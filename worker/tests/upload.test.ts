// Pins the bundle-upload collection contract (tools/upload.ts): only files
// under replays/** are ever swept in (never index.json — the listing is built
// live from the bucket), the single-replay filter picks exactly that replay's
// files, and each .brw head sorts after all of its replay's other objects (it
// is the listing's marker, so a half-uploaded replay never appears).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { pool } from "../tools/r2put";
import { collectReplayFiles } from "../tools/upload";

function fakeBundle(): string {
  const root = mkdtempSync(join(tmpdir(), "bundle-"));
  for (const f of [
    "index.json", // must never be uploaded
    ".wrangler/state.sqlite", // must never be swept in
    "replays/aaa.brw",
    "replays/aaa.keys",
    "replays/aaa.resources",
    "replays/aaa/c0",
    "replays/aaa/c1",
    "replays/bbb.brw",
    "replays/bbb.keys",
    "replays/bbb.resources",
  ]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), f);
  }
  return root;
}

test("collectReplayFiles walks only replays/**, heads last", () => {
  const keys = collectReplayFiles(fakeBundle()).map((o) => o.key);
  assert.ok(keys.every((k) => k.startsWith("replays/")), `outside replays/: ${keys}`);
  assert.ok(!keys.includes("index.json"));
  assert.equal(keys.length, 8);
  const heads = keys.filter((k) => k.endsWith(".brw"));
  assert.deepEqual(heads, ["replays/aaa.brw", "replays/bbb.brw"]);
  assert.ok(
    keys.indexOf("replays/aaa.brw") > keys.indexOf("replays/aaa/c1") && keys.indexOf("replays/bbb.brw") > keys.indexOf("replays/bbb.keys"),
    `heads must sort after their replay's files: ${keys}`,
  );
});

test("collectReplayFiles single-replay filter", () => {
  const keys = collectReplayFiles(fakeBundle(), "aaa").map((o) => o.key);
  assert.deepEqual(keys, ["replays/aaa.keys", "replays/aaa.resources", "replays/aaa/c0", "replays/aaa/c1", "replays/aaa.brw"]);
});

test("pool bounds concurrency and preserves start order", async () => {
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  await pool([...Array(20).keys()], 4, async (i) => {
    started.push(i);
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  });
  assert.deepEqual(started, [...Array(20).keys()], "items start in order");
  assert.ok(peak <= 4 && peak >= 2, `peak in-flight ${peak}`);
});

test("pool rejects on failure and stops scheduling", async () => {
  const started: number[] = [];
  await assert.rejects(
    () =>
      pool([...Array(10).keys()], 2, async (i) => {
        started.push(i);
        if (i === 1) throw new Error("boom");
        await new Promise((r) => setTimeout(r, 5));
      }),
    /boom/,
  );
  assert.ok(started.length < 10, `scheduling stopped early (started ${started.length})`);
});
