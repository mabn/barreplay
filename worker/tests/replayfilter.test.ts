// Pins the catalog list's filter contract (src/worker/replayentry.ts): what a
// GET /api/replays query string parses to, and how a game's size is counted.
// The SQL that consumes a ReplayFilter lives in the Durable Object and needs
// workerd to exercise; everything decided BEFORE the query — parsing,
// validation, date handling, the player-count rule — is pure and pinned here.
import assert from "node:assert/strict";
import test from "node:test";

import { derivePlayerCount, emptyFilter, filterIsEmpty, parseReplayFilter } from "../src/worker/replayentry";

const parse = (qs: string) => parseReplayFilter(new URLSearchParams(qs));

test("no params means no restriction", () => {
  assert.deepEqual(parse(""), emptyFilter());
  assert.equal(filterIsEmpty(emptyFilter()), true);
});

test("unknown params are ignored", () => {
  // An older front-end (or a hand-edited URL) must not 400 the listing.
  assert.deepEqual(parse("replay=abc&admin=true&nonsense=1"), emptyFilter());
});

test("every filter parses", () => {
  const f = parse("from=1752000000&to=1752086399&map=Isidis+crack+1.1&minPlayers=8&maxPlayers=16&minDuration=600&maxDuration=3600&id=92488A6A&player=Flash&settings=lava,zombies");
  assert.deepEqual(f, {
    from: 1_752_000_000,
    to: 1_752_086_399,
    map: "Isidis crack 1.1",
    minPlayers: 8,
    minDuration: 600,
    maxDuration: 3600,
    maxPlayers: 16,
    id: "92488a6a", // folded, like the player name: both are byte ranges
    player: "flash", // folded: the index stores names lowercased
    settings: ["lava", "zombies"],
  });
  assert.equal(filterIsEmpty(f as never), false);
});

test("duration bounds are plain seconds, and a long one is allowed", () => {
  // The slider only ever writes 0..3600 — its top thumb means "and longer",
  // so it writes no upper bound at all — but a hand-written URL may reasonably
  // ask for a three-hour game, which the players' 4-digit cap would refuse.
  const f = parse("minDuration=3600&maxDuration=10800") as Exclude<ReturnType<typeof parse>, string>;
  assert.equal(f.minDuration, 3600);
  assert.equal(f.maxDuration, 10800);
  assert.equal(filterIsEmpty(f as never), false);
  // Absent bounds are what "any length" looks like, including the slider's own
  // top end: no maxDuration means nothing is cut off above it.
  const open = parse("minDuration=1200") as Exclude<ReturnType<typeof parse>, string>;
  assert.equal(open.maxDuration, null);
});

test("YYYY-MM-DD dates bound whole UTC days", () => {
  const f = parse("from=2026-08-01&to=2026-08-01");
  assert.notEqual(typeof f, "string");
  const got = f as Exclude<typeof f, string>;
  assert.equal(got.from, Date.UTC(2026, 7, 1) / 1000);
  // The `to` day is INCLUDED — a range whose last day silently dropped out
  // would quietly under-report.
  assert.equal(got.to, Date.UTC(2026, 7, 1) / 1000 + 86399);
  assert.equal(got.to! - got.from!, 86399);
});

test("blank values are not filters", () => {
  assert.deepEqual(parse("map=&player=+&settings=&from=&minPlayers="), emptyFilter());
});

test("settings de-duplicate and keep their order", () => {
  const f = parse("settings=lava,zombies,lava") as Exclude<ReturnType<typeof parse>, string>;
  assert.deepEqual(f.settings, ["lava", "zombies"]);
});

test("malformed params are rejected with a reason", () => {
  for (const qs of [
    "from=yesterday",
    "to=2026-13-99x",
    "minPlayers=-3",
    "minPlayers=1e3",
    "maxPlayers=abc",
    "minDuration=-1",
    "maxDuration=12.5",
    "maxDuration=1234567",         // six digits is the cap; this is a week
    "settings=lava;zombies",       // ; is not a separator, so the flag is invalid
    "settings=" + Array.from({ length: 17 }, (_, i) => `f${i}`).join(","),
  ]) {
    assert.equal(typeof parse(qs), "string", `should reject ${qs}`);
  }
});

test("player count comes from the roster, not the size spec", () => {
  // "8v8v1" is what an 8v8-with-scavengers renders as: GameSizeSpec builds it
  // from the TEAM list, where the scavenger ally survives (that team carries a
  // side/name) even though nobody plays for it. The roster has only the real
  // sides, so it is the authority and this game is 16 players, not 17.
  const roster = [
    { ally: 0, count: 8, players: [{ name: "a" }] },
    { ally: 1, count: 8, players: [{ name: "b" }] },
  ];
  assert.equal(derivePlayerCount(roster, "8v8v1"), 16);
});

test("player count falls back to the size spec without a roster", () => {
  assert.equal(derivePlayerCount(null, "4v4v4v4"), 16);
  assert.equal(derivePlayerCount([], "1v1"), 2);
  assert.equal(derivePlayerCount(null, "8v8"), 16);
});

test("player count is null when nothing can answer", () => {
  assert.equal(derivePlayerCount(null, null), null);
  assert.equal(derivePlayerCount(null, "unknown"), null);
  assert.equal(derivePlayerCount(null, ""), null);
});

// The id filter is a PASTE target: a whole id, the start of one, or (once
// app.js has lifted the hex out of a link) whatever that yielded.
test("a replay id filters as a prefix, folded", () => {
  const id = "92488a6a2807186a199996b9a0712fa5";
  const got = (qs: string) => (parse(qs) as Exclude<ReturnType<typeof parse>, string>).id;
  assert.equal(got(`id=${id}`), id);
  // Uppercase happens (a copy out of a log, a spreadsheet). Ids are stored
  // lowercase and this is a byte range, so it has to be folded.
  assert.equal(got(`id=${id.toUpperCase()}`), id);
  assert.equal(got("id=92488a6a"), "92488a6a");
  assert.equal(got("id=%20%20"), null);
  // Not hex, or longer than an id: both are a paste of the wrong thing, and
  // saying so beats a list that looks like an archive missing the game.
  assert.equal(typeof parse("id=not-an-id"), "string");
  assert.equal(typeof parse(`id=${id}ff`), "string");
});

