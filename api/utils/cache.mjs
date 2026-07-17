/**
 * Wraps an async function in a small in-memory TTL cache, keyed by its arguments.
 *
 * Each endpoint in this API fans out to Altinn Studio / npm / disk for every tracked app on every request. The
 * Statistics dashboard is the only consumer and re-runs "Synchronize" repeatedly during a session, so without
 * caching every sync re-fetches everything. This wrapper collapses repeated identical calls into a single upstream
 * fetch for `ttlMs`, and de-duplicates concurrent in-flight calls (they share one promise). It is deliberately
 * simple and process-local — appropriate for this dev-only tool, not a distributed cache.
 *
 * Failures are never cached: if the wrapped call rejects, the entry is evicted so the next call retries. A `ttlMs`
 * of 0 effectively disables caching while still de-duplicating calls made within the same tick.
 *
 * @param {(...args: any[]) => Promise<any>} fn - The async function to memoize.
 * @param {Object} [options]
 * @param {number} [options.ttlMs=60000] - Time-to-live for a cached result, in milliseconds.
 * @returns {(...args: any[]) => Promise<any>} A wrapped function with the same call signature.
 */
export function createCachedFunction(fn, { ttlMs = 60000 } = {}) {
    // key (stringified args) -> { promise, expiresAt }
    const cache = new Map();

    return function cached(...args) {
        const key = JSON.stringify(args);
        const now = Date.now();
        const entry = cache.get(key);

        if (entry && entry.expiresAt > now) {
            return entry.promise;
        }

        // Start from a resolved promise so a synchronous throw in `fn` becomes a rejection rather than propagating.
        const promise = Promise.resolve().then(() => fn(...args));
        cache.set(key, { promise, expiresAt: now + ttlMs });

        // Don't let a failed fetch stay cached — evict it (unless a newer entry has already replaced it).
        promise.catch(() => {
            if (cache.get(key)?.promise === promise) {
                cache.delete(key);
            }
        });

        return promise;
    };
}
