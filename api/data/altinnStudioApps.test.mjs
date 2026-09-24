// Dependencies
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Data
import altinnStudioApps from "./altinnStudioApps.mjs";

describe("the projected app list", () => {
    it("spells every app the way this repository reads it", () => {
        // The shared catalogue calls these org and app. Everything here reads appOwner and appName, so the
        // projection is the only place the two spellings meet.
        for (const app of altinnStudioApps) {
            assert.ok(app.appOwner?.length, `an app has no appOwner: ${JSON.stringify(app)}`);
            assert.ok(app.appName?.length, `an app has no appName: ${JSON.stringify(app)}`);
            assert.ok(app.dataType?.length, `${app.appName} has no dataType`);
            assert.equal(app.org, undefined, `${app.appName} still carries the shared catalogue's org`);
            assert.equal(app.app, undefined, `${app.appName} still carries the shared catalogue's app`);
        }
    });

    it("spells the subforms the same way, without the organisation they carry upstream", () => {
        for (const app of altinnStudioApps) {
            for (const subForm of app.subForms ?? []) {
                assert.ok(subForm.appName?.length, `${app.appName} has a subform with no appName`);
                assert.ok(subForm.dataType?.length, `${app.appName} has a subform with no dataType`);
                assert.deepEqual(Object.keys(subForm), ["appName", "dataType"]);
            }
        }
    });

    it("leaves subForms out for an app that has none", () => {
        // getDisplayLayouts puts whatever it finds here straight into its answer, so an empty list would show up
        // as "subForms": [] for some apps and nothing for others.
        for (const app of altinnStudioApps) {
            assert.notEqual(app.subForms?.length, 0, `${app.appName} carries an empty subForms list`);
        }
    });

    it("keeps the layout files for the apps that name them", () => {
        const named = altinnStudioApps.filter((app) => app.layoutFiles);

        assert.ok(named.length > 0, "expected at least one app to name its layout files");
        for (const app of named) {
            for (const file of app.layoutFiles) {
                assert.ok(file.name?.length && file.path?.endsWith(".json"), `${app.appName} has a bad layout file entry`);
            }
        }
    });

    it("holds the apps this API is expected to serve", () => {
        // A sanity check on the shared list being the one this repository means, rather than an empty or partial
        // answer from a package that failed to resolve.
        const names = altinnStudioApps.map((app) => `${app.appOwner}/${app.appName}`);

        assert.ok(altinnStudioApps.length >= 26, `expected the full catalogue, got ${altinnStudioApps.length} apps`);
        assert.ok(names.includes("dibk/fa-v5"), "the ferdigattest app is missing");
        assert.ok(names.includes("dat/byggesak-samtykke-v3"), "the arbeidstilsynet app is missing");
    });
});
