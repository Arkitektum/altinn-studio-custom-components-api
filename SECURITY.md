# Security Policy

## Supported versions

This is a **development-only tool** (not published or deployed).
Security fixes are made against the **latest `main`**.
Please reproduce any issue on the latest `main` before reporting it.

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
- Please give us a reasonable amount of time to address the issue before any public disclosure.
  We are happy to credit reporters who wish to be acknowledged.

## Scope and security model

This API is intended to run **locally** during development of the custom components and their Statistics dashboard.
A few properties are relevant when assessing security:

- **Gitea token.**
  The API reads files from Altinn Studio's Gitea using a `GITEA_TOKEN` (a `read:repository` scoped token).
  It is read from a git-ignored `.env` file and sent only to `https://altinn.studio`.
  Never commit the token, and prefer a least-privilege (read-only) scope.
- **Not for public deployment.**
  CORS is open and there is no authentication on the endpoints — the API assumes a trusted, local-only context.
  Do not expose it to the public internet.
- **Untrusted input.**
  The API parses XML example data and remote files.
  Treat fetched/parsed content as untrusted and validate before use.
- **No personal data.**
  Bundled example data and logs must use synthetic data only — never real or personal data.

## Dependencies

The API depends on `express`, `cors`, `fast-xml-parser`, `libxmljs2`, `jsdom`, and the Arkitektum custom-components packages.
If you find a vulnerability in a dependency, please report it to that project as well, and open an advisory here if this API is affected.
