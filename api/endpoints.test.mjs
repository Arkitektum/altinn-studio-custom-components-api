import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { request as httpRequest } from "node:http";

import altinnStudioApps from "./data/altinnStudioApps.mjs";
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
    it("lists the tracked apps, with the subforms each declares but not as apps of their own", async () => {
        const { status, body } = await call("/api/altinnStudioForms");

        assert.equal(status, 200);
        assert.ok(body.length > 0, "expected the catalogue to have entries");
        assert.ok(
            body.every((entry) => typeof entry.appOwner === "string" && typeof entry.appName === "string"),
            "every entry names an app"
        );
        assert.deepEqual(
            body.map((entry) => `${entry.appOwner}/${entry.appName}`),
            altinnStudioApps.map((app) => `${app.appOwner}/${app.appName}`)
        );
        const subformAppNames = new Set(altinnStudioApps.flatMap((app) => (app.subForms ?? []).map((subForm) => subForm.appName)));
        assert.ok(subformAppNames.size > 0, "expected the catalogue to declare at least one subform");
        assert.ok(!body.some((entry) => subformAppNames.has(entry.appName)), "a subform is listed as an app");
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

    it("answers one display layout entry per app, with each subform under the app carrying it", async () => {
        stubUpstreams((url) => (url.endsWith(".json") ? { data: { layout: [] } } : null));

        const { status, body } = await call("/api/displayLayouts");

        assert.equal(status, 200);
        assert.deepEqual(
            body.map((entry) => `${entry.appOwner}/${entry.appName}`),
            altinnStudioApps.map((app) => `${app.appOwner}/${app.appName}`)
        );
        assert.ok(!body.some((entry) => entry.isSubform), "a subform is answered as an entry of its own");
        const carried = body.flatMap((entry) => entry.subForms ?? []);
        assert.ok(carried.length > 0, "expected at least one app to carry a subform");
        assert.ok(
            carried.every((subForm) => subForm.layout),
            "every subform carries the layout fetched for it"
        );
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

    it("answers every app's copy of each subform's model, read from that app's repository", async () => {
        const urls = stubUpstreams((url) =>
            url.endsWith(".xsd")
                ? `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="Subform" type="xs:string" /></xs:schema>`
                : null
        );

        const { status, body } = await call("/api/subformDataModels");

        assert.equal(status, 200);
        const declared = altinnStudioApps.flatMap((app) => (app.subForms ?? []).map((subForm) => `${app.appName} ${subForm.dataType}`));
        assert.ok(declared.length > 0, "expected the catalogue to declare at least one subform");
        assert.deepEqual(body.flatMap((entry) => entry.copies.map((copy) => `${copy.appName} ${entry.dataType}`)).sort(), [...declared].sort());
        assert.ok(
            body.every((entry) => entry.copies.every((copy) => copy.error === null && copy.rootElement === "Subform")),
            "every copy was read"
        );
        assert.ok(
            urls.every((url) => url.includes("/App/models/")),
            "only models were fetched"
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

describe("the files of a published version of the package", () => {
    /** A one-file tar archive, as npm packs one. */
    function tarOf(name, content) {
        const body = Buffer.from(content);
        const header = Buffer.alloc(512);
        header.write(name, 0);
        header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
        header.write("0", 156);
        return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]);
    }

    /** Answers the npm registry for one version, with the given files in its dist folder, and records the urls asked for. */
    function stubRegistry(version, files, { metadataStatus = 200 } = {}) {
        const tarball = gzipSync(
            Buffer.concat(
                Object.entries(files)
                    .map(([name, content]) => tarOf(`package/dist/${name}`, content).subarray(0, -1024))
                    .concat(Buffer.alloc(1024))
            )
        );
        const tarballUrl = `https://registry.npmjs.org/@arkitektum/altinn-studio-custom-components/-/altinn-studio-custom-components-${version}.tgz`;
        const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
        const urls = [];
        globalThis.fetch = async (url) => {
            urls.push(String(url));
            if (String(url) === tarballUrl) return new Response(tarball);
            return new Response(JSON.stringify({ dist: { tarball: tarballUrl, integrity } }), { status: metadataStatus });
        };
        return urls;
    }

    it("answers a file with its content type, cached for good, and with the CORS origin the client is served from", async () => {
        stubRegistry("16.0.1", { "main.js": "console.log('16.0.1');", "49c816770b639989d28b.woff2": "font" });
        const response = await originalFetch(`${base}/api/packageFiles/16.0.1/main.js`, { headers: { origin: "http://localhost:9000" } });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "console.log('16.0.1');");
        assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
        assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:9000");
        const font = await originalFetch(`${base}/api/packageFiles/16.0.1/49c816770b639989d28b.woff2`);
        assert.equal(font.headers.get("content-type"), "font/woff2");
    });

    it("refuses a version or file it does not serve without asking npm", async () => {
        const urls = stubRegistry("16.0.2", { "main.js": "x" });
        for (const path of [
            "/api/packageFiles/latest/main.js",
            "/api/packageFiles/16.0.2/package.json",
            "/api/packageFiles/16.0.2/..%2Fpackage.json"
        ]) {
            assert.equal((await originalFetch(`${base}${path}`)).status, 404, path);
        }
        assert.deepEqual(urls, []);
    });

    it("answers 404 for a file the version does not have, and for a version npm does not have", async () => {
        stubRegistry("16.0.3", { "main.js": "x" });
        const missingFile = await call("/api/packageFiles/16.0.3/main.css");
        assert.equal(missingFile.status, 404);
        assert.deepEqual(missingFile.body, { error: "Version 16.0.3 of the package has no main.css" });
        stubRegistry("0.0.9", {}, { metadataStatus: 404 });
        const missingVersion = await call("/api/packageFiles/0.0.9/main.js");
        assert.equal(missingVersion.status, 404);
        assert.match(missingVersion.body.error, /has no version 0\.0\.9 on npm/);
    });

    it("answers 502 when npm cannot be reached, without taking the process down", async () => {
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            globalThis.fetch = async () => {
                throw new TypeError("fetch failed");
            };
            const { status, body } = await call("/api/packageFiles/16.0.4/main.js");
            assert.equal(status, 502);
            assert.deepEqual(body, { error: "Failed to fetch package files" });
        } finally {
            console.error = originalConsoleError;
        }
    });
});

describe("what the API refuses", () => {
    it("answers an unknown route with a 404", async () => {
        const response = await originalFetch(`${base}/api/there-is-no-such-route`);

        assert.equal(response.status, 404);
    });

    it("refuses a request addressed to a name that is not ours, as a page that rebound its domain would send", async () => {
        const urls = stubUpstreams();

        assert.equal(await statusForHost("attacker.example:9001", "/api/displayLayouts"), 403);
        // Refused before the endpoint ran, so nothing was fetched with the token.
        assert.deepEqual(urls, []);
    });

    it("answers a request addressed to localhost or an IP address", async () => {
        assert.equal(await statusForHost("localhost:9001"), 200);
        assert.equal(await statusForHost("127.0.0.1:9001"), 200);
        assert.equal(await statusForHost("[::1]:9001"), 200);
    });
});

/**
 * The status the API answers with, given a Host header. fetch will not send a Host other than the URL's, so this goes
 * through node:http.
 *
 * @param {string} host
 * @param {string} [path="/api/diagnostics"]
 * @returns {Promise<number>}
 */
function statusForHost(host, path = "/api/diagnostics") {
    return new Promise((resolve, reject) => {
        const req = httpRequest(`${base}${path}`, { headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
    });
}
