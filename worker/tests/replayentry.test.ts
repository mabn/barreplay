// Pins the PUT /api/replays/<id> body validation (src/worker/replayentry.ts):
// what a well-formed upsert normalizes to, and that malformed ids/bodies are
// rejected with a reason instead of being coerced into the catalog.
import assert from "node:assert/strict";
import test from "node:test";

import { mergeUploads, parseViewRequest, playersFromApi, sanitizeEntry, settingsFlags } from "../src/worker/replayentry";

test("full entry passes through", () => {
  const e = sanitizeEntry("abc123", {
    rid: "abc123-1a2b3c4d",
    startUnix: 1_752_000_000,
    durationSec: 1987,
    map: "Isidis crack 1.1",
    gameSize: "8v8",
    sizeBytes: 8_400_000,
    settings: { ranked: true, lava: true, quickStart: "enabled" },
    players: [
      { ally: 0, count: 8, players: [{ name: "alpha", os: 35.2 }, { name: "beta" }] },
      { ally: 1, count: 8, players: [{ name: "gamma", os: 28 }] },
    ],
    uploaderAlly: 1,
    widgetVersion: "1.7.0",
    widgetSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
    widgetDate: "2026-08-16",
  });
  assert.deepEqual(e, {
    id: "abc123",
    rid: "abc123-1a2b3c4d",
    startUnix: 1_752_000_000,
    durationSec: 1987,
    map: "Isidis crack 1.1",
    gameSize: "8v8",
    sizeBytes: 8_400_000,
    settings: { ranked: true, lava: true, quickStart: "enabled" },
    players: [
      { ally: 0, count: 8, players: [{ name: "alpha", os: 35.2 }, { name: "beta" }] },
      { ally: 1, count: 8, players: [{ name: "gamma", os: 28 }] },
    ],
    // Derived from the roster's counts, not read from the body.
    playerCount: 16,
    uploaderAlly: 1,
    uploads: null,
    view: null,
    // The widget build that produced the capture, straight off its GAME line.
    widgetVersion: "1.7.0",
    widgetSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
    widgetDate: "2026-08-16",
  });
});

test("missing stats become null, unknown fields are dropped", () => {
  const e = sanitizeEntry("abc", { map: "Hooked 1.1.1", bogus: 42 });
  assert.deepEqual(e, {
    id: "abc",
    rid: null,
    startUnix: null,
    durationSec: null,
    map: "Hooked 1.1.1",
    gameSize: null,
    sizeBytes: null,
    settings: null,
    players: null,
    playerCount: null, // no roster and no size spec to count from
    uploaderAlly: null,
    uploads: null,
    view: null,
    widgetVersion: null,
    widgetSha: null,
    widgetDate: null,
  });
});

test("rid is validated like an id", () => {
  assert.equal(sanitizeEntry("abc", { rid: "a/b" }), "invalid rid");
  assert.equal(sanitizeEntry("abc", { rid: 7 }), "invalid rid");
  assert.equal(sanitizeEntry("abc", { rid: "" }), "invalid rid");
  const e = sanitizeEntry("abc", { rid: null });
  assert.ok(typeof e === "object" && e.rid === null);
});

test("settings: empty object becomes null, bad shapes are rejected", () => {
  const empty = sanitizeEntry("abc", { settings: {} });
  assert.ok(typeof empty === "object" && empty.settings === null);
  assert.equal(sanitizeEntry("abc", { settings: [1] }), "settings must be a JSON object");
  assert.equal(sanitizeEntry("abc", { settings: "ranked" }), "settings must be a JSON object");
  assert.equal(sanitizeEntry("abc", { settings: { ranked: 1 } }), "settings.ranked must be a boolean or string");
  assert.equal(sanitizeEntry("abc", { settings: { nested: { a: 1 } } }), "settings.nested must be a boolean or string");
  const manyKeys = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, true]));
  assert.equal(sanitizeEntry("abc", { settings: manyKeys }), "settings must have at most 32 keys");
  const huge = { blob: "x".repeat(3000) };
  assert.equal(sanitizeEntry("abc", { settings: huge }), "settings must serialize to at most 2048 bytes");
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

test("players roster: empty becomes null, bad shapes are rejected, caps hold", () => {
  const empty = sanitizeEntry("abc", { players: [] });
  assert.ok(typeof empty === "object" && empty.players === null);
  assert.equal(sanitizeEntry("abc", { players: {} }), "players must be an array");
  assert.equal(sanitizeEntry("abc", { players: [7] }), "players entries must be objects");
  assert.equal(sanitizeEntry("abc", { players: [{ ally: "x", count: 1, players: [] }] }), "players[].ally must be an integer");
  assert.equal(sanitizeEntry("abc", { players: [{ ally: 0, count: 1, players: [{ name: "" }] }] }), "player name must be a non-empty string");
  assert.equal(sanitizeEntry("abc", { players: [{ ally: 0, count: 1, players: [{ name: "a", os: "35" }] }] }), "player os must be a finite number");
  // The per-ally cap is a FILTER limit (a name not stored cannot be filtered
  // on), so it sits above the largest side BAR fields rather than at the
  // handful of names the list prints.
  const tooDeep = [{ ally: 0, count: 33, players: Array.from({ length: 33 }, (_, i) => ({ name: `p${i}` })) }];
  assert.equal(sanitizeEntry("abc", { players: tooDeep }), "players[].players must be an array of at most 32");
  const bigSide = [{ ally: 0, count: 25, players: Array.from({ length: 25 }, (_, i) => ({ name: `p${i}` })) }];
  assert.ok(typeof sanitizeEntry("abc", { players: bigSide }) === "object", "a 25v25 side must fit");
  const manyAllies = Array.from({ length: 17 }, (_, i) => ({ ally: i, count: 1, players: [{ name: "p" }] }));
  assert.equal(sanitizeEntry("abc", { players: manyAllies }), "players must have at most 16 ally teams");
});

test("uploaderAlly must be an integer; uploads from the body are ignored", () => {
  assert.equal(sanitizeEntry("abc", { uploaderAlly: 1.5 }), "uploaderAlly must be an integer");
  assert.equal(sanitizeEntry("abc", { uploaderAlly: "0" }), "uploaderAlly must be an integer");
  const e = sanitizeEntry("abc", { uploaderAlly: 0, uploads: [{ rid: "forged-00000000", ally: 3 }] });
  assert.ok(typeof e === "object" && e.uploaderAlly === 0 && e.uploads === null);
});

// A live upload's own stream names the side that recorded it, so the publish
// PUT carries the marking and the viewer's POV control shows it filled in
// without anyone touching it. Refusing view here (leaving it to setView alone)
// is what forced every fresh upload to be marked by hand.
test("view is taken from the publishing PUT when it states one", () => {
  const live = sanitizeEntry("abc", { uploaderAlly: 2, view: "ally" });
  assert.ok(typeof live === "object" && live.view === "ally" && live.uploaderAlly === 2);
  const resim = sanitizeEntry("abc", { view: "full" });
  assert.ok(typeof resim === "object" && resim.view === "full" && resim.uploaderAlly === null);
  // Silence is "nothing to say" — upsert COALESCEs, so it keeps any marking.
  const quiet = sanitizeEntry("abc", {});
  assert.ok(typeof quiet === "object" && quiet.view === null);
});

test("view rejects unknown values and an ally view with no side", () => {
  assert.equal(sanitizeEntry("abc", { view: "spectator" }), `view must be one of "full", "ally", "unknown"`);
  assert.equal(sanitizeEntry("abc", { view: 1 }), `view must be one of "full", "ally", "unknown"`);
  assert.equal(sanitizeEntry("abc", { view: "ally" }), `view "ally" requires uploaderAlly`);
});

test("mergeUploads accumulates revisions oldest-first, idempotently", () => {
  assert.equal(mergeUploads(null, null, 1), null);
  assert.deepEqual(mergeUploads(null, "g-11111111", 0), [{ rid: "g-11111111", ally: 0 }]);
  const two = mergeUploads([{ rid: "g-11111111", ally: 0 }], "g-22222222", 1);
  assert.deepEqual(two, [
    { rid: "g-11111111", ally: 0 },
    { rid: "g-22222222", ally: 1 },
  ]);
  // Re-publishing the same rid does not duplicate; a now-known ally refreshes.
  assert.deepEqual(mergeUploads(two, "g-22222222", null), two);
  assert.deepEqual(mergeUploads([{ rid: "g-11111111", ally: null }], "g-11111111", 2), [{ rid: "g-11111111", ally: 2 }]);
});

// The row's widget columns describe only the revision it currently points at,
// so the per-revision history has to live here: a game re-published from
// another capture (a re-sim, a teammate's upload) must not take the earlier
// upload's widget down with it.
test("mergeUploads keeps each revision's widget build", () => {
  const w = { version: "1.7.0", sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736", date: "2026-08-16" };
  const first = mergeUploads(null, "g-11111111", 0, w);
  assert.deepEqual(first, [{ rid: "g-11111111", ally: 0, widget: w }]);

  // A re-sim revision knows no widget: it appends bare and leaves the earlier
  // entry's provenance alone.
  const resim = mergeUploads(first, "g-22222222", null, {});
  assert.deepEqual(resim, [
    { rid: "g-11111111", ally: 0, widget: w },
    { rid: "g-22222222", ally: null },
  ]);

  // Re-publishing a revision refreshes what it now knows and keeps the rest.
  const older = { version: "1.6.0" };
  assert.deepEqual(mergeUploads([{ rid: "g-33333333", ally: 1, widget: older }], "g-33333333", 1, w), [
    { rid: "g-33333333", ally: 1, widget: w },
  ]);
  assert.deepEqual(mergeUploads([{ rid: "g-33333333", ally: 1, widget: older }], "g-33333333", 1, null), [
    { rid: "g-33333333", ally: 1, widget: older },
  ]);
});

test("the widget build rides the publishing PUT", () => {
  const sha = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736";
  const e = sanitizeEntry("abc", { widgetVersion: "1.7.0", widgetSha: sha, widgetDate: "2026-08-16" });
  assert.ok(typeof e === "object");
  assert.equal(e.widgetVersion, "1.7.0");
  assert.equal(e.widgetSha, sha);
  assert.equal(e.widgetDate, "2026-08-16");

  // An unstamped widget (installed from the repo, never published) simply has
  // no SHA — that must stay a publishable capture, not a rejected one.
  const unstamped = sanitizeEntry("abc", { widgetVersion: "1.7.0", widgetDate: "2026-08-16" });
  assert.ok(typeof unstamped === "object" && unstamped.widgetSha === null && unstamped.widgetVersion === "1.7.0");

  // Silence keeps whatever the row has (upsert COALESCEs these three).
  const quiet = sanitizeEntry("abc", {});
  assert.ok(typeof quiet === "object" && quiet.widgetVersion === null && quiet.widgetDate === null);
  // An empty string is silence too, not a value that would blank the column.
  const blank = sanitizeEntry("abc", { widgetVersion: "", widgetSha: "", widgetDate: "" });
  assert.ok(typeof blank === "object" && blank.widgetVersion === null && blank.widgetSha === null);
});

// The SHA is the one field meant to be matched against a git history, so a
// value that could never match one is rejected rather than stored.
test("widgetSha must look like a git SHA", () => {
  assert.equal(sanitizeEntry("abc", { widgetSha: "not-a-sha" }), "widgetSha must be a lowercase hex git SHA");
  assert.equal(sanitizeEntry("abc", { widgetSha: "__WIDGET_SHA__" }), "widgetSha must be a lowercase hex git SHA");
  assert.equal(sanitizeEntry("abc", { widgetSha: "0F1E2D3C4B5A69788796A5B4C3D2E1F009182736" }),
    "widgetSha must be a lowercase hex git SHA");
  assert.equal(sanitizeEntry("abc", { widgetSha: 7 }), "widgetSha must be a string");
  assert.equal(sanitizeEntry("abc", { widgetVersion: 7 }), "widgetVersion must be a string");
  // A short-but-plausible SHA is fine: `git describe`-style prefixes exist.
  const short = sanitizeEntry("abc", { widgetSha: "0f1e2d3" });
  assert.ok(typeof short === "object" && short.widgetSha === "0f1e2d3");
});

// The TypeScript twin of viz.SettingsFlags (internal/viz/catalog.go): the
// same defaults stay silent and the same notable values map to the same keys.
test("settingsFlags mirrors the Go distillation", () => {
  assert.equal(settingsFlags({}), null);
  assert.equal(
    settingsFlags({
      map_waterislava: "0", scavunitsforplayers: "0", experimentalextraunits: "0",
      unit_restrictions_nonukes: "0", unit_restrictions_noair: "0",
      quick_start: "default", commanderbuildersenabled: "disabled",
      zombies: "disabled", ruins: "scav_only", tweakdefs: "", tweakunits9: "",
    }),
    null,
  );
  const cases: [Record<string, string>, string, boolean | string][] = [
    [{ ranked_game: "1" }, "ranked", true],
    [{ ranked_game: "0" }, "unranked", true],
    [{ map_waterislava: "1" }, "lava", true],
    [{ scavunitsforplayers: "1" }, "scavUnits", true],
    [{ experimentalextraunits: "1" }, "extraUnits", true],
    [{ unit_restrictions_nonukes: "1" }, "noNukes", true],
    [{ unit_restrictions_noendgamelrpc: "1" }, "noEndgameLrpc", true],
    [{ unit_restrictions_nolrpc: "1" }, "noLrpc", true],
    [{ unit_restrictions_noair: "1" }, "noAir", true],
    [{ tweakdefs: "Zm9v" }, "mods", true],
    [{ tweakunits3: "Zm9v" }, "mods", true],
    [{ quick_start: "enabled" }, "quickStart", "enabled"],
    [{ commanderbuildersenabled: "enabled_all" }, "comBuilders", "enabled_all"],
    [{ zombies: "normal" }, "zombies", true],
    [{ zombies: "nightmare" }, "zombies", "nightmare"],
    [{ ruins: "enabled" }, "ruins", true],
  ];
  for (const [mo, key, want] of cases) {
    assert.deepEqual(settingsFlags(mo), { [key]: want }, JSON.stringify(mo));
  }
});

// playersFromApi rebuilds the players column from the BAR API's AllyTeams:
// same shape and same CATALOG_PLAYERS_PER_ALLY cap as viz.BuildCatalogEntry's
// .brp-derived roster. This route is also the backfill for rows published
// under the old cap of 5, so it must keep EVERY name the API reports.
test("playersFromApi: allies ascend, humans sort by OS, AIs follow", () => {
  assert.equal(playersFromApi(undefined), null);
  assert.equal(playersFromApi([]), null);
  assert.equal(playersFromApi([{ allyTeamId: 0, Players: [], AIs: [] }]), null);

  const got = playersFromApi([
    {
      allyTeamId: 1,
      Players: [
        { name: "f", skill: "[10.00]" }, { name: "e", skill: "[50.00]" },
        { name: "d", skill: "[20.00]" }, { name: "c", skill: "[30.00]" },
        { name: "b", skill: null }, { name: "a", skill: "[40.00]" },
      ],
      AIs: [],
    },
    { allyTeamId: 0, Players: [{ name: "human", skill: 25 }], AIs: [{ shortName: "RaptorsAI", name: "RaptorsDefenseAI(1)" }] },
    { allyTeamId: "bogus", Players: [{ name: "dropped" }] },
  ]);
  assert.deepEqual(got, [
    // Six slots on ally 1 -> count 6 and all six kept; the unrated player
    // sorts last but is still stored, so the list can be filtered by them.
    { ally: 0, count: 2, players: [{ name: "human", os: 25 }, { name: "RaptorsAI" }] },
    {
      ally: 1,
      count: 6,
      players: [
        { name: "e", os: 50 }, { name: "a", os: 40 }, { name: "c", os: 30 },
        { name: "d", os: 20 }, { name: "f", os: 10 }, { name: "b" },
      ],
    },
  ]);
});

test("ids are confined to a bare token", () => {
  assert.equal(sanitizeEntry("", {}), "invalid replay id");
  assert.equal(sanitizeEntry("a/b", {}), "invalid replay id");
  assert.equal(sanitizeEntry("..", {}), "invalid replay id");
  assert.equal(sanitizeEntry("a".repeat(129), {}), "invalid replay id");
  assert.ok(typeof sanitizeEntry("6da7496aca487581a12b7a6d5bd99bc0", {}) === "object");
});

// The POV marking body (POST /api/replays/<id>/view). "ally" is the only view
// that carries a team, so the parser must reject the combinations that would
// otherwise leave a row claiming a side it does not have.
test("view request accepts the three markings", () => {
  assert.deepEqual(parseViewRequest({ view: "full" }), { view: "full", ally: null });
  assert.deepEqual(parseViewRequest({ view: "unknown" }), { view: "unknown", ally: null });
  assert.deepEqual(parseViewRequest({ view: "ally", ally: 0 }), { view: "ally", ally: 0 });
  assert.deepEqual(parseViewRequest({ view: "ally", ally: 3 }), { view: "ally", ally: 3 });
});

test("view request drops a team when the view is not one-sided", () => {
  // Marking a game full-view must not leave the old ally behind.
  assert.deepEqual(parseViewRequest({ view: "full", ally: 2 }), { view: "full", ally: null });
});

test("view request rejects malformed bodies", () => {
  for (const bad of [
    null,
    "full",
    {},
    { view: "spectator" },      // not one of the three
    { view: "ally" },           // one-sided with no team
    { view: "ally", ally: -1 },
    { view: "ally", ally: 1.5 },
    { view: "ally", ally: "2" },
  ]) {
    assert.equal(typeof parseViewRequest(bad), "string", `should reject ${JSON.stringify(bad)}`);
  }
});
