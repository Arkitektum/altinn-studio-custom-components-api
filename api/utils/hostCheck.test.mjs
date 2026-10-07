import assert from "node:assert/strict";
import { test } from "node:test";

import { allowedHostsSetting, isAllowedHost } from "./hostCheck.mjs";

test("accepts localhost, with or without a port, in any case", () => {
    assert.equal(isAllowedHost("localhost"), true);
    assert.equal(isAllowedHost("localhost:9001"), true);
    assert.equal(isAllowedHost("LocalHost:9001"), true);
    assert.equal(isAllowedHost("api.localhost:9001"), true);
});

test("accepts any IP address, since no page can make a browser send one in place of its own name", () => {
    assert.equal(isAllowedHost("127.0.0.1:9001"), true);
    assert.equal(isAllowedHost("192.168.1.20:9001"), true);
    assert.equal(isAllowedHost("[::1]:9001"), true);
    assert.equal(isAllowedHost("[::1]"), true);
});

test("refuses any other name, which is what a rebound domain arrives as", () => {
    assert.equal(isAllowedHost("attacker.example"), false);
    assert.equal(isAllowedHost("attacker.example:9001"), false);
    // A name that only starts like ours is not ours.
    assert.equal(isAllowedHost("localhost.attacker.example:9001"), false);
    assert.equal(isAllowedHost("127.0.0.1.nip.io:9001"), false);
});

test("accepts a name it is told to, and only that name", () => {
    assert.equal(isAllowedHost("api:9001", ["api"]), true);
    assert.equal(isAllowedHost("API:9001", ["api"]), true);
    assert.equal(isAllowedHost("apis:9001", ["api"]), false);
});

test("refuses a request with no usable Host", () => {
    assert.equal(isAllowedHost(undefined), false);
    assert.equal(isAllowedHost(""), false);
    assert.equal(isAllowedHost("[::1"), false);
    assert.equal(isAllowedHost(":9001"), false);
});

test("reads ALLOWED_HOSTS as a comma-separated list of lowercase names", (t) => {
    const original = process.env.ALLOWED_HOSTS;
    t.after(() => {
        if (original === undefined) delete process.env.ALLOWED_HOSTS;
        else process.env.ALLOWED_HOSTS = original;
    });

    process.env.ALLOWED_HOSTS = " Api , dev-box,,";
    assert.deepEqual(allowedHostsSetting(), ["api", "dev-box"]);

    delete process.env.ALLOWED_HOSTS;
    assert.deepEqual(allowedHostsSetting(), []);
});
