// The summary's achievements: the browser-side demo reader (demo.ts) and the
// rules run over what it reads (achievements/). The demo is the repo's real
// header fixture (internal/demofile/testdata) with a small packet stream and
// tail written onto it, so the byte layouts are checked against a real
// header and startscript.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { gunzip, parseDemo, type BrpDef } from "../src/summary/demo";
import { gather } from "../src/summary/achievements/facts";
import { RULES } from "../src/summary/achievements/rules";

const FIXTURE = new URL("../../internal/demofile/testdata/sample_header.sdfz", import.meta.url);

class Bytes {
  parts: number[] = [];
  u8(x: number) { this.parts.push(x & 255); return this; }
  i16(x: number) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, x, true); this.parts.push(...b); return this; }
  i32(x: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, x, true); this.parts.push(...b); return this; }
  u32(x: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x, true); this.parts.push(...b); return this; }
  f32(x: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, x, true); this.parts.push(...b); return this; }
  str(s: string) { this.parts.push(...new TextEncoder().encode(s)); return this; }
}

/** chunk wraps one packet as the demo stores it: game time, length, bytes. */
function chunk(out: Bytes, packet: Bytes) {
  out.f32(0).u32(packet.parts.length);
  out.parts.push(...packet.parts);
}

const MEX = 7;
const DEFS = new Map<number, BrpDef>([[MEX, { id: MEX, name: "armmex", humanName: "Metal Extractor", isBuilding: true, unitGroup: "metal", metalCost: 50 }]]);

async function demoWithStream() {
  const raw = await gunzip(new Uint8Array(readFileSync(FIXTURE)));
  const v = new DataView(raw.buffer, raw.byteOffset);
  const head = raw.subarray(0, v.getInt32(20, true) + v.getInt32(304, true));
  const numTeams = v.getInt32(332, true);

  const s = new Bytes();
  chunk(s, new Bytes().u8(1).i32(90)); // keyframe 90
  // NETMSG_SELECT then NETMSG_COMMAND: player 0 orders a mex for unit 5.
  chunk(s, new Bytes().u8(12).i16(6).u8(0).i16(5));
  chunk(s, new Bytes().u8(11).i16(33).u8(0).i32(-MEX).i32(0).u8(0).u32(4).f32(1000).f32(0).f32(2000).f32(0));
  for (let i = 0; i < 10; i++) chunk(s, new Bytes().u8(2)); // ten new frames: 100
  // A Lua widget's order (AICOMMAND, aiInst 255 = no AI): another mex.
  chunk(s, new Bytes().u8(14).i16(37).u8(0).u8(255).u8(0).i16(5).i32(-MEX).i32(0).u8(0).u32(4).f32(3000).f32(0).f32(3000).f32(0));
  chunk(s, new Bytes().u8(7).u8(8).u8(0).u8(254).str("gg\0")); // chat to everyone
  const stream = new Uint8Array(s.parts);

  const tail = new Bytes().u8(0); // winners: ally team 0
  for (let t = 0; t < numTeams; t++) tail.i32(1);
  for (let t = 0; t < numTeams; t++) {
    tail.i32(100);
    for (let i = 0; i < 12; i++) tail.f32(i === 2 ? 1000 * (t + 1) : 0); // metalProduced
    for (let i = 0; i < 7; i++) tail.i32(i === 6 ? t : 0); // unitsKilled
  }
  const b = new Uint8Array(head.length + stream.length + tail.parts.length);
  b.set(head);
  b.set(stream, head.length);
  b.set(tail.parts, head.length + stream.length);
  const bv = new DataView(b.buffer);
  bv.setInt32(308, stream.length, true); // streamSize
  bv.setInt32(324, 0, true); // playerStatSize
  bv.setInt32(340, 80, true); // teamStatElem
  bv.setInt32(348, 1, true); // winners
  return parseDemo(b);
}

test("the header and startscript of a real demo", async () => {
  const d = parseDemo(await gunzip(new Uint8Array(readFileSync(FIXTURE))));
  assert.equal(d.gameId, "836d486a5480a9e830be54db7d2c7be9");
  assert.equal(d.mapName, "Isidis crack 1.1");
  assert.equal(d.teams.length, 8);
  assert.ok(d.players.length >= 8);
  assert.ok(d.players.every((p) => p.name));
});

test("orders, chat, winners and the end-of-game totals come out of the stream", async () => {
  const d = await demoWithStream();
  assert.equal(d.commands.length, 2);
  assert.deepEqual(d.commands.map((c) => [c.f, c.id, c.ai]), [[90, -MEX, undefined], [100, -MEX, undefined]]);
  assert.deepEqual(d.commands[0].units, [5]);
  assert.deepEqual(d.chat.map((c) => [c.f, c.player, c.dest, c.text]), [[100, 0, "all", "gg"]]);
  assert.deepEqual(d.winners, [0]);
  assert.equal(d.teamStats?.get(2)?.metalProduced, 3000);
  assert.equal(d.teamStats?.get(3)?.unitsKilled, 3);
});

test("a widget's order is the player's, and both mex placements are builds", async () => {
  const F = gather(await demoWithStream(), DEFS, null, null);
  const p = F.players.find((x) => x.id === 0)!;
  assert.equal(p.cmds.length, 2);
  assert.deepEqual(p.builds.map((b) => b.def.name), ["armmex", "armmex"]);
  assert.equal(p.chat.length, 1);
});

test("every rule runs on a sparse game: an answer or a reason, never a throw", async () => {
  for (const defs of [DEFS, null]) {
    const F = gather(await demoWithStream(), defs, null, null);
    for (const r of RULES) {
      const out = r.check(F);
      if ("skip" in out) assert.ok(out.skip.length > 0, `${r.id} skips with no reason`);
      else assert.ok(Array.isArray(out), `${r.id}`);
    }
  }
  // Without the def table, build orders cannot be named.
  const F = gather(await demoWithStream(), null, null, null);
  const mex = RULES.find((r) => r.id === 1735)!;
  assert.ok("skip" in mex.check(F));
});

test("the shortlist's ids are each implemented once", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 258);
});
