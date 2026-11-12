/**
 * Escapes a string for use as a literal inside a regular expression.
 *
 * @param {string} value - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(value) {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Extracts the version of a NuGet package from the `<PackageReference>` elements of a .csproj file.
 *
 * The version is read from the `Version` attribute, or from a `<Version>` child element when the reference is written
 * out in full. The package name must match exactly (NuGet ids are case-insensitive), so a reference to
 * `Dibk.Ftpb.Common.AltinnApps.SubformLayouts` does not count as one to `Dibk.Ftpb.Common.AltinnApps`. Read with plain
 * regexes rather than an XML parser, since only this one value is needed.
 *
 * @param {string} csproj - The content of the .csproj file.
 * @param {string} packageName - The NuGet package id to look for.
 * @returns {string|null} The referenced version, or null when the package is not referenced or has no version.
 */
export function extractNugetPackageVersion(csproj, packageName) {
    const name = escapeRegExp(packageName);
    // A self-closing reference, or an opening tag followed by its body up to the closing tag.
    const referencePattern = new RegExp(
        String.raw`<PackageReference\b[^>]*\bInclude\s*=\s*["']\s*${name}\s*["'][^>]*?(?:/>|>([\s\S]*?)</PackageReference\s*>)`,
        "i"
    );
    // A missing file arrives as null, which exec reads as the text "null" and finds no reference in.
    const reference = referencePattern.exec(csproj);
    if (!reference) {
        return null;
    }
    const attributeVersion = /\bVersion\s*=\s*["']([^"']*)["']/i.exec(reference[0]);
    const elementVersion = /<Version\s*>([^<]*)<\/Version\s*>/i.exec(reference[1] ?? "");
    return attributeVersion?.[1]?.trim() || elementVersion?.[1]?.trim() || null;
}

/**
 * Splits a version into its numeric release parts, or answers null for a prerelease or anything that is not a version.
 *
 * NuGet versions can have a fourth part (`1.2.3.4`), and build metadata after a `+` does not count for ordering.
 *
 * @param {string} version - The version to split.
 * @returns {number[]|null} The release parts, or null.
 */
function stableVersionParts(version) {
    const match = /^(\d+(?:\.\d+){0,3})(?:\+.*)?$/.exec(String(version).trim());
    return match ? match[1].split(".").map(Number) : null;
}

/**
 * Picks the highest stable version from a list of versions, as a NuGet feed lists them.
 *
 * A feed lists versions in the order they were published, not by version, so the last one is not necessarily the
 * highest. Prereleases are left out, the same way npm's `latest` tag and GitHub's latest release leave them out.
 *
 * @param {string[]} versions - The versions to choose from.
 * @returns {string|null} The highest stable version, or null when there is none.
 */
export function latestStableVersion(versions) {
    let latest = null;
    let latestParts = null;
    for (const version of Array.isArray(versions) ? versions : []) {
        const parts = stableVersionParts(version);
        if (!parts) continue;
        // A missing part reads as zero. Comparing over this version's own parts is enough: parts only the current latest
        // has can never make this one higher.
        let comparison = latestParts ? 0 : 1;
        for (let index = 0; comparison === 0 && index < parts.length; index++) {
            comparison = Math.sign((parts[index] ?? 0) - (latestParts[index] ?? 0));
        }
        if (comparison > 0) {
            latest = version;
            latestParts = parts;
        }
    }
    return latest;
}
