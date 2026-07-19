// Pins the upload route's .brepstream preamble scan (src/worker/preamble.ts)
// against the same harness fixture that pins the Lua encoder <-> Go decoder
// lockstep, plus the reject paths for things that are not widget streams.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { archiveSuffix, scanStreamPreamble } from "../src/worker/preamble";

const FIXTURE = new URL("../../internal/capture/testdata/harness.brepstream", import.meta.url);

const enc = new TextEncoder();
const stream = (text: string) => enc.encode(text);

test("harness fixture: gameId, ally team and spectator flag extracted", () => {
  const p = scanStreamPreamble(new Uint8Array(readFileSync(FIXTURE)));
  assert.ok(typeof p === "object", `expected preamble, got: ${p}`);
  assert.equal(p.gameId, "feed5eed00000000000000000000beef");
  assert.equal(p.allyTeam, 0);
  assert.equal(p.spectator, false);
  assert.equal(archiveSuffix(p), "a0");
});

test("gameId is lowercased; CRLF line endings are tolerated", () => {
  const p = scanStreamPreamble(
    stream("BREPSTREAM 1\r\nBRSNAP GID FEED5EED00000000000000000000BEEF\r\nBRSNAP READY\r\n"),
  );
  assert.ok(typeof p === "object");
  assert.equal(p.gameId, "feed5eed00000000000000000000beef");
});

test("spectator streams and pre-1.1 GAME records name their suffix", () => {
  const spec = scanStreamPreamble(
    stream(
      'BREPSTREAM 1\nBRSNAP GAME {"allyTeam":2,"spectator":true}\n' +
        "BRSNAP GID feed5eed00000000000000000000beef\nBRSNAP READY\n",
    ),
  );
  assert.ok(typeof spec === "object");
  assert.equal(archiveSuffix(spec), "spec");

  const old = scanStreamPreamble(
    stream('BREPSTREAM 1\nBRSNAP GAME {"map":"Hooked 1.1.1"}\nBRSNAP GID feed5eed00000000000000000000beef\nBRSNAP READY\n'),
  );
  assert.ok(typeof old === "object");
  assert.equal(old.allyTeam, null);
  assert.equal(old.spectator, null);
  assert.equal(archiveSuffix(old), "unk");
});

test("a malformed GAME record costs the suffix, not the upload", () => {
  const p = scanStreamPreamble(
    stream("BREPSTREAM 1\nBRSNAP GAME {broken\nBRSNAP GID feed5eed00000000000000000000beef\nBRSNAP READY\n"),
  );
  assert.ok(typeof p === "object");
  assert.equal(archiveSuffix(p), "unk");
});

test("non-brepstream bodies are rejected", () => {
  assert.match(scanStreamPreamble(stream("hello world\n")) as string, /not a \.brepstream/);
  assert.match(scanStreamPreamble(stream("")) as string, /not a \.brepstream/);
  assert.match(scanStreamPreamble(stream("BRSNAP GID feed5eed00000000000000000000beef\n")) as string, /not a \.brepstream/);
});

test("a stream without a (valid) GID is rejected", () => {
  assert.match(scanStreamPreamble(stream("BREPSTREAM 1\nBRSNAP READY\n")) as string, /no GID record/);
  assert.match(scanStreamPreamble(stream("BREPSTREAM 1\nBRSNAP GID nope\nBRSNAP READY\n")) as string, /no GID record/);
});

test("the scan window bounds how far a GID may hide", () => {
  const filler = "BRSNAP DEF " + "x".repeat(100) + "\n";
  const body = "BREPSTREAM 1\n" + filler.repeat(20) + "BRSNAP GID feed5eed00000000000000000000beef\nBRSNAP READY\n";
  assert.ok(typeof scanStreamPreamble(stream(body)) === "object");
  assert.match(scanStreamPreamble(stream(body), 256) as string, /no GID record/);
});
