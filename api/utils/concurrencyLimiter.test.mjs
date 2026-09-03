import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { test } from "node:test";

import { createConcurrencyLimiter } from "./concurrencyLimiter.mjs";

/** A task that records how many are running at once and resolves after a tick. */
function makeTracker() {
    const state = { active: 0, peak: 0, completed: [] };
    const task = (id) => async () => {
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.active -= 1;
        state.completed.push(id);
        return id;
    };
    return { state, task };
}

test("runs no more than the limit at a time and still completes every task", async () => {
    const limit = createConcurrencyLimiter(3);
    const { state, task } = makeTracker();

    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => limit(task(index))));

    assert.equal(state.peak, 3);
    assert.deepEqual(results, Array.from({ length: 12 }, (_, index) => index));
});

test("starts queued tasks in the order they were queued", async () => {
    const limit = createConcurrencyLimiter(1);
    const { state, task } = makeTracker();

    await Promise.all([limit(task("a")), limit(task("b")), limit(task("c"))]);

    assert.deepEqual(state.completed, ["a", "b", "c"]);
});

test("treats a limit below 1 as 1 rather than stalling", async () => {
    const limit = createConcurrencyLimiter(0);
    const { state, task } = makeTracker();

    await Promise.all([limit(task("a")), limit(task("b"))]);

    assert.equal(state.peak, 1);
    assert.deepEqual(state.completed, ["a", "b"]);
});

test("rejects with the task's error and frees the slot for the queue", async () => {
    const limit = createConcurrencyLimiter(1);

    const failed = limit(async () => {
        throw new Error("boom");
    });
    const followed = limit(async () => "still runs");

    await assert.rejects(failed, /boom/);
    assert.equal(await followed, "still runs");
});

test("rejects when a task throws synchronously", async () => {
    const limit = createConcurrencyLimiter(1);

    await assert.rejects(
        limit(() => {
            throw new Error("sync boom");
        }),
        /sync boom/
    );
    assert.equal(await limit(async () => "ok"), "ok");
});

test("runs each queued task in the async context of whoever queued it", async () => {
    // The run-scoped logger reads its current run from AsyncLocalStorage. A queued task is started from the previous
    // task's completion callback, so without AsyncResource.bind it would see that task's context instead of its own.
    const storage = new AsyncLocalStorage();
    const limit = createConcurrencyLimiter(1);
    const seen = [];

    const queueIn = (label) =>
        storage.run(label, () =>
            limit(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                seen.push({ label, contextDuringTask: storage.getStore() });
            })
        );

    await Promise.all([queueIn("request-a"), queueIn("request-b"), queueIn("request-c")]);

    assert.deepEqual(
        seen.map((entry) => entry.contextDuringTask),
        ["request-a", "request-b", "request-c"]
    );
});
