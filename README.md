# altinn-studio-custom-components-api

A small **Express (Node.js) API** that backs the **Statistics** dashboard in [`altinn-studio-custom-components`](https://github.com/Arkitektum/altinn-studio-custom-components).
The dashboard calls this API to analyze component usage and text-resource coverage across the DiBK Altinn apps.

> ℹ️ This is a **development-only tool**.
> It is not published or deployed — you run it locally alongside the components dev server.

---

## Getting started

### Prerequisites

- **Node.js** (current LTS; the ecosystem targets Node 24)
- **Yarn 4** via [Corepack](https://nodejs.org/api/corepack.html) — run `corepack enable` once.

### 1. Install

```bash
git clone https://github.com/Arkitektum/altinn-studio-custom-components-api.git
cd altinn-studio-custom-components-api
yarn install
```

### 2. Configure `.env`

```bash
cp .env.sample .env
```

- `API_PORT` — the port to listen on (use `9001`, which the Statistics dashboard expects).
- `GITEA_TOKEN` — a token for reading files from Altinn Studio's Gitea.

Generate a Gitea token at <https://altinn.studio/repos/user/settings/applications> with the **`read:repository`** scope, then put it in `.env` (replacing `your_token_here`).

> ⚠️ `.env` is git-ignored. Never commit tokens or secrets.

### 3. Run

```bash
yarn start
```

The API serves on `http://localhost:<API_PORT>`.
Start the components repo's dev server and open its **Statistics** page to use it.

---

## Endpoints

All routes are `GET` under `/api` and return JSON:

| Route | Purpose |
| ----- | ------- |
| `/api/displayLayouts` | Layout JSON for the tracked apps (used to compute component usage). |
| `/api/packageVersions` | The custom-components version each tracked app currently uses. |
| `/api/latestPackageVersions` | Latest versions from npm / GitHub for the configured sources. |
| `/api/appResources` | App-level text-resource values (accepts a `language` query param). |
| `/api/resources` | The package's default text resources. |
| `/api/altinnStudioForms` | The configured list of tracked Altinn apps / forms. |
| `/api/exampleData` | Example form + subform data, converted from XML to JSON. |
| `/api/applicationMetadata` | `applicationmetadata.json` for the tracked apps. |

Tracked apps are configured in `api/data/altinnStudioApps.mjs` (and subforms in `api/data/subforms.mjs`).

---

## Resources

- [Architecture overview](./ARCHITECTURE.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Custom components](https://github.com/Arkitektum/altinn-studio-custom-components)
- [Component documentation & gallery](https://arkitektum.github.io/altinn-studio-custom-components-docs/)
