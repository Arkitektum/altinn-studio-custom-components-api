// Dependencies
import { AsyncResource } from "node:async_hooks";

/**
 * Creates a gate that runs at most `limit` async tasks at a time, queueing the rest in the order they arrived.
 *
 * The endpoints here fan out over every tracked app at once, so a single request can open 50+ connections to Altinn
 * Studio, and several endpoints running together multiply that. Putting the gate around the request helper rather
 * than around each fan-out gives all callers one shared budget, whatever mix of endpoints is in flight.
 *
 * Queued tasks are bound with `AsyncResource.bind` so each runs in the async context of the caller that queued it.
 * Without that, a task started from the previous task's completion callback would inherit *that* task's context, and
 * the run-scoped logger (`api/utils/logger.mjs`) would attribute its events to the wrong request's report.
 *
 * @param {number} limit - Maximum number of tasks to run concurrently. Values below 1 are treated as 1.
 * @returns {<T>(task: () => Promise<T>) => Promise<T>} A function that runs `task` when a slot is free and resolves
 *   or rejects with its outcome.
 */
export function createConcurrencyLimiter(limit) {
    const maxConcurrent = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
    const queue = [];
    let active = 0;

    function runNext() {
        if (active >= maxConcurrent || queue.length === 0) {
            return;
        }
        active += 1;
        const { task, resolve, reject } = queue.shift();
        // Start from a resolved promise so a synchronous throw in `task` rejects rather than propagating into runNext.
        Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
                active -= 1;
                runNext();
            });
    }

    return function limited(task) {
        return new Promise((resolve, reject) => {
            queue.push({ task: AsyncResource.bind(task), resolve, reject });
            runNext();
        });
    };
}
