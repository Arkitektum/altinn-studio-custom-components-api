// Dependencies
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Run-scoped logging for the fan-out endpoints.
 *
 * Every endpoint in this API fans out to Altinn Studio / npm / disk once per tracked app, and each step used to log a
 * line of its own. A single "Synchronize" therefore produced hundreds of interleaved lines in which the few real
 * problems were impossible to spot.
 *
 * Instead, callers *record* events (`log.ok` / `log.warn` / `log.error`) into the run that is currently active, and the
 * run prints a single report when it finishes: a per-app summary table, followed by the full text of the warnings and
 * errors grouped by cause. The report is assembled into one string and written with one call, so reports from
 * concurrent requests never interleave.
 *
 * The active run is tracked with AsyncLocalStorage so the deeply nested fetch/parse helpers don't need a context
 * argument threaded through them. Events recorded outside any run (module init, startup checks) fall back to plain
 * console output, so nothing is ever silently swallowed.
 *
 * Set `LOG_VERBOSE=1` to also print every event as it happens — the old line-per-step behaviour, useful when following
 * a single failing app.
 */

const runStorage = new AsyncLocalStorage();

const verbose = /^(1|true|yes|on)$/i.test(process.env.LOG_VERBOSE ?? "");

// Cap each detail group so a systematic failure (every app missing the same file) can't flood the report. Identical
// messages are deduplicated first, so reaching the cap means genuinely distinct entries.
const maxDetailsPerGroup = 30;
const maxScopeWidth = 44;
// How many individual sources the summary table lists before folding the rest into a single row.
const maxTableRows = 12;

const levelMarkers = { ok: "✅", warn: "⚠️", error: "⛔️" };
const levelLabels = { ok: "OK", warn: "Warn", error: "Error" };

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code) => (text) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : String(text));
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const levelColors = { ok: green, warn: yellow, error: red };

/**
 * Records an event outside any active run. Keeps the pre-aggregation behaviour for one-off logging that has no report
 * to be summarised into.
 *
 * @param {"ok"|"warn"|"error"} level
 * @param {{scope?: string, category?: string, message?: string, detail?: string}} event
 */
function logWithoutRun(level, { scope, category, message, detail }) {
    if (level === "ok" && !verbose) {
        return;
    }
    const subject = [scope, category, message].filter(Boolean).join(" · ");
    const text = [levelMarkers[level], subject, detail && `— ${String(detail).replace(/\n+/g, " ")}`].filter(Boolean).join(" ");
    if (level === "error") {
        console.error(text);
    } else if (level === "warn") {
        console.warn(text);
    } else {
        console.log(text);
    }
}

/**
 * Adds an event to the active run, or logs it directly when no run is active.
 *
 * @param {"ok"|"warn"|"error"} level - Severity. `ok` events are counted only; warnings and errors are also detailed.
 * @param {Object} event
 * @param {string} [event.scope] - What the event is about — normally `appOwner/appName`. Becomes a row in the table.
 * @param {string} [event.category] - Short, reusable cause ("Missing file", "XSD validation failed"). Groups details.
 * @param {string} [event.message] - The specific subject, e.g. the file or data type involved.
 * @param {string} [event.detail] - Longer explanation (an error message, validation output) shown under the message.
 */
function record(level, event) {
    const run = runStorage.getStore();
    if (!run) {
        logWithoutRun(level, event);
        return;
    }

    const scope = event.scope || "—";
    const counts = run.counts.get(scope) ?? { ok: 0, warn: 0, error: 0 };
    counts[level] += 1;
    run.counts.set(scope, counts);

    if (verbose) {
        logWithoutRun(level, event);
    }

    if (level === "ok") {
        return;
    }

    // Group by cause, then deduplicate within the group: the same missing file reported for the same app twice is one
    // entry with a count, not two lines.
    const groupKey = `${level}::${event.category ?? "Other"}`;
    const group = run.groups.get(groupKey) ?? { level, category: event.category ?? "Other", entries: new Map() };
    const entryKey = `${scope}::${event.message ?? ""}::${event.detail ?? ""}`;
    const entry = group.entries.get(entryKey) ?? { scope, message: event.message, detail: event.detail, count: 0 };
    entry.count += 1;
    group.entries.set(entryKey, entry);
    run.groups.set(groupKey, group);
}

export const log = {
    /** Records a successful step. Counted in the summary table, never detailed. */
    ok: (event) => record("ok", event),
    /** Records an expected-but-notable outcome, such as an optional file that is missing. */
    warn: (event) => record("warn", event),
    /** Records a failure that made the API skip data. */
    error: (event) => record("error", event),
    /**
     * Prints a progress line in verbose mode only. Use for the per-item "now working on X" chatter that is
     * uninteresting once the run has a summary.
     *
     * @param {string} message
     */
    progress: (message) => {
        if (verbose) {
            console.log(dim(message));
        }
    },
    /**
     * Annotates the active run's headline with a fact about the run itself rather than an event within it — why it
     * did no work, for instance. A no-op outside a run, since there is no headline to annotate.
     *
     * @param {string} note
     */
    note: (note) => {
        runStorage.getStore()?.notes.add(note);
    }
};

/**
 * Truncates a string from the left, keeping the tail — app names differ in their suffix (`rs-v4` vs `rs-v3`), so the
 * end is the informative part.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function truncate(text, width) {
    return text.length <= width ? text : `…${text.slice(text.length - width + 1)}`;
}

/**
 * Formats a duration in milliseconds as a short human-readable string.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Wraps a comma-separated list of names to the terminal width.
 *
 * @param {string[]} names
 * @param {string} indent - Prefix for every produced line.
 * @returns {string[]} The wrapped lines, already indented.
 */
function wrapList(names, indent) {
    const width = Math.max(40, (process.stdout.columns || 120) - indent.length);
    const lines = [];
    let current = "";
    for (const [index, name] of names.entries()) {
        const piece = index === names.length - 1 ? name : `${name}, `;
        if (current && current.length + piece.length > width) {
            lines.push(indent + current);
            current = "";
        }
        current += piece;
    }
    if (current) {
        lines.push(indent + current);
    }
    return lines;
}

/**
 * Renders the per-scope summary table: one column per severity, plus a totals row.
 *
 * Sources that had nothing but successes are collapsed into a single row. With 26 tracked apps, listing the clean ones
 * pushes the rows that need attention off the screen — which is the problem the report exists to solve. `LOG_VERBOSE=1`
 * lists every source.
 *
 * @param {Map<string, {ok: number, warn: number, error: number}>} counts
 * @returns {string[]} The rendered lines.
 */
function renderTable(counts) {
    const allRows = [...counts.entries()].map(([scope, tally]) => ({ scope: truncate(scope, maxScopeWidth), ...tally }));
    // Worst first: the rows that need attention should sit next to the detail sections below the table.
    allRows.sort((a, b) => b.error - a.error || b.warn - a.warn || a.scope.localeCompare(b.scope));

    const totals = allRows.reduce((sum, row) => ({ ok: sum.ok + row.ok, warn: sum.warn + row.warn, error: sum.error + row.error }), {
        ok: 0,
        warn: 0,
        error: 0
    });

    // Show the sources that need attention, then fold everything else into one row: the detail sections below name
    // every affected source anyway, so a full listing here only buries the worst offenders.
    const shown = verbose ? allRows : allRows.filter((row) => row.warn || row.error).slice(0, maxTableRows);
    const folded = allRows.slice(shown.length);
    const rows = [...shown];
    if (folded.length) {
        const tally = folded.reduce((sum, row) => ({ ok: sum.ok + row.ok, warn: sum.warn + row.warn, error: sum.error + row.error }), { ok: 0, warn: 0, error: 0 });
        const allClear = !tally.warn && !tally.error;
        rows.push({
            scope: `${folded.length} other source${folded.length === 1 ? "" : "s"}${allClear ? " · all clear" : ""}`,
            ...tally,
            collapsed: true
        });
    }

    const scopeWidth = Math.max(6, ...rows.map((row) => row.scope.length), "Total".length);
    const columns = ["ok", "warn", "error"];
    const columnWidths = columns.map((column) => Math.max(levelLabels[column].length, String(totals[column]).length));

    // A zero reads as noise in a table of counts — show it as an empty marker so the numbers that matter stand out.
    const cell = (value, level, width) => (value ? levelColors[level](String(value)).padStart(width + (useColor ? 9 : 0)) : dim("·".padStart(width)));

    const line = (label, tally, colorLabel = (text) => text) =>
        ` ${colorLabel(label.padEnd(scopeWidth))}  ${columns.map((column, index) => cell(tally[column], column, columnWidths[index])).join("  ")}`;

    const header = ` ${dim("Source".padEnd(scopeWidth))}  ${columns.map((column, index) => dim(levelLabels[column].padStart(columnWidths[index]))).join("  ")}`;
    const rule = dim(" " + "─".repeat(scopeWidth + columnWidths.reduce((sum, width) => sum + width + 2, 0)));

    return [header, ...rows.map((row) => line(row.scope, row, row.collapsed ? dim : undefined)), rule, line("Total", totals, bold)];
}

/**
 * Groups a category's entries by what actually happened (message + detail), so the same missing file across 26 apps
 * becomes one entry listing 26 sources rather than 26 near-identical lines.
 *
 * @param {Object[]} entries
 * @returns {Array<{message?: string, detail?: string, sources: Array<{source: string, count: number}>, total: number}>}
 */
function summariseEntries(entries) {
    const byOutcome = new Map();
    for (const entry of entries) {
        const key = `${entry.message ?? ""}::${entry.detail ?? ""}`;
        const outcome = byOutcome.get(key) ?? { message: entry.message, detail: entry.detail, sources: [], total: 0 };
        outcome.sources.push({ source: entry.scope, count: entry.count });
        outcome.total += entry.count;
        byOutcome.set(key, outcome);
    }
    return [...byOutcome.values()].sort((a, b) => b.total - a.total);
}

/**
 * Reduces a finished run to a plain, serialisable summary: the counts behind the table, and the grouped warnings and
 * errors behind the detail sections. Both the console report and `getDiagnostics` are built from this, so what the
 * terminal shows and what the API serves can't drift apart.
 *
 * @param {{name: string, startedAt: number, counts: Map, groups: Map, notes: Set<string>}} run
 * @returns {Object} The run summary.
 */
function summariseRun(run) {
    const totals = { ok: 0, warn: 0, error: 0 };
    const sources = [];
    for (const [source, tally] of run.counts) {
        totals.ok += tally.ok;
        totals.warn += tally.warn;
        totals.error += tally.error;
        sources.push({ source, ...tally });
    }

    const issues = [...run.groups.values()]
        .sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) || b.entries.size - a.entries.size || a.category.localeCompare(b.category))
        .map((group) => {
            const outcomes = summariseEntries([...group.entries.values()]);
            return {
                level: group.level,
                category: group.category,
                count: outcomes.reduce((sum, outcome) => sum + outcome.total, 0),
                outcomes
            };
        });

    return {
        name: run.name,
        durationMs: Date.now() - run.startedAt,
        notes: [...run.notes],
        totals,
        sources,
        issues
    };
}

/**
 * Renders the detail sections — the full text of every warning and error, grouped by cause and then by outcome.
 *
 * @param {Array<{level: string, category: string, count: number, outcomes: Object[]}>} issues - From summariseRun.
 * @returns {string[]} The rendered lines.
 */
function renderGroups(issues) {
    const lines = [];
    for (const group of issues) {
        lines.push("");
        lines.push(`${levelMarkers[group.level]} ${levelColors[group.level](bold(group.category))} ${dim(`(${group.count})`)}`);

        for (const outcome of group.outcomes.slice(0, maxDetailsPerGroup)) {
            // A source that hit the same outcome more than once carries its own count.
            const labels = outcome.sources.map(({ source, count }) => (count > 1 ? `${source} ×${count}` : source));
            if (labels.length === 1) {
                lines.push(`   ${bold(labels[0])}${outcome.message ? dim(" · ") + outcome.message : ""}`);
            } else {
                // Without a message there is nothing to head the list with — repeating the category would just echo
                // the group heading directly above.
                const count = `${labels.length} sources`;
                lines.push(outcome.message ? `   ${outcome.message} ${dim(`— ${count}`)}` : `   ${dim(count)}`);
                lines.push(...wrapList(labels, "     ").map(dim));
            }
            if (outcome.detail) {
                // Multi-line details (XSD validation output) keep their own line breaks, indented under the entry.
                for (const detailLine of String(outcome.detail).split("\n")) {
                    if (detailLine.trim()) {
                        lines.push(dim(`     ${detailLine.trim()}`));
                    }
                }
            }
        }

        const hidden = group.outcomes.length - maxDetailsPerGroup;
        if (hidden > 0) {
            lines.push(dim(`   … and ${hidden} more (LOG_VERBOSE=1 to see every event as it happens)`));
        }
    }
    return lines;
}

/**
 * Assembles and prints the report for a finished run, as a single write so concurrent runs never interleave.
 *
 * @param {Map<string, {ok: number, warn: number, error: number}>} counts - The run's per-source tallies.
 * @param {Object} summary - The run summary from summariseRun.
 */
function printReport(counts, summary) {
    const { name, totals, notes, issues } = summary;
    const duration = formatDuration(summary.durationMs);

    if (counts.size === 0) {
        // A run with no events either did no work (the cache answered) or had nothing to do; the notes say which.
        const why = notes.length ? notes.join(" · ") : "nothing to report";
        console.log(`${dim("▪")} ${bold(name)} ${dim(`· ${duration} · ${why}`)}`);
        return;
    }

    const headline = [
        `${bold(name)} ${dim(`· ${duration}`)}`,
        totals.error ? red(`${totals.error} error${totals.error === 1 ? "" : "s"}`) : null,
        totals.warn ? yellow(`${totals.warn} warning${totals.warn === 1 ? "" : "s"}`) : null,
        !totals.error && !totals.warn ? green("all clear") : null,
        ...notes.map(dim)
    ]
        .filter(Boolean)
        .join(dim(" · "));

    // A run with nothing to flag needs no table: the headline already says everything the table would.
    if (!totals.error && !totals.warn && !verbose) {
        const sources = `${counts.size} source${counts.size === 1 ? "" : "s"}`;
        console.log(`${green("✅")} ${headline} ${dim(`· ${totals.ok} OK across ${sources}`)}`);
        return;
    }

    const lines = ["", headline, "", ...renderTable(counts), ...renderGroups(issues), ""];
    console.log(lines.join("\n"));
}

// The most recent summary per run name, so the console report is not the only place the outcome exists — see
// getDiagnostics. Bounded by the number of endpoints, so it can't grow.
const retainedSummaries = new Map();

/**
 * Retains a finished run's summary for `getDiagnostics`.
 *
 * A run that recorded nothing did no work — the cache answered it — so it must not overwrite the summary of the run
 * that did. Its timestamp is still recorded, which is what distinguishes "checked a moment ago and all is well" from
 * "these numbers are from twenty minutes ago".
 *
 * @param {{name: string, startedAt: number, counts: Map, notes: Set<string>}} run
 * @param {Object} summary - The run summary from summariseRun.
 */
function retainSummary(run, summary) {
    const requestedAt = new Date(run.startedAt + summary.durationMs).toISOString();
    const previous = retainedSummaries.get(run.name);

    if (run.counts.size === 0 && previous) {
        retainedSummaries.set(run.name, { ...previous, requestedAt, requestNotes: summary.notes });
        return;
    }

    retainedSummaries.set(run.name, {
        ...summary,
        observedAt: new Date(run.startedAt).toISOString(),
        requestedAt,
        requestNotes: summary.notes
    });
}

/**
 * The most recent outcome of each run, for serving over HTTP.
 *
 * The console report is fine when you are watching the terminal, but the Statistics dashboard is the consumer that
 * actually cares whether an app failed to load. This exposes the same summary the report is rendered from, so the
 * dashboard can show the problems instead of the developer having to notice them scroll past.
 *
 * @returns {{generatedAt: string, totals: {ok: number, warn: number, error: number}, runs: Object[]}} The retained
 *   summaries, worst first, with totals across all of them.
 */
export function getDiagnostics() {
    const runs = [...retainedSummaries.values()].sort(
        (a, b) => b.totals.error - a.totals.error || b.totals.warn - a.totals.warn || a.name.localeCompare(b.name)
    );

    const totals = runs.reduce(
        (sum, run) => ({ ok: sum.ok + run.totals.ok, warn: sum.warn + run.totals.warn, error: sum.error + run.totals.error }),
        { ok: 0, warn: 0, error: 0 }
    );

    return { generatedAt: new Date().toISOString(), totals, runs };
}

/**
 * Runs `fn` as a named logging run: events recorded anywhere inside it are aggregated and reported together when it
 * settles. Reports are printed for failed runs too, so the events leading up to a thrown error are not lost.
 *
 * @template T
 * @param {string} name - Report headline, e.g. "Example data".
 * @param {() => Promise<T>} fn - The work to run.
 * @returns {Promise<T>} Whatever `fn` resolves to.
 */
export async function withRunLog(name, fn) {
    const run = { name, startedAt: Date.now(), counts: new Map(), groups: new Map(), notes: new Set() };
    try {
        return await runStorage.run(run, fn);
    } finally {
        const summary = summariseRun(run);
        retainSummary(run, summary);
        printReport(run.counts, summary);
    }
}
