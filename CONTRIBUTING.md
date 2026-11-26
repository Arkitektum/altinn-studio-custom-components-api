# Contributing

Thanks for contributing to `altinn-studio-custom-components-api`, the local API that backs the Statistics dashboard in [`altinn-studio-custom-components`](https://github.com/Arkitektum/altinn-studio-custom-components). For how the API is structured, read [ARCHITECTURE.md](./ARCHITECTURE.md) first.

## Getting started

Install, configure `.env` and start the API as described in the [README](./README.md#getting-started). Then start the components repo's dev server and open its Statistics page, which calls this API.

Two dependencies are Arkitektum packages shared with `altinn-studio-api-tools`: `@arkitektum/ftpb-testmotor-client`, which fetches the main form and subform examples, and `@arkitektum/ftpb-app-catalogue`, the list of tracked apps. Change either in its own repository and publish, then bump the dependency here.

## Everyday commands

| Command             | What it does                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `yarn start`        | Run the Express API (`node api/index.mjs`).                                                   |
| `yarn test`         | Run the tests with the built-in Node test runner (`node --test`).                             |
| `yarn lint`         | Lint the source (ESLint flat config in `eslint.config.mjs`).                                  |
| `yarn format`       | Format every file with Prettier.                                                              |
| `yarn format:check` | Check the formatting without changing anything, as CI does.                                   |
| `yarn drift`        | Where the app catalogue and the testmotor have drifted apart. Needs the network, not a token. |

## Working on the API

- **Routes** live in `api/app.mjs`. Register a JSON route with `jsonEndpoint`, which catches failures and answers a 500 with a clear message, and pass `runLog` for a route that fans out. Keep the route thin and put the work in a function in `api/scripts/functions.mjs`.
- **Logging** goes through `api/utils/logger.mjs`: record `log.ok` / `log.warn` / `log.error` instead of calling `console.*`, so the events end up in the request's summary report (see [ARCHITECTURE § Logging](./ARCHITECTURE.md#5-logging)). Leaf utilities such as `xmlToJsonConverter.mjs` stay silent and report through the error they throw, since the caller knows which app and file it belongs to. Run with `LOG_VERBOSE=1` to see every event as it happens.
- **Tracked apps** come from `@arkitektum/ftpb-app-catalogue`. Add one there and bump the dependency. Subform layouts are read from the repository of the app that carries each one.
- **Version sources** for `/api/latestPackageVersions` are configured in `api/data/packageSources.mjs` (`npm`, `github` or `nuget`).
- **Example data** for the main forms and the subforms is read from the FtPB testmotor at request time (see [ARCHITECTURE § External data sources](./ARCHITECTURE.md#4-external-data-sources)). To add or change an example, change it on the testmotor's Azure file share. The one main form the testmotor has no data for, `hoeringettersynuttalelse-v2`, is on disk under `api/data/exampleData/forms/<dataType>/`. A numeric prefix on a file name orders the files and is stripped from the label, so `01_Maksimumsversjon.xml` reads as `Maksimumsversjon`. Use synthetic example data only, and never commit real or personal data.
- **Which apps have example data** is answered by `yarn drift`. It is a report, not a gate: it exits 0 whatever drift it finds, and 1 only when it cannot reach the testmotor. The reply forms `nabovarsel-svar-v5`, `ts-v1` and `varselplanoppstartuttalelse-v3` have no example data from either source, because they reference the submission they reply to by instance.

## Coding conventions

- Native ES modules (`.mjs`) and `async/await`.
- JSDoc on exported functions.
- Tests as `*.test.mjs` next to the code they cover, using `node:test` and `node:assert/strict`. Prefer testing the leaf utilities directly, and where a function reaches the network, stub global `fetch` rather than adding a mocking library.
- Formatting and linting via Prettier (`.prettierrc`) and ESLint (`eslint.config.mjs`).
- Keep secrets in `.env` and read them via `process.env`.

## Pull requests

1. Branch off `main`.
2. Keep changes focused, and make sure `yarn lint`, `yarn format:check` and `yarn test` pass. CI runs all three on every pull request.
3. Verify the affected endpoints respond correctly and the Statistics dashboard still loads against your local API.
4. Open a PR against `main`.
