// Dependencies
import { pathToFileURL } from "node:url";

// Data
import altinnStudioApps from "../data/altinnStudioApps.mjs";
import subforms from "../data/subforms.mjs";

// Utils
import { fetchTestmotorApps } from "../utils/testmotorClient.mjs";
import { hasExampleFilesOnDisk } from "../utils/exampleFiles.mjs";

/**
 * Compares the tracked app catalogue against the testmotor's list of the same apps.
 *
 * The two lists do not know about each other. `api/data/altinnStudioApps.mjs` is maintained here and decides which
 * apps the dashboard shows; the testmotor keeps its own list and decides which apps have example data. Nothing
 * reconciles them, so they drift, and the drift is invisible until someone opens an app and finds an empty picker.
 *
 * Four findings come out of it:
 *
 * - **Apps the testmotor holds that the catalogue does not name.** Usually a new app version worth tracking.
 * - **Apps with no example data from either source.** The one worth having: an app you cannot see rendered with
 *   real content, because there is nothing to render it with.
 * - **Apps the two file under different data types.** The one that would actually break something, since the
 *   catalogue's data type decides where the dashboard looks and the testmotor's decides where the examples land.
 * - **Subforms the catalogue declares that this repository holds no layout for.** `subforms.mjs` serves only the
 *   subforms it has a layout for, so one added to the catalogue alone is quietly absent rather than broken.
 *
 * This is a report, not a gate: it exits 0 whatever it finds. Drift is normal and is usually resolved by editing
 * the catalogue, which is a judgement call rather than something to fail a build over.
 */

/**
 * @typedef {Object} CoverageEntry
 * @property {string} appOwner
 * @property {string} appName
 * @property {string} dataType
 * @property {"testmotor"|"disk"|"none"} source - Where this app's example data comes from.
 */

/**
 * Compares the two lists. Pure: everything it needs is passed in, so the tests need no network and no filesystem.
 *
 * @param {Object} params
 * @param {Array<Object>} params.catalogue - The tracked apps, as in `altinnStudioApps.mjs`.
 * @param {Array<Object>} params.subformList - The subforms, as in `subforms.mjs`.
 * @param {Array<{appId: string, mainFormId: string}>} params.testmotorApps - What the testmotor holds.
 * @param {Set<string>} params.formDataTypesOnDisk - Data types with files under `forms/`.
 * @param {Set<string>} params.subformDataTypesOnDisk - Data types with files under `subforms/`.
 * @returns {{
 *   unknownToCatalogue: Array<{appId: string, mainFormId: string}>,
 *   disagreements: Array<{appOwner: string, appName: string, catalogue: string, testmotor: string}>,
 *   coverage: CoverageEntry[],
 *   subformCoverage: Array<{appName: string, dataType: string, source: "disk"|"none"}>,
 *   subformsWithoutLayout: Array<{appName: string, dataType: string}>
 * }}
 */
export function compareCatalogueWithTestmotor({ catalogue, subformList, testmotorApps, formDataTypesOnDisk, subformDataTypesOnDisk }) {
    const heldByTestmotor = new Map(testmotorApps.map((app) => [app.appId, app.mainFormId]));
    const catalogueAppNames = new Set(catalogue.map((app) => app.appName));

    // How many catalogue apps claim each data type. A forms/ folder is named after the data type rather than the
    // app, so it only counts as an app's example data when that app is the only one claiming it — the same rule
    // getJsonExampleData applies, so this report says what the dashboard will actually show.
    const claimsPerDataType = new Map();
    for (const app of catalogue) {
        claimsPerDataType.set(app.dataType, (claimsPerDataType.get(app.dataType) ?? 0) + 1);
    }

    const coverage = catalogue.map((app) => {
        let source = "none";
        if (heldByTestmotor.has(app.appName)) {
            source = "testmotor";
        } else if (formDataTypesOnDisk.has(app.dataType) && claimsPerDataType.get(app.dataType) === 1) {
            source = "disk";
        }
        return { appOwner: app.appOwner, appName: app.appName, dataType: app.dataType, source };
    });

    const disagreements = catalogue
        .filter((app) => heldByTestmotor.has(app.appName) && heldByTestmotor.get(app.appName) !== app.dataType)
        .map((app) => ({ appOwner: app.appOwner, appName: app.appName, catalogue: app.dataType, testmotor: heldByTestmotor.get(app.appName) }));

    const unknownToCatalogue = testmotorApps.filter((app) => !catalogueAppNames.has(app.appId));

    // Only the subforms a catalogue app actually declares. One listed in subforms.mjs that nothing references is a
    // different problem, and not this report's.
    const declaredSubformDataTypes = new Set(catalogue.flatMap((app) => (app.subForms ?? []).map((subForm) => subForm.dataType)));
    const subformCoverage = subformList
        .filter((subForm) => declaredSubformDataTypes.has(subForm.dataType))
        .map((subForm) => ({
            appName: subForm.appName,
            dataType: subForm.dataType,
            source: subformDataTypesOnDisk.has(subForm.dataType) ? "disk" : "none"
        }));

    // Declared in the catalogue but not served, which happens when a subform is added there without a layout being
    // added here. It goes missing quietly rather than breaking, since subforms.mjs leaves out what it cannot serve.
    const servedDataTypes = new Set(subformList.map((subForm) => subForm.dataType));
    const subformsWithoutLayout = [];
    const seenWithoutLayout = new Set();
    for (const app of catalogue) {
        for (const subForm of app.subForms ?? []) {
            if (servedDataTypes.has(subForm.dataType) || seenWithoutLayout.has(subForm.dataType)) {
                continue;
            }
            seenWithoutLayout.add(subForm.dataType);
            subformsWithoutLayout.push({ appName: subForm.appName, dataType: subForm.dataType });
        }
    }

    return { unknownToCatalogue, disagreements, coverage, subformCoverage, subformsWithoutLayout };
}

/**
 * Prints one section, or says there is nothing in it.
 *
 * @param {string} heading
 * @param {string[]} lines
 */
function printSection(heading, lines) {
    console.log(`\n${heading} (${lines.length})`);
    if (lines.length === 0) {
        console.log("  none");
        return;
    }
    for (const line of lines) {
        console.log(`  ${line}`);
    }
}

/**
 * Pads a list of names to a common width, so the parenthesised data types line up.
 *
 * @param {string[]} names
 * @returns {number}
 */
function widestOf(names) {
    return names.reduce((widest, name) => Math.max(widest, name.length), 0);
}

/**
 * Fetches the testmotor's list, works out what is on disk, and prints the comparison.
 *
 * @async
 * @returns {Promise<void>}
 */
export async function reportCatalogueDrift() {
    const testmotorApps = await fetchTestmotorApps();

    const formDataTypes = [...new Set(altinnStudioApps.map((app) => app.dataType))];
    const subformDataTypes = [...new Set(subforms.map((subForm) => subForm.dataType))];
    const [formsOnDisk, subformsOnDisk] = await Promise.all([
        Promise.all(formDataTypes.map(async (dataType) => [dataType, await hasExampleFilesOnDisk("forms", dataType)])),
        Promise.all(subformDataTypes.map(async (dataType) => [dataType, await hasExampleFilesOnDisk("subforms", dataType)]))
    ]);

    const drift = compareCatalogueWithTestmotor({
        catalogue: altinnStudioApps,
        subformList: subforms,
        testmotorApps,
        formDataTypesOnDisk: new Set(formsOnDisk.filter(([, present]) => present).map(([dataType]) => dataType)),
        subformDataTypesOnDisk: new Set(subformsOnDisk.filter(([, present]) => present).map(([dataType]) => dataType))
    });

    console.log(`Catalogue: ${altinnStudioApps.length} apps. Testmotor: ${testmotorApps.length} apps.`);

    const unknownWidth = widestOf(drift.unknownToCatalogue.map((app) => app.appId));
    printSection(
        "Apps the testmotor holds that the catalogue does not name",
        drift.unknownToCatalogue.map((app) => `${app.appId.padEnd(unknownWidth)}  (${app.mainFormId})`)
    );

    const withoutExamples = drift.coverage.filter((entry) => entry.source === "none");
    const withoutWidth = widestOf(withoutExamples.map((entry) => `${entry.appOwner}/${entry.appName}`));
    printSection(
        "Apps with no example data from either source",
        withoutExamples.map((entry) => `${`${entry.appOwner}/${entry.appName}`.padEnd(withoutWidth)}  (${entry.dataType})`)
    );

    printSection(
        "Apps the catalogue and the testmotor file under different data types",
        drift.disagreements.map((entry) => `${entry.appOwner}/${entry.appName}  catalogue: ${entry.catalogue}  testmotor: ${entry.testmotor}`)
    );

    printSection(
        "Declared subforms with no example file",
        drift.subformCoverage.filter((entry) => entry.source === "none").map((entry) => `${entry.appName}  (${entry.dataType})`)
    );

    printSection(
        "Subforms the catalogue declares that this repository holds no layout for",
        drift.subformsWithoutLayout.map((entry) => `${entry.appName}  (${entry.dataType})`)
    );

    const fromTestmotor = drift.coverage.filter((entry) => entry.source === "testmotor").length;
    const fromDisk = drift.coverage.filter((entry) => entry.source === "disk").length;
    console.log(`\nCoverage: ${fromTestmotor} from the testmotor, ${fromDisk} from disk, ${withoutExamples.length} from nowhere.`);
}

// Run when invoked directly, but not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    reportCatalogueDrift().catch((error) => {
        console.error(`Could not compare the catalogue against the testmotor: ${error.message}`);
        process.exitCode = 1;
    });
}
