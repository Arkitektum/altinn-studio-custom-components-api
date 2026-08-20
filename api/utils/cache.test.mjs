import assert from "node:assert/strict";
import { test } from "node:test";

import { createCachedFunction } from "./cache.mjs";

test("returns the cached result for repeated identical calls within the TTL", async () => {
    let calls = 0;
    const cached = createCachedFunction(async (x) => {
        calls++;
        return x * 2;
    });

    assert.equal(await cached(21), 42);
    assert.equal(await cached(21), 42);
    assert.equal(calls, 1);
});

test("keys the cache by arguments", async () => {
    let calls = 0;
    const cached = createCachedFunction(async (x) => {
        calls++;
        return x;
    });

    await cached("a");
    await cached("b");
    await cached("a");
    assert.equal(calls, 2);
});

test("de-duplicates concurrent in-flight calls into a single invocation", async () => {
    let calls = 0;
    const cached = createCachedFunction(async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "done";
    });

    const [a, b] = await Promise.all([cached(), cached()]);
    assert.equal(a, "done");
    assert.equal(b, "done");
    assert.equal(calls, 1);
});

test("does not cache failures — the next call retries", async () => {
    let calls = 0;
    const cached = createCachedFunction(async () => {
        calls++;
        if (calls === 1) {
            throw new Error("boom");
        }
        return "recovered";
    });

    await assert.rejects(() => cached(), /boom/);
    assert.equal(await cached(), "recovered");
    assert.equal(calls, 2);
});

test("de-duplicates concurrent in-flight calls even when the TTL is 0", async () => {
    // Sharing an in-flight call is independent of the TTL: disabling the cache must not let concurrent callers fan
    // out to separate upstream fetches.
    let calls = 0;
    const cached = createCachedFunction(
        async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return "done";
        },
        { ttlMs: 0 }
    );

    const results = await Promise.all([cached(), cached(), cached()]);
    assert.deepEqual(results, ["done", "done", "done"]);
    assert.equal(calls, 1);
});

test("a ttlMs of 0 disables caching across separate calls", async () => {
    let calls = 0;
    const cached = createCachedFunction(
        async () => {
            calls++;
            return calls;
        },
        { ttlMs: 0 }
    );

    assert.equal(await cached(), 1);
    assert.equal(await cached(), 2);
    assert.equal(calls, 2);
});

test("stops sharing a settled result once the TTL has passed", async () => {
    let calls = 0;
    const cached = createCachedFunction(
        async () => {
            calls++;
            return calls;
        },
        { ttlMs: 20 }
    );

    assert.equal(await cached(), 1);
    assert.equal(await cached(), 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await cached(), 2);
    assert.equal(calls, 2);
});

test("does not cache a failure that rejects while callers are still sharing it", async () => {
    let calls = 0;
    const cached = createCachedFunction(
        async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("boom");
        },
        { ttlMs: 0 }
    );

    // Both callers share the one in-flight attempt, and the failure is still not retained afterwards.
    await Promise.all([assert.rejects(() => cached(), /boom/), assert.rejects(() => cached(), /boom/)]);
    assert.equal(calls, 1);
    await assert.rejects(() => cached(), /boom/);
    assert.equal(calls, 2);
});

test("surfaces a synchronous throw in the wrapped function as a rejection", async () => {
    const cached = createCachedFunction(() => {
        throw new Error("sync boom");
    });

    await assert.rejects(() => cached(), /sync boom/);
});
