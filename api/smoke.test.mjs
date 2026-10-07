import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

const SERVER_ENTRY = fileURLToPath(new URL("./index.mjs", import.meta.url));
const TEST_PORT = 9099;
const BOOT_TIMEOUT_MS = 20000;
// Address the loopback interface directly: "localhost" resolves differently across setups (and to a non-loopback
// address inside some containers), which fails the request for reasons that have nothing to do with the server.
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

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

/**
 * Stops the server and waits for it to be gone, so the next test does not find the port still held.
 */
function stopServer(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
    });
}

test("server boots and accepts HTTP connections", async () => {
    const child = await startServer();
    try {
        // Any HTTP response (even a 404 for an unknown route) proves the server booted and is accepting connections.
        const response = await fetch(`${BASE_URL}/__smoke__`);
        assert.equal(typeof response.status, "number");
    } finally {
        await stopServer(child);
    }
});

test("serves diagnostics for a server that has not run anything yet", async () => {
    const child = await startServer();
    try {
        // The only endpoint that needs neither Altinn Studio nor the native XML module, so it is the one route whose
        // response this test can assert on. A freshly booted server has nothing retained yet.
        const response = await fetch(`${BASE_URL}/api/diagnostics`);
        assert.equal(response.status, 200);

        const body = await response.json();
        assert.deepEqual(body.totals, { ok: 0, warn: 0, error: 0 });
        assert.deepEqual(body.runs, []);
        assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
        await stopServer(child);
    }
});

test("exits with an error, rather than claiming to listen, when the port is taken", async (t) => {
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(TEST_PORT, "127.0.0.1", resolve));
    t.after(() => blocker.close());

    const child = spawn(process.execPath, [SERVER_ENTRY], {
        env: { ...process.env, API_PORT: String(TEST_PORT), GITEA_TOKEN: "smoke-test-token" },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), BOOT_TIMEOUT_MS);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(timer);

    assert.equal(code, 1, output);
    assert.doesNotMatch(output, /listening on port/);
    assert.match(output, /could not listen on 127\.0\.0\.1:9099: .*EADDRINUSE/);
});
