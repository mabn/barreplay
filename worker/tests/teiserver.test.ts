// Tests for the teiserver lobby poll: the HTML parsers (fixtures modelled on
// REAL pages captured from server4.beyondallreason.info), the web session's
// login/retry behaviour, the sync's start/end transitions, and the matcher.
// What earns a test HERE is anything that is only JavaScript; the SQL half
// (the lobbies table, lobbiesMatch's reads and writes) lives in
// tests/do/replayindex.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOBBIES_PATH,
  LOBBY_MATCH_WINDOW_SEC,
  TeiserverSession,
  extractCsrfToken,
  parseLobbyIndex,
  partyKey,
  parseLobbyShowPlayers,
  parseLobbyShowRoster,
  pickLobbyMatches,
  syncLobbies,
} from "../src/worker/teiserver";
import type { LobbyIndex, LobbyObservation, LobbyRosterPlayer, MatchGame, MatchLobby, OpenLobby } from "../src/worker/teiserver";

// ---- Fixtures (trimmed from a real /battle/lobbies dead render) ----

/** One index row exactly as teiserver renders it: the trailing cells (party
 * spacer, Show/Chat buttons) are present so the parser must not count on the
 * row ending after the spectator column. */
function indexRow(
  id: number,
  name: string,
  map: string,
  status: string,
  locked: string,
  pw: string,
  counts: [number, number, number],
): string {
  return `<tr id="lobby-${id}">
    <td>${name}</td>
    <td>${map}</td>
    <td>${status}</td>
    <td>${locked}</td>
    <td>${pw}</td>
    <td>${counts[0]}</td>
    <td>${counts[1]}</td>
    <td>${counts[2]}</td>
    <td>&nbsp;</td>
    <td><span><a href="/battle/lobbies/show/${id}" class="btn">Show</a></span></td>
    <td><span><a href="/battle/lobbies/chat/${id}" class="btn">Chat</a></span></td>
  </tr>`;
}

const PLAY = `<i class="fa-fw fa-solid fa-play"></i>&nbsp; 13:49`;
const INDEX_HTML = `<table><tbody>
  ${indexRow(10795, "Rosetta Rotato All Welcome | 8v8", "Proving Grounds v1.0", PLAY, "", "", [35, 16, 19])}
  ${indexRow(11825, "Academy LIVE | 1v1 | Unranked", "Altair_Crossing_V4.1", "", "", "", [20, 2, 18])}
  ${indexRow(7000, "locked &amp; keyed", "Tau12", `<i class="fa-play"></i>&nbsp; 1:03:07`, `<i class="fa-lock"></i>`, `<i class="fa-key"></i>`, [4, 4, 0])}
</tbody></table>`;

/** A show page's players/spectators tables as rendered: a leading unlabeled
 * icon column before Name, and extra columns after it, so the test proves the
 * header-label indexing rather than a fixed position. The Party column is
 * rendered the way teiserver really does it: an EMPTY cell whose background
 * COLOUR is the party key (two players share one), and an unstyled cell for
 * a solo queuer — a fixture carrying party text instead is what let a parser
 * reading the cell's text ship and report no parties at all. */
const SHOW_HTML = `
<table class="table table-sm" id="players-table">
  <thead><tr><th width="100">&nbsp;</th><th>Name</th><th>Ready</th><th>Team</th><th>Party</th><th>Rating</th><th>Bonus</th><th>Faction</th></tr></thead>
  <tbody>
    <tr id="user-row-81372"><td width="100"></td><td>Adzek</td><td></td><td>0</td><td width="50">&nbsp;</td><td>27.25</td><td>0</td><td>Random</td></tr>
    <tr id="user-row-561838"><td width="100"></td><td>[BS]Phoenix</td><td></td><td>1</td><td style="background-color: #62EA6B;" width="50">&nbsp;</td><td>26.78</td><td>0</td><td>Armada</td></tr>
    <tr id="user-row-90001"><td width="100"></td><td>Kirdiel</td><td></td><td>1</td><td style="background-color: #62ea6b;" width="50">&nbsp;</td><td>19.02</td><td>0</td><td>Cortex</td></tr>
    <tr id="user-row-90002"><td width="100"></td><td>voidy</td><td></td><td>0</td><td width="50">&nbsp;</td><td>21.4</td><td>25</td><td></td></tr>
  </tbody>
</table>
<table class="table table-sm" id="spectators-table">
  <thead><tr><th width="100">&nbsp;</th><th>Name</th><th>Rating</th></tr></thead>
  <tbody>
    <tr id="user-row-9"><td width="100"></td><td>LurkerGuy</td><td>12.00</td></tr>
  </tbody>
</table>`;

/** What parseLobbyShowRoster reads out of SHOW_HTML, verbatim. */
const SHOW_ROSTER: LobbyRosterPlayer[] = [
  { name: "Adzek", team: 0, party: null, rating: 27.25, bonus: 0, faction: "Random" },
  // The two partied players share one key, case-normalized from the markup.
  { name: "[BS]Phoenix", team: 1, party: "#62ea6b", rating: 26.78, bonus: 0, faction: "Armada" },
  { name: "Kirdiel", team: 1, party: "#62ea6b", rating: 19.02, bonus: 0, faction: "Cortex" },
  { name: "voidy", team: 0, party: null, rating: 21.4, bonus: 25, faction: null },
];

// ---- Parsers ----

test("parseLobbyIndex reads rows, flags and the running clock", () => {
  const lobbies = parseLobbyIndex(INDEX_HTML);
  assert.equal(lobbies.length, 3);
  assert.deepEqual(lobbies[0], {
    id: 10795,
    name: "Rosetta Rotato All Welcome | 8v8",
    map: "Proving Grounds v1.0",
    inProgress: true,
    elapsedSec: 13 * 60 + 49,
    locked: false,
    passworded: false,
    memberCount: 35,
    playerCount: 16,
    spectatorCount: 19,
  });
  // Waiting lobby: no play icon, no clock.
  assert.equal(lobbies[1].inProgress, false);
  assert.equal(lobbies[1].elapsedSec, null);
  // Hour-long clock, lock and key icons, entity-decoded name.
  assert.equal(lobbies[2].elapsedSec, 3600 + 3 * 60 + 7);
  assert.equal(lobbies[2].locked, true);
  assert.equal(lobbies[2].passworded, true);
  assert.equal(lobbies[2].name, "locked & keyed");
});

test("parseLobbyShowPlayers returns players by header label and never spectators", () => {
  assert.deepEqual(parseLobbyShowPlayers(SHOW_HTML), ["Adzek", "[BS]Phoenix", "Kirdiel", "voidy"]);
  assert.deepEqual(parseLobbyShowPlayers("<p>no tables</p>"), []);
});

test("parseLobbyShowRoster keeps every cell, blank party/faction as null", () => {
  assert.deepEqual(parseLobbyShowRoster(SHOW_HTML), SHOW_ROSTER);
  assert.deepEqual(parseLobbyShowRoster("<p>no tables</p>"), []);
  // A column the account class does not render: that field is null, the rest
  // still resolve by label.
  const noParty = SHOW_HTML.replace("<th>Party</th>", "").replace(/<td[^>]*width="50"[^>]*>[^<]*<\/td>/g, "");
  assert.deepEqual(
    parseLobbyShowRoster(noParty),
    SHOW_ROSTER.map((p) => ({ ...p, party: null })),
  );
});

// The Party cell is EMPTY by design — its colour is the value — so this is
// the one column a text-reading parser silently reports as "nobody is ever
// in a party", which is what shipped.
test("partyKey reads the cell's background colour, not its text", () => {
  assert.equal(partyKey(`<td style="background-color: #62ea6b;" width="50">&nbsp;</td>`), "#62ea6b");
  // Case-normalized, so one party is one key however teiserver spells it.
  assert.equal(partyKey(`<td style="background-color: #62EA6B" width="50">&nbsp;</td>`), "#62ea6b");
  assert.equal(partyKey(`<td style="background-color: rgb(98, 234, 107);">&nbsp;</td>`), "rgb(98, 234, 107)");
  // Unstyled cell, other styles, and a missing column are all "no party".
  assert.equal(partyKey(`<td width="50">&nbsp;</td>`), null);
  assert.equal(partyKey(`<td style="text-align: center;">&nbsp;</td>`), null);
  assert.equal(partyKey(""), null);
});

test("extractCsrfToken reads the meta tag, then the hidden input", () => {
  assert.equal(extractCsrfToken(`<meta name="csrf-token" content="tok123"/>`), "tok123");
  assert.equal(extractCsrfToken(`<input name="_csrf_token" type="hidden" value="tok456">`), "tok456");
  assert.equal(extractCsrfToken(`<p>nothing</p>`), null);
});

// ---- Session ----

/** Scripted fetch: routes on "METHOD path", records calls, answers from the
 * handlers map. */
function fakeWeb(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    calls.push(key);
    const h = handlers[key];
    if (!h) throw new Error(`unexpected request ${key}`);
    return h();
  }) as typeof fetch;
  return { impl, calls };
}

const LOGIN_PAGE = () =>
  new Response(`<meta name="csrf-token" content="tok"/>`, {
    status: 200,
    headers: { "set-cookie": "_teiserver_key=sess1; path=/" },
  });
const LOGIN_OK = () =>
  new Response("", {
    status: 302,
    headers: [
      ["set-cookie", "guardian_default_token=guard1; path=/"],
      ["location", "/"],
    ],
  });

test("login: GET for CSRF, POST form, jar handed to the persistence hook", async () => {
  const { impl, calls } = fakeWeb({
    "GET /login": LOGIN_PAGE,
    "POST /login": LOGIN_OK,
    [`GET ${LOBBIES_PATH}`]: () => new Response(INDEX_HTML, { status: 200 }),
  });
  let persisted: Record<string, string> | null = null;
  const s = new TeiserverSession(
    () => ({ email: "a@b.c", password: "pw" }),
    (jar) => {
      persisted = jar;
    },
    impl,
  );
  await s.authedFetch(LOBBIES_PATH);
  assert.deepEqual(calls, ["GET /login", "POST /login", `GET ${LOBBIES_PATH}`]);
  assert.deepEqual(persisted, { _teiserver_key: "sess1", guardian_default_token: "guard1" });
});

test("login failure: a 200 re-render (bad credentials) throws", async () => {
  const { impl } = fakeWeb({
    "GET /login": LOGIN_PAGE,
    "POST /login": () => new Response("try again", { status: 200 }),
  });
  const s = new TeiserverSession(() => ({ email: "a@b.c", password: "wrong" }), undefined, impl);
  await assert.rejects(() => s.authedFetch(LOBBIES_PATH), /login failed/);
});

test("missing credentials throw before any request", async () => {
  const { impl, calls } = fakeWeb({});
  const s = new TeiserverSession(() => ({}), undefined, impl);
  await assert.rejects(() => s.authedFetch(LOBBIES_PATH), /not configured/);
  assert.deepEqual(calls, []);
});

test("an expired session re-logins exactly once and retries", async () => {
  let listCalls = 0;
  const { impl, calls } = fakeWeb({
    "GET /login": LOGIN_PAGE,
    "POST /login": LOGIN_OK,
    [`GET ${LOBBIES_PATH}`]: () => {
      listCalls++;
      // First authed GET bounces to /login (the stored cookie has expired);
      // after the re-login the same GET succeeds.
      return listCalls === 1
        ? new Response("", { status: 302, headers: { location: "/login?next=x" } })
        : new Response(INDEX_HTML, { status: 200 });
    },
  });
  const s = new TeiserverSession(() => ({ email: "a@b.c", password: "pw" }), undefined, impl);
  s.seedCookies({ guardian_default_token: "stale" });
  const html = await s.authedFetch(LOBBIES_PATH);
  assert.ok(html.includes("lobby-10795"));
  assert.deepEqual(calls, [
    `GET ${LOBBIES_PATH}`,
    "GET /login",
    "POST /login",
    `GET ${LOBBIES_PATH}`,
  ]);
});

// ---- syncLobbies transitions ----

class FakeLobbyIndex implements LobbyIndex {
  cookies: Record<string, string> | null = null;
  open: OpenLobby[] = [];
  observed: LobbyObservation[] = [];
  ended: number[] = [];
  matchCalls = 0;
  teiserverCookies() {
    return this.cookies;
  }
  teiserverCookiesPut(jar: Record<string, string>) {
    this.cookies = jar;
  }
  lobbiesOpen() {
    return this.open;
  }
  lobbiesObserve(obs: LobbyObservation[]) {
    this.observed.push(...obs);
  }
  lobbiesEnd(ids: number[]) {
    this.ended.push(...ids);
  }
  lobbiesMatch() {
    this.matchCalls++;
    return { matched: 0, pruned: 0 };
  }
}

test("syncLobbies observes new games, closes finished ones, skips known ones", async () => {
  const { impl, calls } = fakeWeb({
    "GET /login": LOGIN_PAGE,
    "POST /login": LOGIN_OK,
    [`GET ${LOBBIES_PATH}`]: () => new Response(INDEX_HTML, { status: 200 }),
    [`GET ${LOBBIES_PATH}/show/10795`]: () => new Response(SHOW_HTML, { status: 200 }),
  });
  const index = new FakeLobbyIndex();
  // 7000 is already open (still in progress: no show fetch, no observation);
  // 5 finished since last tick (absent from the page).
  index.open = [
    { lobbyId: 7000, startedUnix: 1000 },
    { lobbyId: 5, startedUnix: 900 },
  ];
  const r = await syncLobbies(index, { email: "a@b.c", password: "pw" }, impl);
  assert.deepEqual(r, { active: 2, started: 1, ended: 1, matched: 0, failed: 0 });
  assert.deepEqual(index.observed, [
    {
      lobbyId: 10795,
      name: "Rosetta Rotato All Welcome | 8v8",
      map: "Proving Grounds v1.0",
      players: ["Adzek", "[BS]Phoenix", "Kirdiel", "voidy"],
      playerCount: 4,
      elapsedSec: 13 * 60 + 49,
      details: {
        locked: false,
        passworded: false,
        memberCount: 35,
        spectatorCount: 19,
        players: SHOW_ROSTER,
      },
    },
  ]);
  assert.deepEqual(index.ended, [5]);
  assert.equal(index.matchCalls, 1);
  assert.ok(!calls.includes(`GET ${LOBBIES_PATH}/show/7000`));
  // The fresh login was persisted for the next tick.
  assert.equal(index.cookies?.guardian_default_token, "guard1");
});

test("syncLobbies with a stored session performs no login", async () => {
  const { impl, calls } = fakeWeb({
    [`GET ${LOBBIES_PATH}`]: () => new Response(indexRow(1, "n", "m", "", "", "", [0, 0, 0]), { status: 200 }),
  });
  const index = new FakeLobbyIndex();
  index.cookies = { guardian_default_token: "guard1" };
  const r = await syncLobbies(index, { email: "a@b.c", password: "pw" }, impl);
  assert.deepEqual(calls, [`GET ${LOBBIES_PATH}`]);
  assert.deepEqual(r, { active: 0, started: 0, ended: 0, matched: 0, failed: 0 });
});

test("a failed show fetch still records the observation, with players null", async () => {
  const { impl } = fakeWeb({
    [`GET ${LOBBIES_PATH}`]: () => new Response(INDEX_HTML, { status: 200 }),
    [`GET ${LOBBIES_PATH}/show/10795`]: () => new Response("boom", { status: 500, statusText: "ISE" }),
    [`GET ${LOBBIES_PATH}/show/7000`]: () => new Response(SHOW_HTML, { status: 200 }),
  });
  const index = new FakeLobbyIndex();
  index.cookies = { guardian_default_token: "guard1" };
  const r = await syncLobbies(index, { email: "a@b.c", password: "pw" }, impl);
  assert.equal(r.started, 2);
  assert.equal(r.failed, 1);
  const broken = index.observed.find((o) => o.lobbyId === 10795);
  assert.equal(broken?.players, null);
  // The index page's player count stands in for the roster we could not get.
  assert.equal(broken?.playerCount, 16);
  // The index-page half of the detail is still recorded; only the roster is
  // missing.
  assert.deepEqual(broken?.details, {
    locked: false,
    passworded: false,
    memberCount: 35,
    spectatorCount: 19,
    players: null,
  });
  // 7000's show fetch worked, and its index flags carry into the detail.
  const keyed = index.observed.find((o) => o.lobbyId === 7000);
  assert.deepEqual(keyed?.details, {
    locked: true,
    passworded: true,
    memberCount: 4,
    spectatorCount: 0,
    players: SHOW_ROSTER,
  });
});

// ---- Matching ----

const lob = (over: Partial<MatchLobby> = {}): MatchLobby => ({
  lobbyId: 1,
  startedUnix: 1000,
  map: "Supreme Isthmus v2.1",
  players: ["Alpha", "Bravo", "Charlie", "Delta"],
  ...over,
});
const game = (over: Partial<MatchGame> = {}): MatchGame => ({
  id: "g1",
  startUnix: 990,
  map: "Supreme Isthmus v2.1",
  players: ["alpha", "BRAVO", "Charlie", "Echo"],
  ...over,
});

test("pickLobbyMatches: map and time gates", () => {
  assert.equal(pickLobbyMatches([lob()], [game()]).length, 1);
  assert.equal(pickLobbyMatches([lob({ map: "Other Map" })], [game()]).length, 0);
  assert.equal(pickLobbyMatches([lob({ map: null })], [game()]).length, 0);
  assert.equal(pickLobbyMatches([lob()], [game({ map: null })]).length, 0);
  assert.equal(pickLobbyMatches([lob()], [game({ startUnix: null })]).length, 0);
  // Observation began too long after the game's start.
  assert.equal(pickLobbyMatches([lob({ startedUnix: 990 + LOBBY_MATCH_WINDOW_SEC + 1 })], [game()]).length, 0);
  // ...or meaningfully before it.
  assert.equal(pickLobbyMatches([lob({ startedUnix: 990 - 61 })], [game()]).length, 0);
  // Map compare is case- and whitespace-insensitive.
  assert.equal(pickLobbyMatches([lob({ map: "supreme  isthmus V2.1" })], [game()]).length, 1);
});

test("pickLobbyMatches: roster overlap threshold, case-insensitive", () => {
  // 3 of min(4,4) shared (alpha, bravo, charlie) = 0.75: match.
  assert.equal(pickLobbyMatches([lob()], [game()]).length, 1);
  // 1 of min(4,4) = 0.25: below the 0.5 bar.
  assert.equal(
    pickLobbyMatches([lob({ players: ["Alpha", "X", "Y", "Z"] })], [game()]).length,
    0,
  );
  // An empty roster on either side cannot vouch for anything.
  assert.equal(pickLobbyMatches([lob({ players: [] })], [game()]).length, 0);
  assert.equal(pickLobbyMatches([lob()], [game({ players: [] })]).length, 0);
});

test("pickLobbyMatches: a null roster falls back to map+time and loses to a real one", () => {
  const g = game();
  const blind = lob({ lobbyId: 9, players: null });
  assert.deepEqual(pickLobbyMatches([blind], [g]), [{ lobbyId: 9, startedUnix: 1000, gameId: "g1" }]);
  // Against a sighted competitor for the same game, the real roster wins.
  const picked = pickLobbyMatches([blind, lob({ lobbyId: 2 })], [g]);
  assert.deepEqual(picked, [{ lobbyId: 2, startedUnix: 1000, gameId: "g1" }]);
});

test("pickLobbyMatches: greedy one-to-one; ties resolve by smaller time delta", () => {
  const gA = game({ id: "gA", startUnix: 1000 });
  const gB = game({ id: "gB", startUnix: 1200, players: ["Alpha", "Bravo", "Xray", "Yankee"] });
  const lA = lob({ lobbyId: 1, startedUnix: 1005 });
  const lB = lob({ lobbyId: 2, startedUnix: 1210, players: ["Alpha", "Bravo", "Xray", "Yankee"] });
  const picked = pickLobbyMatches([lA, lB], [gA, gB]);
  assert.equal(picked.length, 2);
  assert.deepEqual(new Map(picked.map((p) => [p.lobbyId, p.gameId])), new Map([[1, "gA"], [2, "gB"]]));
  // Two identically-scoring lobbies for one game: the closer start wins
  // (best candidate wins — never abstain).
  const near = lob({ lobbyId: 5, startedUnix: 995 });
  const far = lob({ lobbyId: 6, startedUnix: 1100 });
  assert.deepEqual(pickLobbyMatches([far, near], [game({ startUnix: 992 })]), [
    { lobbyId: 5, startedUnix: 995, gameId: "g1" },
  ]);
});
