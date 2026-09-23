import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "./app.mjs";

/**
 * What the endpoints answer, with every upstream stubbed.
 *
 * The getters behind these routes have their own tests. What is only testable from here is the wiring: that each
 * route calls the getter it says it does, that a failure comes back as a 500 rather than taking the process down,
 * and that the query string is narrowed before it reaches the cache. Nothing here touches the network.
 */

const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };

let server;
let base;

before(async () => {
    process.env.GITEA_TOKEN = "test-token";
    process.env.EXAMPLE_DATA_DIR = "/tmp/endpoints-test-examples";
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.close();
    process.env = originalEnvironment;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

/**
 * Answers every upstream this API reaches for, and records what was asked.
 *
 * @param {(url: string) => unknown} [respond] - Returns the body for a url, or throws to fail that request.
 * @returns {string[]} The urls requested so far, appended to as the app runs.
 */
function stubUpstreams(respond = () => null) {
    const urls = [];
    globalThis.fetch = async (url) => {
        const target = String(url);
        urls.push(target);
        const body = respond(target);
        if (body === null) {
            return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
        }
        const serialized = typeof body === "string" ? body : JSON.stringify(body);
        return { ok: true, status: 200, statusText: "OK", text: async () => serialized, json: async () => body };
    };
    return urls;
}

/** Asks the running app for a route, and answers its status and parsed body. */
async function call(path) {
    const response = await originalFetch(`${base}${path}`);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

describe("the routes that answer from disk or memory", () => {
    it("lists the tracked apps and the subforms they declare", async () => {
        const { status, body } = await call("/api/altinnStudioForms");

        assert.equal(status, 200);
        assert.ok(body.length > 0, "expected the catalogue to have entries");
        assert.ok(
            body.every((entry) => typeof entry.appOwner === "string" && typeof entry.appName === "string"),
            "every entry names an app"
        );
    });

    it("answers diagnostics without running anything of its own", async () => {
        // Deliberately outside withRunLog, so polling it does not print a report line per request.
        const urls = stubUpstreams();

        const { status, body } = await call("/api/diagnostics");

        assert.equal(status, 200);
        assert.equal(typeof body.generatedAt, "string");
        assert.deepEqual(urls, []);
    });
});

describe("the routes that fan out to Altinn Studio", () => {
    it("answers JSON with the CORS origin the client is served from", async () => {
        stubUpstreams();

        const { status, headers } = await call("/api/applicationMetadata");

        assert.equal(status, 200);
        assert.equal(headers.get("access-control-allow-origin"), process.env.CLIENT_ORIGIN || "http://localhost:9000");
    });

    it("still answers when the network is gone, rather than failing the request", async () => {
        // getLatestPackageVersions reports an unreachable registry as a null version rather than throwing, so the
        // dashboard gets a row saying "not resolved" instead of an error page.
        globalThis.fetch = async () => {
            throw new Error("the network is gone");
        };

        const { status, body } = await call("/api/latestPackageVersions");

        assert.equal(status, 200);
        assert.ok(Object.keys(body).length > 0, "every configured package is accounted for");
        assert.ok(
            Object.values(body).every((version) => version === null),
            "and each one reads as unresolved"
        );
    });
});

describe("the language a caller asks for", () => {
    /**
     * Runs one case against an app of its own.
     *
     * These cases are about what reaches the cache, so they cannot share one: the first call for a language would
     * otherwise answer the second from memory and there would be nothing to count.
     *
     * @param {(ask: (path: string) => Promise<{status: number}>, urls: string[]) => Promise<void>} run
     */
    async function withFreshApp(run) {
        const urls = [];
        globalThis.fetch = async (url) => {
            urls.push(String(url));
            const body = { resources: [{ id: "a", value: "Alpha" }] };
            return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body), json: async () => body };
        };
        const app = createApp().listen(0, "127.0.0.1");
        await new Promise((resolve) => app.once("listening", resolve));
        const host = `http://127.0.0.1:${app.address().port}`;
        try {
            await run(async (path) => {
                const response = await originalFetch(`${host}${path}`);
                await response.text();
                return { status: response.status };
            }, urls);
        } finally {
            app.close();
        }
    }

    /** The resource files requested, reduced to the language each one is for. */
    const languagesRequested = (urls) => {
        const languages = urls.filter((url) => url.includes("resource.")).map((url) => url.match(/resource\.(\w+)\.json/)[1]);
        return [...new Set(languages)].sort();
    };

    it("fetches only the language asked for when it is one the apps ship", async () => {
        await withFreshApp(async (ask, urls) => {
            assert.equal((await ask("/api/appResources?language=nb")).status, 200);
            assert.deepEqual(languagesRequested(urls), ["nb"]);
        });
    });

    it("fetches every supported language when the one asked for is not one of them", async () => {
        await withFreshApp(async (ask, urls) => {
            assert.equal((await ask("/api/appResources?language=xx")).status, 200);
            assert.deepEqual(languagesRequested(urls), ["nb", "nn"]);
        });
    });

    it("gives every spelling that means nothing in particular the same cache entry", async () => {
        // This is the point of narrowing the query string before it reaches the cache. Without it each spelling is a
        // miss of its own, and every miss re-fetches a resource file from every tracked app.
        await withFreshApp(async (ask, urls) => {
            await ask("/api/appResources?language=xx");
            const afterFirst = urls.length;

            await ask("/api/appResources?language=yy");
            await ask("/api/appResources?language[]=nb");
            await ask("/api/appResources");

            assert.ok(afterFirst > 0, "the first request fetched something");
            assert.equal(urls.length, afterFirst, "and the three that mean the same thing fetched nothing more");
        });
    });
});

describe("what the API refuses", () => {
    it("answers an unknown route with a 404", async () => {
        const response = await originalFetch(`${base}/api/there-is-no-such-route`);

        assert.equal(response.status, 404);
    });
});
