// Dependencies
import { appCatalogue } from "@arkitektum/ftpb-app-catalogue";

/**
 * The Altinn Studio apps this API serves, spelled the way this repository spells them.
 *
 * The list itself lives in `@arkitektum/ftpb-app-catalogue`, because `altinn-studio-api-tools` needs the same one.
 * Add an app there, not here.
 *
 * The shared catalogue names an app's organisation `org` and the app `app`; this repository calls them
 * `appOwner` and `appName`, and enough of it reads those names that renaming them here would be a larger change
 * than sharing the list. So the list is projected on the way in.
 *
 * @typedef {{appName: string, dataType: string}} SubFormEntry
 * @typedef {{name: string, path: string}} LayoutFileEntry
 * @type {Array<{appOwner: string, appName: string, dataType: string, subForms?: SubFormEntry[], layoutFiles?: LayoutFileEntry[]}>}
 */
const altinnStudioApps = appCatalogue.map((app) => ({
    appOwner: app.org,
    appName: app.app,
    dataType: app.dataType,
    // Left out when an app has none, so every app without subforms answers the same way in `getDisplayLayouts`.
    ...(app.subForms.length > 0 ? { subForms: app.subForms.map((subForm) => ({ appName: subForm.app, dataType: subForm.dataType })) } : {}),
    ...(app.layoutFiles ? { layoutFiles: app.layoutFiles } : {})
}));

export default altinnStudioApps;
