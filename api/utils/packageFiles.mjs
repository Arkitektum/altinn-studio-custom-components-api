// Dependencies
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Utils
import { readBoundedBytes, readBoundedJson } from "./boundedBody.mjs";
import { requestTimeoutMs } from "./settings.mjs";

/**
 * The files of a published version of the components package, for the Statistics dashboard's upgrade preview, which
 * draws a form with the version an app has installed beside the local build.
 *
 * A version is read from the npm registry once: its tarball is checked against the integrity the registry publishes for
 * it, and only the few files the preview loads are kept. A published version never changes, so nothing expires; only the
 * number of versions kept is bounded.
 */

export const COMPONENTS_PACKAGE = "@arkitektum/altinn-studio-custom-components";
const REGISTRY = "https://registry.npmjs.org/";

/** The largest tarball read. The package is well under a megabyte. */
export const MAX_TARBALL_BYTES = 10 * 1024 * 1024;

/** How many versions are kept in memory at once. */
export const MAX_VERSIONS_KEPT = 5;

/** Thrown when the registry has no such version, so the endpoint can answer 404 rather than 502. */
export class PackageVersionNotFoundError extends Error {
    /** @param {string} version */
    constructor(version) {
        super(`${COMPONENTS_PACKAGE} has no version ${version} on npm`);
        this.name = "PackageVersionNotFoundError";
    }
}

/**
 * Whether a string is a full version number, such as "17.2.0" or "18.0.0-beta.1". Ranges and tags are not.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function isPackageVersion(version) {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version));
}

/**
 * Whether a file in the package's dist folder is one the preview loads: the bundle, its styles, the default text
 * resources, and the fonts older versions keep beside the styles under a content hash.
 *
 * @param {string} fileName
 * @returns {boolean}
 */
export function isServedPackageFile(fileName) {
    return /^(?:main\.js|main\.css|resource\.nb\.json|[0-9a-f]{20}\.woff2)$/.test(String(fileName));
}

/**
 * Reads the regular files out of an uncompressed tar archive.
 *
 * @param {Buffer} archive - The archive.
 * @returns {Map<string, Buffer>} Each file's content by its path in the archive.
 */
export function readTarFiles(archive) {
    const files = new Map();
    const text = (start, length) => {
        const field = archive.subarray(start, start + length);
        const end = field.indexOf(0);
        return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
    };
    let offset = 0;
    while (offset + 512 <= archive.length) {
        const name = text(offset, 100);
        if (!name) break;
        const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
        const type = text(offset + 156, 1);
        const prefix = text(offset + 257, 6).startsWith("ustar") ? text(offset + 345, 155) : "";
        const start = offset + 512;
        if (type === "" || type === "0") {
            files.set(prefix ? `${prefix}/${name}` : name, Buffer.from(archive.subarray(start, start + size)));
        }
        offset = start + Math.ceil(size / 512) * 512;
    }
    return files;
}

/**
 * Downloads a version of the components package from the npm registry and keeps the files the preview loads.
 *
 * @param {string} version - A full version number.
 * @returns {Promise<Map<string, Buffer>>} The served files from its dist folder, by file name.
 * @throws {PackageVersionNotFoundError} When the registry has no such version.
 * @throws {Error} When the registry cannot be reached, its answer is not what npm answers, or the tarball does not match its integrity.
 */
export async function fetchPackageFiles(version) {
    const metadataUrl = `${REGISTRY}${COMPONENTS_PACKAGE.replaceAll("/", "%2F")}/${encodeURIComponent(version)}`;
    const metadataResponse = await fetch(metadataUrl, { signal: AbortSignal.timeout(requestTimeoutMs()) });
    if (metadataResponse.status === 404) throw new PackageVersionNotFoundError(version);
    if (!metadataResponse.ok) throw new Error(`npm answered ${metadataResponse.status} for ${COMPONENTS_PACKAGE}@${version}`);
    const { tarball, integrity } = (await readBoundedJson(metadataResponse))?.dist ?? {};
    if (typeof tarball !== "string" || !tarball.startsWith(REGISTRY)) {
        throw new Error(`npm gave no tarball on ${REGISTRY} for ${COMPONENTS_PACKAGE}@${version}`);
    }
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
        throw new Error(`npm gave no sha512 integrity for ${COMPONENTS_PACKAGE}@${version}`);
    }
    const tarballResponse = await fetch(tarball, { signal: AbortSignal.timeout(requestTimeoutMs()) });
    if (!tarballResponse.ok) throw new Error(`npm answered ${tarballResponse.status} for the ${COMPONENTS_PACKAGE}@${version} tarball`);
    const compressed = await readBoundedBytes(tarballResponse, MAX_TARBALL_BYTES);
    const digest = `sha512-${createHash("sha512").update(compressed).digest("base64")}`;
    if (digest !== integrity) {
        throw new Error(`the ${COMPONENTS_PACKAGE}@${version} tarball does not match the integrity npm publishes for it`);
    }
    const served = new Map();
    for (const [path, content] of readTarFiles(gunzipSync(compressed, { maxOutputLength: MAX_TARBALL_BYTES * 4 }))) {
        const match = /^package\/dist\/([^/]+)$/.exec(path);
        if (match && isServedPackageFile(match[1])) served.set(match[1], content);
    }
    return served;
}

/**
 * Keeps the files of the versions asked for most recently, fetching a version once even when it is asked for again
 * before the first download has finished. A failed download is not kept, so the next request tries again.
 *
 * @param {Object} [options]
 * @param {number} [options.maxVersions] - How many versions to keep.
 * @param {(version: string) => Promise<Map<string, Buffer>>} [options.fetchFiles] - Downloads a version.
 * @returns {{ getFile: (version: string, fileName: string) => Promise<Buffer|undefined> }} The store.
 */
export function createPackageFileStore({ maxVersions = MAX_VERSIONS_KEPT, fetchFiles = fetchPackageFiles } = {}) {
    const versions = new Map();
    return {
        async getFile(version, fileName) {
            let files = versions.get(version);
            if (files) {
                // Asked for again, so it is the last to go.
                versions.delete(version);
            } else {
                files = fetchFiles(version);
                files.catch(() => versions.delete(version));
            }
            versions.set(version, files);
            while (versions.size > maxVersions) versions.delete(versions.keys().next().value);
            return (await files).get(fileName);
        }
    };
}

/**
 * The content type a served file is answered with.
 *
 * @param {string} fileName
 * @returns {string}
 */
export function packageFileContentType(fileName) {
    if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
    if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
    return "font/woff2";
}
