import assert from "node:assert/strict";
import { test } from "node:test";

import { stripJsonComments } from "./stripJsonComments.mjs";

test("removes a full-line comment", () => {
    const input = ["{", '  // a comment', '  "a": 1', "}"].join("\n");
    assert.deepEqual(JSON.parse(stripJsonComments(input)), { a: 1 });
});

test("removes a trailing comment after a value", () => {
    const input = '{"a": 1} // trailing';
    assert.deepEqual(JSON.parse(stripJsonComments(input)), { a: 1 });
});

test("preserves // that appears inside a string value", () => {
    const input = '{"url": "http://example.com"}';
    assert.equal(stripJsonComments(input), input);
    assert.deepEqual(JSON.parse(stripJsonComments(input)), { url: "http://example.com" });
});

test("handles an escaped backslash before a closing quote (does not misread the quote as escaped)", () => {
    const input = '{"path": "C:\\\\", "x": 1} // trailing';
    // The value is the two-character string  C:\  — the \\ must not swallow the closing quote.
    assert.deepEqual(JSON.parse(stripJsonComments(input)), { path: "C:\\", x: 1 });
});

test("keeps an escaped quote inside a string intact", () => {
    const input = '{"quote": "she said \\"hi\\" //not a comment"}';
    assert.deepEqual(JSON.parse(stripJsonComments(input)), { quote: 'she said "hi" //not a comment' });
});

test("returns valid JSON for a realistic commented layout snippet", () => {
    const input = ['{', '  // layout id', '  "id": "Form", // inline', '  "type": "Group"', "}"].join("\n");
    assert.deepEqual(JSON.parse(stripJsonComments(input)), { id: "Form", type: "Group" });
});
