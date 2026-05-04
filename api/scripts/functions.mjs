// Dependencies
import { JSDOM } from "jsdom";
import fs from "node:fs";

// Data
import altinnStudioApps from "../data/altinnStudioApps.mjs";
import packageSources from "../data/packageSources.mjs";
import subforms from "../data/subforms.mjs";

// Utils
import { convertXmlToJson } from "../utils/xmlToJsonConverter.mjs";

const defaultTextResourcesFilePath = "node_modules/@arkitektum/altinn-studio-custom-components/dist/resources.json";
const defaultTextResources = JSON.parse(fs.readFileSync(defaultTextResourcesFilePath, "utf8"));
const resourceValueLanguages = ["nb", "nn"];

/**
 * Fetches the latest version of a package from the npm registry.
 *
 * @param {string} packageName - The name of the npm package to fetch the latest version for.
 * @returns {Promise<string|null>} The latest version of the package, or null if it cannot be fetched.
 */
async function fetchLatestVersionFromNpm(packageName) {
    try {
        const encodedName = packageName.replace("/", "%2F");
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
        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
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
        if (source.type === "npm") {
            const version = await fetchLatestVersionFromNpm(source.package);
            return { [key]: version };
        } else if (source.type === "github") {
            const version = await fetchLatestVersionFromGithub(source.repo);
            return { [key]: version };
        }
        return { [key]: null };
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
 * @returns {Promise<string>} The content of the requested file as a string.
 * @throws {Error} If the fetch operation fails or the response is not OK.
 */
async function fetchGiteaFileContent(appOwner, appName, filePath) {
    const url = `https://altinn.studio/repos/${appOwner}/${appName}/raw/branch/master/${filePath}`;
    const token = process.env.GITEA_TOKEN;
    const options = {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`
        }
    };
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`⚠️ Failed to fetch file content from ${url}`);
        }
        const content = await response.text();
        return content;
    } catch (error) {
        if (error.message.includes("404")) {
            console.warn(`⚠️ File not found at ${url}, returning null.`);
            return null;
        }
        console.error(`⚠️ Error fetching file content from ${url}`);
        throw error;
    }
}

/**
 * Fetches the display layout JSON from an Altinn Studio app repository.
 *
 * @async
 * @function
 * @param {string} appOwner - The owner of the application repository.
 * @param {string} appName - The name of the application repository.
 * @returns {Promise<Object>} The parsed JSON content of the display layout.
 * @throws {Error} If fetching or parsing the display layout fails.
 */
async function fetchDisplayLayoutFromAltinnStudio(appOwner, appName) {
    const filePath = "App/ui/form/layouts/DisplayLayout.json";
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
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath);
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
            throw new Error(`⛔️ No layout found for subform ${subFormDataType} in ${appOwner}/${appName}`);
        }
        return subLayout;
    } catch {
        console.error(`⛔️ Error fetching layout for subform ${subFormDataType} in ${appOwner}/${appName}:`);
        return null;
    }
}

/**
 * Fetches the display layouts for all Altinn Studio apps and their associated subforms, and returns them as an array of layout objects.
 *
 * This function iterates over the list of Altinn Studio apps, fetches the main display layout for each app, and if the app has associated subforms,
 * it also fetches the display layouts for those subforms. The resulting array contains layout objects for both main forms and subforms, each including
 * the app owner, app name, data type, layout, and any associated subforms.
 *
 * @async
 * @function
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of display layout objects for all Altinn Studio apps and their subforms.
 * @throws {Error} If fetching or parsing any of the display layouts fails.
 */
export async function getDisplayLayouts() {
    const layoutPromises = altinnStudioApps.map(({ appOwner, appName, dataType, subForms }) =>
        fetchDisplayLayoutFromAltinnStudio(appOwner, appName)
            .then(async (layout) => {
                if (!layout) {
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
                    layout,
                    subForms
                };
            })
            .catch(() => {
                console.error(`⛔️ Error fetching layout for ${appOwner}/${appName}:`);
                return null;
            })
    );
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
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath);
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
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath);
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
 * @param {string} language - The language code for which to fetch resource values (e.g., 'en', 'nb').
 * @returns {Promise<Array<{ appOwner: string, appName: string, resourceValues: any }>>}
 *   A promise that resolves to an array of resource value objects for each app.
 */
export async function getAppResourceValues() {
    const appResourcePromises = altinnStudioApps.map(async ({ appOwner, appName }) => {
        try {
            const resourceFiles = await Promise.all(
                resourceValueLanguages.map((lang) =>
                    fetchAppResourceFile(appOwner, appName, lang)
                        .then((file) => ({ language: lang, resources: file.resources }))
                        .catch(() => {
                            return null;
                        })
                )
            );

            const validResourceFiles = resourceFiles.filter((file) => file !== null);

            if (validResourceFiles.length === 0) {
                console.warn(`⛔️ No valid resource files found for ${appOwner}/${appName}. Skipping this app.`);
                return null;
            }

            const resourceValues = mergeResourceFiles(...validResourceFiles);

            return {
                appOwner,
                appName,
                resourceValues
            };
        } catch {
            console.error(`⛔️ Error fetching resource values for ${appOwner}/${appName}`);
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
    try {
        return defaultTextResources;
    } catch {
        console.error("⛔️ Error reading default text resources:");
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
 * @throws {Error} If the altinn-studio-custom-components package is not found in the package-lock.json.
 */
function extractAltinnStudioCustomComponentsVersion(packageLock) {
    const dependencies = packageLock?.packages || {};
    const altinnStudioCustomComponents = dependencies?.["node_modules/@arkitektum/altinn-studio-custom-components"];
    if (altinnStudioCustomComponents?.version) {
        return altinnStudioCustomComponents.version;
    }
    throw new Error("altinn-studio-custom-components not found in package-lock.json");
}

/**
 * Extracts the versions of the altinn-app-frontend CSS and JS files referenced in the given HTML string.
 * @param {string} htmlString - The HTML content of the Index.cshtml file.
 * @returns {Object} An object containing the extracted CSS and JS versions.
 */
function extractAltinnAppFrontendVersions(htmlString) {
    const dom = new JSDOM(htmlString);
    const doc = dom.window.document;

    const result = {
        css: new Set(),
        js: doc?.querySelector("meta[data-altinn-app-frontend-version]")?.dataset?.altinnAppFrontendVersion || null
    };

    const cssRegex = /altinn-app-frontend\/([^/]+)\/altinn-app-frontend\.css$/;

    doc.querySelectorAll('link[rel="stylesheet"][href]').forEach((link) => {
        const match = link.href.match(cssRegex);
        if (match) {
            result.css.add(match[1]);
        }
    });

    return {
        css: result.css.size > 0 ? Array.from(result.css)[0] : null,
        js: result.js
    };
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
            return {
                appOwner,
                appName,
                packageVersions: {
                    altinnStudioCustomComponents: altinnStudioCustomComponentsVersion,
                    altinnAppFrontendCSS: altinnAppFrontendVersions.css,
                    altinnAppFrontendJS: altinnAppFrontendVersions.js
                }
            };
        } catch {
            console.error(`⛔️ Error fetching package versions for ${appOwner}/${appName}`);
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
 * Fetches the XML schema (XSD) file content for a given data type from an Altinn Studio app repository.
 *
 * @async
 * @param {string} appOwner - The owner of the Altinn Studio app.
 * @param {string} appName - The name of the Altinn Studio app.
 * @param {string} dataType - The data type whose XML schema should be fetched.
 * @returns {Promise<string>} The content of the XML schema file as a string.
 */
async function fetchXmlSchemaFromAltinnStudio(appOwner, appName, dataType) {
    const filePath = `App/models/${dataType}.xsd`;
    const fileContent = await fetchGiteaFileContent(appOwner, appName, filePath);
    return fileContent;
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
            return {
                appOwner,
                appName,
                metadata
            };
        } catch {
            console.error(`⛔️ Error fetching application metadata for ${appOwner}/${appName}`);
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
    const files = fs.readdirSync(folderPath, { withFileTypes: true }).filter((dirent) => dirent.isFile() && dirent.name.endsWith(".xml"));
    const { appOwner, appName } = getAppOwnerAndNameFromDataType(dataType);
    if (!appOwner || !appName) {
        console.warn(`⛔️ No app owner or app name found for data type: ${dataType}. Skipping folder: ${folderPath}`);
        return;
    }
    const xmlSchema = await fetchXmlSchemaFromAltinnStudio(appOwner, appName, dataType);

    for (const file of files) {
        const filePath = `${folderPath}/${file.name}`;
        const content = fs.readFileSync(filePath, "utf8");
        const existing = result.find((r) => r.dataType === dataType);
        console.log(`📄 Processing XML: ${appOwner}/${appName} - ${dataType} (${file.name})`);
        if (existing) {
            existing.data[file.name] = convertXmlToJson(content, xmlSchema);
        } else {
            result.push({ dataType, data: { [file.name]: convertXmlToJson(content, xmlSchema) } });
        }
    }

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
        if (fs.existsSync(subFormFolderPath)) {
            const subFormFiles = fs.readdirSync(subFormFolderPath, { withFileTypes: true }).filter((dirent) => dirent.isFile());
            const subXmlSchema = await fetchXmlSchemaFromAltinnStudio(appOwner, appName, subFormDataType);
            for (const subFormFile of subFormFiles) {
                const subFormFilePath = `${subFormFolderPath}/${subFormFile.name}`;
                const subFormContent = fs.readFileSync(subFormFilePath, "utf8");
                const existing = result.find((r) => r.dataType === subFormDataType);
                console.log(`📄 Processing XML: ${appOwner}/${appName} - ${subFormDataType} (${subFormFile.name})`);
                if (existing) {
                    existing.data[subFormFile.name] = convertXmlToJson(subFormContent, subXmlSchema);
                } else {
                    result.push({ dataType: subFormDataType, data: { [subFormFile.name]: convertXmlToJson(subFormContent, subXmlSchema) } });
                }
            }
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
    const formsExampleDataDir = "./api/data/exampleData/forms";
    const subformsExampleDataDir = "./api/data/exampleData/subforms";
    const formsFolders = fs.readdirSync(formsExampleDataDir, { withFileTypes: true }).filter((dirent) => dirent.isDirectory());

    const result = [];

    for (const folder of formsFolders) {
        const dataType = folder.name;
        const folderPath = `${formsExampleDataDir}/${dataType}`;
        await readExampleFilesForDataType(dataType, folderPath, result, subformsExampleDataDir);
    }

    return result;
}
