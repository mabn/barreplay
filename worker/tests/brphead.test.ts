// Pins the upload route's .brp head scan (src/worker/brphead.ts) against the
// viewer fixture Go writes, plus the reject paths.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isBrp, scanBrpHead } from "../src/worker/brphead";
import { archiveSuffix } from "../src/worker/preamble";
import { brp } from "./brpfixture";

const FIXTURE = new URL("./fixtures/viewer.brp", import.meta.url);

const GID = "feed5eed00000000000000000000beef";

// The fixture's game is called "viewer", which no real game is — so reaching
// that refusal proves the header, the gunzip and the JSON of a meta Go wrote.
test("the Go-written viewer fixture's meta is read", async () => {
  const data = new Uint8Array(readFileSync(FIXTURE));
  assert.ok(isBrp(data));
  assert.match((await scanBrpHead(data)) as string, /names no game/);
});

test("gameId and recorder are read from the meta", async () => {
  const spec = await scanBrpHead(brp({ gameId: GID.toUpperCase(), recorder: { playerId: 3, allyTeam: 0, spectator: true } }));
  assert.ok(typeof spec === "object");
  assert.equal(spec.gameId, GID);
  assert.equal(archiveSuffix(spec), "spec");
  const player = await scanBrpHead(brp({ gameId: GID, recorder: { playerId: 3, allyTeam: 1 } }));
  assert.ok(typeof player === "object");
  assert.equal(archiveSuffix(player), "a1");
  const resim = await scanBrpHead(brp({ gameId: GID, resim: true }));
  assert.ok(typeof resim === "object");
  assert.equal(archiveSuffix(resim), "unk");
});

test("what is not a readable .brp head is refused", async () => {
  const cases: [Uint8Array, RegExp][] = [
    [new TextEncoder().encode("BREPSTREAM 1\n"), /not a \.brp/],
    [brp({ gameId: GID }).subarray(0, 8), /truncated/],
    [brp({ gameId: GID }, 4), /unsupported \.brp version 4/],
    [brp({ gameId: GID }).subarray(0, 20), /truncated/],
    [brp({ gameId: GID }, 6, false), /not a gzip stream/],
    [brp({ gameId: "nope" }), /names no game/],
    [brp([1, 2]), /names no game/],
  ];
  for (const [data, want] of cases) {
    const got = await scanBrpHead(data);
    assert.equal(typeof got, "string", `expected a refusal matching ${want}`);
    assert.match(got as string, want);
  }
  const notM = brp({ gameId: GID });
  notM[5] = 0x45;
  assert.match((await scanBrpHead(notM)) as string, /meta section is not first/);
});
