// Pins the PUT /api/replays/<id> body validation (src/worker/replayentry.ts):
// what a well-formed upsert normalizes to, and that malformed ids/bodies are
// rejected with a reason instead of being coerced into the catalog.
import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeEntry } from "../src/worker/replayentry";

test("full entry passes through", () => {
  const e = sanitizeEntry("abc123", {
    startUnix: 1_752_000_000,
    durationSec: 1987,
    map: "Isidis crack 1.1",
    gameSize: "8v8",
    sizeBytes: 8_400_000,
  });
  assert.deepEqual(e, {
    id: "abc123",
    startUnix: 1_752_000_000,
    durationSec: 1987,
    map: "Isidis crack 1.1",
    gameSize: "8v8",
    sizeBytes: 8_400_000,
  });
});

test("missing stats become null, unknown fields are dropped", () => {
  const e = sanitizeEntry("abc", { map: "Hooked 1.1.1", bogus: 42 });
  assert.deepEqual(e, {
    id: "abc",
    startUnix: null,
    durationSec: null,
    map: "Hooked 1.1.1",
    gameSize: null,
    sizeBytes: null,
  });
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
