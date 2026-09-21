import assert from "node:assert/strict";
import { test } from "node:test";

import altinnStudioApps from "../data/altinnStudioApps.mjs";
import { compareCatalogueWithTestmotor } from "./catalogueDrift.mjs";
import subforms from "../data/subforms.mjs";

/**
 * A catalogue small enough to reason about, holding every case that matters: an app both lists know, two apps
 * sharing a data type, an app only disk has, an app neither has, and an app with a subform.
 */
const catalogue = [
    { appOwner: "dibk", appName: "an-v2", dataType: "AN" },
    { appOwner: "dibk", appName: "fa-v3", dataType: "FA" },
    { appOwner: "dibk", appName: "fa-v5", dataType: "FA" },
    { appOwner: "dibk", appName: "hoeringettersynuttalelse-v2", dataType: "HoeringOgOffentligEttersynUttalelse" },
    { appOwner: "dibk", appName: "ts-v1", dataType: "TS" },
    {
        appOwner: "dibk",
        appName: "es-v2",
        dataType: "ES",
        subForms: [{ appName: "gjennomfoeringsplan-v7", dataType: "GjennomfoeringsplanDataV7" }]
    }
];

const subformList = [
    { appOwner: "dibk", appName: "gjennomfoeringsplan-v7", dataType: "GjennomfoeringsplanDataV7" },
    { appOwner: "dibk", appName: "dispensasjonsvarsel-v1", dataType: "DispensasjonsvarselDataV1" }
];

const testmotorApps = [
    { appId: "an-v2", mainFormId: "AN" },
    { appId: "fa-v3", mainFormId: "FA" },
    { appId: "fa-v5", mainFormId: "FA" },
    { appId: "es-v2", mainFormId: "ES" },
    { appId: "varselplanoppstart-v4", mainFormId: "Planvarsel" }
];

/**
 * Runs the comparison over the fixtures, with anything the test cares about overridden.
 *
 * @param {Object} [overrides]
 * @returns {Object}
 */
function compare(overrides = {}) {
    return compareCatalogueWithTestmotor({
        catalogue,
        subformList,
        testmotorApps,
        formDataTypesOnDisk: new Set(["HoeringOgOffentligEttersynUttalelse"]),
        subformDataTypesOnDisk: new Set(["GjennomfoeringsplanDataV7"]),
        ...overrides
    });
}

/**
 * The source recorded for one app.
 *
 * @param {Object} drift
 * @param {string} appName
 * @returns {string|undefined}
 */
function sourceFor(drift, appName) {
    return drift.coverage.find((entry) => entry.appName === appName)?.source;
}

test("names an app the testmotor holds that the catalogue does not", () => {
    assert.deepEqual(compare().unknownToCatalogue, [{ appId: "varselplanoppstart-v4", mainFormId: "Planvarsel" }]);
});

test("says where each app's examples come from", () => {
    const drift = compare();

    assert.equal(sourceFor(drift, "an-v2"), "testmotor");
    assert.equal(sourceFor(drift, "hoeringettersynuttalelse-v2"), "disk");
    assert.equal(sourceFor(drift, "ts-v1"), "none");
});

test("gives every catalogue app exactly one coverage entry", () => {
    const drift = compare();

    assert.equal(drift.coverage.length, catalogue.length);
    assert.equal(new Set(drift.coverage.map((entry) => entry.appName)).size, catalogue.length);
});

test("does not credit a disk folder that two apps claim", () => {
    // A folder named FA cannot say whether it is fa-v3's or fa-v5's, so it counts for neither — the same rule
    // getJsonExampleData applies, so this report matches what the dashboard actually shows.
    const drift = compare({
        testmotorApps: [{ appId: "an-v2", mainFormId: "AN" }],
        formDataTypesOnDisk: new Set(["FA"])
    });

    assert.equal(sourceFor(drift, "fa-v3"), "none");
    assert.equal(sourceFor(drift, "fa-v5"), "none");
});

test("credits a disk folder only one app claims", () => {
    const drift = compare({
        testmotorApps: [],
        formDataTypesOnDisk: new Set(["TS"])
    });

    assert.equal(sourceFor(drift, "ts-v1"), "disk");
});

test("reports the two filing one app under different data types", () => {
    // The finding that would actually break something: the catalogue's data type is where the dashboard looks, and
    // the testmotor's is where the examples arrive.
    const drift = compare({
        testmotorApps: [{ appId: "fa-v5", mainFormId: "Ferdigattest" }]
    });

    assert.deepEqual(drift.disagreements, [{ appOwner: "dibk", appName: "fa-v5", catalogue: "FA", testmotor: "Ferdigattest" }]);
});

test("finds no disagreement when the two agree", () => {
    assert.deepEqual(compare().disagreements, []);
});

test("names a declared subform with no example file", () => {
    const drift = compare({ subformDataTypesOnDisk: new Set() });

    assert.deepEqual(drift.subformCoverage, [{ appName: "gjennomfoeringsplan-v7", dataType: "GjennomfoeringsplanDataV7", source: "none" }]);
});

test("ignores a subform no app declares", () => {
    // dispensasjonsvarsel-v1 is in the subform list but nothing in this catalogue references it, so its missing
    // example file is not this report's finding.
    const drift = compare({ subformDataTypesOnDisk: new Set() });

    assert.ok(!drift.subformCoverage.some((entry) => entry.dataType === "DispensasjonsvarselDataV1"));
});

test("copes with a testmotor that answered nothing", () => {
    const drift = compare({ testmotorApps: [] });

    assert.deepEqual(drift.unknownToCatalogue, []);
    assert.deepEqual(drift.disagreements, []);
    assert.ok(drift.coverage.every((entry) => entry.source !== "testmotor"));
});

test("runs over the real catalogue without losing or duplicating an app", () => {
    // Fixtures cannot go wrong the way the real catalogue does — three of its data types are claimed twice.
    const drift = compareCatalogueWithTestmotor({
        catalogue: altinnStudioApps,
        subformList: subforms,
        testmotorApps: [],
        formDataTypesOnDisk: new Set(),
        subformDataTypesOnDisk: new Set()
    });

    assert.equal(drift.coverage.length, altinnStudioApps.length);
    assert.equal(new Set(drift.coverage.map((entry) => `${entry.appOwner}/${entry.appName}`)).size, altinnStudioApps.length);
});
