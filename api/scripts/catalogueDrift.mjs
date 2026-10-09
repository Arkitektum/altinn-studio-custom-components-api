// Dependencies
import { pathToFileURL } from "node:url";

// Data
import altinnStudioApps from "../data/altinnStudioApps.mjs";

// Utils
import { fetchTestmotorApps, fetchTestmotorSubformXml } from "../utils/testmotorClient.mjs";
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
 * - **Declared subforms with no example file under an app declaring them.** The testmotor files subform examples
 *   per app, so a subform can have examples under one parent and none under another.
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
 * @param {Array<{appId: string, mainFormId: string}>} params.testmotorApps - What the testmotor holds.
 * @param {Set<string>} params.formDataTypesOnDisk - Data types with files under `forms/`.
 * @param {Map<string, number>} params.subformFileCounts - How many files the testmotor holds per subform under each
 *   app it was asked about, keyed by `subformKey`. A pair it was not asked about is absent.
 * @param {Map<string, string>} [params.subformErrors] - Why a pair could not be asked about, keyed the same way.
 * @returns {{
 *   unknownToCatalogue: Array<{appId: string, mainFormId: string}>,
 *   disagreements: Array<{appOwner: string, appName: string, catalogue: string, testmotor: string}>,
 *   coverage: CoverageEntry[],
 *   subformCoverage: Array<{appName: string, subformAppName: string, dataType: string, source: "testmotor"|"none"|"error", error?: string}>
 * }}
 */
export function compareCatalogueWithTestmotor({ catalogue, testmotorApps, formDataTypesOnDisk, subformFileCounts, subformErrors = new Map() }) {
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

    // One entry per subform under each app declaring it, because that is how the testmotor files them and how
    // getJsonExampleData serves them. An app the testmotor does not hold has no subform examples either, the same rule
    // getJsonExampleData applies.
    const subformCoverage = catalogue.flatMap((app) =>
        (app.subForms ?? []).map((subForm) => {
            const key = subformKey(app.appName, subForm.dataType);
            const entry = { appName: app.appName, subformAppName: subForm.appName, dataType: subForm.dataType };
            if (subformErrors.has(key)) {
                return { ...entry, source: "error", error: subformErrors.get(key) };
            }
            const held = heldByTestmotor.has(app.appName) && (subformFileCounts.get(key) ?? 0) > 0;
            return { ...entry, source: held ? "testmotor" : "none" };
        })
    );

    return { unknownToCatalogue, disagreements, coverage, subformCoverage };
}

/**
 * How a subform under one app is keyed in the counts and errors passed to compareCatalogueWithTestmotor.
 *
 * @param {string} appName - The app declaring the subform.
 * @param {string} dataType - The subform's data type.
 * @returns {string}
 */
export function subformKey(appName, dataType) {
    return `${appName}|${dataType}`;
}

/**
 * Asks the testmotor how many files it holds for each declared subform under each app declaring it.
 *
 * Only the apps it holds are asked about. The client has no way to list a subform's files without downloading them, so this downloads them, which is a few dozen small files and only when the report is run.
 *
 * @async
 * @param {Array<{appId: string}>} testmotorApps - What the testmotor holds.
 * @returns {Promise<{subformFileCounts: Map<string, number>, subformErrors: Map<string, string>}>}
 */
async function countSubformFiles(testmotorApps) {
    const held = new Set(testmotorApps.map((app) => app.appId));
    const pairs = altinnStudioApps
        .filter((app) => held.has(app.appName))
        .flatMap((app) => (app.subForms ?? []).map((subForm) => [app.appName, subForm.dataType]));

    const subformFileCounts = new Map();
    const subformErrors = new Map();
    await Promise.all(
        pairs.map(async ([appName, dataType]) => {
            try {
                subformFileCounts.set(subformKey(appName, dataType), (await fetchTestmotorSubformXml(appName, dataType)).length);
            } catch (error) {
                subformErrors.set(subformKey(appName, dataType), error.message);
            }
        })
    );
    return { subformFileCounts, subformErrors };
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
    const [formsOnDisk, { subformFileCounts, subformErrors }] = await Promise.all([
        Promise.all(formDataTypes.map(async (dataType) => [dataType, await hasExampleFilesOnDisk("forms", dataType)])),
        countSubformFiles(testmotorApps)
    ]);

    const drift = compareCatalogueWithTestmotor({
        catalogue: altinnStudioApps,
        testmotorApps,
        formDataTypesOnDisk: new Set(formsOnDisk.filter(([, present]) => present).map(([dataType]) => dataType)),
        subformFileCounts,
        subformErrors
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

    const subformsWithout = drift.subformCoverage.filter((entry) => entry.source === "none");
    const parentWidth = widestOf(subformsWithout.map((entry) => entry.appName));
    const subformWidth = widestOf(subformsWithout.map((entry) => entry.subformAppName));
    printSection(
        "Declared subforms with no example file under an app declaring them",
        subformsWithout.map((entry) => `${entry.appName.padEnd(parentWidth)}  ${entry.subformAppName.padEnd(subformWidth)}  (${entry.dataType})`)
    );

    printSection(
        "Declared subforms that could not be checked",
        drift.subformCoverage
            .filter((entry) => entry.source === "error")
            .map((entry) => `${entry.appName}  ${entry.subformAppName}  (${entry.dataType}): ${entry.error}`)
    );

    const fromTestmotor = drift.coverage.filter((entry) => entry.source === "testmotor").length;
    const fromDisk = drift.coverage.filter((entry) => entry.source === "disk").length;
    const subformsFromTestmotor = drift.subformCoverage.filter((entry) => entry.source === "testmotor").length;
    console.log(`\nCoverage: ${fromTestmotor} from the testmotor, ${fromDisk} from disk, ${withoutExamples.length} from nowhere.`);
    console.log(`Subforms: ${subformsFromTestmotor} of ${drift.subformCoverage.length} app and subform pairs have examples in the testmotor.`);
}

// Run when invoked directly, but not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    reportCatalogueDrift().catch((error) => {
        console.error(`Could not compare the catalogue against the testmotor: ${error.message}`);
        process.exitCode = 1;
    });
}
