import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { log, withRunLog } from "./logger.mjs";

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

let output;

/**
 * Collects everything the logger writes, so a test can assert on the rendered report instead of the internals.
 */
function captureConsole() {
    output = [];
    const collect = (...args) => output.push(args.join(" "));
    console.log = collect;
    console.warn = collect;
    console.error = collect;
}

/** The captured output as a single string. */
const captured = () => output.join("\n");

beforeEach(captureConsole);

afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
});

test("prints one report per run, listing the affected source and a totals row", async () => {
    await withRunLog("Example data", async () => {
        log.ok({ scope: "dibk/ig-v3", category: "Example data", message: "01_Standard.xml" });
        log.ok({ scope: "dibk/ig-v3", category: "Example data", message: "02_AnsvarligSoker.xml" });
        log.warn({ scope: "dibk/rs-v4", category: "File not found in Altinn Studio", message: "App/config/texts/resource.nn.json" });
    });

    // One write for the whole report keeps concurrent runs from interleaving.
    assert.equal(output.length, 1);
    const report = captured();
    assert.match(report, /Example data/);
    assert.match(report, /1 warning\b/);
    assert.match(report, /dibk\/rs-v4\s+·\s+1/);
    // The clean source is folded away, but its successes still count towards the totals.
    assert.match(report, /1 other source · all clear\s+2/);
    assert.match(report, /Total\s+2\s+1/);
});

test("reduces an all-clear run to a single line", async () => {
    await withRunLog("Package versions", async () => {
        log.ok({ scope: "dibk/ig-v3", category: "Package versions" });
        log.ok({ scope: "dibk/rs-v4", category: "Package versions" });
    });

    assert.equal(output.length, 1);
    assert.match(captured(), /Package versions .*all clear .*2 OK across 2 sources/);
    // Nothing needs attention, so the table is not worth the screen space.
    assert.ok(!captured().includes("Warn"));
});

test("folds the source list once more than a screenful needs attention", async () => {
    await withRunLog("App resources", async () => {
        for (let index = 0; index < 20; index += 1) {
            log.warn({ scope: `dibk/app-${String(index).padStart(2, "0")}`, category: "File not found in Altinn Studio", message: "resource.nn.json" });
        }
    });

    const report = captured();
    assert.match(report, /8 other sources\s+·\s+8/);
    assert.match(report, /Total\s+·\s+20/);
    // Folding the table never hides a source: the detail section still names all 20.
    assert.match(report, /resource\.nn\.json — 20 sources/);
    assert.match(report, /dibk\/app-19/);
});

test("groups warnings and errors by category and shows the full detail text", async () => {
    await withRunLog("Example data", async () => {
        log.error({
            scope: "dibk/uttalelse",
            category: "Example data not processed",
            message: "HoeringOgOffentligEttersynUttalelse",
            detail: "XML does not conform to XSD:\nNo matching global declaration available for the validation root."
        });
        log.warn({ scope: "dibk/rs-v4", category: "File not found in Altinn Studio", message: "resource.nn.json" });
        log.warn({ scope: "dibk/ko-v2", category: "File not found in Altinn Studio", message: "resource.nn.json" });
    });

    const report = captured();
    // Both warnings sit under a single group heading that carries their combined count, and because they share the
    // same cause they are summed into one entry listing the affected sources.
    assert.match(report, /File not found in Altinn Studio \(2\)/);
    assert.match(report, /resource\.nn\.json — 2 sources/);
    assert.match(report, /dibk\/rs-v4, dibk\/ko-v2/);
    // Multi-line details keep every line.
    assert.match(report, /XML does not conform to XSD:/);
    assert.match(report, /No matching global declaration available for the validation root\./);
});

test("collapses repeated identical events into one entry with a count", async () => {
    await withRunLog("Display layouts", async () => {
        log.warn({ scope: "dibk/rs-v4", category: "File not found in Altinn Studio", message: "DisplayLayout.json" });
        log.warn({ scope: "dibk/rs-v4", category: "File not found in Altinn Studio", message: "DisplayLayout.json" });
        log.warn({ scope: "dibk/rs-v4", category: "File not found in Altinn Studio", message: "DisplayLayout.json" });
    });

    const report = captured();
    assert.match(report, /File not found in Altinn Studio \(3\)/);
    assert.match(report, /dibk\/rs-v4 ×3 · DisplayLayout\.json/);
    // The detail line appears once, not three times.
    assert.equal(report.match(/DisplayLayout\.json/g).length, 1);
});

test("reports a run that recorded nothing as a single line", async () => {
    await withRunLog("Application metadata", async () => "cached");

    assert.equal(output.length, 1);
    assert.match(captured(), /Application metadata .*nothing to report/);
});

test("still prints the report when the run throws", async () => {
    await assert.rejects(
        withRunLog("Package versions", async () => {
            log.error({ scope: "dibk/rs-v4", category: "Package versions not resolved", detail: "boom" });
            throw new Error("upstream failed");
        }),
        /upstream failed/
    );

    assert.match(captured(), /Package versions not resolved/);
});

test("falls back to plain console output when no run is active", () => {
    log.warn({ scope: "dibk/rs-v4", category: "File not found in Altinn Studio", message: "App/x.json" });
    log.ok({ scope: "dibk/rs-v4", category: "Not interesting on its own" });

    // The warning is never swallowed, but an unaggregated success has nothing to add.
    assert.equal(output.length, 1);
    assert.match(captured(), /dibk\/rs-v4 · File not found in Altinn Studio · App\/x\.json/);
});

test("keeps events from concurrent runs in their own reports", async () => {
    const runA = withRunLog("Run A", async () => {
        log.warn({ scope: "app-a", category: "Only in A" });
        await new Promise((resolve) => setImmediate(resolve));
        log.error({ scope: "app-a", category: "Also only in A" });
    });
    const runB = withRunLog("Run B", async () => {
        log.warn({ scope: "app-b", category: "Only in B" });
    });

    await Promise.all([runA, runB]);

    const reportA = output.find((entry) => entry.includes("Run A"));
    const reportB = output.find((entry) => entry.includes("Run B"));

    // Each run reports only its own events, even though B started and finished while A was awaiting.
    assert.match(reportA, /⚠️ Only in A/);
    assert.match(reportA, /⛔️ Also only in A/);
    assert.ok(!reportA.includes("app-b"));
    assert.match(reportB, /Only in B/);
    assert.ok(!reportB.includes("app-a"));
});
