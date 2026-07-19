// Pins the PUT /api/replays/<id> body validation (src/worker/replayentry.ts):
// what a well-formed upsert normalizes to, and that malformed ids/bodies are
// rejected with a reason instead of being coerced into the catalog.
import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeEntry } from "../src/worker/replayentry";

test("full entry passes through", () => {
  const e = sanitizeEntry("abc123", {
    rid: "abc123-1a2b3c4d",
    startUnix: 1_752_000_000,
    durationSec: 1987,
    map: "Isidis crack 1.1",
    gameSize: "8v8",
    sizeBytes: 8_400_000,
    settings: { ranked: true, lava: true, quickStart: "enabled" },
  });
  assert.deepEqual(e, {
    id: "abc123",
    rid: "abc123-1a2b3c4d",
    startUnix: 1_752_000_000,
    durationSec: 1987,
    map: "Isidis crack 1.1",
    gameSize: "8v8",
    sizeBytes: 8_400_000,
    settings: { ranked: true, lava: true, quickStart: "enabled" },
  });
});

test("missing stats become null, unknown fields are dropped", () => {
  const e = sanitizeEntry("abc", { map: "Hooked 1.1.1", bogus: 42 });
  assert.deepEqual(e, {
    id: "abc",
    rid: null,
    startUnix: null,
    durationSec: null,
    map: "Hooked 1.1.1",
    gameSize: null,
    sizeBytes: null,
    settings: null,
  });
});

test("rid is validated like an id", () => {
  assert.equal(sanitizeEntry("abc", { rid: "a/b" }), "invalid rid");
  assert.equal(sanitizeEntry("abc", { rid: 7 }), "invalid rid");
  assert.equal(sanitizeEntry("abc", { rid: "" }), "invalid rid");
  const e = sanitizeEntry("abc", { rid: null });
  assert.ok(typeof e === "object" && e.rid === null);
});

test("settings: empty object becomes null, bad shapes are rejected", () => {
  const empty = sanitizeEntry("abc", { settings: {} });
  assert.ok(typeof empty === "object" && empty.settings === null);
  assert.equal(sanitizeEntry("abc", { settings: [1] }), "settings must be a JSON object");
  assert.equal(sanitizeEntry("abc", { settings: "ranked" }), "settings must be a JSON object");
  assert.equal(sanitizeEntry("abc", { settings: { ranked: 1 } }), "settings.ranked must be a boolean or string");
  assert.equal(sanitizeEntry("abc", { settings: { nested: { a: 1 } } }), "settings.nested must be a boolean or string");
  const manyKeys = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, true]));
  assert.equal(sanitizeEntry("abc", { settings: manyKeys }), "settings must have at most 32 keys");
  const huge = { blob: "x".repeat(3000) };
  assert.equal(sanitizeEntry("abc", { settings: huge }), "settings must serialize to at most 2048 bytes");
});

test("oversized strings are truncated, not rejected", () => {
  const e = sanitizeEntry("abc", { gameSize: "x".repeat(1000) });
  assert.ok(typeof e === "object" && e.gameSize !== null && e.gameSize.length === 40);
});

test("wrong types and bad bodies are rejected with a reason", () => {
  assert.equal(sanitizeEntry("abc", { startUnix: "yesterday" }), "startUnix must be a finite number");
  assert.equal(sanitizeEntry("abc", { durationSec: NaN }), "durationSec must be a finite number");
  assert.equal(sanitizeEntry("abc", { map: 7 }), "map must be a string");
  assert.equal(sanitizeEntry("abc", [1]), "body must be a JSON object");
  assert.equal(sanitizeEntry("abc", null), "body must be a JSON object");
});

test("ids are confined to a bare token", () => {
  assert.equal(sanitizeEntry("", {}), "invalid replay id");
  assert.equal(sanitizeEntry("a/b", {}), "invalid replay id");
  assert.equal(sanitizeEntry("..", {}), "invalid replay id");
  assert.equal(sanitizeEntry("a".repeat(129), {}), "invalid replay id");
  assert.ok(typeof sanitizeEntry("6da7496aca487581a12b7a6d5bd99bc0", {}) === "object");
});
