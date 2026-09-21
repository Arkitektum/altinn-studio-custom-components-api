// Dependencies
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The example data still kept as files in this repository.
 *
 * Most main form examples are not here: they are read from the FtPB testmotor, which re-stamps their date fields on
 * every request (see `api/utils/testmotorClient.mjs`). What is left on disk is every subform, and the one main form
 * the testmotor has no data for.
 *
 * Reading these is kept apart from `api/scripts/functions.mjs` because the drift check needs the same rules without
 * pulling in the XML converter and its native `libxmljs2` binding.
 */

// Resolved relative to this module rather than the current working directory, so it does not matter where the server
// or the drift check is launched from.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../..");

/**
 * Where the on-disk example data lives. Overridable so a test can point at fixtures, and so the directory can be
 * kept elsewhere without this repo holding a second copy of it.
 *
 * @returns {string} The example data root, holding `forms/` and `subforms/`.
 */
export function exampleDataDir() {
    return process.env.EXAMPLE_DATA_DIR?.trim() || path.join(repoRoot, "api/data/exampleData");
}

/**
 * The label an example file is offered under: its stem, without the ordering prefix or the file extension.
 *
 * The testmotor strips both before answering — `01_Maksimumsversjon.xml` on its Azure share arrives as
 * `Maksimumsversjon` — so disk files are stripped the same way rather than leaving one dropdown mixing two
 * conventions. Nothing downstream reads the extension: the name is a label and a selection key, nothing more.
 *
 * @param {string} fileName - The file name as it is on disk, e.g. "01_Maksimumsversjon.xml".
 * @returns {string} The label, e.g. "Maksimumsversjon".
 */
export function exampleFileLabel(fileName) {
    return fileName.replace(/\.[^.]+$/, "").replace(/^\d+_/, "");
}

/**
 * Reads a folder of example XML files.
 *
 * Sorted explicitly rather than trusting `readdir`, whose order is not guaranteed, and sorted on the file name
 * before the label is taken from it, because the numeric prefix carrying the order is gone from the label.
 *
 * @async
 * @param {string} folderPath - The folder to read.
 * @returns {Promise<Array<{name: string, contents: string}>>} The files in prefix order. Empty when there is no
 *   such folder, which is the ordinary case for a data type with no examples on disk.
 */
export async function readExampleFilesFromDisk(folderPath) {
    let entries;
    try {
        entries = await fs.readdir(folderPath, { withFileTypes: true });
    } catch (error) {
        // A missing folder is expected — it means no examples. Anything else is a real problem worth reporting.
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }

    const fileNames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".xml"))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, "nb"));

    return Promise.all(
        fileNames.map(async (fileName) => ({
            name: exampleFileLabel(fileName),
            contents: await fs.readFile(path.join(folderPath, fileName), "utf8")
        }))
    );
}

/**
 * Whether a data type has example files on disk, without reading their contents.
 *
 * @async
 * @param {string} kind - "forms" or "subforms".
 * @param {string} dataType - The data type, which is also the folder name.
 * @returns {Promise<boolean>}
 */
export async function hasExampleFilesOnDisk(kind, dataType) {
    try {
        const entries = await fs.readdir(path.join(exampleDataDir(), kind, dataType), { withFileTypes: true });
        return entries.some((entry) => entry.isFile() && entry.name.endsWith(".xml"));
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
