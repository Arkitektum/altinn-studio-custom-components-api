import assert from "node:assert/strict";
import { test } from "node:test";

import { extractAltinnAppFrontendVersions } from "./altinnAppFrontendVersions.mjs";

test("extracts the JS version from the data attribute and the CSS version from the stylesheet href", () => {
    const html = [
        "<!DOCTYPE html><html><head>",
        '  <meta name="app-frontend" data-altinn-app-frontend-version="4.15.0" />',
        '  <link rel="stylesheet" href="https://altinncdn.no/toolkits/altinn-app-frontend/4/altinn-app-frontend.css" />',
        "</head><body></body></html>"
    ].join("\n");
    assert.deepEqual(extractAltinnAppFrontendVersions(html), { css: "4", js: "4.15.0" });
});

test("returns null for both when neither is present", () => {
    assert.deepEqual(extractAltinnAppFrontendVersions("<html><head></head></html>"), { css: null, js: null });
});

test("treats an empty version attribute as null", () => {
    assert.deepEqual(extractAltinnAppFrontendVersions('<meta data-altinn-app-frontend-version="" />'), { css: null, js: null });
});

test("still finds the CSS version when the href has a trailing query string", () => {
    const html = '<link rel="stylesheet" href="/altinn-app-frontend/3.2.1/altinn-app-frontend.css?v=abc" />';
    assert.equal(extractAltinnAppFrontendVersions(html).css, "3.2.1");
});

test("returns null for both when given a non-string", () => {
    assert.deepEqual(extractAltinnAppFrontendVersions(null), { css: null, js: null });
    assert.deepEqual(extractAltinnAppFrontendVersions(undefined), { css: null, js: null });
});
