import assert from "node:assert/strict";
import { test } from "node:test";

import { extractNugetPackageVersion } from "./nugetPackageVersion.mjs";

const packageName = "Dibk.Ftpb.Common.AltinnApps";

test("reads the version attribute of a self-closing reference", () => {
    const csproj = [
        '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "  <ItemGroup>",
        '    <PackageReference Include="Altinn.App.Api" Version="8.5.0" />',
        '    <PackageReference Include="Dibk.Ftpb.Common.AltinnApps" Version="0.7.1-preview-1" />',
        "  </ItemGroup>",
        "</Project>"
    ].join("\n");
    assert.equal(extractNugetPackageVersion(csproj, packageName), "0.7.1-preview-1");
});

test("reads the version attribute when the reference has a body", () => {
    const csproj =
        '<PackageReference Include="Dibk.Ftpb.Common.AltinnApps" Version="1.2.3">\n  <PrivateAssets>all</PrivateAssets>\n</PackageReference>';
    assert.equal(extractNugetPackageVersion(csproj, packageName), "1.2.3");
});

test("reads the version from a Version child element", () => {
    const csproj = '<PackageReference Include="Dibk.Ftpb.Common.AltinnApps">\n  <Version>2.0.0</Version>\n</PackageReference>';
    assert.equal(extractNugetPackageVersion(csproj, packageName), "2.0.0");
});

test("does not take a package whose id only starts with the name", () => {
    const csproj = '<PackageReference Include="Dibk.Ftpb.Common.AltinnApps.SubformLayouts" Version="9.9.9" />';
    assert.equal(extractNugetPackageVersion(csproj, packageName), null);
});

test("finds the package after one whose id only starts with the name", () => {
    const csproj = [
        '<PackageReference Include="Dibk.Ftpb.Common.AltinnApps.SubformLayouts" Version="9.9.9" />',
        '<PackageReference Include="Dibk.Ftpb.Common.AltinnApps" Version="1.0.0" />'
    ].join("\n");
    assert.equal(extractNugetPackageVersion(csproj, packageName), "1.0.0");
});

test("does not take the version of the next reference when this one has none", () => {
    const csproj = [
        '<PackageReference Include="Dibk.Ftpb.Common.AltinnApps" />',
        '<PackageReference Include="Altinn.App.Api" Version="8.5.0" />'
    ].join("\n");
    assert.equal(extractNugetPackageVersion(csproj, packageName), null);
});

test("reads the dots in the id as dots, not as any character", () => {
    const csproj = '<PackageReference Include="Dibk-Ftpb-Common-AltinnApps" Version="5.0.0" />';
    assert.equal(extractNugetPackageVersion(csproj, packageName), null);
});

test("matches the id regardless of case, as NuGet does", () => {
    const csproj = "<packagereference include='dibk.ftpb.common.altinnapps' version='3.1.0' />";
    assert.equal(extractNugetPackageVersion(csproj, packageName), "3.1.0");
});

test("finds the version attribute written before Include", () => {
    const csproj = '<PackageReference Version="4.0.0" Include="Dibk.Ftpb.Common.AltinnApps" />';
    assert.equal(extractNugetPackageVersion(csproj, packageName), "4.0.0");
});

test("returns null when the package is not referenced", () => {
    assert.equal(extractNugetPackageVersion('<PackageReference Include="Altinn.App.Api" Version="8.5.0" />', packageName), null);
});

test("returns null for an empty version", () => {
    assert.equal(extractNugetPackageVersion('<PackageReference Include="Dibk.Ftpb.Common.AltinnApps" Version="" />', packageName), null);
});

test("returns null when given a non-string", () => {
    assert.equal(extractNugetPackageVersion(null, packageName), null);
    assert.equal(extractNugetPackageVersion(undefined, packageName), null);
});
