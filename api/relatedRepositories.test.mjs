import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Checks this repository's row in the "Related repositories" table against package.json: the name it is published as, and the @arkitektum packages it depends on. The same table is in all seven repositories, and each checks its own row.
 */
const REPOSITORY = "altinn-studio-custom-components-api";
const DOCUMENT = "ARCHITECTURE.md";

const markdown = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifests = [manifest];

/**
 * The cells of the given repository's row, keyed by column heading, and the repositories the table lists.
 *
 * @param {string} text - The markdown holding the table.
 * @param {string} repository - The repository whose row to read.
 * @returns {{ row: Record<string, string>, repositories: string[] }}
 */
function relatedRepositoriesTable(text, repository) {
    const section = text.split(/^## (?:\d+\. )?Related repositories$/m)[1]?.split(/^## /m)[0] ?? "";
    const rows = section
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .map((line) =>
            line
                .split("|")
                .slice(1, -1)
                .map((cell) => cell.trim())
        );
    const [header = [], , ...body] = rows;
    const cells = body.find((row) => row[0] === `\`${repository}\``) ?? [];
    return {
        row: Object.fromEntries(header.map((heading, index) => [heading, cells[index] ?? ""])),
        repositories: body.map((row) => namesIn(row[0] ?? "")[0] ?? "")
    };
}

/**
 * The names written in backticks in a table cell.
 *
 * @param {string} cell - The cell's text.
 * @returns {string[]}
 */
function namesIn(cell) {
    return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/**
 * The @arkitektum packages the package.json files depend on, as the table names them: by repository when the table lists one, else by package name.
 *
 * @param {Object[]} packageFiles - The parsed package.json files.
 * @param {string[]} repositories - The repositories the table lists.
 * @returns {string[]}
 */
function arkitektumDependencies(packageFiles, repositories) {
    const names = packageFiles.flatMap((file) => Object.keys({ ...file.dependencies, ...file.devDependencies, ...file.peerDependencies }));
    const scope = "@arkitektum/";
    const documented = names
        .filter((name) => name.startsWith(scope))
        .map((name) => (repositories.includes(name.slice(scope.length)) ? name.slice(scope.length) : name));
    return [...new Set(documented)].sort();
}

describe("the Related repositories table", () => {
    const { row, repositories } = relatedRepositoriesTable(markdown, REPOSITORY);

    it("has a row for this repository", () => {
        assert.equal(row["Repository"], `\`${REPOSITORY}\``, `no row for ${REPOSITORY} under "Related repositories" in ${DOCUMENT}`);
    });

    it("names the package this repository publishes", () => {
        if (manifest.name.startsWith("@arkitektum/")) {
            assert.equal(row["Published as"], `\`${manifest.name}\``);
        } else {
            assert.match(row["Published as"] ?? "", /^Not published/);
        }
    });

    it("lists the @arkitektum packages this repository depends on", () => {
        assert.deepEqual(namesIn(row["Depends on"] ?? "").sort(), arkitektumDependencies(manifests, repositories));
    });
});
