import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
    PackageVersionNotFoundError,
    createPackageFileStore,
    fetchPackageFiles,
    isPackageVersion,
    isServedPackageFile,
    packageFileContentType,
    readTarFiles
} from "./packageFiles.mjs";

/**
 * Builds a tar archive the way npm packs one: a 512-byte header per entry, the content padded to 512, two empty blocks
 * at the end. A name longer than 100 characters is split into the ustar prefix.
 */
function makeTar(entries) {
    const blocks = [];
    for (const { name, content = "", type = "0" } of entries) {
        const body = Buffer.from(content);
        const header = Buffer.alloc(512);
        const [prefix, base] = name.length > 100 ? [name.slice(0, name.lastIndexOf("/")), name.slice(name.lastIndexOf("/") + 1)] : ["", name];
        header.write(base, 0, "utf8");
        header.write("0000644\0", 100);
        header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
        header.write(type, 156);
        header.write("ustar\0", 257);
        header.write("00", 263);
        header.write(prefix, 345);
        blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

function integrityOf(bytes) {
    return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

const tarball = gzipSync(
    makeTar([
        { name: "package/package.json", content: "{}" },
        { name: "package/dist/", type: "5" },
        { name: "package/dist/main.js", content: "console.log('old');" },
        { name: "package/dist/main.css", content: "body{}" },
        { name: "package/dist/resource.nb.json", content: '{"resources":[]}' },
        { name: "package/dist/426ca03d8326dfb4cbd7.woff2", content: "font" },
        { name: "package/dist/layout.schema.json", content: "{}" },
        { name: "package/dist/nested/main.js", content: "not this one" }
    ])
);
const tarballUrl = "https://registry.npmjs.org/@arkitektum/altinn-studio-custom-components/-/altinn-studio-custom-components-17.0.0.tgz";

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** Answers the registry's metadata and tarball requests, and records the urls asked for. */
function stubRegistry({
    metadataStatus = 200,
    dist = { tarball: tarballUrl, integrity: integrityOf(tarball) },
    tarballBytes = tarball,
    tarballHeaders = {}
} = {}) {
    const urls = [];
    globalThis.fetch = async (url) => {
        urls.push(String(url));
        if (String(url) === tarballUrl) {
            return new Response(tarballBytes, { status: 200, headers: tarballHeaders });
        }
        return new Response(JSON.stringify({ name: "@arkitektum/altinn-studio-custom-components", version: "17.0.0", dist }), {
            status: metadataStatus
        });
    };
    return urls;
}

describe("isPackageVersion", () => {
    it("accepts full version numbers, with or without a pre-release", () => {
        for (const version of ["17.0.0", "0.1.12", "18.0.0-beta.1"]) assert.equal(isPackageVersion(version), true, version);
    });
    it("refuses ranges, tags and anything that could reach another path", () => {
        for (const version of ["^17.0.0", "latest", "17.0", "17.0.0/../x", "", "17.0.0 "]) assert.equal(isPackageVersion(version), false, version);
    });
});

describe("isServedPackageFile", () => {
    it("serves the bundle, its styles, the nb text resources and hashed fonts", () => {
        for (const name of ["main.js", "main.css", "resource.nb.json", "426ca03d8326dfb4cbd7.woff2"])
            assert.equal(isServedPackageFile(name), true, name);
    });
    it("serves nothing else", () => {
        for (const name of ["resources.json", "layout.schema.json", "main.js.map", "../main.js", "x.woff2", "package.json"]) {
            assert.equal(isServedPackageFile(name), false, name);
        }
    });
});

describe("readTarFiles", () => {
    it("reads each regular file with its content, and skips directories", () => {
        const files = readTarFiles(
            makeTar([
                { name: "package/", type: "5" },
                { name: "package/a.txt", content: "a".repeat(700) },
                { name: "package/b.txt", content: "b" }
            ])
        );
        assert.deepEqual([...files.keys()], ["package/a.txt", "package/b.txt"]);
        assert.equal(files.get("package/a.txt").toString(), "a".repeat(700));
        assert.equal(files.get("package/b.txt").toString(), "b");
    });
    it("joins a long name's ustar prefix to it", () => {
        const name = `package/${"d".repeat(120)}/file.txt`;
        assert.deepEqual([...readTarFiles(makeTar([{ name, content: "x" }])).keys()], [name]);
    });
    it("reads nothing from an empty archive", () => {
        assert.equal(readTarFiles(Buffer.alloc(1024)).size, 0);
    });
});

describe("fetchPackageFiles", () => {
    it("keeps the served files from dist, read from the tarball npm names for the version", async () => {
        const urls = stubRegistry();
        const files = await fetchPackageFiles("17.0.0");
        assert.deepEqual(urls, ["https://registry.npmjs.org/@arkitektum%2Faltinn-studio-custom-components/17.0.0", tarballUrl]);
        assert.deepEqual([...files.keys()].sort(), ["426ca03d8326dfb4cbd7.woff2", "main.css", "main.js", "resource.nb.json"]);
        assert.equal(files.get("main.js").toString(), "console.log('old');");
    });
    it("refuses a tarball that does not match the integrity npm publishes", async () => {
        stubRegistry({ dist: { tarball: tarballUrl, integrity: integrityOf(Buffer.from("something else")) } });
        await assert.rejects(fetchPackageFiles("17.0.0"), /does not match the integrity/);
    });
    it("refuses a tarball that is not on the npm registry", async () => {
        const urls = stubRegistry({ dist: { tarball: "https://example.com/x.tgz", integrity: integrityOf(tarball) } });
        await assert.rejects(fetchPackageFiles("17.0.0"), /no tarball on https:\/\/registry\.npmjs\.org\//);
        assert.equal(urls.length, 1);
    });
    it("refuses a version without a sha512 integrity", async () => {
        stubRegistry({ dist: { tarball: tarballUrl, integrity: "sha1-abc" } });
        await assert.rejects(fetchPackageFiles("17.0.0"), /no sha512 integrity/);
    });
    it("says when npm has no such version", async () => {
        stubRegistry({ metadataStatus: 404 });
        await assert.rejects(fetchPackageFiles("0.0.1"), PackageVersionNotFoundError);
    });
    it("fails, without saying the version is missing, when npm answers with an error", async () => {
        stubRegistry({ metadataStatus: 503 });
        await assert.rejects(
            fetchPackageFiles("17.0.0"),
            (error) => !(error instanceof PackageVersionNotFoundError) && /answered 503/.test(error.message)
        );
    });
    it("refuses a tarball larger than the limit before reading it", async () => {
        stubRegistry({ tarballHeaders: { "content-length": String(11 * 1024 * 1024) } });
        await assert.rejects(fetchPackageFiles("17.0.0"), { name: "BodyTooLargeError" });
    });
});

describe("createPackageFileStore", () => {
    const filesFor = (version) => new Map([["main.js", Buffer.from(`version ${version}`)]]);

    it("downloads a version once, also when asked again before the download is done", async () => {
        const asked = [];
        const store = createPackageFileStore({
            fetchFiles: async (version) => {
                asked.push(version);
                return filesFor(version);
            }
        });
        const [first, second] = await Promise.all([store.getFile("1.0.0", "main.js"), store.getFile("1.0.0", "main.js")]);
        await store.getFile("1.0.0", "main.js");
        assert.deepEqual(asked, ["1.0.0"]);
        assert.equal(first.toString(), "version 1.0.0");
        assert.equal(second.toString(), "version 1.0.0");
    });
    it("answers undefined for a file the version does not have", async () => {
        const store = createPackageFileStore({ fetchFiles: async (version) => filesFor(version) });
        assert.equal(await store.getFile("1.0.0", "main.css"), undefined);
    });
    it("lets the version asked for longest ago go first when it keeps too many", async () => {
        const asked = [];
        const store = createPackageFileStore({
            maxVersions: 2,
            fetchFiles: async (version) => {
                asked.push(version);
                return filesFor(version);
            }
        });
        await store.getFile("1.0.0", "main.js");
        await store.getFile("2.0.0", "main.js");
        await store.getFile("1.0.0", "main.js");
        await store.getFile("3.0.0", "main.js");
        await store.getFile("1.0.0", "main.js");
        await store.getFile("2.0.0", "main.js");
        assert.deepEqual(asked, ["1.0.0", "2.0.0", "3.0.0", "2.0.0"]);
    });
    it("tries a failed download again on the next request", async () => {
        let attempts = 0;
        const store = createPackageFileStore({
            fetchFiles: async (version) => {
                attempts++;
                if (attempts === 1) throw new Error("npm had a bad moment");
                return filesFor(version);
            }
        });
        await assert.rejects(store.getFile("1.0.0", "main.js"), /bad moment/);
        assert.equal((await store.getFile("1.0.0", "main.js")).toString(), "version 1.0.0");
        assert.equal(attempts, 2);
    });
});

describe("packageFileContentType", () => {
    it("names the type of each served kind of file", () => {
        assert.equal(packageFileContentType("main.js"), "text/javascript; charset=utf-8");
        assert.equal(packageFileContentType("main.css"), "text/css; charset=utf-8");
        assert.equal(packageFileContentType("resource.nb.json"), "application/json; charset=utf-8");
        assert.equal(packageFileContentType("426ca03d8326dfb4cbd7.woff2"), "font/woff2");
    });
});
