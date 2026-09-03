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
    getPackageVersions
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

app.get("/api/displayLayouts", async (req, res) => {
    try {
        const layouts = await withRunLog("Display layouts", cachedGetDisplayLayouts);
        res.json(layouts);
    } catch (error) {
        console.error("Error fetching display layouts:", error);
        res.status(500).json({ error: "Failed to fetch display layouts" });
    }
});

app.get("/api/packageVersions", async (req, res) => {
    try {
        const packageVersions = await withRunLog("Package versions", cachedGetPackageVersions);
        res.json(packageVersions);
    } catch (error) {
        console.error("Error fetching package.json files:", error);
        res.status(500).json({ error: "Failed to fetch package.json files" });
    }
});

app.get("/api/latestPackageVersions", async (req, res) => {
    try {
        const packageVersions = await withRunLog("Latest package versions", cachedGetLatestPackageVersions);
        res.json(packageVersions);
    } catch (error) {
        console.error("Error fetching latest package versions:", error);
        res.status(500).json({ error: "Failed to fetch latest package versions" });
    }
});

app.get("/api/appResources", async (req, res) => {
    try {
        const appResources = await withRunLog("App resources", () => cachedGetAppResourceValues(req.query.language));
        res.json(appResources);
    } catch (error) {
        console.error("Error fetching app resource values:", error);
        res.status(500).json({ error: "Failed to fetch app resource values" });
    }
});

app.get("/api/resources", async (req, res) => {
    try {
        const defaultTextResources = await getDefaultTextResources();
        res.json(defaultTextResources);
    } catch (error) {
        console.error("Error fetching default text resources:", error);
        res.status(500).json({ error: "Failed to fetch default text resources" });
    }
});

app.get("/api/altinnStudioForms", (req, res) => {
    try {
        const altinnStudioForms = getAltinnStudioForms();
        res.json(altinnStudioForms);
    } catch (error) {
        console.error("Error fetching Altinn Studio forms:", error);
        res.status(500).json({ error: "Failed to fetch Altinn Studio forms" });
    }
});

app.get("/api/exampleData", async (req, res) => {
    try {
        const exampleData = await withRunLog("Example data", cachedGetJsonExampleData);
        res.json(exampleData);
    } catch (error) {
        console.error("Error fetching example data:", error);
        res.status(500).json({ error: "Failed to fetch example data" });
    }
});

app.get("/api/applicationMetadata", async (req, res) => {
    try {
        const applicationMetadata = await withRunLog("Application metadata", cachedGetApplicationMetadata);
        res.json(applicationMetadata);
    } catch (error) {
        console.error("Error fetching application metadata:", error);
        res.status(500).json({ error: "Failed to fetch application metadata" });
    }
});

// Reports what the data endpoints last ran into, so the Statistics dashboard can surface problems instead of leaving
// them in the terminal. Deliberately not wrapped in withRunLog: it does no work of its own, and polling it would
// otherwise print a report line per request.
app.get("/api/diagnostics", (req, res) => {
    try {
        res.json(getDiagnostics());
    } catch (error) {
        console.error("Error building diagnostics:", error);
        res.status(500).json({ error: "Failed to build diagnostics" });
    }
});

app.listen(port, () => {
    console.log(`Altinn Studio Custom Components API listening on port ${port}`);
});
