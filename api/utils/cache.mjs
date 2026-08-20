/**
 * Wraps an async function in a small in-memory TTL cache, keyed by its arguments.
 *
 * Each endpoint in this API fans out to Altinn Studio / npm / disk for every tracked app on every request. The
 * Statistics dashboard is the only consumer and re-runs "Synchronize" repeatedly during a session, so without
 * caching every sync re-fetches everything. This wrapper collapses repeated identical calls into a single upstream
 * fetch for `ttlMs`, and de-duplicates concurrent in-flight calls (they share one promise). It is deliberately
 * simple and process-local — appropriate for this dev-only tool, not a distributed cache.
 *
 * Failures are never cached: if the wrapped call rejects, the entry is evicted so the next call retries.
 *
 * De-duplication and the TTL are independent: an in-flight call is always shared, while a settled result is only
 * reused while it is still fresh. A `ttlMs` of 0 therefore disables caching without letting concurrent callers fan
 * out to separate upstream fetches.
 *
 * @param {(...args: any[]) => Promise<any>} fn - The async function to memoize.
 * @param {Object} [options]
 * @param {number} [options.ttlMs=60000] - Time-to-live for a cached result, in milliseconds.
 * @returns {(...args: any[]) => Promise<any>} A wrapped function with the same call signature.
 */
export function createCachedFunction(fn, { ttlMs = 60000 } = {}) {
    // key (stringified args) -> { promise, expiresAt, settled }
    const cache = new Map();

    return function cached(...args) {
        const key = JSON.stringify(args);
        const now = Date.now();
        const entry = cache.get(key);

        // Share a call that is still running whatever the TTL says, so concurrent callers never trigger the same
        // upstream fetch twice. Only once it has settled does freshness decide — which for a ttlMs of 0 is never,
        // since expiresAt is then the moment the call started.
        if (entry && (!entry.settled || entry.expiresAt > now)) {
            return entry.promise;
        }

        // Start from a resolved promise so a synchronous throw in `fn` becomes a rejection rather than propagating.
        const promise = Promise.resolve().then(() => fn(...args));
        const newEntry = { promise, expiresAt: now + ttlMs, settled: false };
        cache.set(key, newEntry);

        promise.then(
            () => {
                newEntry.settled = true;
            },
            () => {
                // Don't let a failed fetch stay cached — evict it (unless a newer entry has already replaced it).
                // Evicting is enough to make it unreachable, so it never needs marking as settled.
                if (cache.get(key)?.promise === promise) {
                    cache.delete(key);
                }
            }
        );

        return promise;
    };
}
