// Dependencies
import "dotenv/config";
import cors from "cors";
import express from "express";

// Local functions
import {
    getAltinnStudioForms,
    getAppResourceValues,
    getApplicationMetadata,
    getDefaultTextResources,
    getDisplayLayouts,
    getJsonExampleData,
    getLatestPackageVersions,
    getPackageVersions,
    supportedResourceLanguage
} from "./scripts/functions.mjs";
import { getDiagnostics, withRunLog } from "./utils/logger.mjs";
import { createCachedFunction } from "./utils/cache.mjs";

const app = express();

// Each endpoint below re-fetches from Altinn Studio / npm / disk for every tracked app. Cache the expensive
// getters so repeated "Synchronize" runs within a session don't re-fan-out. The TTL is short so an intentional
// re-sync after editing an app still reflects the changes; tune or disable via CACHE_TTL_MS (0 disables).
const cacheTtlEnv = Number.parseInt(process.env.CACHE_TTL_MS, 10);
const cacheTtlMs = Number.isInteger(cacheTtlEnv) && cacheTtlEnv >= 0 ? cacheTtlEnv : 60000;

const cachedGetDisplayLayouts = createCachedFunction(getDisplayLayouts, { ttlMs: cacheTtlMs });
const cachedGetPackageVersions = createCachedFunction(getPackageVersions, { ttlMs: cacheTtlMs });
const cachedGetLatestPackageVersions = createCachedFunction(getLatestPackageVersions, { ttlMs: cacheTtlMs });
const cachedGetAppResourceValues = createCachedFunction(getAppResourceValues, { ttlMs: cacheTtlMs });
const cachedGetApplicationMetadata = createCachedFunction(getApplicationMetadata, { ttlMs: cacheTtlMs });
const cachedGetJsonExampleData = createCachedFunction(getJsonExampleData, { ttlMs: cacheTtlMs });

const envPort = process.env.API_PORT;
const parsedPort = envPort === undefined ? Number.NaN : Number.parseInt(envPort, 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;

if (port !== parsedPort) {
    const envPortMsg = envPort ? ' ("' + envPort + '")' : "";
    console.warn(`Invalid or missing API_PORT environment variable${envPortMsg}. Falling back to default port ${port}.`);
}

// Warn loudly at startup if the Gitea token is missing — every Altinn Studio fetch depends on it.
if (!process.env.GITEA_TOKEN || !process.env.GITEA_TOKEN.trim()) {
    console.warn("⚠️ GITEA_TOKEN is not set. Requests for Altinn Studio data (layouts, metadata, resources, schemas) will fail. Add it to .env — see .env.sample.");
}

// This API proxies private Altinn Studio content using a Gitea token, so restrict CORS to the local dev client
// (default: the webpack dev server on port 9000) instead of allowing every origin. Override with CLIENT_ORIGIN.
const allowedOrigin = process.env.CLIENT_ORIGIN || "http://localhost:9000";
app.use(cors({ origin: allowedOrigin }));

/**
 * Registers a GET endpoint that answers with JSON.
 *
 * Every endpoint below is the same eight lines around a different getter, and the parts that are easy to get wrong
 * are the parts they share: a handler whose rejection is not caught takes the process down under Express, and a
 * handler that reports the failure only to the terminal leaves the dashboard with nothing to show. Writing the shape
 * once means a new endpoint cannot be added without them.
 *
 * `get` is handed the request and is expected to be a closure rather than a bare cached getter: the cached getters
 * are keyed on their arguments, so passing one directly would put the whole request object into its cache key.
 *
 * @param {string} path - The route to register.
 * @param {Object} options
 * @param {(req: import("express").Request) => unknown} options.get - Produces the payload, or throws.
 * @param {string} options.failure - What went wrong, in the terminal and in the 500 body alike.
 * @param {string} [options.runLog] - Report headline. Left out for endpoints that do no work worth reporting.
 */
function jsonEndpoint(path, { get, failure, runLog }) {
    app.get(path, async (req, res) => {
        try {
            res.json(runLog ? await withRunLog(runLog, () => get(req)) : await get(req));
        } catch (error) {
            console.error(`${failure}:`, error);
            res.status(500).json({ error: failure });
        }
    });
}

jsonEndpoint("/api/displayLayouts", {
    runLog: "Display layouts",
    failure: "Failed to fetch display layouts",
    get: () => cachedGetDisplayLayouts()
});

jsonEndpoint("/api/packageVersions", {
    runLog: "Package versions",
    failure: "Failed to fetch package.json files",
    get: () => cachedGetPackageVersions()
});

jsonEndpoint("/api/latestPackageVersions", {
    runLog: "Latest package versions",
    failure: "Failed to fetch latest package versions",
    get: () => cachedGetLatestPackageVersions()
});

jsonEndpoint("/api/appResources", {
    runLog: "App resources",
    failure: "Failed to fetch app resource values",
    // Narrowed before it is cached, not after: the cache is keyed on the argument, so handing it the query value as
    // it arrived would give every spelling of an unsupported language a fan-out and an entry of its own.
    get: (req) => cachedGetAppResourceValues(supportedResourceLanguage(req.query.language))
});

jsonEndpoint("/api/resources", {
    failure: "Failed to fetch default text resources",
    get: () => getDefaultTextResources()
});

jsonEndpoint("/api/altinnStudioForms", {
    failure: "Failed to fetch Altinn Studio forms",
    get: () => getAltinnStudioForms()
});

jsonEndpoint("/api/exampleData", {
    runLog: "Example data",
    failure: "Failed to fetch example data",
    get: () => cachedGetJsonExampleData()
});

jsonEndpoint("/api/applicationMetadata", {
    runLog: "Application metadata",
    failure: "Failed to fetch application metadata",
    get: () => cachedGetApplicationMetadata()
});

// Reports what the data endpoints last ran into. Nothing fetches this yet — the Statistics dashboard does not call it,
// so a failure reaches a person only through the terminal, or through the `error` that /api/exampleData carries on the
// entries it could not fill. Deliberately given no runLog: it does no work of its own, and polling it would otherwise
// print a report line per request.
jsonEndpoint("/api/diagnostics", {
    failure: "Failed to build diagnostics",
    get: () => getDiagnostics()
});

app.listen(port, () => {
    console.log(`Altinn Studio Custom Components API listening on port ${port}`);
});
