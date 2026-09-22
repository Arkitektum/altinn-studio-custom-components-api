// Dependencies
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

// Data
import altinnStudioApps from "../data/altinnStudioApps.mjs";
import packageSources from "../data/packageSources.mjs";
import subforms from "../data/subforms.mjs";

// Utils
import { compileXmlSchema, convertXmlToJson } from "../utils/xmlToJsonConverter.mjs";
import { exampleDataDir, readExampleFilesFromDisk } from "../utils/exampleFiles.mjs";
import { fetchTestmotorApps, fetchTestmotorFormXml } from "../utils/testmotorClient.mjs";
import { createConcurrencyLimiter } from "../utils/concurrencyLimiter.mjs";
import { extractAltinnAppFrontendVersions } from "../utils/altinnAppFrontendVersions.mjs";
import { log } from "../utils/logger.mjs";
import { stripJsonComments } from "../utils/stripJsonComments.mjs";

// Resolve paths relative to this module rather than the current working directory, so the server works
// regardless of where it is launched from.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../..");
const defaultTextResourcesFilePath = path.join(repoRoot, "node_modules/@arkitektum/altinn-studio-custom-components/dist/resources.json");
const resourceValueLanguages = ["nb", "nn"];

// Loaded lazily and cached on first successful read (see getDefaultTextResources), so a missing/malformed
// resources.json degrades gracefully instead of crashing the server at import time.
let defaultTextResourcesCache;

// Every endpoint fans out over all tracked apps at once, and the dashboard calls several endpoints together, so
// without a cap one "Synchronize" opens well over a hundred connections to Altinn Studio at the same time (measured:
// ~180 requests, peaking at ~160 concurrent). All requests share this one gate, whatever mix of endpoints is in
// flight. The default trades a little wall-clock for being a reasonable client; raise ALTINN_STUDIO_CONCURRENCY for a
// faster cold sync, lower it if Altinn Studio starts refusing connections.
const parsedConcurrency = Number.parseInt(process.env.ALTINN_STUDIO_CONCURRENCY, 10);
const altinnStudioConcurrency = Number.isInteger(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 16;
const limitAltinnStudioRequest = createConcurrencyLimiter(altinnStudioConcurrency);

// Example data is assembled per app, and an app's work is nearly all waiting: one request to the testmotor, one
// schema fetch per data type. Taking the catalogue one app at a time meant every one of those round trips happened
// after the one before it. Running the apps together collapses that into a few waves instead.
//
// Bounded rather than unbounded because one testmotor answer carries every example file for an app — the largest
// runs to several megabytes — and there is nothing to gain from holding twenty-six of those in memory at once.
// Altinn Studio requests stay inside their own budget above whatever this is set to.
const EXAMPLE_DATA_APP_CONCURRENCY = 8;
const limitExampleDataApp = createConcurrencyLimiter(EXAMPLE_DATA_APP_CONCURRENCY);

/**
 * Fetches the latest version of a package from the npm registry.
 *
 * @param {string} packageName - The name of the npm package to fetch the latest version for.
 * @returns {Promise<string|null>} The latest version of the package, or null if it cannot be fetched.
 */
async function fetchLatestVersionFromNpm(packageName) {
    try {
        // Encode every "/" so scoped names like "@scope/name" become "@scope%2Fname" for the registry path.
        const encodedName = packageName.replaceAll("/", "%2F");
        const response = await fetch(`https://registry.npmjs.org/${encodedName}/latest`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.version ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetches the latest version of a package from a GitHub repository.
 *
 * @param {string} repo - The GitHub repository in the format "owner/repo".
 * @returns {Promise<string|null>} The latest version of the package, or null if it cannot be fetched.
 */
async function fetchLatestVersionFromGithub(repo) {
    try {
        // GitHub's REST API rejects requests without a User-Agent header (HTTP 403), so one must be sent explicitly.
        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { "User-Agent": "altinn-studio-custom-components-api", Accept: "application/vnd.github+json" }
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.tag_name?.replace(/^v/, "") ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetches the latest versions of all packages defined in the packageSources object.
 *
 * @returns {Promise<Object>} An object containing the latest versions of all packages.
 */
export async function getLatestPackageVersions() {
    const versionPromises = Object.entries(packageSources).map(async ([key, source]) => {
        const origin = source.package ?? source.repo ?? source.type;
        let version = null;
        if (source.type === "npm") {
            version = await fetchLatestVersionFromNpm(source.package);
        } else if (source.type === "github") {
            version = await fetchLatestVersionFromGithub(source.repo);
        }
        // The fetch helpers swallow their errors and answer null, so this is the only place the outcome is visible.
        if (version) {
            log.ok({ scope: key, category: "Latest version", message: `${version} (${origin})` });
        } else {
            log.warn({ scope: key, category: "Latest version not resolved", message: `${source.type}: ${origin}` });
        }
        return { [key]: version };
    });

    return Promise.all(versionPromises).then((versions) => Object.assign({}, ...versions));
}

/**
 * Fetches the content of a file from a Gitea repository using the Altinn Studio API.
 *
 * @async
 * @function
 * @param {string} appOwner - The owner of the application repository.
 * @param {string} appName - The name of the application repository.
 * @param {string} filePath - The path to the file within the repository.
 * @param {Object} [options]
 * @param {boolean} [options.optional=false] - Set when a missing file is either expected (not every app ships a
 *   nynorsk resource file) or already reported by the caller with better context. A 404 is then recorded as progress
 *   instead of a warning, so the report only warns about files that are actually supposed to be there.
 * @returns {Promise<string>} The content of the requested file as a string.
 * @throws {Error} If the fetch operation fails or the response is not OK.
 */
async function fetchGiteaFileContent(appOwner, appName, filePath, { optional = false } = {}) {
    // Default branch is "master" (Gitea's historical default); override with GITEA_BRANCH for apps that use "main".
    const branch = process.env.GITEA_BRANCH || "master";
    const url = `https://altinn.studio/repos/${appOwner}/${appName}/raw/branch/${branch}/${filePath}`;
    const token = process.env.GITEA_TOKEN;
    // Fail fast with a clear message when the token is missing. Without it Altinn Studio returns an HTML login page,
    // which otherwise surfaces later as a confusing "Premature end of data in tag div" XML parse error.
    if (!token || !token.trim()) {
        throw new Error("GITEA_TOKEN is not set — add it to your .env (see .env.sample) to fetch Altinn Studio data.");
    }
    const options = {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`
        }
    };
    try {
        // The slot is held until the body has been read, so the cap bounds open connections rather than just how many
        // requests have been started.
        return await limitAltinnStudioRequest(async () => {
            const response = await fetch(url, options);
            if (!response.ok) {
                // Missing files are expected (optional layouts/subforms); return null so callers can skip them gracefully.
                if (response.status === 404) {
                    if (optional) {
                        log.progress(`⚠️ Optional file not found: ${appOwner}/${appName} ${filePath}`);
                    } else {
                        log.warn({ scope: `${appOwner}/${appName}`, category: "File not found in Altinn Studio", message: filePath });
                    }
                    return null;
                }
                // No severity marker in the message: it is reported as the detail of whichever event the caller records.
                throw new Error(`Failed to fetch ${filePath} (status ${response.status}) from ${url}`);
            }
            let content = await response.text();

            // If it's a JSON file, strip comments to prevent JSON.parse() failures
            if (filePath.toLowerCase().endsWith(".json")) {
                content = stripJsonComments(content);
            }

            return content;
        });
    } catch (error) {
        // The caller records this failure with its own context (which app, which endpoint), so logging it here too
        // would only duplicate a line in the report. Keep the exact URL for verbose runs.
        log.progress(`⚠️ Error fetching file content from ${url}: ${error.message}`);
        throw error;
    }
}

/**
 * The default display layout used when an app does not define its own `layoutFiles`.
 */
const DEFAULT_DISPLAY_LAYOUT_FILE = { name: "DisplayLayout", path: "App/ui/form/layouts/DisplayLayout.json" };

/**
 * Fetches the display layout JSON from an Altinn Studio app repository.
 *
 * @async
 * @function
 * @param {string} appOwner - The owner of the application repository.
 * @param {string} appName - The name of the application repository.
 * @param {string} filePath - The repository path of the display layout file to fetch.
 * @returns {Promise<Object|null>} The parsed JSON content of the display layout, or null if the file is missing.
 * @throws {Error} If fetching or parsing the display layout fails.
 */
async function fetchDisplayLayoutFromAltinnStudio(appOwner, appName, filePath) {
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath);
    if (!fileContent) {
        return null;
    }
    const jsonResponse = JSON.parse(fileContent);
    return jsonResponse;
}

/**
 * Fetches the display layout JSON for a subform from an Altinn Studio app repository.
 *
 * @async
 * @function
 * @param {string} appOwner - The owner of the application repository.
 * @param {string} appName - The name of the application repository.
 * @param {string} subFormDataType - The data type of the subform for which to fetch the display layout.
 * @returns {Promise<Object>} The parsed JSON content of the subform display layout.
 * @throws {Error} If fetching or parsing the subform display layout fails.
 */
async function fetchSubFormDisplayLayoutFromAltinnStudio(appOwner, appName, subFormDataType) {
    const filePath = `App/ui/subform-${subFormDataType}/layouts/${subFormDataType}.json`;
    // getSubFormLayout reports a missing layout as an error naming the subform, so a 404 warning here would only
    // report the same thing twice.
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath, { optional: true });
    if (!fileContent) {
        return null;
    }
    const jsonResponse = JSON.parse(fileContent);
    return jsonResponse;
}

/**
 * Helper function to fetch and validate a subform layout.
 * @param {string} appOwner
 * @param {string} appName
 * @param {string} subFormDataType
 * @returns {Promise<Object|null>}
 */
async function getSubFormLayout(appOwner, appName, subFormDataType) {
    try {
        const subLayout = await fetchSubFormDisplayLayoutFromAltinnStudio(appOwner, appName, subFormDataType);
        if (!subLayout) {
            throw new Error(`No layout file found for subform ${subFormDataType}`);
        }
        log.ok({ scope: `${appOwner}/${appName}`, category: "Subform layout" });
        return subLayout;
    } catch (error) {
        log.error({
            scope: `${appOwner}/${appName}`,
            category: "Subform layout not fetched",
            message: subFormDataType,
            detail: error.message
        });
        return null;
    }
}

/**
 * Fetches the display layouts for all Altinn Studio apps and their associated subforms, and returns them as an array of layout objects.
 *
 * This function iterates over the list of Altinn Studio apps, fetches every display layout for each app (as defined by its `layoutFiles`,
 * falling back to a single default layout), and if the app has associated subforms it also fetches the display layouts for those subforms.
 * The resulting array contains layout objects for both main-form apps and subforms. Each app object includes the app owner, app name, data type,
 * an array of named display layouts, and any associated subforms.
 *
 * @async
 * @function
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of display layout objects for all Altinn Studio apps and their subforms.
 * @throws {Error} If fetching or parsing any of the display layouts fails.
 */
export async function getDisplayLayouts() {
    const layoutPromises = altinnStudioApps.map(({ appOwner, appName, dataType, layoutFiles, subForms }) => {
        const layoutFilesToFetch = layoutFiles?.length ? layoutFiles : [DEFAULT_DISPLAY_LAYOUT_FILE];
        return Promise.all(
            layoutFilesToFetch.map(async ({ name, path }) => {
                const layout = await fetchDisplayLayoutFromAltinnStudio(appOwner, appName, path);
                if (!layout) {
                    return null;
                }
                log.ok({ scope: `${appOwner}/${appName}`, category: "Display layout", message: name });
                return { name, path, layout };
            })
        )
            .then(async (fetchedLayouts) => {
                const displayLayouts = fetchedLayouts.filter((displayLayout) => displayLayout !== null);
                if (!displayLayouts.length) {
                    throw new Error(`No layout found for ${appOwner}/${appName}`);
                }
                if (subForms) {
                    subForms = await Promise.all(
                        subForms.map(async (subForm) => {
                            const subFormDataType = subForm.dataType;
                            const subFormLayout = await getSubFormLayout(appOwner, appName, subFormDataType);
                            return {
                                ...subForm,
                                layout: subFormLayout
                            };
                        })
                    );
                }
                return {
                    appOwner,
                    appName,
                    dataType,
                    displayLayouts,
                    subForms
                };
            })
            .catch((error) => {
                log.error({ scope: `${appOwner}/${appName}`, category: "Display layouts not fetched", detail: error.message });
                return null;
            });
    });
    const layouts = await Promise.all(layoutPromises);
    const allLayouts = layouts.filter((layout) => layout !== null).concat(subforms);
    return allLayouts;
}

/**
 * Fetches the package-lock.json file from an Altinn Studio app repository and extracts the version information.
 *
 * @async
 * @function
 * @param {string} appOwner - The owner of the application repository.
 * @param {string} appName - The name of the application repository.
 * @returns {Promise<Object>} An object containing the version information from the package-lock.json file.
 * @throws {Error} If fetching or parsing the package-lock.json file fails.
 */
async function fetchPackageLockFromAltinnStudio(appOwner, appName) {
    const filePath = "App/package-lock.json";
    // getPackageVersions reports the app as unresolved, which covers a missing lockfile as well as one that
    // doesn't list the components package.
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath, { optional: true });
    if (!fileContent) {
        return null;
    }
    const jsonResponse = JSON.parse(fileContent);
    return jsonResponse;
}

/**
 * Fetches the resource file for a given app and language from Gitea.
 *
 * @async
 * @param {string} appOwner - The owner of the app repository.
 * @param {string} appName - The name of the app repository.
 * @param {string} [language="nb"] - The language code for the resource file (default is "nb").
 * @returns {Promise<Object>} The parsed JSON content of the resource file.
 */
async function fetchAppResourceFile(appOwner, appName, language = "nb") {
    const filePath = `App/config/texts/resource.${language}.json`;
    // Apps are not required to ship every language — most have no nynorsk file — so a missing one is normal and not
    // worth a warning. getAppResourceValues still warns about an app with no readable resource file at all.
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath, { optional: true });
    if (!fileContent) {
        return null;
    }
    const jsonResponse = JSON.parse(fileContent);
    return jsonResponse;
}

/**
 * Merges multiple resource files into a single array of resource objects,
 * grouping values by their resource ID and language.
 *
 * @param {...Object} files - The resource files to merge. Each file should have a `language` property (string)
 *   and a `resources` property (array of objects with `id` and `value`).
 * @returns {Array<Object>} An array of merged resource objects, each with an `id` and a `values` object
 *   mapping language codes to their respective values.
 */
function mergeResourceFiles(...files) {
    const resultMap = {};

    files.forEach((file) => {
        const { language, resources } = file;

        resources.forEach(({ id, value }) => {
            if (!resultMap[id]) {
                resultMap[id] = { id, values: {} };
            }

            resultMap[id].values[language] = value;
        });
    });

    return Object.values(resultMap);
}

/**
 * Fetches resource values for all Altinn Studio apps for a given language.
 *
 * Iterates over the list of Altinn Studio apps, fetches the resource file for each app in the specified language,
 * and returns an array of objects containing the app owner, app name, and the fetched resource values.
 * If fetching fails for an app, it logs the error and excludes that app from the result.
 *
 * @async
 * @param {string} [language] - Optional language code to restrict the fetch to (e.g. 'nb', 'nn'). When omitted or
 *   not one of the supported languages, resource values for all supported languages are returned.
 * @returns {Promise<Array<{ appOwner: string, appName: string, resourceValues: any }>>}
 *   A promise that resolves to an array of resource value objects for each app.
 */
export async function getAppResourceValues(language) {
    const languages = language && resourceValueLanguages.includes(language) ? [language] : resourceValueLanguages;
    const appResourcePromises = altinnStudioApps.map(async ({ appOwner, appName }) => {
        try {
            const resourceFiles = await Promise.all(
                languages.map((lang) =>
                    fetchAppResourceFile(appOwner, appName, lang)
                        .then((file) => {
                            // A missing file resolves to null, and an app can ship a resource file without a
                            // "resources" array. Skip either case: passing one on would throw inside
                            // mergeResourceFiles and take down every language for this app, not just this one.
                            if (!Array.isArray(file?.resources)) {
                                return null;
                            }
                            log.ok({ scope: `${appOwner}/${appName}`, category: "App resources", message: lang });
                            return { language: lang, resources: file.resources };
                        })
                        .catch((error) => {
                            log.warn({
                                scope: `${appOwner}/${appName}`,
                                category: "App resources unreadable",
                                message: `resource.${lang}.json`,
                                detail: error.message
                            });
                            return null;
                        })
                )
            );

            const validResourceFiles = resourceFiles.filter((file) => file !== null);

            if (validResourceFiles.length === 0) {
                log.warn({
                    scope: `${appOwner}/${appName}`,
                    category: "App skipped — no readable resource file",
                    message: languages.map((lang) => `resource.${lang}.json`).join(", ")
                });
                return null;
            }

            const resourceValues = mergeResourceFiles(...validResourceFiles);

            return {
                appOwner,
                appName,
                resourceValues
            };
        } catch (error) {
            log.error({ scope: `${appOwner}/${appName}`, category: "App resources not fetched", detail: error.message });
            return null;
        }
    });

    const resources = await Promise.all(appResourcePromises);
    return resources.filter((resource) => resource !== null);
}

/**
 * Fetches the default text resources from a local JSON file.
 *
 * This function reads the content of the 'resources.json' file located in the './api/data/' directory,
 * parses it as JSON, and returns the resulting object. If there is an error during file reading or parsing,
 * it logs the error and returns null.
 *
 * @async
 * @function
 * @returns {Promise<Object|null>} A promise that resolves to the parsed JSON object containing default text resources,
 *   or null if an error occurs.
 */
export async function getDefaultTextResources() {
    if (defaultTextResourcesCache !== undefined) {
        return defaultTextResourcesCache;
    }
    try {
        defaultTextResourcesCache = JSON.parse(await fs.readFile(defaultTextResourcesFilePath, "utf8"));
        return defaultTextResourcesCache;
    } catch (error) {
        log.error({
            scope: "@arkitektum/altinn-studio-custom-components",
            category: "Default text resources unreadable",
            message: defaultTextResourcesFilePath,
            detail: error.message
        });
        return null;
    }
}

/**
 * Fetches the Index.cshtml file from an Altinn Studio app repository, which typically contains references to frontend assets.
 * This function is used to extract the versions of the altinn-app-frontend CSS and JS files referenced in the Index.cshtml.
 * @param {string} appOwner - The owner of the application repository.
 * @param {string} appName - The name of the application repository.
 * @returns {Promise<string>} The content of the Index.cshtml file as a string.
 * @throws {Error} If fetching the Index.cshtml file fails.
 */
async function fetchAltinnAppIndexHtml(appOwner, appName) {
    const filePath = "App/views/Home/Index.cshtml";
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath);
    return fileContent;
}

/**
 * Extracts the version of the altinn-studio-custom-components package from the given package-lock.json content.
 * @param {Object} packageLock - The parsed JSON content of the package-lock.json file.
 * @returns {string} The version of the altinn-studio-custom-components package.
 * @throws {Error} If the package-lock.json is missing, or does not list the altinn-studio-custom-components package.
 */
function extractAltinnStudioCustomComponentsVersion(packageLock) {
    // Distinguish "no lockfile in the repo" from "lockfile without the package" — the fetch no longer reports the
    // missing file itself, so this message is the only explanation the report gets.
    if (!packageLock) {
        throw new Error("App/package-lock.json not found in the repository");
    }
    const dependencies = packageLock?.packages || {};
    const altinnStudioCustomComponents = dependencies?.["node_modules/@arkitektum/altinn-studio-custom-components"];
    if (altinnStudioCustomComponents?.version) {
        return altinnStudioCustomComponents.version;
    }
    throw new Error("altinn-studio-custom-components not found in package-lock.json");
}

/**
 * Fetches and returns the versions of the altinn-studio-custom-components package and the altinn-app-frontend assets for all Altinn Studio apps.
 *
 * Iterates over the list of Altinn Studio applications, fetches their package-lock.json files and Index.cshtml files to extract version information,
 * and returns an array of objects containing the app owner, app name, and version details. If fetching version information fails for an app, it logs
 * the error and skips that app.
 *
 * @async
 * @function
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of objects with version information for each app.
 */
export async function getPackageVersions() {
    const versionPromises = altinnStudioApps.map(async ({ appOwner, appName }) => {
        try {
            const [packageLock, indexHtml] = await Promise.all([
                fetchPackageLockFromAltinnStudio(appOwner, appName),
                fetchAltinnAppIndexHtml(appOwner, appName)
            ]);
            const altinnStudioCustomComponentsVersion = extractAltinnStudioCustomComponentsVersion(packageLock);
            const altinnAppFrontendVersions = extractAltinnAppFrontendVersions(indexHtml);
            log.ok({ scope: `${appOwner}/${appName}`, category: "Package versions", message: altinnStudioCustomComponentsVersion });
            return {
                appOwner,
                appName,
                packageVersions: {
                    altinnStudioCustomComponents: altinnStudioCustomComponentsVersion,
                    altinnAppFrontendCSS: altinnAppFrontendVersions.css,
                    altinnAppFrontendJS: altinnAppFrontendVersions.js
                }
            };
        } catch (error) {
            log.error({ scope: `${appOwner}/${appName}`, category: "Package versions not resolved", detail: error.message });
            return null;
        }
    });

    const versions = await Promise.all(versionPromises);
    return versions.filter((version) => version !== null);
}

/**
 * Retrieves a combined list of Altinn Studio applications and subforms.
 *
 * This function maps over the `subforms` array to extract relevant properties
 * (`appOwner`, `appName`, `dataType`) from each subform, then merges these with
 * the existing `altinnStudioApps` array to produce a single array containing all apps.
 *
 * @returns {Array<Object>} An array of objects representing both Altinn Studio apps and subforms.
 */
export function getAltinnStudioForms() {
    const subFormApps = subforms?.map((subform) => ({
        appOwner: subform?.appOwner,
        appName: subform?.appName,
        dataType: subform?.dataType
    }));
    const allApps = [...altinnStudioApps, ...subFormApps];
    return allApps;
}

/**
 * The repository path of the XSD for a data type. Shared so the callers that report a missing schema name the same
 * path that was fetched.
 *
 * @param {string} dataType - The data type to build the schema path for.
 * @returns {string} The path to the schema file within the repository.
 */
function xmlSchemaFilePath(dataType) {
    return `App/models/${dataType}.xsd`;
}

/**
 * Fetches the XML schema (XSD) file content for a given data type from an Altinn Studio app repository.
 *
 * @async
 * @param {string} appOwner - The owner of the Altinn Studio app.
 * @param {string} appName - The name of the Altinn Studio app.
 * @param {string} dataType - The data type whose XML schema should be fetched.
 * @returns {Promise<string>} The content of the XML schema file as a string.
 */
async function fetchXmlSchemaFromAltinnStudio(appOwner, appName, dataType) {
    // Reported once by the caller, which then skips the affected example files rather than failing each of them with
    // an opaque parser error about a schema that was never there.
    return fetchGiteaFileContent(appOwner, appName, xmlSchemaFilePath(dataType), { optional: true });
}

/**
 * Fetches the application metadata JSON from an Altinn Studio app repository.
 *
 * @async
 * @function
 * @param {string} appOwner - The owner of the application repository.
 * @param {string} appName - The name of the application repository.
 * @returns {Promise<Object>} The parsed JSON content of the application metadata.
 * @throws {Error} If fetching or parsing the application metadata fails.
 */
async function fetchApplicationMetadataFromAltinnStudio(appOwner, appName) {
    const filePath = "App/config/applicationmetadata.json";
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath);
    if (!fileContent) {
        return null;
    }
    const jsonResponse = JSON.parse(fileContent);
    return jsonResponse;
}

/**
 * Fetches the application metadata for all Altinn Studio apps and returns it as an array of metadata objects.
 *
 * This function iterates over the list of Altinn Studio apps, fetches the application metadata for each app,
 * and returns an array of objects containing the app owner, app name, and the fetched metadata. If fetching
 * metadata fails for an app, it logs the error and excludes that app from the result.
 *
 * @async
 * @function
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of application metadata objects for each app.
 * @throws {Error} If fetching or parsing any of the application metadata fails.
 */
export async function getApplicationMetadata() {
    const metadataPromises = altinnStudioApps.map(async ({ appOwner, appName }) => {
        try {
            const metadata = await fetchApplicationMetadataFromAltinnStudio(appOwner, appName);
            if (metadata) {
                log.ok({ scope: `${appOwner}/${appName}`, category: "Application metadata" });
            }
            return {
                appOwner,
                appName,
                metadata
            };
        } catch (error) {
            log.error({ scope: `${appOwner}/${appName}`, category: "Application metadata not fetched", detail: error.message });
            return null;
        }
    });

    const metadataArray = await Promise.all(metadataPromises);
    return metadataArray.filter((metadata) => metadata !== null);
}

/**
 * @typedef {Object} ExampleFile
 * @property {string} name - What the file is offered as: its stem, with the ordering prefix and the file extension
 *   stripped, from both sources alike.
 * @property {Object} data - The file's XML converted to JSON, with the root element removed.
 */

/**
 * @typedef {Object} ExampleDataEntry
 * @property {string|null} appOwner - The app these examples belong to, or null for a subform's shared examples.
 * @property {string|null} appName - As above. Null means "matches any app declaring this data type".
 * @property {string} dataType - The Altinn data type the examples are filed under.
 * @property {string|null} error - Why `files` is empty, when the reason is a failure rather than an absence. The
 *   dashboard has to tell "there are no examples for this" from "the examples could not be fetched".
 * @property {ExampleFile[]} files - In source order: the testmotor's own for a main form, prefix order on disk.
 */

/**
 * Converts one example file's XML to JSON.
 *
 * A failure is recorded and swallowed rather than thrown: one example that no longer validates against its schema
 * should cost that one file, not the rest of its app and not its subforms.
 *
 * @param {Object} params
 * @param {string} params.scope - The app the file belongs to, for the log.
 * @param {string} params.dataType - The data type the file belongs to.
 * @param {string} params.name - The file's label.
 * @param {string} params.contents - The XML.
 * @param {import("../utils/xmlToJsonConverter.mjs").CompiledXmlSchema} params.schema - The schema to validate against.
 * @returns {ExampleFile|null} Null when the file could not be converted.
 */
function convertExampleFile({ scope, dataType, name, contents, schema }) {
    try {
        log.progress(`📄 Processing XML: ${scope} - ${dataType} (${name})`);
        const data = convertXmlToJson(contents, schema);
        log.ok({ scope, category: "Example data", message: `${dataType} (${name})` });
        return { name, data };
    } catch (error) {
        log.error({ scope, category: "Example file skipped", message: `${dataType} (${name})`, detail: error.message });
        return null;
    }
}

/**
 * One app's main form example files, unconverted, and why there are none when there are none.
 *
 * The testmotor is the source for every main form it holds, because it re-stamps the date fields on every request
 * and a file committed here cannot. Disk is consulted only for an app it does not hold.
 *
 * @async
 * @param {Object} app - The catalogue entry: `appOwner`, `appName` and `dataType`.
 * @param {Object} sources
 * @param {Array<{appId: string}>|null} sources.testmotorApps - The apps the testmotor holds, or null when the
 *   listing could not be read.
 * @param {string|null} sources.testmotorError - Why the listing could not be read, if it could not.
 * @returns {Promise<{files: Array<{name: string, contents: string}>, error: string|null}>}
 */
async function readMainFormExampleFiles(app, { testmotorApps, testmotorError }) {
    if (testmotorApps?.some((entry) => entry.appId === app.appName)) {
        try {
            return { files: await fetchTestmotorFormXml(app.appName), error: null };
        } catch (error) {
            log.error({
                scope: `${app.appOwner}/${app.appName}`,
                category: "Testmotor examples not fetched",
                message: app.dataType,
                detail: error.message
            });
            return { files: [], error: error.message };
        }
    }

    // An example folder is named after the data type rather than the app, so it can only be attributed to an app
    // when exactly one app claims that data type. fa-v3 and fa-v5 both claim FA and hold different data, so a
    // folder named FA answers for at most one of them and there is no way to tell which.
    const claimants = altinnStudioApps.filter((entry) => entry.dataType === app.dataType);
    const files = claimants.length === 1 ? await readExampleFilesFromDisk(path.join(exampleDataDir(), "forms", app.dataType)) : [];
    if (files.length > 0) {
        return { files, error: null };
    }

    // Nothing anywhere. That is a plain absence for an app the testmotor holds no data for, and a failure only if
    // the testmotor could not be asked — in which case we never learnt whether it holds this app at all.
    return { files: [], error: testmotorError };
}

/**
 * Validates a set of example files against their data type's schema in Altinn Studio and converts them to JSON.
 *
 * @async
 * @param {Object} params
 * @param {string} params.appOwner - The owner of the repository holding the schema.
 * @param {string} params.appName - The repository holding the schema.
 * @param {string} params.dataType - The data type the files belong to.
 * @param {Array<{name: string, contents: string}>} params.files - The files to convert, in the order to keep them.
 * @param {string} [params.label="example"] - What to call these files in the log.
 * @returns {Promise<{files: ExampleFile[], error: string|null}>} The error is set when the schema itself could not
 *   be fetched or parsed, which costs every file rather than one.
 */
async function convertExampleFiles({ appOwner, appName, dataType, files, label = "example" }) {
    if (files.length === 0) {
        return { files: [], error: null };
    }

    const scope = `${appOwner}/${appName}`;
    const skipped = `${files.length} ${label} file${files.length === 1 ? "" : "s"} could not be validated.`;
    const xmlSchema = await fetchXmlSchemaFromAltinnStudio(appOwner, appName, dataType);
    if (!xmlSchema) {
        log.error({
            scope,
            category: "Schema not found — example files skipped",
            message: xmlSchemaFilePath(dataType),
            detail: skipped
        });
        return { files: [], error: `${xmlSchemaFilePath(dataType)} could not be read from Altinn Studio, so the examples could not be validated.` };
    }

    // Parsed once for the whole set rather than once per file. A schema that cannot be parsed is reported like one
    // that could not be fetched: the files are fine, and saying so once beats blaming each of them in turn.
    let schema;
    try {
        schema = compileXmlSchema(xmlSchema);
    } catch (error) {
        log.error({ scope, category: "Schema unreadable — example files skipped", message: xmlSchemaFilePath(dataType), detail: skipped });
        return {
            files: [],
            error: `${xmlSchemaFilePath(dataType)} could not be parsed as a schema (${error.message}), so the examples could not be validated.`
        };
    }

    return {
        files: files.map((file) => convertExampleFile({ scope, dataType, ...file, schema })).filter((file) => file !== null),
        error: null
    };
}

/**
 * One app's main form examples, as a single entry naming the app.
 *
 * Nothing thrown escapes: individual files are handled by convertExampleFile, so this catches what fails for the app
 * as a whole — an unreadable directory, or a schema fetch that threw instead of answering null — and turns it into an
 * entry carrying the reason.
 *
 * @async
 * @param {Object} app - The catalogue entry.
 * @param {Object} sources - As for readMainFormExampleFiles.
 * @returns {Promise<ExampleDataEntry>}
 */
async function mainFormExampleEntry(app, sources) {
    const { appOwner, appName, dataType } = app;
    try {
        const source = await readMainFormExampleFiles(app, sources);
        const converted = await convertExampleFiles({ appOwner, appName, dataType, files: source.files });
        return { appOwner, appName, dataType, error: source.error ?? converted.error, files: converted.files };
    } catch (error) {
        log.error({ scope: `${appOwner}/${appName}`, category: "Example data not processed", message: dataType, detail: error.message });
        return { appOwner, appName, dataType, error: error.message, files: [] };
    }
}

/**
 * One subform's examples, filed under no app.
 *
 * Subform entries name no app. The same subform is declared by several parents, its examples are one shared set,
 * and it is whichever parent got there first whose repository supplies the schema — so recording an app on the
 * entry would record an arbitrary one. A null app means "matches any app that declares this data type" instead.
 *
 * @async
 * @param {Object} app - The catalogue entry this subform was assigned to, which supplies the schema.
 * @param {string} dataType - The subform's data type.
 * @returns {Promise<ExampleDataEntry|null>} Null when the subform could not be processed at all, which is reported
 *   and costs that one subform rather than the app it was reached through.
 */
async function subformExampleEntry(app, dataType) {
    try {
        const files = await readExampleFilesFromDisk(path.join(exampleDataDir(), "subforms", dataType));
        const converted = await convertExampleFiles({
            appOwner: app.appOwner,
            appName: app.appName,
            dataType,
            files,
            label: "subform example"
        });
        return { appOwner: null, appName: null, dataType, error: converted.error, files: converted.files };
    } catch (error) {
        log.error({
            scope: `${app.appOwner}/${app.appName}`,
            category: "Subform example data not processed",
            message: dataType,
            detail: error.message
        });
        return null;
    }
}

/**
 * Which subforms each app is responsible for fetching, so that a subform declared by several apps is fetched once.
 *
 * Decided up front rather than by checking what has already been collected, because the apps no longer run one after
 * another and "has anyone done this yet" has no answer while they are all in flight. Walking the catalogue in order
 * gives the subform to the first app that declares it — the same one that reached it first when this was a loop.
 *
 * @param {Array<Object>} apps - The catalogue, in order.
 * @returns {string[][]} One array of data types per app, positionally.
 */
function subformDataTypesPerApp(apps) {
    const assigned = new Set();
    return apps.map((app) =>
        (app.subForms ?? [])
            .map((subForm) => subForm.dataType)
            .filter((dataType) => {
                if (assigned.has(dataType)) {
                    return false;
                }
                assigned.add(dataType);
                return true;
            })
    );
}

/**
 * Every example the dashboard can offer: each tracked app's main form, and the subforms those apps declare.
 *
 * The main forms come from the FtPB testmotor rather than from disk, because it re-stamps the date fields on every
 * request and a copy committed here goes stale within a fortnight — see `api/utils/testmotorClient.mjs`. The
 * testmotor is keyed by app id, which is why an entry names the app and not only the data type: fa-v3 and fa-v5
 * are both filed under FA and hold different files.
 *
 * Iterating the catalogue rather than the example folders is what makes that possible. It also means an app with
 * no examples at all still gets an entry, and that an app's subforms are its own rather than those of whichever
 * app happened to claim its data type first.
 *
 * Nothing here throws. An app whose examples could not be fetched gets an entry carrying the reason, so the
 * dashboard can say "could not be fetched" where it would otherwise say nothing at all and look like "none".
 *
 * @async
 * @function
 * @returns {Promise<ExampleDataEntry[]>} One entry per tracked app, plus one per subform they declare.
 */
export async function getJsonExampleData() {
    let testmotorApps = null;
    let testmotorError = null;
    try {
        testmotorApps = await fetchTestmotorApps();
    } catch (error) {
        // One report for the run, rather than the same message repeated under all 25 apps. The apps carry it too,
        // because that is the copy the dashboard can put next to the picker that has nothing in it.
        testmotorError = error.message;
        log.error({ scope: "testmotor", category: "Testmotor not reached", detail: error.message });
    }

    const sources = { testmotorApps, testmotorError };
    const subformDataTypes = subformDataTypesPerApp(altinnStudioApps);

    // Each app's entries are collected together — its main form alongside the subforms assigned to it, since subforms
    // carry their own schemas and their own files and are worth having even when the main form examples could not be
    // had — and the apps are flattened in catalogue order afterwards. Running them together therefore changes how long
    // this takes and nothing about what comes out of it.
    const entriesPerApp = await Promise.all(
        altinnStudioApps.map((app, index) =>
            limitExampleDataApp(() =>
                Promise.all([
                    mainFormExampleEntry(app, sources),
                    ...subformDataTypes[index].map((dataType) => subformExampleEntry(app, dataType))
                ])
            )
        )
    );

    return entriesPerApp.flat().filter((entry) => entry !== null);
}
