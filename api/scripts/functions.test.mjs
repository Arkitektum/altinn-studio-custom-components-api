import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAppResourceValues, getJsonExampleData, supportedResourceLanguage } from "./functions.mjs";
import altinnStudioApps from "../data/altinnStudioApps.mjs";
import { clearTestmotorCache } from "../utils/testmotorClient.mjs";
import { createCachedFunction } from "../utils/cache.mjs";

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITEA_TOKEN;
const originalExampleDir = process.env.EXAMPLE_DATA_DIR;
const originalWarn = console.warn;
const originalError = console.error;
const originalLog = console.log;

/**
 * Stubs global fetch with a Gitea-like response. `bodyForUrl` returns the file content for a requested URL, or
 * null to answer 404.
 */
function stubFetch(bodyForUrl) {
    globalThis.fetch = async (url) => {
        const body = bodyForUrl(String(url));
        if (body === null) {
            return { ok: false, status: 404, text: async () => "" };
        }
        return { ok: true, status: 200, text: async () => body };
    };
}

beforeEach(() => {
    process.env.GITEA_TOKEN = "test-token";
    // The skip paths log deliberately, and outside a run the logger writes straight to the console. Keep the test
    // output readable.
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
    } else {
        process.env.GITEA_TOKEN = originalToken;
    }
    if (originalExampleDir === undefined) {
        delete process.env.EXAMPLE_DATA_DIR;
    } else {
        process.env.EXAMPLE_DATA_DIR = originalExampleDir;
    }
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
    clearTestmotorCache();
});

test("merges values per language when every resource file parses", async () => {
    stubFetch((url) => {
        if (url.includes("resource.nb.json")) return JSON.stringify({ resources: [{ id: "a", value: "bokmål" }] });
        return JSON.stringify({ resources: [{ id: "a", value: "nynorsk" }] });
    });

    const result = await getAppResourceValues();

    assert.equal(result.length, altinnStudioApps.length);
    assert.deepEqual(result[0].resourceValues, [{ id: "a", values: { nb: "bokmål", nn: "nynorsk" } }]);
});

test("keeps the languages that parse when one resource file has no resources array", async () => {
    stubFetch((url) => {
        // A file that is valid JSON but carries no "resources" array used to throw inside mergeResourceFiles and
        // drop the app entirely — including the language that parsed fine.
        if (url.includes("resource.nb.json")) return JSON.stringify({ language: "nb" });
        return JSON.stringify({ resources: [{ id: "a", value: "nynorsk" }] });
    });

    const result = await getAppResourceValues();

    assert.equal(result.length, altinnStudioApps.length);
    assert.deepEqual(result[0].resourceValues, [{ id: "a", values: { nn: "nynorsk" } }]);
});

test("keeps the languages that parse when one resource file is missing", async () => {
    stubFetch((url) => (url.includes("resource.nb.json") ? null : JSON.stringify({ resources: [{ id: "a", value: "nynorsk" }] })));

    const result = await getAppResourceValues();

    assert.equal(result.length, altinnStudioApps.length);
    assert.deepEqual(result[0].resourceValues, [{ id: "a", values: { nn: "nynorsk" } }]);
});

test("skips an app when no resource file can be read", async () => {
    stubFetch(() => null);

    assert.deepEqual(await getAppResourceValues(), []);
});

test("restricts the fetch to a single supported language", async () => {
    const requested = [];
    stubFetch((url) => {
        requested.push(url);
        return JSON.stringify({ resources: [{ id: "a", value: "bokmål" }] });
    });

    const result = await getAppResourceValues("nb");

    assert.ok(requested.every((url) => url.includes("resource.nb.json")));
    assert.deepEqual(result[0].resourceValues, [{ id: "a", values: { nb: "bokmål" } }]);
});

test("keeps the supported languages and turns everything else into 'all of them'", () => {
    assert.equal(supportedResourceLanguage("nb"), "nb");
    assert.equal(supportedResourceLanguage("nn"), "nn");

    // Anything else means the same as asking for nothing, so it has to reduce to the same value.
    assert.equal(supportedResourceLanguage("en"), null);
    assert.equal(supportedResourceLanguage(""), null);
    assert.equal(supportedResourceLanguage(undefined), null);
    assert.equal(supportedResourceLanguage("NB"), null);
    assert.equal(supportedResourceLanguage(" nb "), null);
});

test("narrows a query string that is not a string at all", () => {
    // Express parses ?language[]=nb into an array and ?language[a]=b into an object. Neither is a language, and
    // neither may reach a cache key as it stands.
    assert.equal(supportedResourceLanguage(["nb"]), null);
    assert.equal(supportedResourceLanguage({ toString: () => "nb" }), null);
});

test("gives every request that means 'all languages' the same cache entry", async () => {
    // The endpoint caches on the argument, so narrowing has to happen before the call rather than inside it:
    // otherwise each distinct spelling is a miss, and each miss is a full fan-out to Altinn Studio.
    let calls = 0;
    const cached = createCachedFunction(async () => {
        calls += 1;
        return "resources";
    });

    for (const asked of ["en", "de", "", undefined, ["nb"], { a: 1 }]) {
        await cached(supportedResourceLanguage(asked));
    }
    await cached(supportedResourceLanguage("nb"));
    await cached(supportedResourceLanguage("nb"));

    // One for "all of them", one for nb.
    assert.equal(calls, 2);
});

/**
 * Example data, assembled from the testmotor and from disk.
 *
 * These run against the real app catalogue, because which apps share a data type is exactly what is under test —
 * a fixture catalogue could not go wrong in the way the real one does. Everything else is stubbed: the testmotor,
 * the schemas fetched from Altinn Studio, and the example directory.
 */

/** A schema every fixture file below validates against. */
const XSD = `<?xml version="1.0" encoding="utf-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
    <xs:element name="skjema">
        <xs:complexType>
            <xs:sequence>
                <xs:element name="tittel" type="xs:string" />
            </xs:sequence>
        </xs:complexType>
    </xs:element>
</xs:schema>`;

/**
 * An example file that validates against XSD, carrying its own name so a test can tell the files apart.
 *
 * @param {string} tittel
 * @returns {string}
 */
function xml(tittel) {
    return `<?xml version="1.0" encoding="utf-8"?><skjema><tittel>${tittel}</tittel></skjema>`;
}

/** An example file that does not validate against XSD. */
const INVALID_XML = `<?xml version="1.0" encoding="utf-8"?><skjema><ukjentFelt>nei</ukjentFelt></skjema>`;

/**
 * Stubs both upstreams: the testmotor's endpoints and the schema fetch from Altinn Studio.
 *
 * The attachment endpoints answer the way the testmotor does: a list of attachment types per app, and each file
 * downloaded by the `fileName` header, with a 404 for a name it does not hold. Every testmotor request is recorded.
 *
 * @param {Object} options
 * @param {Array<{appId: string, mainFormId: string}>} [options.apps] - What /api/altinn-app answers.
 * @param {Object<string, Array<{name: string, contents: string}>>} [options.xmlByApp] - What /api/xml/{appId} answers.
 * @param {Object<string, Object<string, Array<{fileName: string, contents: string|null}>>>} [options.subformsByApp] -
 *   Per app and subform data type, the predefined files. A null `contents` is listed but answers 404 when downloaded.
 * @param {boolean} [options.testmotorDown] - Make every testmotor request fail.
 * @param {string|null} [options.xsd] - The schema every data type resolves to, or null to answer 404.
 * @param {string} [options.xsdError] - A schema path fragment to answer 500 for. A 404 means "no schema" and is
 *   handled; a 500 throws out of the fetch helper instead, which is the other path.
 */
function stubExampleSources({ apps = [], xmlByApp = {}, subformsByApp = {}, testmotorDown = false, xsd = XSD, xsdError = null }) {
    clearTestmotorCache();
    const testmotorCalls = [];
    const schemaCalls = [];
    globalThis.fetch = async (url, init) => {
        const target = String(url);
        if (target.includes("app-ftpb-testmotor")) {
            testmotorCalls.push(target);
            if (testmotorDown) {
                throw new TypeError("fetch failed");
            }
            const attachment = target.split("/api/attachment/")[1];
            if (attachment !== undefined) {
                const [appId, dataType] = attachment.split("/").map(decodeURIComponent);
                const types = subformsByApp[appId] ?? {};
                if (dataType === undefined) {
                    const list = Object.entries(types).map(([id, files]) => ({
                        id,
                        predefined: files.map(({ fileName }) => ({ fileName }))
                    }));
                    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(list) };
                }
                const fileName = new Headers(init?.headers).get("fileName");
                const file = (types[dataType] ?? []).find((candidate) => candidate.fileName === fileName);
                if (!file || file.contents === null) {
                    return { ok: false, status: 404, statusText: "Not Found", text: async () => "Fant ikke vedlegg" };
                }
                return { ok: true, status: 200, statusText: "OK", text: async () => file.contents };
            }
            const body = target.endsWith("/api/altinn-app") ? apps : (xmlByApp[decodeURIComponent(target.split("/api/xml/")[1])] ?? []);
            return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
        }
        if (target.endsWith(".xsd")) {
            schemaCalls.push(target);
            if (xsdError && target.includes(xsdError)) {
                return { ok: false, status: 500, statusText: "Internal Server Error", text: async () => "" };
            }
            if (xsd !== null) {
                return { ok: true, status: 200, text: async () => xsd };
            }
        }
        return { ok: false, status: 404, text: async () => "" };
    };
    return { testmotorCalls, schemaCalls };
}

/**
 * Writes an example directory and points EXAMPLE_DATA_DIR at it for the duration of the test.
 *
 * @param {import("node:test").TestContext} t
 * @param {Object<string, string>} files - Path under the example root, relative, to file contents.
 * @returns {Promise<string>} The directory.
 */
async function withExampleDir(t, files) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "example-data-"));
    for (const [relativePath, contents] of Object.entries(files)) {
        const filePath = path.join(dir, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents, "utf8");
    }
    process.env.EXAMPLE_DATA_DIR = dir;
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

/**
 * The entry for one app's own examples.
 *
 * @param {Array<Object>} result
 * @param {string} appName
 * @returns {Object|undefined}
 */
function entryForApp(result, appName) {
    const app = altinnStudioApps.find((candidate) => candidate.appName === appName);
    return result.find((entry) => entry.appName === appName && entry.dataType === app.dataType);
}

/**
 * The main form entries, which name an app and that app's own data type. A subform entry names an app too, the one
 * it was read through, but under the subform's data type.
 *
 * @param {Array<Object>} result
 * @returns {Array<Object>}
 */
function mainFormEntries(result) {
    return result.filter((entry) => altinnStudioApps.some((app) => app.appName === entry.appName && app.dataType === entry.dataType));
}

/**
 * The entry for one subform as one app holds it, or the shared one when appName is null.
 *
 * @param {Array<Object>} result
 * @param {string|null} appName
 * @param {string} dataType
 * @returns {Object|undefined}
 */
function subformEntry(result, appName, dataType) {
    return result.find((entry) => entry.appName === appName && entry.dataType === dataType);
}

/** The apps in the catalogue that declare a subform data type, in catalogue order. */
function appsDeclaring(dataType) {
    return altinnStudioApps.filter((app) => app.subForms?.some((subForm) => subForm.dataType === dataType));
}

test("keys main form examples on the app, so two apps sharing a data type keep their own", async () => {
    // fa-v3 and fa-v5 are both filed under FA and hold different files. Keyed on the data type alone, one of them
    // was being shown the other's examples.
    stubExampleSources({
        apps: [
            { appId: "fa-v3", mainFormId: "FA" },
            { appId: "fa-v5", mainFormId: "FA" }
        ],
        xmlByApp: {
            "fa-v3": [{ name: "Standard", contents: xml("v3 standard") }],
            "fa-v5": [
                { name: "Standard", contents: xml("v5 standard") },
                { name: "Automatiseringskrav", contents: xml("v5 automatisering") }
            ]
        }
    });

    const result = await getJsonExampleData();

    assert.deepEqual(entryForApp(result, "fa-v3").files, [{ name: "Standard", data: { tittel: "v3 standard" } }]);
    assert.deepEqual(entryForApp(result, "fa-v5").files, [
        { name: "Standard", data: { tittel: "v5 standard" } },
        { name: "Automatiseringskrav", data: { tittel: "v5 automatisering" } }
    ]);
});

test("keeps the order the testmotor answers files in", async () => {
    // The ordering prefix is stripped before the files arrive, so sorting the stems would put Maksimumsversjon
    // ahead of Minimumsversjon by accident rather than by intent.
    stubExampleSources({
        apps: [{ appId: "an-v2", mainFormId: "AN" }],
        xmlByApp: {
            "an-v2": [
                { name: "Maksimumsversjon", contents: xml("maks") },
                { name: "Minimumsversjon", contents: xml("min") },
                { name: "Automatiseringskrav", contents: xml("auto") }
            ]
        }
    });

    const result = await getJsonExampleData();

    assert.deepEqual(
        entryForApp(result, "an-v2").files.map((file) => file.name),
        ["Maksimumsversjon", "Minimumsversjon", "Automatiseringskrav"]
    );
});

test("reads from disk for an app the testmotor does not hold, stripping the prefix and the extension", async (t) => {
    // hoeringettersynuttalelse-v2 is the one main form the testmotor has no data for.
    await withExampleDir(t, {
        "forms/HoeringOgOffentligEttersynUttalelse/02_uttalelse.xml": xml("uttalelse"),
        "forms/HoeringOgOffentligEttersynUttalelse/01_standard.xml": xml("standard")
    });
    stubExampleSources({ apps: [{ appId: "an-v2", mainFormId: "AN" }] });

    const result = await getJsonExampleData();
    const entry = entryForApp(result, "hoeringettersynuttalelse-v2");

    assert.equal(entry.error, null);
    assert.deepEqual(entry.files, [
        { name: "standard", data: { tittel: "standard" } },
        { name: "uttalelse", data: { tittel: "uttalelse" } }
    ]);
});

test("refuses a disk folder that two apps claim", async (t) => {
    // A folder is named after the data type, so a folder called FA cannot say whether it is fa-v3's or fa-v5's.
    await withExampleDir(t, { "forms/FA/01_Standard.xml": xml("whose is this?") });
    stubExampleSources({ apps: [] });

    const result = await getJsonExampleData();

    assert.deepEqual(entryForApp(result, "fa-v3").files, []);
    assert.deepEqual(entryForApp(result, "fa-v5").files, []);
});

test("carries the reason on every app when the testmotor cannot be reached", async () => {
    // "No examples" and "could not reach the examples" are different answers, and only one of them is ours.
    stubExampleSources({ testmotorDown: true });

    const result = await getJsonExampleData();
    const entry = entryForApp(result, "fa-v5");

    assert.deepEqual(entry.files, []);
    assert.match(entry.error, /could not be reached: fetch failed/);
});

test("still serves a disk-backed app when the testmotor is down", async (t) => {
    // Its examples never depended on the testmotor, so an outage there is not a reason to lose them.
    await withExampleDir(t, { "forms/HoeringOgOffentligEttersynUttalelse/01_uttalelse.xml": xml("uttalelse") });
    stubExampleSources({ testmotorDown: true });

    const result = await getJsonExampleData();
    const entry = entryForApp(result, "hoeringettersynuttalelse-v2");

    assert.equal(entry.error, null);
    assert.deepEqual(entry.files, [{ name: "uttalelse", data: { tittel: "uttalelse" } }]);
});

test("gives an app with no examples anywhere an entry and no error", async () => {
    // ts-v1 is one of the reply forms, which have example data from neither source. That is an absence, not a
    // failure, and it has to read as one.
    stubExampleSources({ apps: [{ appId: "an-v2", mainFormId: "AN" }] });

    const result = await getJsonExampleData();
    const entry = entryForApp(result, "ts-v1");

    assert.deepEqual(entry.files, []);
    assert.equal(entry.error, null);
});

test("skips one example that fails validation and keeps the rest", async () => {
    stubExampleSources({
        apps: [{ appId: "an-v2", mainFormId: "AN" }],
        xmlByApp: {
            "an-v2": [
                { name: "Maksimumsversjon", contents: xml("maks") },
                { name: "Ugyldig", contents: INVALID_XML },
                { name: "Minimumsversjon", contents: xml("min") }
            ]
        }
    });

    const result = await getJsonExampleData();

    assert.deepEqual(
        entryForApp(result, "an-v2").files.map((file) => file.name),
        ["Maksimumsversjon", "Minimumsversjon"]
    );
});

test("reports the schema when it is the schema that could not be read", async () => {
    stubExampleSources({
        apps: [{ appId: "an-v2", mainFormId: "AN" }],
        xmlByApp: { "an-v2": [{ name: "Maksimumsversjon", contents: xml("maks") }] },
        xsd: null
    });

    const result = await getJsonExampleData();
    const entry = entryForApp(result, "an-v2");

    assert.deepEqual(entry.files, []);
    assert.match(entry.error, /App\/models\/AN\.xsd could not be read from Altinn Studio/);
});

test("files a subform under each app that declares it, with that app's own files", async () => {
    // The testmotor files subform examples per app, and DispensasjonssoeknadDataV1 holds different files under
    // disp-v1 and fts-v1. One shared set would show one of them the other's examples.
    stubExampleSources({
        apps: [
            { appId: "disp-v1", mainFormId: "DS" },
            { appId: "fts-v1", mainFormId: "FTS" }
        ],
        subformsByApp: {
            "disp-v1": { DispensasjonssoeknadDataV1: [{ fileName: "Dispensasjonssoeknad1.xml", contents: xml("disp") }] },
            "fts-v1": {
                DispensasjonssoeknadDataV1: [
                    { fileName: "Dispensasjonssoeknad1.xml", contents: xml("fts en") },
                    { fileName: "DispensasjonssoeknadV1.xml", contents: xml("fts to") }
                ]
            }
        }
    });

    const result = await getJsonExampleData();

    assert.deepEqual(subformEntry(result, "disp-v1", "DispensasjonssoeknadDataV1"), {
        appOwner: "dibk",
        appName: "disp-v1",
        dataType: "DispensasjonssoeknadDataV1",
        error: null,
        files: [{ name: "Dispensasjonssoeknad1", data: { tittel: "disp" } }]
    });
    assert.deepEqual(subformEntry(result, "fts-v1", "DispensasjonssoeknadDataV1").files, [
        { name: "Dispensasjonssoeknad1", data: { tittel: "fts en" } },
        { name: "DispensasjonssoeknadV1", data: { tittel: "fts to" } }
    ]);
    for (const app of appsDeclaring("DispensasjonssoeknadDataV1")) {
        assert.ok(subformEntry(result, app.appName, "DispensasjonssoeknadDataV1"), `${app.appName} should have its own entry`);
    }
});

test("also files each subform once under no app, as the first app declaring it holds it", async () => {
    // Viewed as an app of its own, a subform has no parent to be matched through, and the dashboard falls back on the
    // entry naming no app. disp-v1 is the first app declaring DispensasjonssoeknadDataV1, so its files are the ones.
    const [first, second] = appsDeclaring("DispensasjonssoeknadDataV1");
    assert.equal(first.appName, "disp-v1");
    stubExampleSources({
        apps: [
            { appId: first.appName, mainFormId: first.dataType },
            { appId: second.appName, mainFormId: second.dataType }
        ],
        subformsByApp: {
            [first.appName]: { DispensasjonssoeknadDataV1: [{ fileName: "Forste.xml", contents: xml("first") }] },
            [second.appName]: { DispensasjonssoeknadDataV1: [{ fileName: "Andre.xml", contents: xml("second") }] }
        }
    });

    const result = await getJsonExampleData();
    const shared = result.filter((entry) => entry.appName === null && entry.dataType === "DispensasjonssoeknadDataV1");

    assert.equal(shared.length, 1);
    assert.equal(shared[0].appOwner, null);
    assert.deepEqual(shared[0].files, [{ name: "Forste", data: { tittel: "first" } }]);
});

test("copies the shared entry from a later app when the first app declaring the subform holds no files for it", async () => {
    // Each app holds its own files, so the first app declaring a subform can have none while another has some. Viewed on its own, the subform should show those rather than nothing.
    const [first, second] = appsDeclaring("GjennomfoeringsplanDataV7");
    stubExampleSources({
        apps: [
            { appId: first.appName, mainFormId: first.dataType },
            { appId: second.appName, mainFormId: second.dataType }
        ],
        subformsByApp: { [second.appName]: { GjennomfoeringsplanDataV7: [{ fileName: "Plan.xml", contents: xml("plan") }] } }
    });

    const result = await getJsonExampleData();
    const shared = result.filter((entry) => entry.appName === null && entry.dataType === "GjennomfoeringsplanDataV7");

    assert.deepEqual(subformEntry(result, first.appName, "GjennomfoeringsplanDataV7").files, []);
    assert.equal(shared.length, 1);
    assert.deepEqual(shared[0].files, [{ name: "Plan", data: { tittel: "plan" } }]);
    // Straight after the entry it was copied from.
    const sourceIndex = result.indexOf(subformEntry(result, second.appName, "GjennomfoeringsplanDataV7"));
    assert.equal(result[sourceIndex + 1], shared[0]);
});

test("copies the shared entry from a later app when the first app's download fails", async () => {
    const [first, second] = appsDeclaring("DispensasjonssoeknadDataV1");
    stubExampleSources({
        apps: [
            { appId: first.appName, mainFormId: first.dataType },
            { appId: second.appName, mainFormId: second.dataType }
        ],
        subformsByApp: {
            [first.appName]: { DispensasjonssoeknadDataV1: [{ fileName: "Borte.xml", contents: null }] },
            [second.appName]: { DispensasjonssoeknadDataV1: [{ fileName: "Andre.xml", contents: xml("second") }] }
        }
    });

    const result = await getJsonExampleData();
    const shared = subformEntry(result, null, "DispensasjonssoeknadDataV1");

    assert.ok(subformEntry(result, first.appName, "DispensasjonssoeknadDataV1").error, "the first app's entry should carry the failure");
    assert.equal(shared.error, null);
    assert.deepEqual(shared.files, [{ name: "Andre", data: { tittel: "second" } }]);
});

test("copies the shared entry from the first app declaring the subform when no app holds files for it", async () => {
    const [first] = appsDeclaring("DispensasjonssoeknadDataV1");
    stubExampleSources({ apps: [] });

    const result = await getJsonExampleData();
    const sourceIndex = result.indexOf(subformEntry(result, first.appName, "DispensasjonssoeknadDataV1"));

    assert.deepEqual(result[sourceIndex + 1], { appOwner: null, appName: null, dataType: "DispensasjonssoeknadDataV1", error: null, files: [] });
});

test("reads a subform once per app, and the shared copy costs nothing more", async () => {
    const { testmotorCalls, schemaCalls } = stubExampleSources({
        apps: [{ appId: "disp-v1", mainFormId: "DS" }],
        subformsByApp: { "disp-v1": { DispensasjonssoeknadDataV1: [{ fileName: "Dispensasjonssoeknad1.xml", contents: xml("disp") }] } }
    });

    await getJsonExampleData();

    const downloads = testmotorCalls.filter((url) => url.endsWith("/api/attachment/disp-v1/DispensasjonssoeknadDataV1"));
    assert.equal(downloads.length, 1);
    // The schema comes from the repository of the app the subform was read through.
    const schemas = schemaCalls.filter((url) => url.includes("DispensasjonssoeknadDataV1.xsd"));
    assert.equal(schemas.length, 1);
    assert.match(schemas[0], /disp-v1/);
});

test("gives a subform no examples and no error under an app the testmotor does not hold", async () => {
    // An absence, as for a main form, and nothing is asked for that app at all.
    const { testmotorCalls } = stubExampleSources({ apps: [{ appId: "an-v2", mainFormId: "AN" }] });

    const result = await getJsonExampleData();
    const entry = subformEntry(result, "disp-v1", "DispensasjonssoeknadDataV1");

    assert.deepEqual(entry.files, []);
    assert.equal(entry.error, null);
    assert.equal(
        testmotorCalls.some((url) => url.includes("/api/attachment/")),
        false
    );
});

test("carries the reason on every subform when the testmotor cannot be reached, without asking per subform", async () => {
    const { testmotorCalls } = stubExampleSources({ testmotorDown: true });

    const result = await getJsonExampleData();

    for (const entry of result.filter((candidate) => candidate.dataType === "GjennomfoeringsplanDataV7")) {
        assert.deepEqual(entry.files, []);
        assert.match(entry.error, /could not be reached: fetch failed/);
    }
    assert.deepEqual(
        testmotorCalls.map((url) => new URL(url).pathname),
        ["/api/altinn-app"]
    );
});

test("carries the reason on that app's subform when a download fails, naming the file", async () => {
    stubExampleSources({
        apps: [
            { appId: "disp-v1", mainFormId: "DS" },
            { appId: "es-v2", mainFormId: "ES" }
        ],
        subformsByApp: {
            "disp-v1": { DispensasjonssoeknadDataV1: [{ fileName: "Mangler.xml", contents: null }] },
            "es-v2": { DispensasjonssoeknadDataV1: [{ fileName: "Finnes.xml", contents: xml("es") }] }
        }
    });

    const result = await getJsonExampleData();

    const failed = subformEntry(result, "disp-v1", "DispensasjonssoeknadDataV1");
    assert.deepEqual(failed.files, []);
    assert.match(failed.error, /\(file Mangler\.xml\) answered 404/);
    assert.deepEqual(subformEntry(result, "es-v2", "DispensasjonssoeknadDataV1").files, [{ name: "Finnes", data: { tittel: "es" } }]);
    assert.equal(entryForApp(result, "disp-v1").error, null, "the main form is not affected");
});

test("gives every tracked app an entry of its own", async () => {
    stubExampleSources({ apps: [] });

    const result = await getJsonExampleData();

    assert.equal(mainFormEntries(result).length, altinnStudioApps.length);
});

test("reports the schema when it is the schema that could not be parsed", async () => {
    // The schema is parsed once for the whole set, so a schema that is not a schema fails once. Blaming the files
    // individually would point at the wrong thing: they are fine, and there is nothing to validate them against.
    stubExampleSources({
        apps: [{ appId: "an-v2", mainFormId: "AN" }],
        xmlByApp: { "an-v2": [{ name: "Maksimumsversjon", contents: xml("maks") }] },
        xsd: "this is not a schema"
    });

    const result = await getJsonExampleData();
    const entry = entryForApp(result, "an-v2");

    assert.deepEqual(entry.files, []);
    assert.match(entry.error, /App\/models\/AN\.xsd could not be parsed as a schema/);
});

test("carries the reason on the app when a schema request fails outright", async () => {
    // The backstop: a 404 resolves to null and is reported as a missing schema, but a 500 throws out of the fetch
    // helper. That has to become this app's error rather than escaping into the run.
    stubExampleSources({
        apps: [{ appId: "an-v2", mainFormId: "AN" }],
        xmlByApp: { "an-v2": [{ name: "Maksimumsversjon", contents: xml("maks") }] },
        xsdError: "AN.xsd"
    });

    const result = await getJsonExampleData();
    const entry = entryForApp(result, "an-v2");

    assert.deepEqual(entry.files, []);
    assert.match(entry.error, /status 500/);
    // And it costs that app only. Every other app still gets its entry.
    assert.equal(mainFormEntries(result).length, altinnStudioApps.length);
});

test("drops a subform that could not be processed, and nothing else", async () => {
    // A schema request that fails outright throws, and costs that subform under that app rather than the app.
    const gjennomfoeringsplan = { GjennomfoeringsplanDataV7: [{ fileName: "GjennomfoeringsplanDataV7.xml", contents: xml("plan") }] };
    stubExampleSources({
        apps: [{ appId: "fa-v5", mainFormId: "FA" }],
        subformsByApp: { "fa-v5": gjennomfoeringsplan },
        xsdError: "GjennomfoeringsplanDataV7.xsd"
    });

    const result = await getJsonExampleData();

    assert.ok(
        result.every((entry) => entry !== null),
        "a subform that could not be processed must leave no hole in the result"
    );
    assert.equal(subformEntry(result, "fa-v5", "GjennomfoeringsplanDataV7"), undefined);
    assert.equal(mainFormEntries(result).length, altinnStudioApps.length);
});

test("answers in catalogue order, each app's subforms after its main form and each shared copy after its source", async () => {
    // The apps are fetched concurrently, so the order they finish in is not the order they are named in. What the
    // dashboard receives has to be the catalogue's order regardless of which app's upstream answered first.
    stubExampleSources({ apps: [] });

    const result = await getJsonExampleData();

    const expected = [];
    const shared = new Set();
    for (const app of altinnStudioApps) {
        expected.push(`${app.appName}:${app.dataType}`);
        for (const { dataType } of app.subForms ?? []) {
            expected.push(`${app.appName}:${dataType}`);
            if (!shared.has(dataType)) {
                shared.add(dataType);
                expected.push(`shared:${dataType}`);
            }
        }
    }
    assert.deepEqual(
        result.map((entry) => `${entry.appName ?? "shared"}:${entry.dataType}`),
        expected
    );
});
