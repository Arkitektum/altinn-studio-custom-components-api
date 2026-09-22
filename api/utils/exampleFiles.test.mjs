import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { exampleDataDir, exampleFileLabel, hasExampleFilesOnDisk, readExampleFilesFromDisk } from "./exampleFiles.mjs";

const originalExampleDir = process.env.EXAMPLE_DATA_DIR;

/**
 * Writes an example directory that is removed when the test ends.
 *
 * @param {import("node:test").TestContext} t
 * @param {Object<string, string>} files - Path relative to the directory, to file contents.
 * @returns {Promise<string>} The directory.
 */
async function withFiles(t, files) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "example-files-"));
    for (const [relativePath, contents] of Object.entries(files)) {
        const filePath = path.join(dir, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents, "utf8");
    }
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

/** Restores EXAMPLE_DATA_DIR for the tests that move it. */
function restoreExampleDir(t) {
    t.after(() => {
        if (originalExampleDir === undefined) {
            delete process.env.EXAMPLE_DATA_DIR;
        } else {
            process.env.EXAMPLE_DATA_DIR = originalExampleDir;
        }
    });
}

test("strips the ordering prefix and the extension from a label", () => {
    assert.equal(exampleFileLabel("01_Maksimumsversjon.xml"), "Maksimumsversjon");
});

test("leaves a name that carries no ordering prefix alone", () => {
    assert.equal(exampleFileLabel("uttalelse.xml"), "uttalelse");
});

test("only strips a leading run of digits followed by an underscore", () => {
    // The prefix is an ordering device, not any digits that happen to be there: a year in the name is part of it.
    assert.equal(exampleFileLabel("2024rapport.xml"), "2024rapport");
    assert.equal(exampleFileLabel("nabovarsel_838-naboer.xml"), "nabovarsel_838-naboer");
});

test("strips one prefix, not every digit group in the name", () => {
    assert.equal(exampleFileLabel("01_02_Maksimum.xml"), "02_Maksimum");
});

test("removes only the final extension from a name containing dots", () => {
    assert.equal(exampleFileLabel("01_hoeringOgOffentligEttersynV2.BEGR.xml"), "hoeringOgOffentligEttersynV2.BEGR");
});

test("reads a folder of examples, labelled and in prefix order", async (t) => {
    // Deliberately in an order where sorting the *labels* would disagree with sorting the file names: the prefix
    // carries the intended order and it is gone from the label, so the sort has to happen before the strip.
    const dir = await withFiles(t, {
        "01_Zebra.xml": "<a/>",
        "02_Alfa.xml": "<b/>"
    });

    const files = await readExampleFilesFromDisk(dir);

    assert.deepEqual(files, [
        { name: "Zebra", contents: "<a/>" },
        { name: "Alfa", contents: "<b/>" }
    ]);
});

test("orders an unpadded prefix by its number rather than its first digit", async (t) => {
    const dir = await withFiles(t, {
        "2_Andre.xml": "<b/>",
        "10_Tiende.xml": "<c/>",
        "1_Foerste.xml": "<a/>"
    });

    const files = await readExampleFilesFromDisk(dir);

    assert.deepEqual(
        files.map((file) => file.name),
        ["Foerste", "Andre", "Tiende"]
    );
});

test("ignores anything that is not an XML file", async (t) => {
    const dir = await withFiles(t, {
        "01_Standard.xml": "<a/>",
        "README.md": "not an example",
        "notes.txt": "nor this",
        "nested/02_Deeper.xml": "<b/>"
    });

    const files = await readExampleFilesFromDisk(dir);

    assert.deepEqual(
        files.map((file) => file.name),
        ["Standard"]
    );
});

test("answers with nothing for a folder that does not exist", async (t) => {
    const dir = await withFiles(t, {});

    // The ordinary case for a data type with no examples on disk, and not a failure.
    assert.deepEqual(await readExampleFilesFromDisk(path.join(dir, "NoSuchDataType")), []);
});

test("rethrows a read failure that is not a missing folder", async (t) => {
    const dir = await withFiles(t, { "notAFolder.xml": "<a/>" });

    // A file where a folder was expected is a real problem, and has to be reported rather than read as "no examples".
    await assert.rejects(() => readExampleFilesFromDisk(path.join(dir, "notAFolder.xml")), { code: "ENOTDIR" });
});

test("reports that a data type has examples without reading them", async (t) => {
    restoreExampleDir(t);
    process.env.EXAMPLE_DATA_DIR = await withFiles(t, { "subforms/GjennomfoeringsplanDataV7/plan.xml": "<a/>" });

    assert.equal(await hasExampleFilesOnDisk("subforms", "GjennomfoeringsplanDataV7"), true);
});

test("reports no examples for a data type with no folder, and for one holding no XML", async (t) => {
    restoreExampleDir(t);
    process.env.EXAMPLE_DATA_DIR = await withFiles(t, { "forms/AN/README.md": "no examples here" });

    assert.equal(await hasExampleFilesOnDisk("forms", "AN"), false);
    assert.equal(await hasExampleFilesOnDisk("forms", "NoSuchDataType"), false);
});

test("defaults the example directory to the one in this repository", (t) => {
    restoreExampleDir(t);
    delete process.env.EXAMPLE_DATA_DIR;

    assert.equal(path.isAbsolute(exampleDataDir()), true);
    assert.equal(exampleDataDir().endsWith(path.join("api", "data", "exampleData")), true);
});

test("takes the example directory from the environment, trimmed, ignoring a blank one", (t) => {
    restoreExampleDir(t);

    process.env.EXAMPLE_DATA_DIR = "  /tmp/example-data  ";
    assert.equal(exampleDataDir(), "/tmp/example-data");

    process.env.EXAMPLE_DATA_DIR = "   ";
    assert.equal(exampleDataDir().endsWith(path.join("api", "data", "exampleData")), true);
});
