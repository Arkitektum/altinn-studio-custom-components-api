# Contributing

Thanks for contributing to `altinn-studio-custom-components-api`!
This is the local API that backs the **Statistics** dashboard in [`altinn-studio-custom-components`](https://github.com/Arkitektum/altinn-studio-custom-components).

For an overview of what the API does and how it is structured, read [ARCHITECTURE.md](./ARCHITECTURE.md) first.

---

## Prerequisites

- **Node.js 24** (other packages in the ecosystem target 24; the native ESM features used here work on current LTS too).
- **Yarn 4**, managed via [Corepack](https://nodejs.org/api/corepack.html). Enable it once:

  ```bash
  corepack enable
  ```

  The correct Yarn version is then activated automatically from the `packageManager` field in `package.json`.

---

## Getting started

1. **Clone and install**

   ```bash
   git clone https://github.com/Arkitektum/altinn-studio-custom-components-api.git
   cd altinn-studio-custom-components-api
   yarn install
   ```

   Installing pulls in `@arkitektum/altinn-studio-custom-components`, which the API reads default text resources from at runtime.

2. **Create your `.env`**

   ```bash
   cp .env.sample .env
   ```

   - `API_PORT` — the port to listen on (use `9001`, which the Statistics dashboard expects).
   - `GITEA_TOKEN` — a token for reading files from Altinn Studio's Gitea.

   To generate a Gitea token:
   - Go to <https://altinn.studio/repos/user/settings/applications>
   - Create a token with the **`read:repository`** scope
   - Put it in `.env` as `GITEA_TOKEN` (replacing `your_token_here`)

   > ⚠️ `.env` is git-ignored. Never commit tokens or secrets.

3. **Start the API**

   ```bash
   yarn start
   ```

   It serves on `http://localhost:<API_PORT>`.
   Then start the components repo's dev server and open its **Statistics** page, which calls this API.

---

## Everyday commands

| Command | What it does |
| ------- | ------------ |
| `yarn start` | Run the Express API (`node api/index.mjs`). |
| `yarn test` | Run the tests with the built-in Node test runner (`node --test`). |
| `yarn lint` | Lint the source (ESLint flat config in `eslint.config.mjs`). |

---

## Working on the API

- **Routes** live in `api/index.mjs`.
  Keep each route thin — delegate the actual work to a function in `api/scripts/functions.mjs`.
- **Data fetching/parsing** belongs in `api/scripts/functions.mjs`.
  Wrap external calls in `try/catch` and return a `500` with a clear message, matching the existing routes.
- **Logging** goes through `api/utils/logger.mjs` — record `log.ok` / `log.warn` / `log.error` instead of calling
  `console.*`, so the events end up in the request's summary report (see
  [ARCHITECTURE § Logging](./ARCHITECTURE.md#6-logging)). Wrap a new fan-out route in `withRunLog("<name>", …)`.
  Run with `LOG_VERBOSE=1` to see every event as it happens while debugging.
- **Tracked apps** are configured in `api/data/altinnStudioApps.mjs` (and subforms in `api/data/subforms.mjs`).
  Add an app there to include it in the statistics.
- **Version sources** for `latestPackageVersions` are configured in `api/data/packageSources.mjs` (`npm` or `github`).
- **Example data** is bundled XML under `api/data/exampleData/{forms,subforms}` and converted to JSON by `api/utils/xmlToJsonConverter.mjs`.
  Use synthetic/example data only — never commit real or personal data.

---

## Coding conventions

- **Native ES modules** (`.mjs`) and `async/await`.
- **JSDoc** on exported functions.
- **Tests** as `*.test.mjs` next to the code they cover, using `node:test` and `node:assert/strict`.
  Prefer testing the leaf utilities directly; where a function reaches the network, stub global `fetch` rather than
  adding a mocking library.
- **Formatting & linting** via Prettier (`.prettierrc`) and ESLint (`eslint.config.mjs`).
- Keep secrets in `.env`; read them via `process.env`.

---

## Pull requests

1. Branch off `main`.
2. Keep changes focused, and make sure `yarn lint` and `yarn test` both pass — CI runs both on every pull request.
3. Verify the affected endpoints respond correctly and the Statistics dashboard still loads against your local API.
4. Open a PR against `main`.
