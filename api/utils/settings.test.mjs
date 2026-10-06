import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CACHE_TTL_MS, DEFAULT_REQUEST_TIMEOUT_MS, cacheTtlMs, requestTimeoutMs } from "./settings.mjs";

/** Sets one environment variable for one test, or removes it for undefined, and puts it back afterwards. */
function withEnv(t, name, value) {
    const original = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    });
}

test("CACHE_TTL_MS is read as a whole number of milliseconds, zero included", (t) => {
    withEnv(t, "CACHE_TTL_MS", "1500");
    assert.equal(cacheTtlMs(), 1500);
    process.env.CACHE_TTL_MS = "0";
    assert.equal(cacheTtlMs(), 0);
});

test("CACHE_TTL_MS falls back to a minute when it is missing, negative or not a number", (t) => {
    withEnv(t, "CACHE_TTL_MS", undefined);
    assert.equal(cacheTtlMs(), DEFAULT_CACHE_TTL_MS);
    assert.equal(DEFAULT_CACHE_TTL_MS, 60_000);
    for (const value of ["-1", "soon", ""]) {
        process.env.CACHE_TTL_MS = value;
        assert.equal(cacheTtlMs(), DEFAULT_CACHE_TTL_MS, `for ${JSON.stringify(value)}`);
    }
});

test("REQUEST_TIMEOUT_MS is read as a whole number of milliseconds", (t) => {
    withEnv(t, "REQUEST_TIMEOUT_MS", "2500");
    assert.equal(requestTimeoutMs(), 2500);
});

test("REQUEST_TIMEOUT_MS falls back to thirty seconds when it is missing, zero, negative or not a number", (t) => {
    // Zero is not "no timeout" here: the point of the setting is that a request cannot wait for ever.
    withEnv(t, "REQUEST_TIMEOUT_MS", undefined);
    assert.equal(requestTimeoutMs(), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30_000);
    for (const value of ["0", "-5", "later", ""]) {
        process.env.REQUEST_TIMEOUT_MS = value;
        assert.equal(requestTimeoutMs(), DEFAULT_REQUEST_TIMEOUT_MS, `for ${JSON.stringify(value)}`);
    }
});
