# Security Policy

## Supported versions

This is a development-only tool (not published or deployed). Security fixes are made against the latest `main`. Please reproduce any issue on the latest `main` before reporting it.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Instead, report them privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab: <https://github.com/Arkitektum/altinn-studio-custom-components-api/security>
2. Click **Report a vulnerability** to open a private advisory.

Please include as much of the following as you can:

- A description of the vulnerability and its potential impact.
- The affected version / commit and how you ran the API.
- Step-by-step instructions to reproduce, including a minimal proof of concept if possible.
- Any suggested remediation.

### What to expect

- We will acknowledge your report and begin investigating.
- We will keep you informed of progress and let you know when a fix is released.
- Please give us a reasonable amount of time to address the issue before any public disclosure. We are happy to credit reporters who wish to be acknowledged.

## Scope and security model

This API runs locally during development of the custom components and their Statistics dashboard. These properties are relevant when assessing security:

- **Gitea token.** The API reads files from Altinn Studio's Gitea with a `GITEA_TOKEN` (a `read:repository` scoped token). It is read from a git-ignored `.env` file, or from the file `DOTENV_PATH` names outside the project (see the README), and sent only to `https://altinn.studio`. Never commit the token, and prefer a least-privilege (read-only) scope.
- **Not for public deployment.** The endpoints have no authentication. CORS allows only `CLIENT_ORIGIN` (the local dev client by default), which keeps other origins' browsers out but has no effect on requests made outside a browser. The API binds `127.0.0.1` unless `API_HOST` says otherwise. Do not expose it to the public internet.
- **DNS rebinding.** Binding loopback does not keep out a web page in your own browser, which can point its own domain at 127.0.0.1 after loading and then call the API as if same-origin. Such a request still names the page's domain in its `Host` header, so the API answers only to `localhost`, to IP addresses and to the names in `ALLOWED_HOSTS`, and refuses anything else with a 403 before any endpoint runs.
- **FtPB testmotor.** The example data is fetched from `TESTMOTOR_URL` over open endpoints with no token attached, and `GITEA_TOKEN` must never be sent there. The XML it answers is validated against a schema fetched from Altinn Studio, and is treated as remote input like any other.
- **npm registry.** `/api/packageFiles` downloads published versions of `@arkitektum/altinn-studio-custom-components` from `registry.npmjs.org`, bounded in size and refused unless they match the sha512 integrity npm publishes.
- **Untrusted input.** The API parses XML example data and remote files. Treat fetched and parsed content as untrusted and validate it before use.
- **No personal data.** Example data and logs must use synthetic data only, never real or personal data. This applies to the files in this repository and to anything added to the testmotor's share.

## Dependencies

The API depends on `express`, `cors`, `dotenv`, `fast-xml-parser`, `libxmljs2` and the Arkitektum packages `@arkitektum/ftpb-app-catalogue` and `@arkitektum/ftpb-testmotor-client`. If you find a vulnerability in a dependency, please report it to that project as well, and open an advisory here if this API is affected.
