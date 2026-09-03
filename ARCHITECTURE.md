# Architecture

This document explains what `altinn-studio-custom-components-api` does, how it is structured, and how it fits into the wider custom-components ecosystem.
It is aimed at developers who maintain or extend the API.

For how to run it and contribute, see [CONTRIBUTING](./CONTRIBUTING.md).

---

## 1. What this package is

A small **Express (Node.js) API** that backs the **Statistics** dashboard shipped in the [`altinn-studio-custom-components`](https://github.com/Arkitektum/altinn-studio-custom-components) repository (the `statistics.html` dev surface).
The dashboard calls this API to analyze component usage and text-resource coverage across the DiBK Altinn apps.

It is a **development-only tool**.
It is not published to npm and is not deployed — each developer runs it locally alongside the components dev server.

---

## 2. Where it fits

```text
  altinn-studio-custom-components (dev server)
        statistics.html  ──HTTP──▶  this API (localhost:9001)
                                        │
                          ┌─────────────┼───────────────────────────────┐
                          ▼             ▼                               ▼
                  Altinn Studio    npm registry / GitHub          local example data
                  (Gitea repos)    (latest versions)              (api/data/exampleData)
```

- The **Statistics** dashboard is the only consumer.
- This API reads live data from **Altinn Studio's Gitea** (raw files via `https://altinn.studio/repos/...`), looks up **latest package versions** from the npm registry and GitHub releases, and serves **bundled example form data** from disk.

---

## 3. Endpoints

All routes are `GET` under `/api` and return JSON (`api/index.mjs`):

| Route | Purpose |
| ----- | ------- |
| `/api/displayLayouts` | Layout JSON for the tracked apps (used to compute component usage). |
| `/api/packageVersions` | The custom-components version each tracked app currently uses. |
| `/api/latestPackageVersions` | Latest versions from npm / GitHub for the sources in `packageSources.mjs`. |
| `/api/appResources` | App-level text-resource values (accepts a `language` query param). |
| `/api/resources` | The package's default text resources. |
| `/api/altinnStudioForms` | The configured list of tracked Altinn apps / forms. |
| `/api/exampleData` | Example form + subform data, converted from XML to JSON. |
| `/api/applicationMetadata` | `applicationmetadata.json` for the tracked apps. |
| `/api/diagnostics` | What the data endpoints above last ran into — counts per app plus the grouped warnings and errors. Reads retained state only; it never fetches. |

The server listens on `API_PORT` (default `3000`; the Statistics dashboard expects `9001`).
CORS is restricted to a single origin (`CLIENT_ORIGIN`, default `http://localhost:9000`).

The expensive getters (everything except the static forms list and the already-cached default resources) are wrapped in a
short-lived in-memory TTL cache (`api/utils/cache.mjs`) so repeated "Synchronize" runs within a session don't re-fan-out to
Altinn Studio / npm / disk. Concurrent identical requests share one in-flight fetch, and failures are not cached. Reusing
a call is noted on the request's log report (see [§ Logging](#6-logging)), so a request that logged nothing says why. The TTL
defaults to 60s and is configurable via `CACHE_TTL_MS` (`0` disables caching).

---

## 4. Source layout

```text
api/
├── index.mjs                        # Express app: route definitions + server bootstrap
├── smoke.test.mjs                   # Boots the server and checks it accepts connections
├── scripts/
│   ├── functions.mjs                # All data fetching/parsing (Gitea, npm, GitHub, local files)
│   └── functions.test.mjs
├── utils/
│   ├── altinnAppFrontendVersions.mjs# Extracts frontend asset versions from Index.cshtml
│   ├── cache.mjs                    # In-memory TTL cache used by the expensive endpoints
│   ├── concurrencyLimiter.mjs       # Caps simultaneous Altinn Studio requests
│   ├── logger.mjs                   # Run-scoped logging: one aggregated report per request
│   ├── stripJsonComments.mjs        # Strips comments so commented JSON still parses
│   ├── xmlToJsonConverter.mjs       # Converts example form XML into JSON
│   └── *.test.mjs
└── data/
    ├── altinnStudioApps.mjs         # The tracked apps (appOwner / appName / dataType / subForms)
    ├── subforms.mjs                 # Subform definitions + their layouts
    ├── subforms/                    # One module per subform, re-exported by subforms.mjs
    ├── packageSources.mjs           # Which packages to look up latest versions for (npm / GitHub)
    └── exampleData/                 # Bundled example XML (forms/ and subforms/)
```

---

## 5. External data sources

- **Altinn Studio (Gitea).**
  `fetchGiteaFileContent` reads raw files from `https://altinn.studio/repos/{owner}/{repo}/raw/branch/{branch}/{path}` using a **`GITEA_TOKEN`** (sent as `Authorization: Bearer …`).
  The branch defaults to `master` and is configurable via **`GITEA_BRANCH`**, for apps that use `main`.
  This is how layouts, app resources, and application metadata are retrieved.
  A missing token fails fast with a clear message, because Altinn Studio otherwise answers with an HTML login page that surfaces later as a confusing XML parse error.
  Requests go through a shared concurrency gate (`api/utils/concurrencyLimiter.mjs`), because each endpoint fans out over
  every tracked app and the dashboard calls several endpoints at once — uncapped, one sync peaks at ~160 simultaneous
  connections. The limit is **`ALTINN_STUDIO_CONCURRENCY`** (default `16`): raise it for a faster cold sync, lower it if
  Altinn Studio starts refusing connections. The gate is around the request helper rather than each fan-out, so the
  budget is shared however many endpoints are in flight.
- **npm registry & GitHub releases.**
  `getLatestPackageVersions` resolves the latest version for each entry in `packageSources.mjs` — from `registry.npmjs.org` for `npm` sources and from the GitHub releases API for `github` sources.
- **Local files.**
  Default text resources are read from the installed package at `node_modules/@arkitektum/altinn-studio-custom-components/dist/resources.json`, and example data is read from `api/data/exampleData`.

---

## 6. Logging

Each fan-out endpoint runs inside a **logging run** (`api/utils/logger.mjs`). Instead of logging a line per step —
which made a single "Synchronize" produce hundreds of interleaved lines — the fetch/parse helpers *record* events
(`log.ok` / `log.warn` / `log.error`), and the run prints one report when the request finishes:

```text
Example data · 4.2s · 1 error

 Source                        OK  Warn  Error
 dibk/disp-v1                   3     ·      1
 18 other sources · all clear  69     ·      ·
 ─────────────────────────────────────────────
 Total                         72     ·      1

⛔️ Example file skipped (1)
   dibk/disp-v1 · DS (02_Maksimumsversjon.xml)
     XML does not conform to XSD:
     Element 'Dispensasjon': No matching global declaration available for the validation root.
```

Successes are counted only. A file whose absence is expected — not every app ships a nynorsk resource file — or which
the caller already reports with better context is fetched with `{ optional: true }` and does not warn, so the warning
list stays worth reading. Warnings and errors keep their full text, grouped by cause, and within a cause the
sources that failed the same way are listed together instead of one line each. Sources with nothing to flag are
folded into a single table row, and a run with no warnings or errors at all collapses to one line. A run that did no
work of its own prints one line saying why — `served from cache (fresh for another 43s)` when the TTL cache answered,
or `joined a request already in flight` when it shared a concurrent call.

The report is assembled into a single string and written with one call, so reports from concurrent requests never
interleave, and it is printed even if the run throws.

The active run is tracked with `AsyncLocalStorage`, so the nested helpers need no context argument. Events recorded
outside a run (startup checks, `/api/resources`) fall back to plain `console` output. Set **`LOG_VERBOSE=1`** to also
print every event as it happens — the old line-per-step behaviour, useful when following one failing app.

Because of this, code in `api/scripts/functions.mjs` should record events rather than call `console.*` directly, and
leaf utilities such as `xmlToJsonConverter.mjs` stay silent and report through the error they throw — the caller knows
which app and file the failure belongs to.

### Diagnostics over HTTP

The console report is only useful while you are watching the terminal, so each run's summary is also retained in
memory and served by **`/api/diagnostics`** — the same structure the report is rendered from, so the two cannot drift:

```jsonc
{
  "generatedAt": "2026-09-03T10:37:13.288Z",
  "totals": { "ok": 71, "warn": 2, "error": 1 },   // across every retained run
  "runs": [{
    "name": "Package versions",
    "observedAt": "…",        // when these numbers were produced
    "requestedAt": "…",       // when the endpoint was last asked, cache hit or not
    "requestNotes": ["served from cache (fresh for another 43s)"],
    "durationMs": 4210,
    "totals": { "ok": 25, "warn": 0, "error": 1 },
    "sources": [{ "source": "dibk/ko-v2", "ok": 0, "warn": 0, "error": 1 }],
    "issues": [{ "level": "error", "category": "Package versions not resolved", "count": 1, "outcomes": [ … ] }]
  }]
}
```

Runs are worst-first, one entry per endpoint, so the map is bounded. A request that did no work does **not** overwrite
the summary of the run that did — otherwise a second "Synchronize" within the cache TTL would report a clean bill of
health — it only updates `requestedAt` and `requestNotes`.

Nothing consumes this yet: the Statistics dashboard in the components repo would need to call it to show the problems
it reports.

---

## 7. Tooling

- **Node.js** with native ES modules (`.mjs`).
- **Express 5** + **cors**.
- **Yarn 4** via Corepack (pinned through `packageManager`).
- XML parsing via **fast-xml-parser** and **libxmljs2**.
- **ESLint** (flat config) for linting.
- **`node --test`** (the built-in Node test runner) for tests — no test framework is installed.

Tests live next to the code they cover as `*.test.mjs`. Most target the leaf utilities, which are pure and need no
network; `functions.test.mjs` stubs global `fetch` to exercise the fan-out logic, and `smoke.test.mjs` boots the
server in a child process to check it starts and accepts connections.

Two GitHub Actions workflows cover `main`: `ci.yml` runs `yarn lint` and `yarn test` on every push and pull request,
and `eslint.yml` uploads ESLint results to the repository's security tab on the same events plus a weekly schedule.

Note that `libxmljs2` is a native module, so its binding is built for the platform that installed it. A `node_modules`
tree copied between platforms fails to load it, which takes down anything importing `functions.mjs`.
