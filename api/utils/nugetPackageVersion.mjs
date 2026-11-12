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
