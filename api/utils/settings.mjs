/**
 * The settings read from the environment by more than one module, each parsed by one rule in one place.
 *
 * Read when called rather than once at import, so that dotenv has run and a test can change a value between cases.
 */

/** How long an expensive answer is reused when CACHE_TTL_MS does not say. */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** How long an outbound request may take when REQUEST_TIMEOUT_MS does not say, the same default altinn-studio-api-tools uses. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long an expensive answer is reused, in milliseconds. Zero disables reuse.
 *
 * @returns {number}
 */
export function cacheTtlMs() {
    const parsed = Number.parseInt(process.env.CACHE_TTL_MS, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

/**
 * How long one outbound request may take, reading the body included, before it is abandoned, in milliseconds.
 *
 * Without one, only undici's own five-minute timeouts apply, so an upstream that accepts the connection and never answers holds the endpoint for minutes, and a Gitea request holds one of the shared Altinn Studio slots for as long.
 *
 * @returns {number}
 */
export function requestTimeoutMs() {
    const parsed = Number.parseInt(process.env.REQUEST_TIMEOUT_MS, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}
