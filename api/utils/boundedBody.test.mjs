import assert from "node:assert/strict";
import { test } from "node:test";

import { BodyTooLargeError, MAX_BODY_BYTES, readBoundedBytes, readBoundedJson, readBoundedText } from "./boundedBody.mjs";

/** A body that keeps sending 100-byte chunks for as long as it is read, and says when it was told to stop. */
function endlessBody() {
    const state = { chunks: 0, cancelled: false };
    const body = new ReadableStream({
        pull(controller) {
            state.chunks += 1;
            controller.enqueue(new Uint8Array(100));
        },
        cancel() {
            state.cancelled = true;
        }
    });
    return { state, response: new Response(body) };
}

test("reads a body within the limit", async () => {
    assert.equal(await readBoundedText(new Response("<skjema/>"), 100), "<skjema/>");
});

test("reads a body exactly as long as the limit", async () => {
    assert.equal(await readBoundedText(new Response("12345"), 5), "12345");
});

test("refuses a declared length over the limit before reading anything", async () => {
    let pulled = 0;
    const body = new ReadableStream({
        pull(controller) {
            pulled += 1;
            controller.enqueue(new TextEncoder().encode("x"));
            controller.close();
        }
    });
    const response = new Response(body, { headers: { "content-length": "101" } });

    await assert.rejects(() => readBoundedText(response, 100), BodyTooLargeError);
    assert.ok(pulled <= 1, "nothing past the first chunk the stream offers by itself should be asked for");
});

test("gives up on a body that never says how long it is, as soon as it passes the limit", async () => {
    const { state, response } = endlessBody();

    await assert.rejects(() => readBoundedText(response, 1000), /larger than 1000 bytes/);
    assert.equal(state.cancelled, true, "the rest of the body should be cancelled, not left to arrive");
    assert.ok(state.chunks < 20, `read ${state.chunks} chunks of 100 bytes past a limit of 1000`);
});

test("keeps a character whose bytes arrive in two chunks", async () => {
    const bytes = new TextEncoder().encode("Søknad");
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of the ø
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
        }
    });

    assert.equal(await readBoundedText(new Response(body), 100), "Søknad");
});

test("reads a stand-in response that has only text()", async () => {
    assert.equal(await readBoundedText({ ok: true, status: 200, text: async () => "<a/>" }), "<a/>");
});

test("reads JSON with the same limit", async () => {
    assert.deepEqual(await readBoundedJson(new Response('{"version":"1.2.3"}')), { version: "1.2.3" });
    await assert.rejects(() => readBoundedJson(endlessBody().response, 1000), BodyTooLargeError);
});

test("has a limit of 20 MB by default", async () => {
    const response = new Response("[]", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } });

    assert.equal(MAX_BODY_BYTES, 20 * 1024 * 1024);
    await assert.rejects(() => readBoundedText(response), /larger than 20971520 bytes/);
});

test("readBoundedBytes reads a body under the limit as the bytes it sent", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const read = await readBoundedBytes(new Response(bytes), 10);
    assert.ok(Buffer.isBuffer(read));
    assert.deepEqual([...read], [0, 1, 2, 255]);
});

test("readBoundedBytes stops reading, and cancels the body, as soon as it passes the limit", async () => {
    const { state, response } = endlessBody();
    await assert.rejects(readBoundedBytes(response, 250), BodyTooLargeError);
    assert.equal(state.chunks, 3);
    assert.equal(state.cancelled, true);
});

test("readBoundedBytes refuses a declared length over the limit before reading anything", async () => {
    const { state, response } = endlessBody();
    const declared = new Response(response.body, { headers: { "content-length": "1000" } });
    await assert.rejects(readBoundedBytes(declared, 250), BodyTooLargeError);
    assert.equal(state.chunks <= 1, true);
});

test("readBoundedBytes checks a body it cannot stream against the limit too", async () => {
    const standIn = { headers: new Headers(), arrayBuffer: async () => new Uint8Array(300).buffer };
    await assert.rejects(readBoundedBytes(standIn, 250), BodyTooLargeError);
    const small = { headers: new Headers(), arrayBuffer: async () => new Uint8Array([7]).buffer };
    assert.deepEqual([...(await readBoundedBytes(small, 250))], [7]);
});

test("readBoundedBytes reads up to the default limit", async () => {
    const read = await readBoundedBytes(new Response(new Uint8Array(1024)));
    assert.equal(read.length, 1024);
    assert.equal(MAX_BODY_BYTES > 1024, true);
});
