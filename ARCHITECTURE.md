# Architecture

How `altinn-studio-custom-components-api` is structured and where its data comes from, for developers who maintain or extend it. What it is and how to run it is in the [README](./README.md), and how to contribute is in [CONTRIBUTING](./CONTRIBUTING.md).

## 1. Where it fits

```text
  altinn-studio-custom-components (dev server)
        statistics.html  ──HTTP──▶  this API (localhost:9001)
                                        │
                  ┌─────────────┬───────┴────────┬──────────────────────┐
                  ▼             ▼                ▼                      ▼
          Altinn Studio   npm registry     FtPB testmotor        local files
          (Gitea repos)   / GitHub / NuGet (example data)        (one main form)

  Shared with altinn-studio-api-tools:
     @arkitektum/ftpb-testmotor-client   reaching the testmotor
     @arkitektum/ftpb-app-catalogue      which apps exist and what their data types are
```

The Statistics dashboard is the only consumer.

## 2. Server

The routes (listed in the [README](./README.md#endpoints)) are registered in `api/app.mjs`, which builds the app and holds the caches. `api/index.mjs` starts it listening. Each JSON route is registered through `jsonEndpoint`, which catches a failure, logs it and answers a 500 with an `error` message.

The server listens on `API_PORT` (default `3000`, the Statistics dashboard expects `9001`), bound to `API_HOST` (default `127.0.0.1`). CORS allows a single origin, `CLIENT_ORIGIN` (default `http://localhost:9000`). A request whose `Host` header is not `localhost`, a `.localhost` name, an IP address or a name in `ALLOWED_HOSTS` is refused with a 403 before any route runs (`api/utils/hostCheck.mjs`), which keeps a web page from reaching the API through DNS rebinding.

### Caching

Every data getter except `/api/altinnStudioForms` and `/api/diagnostics` is wrapped in an in-memory TTL cache (`api/utils/cache.mjs`), so repeated "Synchronize" runs within a session do not fan out to Altinn Studio, npm and the testmotor again. The TTL is `CACHE_TTL_MS` (default `60000`, `0` disables caching). Concurrent identical requests share one in-flight fetch, and failures are not cached.

An answer that is only partial because a fetch failed for a reason that may pass (a network error, a timeout, a 5xx or a 429) is not cached either. Such a fetch calls `noteTransientFailure()`, which reaches the cached call it runs inside. An answer whose only failures are permanent (a 404, an example that does not validate) is cached as usual. A reused answer is noted on the request's log report (see [Logging](#5-logging)).

### Package files

`/api/packageFiles/<version>/<file>` serves `main.js`, `main.css`, `resource.nb.json` and the hashed `.woff2` fonts older versions keep beside their styles, for a full version number such as `17.2.0`. Anything else is a 404 before npm is asked. The version's tarball is read from the npm registry once (`api/utils/packageFiles.mjs`): its metadata must name a tarball on `registry.npmjs.org` with a sha512 integrity, the download is bounded, and it is refused unless it matches that integrity. The files of the last five versions asked for are kept with no expiry and answered as `immutable`. A version npm does not have is a 404, and npm being unreachable is a 502.

## 3. Source layout

```text
api/
├── app.mjs                          # Builds the Express app: caches, Host check, CORS, routes
├── index.mjs                        # Reads API_PORT / API_HOST and starts the app listening
├── endpoints.test.mjs               # Boots the app on a free port and exercises the routes
├── smoke.test.mjs                   # Boots the server and checks it accepts connections
├── scripts/
│   ├── catalogueDrift.mjs           # `yarn drift`: where the catalogue and the testmotor disagree
│   ├── functions.mjs                # All data fetching/parsing (Gitea, npm, GitHub, NuGet, testmotor, local files)
│   └── *.test.mjs
├── utils/
│   ├── altinnAppFrontendVersions.mjs# Extracts frontend asset versions from Index.cshtml
│   ├── boundedBody.mjs              # Reads an upstream body, refusing anything over 20 MB
│   ├── cache.mjs                    # In-memory TTL cache used by the expensive endpoints
│   ├── concurrencyLimiter.mjs       # Caps simultaneous Altinn Studio requests
│   ├── exampleFiles.mjs             # Reads the example XML kept on disk
│   ├── hostCheck.mjs                # Refuses a request by a host name that is not ours (DNS rebinding)
│   ├── logger.mjs                   # Run-scoped logging: one aggregated report per request
│   ├── nugetPackageVersion.mjs      # Reads a package version from a .csproj and picks the latest stable NuGet version
│   ├── packageFiles.mjs             # Files of a published version of the components package, from npm
│   ├── settings.mjs                 # CACHE_TTL_MS and REQUEST_TIMEOUT_MS, parsed in one place
│   ├── stripJsonComments.mjs        # Strips comments so commented JSON still parses
│   ├── testmotorClient.mjs          # Thin wrapper over @arkitektum/ftpb-testmotor-client
│   ├── xmlToJsonConverter.mjs       # Converts example form XML into JSON
│   ├── xsdValueTypes.mjs            # Which elements an XSD types as numbers or booleans, the rest stay text
│   └── *.test.mjs
└── data/
    ├── altinnStudioApps.mjs         # @arkitektum/ftpb-app-catalogue, spelled appOwner / appName
    ├── packageSources.mjs           # Which packages to look up latest versions for (npm / GitHub / NuGet)
    └── exampleData/                 # Example XML the testmotor does not serve (one form, under forms/)
```

## 4. External data sources

### Altinn Studio (Gitea)

`fetchGiteaFileContent` reads raw files from `https://altinn.studio/repos/{owner}/{repo}/raw/branch/{branch}/{path}` with `GITEA_TOKEN` sent as `Authorization: Bearer …`. The branch is `GITEA_BRANCH` (default `master`). Layouts, app resources, application metadata, `package-lock.json`, `App.csproj`, `Index.cshtml` and subform schemas are read this way. A missing token fails fast with a clear message rather than letting Altinn Studio's HTML login page surface later as an XML parse error.

Requests go through one shared concurrency gate (`api/utils/concurrencyLimiter.mjs`), because each endpoint fans out over every tracked app and the dashboard calls several endpoints at once. The limit is `ALTINN_STUDIO_CONCURRENCY` (default `16`): raise it for a faster cold sync, lower it if Altinn Studio starts refusing connections.

Every outbound request (Altinn Studio, npm, GitHub, NuGet and the testmotor) is abandoned after `REQUEST_TIMEOUT_MS` (default `30000`), body included. For Altinn Studio the clock starts when the request gets its slot in the gate.

### npm registry, GitHub releases and NuGet

`getLatestPackageVersions` resolves the latest version for each entry in `api/data/packageSources.mjs`: from `registry.npmjs.org` for `npm` sources, from the GitHub releases API for `github` sources, and from the named feed's package base address for `nuget` sources (DIBK's own feed for `Dibk.Ftpb.Common.AltinnApps`).

### FtPB testmotor

`api/utils/testmotorClient.mjs` reads the main form and subform example data from `TESTMOTOR_URL` (default `https://app-ftpb-testmotor.azurewebsites.net`). No token is sent, and every endpoint it reads is open.

| Endpoint                                 | Answers                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/altinn-app`                    | The apps it holds data for, and each one's main form data type.                                                           |
| `GET /api/xml/{appId}`                   | That app's example files, contents and all.                                                                               |
| `GET /api/attachment/{appId}`            | That app's attachment types, each with the names of its predefined files. Subforms are among them, under their data type. |
| `GET /api/attachment/{appId}/{dataType}` | One predefined file, named by a `fileName` request header, answered as the XML itself.                                    |

The testmotor serves the copy the DiBK test team maintains on an Azure file share, and re-stamps the date fields on every request with a date ten days out, so examples with date rules (such as a ferdigattest's `bekreftelseInnen` and `utfoertInnen`) stay valid.

It is keyed by app id: `fa-v3` and `fa-v5` are both filed under the data type `FA` and hold different files, so `/api/exampleData` names the app on each entry. Subforms are keyed by app id too, since the same subform can hold different files under different apps (`DispensasjonssoeknadDataV1` under `disp-v1` and `fts-v1`). Each app gets an entry per subform it declares, read through that app and validated against the schema in that app's repository.

Answers are reused for `CACHE_TTL_MS` and requests are abandoned after `REQUEST_TIMEOUT_MS`, as for every other upstream. File names arrive as bare stems (`01_Maksimumsversjon.xml` on the share becomes `Maksimumsversjon`) in the order the testmotor answers them. If the testmotor cannot be reached, the affected entries carry the reason in `error`, so the dashboard can tell "no examples" from "could not fetch the examples".

The catalogue in `@arkitektum/ftpb-app-catalogue` and the testmotor's own list of the same apps are maintained separately, so they can drift. `yarn drift` (`api/scripts/catalogueDrift.mjs`) compares them and reports apps the testmotor holds that the catalogue does not name, apps with no example data from either source, apps the two file under different data types (the case that breaks something, since the catalogue's data type decides where the dashboard looks), declared subforms with no example files under an app declaring them, and any subform it could not check.

### Local files

The one main form the testmotor has no data for, `hoeringettersynuttalelse-v2`, is read from `EXAMPLE_DATA_DIR` (default `api/data/exampleData`), laid out as `forms/{dataType}/*.xml`. Because a folder is named after the data type, it is only read when exactly one tracked app claims that data type.

## 5. Logging

Each fan-out endpoint runs inside a logging run (`withRunLog` in `api/utils/logger.mjs`). The fetch/parse helpers record events (`log.ok` / `log.warn` / `log.error`), and the run prints one report when the request finishes:

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

Successes are counted only. A file whose absence is expected (not every app ships a nynorsk resource file) is fetched with `{ optional: true }` and does not warn. Warnings and errors keep their full text, grouped by cause, with the sources that failed the same way listed together. Sources with nothing to flag are folded into one row, and a run with no warnings or errors collapses to one line. A run that did no work prints one line saying why: `served from cache (fresh for another 43s)` or `joined a request already in flight`.

Each report is written with one call, so reports from concurrent requests never interleave, and it is printed even if the run throws. The active run is tracked with `AsyncLocalStorage`, so the nested helpers need no context argument. Events recorded outside a run (startup checks) go to plain `console` output. Set `LOG_VERBOSE=1` to also print every event as it happens. Colours are used on a terminal unless `NO_COLOR` is set.

### Diagnostics over HTTP

Each run's summary is also kept in memory and served by `/api/diagnostics`, the same structure the console report is rendered from. The Statistics dashboard does not call it, so read it directly when you need it.

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

Runs are worst-first, one entry per endpoint. A request answered from the cache keeps the summary of the run that did the work and only updates `requestedAt` and `requestNotes`.

## 6. Tooling

- Node.js 24 or later, with native ES modules (`.mjs`).
- Express 5 and `cors`.
- Yarn 4 via Corepack (pinned through `packageManager`).
- XML parsing via `fast-xml-parser`, XSD validation via `libxmljs2`.
- ESLint (flat config) and Prettier.
- `node --test` (the built-in Node test runner) for tests.

Tests live next to the code they cover as `*.test.mjs`. `functions.test.mjs` stubs global `fetch`, for both Altinn Studio and the testmotor, and points `EXAMPLE_DATA_DIR` at a temporary directory, so the example-data assembly runs end to end without either upstream. `smoke.test.mjs` boots the server in a child process to check it starts and accepts connections.

Two GitHub Actions workflows cover `main`: `ci.yml` runs `yarn lint`, `yarn format:check` and `yarn test` on every push and pull request, and `eslint.yml` uploads ESLint results to the repository's security tab on the same events plus a weekly schedule.

`libxmljs2` is a native module, so a `node_modules` tree copied between platforms fails to load it. It is loaded on first use (see `api/utils/xmlToJsonConverter.mjs`), so such a tree still starts the server, and only the example data conversion and its tests fail.
