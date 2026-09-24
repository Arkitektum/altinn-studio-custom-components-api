// Dependencies
import { appCatalogue } from "@arkitektum/ftpb-app-catalogue";

/**
 * The Altinn Studio apps this API serves, spelled the way this repository spells them.
 *
 * The list itself lives in `@arkitektum/ftpb-app-catalogue`, because `altinn-studio-api-tools` needs the same one
 * and the two repositories held their own copies until 2026-09-24, by which point the copies had drifted apart.
 * Add an app there, not here.
 *
 * The shared catalogue names an app's organisation `org` and the app `app`; this repository has always called them
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
    // Left out when an app has none, which is what 24 of the 26 entries did before this list was shared. The other
    // two carried an empty array, so `getDisplayLayouts` answered "subForms": [] for those two and omitted the key
    // for the rest. Following the majority makes all 26 answer the same way.
    ...(app.subForms.length > 0 ? { subForms: app.subForms.map((subForm) => ({ appName: subForm.app, dataType: subForm.dataType })) } : {}),
    ...(app.layoutFiles ? { layoutFiles: app.layoutFiles } : {})
}));

export default altinnStudioApps;
