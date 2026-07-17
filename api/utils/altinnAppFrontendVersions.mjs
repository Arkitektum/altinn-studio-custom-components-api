/**
 * Extracts the versions of the altinn-app-frontend CSS and JS assets referenced in an app's Index.cshtml.
 *
 * The JS version comes from the `data-altinn-app-frontend-version` attribute (rendered on a `<meta>` tag) and the CSS
 * version from the version segment of the `altinn-app-frontend/<version>/altinn-app-frontend.css` stylesheet href.
 * Both are read with plain regexes rather than a full DOM parser, since only these two values are needed.
 *
 * @param {string} htmlString - The HTML content of the Index.cshtml file.
 * @returns {{ css: string|null, js: string|null }} The extracted CSS and JS versions (each null when not found).
 */
export function extractAltinnAppFrontendVersions(htmlString) {
    if (typeof htmlString !== "string") {
        return { css: null, js: null };
    }
    const jsMatch = htmlString.match(/data-altinn-app-frontend-version\s*=\s*["']([^"']*)["']/i);
    const cssMatch = htmlString.match(/altinn-app-frontend\/([^/"']+)\/altinn-app-frontend\.css/i);
    return {
        css: cssMatch?.[1] || null,
        js: jsMatch?.[1] || null
    };
}
