export default {
    altinnStudioCustomComponents: { type: "npm", package: "@arkitektum/altinn-studio-custom-components" },
    altinnAppFrontend: { type: "github", repo: "Altinn/app-frontend-react" },
    // Published to DIBK's own NuGet feed rather than nuget.org. The feed's package base address, from its
    // https://nugetserver-api.ft.dibk.no/v3/index.json service index.
    dibkFtpbCommonAltinnApps: { type: "nuget", feed: "https://nugetserver-api.ft.dibk.no/v3/package/", package: "Dibk.Ftpb.Common.AltinnApps" }
};
