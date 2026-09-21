// Utils
import { createCachedFunction } from "./cache.mjs";

/**
 * The FtPB testmotor, which is where the main form example data comes from.
 *
 * It serves the copy the DIBK test team maintains out of an Azure file share, and it does one thing on the way out
 * that a file committed here cannot: it stamps the date fields a form cares about with a date ten days ahead, on
 * every request. A ferdigattest example is only valid while its `bekreftelseInnen` and `utfoertInnen` fall inside
 * the next fortnight, and several other form types have a rule of that shape. A committed copy is therefore right
 * on the day it is committed and stale a couple of weeks later, which is the whole reason these examples are read
 * from here rather than kept in `api/data/exampleData/forms`.
 *
 * Two endpoints are used, both open, neither carrying a token:
 *
 *     GET {TESTMOTOR_URL}/api/altinn-app     the apps it holds data for, and each one's main form data type
 *     GET {TESTMOTOR_URL}/api/xml/{appId}    that app's example files, contents and all
 *
 * There is a third, `GET /api/altinn-app/{appId}`, which answers the same files alongside parties, metadata and
 * attachments. It is deliberately not used: it makes Altinn calls this API has no use for.
 */

/** Where the testmotor lives. Overridable so a test, or a local instance, can be pointed at instead. */
const DEFAULT_TESTMOTOR_URL = "https://app-ftpb-testmotor.azurewebsites.net";

/**
 * How long an answer is reused.
 *
 * Five minutes is how long the testmotor caches its own reads of the Azure share, so asking more often than this
 * mostly re-reads that cache, and the dates it stamps only move from one day to the next. This sits underneath the
 * endpoint-level cache in `index.mjs`, which is shorter and keyed per endpoint; this one is what stops a burst of
 * example-data requests turning into a burst of requests to the testmotor.
 */
const TESTMOTOR_CACHE_TTL_MS = 5 * 60000;

/**
 * @typedef {Object} TestmotorApp
 * @property {string} appId - The app the example data belongs to, e.g. "fa-v5". Without the owner prefix.
 * @property {string} mainFormId - Altinn data type id of the app's main form, e.g. "FA".
 */

/**
 * @typedef {Object} TestmotorXmlFile
 * @property {string} name - The file's bare stem: both the ordering prefix and the extension are already stripped,
 *   so `01_Maksimumsversjon.xml` on the share arrives as `Maksimumsversjon`.
 * @property {string} contents - The XML itself, with its date fields freshly stamped.
 */

/**
 * The base URL, read per call rather than at import time so `dotenv` has run and so a test can move it.
 *
 * @returns {string} The base URL with any trailing slash removed.
 */
function testmotorUrl() {
    const configured = process.env.TESTMOTOR_URL?.trim();
    return (configured || DEFAULT_TESTMOTOR_URL).replace(/\/+$/, "");
}

/**
 * Fetches and parses one testmotor endpoint.
 *
 * Every failure is rethrown naming the URL that failed. The caller surfaces this message to the dashboard, where
 * "could not be reached" has to be distinguishable from "holds nothing for this app" — and a bare `fetch failed`
 * does not tell anyone which host was unreachable.
 *
 * @param {string} path - The path to request, including its leading slash.
 * @returns {Promise<unknown>} The parsed response body.
 * @throws {Error} If the request fails, the response is not ok, or the body is not JSON.
 */
async function getJson(path) {
    const url = `${testmotorUrl()}${path}`;
    let response;
    try {
        response = await fetch(url);
    } catch (error) {
        throw new Error(`${url} could not be reached: ${error.message}`, { cause: error });
    }
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = body ? `: ${body.slice(0, 200)}` : "";
        throw new Error(`${url} answered ${response.status} ${response.statusText}${detail}`);
    }
    try {
        return await response.json();
    } catch (error) {
        throw new Error(`${url} did not answer JSON: ${error.message}`, { cause: error });
    }
}

// Cached rather than the two exported functions, so both endpoints share one policy and the cache key is the path.
// `createCachedFunction` caches the promise rather than the value, which means a page load that asks for the same
// app several times makes one request instead of racing several, and it evicts on rejection, so a moment of the
// host being down cannot outlast the outage by five minutes.
let cachedGetJson = createCachedFunction(getJson, { ttlMs: TESTMOTOR_CACHE_TTL_MS });

/** Forgets everything read so far. Only the tests need this. */
export function clearTestmotorCache() {
    cachedGetJson = createCachedFunction(getJson, { ttlMs: TESTMOTOR_CACHE_TTL_MS });
}

/**
 * The apps the testmotor holds example data for, each with the data type its main form is filed under.
 *
 * Note that `mainFormId` is not unique: `fa-v3` and `fa-v5` are both filed under `FA` and hold different data. The
 * app id is the key that identifies example data; the data type alone does not.
 *
 * @returns {Promise<TestmotorApp[]>} The apps, in the order the testmotor answers them.
 * @throws {Error} If the testmotor could not be reached or did not answer a list.
 */
export async function fetchTestmotorApps() {
    const body = await cachedGetJson("/api/altinn-app");
    if (!Array.isArray(body)) {
        throw new Error(`${testmotorUrl()}/api/altinn-app did not answer a list.`);
    }
    // An entry missing either field cannot be used as a key or filed under a data type, so it is dropped rather
    // than passed on as a half-identified app.
    return body
        .filter((entry) => typeof entry?.appId === "string" && entry.appId !== "" && typeof entry?.mainFormId === "string" && entry.mainFormId !== "")
        .map((entry) => ({ appId: entry.appId, mainFormId: entry.mainFormId }));
}

/**
 * One app's example form files, in the order the testmotor answers them.
 *
 * Deliberately not sorted. The share orders the files by a numeric prefix that has already been stripped by the
 * time they arrive, so sorting the stems would put "Maksimumsversjon" ahead of "Minimumsversjon" by accident
 * rather than by intent. The order they arrive in is the share's own, and the same order the testmotor's own
 * interface offers.
 *
 * @param {string} appId - The app to fetch example files for, e.g. "fa-v5".
 * @returns {Promise<TestmotorXmlFile[]>} The example files. Empty when the testmotor holds none for this app.
 * @throws {Error} If the testmotor could not be reached or did not answer a list.
 */
export async function fetchTestmotorFormXml(appId) {
    const path = `/api/xml/${encodeURIComponent(appId)}`;
    const body = await cachedGetJson(path);
    if (!Array.isArray(body)) {
        throw new Error(`${testmotorUrl()}${path} did not answer a list.`);
    }
    // A file with no name cannot be labelled or selected, and one with no contents has nothing to convert, so
    // neither is worth carrying further.
    return body
        .filter((entry) => typeof entry?.name === "string" && entry.name !== "" && typeof entry?.contents === "string" && entry.contents !== "")
        .map((entry) => ({ name: entry.name, contents: entry.contents }));
}
