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

The server listens on `API_PORT` (default `3000`; the Statistics dashboard expects `9001`).
CORS is restricted to a single origin (`CLIENT_ORIGIN`, default `http://localhost:9000`).

The expensive getters (everything except the static forms list and the already-cached default resources) are wrapped in a
short-lived in-memory TTL cache (`api/utils/cache.mjs`) so repeated "Synchronize" runs within a session don't re-fan-out to
Altinn Studio / npm / disk. Concurrent identical requests share one in-flight fetch, and failures are not cached. The TTL
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
- **npm registry & GitHub releases.**
  `getLatestPackageVersions` resolves the latest version for each entry in `packageSources.mjs` — from `registry.npmjs.org` for `npm` sources and from the GitHub releases API for `github` sources.
- **Local files.**
  Default text resources are read from the installed package at `node_modules/@arkitektum/altinn-studio-custom-components/dist/resources.json`, and example data is read from `api/data/exampleData`.

---

## 6. Tooling

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
