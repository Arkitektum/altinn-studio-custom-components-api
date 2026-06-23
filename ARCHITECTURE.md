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
CORS is enabled for all origins.

---

## 4. Source layout

```text
api/
├── index.mjs                 # Express app: route definitions + server bootstrap
├── scripts/
│   └── functions.mjs         # All data fetching/parsing (Gitea, npm, GitHub, local files)
├── utils/
│   └── xmlToJsonConverter.mjs# Converts example form XML into JSON
└── data/
    ├── altinnStudioApps.mjs  # The tracked apps (appOwner / appName / dataType / subForms)
    ├── subforms.mjs          # Subform definitions + their layouts
    ├── packageSources.mjs    # Which packages to look up latest versions for (npm / GitHub)
    └── exampleData/          # Bundled example XML (forms/ and subforms/)
```

---

## 5. External data sources

- **Altinn Studio (Gitea).**
  `fetchGiteaFileContent` reads raw files from `https://altinn.studio/repos/{owner}/{repo}/raw/branch/master/{path}` using a **`GITEA_TOKEN`** (sent as `Authorization: Bearer …`).
  This is how layouts, app resources, and application metadata are retrieved.
- **npm registry & GitHub releases.**
  `getLatestPackageVersions` resolves the latest version for each entry in `packageSources.mjs` — from `registry.npmjs.org` for `npm` sources and from the GitHub releases API for `github` sources.
- **Local files.**
  Default text resources are read from the installed package at `node_modules/@arkitektum/altinn-studio-custom-components/dist/resources.json`, and example data is read from `api/data/exampleData`.

---

## 6. Tooling

- **Node.js** with native ES modules (`.mjs`).
- **Express 5** + **cors**.
- **Yarn 4** via Corepack (pinned through `packageManager`).
- XML parsing via **fast-xml-parser**, **libxmljs2**, and **jsdom**.
- **ESLint** (flat config) for linting.

There are no automated tests or CI workflows in this repository; it is a local developer tool.
