// Dependencies
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

// Data
import altinnStudioApps from "../data/altinnStudioApps.mjs";
import packageSources from "../data/packageSources.mjs";
import subforms from "../data/subforms.mjs";

// Utils
import { convertXmlToJson } from "../utils/xmlToJsonConverter.mjs";
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
 * Retrieves the app owner and app name for a given data type.
 *
 * Searches through the `altinnStudioApps` array for an app matching the provided `dataType`.
 * If not found, searches the `subforms` array for a subform matching the `dataType`.
 * Returns an object containing `appOwner` and `appName` if a match is found.
 * Throws an error if no matching app or subform is found.
 *
 * @param {string} dataType - The data type to search for.
 * @returns {{ appOwner: string, appName: string }} The app owner and app name associated with the data type.
 * @throws {Error} If no app or subform is found for the given data type.
 */
function getAppOwnerAndNameFromDataType(dataType) {
    const app = altinnStudioApps.find((app) => app.dataType === dataType);
    if (app) {
        return { appOwner: app.appOwner, appName: app.appName };
    }
    const subform = subforms.find((sub) => sub.dataType === dataType);
    if (subform) {
        return { appOwner: subform.appOwner, appName: subform.appName };
    }
    return { appOwner: null, appName: null };
}

/**
 * Retrieves the subforms associated with a given data type from the altinnStudioApps collection.
 *
 * @param {string} dataType - The data type to search for in the altinnStudioApps array.
 * @returns {Array} An array of subforms if found; otherwise, an empty array.
 */
function getSubformsFromDataType(dataType) {
    const app = altinnStudioApps.find((app) => app.dataType === dataType);
    if (app?.subForms) {
        return app.subForms;
    }
    return [];
}

/**
 * Reads one example XML file, converts it to JSON and adds it to the result array under its data type.
 *
 * A failure is recorded and swallowed rather than thrown: one example that no longer validates against its schema
 * should cost that one file, not the rest of its folder and not the folder's subforms.
 *
 * @async
 * @param {Object} params
 * @param {string} params.dataType - The data type the file belongs to.
 * @param {string} params.appOwner - The owner of the Altinn Studio application.
 * @param {string} params.appName - The name of the Altinn Studio application.
 * @param {string} params.folderPath - The folder holding the example file.
 * @param {string} params.fileName - The name of the example file.
 * @param {string} params.xmlSchema - The XSD to validate the file against.
 * @param {Array<Object>} params.result - The array to add the converted data to.
 * @returns {Promise<void>} Resolves once the file has been added or its failure recorded.
 */
async function addExampleFile({ dataType, appOwner, appName, folderPath, fileName, xmlSchema, result }) {
    const scope = `${appOwner}/${appName}`;
    try {
        const content = await fs.readFile(`${folderPath}/${fileName}`, "utf8");
        log.progress(`📄 Processing XML: ${scope} - ${dataType} (${fileName})`);
        // Convert before touching `result`, so a failed file never leaves a half-populated entry behind.
        const data = convertXmlToJson(content, xmlSchema);
        const existing = result.find((r) => r.dataType === dataType);
        if (existing) {
            existing.data[fileName] = data;
        } else {
            result.push({ dataType, data: { [fileName]: data } });
        }
        log.ok({ scope, category: "Example data", message: `${dataType} (${fileName})` });
    } catch (error) {
        log.error({ scope, category: "Example file skipped", message: `${dataType} (${fileName})`, detail: error.message });
    }
}

/**
 * Reads example files for a given data type from a specified folder, converts their XML content to JSON using the corresponding XML schema,
 * and adds the results to the provided result array. Also handles subforms by delegating to the handleSubForms function.
 *
 * @async
 * @param {string} dataType - The data type identifier to process.
 * @param {string} folderPath - The path to the folder containing example files.
 * @param {Array<Object>} result - The array to which the processed data will be added.
 * @param {string} subformsExampleDataDir - The directory containing example data for subforms.
 * @returns {Promise<void>} Resolves when all files and subforms have been processed.
 */
async function readExampleFilesForDataType(dataType, folderPath, result, subformsExampleDataDir) {
    const files = (await fs.readdir(folderPath, { withFileTypes: true })).filter((dirent) => dirent.isFile() && dirent.name.endsWith(".xml"));
    const { appOwner, appName } = getAppOwnerAndNameFromDataType(dataType);
    if (!appOwner || !appName) {
        log.warn({
            scope: dataType,
            category: "Folder skipped — data type not tracked",
            message: path.relative(repoRoot, folderPath),
            detail: "No app in altinnStudioApps.mjs or subforms.mjs declares this data type."
        });
        return;
    }
    const xmlSchema = await fetchXmlSchemaFromAltinnStudio(appOwner, appName, dataType);

    if (xmlSchema) {
        for (const file of files) {
            await addExampleFile({ dataType, appOwner, appName, folderPath, fileName: file.name, xmlSchema, result });
        }
    } else {
        log.error({
            scope: `${appOwner}/${appName}`,
            category: "Schema not found — example files skipped",
            message: xmlSchemaFilePath(dataType),
            detail: `${files.length} example file${files.length === 1 ? "" : "s"} could not be validated.`
        });
    }

    // Subforms carry their own schemas, so they are still worth processing even when this data type has none.
    await handleSubForms(dataType, appOwner, appName, result, subformsExampleDataDir);
}

/**
 * Processes subforms for a given data type by reading example data files from the specified directory,
 * converting their XML content to JSON, and updating the result array accordingly.
 *
 * @async
 * @param {string} dataType - The main data type to process subforms for.
 * @param {string} appOwner - The owner of the Altinn Studio application.
 * @param {string} appName - The name of the Altinn Studio application.
 * @param {Array<Object>} result - The array to update with subform data. Each object should have a `dataType` and `data` property.
 * @param {string} subformsExampleDataDir - The directory path containing example data for subforms.
 * @returns {Promise<void>} Resolves when all subforms have been processed and the result array is updated.
 */
async function handleSubForms(dataType, appOwner, appName, result, subformsExampleDataDir) {
    const subForms = getSubformsFromDataType(dataType);
    for (const subForm of subForms) {
        const subFormDataType = subForm.dataType;
        const subFormFolderPath = `${subformsExampleDataDir}/${subFormDataType}`;
        const existingSubForm = result.find((r) => r.dataType === subFormDataType);
        if (existingSubForm) {
            continue;
        }
        let subFormFiles;
        try {
            subFormFiles = (await fs.readdir(subFormFolderPath, { withFileTypes: true })).filter((dirent) => dirent.isFile());
        } catch (error) {
            // Missing subform example folder is expected — skip it. Re-throw anything else.
            if (error.code === "ENOENT") {
                continue;
            }
            throw error;
        }
        const subXmlSchema = await fetchXmlSchemaFromAltinnStudio(appOwner, appName, subFormDataType);
        if (!subXmlSchema) {
            log.error({
                scope: `${appOwner}/${appName}`,
                category: "Schema not found — example files skipped",
                message: xmlSchemaFilePath(subFormDataType),
                detail: `${subFormFiles.length} subform example file${subFormFiles.length === 1 ? "" : "s"} could not be validated.`
            });
            continue;
        }
        for (const subFormFile of subFormFiles) {
            await addExampleFile({
                dataType: subFormDataType,
                appOwner,
                appName,
                folderPath: subFormFolderPath,
                fileName: subFormFile.name,
                xmlSchema: subXmlSchema,
                result
            });
        }
    }
}

/**
 * Asynchronously retrieves example JSON data for forms and subforms.
 *
 * Reads directories containing example data for forms and subforms,
 * processes each data type folder, and aggregates the results.
 *
 * @async
 * @function
 * @returns {Promise<Array>} A promise that resolves to an array containing the aggregated example data.
 */
export async function getJsonExampleData() {
    const formsExampleDataDir = path.join(repoRoot, "api/data/exampleData/forms");
    const subformsExampleDataDir = path.join(repoRoot, "api/data/exampleData/subforms");
    const formsFolders = (await fs.readdir(formsExampleDataDir, { withFileTypes: true })).filter((dirent) => dirent.isDirectory());

    const result = [];

    for (const folder of formsFolders) {
        const dataType = folder.name;
        const folderPath = `${formsExampleDataDir}/${dataType}`;
        try {
            await readExampleFilesForDataType(dataType, folderPath, result, subformsExampleDataDir);
        } catch (error) {
            // Individual example files are handled by addExampleFile, so this is the backstop for what fails for the
            // folder as a whole — an unreadable directory, or a schema that can't be fetched from Altinn Studio.
            const { appOwner, appName } = getAppOwnerAndNameFromDataType(dataType);
            log.error({
                scope: appOwner && appName ? `${appOwner}/${appName}` : dataType,
                category: "Example data folder not processed",
                message: dataType,
                detail: error.message
            });
        }
    }

    return result;
}
