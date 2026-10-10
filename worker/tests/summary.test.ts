// The summary library's pure parts: formatting and what it decides it may
// draw. The DOM half is checked against a real page (see worker/README.md).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fmtClock, fmtMetal, niceStep, timeStep } from "../src/summary/format";
import { comparable, notices, sideColor, sideName } from "../src/summary/model";
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
  assert.equal(sideColor(ins(), 0), "#112233");
  assert.match(sideColor(ins(), 1), /^#[0-9a-f]{6}$/);
});
