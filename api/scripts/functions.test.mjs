import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAppResourceValues, getJsonExampleData } from "./functions.mjs";
import altinnStudioApps from "../data/altinnStudioApps.mjs";
import { clearTestmotorCache } from "../utils/testmotorClient.mjs";

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
 * Stubs both upstreams: the testmotor's two endpoints and the schema fetch from Altinn Studio.
 *
 * @param {Object} options
 * @param {Array<{appId: string, mainFormId: string}>} [options.apps] - What /api/altinn-app answers.
 * @param {Object<string, Array<{name: string, contents: string}>>} [options.xmlByApp] - What /api/xml/{appId} answers.
 * @param {boolean} [options.testmotorDown] - Make every testmotor request fail.
 * @param {string|null} [options.xsd] - The schema every data type resolves to, or null to answer 404.
 * @param {string} [options.xsdError] - A schema path fragment to answer 500 for. A 404 means "no schema" and is
 *   handled; a 500 throws out of the fetch helper instead, which is the other path.
 */
function stubExampleSources({ apps = [], xmlByApp = {}, testmotorDown = false, xsd = XSD, xsdError = null }) {
    clearTestmotorCache();
    globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.includes("app-ftpb-testmotor")) {
            if (testmotorDown) {
                throw new TypeError("fetch failed");
            }
            const body = target.endsWith("/api/altinn-app") ? apps : (xmlByApp[decodeURIComponent(target.split("/api/xml/")[1])] ?? []);
            return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
        }
        if (target.endsWith(".xsd")) {
            if (xsdError && target.includes(xsdError)) {
                return { ok: false, status: 500, statusText: "Internal Server Error", text: async () => "" };
            }
            if (xsd !== null) {
                return { ok: true, status: 200, text: async () => xsd };
            }
        }
        return { ok: false, status: 404, text: async () => "" };
    };
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
    return result.find((entry) => entry.appName === appName);
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

test("files a subform under no app, once, however many apps declare it", async (t) => {
    // GjennomfoeringsplanDataV7 is declared by several apps and its examples are one shared set, so the entry
    // matches any app that declares the data type rather than naming whichever parent reached it first.
    await withExampleDir(t, {
        "subforms/GjennomfoeringsplanDataV7/GjennomfoeringsplanDataV7.xml": xml("gjennomfoeringsplan")
    });
    stubExampleSources({ apps: [] });

    const result = await getJsonExampleData();
    const subformEntries = result.filter((entry) => entry.dataType === "GjennomfoeringsplanDataV7");

    assert.equal(subformEntries.length, 1);
    assert.equal(subformEntries[0].appName, null);
    assert.equal(subformEntries[0].appOwner, null);
    assert.deepEqual(subformEntries[0].files, [{ name: "GjennomfoeringsplanDataV7", data: { tittel: "gjennomfoeringsplan" } }]);

    const declaringApps = altinnStudioApps.filter((app) => app.subForms?.some((subForm) => subForm.dataType === "GjennomfoeringsplanDataV7"));
    assert.ok(declaringApps.length > 1);
});

test("gives every tracked app an entry of its own", async () => {
    stubExampleSources({ apps: [] });

    const result = await getJsonExampleData();
    const mainFormEntries = result.filter((entry) => entry.appName !== null);

    assert.equal(mainFormEntries.length, altinnStudioApps.length);
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
    // And it costs that app only — every other app still gets its entry.
    assert.equal(result.filter((other) => other.appName !== null).length, altinnStudioApps.length);
});

test("drops a subform that could not be processed, and nothing else", async (t) => {
    await withExampleDir(t, { "subforms/GjennomfoeringsplanDataV7/GjennomfoeringsplanDataV7.xml": xml("gjennomfoeringsplan") });
    stubExampleSources({ apps: [], xsdError: "GjennomfoeringsplanDataV7.xsd" });

    const result = await getJsonExampleData();

    assert.ok(
        result.every((entry) => entry !== null),
        "a subform that could not be processed must leave no hole in the result"
    );
    assert.equal(
        result.some((entry) => entry.dataType === "GjennomfoeringsplanDataV7"),
        false
    );
    assert.equal(result.filter((entry) => entry.appName !== null).length, altinnStudioApps.length);
});

test("answers in catalogue order, each subform placed with the first app that declares it", async () => {
    // The apps are fetched concurrently, so the order they finish in is not the order they are named in. What the
    // dashboard receives has to be the catalogue's order regardless of which app's upstream answered first.
    stubExampleSources({ apps: [] });

    const result = await getJsonExampleData();

    assert.deepEqual(
        result.filter((entry) => entry.appName !== null).map((entry) => entry.appName),
        altinnStudioApps.map((app) => app.appName)
    );

    // A subform's schema comes from the app it was reached through, so it has to sit with the first app declaring it
    // — the one that supplied the schema — rather than with whichever app's fetch happened to settle first.
    let precedingApp = null;
    for (const entry of result) {
        if (entry.appName !== null) {
            precedingApp = entry.appName;
            continue;
        }
        const firstDeclaringApp = altinnStudioApps.find((app) => app.subForms?.some((subForm) => subForm.dataType === entry.dataType));
        assert.equal(precedingApp, firstDeclaringApp.appName, `${entry.dataType} should follow ${firstDeclaringApp.appName}`);
    }

    // And each of them exactly once, however many apps declare it.
    const subformDataTypes = result.filter((entry) => entry.appName === null).map((entry) => entry.dataType);
    assert.equal(new Set(subformDataTypes).size, subformDataTypes.length);
});
