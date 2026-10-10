// The summary library's pure parts: formatting and what it decides it may
// draw. The DOM half is checked against a real page (see worker/README.md).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fmtClock, fmtMetal, niceStep, timeStep } from "../src/summary/format";
import { comparable, notices, readable, sideColor, sideName } from "../src/summary/model";
import { knockouts, lossesByStep, wipedOf } from "../src/summary/losses";
import { compass, momentStory } from "../src/summary/moments";
import { clipAround, clipSpan, watcher } from "../src/summary/watch";
import type { Insights } from "../src/summary/types";

function ins(over: Partial<Insights> = {}): Insights {
  return {
    version: 1, gameId: "g", durationSec: 600, stepSec: 15, costCoverage: "full", pov: "full",
    bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
    sides: [{ ally: 0, teams: [0], players: ["Ann", "Bob"], color: "#112233" }, { ally: 1, teams: [1], players: ["Cy"] }],
    teams: [], defs: {},
    series: { t: [], army: [], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    deaths: { f: [], x: [], z: [], def: [], team: [], cost: [], unfinished: [] },
    milestones: [], chat: [], marks: [],
    ...over,
  };
}

test("fmtClock", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(65.4), "1:05");
  assert.equal(fmtClock(3725), "1:02:05");
});

test("fmtMetal keeps BAR's bands", () => {
  assert.deepEqual([950, 7040, 504321, 3.71e6, -1500].map(fmtMetal), ["950", "7.0k", "504k", "3.7M", "-1.5k"]);
});

test("axis steps are round", () => {
  assert.equal(niceStep(10000, 4), 5000);
  assert.equal(niceStep(730, 5), 200);
  assert.equal(timeStep(33 * 60, 8), 300);
  assert.equal(timeStep(90, 8), 60);
});

test("only a full-view two-sided game is comparable", () => {
  assert.equal(comparable(ins()), true);
  assert.equal(comparable(ins({ pov: "ally" })), false);
  assert.equal(comparable(ins({ pov: "unknown" })), false);
  assert.equal(comparable(ins({ sides: [ins().sides[0], ins().sides[1], ins().sides[1]] })), false);
});

test("notices say why something is missing", () => {
  assert.deepEqual(notices(ins()), []);
  assert.match(notices(ins({ pov: "ally" }))[0], /re-simulation/);
  assert.match(notices(ins({ costCoverage: "army" }))[0], /armed mobile units only/);
});

test("side labels and colours", () => {
  assert.equal(sideName(ins(), 0), "Ann +1");
  assert.equal(sideName(ins(), 1), "Cy");
  assert.equal(readable("#ffd000"), "#ffd000", "a light colour is kept");
  assert.notEqual(readable("#0000ff"), "#0000ff", "pure blue is lifted");
  assert.notEqual(sideColor(ins(), 0), "#112233");
  assert.match(sideColor(ins(), 1), /^#[0-9a-f]{6}$/);
});

test("compass splits the map in thirds", () => {
  const i = ins({ bounds: { minX: 0, maxX: 900, minZ: 0, maxZ: 900 } });
  assert.equal(compass(i, 100, 100), "the north-west");
  assert.equal(compass(i, 450, 450), "the centre");
  assert.equal(compass(i, 800, 450), "the east");
  assert.equal(compass(i, 450, 800), "the south");
});

test("a moment is named after what died in it", () => {
  const base = {
    battles: [],
    bounds: { minX: 0, maxX: 900, minZ: 0, maxZ: 900 },
    teams: [{ team: 0, side: 0, player: "Ann" }, { team: 1, side: 1, player: "Cy" }],
    defs: { "1": { name: "armcom", human: "Commander", cost: 1200 }, "2": { name: "armpw", human: "Pawn", cost: 50 }, "3": { name: "corkorg", human: "Juggernaut", cost: 3000 } },
    series: { t: [0, 15, 30, 45], army: [[0, 100, 200, 300], [0, 100, 900, 1200]], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
  };
  const deaths = (rows: [number, number, number, number, number][]) => ({
    f: rows.map((r) => r[0]), def: rows.map((r) => r[1]), team: rows.map((r) => r[2]), x: rows.map((r) => r[3]), z: rows.map((r) => r[4]),
    cost: rows.map((r) => (base.defs as Record<string, { cost: number }>)[String(r[1])].cost), unfinished: rows.map(() => 0),
  });
  const m = { n: 1, f0: 900, f1: 1350, side: 1, delta: 0.3, battle: -1 };
  // Ann's commander dies in the north-west: that names it.
  let st = momentStory(ins({ ...base, deaths: deaths([[1000, 1, 0, 100, 100], [1000, 2, 1, 100, 100]]) }), m);
  assert.equal(st.title, "Ann's commander falls in the north-west");
  assert.equal(st.detail, "Ann +1 lost 1 unit (1.2k metal): Commander; Cy lost 1 unit (50 metal): Pawn.");
  // One big unit is most of the loss.
  st = momentStory(ins({ ...base, deaths: deaths([[1000, 3, 0, 800, 800], [1000, 2, 0, 800, 800]]) }), m);
  assert.equal(st.title, "Ann +1 loses a Juggernaut in the south-east");
  // A lopsided trade of small units is a won fight.
  st = momentStory(ins({ ...base, deaths: deaths(Array.from({ length: 10 }, () => [1000, 2, 0, 450, 450] as [number, number, number, number, number])) }), m);
  assert.equal(st.title, "Cy wins the fight in the centre");
  // Nothing died: the armies pulled apart.
  st = momentStory(ins({ ...base, deaths: deaths([]) }), m);
  assert.equal(st.title, "Cy out-builds Ann +1");
  // Deaths outside the window (and the step before it) do not count.
  st = momentStory(ins({ ...base, deaths: deaths([[100, 1, 0, 100, 100]]) }), m);
  assert.equal(st.lost[0].n, 0);
  // A player leaving takes their army with them: that names it, and what
  // went down with the team is not counted as lost in the game.
  const pawns = Array.from({ length: 10 }, () => [1100, 2, 0, 450, 450] as [number, number, number, number, number]);
  st = momentStory(ins({ ...base, deaths: deaths(pawns), eliminated: [{ f: 1100, team: 0, recorded: true }] }), m);
  assert.equal(st.title, "Ann is eliminated");
  assert.equal(st.lost[0].n, 0);
});

test("losses split what died fighting from what went down with its team", () => {
  const i = ins({
    stepSec: 15,
    teams: [{ team: 0, side: 0, player: "Ann" }, { team: 1, side: 1, player: "Cy" }, { team: 2, side: -1 }],
    series: { t: [0, 15, 30], army: [], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    deaths: {
      f: [30, 500, 900, 950, 950], x: [0, 0, 0, 0, 0], z: [0, 0, 0, 0, 0], def: [1, 1, 1, 1, 1],
      team: [0, 1, 0, 0, 2], cost: [100, 50, 200, 400, 999], unfinished: [0, 0, 0, 0, 0],
    },
    eliminated: [{ f: 950, team: 0, recorded: false }],
  });
  const w = wipedOf(i);
  assert.deepEqual([0, 1, 2, 3, 4].map(w), [false, false, false, true, false]);
  const l = lossesByStep(i);
  assert.equal(l.priced, true);
  assert.deepEqual(l.combat, [[100, 0, 200], [0, 50, 0]], "Gaia's loss belongs to no side");
  assert.deepEqual(l.wiped, [[0, 0, 400], [0, 0, 0]]);
  assert.deepEqual(knockouts(i), [{ f: 950, team: 0, side: 0, name: "Ann" }]);
  assert.deepEqual(knockouts(ins()), [], "a file before version 3 names none");
});

test("clips carry a lead-in, and fall back to a seek", () => {
  assert.deepEqual(clipAround(600), { f0: 300, f1: 1200 });
  assert.deepEqual(clipSpan(100, 900, { x: 5, title: "t" }), { x: 5, title: "t", f0: 0, f1: 1050 });
  assert.equal(watcher({}), null, "no hook: nothing is clickable");
  let seeked = -1;
  watcher({ onSeek: (f) => { seeked = f; } })!({ f0: 42, f1: 99 });
  assert.equal(seeked, 42);
  let clipped: unknown = null;
  watcher({ onSeek: () => {}, onClip: (c) => { clipped = c; } })!({ f0: 1, f1: 2 });
  assert.deepEqual(clipped, { f0: 1, f1: 2 }, "onClip wins over onSeek");
});
