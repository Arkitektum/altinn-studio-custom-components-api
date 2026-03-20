// Dependencies
import "dotenv/config";
import cors from "cors";
import express from "express";

// Local functions
import {
    getAltinnStudioForms,
    getAppResourceValues,
    getDefaultTextResources,
    getDisplayLayouts,
    getJsonExampleData,
    getPackageVersions
} from "./scripts/functions.mjs";

const app = express();

const envPort = process.env.API_PORT;
const parsedPort = envPort === undefined ? Number.NaN : Number.parseInt(envPort, 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;

if (port !== parsedPort) {
    console.warn(`Invalid or missing API_PORT environment variable${envPort ? ` ("${envPort}")` : ""}. Falling back to default port ${port}.`);
}

app.use(cors());

app.get("/api/displayLayouts", async (req, res) => {
    try {
        const layouts = await getDisplayLayouts();
        res.json(layouts);
    } catch (error) {
        console.error("Error fetching display layouts:", error);
        res.status(500).json({ error: "Failed to fetch display layouts" });
    }
});

app.get("/api/packageVersions", async (req, res) => {
    try {
        const packageVersions = await getPackageVersions();
        res.json(packageVersions);
    } catch (error) {
        console.error("Error fetching package.json files:", error);
        res.status(500).json({ error: "Failed to fetch package.json files" });
    }
});

app.get("/api/appResources", async (req, res) => {
    try {
        const appResources = await getAppResourceValues();
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
        const exampleData = await getJsonExampleData();
        res.json(exampleData);
    } catch (error) {
        console.error("Error fetching example data:", error);
        res.status(500).json({ error: "Failed to fetch example data" });
    }
});

app.listen(port, () => {
    console.log(`Altinn Studio Custom Components API listening on port ${port}`);
});
