import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { getDiagnostics, log, withRunLog } from "./logger.mjs";

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

test("lists the sources without a heading when events carry no message of their own", async () => {
    await withRunLog("Application metadata", async () => {
        log.error({ scope: "dibk/rs-v4", category: "Application metadata not fetched", detail: "connect ETIMEDOUT" });
        log.error({ scope: "dibk/ko-v2", category: "Application metadata not fetched", detail: "connect ETIMEDOUT" });
    });

    const report = captured();
    assert.match(report, /Application metadata not fetched \(2\)\n {3}2 sources\n {5}dibk\/rs-v4, dibk\/ko-v2/);
    // The category is the group heading; repeating it as the entry heading would say the same thing twice.
    assert.equal(report.match(/Application metadata not fetched/g).length, 1);
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

test("explains an eventless run with the note it was given", async () => {
    // What the cache does when it answers a request without doing any work.
    await withRunLog("Example data", async () => {
        log.note("served from cache (fresh for another 43s)");
        return "cached";
    });

    // The duration is whatever it took, so match its shape rather than a value.
    assert.match(captured(), /Example data · \d+ms · served from cache \(fresh for another 43s\)/);
    assert.ok(!captured().includes("nothing to report"));
});

test("keeps a note in the headline of a run that did record events", async () => {
    await withRunLog("Package versions", async () => {
        log.note("joined a request already in flight");
        log.warn({ scope: "dibk/ko-v2", category: "Package versions not resolved" });
    });

    assert.match(captured(), /Package versions .* 1 warning.*joined a request already in flight/);
});

test("ignores a note when no run is active", () => {
    log.note("served from cache");

    // There is no headline to annotate, and a bare note is not worth a line of its own.
    assert.equal(output.length, 0);
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

// Retained summaries are module state shared by every run in this file, so these tests use run names of their own and
// pick their entries out of the payload by name rather than asserting on the whole list.
const findRun = (name) => getDiagnostics().runs.find((run) => run.name === name);

test("serves the last outcome of a run as structured diagnostics", async () => {
    await withRunLog("diagnostics-versions", async () => {
        log.ok({ scope: "dibk/ig-v3", category: "Package versions", message: "16.7.2" });
        log.error({ scope: "dibk/ko-v2", category: "Package versions not resolved", detail: "App/package-lock.json not found in the repository" });
    });

    const run = findRun("diagnostics-versions");
    assert.deepEqual(run.totals, { ok: 1, warn: 0, error: 1 });
    assert.deepEqual(run.sources, [
        { source: "dibk/ig-v3", ok: 1, warn: 0, error: 0 },
        { source: "dibk/ko-v2", ok: 0, warn: 0, error: 1 }
    ]);
    assert.deepEqual(run.issues, [
        {
            level: "error",
            category: "Package versions not resolved",
            count: 1,
            outcomes: [
                {
                    message: undefined,
                    detail: "App/package-lock.json not found in the repository",
                    sources: [{ source: "dibk/ko-v2", count: 1 }],
                    total: 1
                }
            ]
        }
    ]);
    assert.match(run.observedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("keeps the last real outcome when a later request did no work", async () => {
    await withRunLog("diagnostics-cached", async () => {
        log.error({ scope: "dibk/ko-v2", category: "Package versions not resolved" });
    });
    const observed = findRun("diagnostics-cached");

    await withRunLog("diagnostics-cached", async () => {
        log.note("served from cache (fresh for another 43s)");
    });
    const afterCacheHit = findRun("diagnostics-cached");

    // A cache hit must not erase what the run that did the work found — otherwise a second Synchronize within the TTL
    // would report a clean bill of health.
    assert.deepEqual(afterCacheHit.totals, { ok: 0, warn: 0, error: 1 });
    assert.equal(afterCacheHit.observedAt, observed.observedAt);
    // It does record that the endpoint was asked again, and why nothing was re-fetched.
    assert.deepEqual(afterCacheHit.requestNotes, ["served from cache (fresh for another 43s)"]);
    assert.ok(afterCacheHit.requestedAt >= observed.requestedAt);
});

test("totals the retained runs and puts the worst first", async () => {
    await withRunLog("diagnostics-warned", async () => {
        log.warn({ scope: "dibk/sa-v2", category: "File not found in Altinn Studio", message: "App/config/applicationmetadata.json" });
    });
    await withRunLog("diagnostics-failed", async () => {
        log.error({ scope: "dibk/ko-v2", category: "Display layouts not fetched" });
    });

    const { totals, runs } = getDiagnostics();
    const names = runs.map((run) => run.name);
    assert.ok(names.indexOf("diagnostics-failed") < names.indexOf("diagnostics-warned"), "a run with errors sorts above one with only warnings");
    // Totals cover every retained run, including those from the tests above.
    assert.ok(totals.error >= 1 && totals.warn >= 1);
});
