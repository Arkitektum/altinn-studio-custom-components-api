import assert from "node:assert/strict";
import { test } from "node:test";

import { clearTestmotorCache, fetchTestmotorApps, fetchTestmotorFormXml } from "./testmotorClient.mjs";

const DEFAULT_URL = "https://app-ftpb-testmotor.azurewebsites.net";

/**
 * Replaces the global fetch for the duration of one test, and clears the client's cache either side of it so tests
 * cannot see each other's answers.
 *
 * @param {import("node:test").TestContext} t
 * @param {(url: string, callCount: number) => any} responder - Returns the response, or throws to fail the request.
 * @returns {string[]} The urls requested so far, appended to as the test runs.
 */
function stubFetch(t, responder) {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.TESTMOTOR_URL;
    const urls = [];

    clearTestmotorCache();
    globalThis.fetch = async (url) => {
        urls.push(url);
        return responder(url, urls.length);
    };

    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalUrl === undefined) {
            delete process.env.TESTMOTOR_URL;
        } else {
            process.env.TESTMOTOR_URL = originalUrl;
        }
        clearTestmotorCache();
    });

    return urls;
}

/**
 * A successful JSON response, as much of one as the client touches.
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, status: number, statusText: string, json: () => Promise<unknown>, text: () => Promise<string> }}
 */
function jsonResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
        text: async () => JSON.stringify(body)
    };
}

/**
 * A failed response.
 *
 * @param {number} status
 * @param {string} statusText
 * @param {string} [body]
 */
function errorResponse(status, statusText, body = "") {
    return {
        ok: false,
        status,
        statusText,
        json: async () => {
            throw new Error("not json");
        },
        text: async () => body
    };
}

/** What the testmotor answers for /api/altinn-app, trimmed to the shape and the cases that matter. */
const APPS = [
    { appId: "an-v2", mainFormId: "AN" },
    { appId: "fa-v3", mainFormId: "FA" },
    { appId: "fa-v5", mainFormId: "FA" }
];

/**
 * What the testmotor answers for /api/xml/fa-v5: bare stems, no extension, no ordering prefix, in the share's own
 * order. "Maksimumsversjon" arriving before "Minimumsversjon" is the case that catches a stray sort, and
 * "Automatiseringskrav" last is the case that catches an alphabetical one.
 */
const FA_V5_FILES = [
    { name: "Standard", contents: "<ferdigattest>standard</ferdigattest>" },
    { name: "Maksimumsversjon", contents: "<ferdigattest>maks</ferdigattest>" },
    { name: "Minimumsversjon", contents: "<ferdigattest>min</ferdigattest>" },
    { name: "Automatiseringskrav", contents: "<ferdigattest>auto</ferdigattest>" }
];

test("lists the apps the testmotor holds, with the data type each main form is filed under", async (t) => {
    stubFetch(t, () => jsonResponse(APPS));

    assert.deepEqual(await fetchTestmotorApps(), APPS);
});

test("keeps two apps sharing one data type apart", async (t) => {
    // The reason the client is keyed on the app id at all: fa-v3 and fa-v5 are both filed under FA and hold
    // different data, so collapsing them onto the data type loses one of them.
    stubFetch(t, () => jsonResponse(APPS));

    const apps = await fetchTestmotorApps();
    const filedUnderFa = apps.filter((app) => app.mainFormId === "FA").map((app) => app.appId);
    assert.deepEqual(filedUnderFa, ["fa-v3", "fa-v5"]);
});

test("drops an app entry that names no app or no data type", async (t) => {
    stubFetch(t, () =>
        jsonResponse([
            { appId: "an-v2", mainFormId: "AN" },
            { appId: "ghost-v1" },
            { mainFormId: "GHOST" },
            { appId: "", mainFormId: "GHOST" },
            { appId: "ghost-v2", mainFormId: "" },
            { appId: 42, mainFormId: "GHOST" },
            null
        ])
    );

    assert.deepEqual(await fetchTestmotorApps(), [{ appId: "an-v2", mainFormId: "AN" }]);
});

test("requests the two documented endpoints, with the app id encoded", async (t) => {
    const urls = stubFetch(t, (url) => jsonResponse(url.includes("/api/xml/") ? FA_V5_FILES : APPS));

    await fetchTestmotorApps();
    await fetchTestmotorFormXml("fa-v5");
    await fetchTestmotorFormXml("owner/app v1");

    assert.deepEqual(urls, [`${DEFAULT_URL}/api/altinn-app`, `${DEFAULT_URL}/api/xml/fa-v5`, `${DEFAULT_URL}/api/xml/owner%2Fapp%20v1`]);
});

test("keeps the order the testmotor answers files in, rather than sorting the stems", async (t) => {
    stubFetch(t, () => jsonResponse(FA_V5_FILES));

    const names = (await fetchTestmotorFormXml("fa-v5")).map((file) => file.name);
    assert.deepEqual(names, ["Standard", "Maksimumsversjon", "Minimumsversjon", "Automatiseringskrav"]);
});

test("leaves a file name as the bare stem it arrives as", async (t) => {
    // The share's "01_Maksimumsversjon.xml" arrives with both the prefix and the extension already stripped. The
    // client passes that through untouched; deciding what to label or key it as is the caller's problem.
    stubFetch(t, () => jsonResponse(FA_V5_FILES));

    const [, maksimum] = await fetchTestmotorFormXml("fa-v5");
    assert.equal(maksimum.name, "Maksimumsversjon");
    assert.equal(maksimum.contents, "<ferdigattest>maks</ferdigattest>");
});

test("drops a file with no name and one with no contents", async (t) => {
    stubFetch(t, () =>
        jsonResponse([
            { name: "Standard", contents: "<x/>" },
            { name: "", contents: "<x/>" },
            { contents: "<x/>" },
            { name: "Tom", contents: "" },
            { name: "Mangler" },
            { name: "Feiltype", contents: 42 },
            null
        ])
    );

    assert.deepEqual(await fetchTestmotorFormXml("fa-v5"), [{ name: "Standard", contents: "<x/>" }]);
});

test("answers an empty list for an app the testmotor holds nothing for", async (t) => {
    // Distinct from a failure: this is a real answer, and the caller has to be able to tell them apart.
    stubFetch(t, () => jsonResponse([]));

    assert.deepEqual(await fetchTestmotorFormXml("hoeringettersynuttalelse-v2"), []);
});

test("reuses one request for repeated calls", async (t) => {
    const urls = stubFetch(t, () => jsonResponse(FA_V5_FILES));

    await fetchTestmotorFormXml("fa-v5");
    await fetchTestmotorFormXml("fa-v5");

    assert.equal(urls.length, 1);
});

test("caches each app separately", async (t) => {
    const urls = stubFetch(t, (url) => jsonResponse(url.endsWith("fa-v5") ? FA_V5_FILES : [{ name: "Standard", contents: "<v3/>" }]));

    const v5 = await fetchTestmotorFormXml("fa-v5");
    const v3 = await fetchTestmotorFormXml("fa-v3");

    assert.equal(urls.length, 2);
    assert.equal(v5.length, 4);
    assert.deepEqual(v3, [{ name: "Standard", contents: "<v3/>" }]);
});

test("shares one request between concurrent callers", async (t) => {
    const urls = stubFetch(t, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse(FA_V5_FILES);
    });

    const [first, second] = await Promise.all([fetchTestmotorFormXml("fa-v5"), fetchTestmotorFormXml("fa-v5")]);

    assert.equal(urls.length, 1);
    assert.deepEqual(first, second);
});

test("does not cache a failure — the next call tries again", async (t) => {
    // A five-minute cache over a rejection would let a moment of the host being down outlast the outage.
    const urls = stubFetch(t, (url, callCount) => {
        if (callCount === 1) {
            throw new TypeError("fetch failed");
        }
        return jsonResponse(FA_V5_FILES);
    });

    await assert.rejects(() => fetchTestmotorFormXml("fa-v5"), /could not be reached/);
    assert.equal((await fetchTestmotorFormXml("fa-v5")).length, 4);
    assert.equal(urls.length, 2);
});

test("names the url and the status when the testmotor answers an error", async (t) => {
    stubFetch(t, () => errorResponse(503, "Service Unavailable", "upstream share unavailable"));

    await assert.rejects(
        () => fetchTestmotorApps(),
        (error) => {
            assert.match(error.message, /\/api\/altinn-app answered 503 Service Unavailable/);
            assert.match(error.message, /upstream share unavailable/);
            return true;
        }
    );
});

test("names the url when the testmotor cannot be reached at all", async (t) => {
    stubFetch(t, () => {
        throw new TypeError("fetch failed");
    });

    await assert.rejects(
        () => fetchTestmotorFormXml("fa-v5"),
        (error) => {
            assert.match(error.message, /app-ftpb-testmotor.*\/api\/xml\/fa-v5 could not be reached: fetch failed/);
            assert.ok(error.cause instanceof TypeError);
            return true;
        }
    );
});

test("throws when an endpoint answers something other than a list", async (t) => {
    stubFetch(t, (url) => jsonResponse(url.includes("/api/xml/") ? { error: "nope" } : { error: "nope" }));

    await assert.rejects(() => fetchTestmotorApps(), /\/api\/altinn-app did not answer a list\./);
    await assert.rejects(() => fetchTestmotorFormXml("fa-v5"), /\/api\/xml\/fa-v5 did not answer a list\./);
});

test("throws when a response is not JSON", async (t) => {
    stubFetch(t, () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
        text: async () => "<html>login</html>"
    }));

    await assert.rejects(() => fetchTestmotorApps(), /\/api\/altinn-app did not answer JSON: Unexpected token/);
});

test("reads the base url from TESTMOTOR_URL, trailing slash and all", async (t) => {
    const urls = stubFetch(t, () => jsonResponse(APPS));
    process.env.TESTMOTOR_URL = "http://localhost:5005/";

    await fetchTestmotorApps();

    assert.deepEqual(urls, ["http://localhost:5005/api/altinn-app"]);
});

test("falls back to the hosted testmotor when TESTMOTOR_URL is blank", async (t) => {
    const urls = stubFetch(t, () => jsonResponse(APPS));
    process.env.TESTMOTOR_URL = "   ";

    await fetchTestmotorApps();

    assert.deepEqual(urls, [`${DEFAULT_URL}/api/altinn-app`]);
});
