// The summary library's pure parts: formatting and what it decides it may
// draw. The DOM half is checked against a real page (see worker/README.md).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fmtClock, fmtMetal, niceStep, timeStep } from "../src/summary/format";
import { colorName, comparable, nameRuns, notices, readable, sideColor, sideName } from "../src/summary/model";
import { knockouts, lossesByStep, wipedOf } from "../src/summary/losses";
import { armyDrop, compass, fighters, gapBattles, momentStories, momentStory } from "../src/summary/moments";
import { clipAround, clipAt, clipEvent, clipSpan, watcher } from "../src/summary/watch";
import { zonesOf } from "../src/summary/zones";
import { lossKinds } from "../src/summary/losskinds";
import { leadPct, ratioDomain } from "../src/summary/series";
import { clipOf } from "../src/summary/sections/awards";
import { battlePhrase, marginPhrase } from "../src/summary/phrases";
import { at, place } from "../src/summary/places";
import type { Insights } from "../src/summary/types";

function ins(over: Partial<Insights> = {}): Insights {
  return {
    version: 9, causes: true, gameId: "g", durationSec: 600, stepSec: 15, costCoverage: "full", pov: "full",
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
  // An older file says what it lacks; a capture without killers says so.
  assert.equal(notices(ins({ version: 5 }))[0], "Outdated report (v5), missing: fitted win odds, game end at the resign, story battles, friendly fire, battle titles that say what did the killing, calmer win odds that move with the fighting. It updates when summaries are recomputed.");
  assert.match(notices(ins({ causes: false }))[0], /does not record killers/);
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
  assert.equal(compass(i, 450, 450), "the middle");
  assert.equal(compass(i, 800, 450), "the east");
  assert.equal(compass(i, 450, 800), "the south");
});

test("armyDrop measures the share of the army a side lost over a window", () => {
  const file = ins({
    series: {
      t: [0, 15, 30, 45, 60], army: [[1000, 1000, 600, 500, 700], [0, 0, 0, 0, 0]], metalIncome: [], energyIncome: [],
      armyCats: ["air", "heavy"], armyByCat: [[[600, 600, 200, 100, 300], [400, 400, 400, 400, 400]], [[], []]],
    },
  });
  // From 1000 at the step before the window to its low of 500: half, and
  // the aircraft are all of it.
  assert.deepEqual(armyDrop(file, 0, 15 * 30, 45 * 30), { share: 0.5, mostly: "aircraft" });
  // Under a quarter is not worth a story.
  assert.equal(armyDrop(file, 0, 45 * 30, 60 * 30), null);
});

test("two swings inside one long battle each tell their own part of it", () => {
  const defs = { "2": { name: "armpw", human: "Pawn", cost: 50 } };
  const rows: [number, number][] = [
    ...Array.from({ length: 10 }, () => [1000, 0] as [number, number]),
    ...Array.from({ length: 6 }, () => [5000, 1] as [number, number]),
  ];
  const file = ins({
    bounds: { minX: 0, maxX: 900, minZ: 0, maxZ: 900 },
    teams: [{ team: 0, side: 0, player: "Ann" }, { team: 1, side: 1, player: "Cy" }],
    defs,
    series: { t: [0, 15, 30, 45], army: [[0, 100, 200, 300], [0, 100, 900, 1200]], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    battles: [{ f0: 900, f1: 5400, x: 450, z: 450, r: 300, lost: [] }],
    deaths: {
      f: rows.map((r) => r[0]), def: rows.map(() => 2), team: rows.map((r) => r[1]), x: rows.map(() => 450), z: rows.map(() => 450),
      cost: rows.map(() => 50), unfinished: rows.map(() => 0),
    },
  });
  const a = { n: 1, f0: 900, f1: 1350, side: 1, delta: 0.3, battle: -1 };
  const b = { n: 2, f0: 4800, f1: 5250, side: 0, delta: -0.3, battle: -1 };
  // Told alone, each would be the whole battle.
  assert.deepEqual(momentStory(file, a).focus, momentStory(file, b).focus);
  const [sa, sb] = momentStories(file, [a, b]);
  assert.notEqual(sa.title, sb.title);
  assert.deepEqual([sa.focus?.f, sa.focus?.f1], [900, 1350 + 450]);
  assert.deepEqual([sb.focus?.f, sb.focus?.f1], [4800 - 450, 5400]);
  assert.match(sa.detail, /Part of a fight from 0:30 to 3:00\.$/);
  // A battle only one moment tells stays whole.
  assert.deepEqual(momentStories(file, [a])[0].focus, momentStory(file, a).focus);
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
  // One Ann blew up herself (a version 5 file marks it) says so.
  const own = deaths([[1000, 1, 0, 100, 100], [1000, 2, 1, 100, 100]]);
  assert.equal(momentStory(ins({ ...base, deaths: { ...own, selfd: [1, 0] } }), m).title, "Ann self-destructs their commander in the north-west");
  assert.equal(st.detail, "Blue team lost 1 unit (1.2k metal): Commander; Team 2 lost 1 unit (50 metal): Pawn.");
  // Its clip is about the commander's death, where it happened.
  assert.deepEqual(st.focus, { f: 1000, x: 100, z: 100, r: 700 });
  // One big unit is most of the loss.
  st = momentStory(ins({ ...base, deaths: deaths([[1000, 3, 0, 800, 800], [1000, 2, 0, 800, 800]]) }), m);
  assert.equal(st.title, "Blue team loses a Juggernaut in the south-east");
  assert.equal(st.focus?.f, 1000);
  const pawns10 = () => Array.from({ length: 10 }, () => [1000, 2, 0, 450, 450] as [number, number, number, number, number]);
  // A lopsided trade of small units is a won fight.
  st = momentStory(ins({ ...base, deaths: deaths(Array.from({ length: 10 }, () => [1000, 2, 0, 450, 450] as [number, number, number, number, number])) }), m);
  assert.equal(st.title, "Team 2 wins the fight in the middle");
  assert.deepEqual(st.focus, { f: 1000, f1: 1000, x: 450, z: 450, r: 600 });
  // With a battle there, the fight is that battle: its span, and only what
  // died inside it — not the pawns lost across the map at the same time.
  const far = Array.from({ length: 10 }, () => [1000, 2, 1, 2000, 2000] as [number, number, number, number, number]);
  st = momentStory(ins({ ...base, deaths: deaths([...pawns10(), ...far.slice(0, 2)]),
    battles: [{ f0: 950, f1: 1300, x: 450, z: 450, r: 200, lost: [] }] }), m);
  assert.deepEqual(st.focus, { f: 950, f1: 1300, x: 450, z: 450, r: 200 });
  assert.match(st.detail, /^There, 0:32–0:43: Blue team lost 10 units/);
  assert.doesNotMatch(st.detail, /lost nothing/, "a side that lost nothing is not mentioned");
  // With no battle, the fight is still the killing at one spot: from its
  // first death in the window to its last (the clip plays all of it), and
  // not what died across the map meanwhile.
  const later = Array.from({ length: 2 }, () => [1200, 2, 0, 500, 500] as [number, number, number, number, number]);
  st = momentStory(ins({ ...base, deaths: deaths([...pawns10(), ...later, ...far.slice(0, 3).map((r) => [r[0], r[1], 0, r[3], r[4]] as typeof r)]) }), m);
  assert.equal(st.focus?.f, 1000);
  assert.equal(st.focus?.f1, 1200);
  assert.match(st.detail, /^There, 0:33–0:40: Blue team lost 12 units/);
  assert.equal(st.shown[0].n, 12);
  assert.equal(st.lost[0].n, 15);
  // The line moved toward a side that lost MORE there: the title states the
  // trade instead of calling it a win.
  const trade = [...pawns10().slice(0, 8), ...Array.from({ length: 16 }, () => [1000, 2, 1, 450, 450] as [number, number, number, number, number])];
  st = momentStory(ins({ ...base, deaths: deaths(trade) }), m);
  assert.equal(st.title, "Team 2 trades 800 metal for 400 metal in the middle");
  // Nothing died: the armies pulled apart.
  st = momentStory(ins({ ...base, deaths: deaths([]) }), m);
  assert.equal(st.title, "Team 2 out-builds Blue team's army");
  assert.equal(st.focus, null, "nothing happened at one place");
  assert.doesNotMatch(st.detail, /lost/, "nobody lost anything, so nobody is said to have");
  // A version 7 file says what carried the shift: income alone names only
  // income, with the numbers the model read; both name both.
  const inc = { ...base, series: { ...base.series, metalIncome: [[5, 5, 5, 5], [5, 5, 20, 30]] } };
  st = momentStory(ins({ ...inc, deaths: deaths([]) }), { ...m, army: 0.1, eco: 0.9 });
  assert.equal(st.title, "Team 2 builds up a bigger economy");
  assert.match(st.detail, /^Metal income over the last minute: Team 2 /);
  assert.doesNotMatch(st.detail, /Army|lost/);
  assert.deepEqual(st.growth?.[1].income, [5, 10]);
  const fell = { ...base, series: { ...base.series, metalIncome: [[20, 20, 4, 4], [5, 5, 5, 5]] } };
  st = momentStory(ins({ ...fell, deaths: deaths([]) }), { ...m, army: 0, eco: 1 });
  assert.equal(st.title, "Blue team loses metal income");
  // A fight the model says did not move the armies' balance (army < 20% of
  // the shift) is not the story, however big: the incomes are, with the
  // fighting a side note and no battle credited.
  st = momentStory(ins({ ...fell, deaths: deaths(trade), battles: [{ f0: 950, f1: 1300, x: 450, z: 450, r: 200, lost: [] }] }), { ...m, army: 0, eco: 1 });
  assert.equal(st.title, "Blue team loses metal income");
  assert.equal(st.battle, -1);
  assert.equal(st.focus, null);
  assert.match(st.detail, /Meanwhile Blue team lost 400 metal in fighting and Team 2 800, which did not tip the armies toward Team 2\.$/);
  // The same trade with the army carrying the shift is still the fight.
  st = momentStory(ins({ ...fell, deaths: deaths(trade) }), { ...m, army: 0.6, eco: 0.4 });
  assert.equal(st.title, "Team 2 trades 800 metal for 400 metal in the middle");
  st = momentStory(ins({ ...inc, deaths: deaths([]) }), { ...m, army: 0.4, eco: 0.6 });
  assert.equal(st.title, "Team 2 out-builds Blue team in army and economy");
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
  assert.deepEqual(knockouts(i), [{ f: 950, team: 0, side: 0, name: "Ann", label: "Ann is eliminated", handoff: false }]);
  assert.equal(knockouts({ ...i, eliminated: [{ f: 950, team: 0, recorded: false, to: 1 }] })[0].label, `Ann leaves, handing their units to ${i.teams.find((t) => t.team === 1)?.player ?? "Team 1"}`);
  assert.deepEqual(knockouts(ins()), [], "a file before version 3 names none");
});

test("clips carry a lead-in, and fall back to a seek", () => {
  assert.deepEqual(clipAround(600), { at: 600, f0: 0, start: 450, f1: 1200 });
  assert.deepEqual(clipSpan(100, 900, { x: 5, title: "t" }), { x: 5, title: "t", at: 100, f0: 0, start: 0, f1: 1050 });
  // A swing explained by one instant opens 5 s before it, not at the start
  // of the minute the line took to move, and runs on to the swing's end.
  assert.deepEqual(clipAt(2610, 3150), { at: 2610, f0: 1920, start: 2460, f1: 3300 }, "the instant mid-clip, playback 5 s before it");
  assert.deepEqual(clipAt(300, 9000), { at: 300, f0: 0, start: 150, f1: 2100 }, "at most a minute past the instant");
  // An event with an end plays all of it, however long, marked as a band.
  assert.deepEqual(clipEvent(3000, 6600), { at: 3000, atEnd: 6600, f0: 2400, start: 2850, f1: 6750 });
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

test("lossKinds merges defs sharing an icon and keeps 90% of the metal up front", () => {
  const units = [
    { def: 1, n: 2, metal: 600 }, // fighter A
    { def: 2, n: 3, metal: 300 }, // fighter B, same icon
    { def: 3, n: 1, metal: 50 }, // jammer
    { def: 4, n: 2, metal: 20 }, // walls
  ];
  const icon: Record<number, string> = { 1: "fighter", 2: "fighter", 3: "jammer", 4: "wall" };
  const { main, rest } = lossKinds(units, (u) => icon[u.def]);
  assert.deepEqual(main.map((g) => [g.key, g.n, g.metal]), [["fighter", 5, 900]]);
  assert.deepEqual(rest.map((g) => g.key), ["jammer", "wall"]);
  // Unpriced losses split by count; one kind always shows.
  const unpriced = lossKinds([{ def: 1, n: 1, metal: 0 }], (u) => String(u.def));
  assert.equal(unpriced.main.length, 1);
  assert.equal(unpriced.rest.length, 0);
});

test("embed: findInsights resolves the game's revision and the newest insights file", async (t) => {
  const { findInsights, replayLink } = await import("../src/summary/embed.ts");
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/replays?id=")) {
      return Response.json([
        { id: "aaaa0000", rid: "2026-10/aaaa0000", placeholder: false }, // the asked game
        { id: "aaaa00001", rid: "x", placeholder: false },                // a longer id with the same prefix
      ]);
    }
    if (url.endsWith(".insights4.json")) return new Response("", { status: 404 });
    if (url.endsWith(".insights3.json")) return Response.json({ version: 3, gameId: "aaaa0000" });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const ins = await findInsights("aaaa0000", { replayOrigin: "https://r.test", dataOrigin: "https://d.test" });
  assert.equal(ins?.version, 3);
  assert.ok(urls.includes("https://d.test/replays/2026-10/aaaa0000.insights3.json"), urls.join("\n"));
  assert.equal(replayLink("aaaa0000", 4500.4, "https://r.test"), "https://r.test/replays/aaaa0000?f=4500");
  assert.equal(replayLink("aaaa0000", 0, "https://r.test"), "https://r.test/replays/aaaa0000");
});

test("embed: a game with no published replay has no summary", async (t) => {
  const { findInsights } = await import("../src/summary/embed.ts");
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async () => Response.json([{ id: "bbbb", rid: null, placeholder: true }])) as unknown as typeof fetch;
  assert.equal(await findInsights("bbbb"), null);
});

test("leadPct reads the leader's margin both ways", () => {
  const r = leadPct([100, 120, 0, 0], [120, 100, 0, 50], 0.0001);
  assert.ok(Math.abs(r[0] - 20) < 0.01); // b 20% bigger
  assert.ok(Math.abs(r[1] + 20) < 0.01); // a 20% bigger
  assert.equal(Math.round(r[2]), 0); // both empty: even
  // Smoothing keeps an opening lead finite.
  const s = leadPct([0], [300], 300);
  assert.equal(Math.round(s[0]), 100);
});

test("gapBattles fills a long stretch with no swing with its biggest battles", () => {
  const F = 30;
  const battle = (min: number, a: number, b: number) => ({ f0: min * 60 * F, f1: (min * 60 + 30) * F, x: 0, z: 0, r: 500,
    lost: [{ n: 1, metal: a, top: [] }, { n: 1, metal: b, top: [] }] });
  const steps = Array.from({ length: 40 }, (_, i) => i * 60);
  const file = ins({
    durationSec: 2400, stepSec: 60,
    series: { t: steps, army: [], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    battles: [battle(3, 5000, 4000), battle(15, 60000, 3000), battle(16, 500, 500), battle(25, 20000, 19500), battle(31, 4000, 6000)],
    swing: { p: steps.map((_, i) => (i < 15 ? 0.5 : 0.3)), moments: [
      { n: 1, f0: 3 * 60 * F, f1: 4 * 60 * F, side: 0, delta: 0.2, battle: 0 },
      { n: 2, f0: 34 * 60 * F, f1: 35 * 60 * F, side: 1, delta: 0.2, battle: -1 },
    ], fitted: false },
  } as Partial<Insights>);
  const got = gapBattles(file, file.swing!.moments, momentStories(file, file.swing!.moments));
  // The 30-minute gap takes the 15-minute rout first, then the even trade
  // at 25 and the small one at 31; the tiny one at 16 is not worth a line,
  // and battle 1 overlaps a swing.
  assert.deepEqual(got.map((g) => [g.battle, g.side, g.verdict]), [[1, 1, "decisive"], [3, -1, "even"], [4, 0, "win"]]);
  assert.ok(got[0].delta > 0.15, "the line moved toward the side that won it");
});

test("gapBattles tells only decisive battles with real losses in the opening", () => {
  const F = 30;
  const battle = (min: number, a: number, b: number) => ({ f0: min * 60 * F, f1: (min * 60 + 30) * F, x: 0, z: 0, r: 500,
    lost: [{ n: 1, metal: a, top: [] }, { n: 1, metal: b, top: [] }] });
  const steps = Array.from({ length: 40 }, (_, i) => i * 60);
  const file = ins({
    durationSec: 2400, stepSec: 60,
    series: { t: steps, army: [steps.map(() => 4000), steps.map(() => 4000)], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    battles: [
      battle(2, 300, 2500), // decisive, 2.5k of a 4k army: told
      battle(5, 1500, 2500), // not by a large margin, but half of both armies: a story
      battle(8, 0, 600), // decisive but trivial
      battle(10, 2000, 200), // decisive: told
      battle(20, 30000, 29000), // past the opening: fills the gap as before
    ],
    swing: { p: steps.map(() => 0.5), moments: [], fitted: false },
  } as Partial<Insights>);
  const got = gapBattles(file, [], []);
  assert.deepEqual(got.map((g) => [g.battle, g.side, g.verdict]), [[0, 0, "decisive"], [1, 0, "win"], [3, 1, "decisive"], [4, -1, "even"]]);
});

test("gapBattles leaves a battle inside a swing told over its whole window to that swing", () => {
  const F = 30;
  const battle = (min: number, a: number, b: number) => ({ f0: min * 60 * F, f1: (min * 60 + 30) * F, x: 0, z: 0, r: 500,
    lost: [{ n: 1, metal: a, top: [] }, { n: 1, metal: b, top: [] }] });
  const steps = Array.from({ length: 40 }, (_, i) => i * 60);
  const file = ins({
    durationSec: 2400, stepSec: 60,
    series: { t: steps, army: [steps.map(() => 4000), steps.map(() => 4000)], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    // A short, costly story battle in the middle of a swing's minute.
    battles: [battle(30, 3000, 300)],
    swing: { p: steps.map(() => 0.5), moments: [], fitted: false },
  } as Partial<Insights>);
  const m = { n: 1, f0: 30 * 60 * F, f1: 31 * 60 * F, side: 1, delta: 0.2, battle: -1 };
  const lost: never[] = [];
  const whole = { shown: lost, lost, growth: null, focus: { f: 30 * 60 * F }, battle: -1 } as unknown as ReturnType<typeof momentStory>;
  assert.deepEqual(gapBattles(file, [m], [whole]), [], "the swing's story already counts its deaths");
  const built = { ...whole, growth: [] } as unknown as ReturnType<typeof momentStory>;
  assert.equal(gapBattles(file, [m], [built]).length, 1, "a swing told on what was built covers no fight");
});

test("gapBattles judges a battle by worth: lost power plants count 2.5x", () => {
  const F = 30;
  const steps = Array.from({ length: 40 }, (_, i) => i * 60);
  // Side 0 lost less metal, but 1000 of it was a fusion (worth 2500).
  const file = ins({
    durationSec: 2400, stepSec: 60,
    series: { t: steps, army: [steps.map(() => 4000), steps.map(() => 4000)], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    battles: [{ f0: 20 * 60 * F, f1: (20 * 60 + 30) * F, x: 0, z: 0, r: 500,
      lost: [{ n: 3, metal: 1500, worth: 3000, top: [] }, { n: 9, metal: 2000, worth: 2000, top: [] }] }],
    swing: { p: steps.map(() => 0.5), moments: [], fitted: false },
  } as Partial<Insights>);
  assert.deepEqual(gapBattles(file, [], []).map((g) => [g.side, g.verdict]), [[1, "win"]]);
});

test("gapBattles' metal floors read plain metal, not worth", () => {
  const F = 30;
  const steps = Array.from({ length: 40 }, (_, i) => i * 60);
  const lost = (metal: number, worth = metal) => ({ n: 4, metal, worth, top: [] });
  const at = (min: number) => ({ f0: min * 60 * F, f1: (min * 60 + 5) * F, x: 0, z: 0, r: 500 });
  const file = ins({
    durationSec: 2400, stepSec: 60,
    series: { t: steps, army: [steps.map(() => 1000), steps.map(() => 1000)], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [] },
    battles: [
      // 440 metal of wind turbines (worth 1100) against 300: not decisive, not a story.
      { ...at(5), lost: [lost(300), lost(440, 1100)] },
      // Past the opening, the game's only other battle: too small to fill a gap.
      { ...at(20), lost: [lost(900), lost(200)] },
    ],
    swing: { p: steps.map(() => 0.5), moments: [], fitted: false },
  } as Partial<Insights>);
  assert.deepEqual(gapBattles(file, [], []), []);
});

test("ratioDomain scales to the leads from 40% to 95% of the game", () => {
  const t = Array.from({ length: 100 }, (_, i) => i * 10); // a 1000 s game
  // Thousands of percent at the start and the very end, -30..+60 between.
  const lead = t.map((s) => (s < 400 ? 3000 : s > 950 ? -5000 : s < 700 ? -30 : 60));
  const [lo, hi] = ratioDomain(t, lead, 1000);
  assert.ok(lo < -30 && lo > -40, `lo ${lo}`);
  assert.ok(hi > 60 && hi < 70, `hi ${hi}`);
  // Zero is always on the axis, and an even game still has some height.
  const [a, b] = ratioDomain(t, t.map(() => 1), 1000);
  assert.ok(a < 0 && b > 1 && b - a >= 10);
});

test("battle phrases say what did the killing, and only when the numbers are sure", () => {
  const defs = {
    "1": { name: "armthund", human: "Thunder", cost: 150, class: "bomber" },
    "2": { name: "cormex", human: "Metal Extractor", cost: 50, class: "eco" },
    "3": { name: "corjugg", human: "Behemoth", cost: 40000, class: "experimental" },
    "4": { name: "corak", human: "Grunt", cost: 40, class: "army" },
    "5": { name: "armllt", human: "Sentry", cost: 85, class: "defence" },
    "6": { name: "corlab", human: "Bot Lab", cost: 1500, class: "factory" },
    "7": { name: "armfig", human: "Falcon", cost: 80, class: "fighter" },
    "8": { name: "corwin", human: "Wind Turbine", cost: 40, class: "building" },
  };
  const g = ins({
    defs,
    sides: [{ ally: 0, teams: [0], players: ["Ann"], color: "#0000ff" }, { ally: 1, teams: [1], players: ["Cy"], color: "#ff0000" }],
    teams: [{ team: 0, side: 0, player: "Ann" }, { team: 1, side: 1, player: "Cy" }] as Insights["teams"],
  });
  const battle = (lost1: { def: number; n: number; metal: number }[], by: { def: number; n: number; metal: number; units: number }[], lost0 = 0) => ({
    f0: 0, f1: 300, x: 0.5, z: 0.5, r: 100,
    lost: [
      { n: lost0 ? 1 : 0, metal: lost0, top: [] },
      { n: lost1.reduce((a, u) => a + u.n, 0), metal: lost1.reduce((a, u) => a + u.metal, 0), top: [], units: lost1, by: by.map((k) => ({ team: 0, ...k })) },
    ],
    teams: [{ team: 0, army: 0, lost: lost0, killed: 0 }, { team: 1, army: 0, lost: lost1.reduce((a, u) => a + u.metal, 0), killed: 0 }],
  });
  const where = "in the middle";
  // Bombers taking out buildings bomb the base; a big haul levels it, and
  // one player losing nearly all of it is named.
  assert.equal(battlePhrase(g, battle([{ def: 2, n: 40, metal: 2000 }], [{ def: 1, n: 40, metal: 2000, units: 6 }]), 0, where), "Blue Thunders bomb Cy's base");
  assert.equal(battlePhrase(g, battle([{ def: 8, n: 600, metal: 24000 }], [{ def: 1, n: 600, metal: 24000, units: 20 }]), 0, where), "Blue Thunders level Cy's base");
  // One experimental doing the killing: the verb agrees with one of it.
  assert.equal(battlePhrase(g, battle([{ def: 4, n: 100, metal: 4000 }], [{ def: 3, n: 100, metal: 4000, units: 1 }], 500), 0, where), "Blue Behemoth stomps through the Red army in the middle");
  // A failed bombing run is the bombers' own loss; fighters intercept it.
  assert.equal(battlePhrase(g, battle([{ def: 1, n: 20, metal: 3000 }], [{ def: 7, n: 20, metal: 3000, units: 8 }]), 0, where), "Blue Falcons intercept the Red Thunders");
  // Defences hold only when the attack plainly failed.
  const held = battle([{ def: 4, n: 50, metal: 2000 }], [{ def: 5, n: 50, metal: 2000, units: 5 }], 500);
  assert.equal(battlePhrase(g, held, 0, where), "Blue Sentries hold off a Red attack in the middle");
  assert.equal(battlePhrase(g, battle([{ def: 4, n: 50, metal: 2000 }], [{ def: 5, n: 50, metal: 2000, units: 5 }], 1800), 0, where), null);
  // A swarm of cheap units.
  assert.equal(battlePhrase(g, battle([{ def: 5, n: 30, metal: 2550 }], [{ def: 4, n: 30, metal: 2550, units: 60 }]), 0, where), "Blue Grunts swarm Red in the middle");
  assert.equal(battlePhrase(g, battle([{ def: 5, n: 300, metal: 25500 }], [{ def: 4, n: 300, metal: 25500, units: 600 }]), 0, where), "A swarm of Blue Grunts overwhelms Red in the middle");
  // A lab that was a real part of the loss names the battle.
  assert.equal(battlePhrase(g, battle([{ def: 6, n: 1, metal: 1500 }, { def: 4, n: 10, metal: 400 }], []), 0, where), "Blue destroys Cy's Bot Lab in the middle");
  // Killers unknown for most of the loss: nothing but the margin is sure.
  assert.equal(battlePhrase(g, battle([{ def: 2, n: 40, metal: 2000 }], [{ def: 1, n: 10, metal: 500, units: 2 }]), 0, where), null);
  // The side that lost MORE is never the subject of a phrase.
  assert.equal(battlePhrase(g, battle([{ def: 2, n: 40, metal: 2000 }], [{ def: 1, n: 40, metal: 2000, units: 6 }], 2500), 0, where), null);
  // Margin words rotate by battle number and scale with the fight: a 2.8k
  // kill for 628 is a skirmish won, not Red overwhelmed (Marcin's screenshot).
  const small = battle([{ def: 4, n: 70, metal: 2800 }], [], 628);
  assert.equal(marginPhrase(g, small, 0, 0, true, where, true), "Blue wins a skirmish in the middle");
  assert.equal(marginPhrase(g, small, 1, 0, true, where, true), "Blue picks off Red units in the middle");
  const mid = battle([{ def: 4, n: 200, metal: 8000 }], [], 2000);
  assert.equal(marginPhrase(g, mid, 0, 0, true, where, true), "Blue decisively wins in the middle");
  assert.equal(marginPhrase(g, mid, 1, 0, true, where, true), "Blue outfights Red in the middle");
  const big = battle([{ def: 4, n: 750, metal: 30000 }], [], 8000);
  assert.equal(marginPhrase(g, big, 0, 0, true, where, true), "Blue overwhelms Red in the middle");
  // A lopsided result is a crush only when the fight was a real one.
  assert.equal(marginPhrase(g, battle([{ def: 4, n: 300, metal: 12000 }], [], 100), 0, 0, true, where, true), "Blue crushes Red in the middle");
  assert.equal(marginPhrase(g, battle([{ def: 4, n: 50, metal: 2000 }], [], 100), 0, 0, true, where, true), "Blue wins a skirmish in the middle");
  // Bloody needs real losses on both sides.
  assert.equal(marginPhrase(g, battle([{ def: 4, n: 300, metal: 12000 }], [], 11000), 0, -1, false, where, true), "Bloody stalemate in the middle: both sides lose ~11.5k metal");
  assert.equal(marginPhrase(g, battle([{ def: 4, n: 50, metal: 2000 }], [], 800), 0, -1, false, where, true), "Even trade in the middle");
});

test("Supreme Isthmus areas go by the names players use", () => {
  const g = ins({
    mapName: "Supreme Isthmus v2.1",
    sides: [{ ally: 0, teams: [0], players: ["Ann"], color: "#0000ff" }, { ally: 1, teams: [1], players: ["Cy"], color: "#ff0000" }],
    series: { t: [0], army: [], metalIncome: [], energyIncome: [], armyCats: [], armyByCat: [], front: [[null, [2000, 10500]], [[10500, 2000]]] },
  });
  // Blue started south-west, so the south-west base areas are Blue's and
  // their north-east twins Red's.
  assert.equal(at(g, 0.387 * 12288, 0.787 * 12288), "at Blue geo");
  assert.equal(at(g, (1 - 0.387) * 12288, (1 - 0.787) * 12288), "at Red geo");
  assert.equal(at(g, 0.19 * 12288, 0.95 * 12288), "at Blue air");
  assert.deepEqual(place(g, 6300, 6200), { name: "the middle", prep: "in", side: -1 });
  assert.equal(at(g, 900, 1800), "on the north island");
  assert.equal(at(g, 9000, 9000), "in the south sea");
  // Without knowing who started where, a base is told by the compass.
  assert.equal(at({ ...g, bounds: { minX: 0, maxX: 12288, minZ: 0, maxZ: 12288 }, series: { ...g.series, front: [] } }, 0.387 * 12288, 0.787 * 12288), "in the south");
});
