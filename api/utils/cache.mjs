// Dependencies
import { AsyncLocalStorage } from "node:async_hooks";

// Utils
import { log } from "./logger.mjs";

/**
 * The cached call a piece of work is running inside, so a fetch deep in a getter can say that what it is part of should
 * not be kept. Each entry points at the call it was made from, so a cached getter running inside another passes the
 * news up as well.
 */
const callStorage = new AsyncLocalStorage();

/**
 * Says that the cached call this runs inside should not keep its result: something it fetched failed for a reason that
 * may be gone a moment later, so the getters' habit of carrying on without that app would otherwise serve the gap for a
 * whole TTL. Does nothing outside a cached call.
 */
export function noteTransientFailure() {
    for (let call = callStorage.getStore(); call; call = call.parent) {
        call.transientFailure = true;
    }
}

/**
 * Whether an error is one that may well not happen again: the network, a timeout, or an upstream answering 5xx or 429.
 *
 * Read from the error and its causes, since the testmotor client wraps the original and says what status it got only
 * in its message. Anything else (a 404, XML that does not validate, a schema that does not parse) will fail the same
 * way next time, and is worth caching like any other answer.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientError(error) {
    for (let current = error; current instanceof Error; current = current.cause) {
        if (current.name === "TimeoutError" || current.name === "AbortError") return true;
        // undici's "fetch failed", which is how fetch reports a connection that never got an answer.
        if (current instanceof TypeError && current.message === "fetch failed") return true;
        if (/\b(?:status|answered) (?:5\d\d|429)\b/.test(current.message)) return true;
    }
    return false;
}

/**
 * Whether an upstream status is one worth asking again about.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isTransientStatus(status) {
    return status >= 500 || status === 429;
}

/**
 * Wraps an async function in a small in-memory TTL cache, keyed by its arguments.
 *
 * Each endpoint in this API fans out to Altinn Studio / npm / disk for every tracked app on every request. The
 * Statistics dashboard is the only consumer and re-runs "Synchronize" repeatedly during a session, so without
 * caching every sync re-fetches everything. This wrapper collapses repeated identical calls into a single upstream
 * fetch for `ttlMs`, and de-duplicates concurrent in-flight calls (they share one promise). It is deliberately
 * simple and process-local — appropriate for this dev-only tool, not a distributed cache.
 *
 * Failures are not cached: if the wrapped call rejects, the entry is evicted so the next call retries. Neither is a
 * result that was only partly fetched because of a transient failure (see `noteTransientFailure`). The getters catch
 * per-app failures and answer the rest, so without that a blip would be served for a whole TTL. A result whose only
 * failures are permanent is cached as usual, or one broken example file would switch the cache off for good.
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
            // Reusing a call means the request logs nothing of its own. Say why, so a report with no events reads as
            // "the cache answered" rather than as a request that mysteriously did nothing.
            log.note(
                entry.settled
                    ? `served from cache (fresh for another ${Math.round((entry.expiresAt - now) / 1000)}s)`
                    : "joined a request already in flight"
            );
            return entry.promise;
        }

        // Start from a resolved promise so a synchronous throw in `fn` becomes a rejection rather than propagating.
        const call = { transientFailure: false, parent: callStorage.getStore() };
        const promise = callStorage.run(call, () => Promise.resolve().then(() => fn(...args)));
        const newEntry = { promise, expiresAt: now + ttlMs, settled: false };
        cache.set(key, newEntry);

        // Evicting is enough to make an entry unreachable, so an evicted one never needs marking as settled. A newer entry
        // that has already replaced it is left alone.
        const evict = () => {
            if (cache.get(key)?.promise === promise) {
                cache.delete(key);
            }
        };
        promise.then(
            () => {
                if (call.transientFailure) {
                    evict();
                } else {
                    newEntry.settled = true;
                }
            },
            // Don't let a failed fetch stay cached.
            evict
        );

        return promise;
    };
}
