import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

const SERVER_ENTRY = fileURLToPath(new URL("./index.mjs", import.meta.url));
const TEST_PORT = 9099;
const BOOT_TIMEOUT_MS = 20000;

/**
 * Starts the API server as a child process and resolves once it logs that it is listening.
 * Rejects if the process exits early or does not come up within the timeout.
 */
function startServer() {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
        env: { ...process.env, API_PORT: String(TEST_PORT), GITEA_TOKEN: "smoke-test-token" },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`Server did not start within ${BOOT_TIMEOUT_MS}ms. Output:\n${output}`));
        }, BOOT_TIMEOUT_MS);

        const onData = (chunk) => {
            output += chunk.toString();
            if (output.includes(`listening on port ${TEST_PORT}`)) {
                clearTimeout(timer);
                resolve(child);
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);

        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Server exited early with code ${code} before listening. Output:\n${output}`));
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

test("server boots and accepts HTTP connections", async () => {
    const child = await startServer();
    try {
        // Any HTTP response (even a 404 for an unknown route) proves the server booted and is accepting connections.
        const response = await fetch(`http://localhost:${TEST_PORT}/__smoke__`);
        assert.equal(typeof response.status, "number");
    } finally {
        child.kill("SIGTERM");
    }
});
