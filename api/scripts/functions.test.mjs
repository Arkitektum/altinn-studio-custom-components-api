import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import altinnStudioApps from "../data/altinnStudioApps.mjs";
import { getAppResourceValues } from "./functions.mjs";

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITEA_TOKEN;
const originalWarn = console.warn;

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
    // The skip paths log deliberately; keep the test output readable.
    console.warn = () => {};
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
    } else {
        process.env.GITEA_TOKEN = originalToken;
    }
    console.warn = originalWarn;
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
