# Analysis: live widget → remote upload (crowd-sourced capture)

Status: analysis; the **manual half is implemented**. A player can drag&drop
their `<gameId>.brepstream` (the widget's local file) onto the worker's landing
page: `POST /api/upload` archives the raw stream in R2 under
`streams/<gameId>/<ts>-a<allyTeam>.brepstream` (append-only — every original is
kept, keyed by gameId with the recorder's ally team, exactly the merge
substrate this doc anticipates) and `cmd/bringest` publishes it. What
remains from this doc is the live path (the widget uploading during the match)
and the multi-uploader merge. The rest of this doc explores replacing (or
complementing) the post-game headless re-simulation with a widget that **any
player can install**, which samples game state live and uploads it to a remote
ingest server during the match. The server combines uploads from multiple
players into one capture.

## TL;DR — verdict

**Feasible, and the engine cooperates more than expected.** All the hard
prerequisites turn out to already exist in Recoil:

| Requirement | Answer | Mechanism |
|---|---|---|
| Widget network I/O | **Yes, by default** | LuaSocket TCP; `TCPAllowConnect` defaults to `*` (any host, no player config needed), `LuaSocketEnabled` defaults to true |
| Unique game identifier | **Yes, and it's *the* BAR gameId** | `widget:GameID(gameID)` callin fires at game start with the 32-hex-char id — byte-identical to the `.sdfz` header gameID and the id `api.bar-rts.com` keys replays on |
| Fixed constants (no per-game substitution) | **Works** | `sampleEvery` already falls back to 30; endpoint URL becomes a constant; the output-path substitution is simply not needed |
| Compression | **Yes** | `VFS.ZlibCompress` is exposed to LuaUI |
| Mergeable across players | **Yes, trivially** | Unit IDs are synced-sim state — identical on every client. Sampling at `frame % 30 == 0` aligns perfectly across uploaders, and synced reads at the same frame are bit-identical |
| Live meta (map, versions) | **Yes** | `Game.mapName`, `Game.gameVersion`, `Engine.version` readable from Lua — no demo fetch needed (this even fixes the `pack -no-demo` empty-mapName gap) |

The two real constraints are **no TLS** (plain TCP/HTTP only — Recoil bundles
vanilla LuaSocket, no luasec) and **LOS**: a playing player's widget can only see
its own ally team (plus wobbled radar blips), which is exactly why the
merge-on-server step the request anticipates is required.

Engine facts above were verified against RecoilEngine `master` source
(`rts/lib/luasocket/src/restrictions.cpp`, `rts/Lua/LuaUI.cpp`,
`rts/Lua/LuaHandle.cpp`, `rts/Lua/LuaVFS.cpp`, `rts/Lua/LuaSyncedRead.cpp`) and
the BAR game repo (`modoptions.lua`, `luaui/barwidgets.lua`).

## What the engine gives a live, player-run widget

### Network: plain TCP to any host, on by default

- `LuaSocketEnabled` default `true`; `TCPAllowConnect` default `*` (wildcard) and
  `readOnly` — outbound TCP from a user widget to an arbitrary host:port works
  with **zero player configuration**. (UDP outbound is blocked by default;
  irrelevant here.)
- **No TLS.** No luasec, no HTTPS client. Uploads go over plain HTTP (hand-rolled
  over `socket.tcp`, non-blocking) to a plain-HTTP ingest endpoint. Consequences
  in "Risks" below.
- Precedent exists: BAR's own tree ships `socket.tcp` widget code
  (`camera_joystick.lua` live; `api_unit_tracker_gl4.lua` even contains a
  currently-disabled upload path to `server4.beyondallreason.info:8200`). So this
  is a known, accepted widget capability — but nothing actively streams unit
  positions today; this would be new ground and worth socializing with BAR devs.

### Identity: `widget:GameID` solves the unique-game-identifier problem outright

`widget:GameID(gameID)` fires once at game start and delivers the 16-byte game id
as a 32-char hex string — the **same id** this repo already treats as canonical
(`demofile.Header.GameID`, `barapi.ParseGameID`, the `.brp` file name). Uploads
self-key to the exact replay that will later appear on the BAR API, so a
crowd-sourced capture and a resim capture of the same game land under the same id
with no correlation logic at all.

### Visibility: the one-team constraint, precisely

`LuaSyncedRead` LOS-gates everything for a playing (non-spectator) client:

- **Own ally team: fully readable** — exact position, defID, health, velocity,
  buildProgress. Same fidelity as today's replay capture, for those units.
- **Enemies in LOS**: readable while seen; **radar-only**: position comes back
  with a per-unit error vector (the radar wobble) and no reliable defID;
  **unseen**: `nil` everywhere.
- `Spring.GetAllUnits` returns only visible units. `spectatorfullview 1` is not
  available to players (and `setminspeed`/`quitforce` must obviously not run in a
  live game — see widget changes).
- `GetTeamResources` works for the player's own ally team.
- `UnitCreated/UnitFinished/UnitDestroyed` callins fire only for visible units.

So the natural unit of contribution is: **one uploader covers one ally team,
fully**. Enemy-LOS data is a bonus layer on top (recorded by default since
widget 1.1.0 — see risk 6), useful on its own but not needed for
reconstruction when every ally team has an uploader.

**Key merge property:** because unit IDs, frame numbers, and all synced values are
identical on every client, two uploaders on the *same* ally team (same widget
version, same constants) produce **byte-identical `F`/`U`/`R`/`EV` lines**. Merging
is therefore not a fuzzy-reconciliation problem:

- same ally team → line-level dedupe (and any mismatch is a red flag: forged data
  or version skew);
- different ally teams → per-frame union keyed by unitID. With the widget's
  default `recordEnemies` (v1.1+) the sets are no longer disjoint: each stream
  also carries the *other* side's units as this side perceived them (LOS/radar
  readings while the engine lists them — see the format doc). Those
  records are best-effort views, not ground truth, so the union must prefer the
  owning ally team's own records for any unit both sides report; the GAME
  line's `recordEnemies` + `allyTeam` fields identify which records are
  authoritative. Streams with `recordEnemies` false keep the old
  disjoint-by-construction property.

A full capture needs **≥1 uploader per ally team**. A spectator running the widget
sees everything (specs bypass LOS) and is a complete capture on their own — the
server should prefer a spec upload when one exists. Players who die/resign become
spectators and could widen their coverage mid-game.

### Where user widgets don't run (coverage ceiling)

`allowuserwidgets` defaults to true, but: hosts can disable it (`!bSet
AllowUserWidgets 0`), and **anonymous mode force-disables user widgets**
(`barwidgets.lua`). Ranked/tournament lobbies often use these. So coverage is
structurally limited to games that permit user widgets — this approach
complements, not replaces, the resim pipeline.

## Widget changes (one widget, two modes)

The current widget already tolerates missing substitutions (`sampleEvery` falls
back to 30). A distributable version keeps all constants fixed and branches on
`Spring.IsReplay()` / spectator status:

Live-player mode must **not**: `spectatorfullview`, `setminspeed`/`setmaxspeed`,
`quitforce` on GameOver, or disable other widgets. It must additionally:

- capture `widget:GameID` and its own playerID/allyTeam;
- read meta live (`Game.mapName`, `Game.gameVersion`, `Engine.version`) into the
  preamble;
- buffer sampled lines, `VFS.ZlibCompress` them, and send **non-blocking**
  (`sock:settimeout(0)`, partial-send handling in `widget:Update`) so a slow
  server can never stall the player's sim/render;
- keep the existing **local relative-path file write as a fallback journal**
  (LuaIO allows relative writes in live games too) so a dropped connection loses
  nothing — the file can be uploaded on reconnect or manually packed with
  `pack`;
- pcall everything, bound the buffer (drop-oldest + tell the server), never let an
  error escape a callin (BAR unloads the widget on callin error).

Data volume is a non-issue: own team in an 8v8 peaks around 500–1000 units →
~40–80 KB/s of raw BRSNAP text at 1 Hz, ~5–10 KB/s after zlib. Sample cost is the
already-measured µs-range `sample_time`.

Suggested wire protocol: keep BRSNAP text (the `capture` parser then works
unchanged server-side), add a few preamble lines —

```
BRSNAP V <protocolVersion> live
BRSNAP GID <32-hex gameId>
BRSNAP ME <playerID> <allyTeam> <spectator>
...existing DEF/T/P/READY/F/U/R/EV...
BRSNAP END <reason>            (gameover | shutdown | buffer-overflow)
```

Transport: HTTP `POST /v1/ingest/<gameId>/<playerId>/<seq>` every ~10 game-seconds,
body = zlib chunk. Stateless chunked POSTs (rather than one long-lived TCP stream)
survive reconnects, are load-balancer-friendly, and give the server a **response
channel**: `200` keep going, `205` "you're redundant for this ally team, back off
to heartbeats", `410` stop. Since protocol constants can never be re-substituted
per game, the `V` line + a stable DNS name for the endpoint are the compatibility
story; the server must accept old protocol versions forever (or reply "please
update").

## Server side (new component)

A small Go ingest+merge service (`cmd/bringest`, say) — the repo's
existing seams do most of the work:

1. **Ingest**: append each `(gameId, playerId)` chunk stream to disk. Zero
   parsing on the hot path.
2. **Finalize** on `END` from all uploaders, or a timeout, or the replay appearing
   on `api.bar-rts.com` (nice authoritative game-over signal, and a source for the
   startscript-grade player metadata — rank, OpenSkill, country — that live `P`
   lines lack; `demofile.BaseMeta` already implements that enrichment).
3. **Merge**: per uploader, `capture.Consume` (reusable as-is) into memory; pick
   the best uploader per ally team (longest coverage / spec preferred);
   cross-verify overlapping uploaders byte-for-byte; union frames by
   `(frame, unitID)`, events by `(frame, kind, unitID)`, resources by team.
4. **Write** through `snapshot.NewBRPWriter` — everything downstream (viz server,
   `barreplay-static`, the worker/R2 deployment) works unchanged. Add a
   `coverage` field to `Meta` (which ally teams / frame ranges are present) so the
   viewer can label partial captures.

The `.brp` codec needs no changes: the delta codec already handles units appearing
and disappearing per frame, and merged frames are full frames from its point of
view. If only one team uploaded, the capture is simply that team's half — still
useful (your own game review), and the resim path can later replace it with the
full version under the same gameId.

## Risks and open problems

1. **Live map-hack (the serious one).** The ingest server holds both teams'
   positions in near-real-time. If anything can query it during a live game, it's
   a wallhack service. The merged/queryable output must be **embargoed until the
   game is over** (finalize-then-publish, never a live read API), the ingest
   endpoint must be write-only, and this design point should be explicit if the
   widget is socialized in the BAR community — it will be the first question.
2. **No TLS + unauthenticated writes → forgeable data.** Anyone can POST
   fabricated streams (and plain HTTP can be tampered in transit). Mitigations,
   not solutions: cross-check overlapping uploaders (identical-bytes property
   makes forgery detectable whenever ≥2 players on a team upload), sanity checks
   (unit counts vs def costs, frame monotonicity), rate limits per IP/gameId, and
   keep the resim pipeline as ground truth for spot verification. Real
   authentication would need lobby integration (out of widget scope). Accept that
   this data is *best-effort telemetry*, not authoritative.
3. **Adoption = coverage.** One uploader per ally team per game is the minimum;
   games where nobody runs the widget produce nothing, and anonymous/no-user-widget
   lobbies are excluded entirely. The resim path remains the completeness
   backstop; this path's value is **latency** (available seconds after game end,
   no engine farm, no GPU/GL headless wall) and **zero per-game infra**.
4. **Redundant uploads.** Every widget user on the same team uploads the same
   bytes. Server-side dedupe is correct but wasteful; the `205 back off` response
   is the cheap fix. (In-game coordination via `Spring.SendLuaUIMsg` election is
   possible but adds failure modes; not worth it for v1 given the tiny
   bandwidth.)
5. **Mid-game joins/drops.** Rejoining players and mid-game widget enables start
   sampling at their join frame; a player alt-F4 truncates their stream. Per-frame
   union handles it naturally; coverage metadata should expose the gaps rather
   than hide them.
6. **Enemy-LOS data.** Recorded since widget 1.1.0 (the `recordEnemies`
   constant, default on): enemy units are captured inline as this client
   perceives them — present while the engine lists them (LOS, radar, or a
   radar-memory dot), dropped from the stream the sample the engine stops
   listing them (widget 1.5.0; 1.1–1.4 instead froze them as immobile
   "ghosts"), and buried for good on a witnessed death. Burial is tombstoned
   (widget 1.1.1): the engine can keep
   returning a dead enemy's id from GetAllUnits as a frozen radar-memory dot,
   which must not re-record the corpse — the id stays skipped until it is
   demonstrably a new unit reusing it. The v1 concerns became merge-side rules instead of an
   exclusion: enemy records double-report units the owning side records
   exactly, so the merge must treat them as non-authoritative (see the merge
   property above); wobbled radar positions and unidentified contacts (def 0)
   are recorded as-is — they are what the player actually knew.
7. **Chat and map drawings.** Recorded since widget 1.6.0 as `C` records (see
   `docs/brepstream-format.md`), and point-of-view-limited in exactly the same
   way as unit visibility: the engine hands a client only the chat channels it
   receives and only the marks it may see. Two consequences for the merge: a
   message or mark shows up in several players' streams (deduplicate on
   frame + author + payload, not on arrival), and each side's `ally` chat and
   marks exist only in that side's uploads — so the union of live uploads
   covers strictly more than any single one. Unlike unit visibility, though,
   this is one area where a re-simulation is already complete: a demo is
   watched by a spectating client, and the engine hands a spectator every
   channel and every mark.

## Alternatives considered (for contrast)

- **Status quo (post-game resim):** ground truth, full view, works for every
  public replay — but slow, post-hoc, and needs an engine farm with working GL.
- **Capture spectator bot:** a client we run joins each lobby as a spec with
  `spectatorfullview` + this widget → complete single-source live capture, no
  merging, no adoption problem. But it costs a running engine client per
  concurrent game (same GL-headless wall, realtime duration), a spec slot, and
  community/TOS goodwill. Worth keeping in mind if crowd-sourced coverage
  disappoints.
- **Recommended posture: hybrid.** Widget uploads give instant, cheap,
  partial-trust captures for games with adoption; the resim pipeline stays as the
  authoritative/completeness fallback, writing to the same gameId-keyed `.brp`
  namespace so the better capture simply replaces the worse one.

## Suggested proving steps (before building the server)

1. Prototype the live mode of the widget locally: `Spring.IsReplay()` branch,
   `widget:GameID` capture, own-team sampling, zlib chunks written to the local
   fallback file — then feed that file through `capture.Consume` +
   `NewBRPWriter` to confirm a one-team `.brp` renders fine in the existing viewer.
2. Two-client LAN game with the widget on both sides; merge the two local files
   with a throwaway script; verify the identical-bytes property and that the
   union equals a resim capture of the same game (the repo's determinism-diff
   workflow applies directly).
3. Only then build the ingest service + non-blocking socket sender.
