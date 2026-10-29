/**
 * The largest answer read from an upstream: 20 MB.
 *
 * The request timeout does not bound a body. An upstream that answers quickly can send hundreds of megabytes inside
 * thirty seconds, and all of it would be held in memory. The largest thing read here, a data model or a layout, is well
 * under a megabyte, so this leaves a wide margin.
 */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** Thrown when an answer passes the limit, so a caller can say so rather than call it unreadable. */
export class BodyTooLargeError extends Error {
    /** @param {number} maxBytes - The limit it passed. */
    constructor(maxBytes) {
        super(`the answer is larger than ${maxBytes} bytes, so it was not read`);
        this.name = "BodyTooLargeError";
    }
}

/**
 * Reads a response body as text, giving up as soon as it passes `maxBytes`.
 *
 * A declared `Content-Length` over the limit is refused before anything is read. Otherwise the body is read as it
 * arrives and abandoned at the first chunk that takes it over, so an answer that never declared its length cannot fill
 * memory either. A response with no stream to read, such as a test's stand-in, is read with its own `text()`.
 *
 * @param {Response} response - The response to read.
 * @param {number} [maxBytes] - The limit.
 * @returns {Promise<string>} The body.
 * @throws {BodyTooLargeError} When the body is larger than the limit.
 */
export async function readBoundedText(response, maxBytes = MAX_BODY_BYTES) {
    if (Number(response.headers?.get?.("content-length")) > maxBytes) {
        await response.body?.cancel?.();
        throw new BodyTooLargeError(maxBytes);
    }
    if (typeof response.body?.getReader !== "function") {
        return response.text();
    }
    const reader = response.body.getReader();
    // Decoded as it arrives, with `stream` holding back a character split across two chunks until the rest of it comes.
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw new BodyTooLargeError(maxBytes);
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

/**
 * Reads a response body as JSON, with the same limit as `readBoundedText`.
 *
 * @param {Response} response - The response to read.
 * @param {number} [maxBytes] - The limit.
 * @returns {Promise<unknown>} The parsed body.
 */
export async function readBoundedJson(response, maxBytes = MAX_BODY_BYTES) {
    return JSON.parse(await readBoundedText(response, maxBytes));
}
