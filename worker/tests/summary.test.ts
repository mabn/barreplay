// The summary library's pure parts: formatting and what it decides it may
// draw. The DOM half is checked against a real page (see worker/README.md).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fmtClock, fmtMetal, niceStep, timeStep } from "../src/summary/format";
import { colorName, comparable, nameRuns, notices, readable, sideColor, sideName } from "../src/summary/model";
import { knockouts, lossesByStep, wipedOf } from "../src/summary/losses";
import { compass, fighters, momentStory } from "../src/summary/moments";
import { clipAround, clipAt, clipSpan, watcher } from "../src/summary/watch";
import { zonesOf } from "../src/summary/zones";
import { clipOf } from "../src/summary/sections/awards";
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
  // #112233 is a dark blue; the second side has no colour of its own.
  assert.equal(sideName(ins(), 0), "Blue team");
  assert.equal(sideName(ins(), 1), "Team 2");
  const red = ins({ sides: [ins().sides[0], { ...ins().sides[1], color: "#ff1010" }] });
  assert.equal(sideName(red, 1), "Red team");
  const twoBlues = ins({ sides: [ins().sides[0], { ...ins().sides[1], color: "#0b3ef3" }] });
  assert.equal(sideName(twoBlues, 0), "Team 1", "two sides are never called the same");
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
  assert.equal(st.detail, "Blue team lost 1 unit (1.2k metal): Commander; Team 2 lost 1 unit (50 metal): Pawn.");
  // Its clip is about the commander's death, where it happened.
  assert.deepEqual(st.focus, { f: 1000, x: 100, z: 100, r: 700 });
  // One big unit is most of the loss.
  st = momentStory(ins({ ...base, deaths: deaths([[1000, 3, 0, 800, 800], [1000, 2, 0, 800, 800]]) }), m);
  assert.equal(st.title, "Blue team loses a Juggernaut in the south-east");
  assert.equal(st.focus?.f, 1000);
  // A lopsided trade of small units is a won fight.
  st = momentStory(ins({ ...base, deaths: deaths(Array.from({ length: 10 }, () => [1000, 2, 0, 450, 450] as [number, number, number, number, number])) }), m);
  assert.equal(st.title, "Team 2 wins the fight in the centre");
  assert.deepEqual(st.focus, { f: 1000, x: 450, z: 450, r: 600 });
  // Nothing died: the armies pulled apart.
  st = momentStory(ins({ ...base, deaths: deaths([]) }), m);
  assert.equal(st.title, "Team 2 out-builds Blue team");
  assert.equal(st.focus, null, "nothing happened at one place");
  // Deaths outside the window (and the step before it) do not count.
  st = momentStory(ins({ ...base, deaths: deaths([[100, 1, 0, 100, 100]]) }), m);
  assert.equal(st.lost[0].n, 0);
  // A player leaving takes their army with them: that names it, and what
  // went down with the team is not counted as lost in the game.
  const pawns = Array.from({ length: 10 }, () => [1100, 2, 0, 450, 450] as [number, number, number, number, number]);
  st = momentStory(ins({ ...base, deaths: deaths(pawns), eliminated: [{ f: 1100, team: 0, recorded: true }] }), m);
  assert.equal(st.title, "Ann is eliminated");
  assert.equal(st.focus?.f, 1100);
  assert.equal(st.focus?.x, 450);
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
  assert.deepEqual(clipAround(600), { at: 600, f0: 0, start: 450, f1: 1200 });
  assert.deepEqual(clipSpan(100, 900, { x: 5, title: "t" }), { x: 5, title: "t", at: 100, f0: 0, start: 0, f1: 1050 });
  // A swing explained by one instant opens 5 s before it, not at the start
  // of the minute the line took to move, and runs on to the swing's end.
  assert.deepEqual(clipAt(2610, 3150), { at: 2610, f0: 1920, start: 2460, f1: 3300 }, "the instant mid-clip, playback 5 s before it");
  assert.deepEqual(clipAt(300, 9000), { at: 300, f0: 0, start: 150, f1: 2100 }, "at most a minute past the instant");
  assert.equal(watcher({}), null, "no hook: nothing is clickable");
  let seeked = -1;
  watcher({ onSeek: (f) => { seeked = f; } })!({ f0: 42, f1: 99 });
  assert.equal(seeked, 42);
  let clipped: unknown = null;
  watcher({ onSeek: () => {}, onClip: (c) => { clipped = c; } })!({ f0: 1, f1: 2 });
  assert.deepEqual(clipped, { f0: 1, f1: 2 }, "onClip wins over onSeek");
});

test("colorName names BAR's team colours", () => {
  assert.deepEqual(["#0b3ef3", "#ff1010", "#0ce908", "#00f5e5", "#ffd000", "#ff8c00", "#a020f0", "#ff69b4", "#808080"].map(colorName),
    ["Blue", "Red", "Green", "Cyan", "Yellow", "Orange", "Purple", "Pink", "Grey"]);
});

test("nameRuns colours whole player and side names only", () => {
  const i = ins({ teams: [{ team: 0, side: 0, player: "Ann", color: "#ffd000" }, { team: 1, side: 1, player: "Annabel", color: "#00f5e5" }] });
  const runs = nameRuns(i, "Annabel's commander falls; Ann lost Annex; Blue team wins");
  assert.deepEqual(runs.map((r) => [r.text, !!r.color]), [
    ["Annabel", true], ["'s commander falls; ", false], ["Ann", true], [" lost Annex; ", false], ["Blue team", true], [" wins", false],
  ]);
  assert.equal(runs[0].color, "#00f5e5");
});

test("a battle names the players who carried it", () => {
  const i = ins({
    teams: [{ team: 0, side: 0, player: "Benz" }, { team: 1, side: 0, player: "Lazy" }, { team: 2, side: 1, player: "Mir" }, { team: 3, side: 1, player: "Para" }, { team: 4, side: 1, player: "Leo" }],
  });
  const b = { f0: 0, f1: 1, x: 0, z: 0, r: 1, lost: [], teams: [
    { team: 0, army: 17572, lost: 18058 }, { team: 1, army: 0, lost: 52 },
    { team: 2, army: 0, lost: 60814 }, { team: 3, army: 4527, lost: 31610 }, { team: 4, army: 1500, lost: 2320 },
  ] };
  const f = fighters(i, b);
  assert.deepEqual(f.map((l) => l.map((x) => x.name)), [["Benz"], ["Mir", "Para"]], "10% of a side's army-plus-losses names a player");
  assert.deepEqual(fighters(i, { ...b, teams: undefined }), [[], []], "an older file names nobody");
});

test("killing zones merge nearby deaths and leave out what was not fought for", () => {
  const rows: [number, number, number, number, number][] = [
    // A fight in the west: both sides lose there.
    [1000, 0, 100, 100, 300], [1100, 1, 120, 90, 100], [1200, 0, 90, 110, 100],
    // A lone loss in the east.
    [5000, 1, 1900, 1900, 50],
    // Team 0 is eliminated at 6000: what goes down after is not a loss.
    [6000, 0, 1900, 100, 999],
  ];
  const i = ins({
    bounds: { minX: 0, maxX: 2000, minZ: 0, maxZ: 2000 },
    teams: [{ team: 0, side: 0, player: "Ann" }, { team: 1, side: 1, player: "Cy" }],
    deaths: { f: rows.map((r) => r[0]), team: rows.map((r) => r[1]), x: rows.map((r) => r[2]), z: rows.map((r) => r[3]),
      cost: rows.map((r) => r[4]), def: rows.map(() => 1), unfinished: rows.map(() => 0) },
    eliminated: [{ f: 6000, team: 0, recorded: true }],
  });
  const { zones } = zonesOf(i);
  assert.equal(zones.length, 2);
  assert.deepEqual(zones[0].lost, [400, 100]);
  assert.deepEqual(zones[0].count, [2, 1]);
  assert.equal(zones[0].peakF0, 1000);
  assert.deepEqual(zones[1].lost, [0, 50]);
  assert.deepEqual(zonesOf(i).totals, [400, 150]);
});

test("an award's clip follows its unit", () => {
  const a = { key: "marathon", label: "Marathon", text: "", team: 0, def: 2, value: 1, f: 900, unit: 77, f0: 300, f1: 900, path: [[300, 1, 1], [900, 5, 5]] as [number, number, number][] };
  const c = clipOf(a, {}, "t");
  assert.deepEqual([c.f0, c.f1, c.follow], [300, 900, { id: 77, def: 2 }], "a life award plays the life");
  const loss = clipOf({ ...a, key: "costliest", f: 3000 }, { x: 4, z: 6 }, "t");
  assert.deepEqual([loss.f0, loss.start, loss.f1, loss.at, loss.x], [2400, 2850, 3600, 3000, 4], "a loss: room to scroll back, playback 5 s before it");
  const old = clipOf({ key: "immortal", label: "", text: "", team: 0, def: 2, value: 1, f: 900 }, {}, "t");
  assert.equal(old.follow, undefined, "an older file names no unit");
});
