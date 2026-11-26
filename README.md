# altinn-studio-custom-components-api

A small Express (Node.js) API that backs the Statistics dashboard in [`altinn-studio-custom-components`](https://github.com/Arkitektum/altinn-studio-custom-components). The dashboard calls it to analyze component usage and text-resource coverage across the DiBK Altinn apps.

This is a development-only tool. It is not published or deployed: you run it locally alongside the components dev server.

## Getting started

### Prerequisites

- **Node.js 24** or later
- **Yarn 4** via [Corepack](https://nodejs.org/api/corepack.html): run `corepack enable` once.

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

- `API_PORT`: the port to listen on (use `9001`, which the Statistics dashboard expects).
- `GITEA_TOKEN`: a token for reading files from Altinn Studio's Gitea.
- `TESTMOTOR_URL`: the FtPB testmotor, which serves the main form and subform example data. The default is the hosted instance. Override it to work against your own.
- `EXAMPLE_DATA_DIR`: where the one main form the testmotor holds no data for lives. Defaults to `api/data/exampleData`.

The rest (`API_HOST`, `ALLOWED_HOSTS`, `CLIENT_ORIGIN`, `GITEA_BRANCH`, `CACHE_TTL_MS`, `LOG_VERBOSE`, `ALTINN_STUDIO_CONCURRENCY`, `REQUEST_TIMEOUT_MS`) are explained in `.env.sample`.

Generate a Gitea token at <https://altinn.studio/repos/user/settings/applications> with the **`read:repository`** scope and an expiry date, then put it in `.env` (replacing `your_token_here`).

> `.env` is git-ignored. Never commit tokens or secrets.

#### Keeping the token out of the project folder

`.env` is read from the project folder by default. It can live anywhere else instead, for example `~/.env/altinn-studio-custom-components-api`, with `DOTENV_PATH` pointing at it when the API starts:

```bash
DOTENV_PATH="$HOME/.env/altinn-studio-custom-components-api" yarn start
```

Every entry point loads its settings through `dotenv/config`, which reads `DOTENV_PATH`. While it is set, only that file is read and a `.env` in the project is ignored. Set it per command or per project (an alias, or a tool such as direnv) rather than exporting it from your shell profile: every project that loads its settings with dotenv reads the same variable, and would load this file too.

### 3. Run

```bash
yarn start
```

The API serves on `http://localhost:<API_PORT>`. Start the components repo's dev server and open its **Statistics** page to use it.

## Endpoints

All routes are `GET` under `/api` and return JSON, except `/api/packageFiles`:

| Route                                | Purpose                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/displayLayouts`                | Layout JSON for the tracked apps (used to compute component usage).                                                                                                                             |
| `/api/packageVersions`               | The custom-components, app-frontend and Dibk.Ftpb.Common.AltinnApps versions each tracked app uses.                                                                                             |
| `/api/latestPackageVersions`         | Latest versions from npm, GitHub and DIBK's NuGet feed for the sources in `api/data/packageSources.mjs`.                                                                                        |
| `/api/appResources`                  | App-level text-resource values. `?language=nb` or `?language=nn` limits the answer to one language, otherwise both are returned.                                                                |
| `/api/altinnStudioForms`             | The list of tracked Altinn apps and forms.                                                                                                                                                      |
| `/api/exampleData`                   | Example form and subform data, converted from XML to JSON. One entry per tracked app and one per subform each app declares. An entry carries an `error` when its examples could not be fetched. |
| `/api/applicationMetadata`           | `applicationmetadata.json` for the tracked apps.                                                                                                                                                |
| `/api/subformDataModels`             | Every app's copy of each subform's data model (`App/models/<dataType>.xsd`), read into fields for comparing the copies. A copy carries an `error` when its schema could not be read or parsed.  |
| `/api/diagnostics`                   | What the endpoints above last ran into: counts per app plus the grouped warnings and errors. Reads retained state and fetches nothing.                                                          |
| `/api/packageFiles/<version>/<file>` | A file of a published version of the components package, for the upgrade preview on the Display layouts page. Answers the file itself (JavaScript, CSS, JSON or a font).                        |

Details on caching, `/api/packageFiles` and `/api/diagnostics` are in [ARCHITECTURE.md](./ARCHITECTURE.md).

The tracked apps come from `@arkitektum/ftpb-app-catalogue`, a package shared with `altinn-studio-api-tools`. Add an app there, not here: `api/data/altinnStudioApps.mjs` only renames its fields to `appOwner`/`appName`.

## Resources

- [Architecture overview](./ARCHITECTURE.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Custom components](https://github.com/Arkitektum/altinn-studio-custom-components), where the dashboard this API backs lives
- [Component documentation & gallery](https://arkitektum.github.io/altinn-studio-custom-components-docs/)
- [FtPB testmotor client](https://github.com/Arkitektum/ftpb-testmotor-client), shared with the API tools
- [FtPB app catalogue](https://github.com/Arkitektum/ftpb-app-catalogue), shared with the API tools. Add a tracked app there.

## Licence

[MIT](./LICENSE)
