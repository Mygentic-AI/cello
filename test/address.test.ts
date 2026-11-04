// An address decides where this machine connects and whether that's encrypted, and a mistake wouldn't show in a working run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAddress, parseAddress, serverUrlFrom } from "../src/daemon/address.ts";

const id = "ab".repeat(32);

test("the short form is encrypted, except on this machine", () => {
  assert.equal(serverUrlFrom("cello.example.com"), "wss://cello.example.com/v1");
  assert.equal(serverUrlFrom("cello.example.com:8443"), "wss://cello.example.com:8443/v1");
  assert.equal(serverUrlFrom("127.0.0.1:18400"), "ws://127.0.0.1:18400/v1");
  assert.equal(serverUrlFrom("localhost:18400"), "ws://localhost:18400/v1");
  // Looks like this machine at first glance, and isn't.
  assert.equal(serverUrlFrom("127.0.0.1.evil.example"), "wss://127.0.0.1.evil.example/v1");
  assert.equal(serverUrlFrom("localhost.evil.example:80"), "wss://localhost.evil.example:80/v1");
});

test("an address parses back to what it was made from", () => {
  for (const url of ["wss://cello.example.com/v1", "ws://127.0.0.1:18400/v1", "ws://10.0.0.5:8080/v1", "wss://acme.example/other/path"]) {
    const address = formatAddress(id, url);
    assert.deepEqual(parseAddress(address), { id, server: url }, address);
  }
  assert.equal(formatAddress(id, "wss://cello.example.com/v1"), `${id}@cello.example.com`);
  assert.equal(formatAddress(id, "ws://10.0.0.5:8080/v1"), `${id}@ws://10.0.0.5:8080/v1`, "plain ws off this machine stays spelled out");
});

test("a key alone means this daemon's own server, and nonsense is refused", () => {
  assert.deepEqual(parseAddress(id), { id });
  for (const bad of [`${id}@`, `${id}@has space`, `${id}@http://example.com`, `${id}@a/b`]) {
    assert.throws(() => parseAddress(bad), RangeError, bad);
  }
});
