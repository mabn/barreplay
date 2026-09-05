# barreplay worker

A Cloudflare Worker that hosts the barreplay viewer as **static files, with no server
on the playback path**. Built with [Hono](https://hono.dev) and
[Vite](https://vite.dev) (via
[`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/)).
No front-end framework — the viewer is the same plain Canvas/vanilla-JS app as
`cmd/barreplay-viz`.

## How it works

The `.brp` format was designed so serving is a byte copy, not a re-encode: the
head is a pure function of the file's meta, the keyframes section and each frame
chunk are independently-gzipped byte ranges. The Go viz server and this Worker
share ONE URL scheme, so the same `worker/public` front-end works against both.
The files are precomputed **offline** by `cmd/barreplay-static` and served
straight from an **R2 bucket**:

| URL | Static object (in R2) |
| --- | --- |
| `GET /index.json` | built live by the Worker from the bucket (no stored file) |
| `GET /replays/<id>.brw` | `replays/<id>.brw` (head: meta, teams, icons, chunk index) |
| `GET /replays/<id>.keys` | `replays/<id>.keys` (every keyframe, one gzip stream — streamed first, makes the whole timeline scrubbable) |
| `GET /replays/<id>/c<n>` | `replays/<id>/c<n>` (chunk n's delta frames; absent for single-frame chunks) |
| `GET /replays/<id>.resources` | `replays/<id>.resources` |

The Worker (`src/worker/index.ts`) is a thin Hono app that streams these out of R2 —
no frame is ever decoded server-side. The replay listing (`/index.json`) is
built **live** from the bucket (it lists the `replays/` prefix), so there is no listing file
to maintain: uploading one replay's handful of files makes it appear, and deleting them
removes it. The SPA and the vendored unit/rank
icons (`/icons/*`, `/ranks/*`) are fixed static assets bundled with the deploy. Map terrain
is fetched **browser-side directly** from `api.bar-rts.com` (degrades gracefully if
unreachable), so there is no map proxy.

## The landing page's sections

The landing page (no `?replay=` in the URL) has a **left menu** with these sections:

- **Replays** — the catalog list (below), the default.
- **Queue** — **admin-only** (`?admin=true`): the ingest jobs (`GET /api/queue`),
  one row per job with its game, **kind**, state, age and failure detail, **25 per
  page** with a Prev/Next pager. Two kinds appear here: an `upload` is a dropped
  `.brepstream` waiting for a plain `bringest`, a `re-sim` is a game **nobody
  uploaded**, requested from the paste box above the table (below) and waiting for
  an engine host running `bringest -resim`. A finished job also shows what the
  work **took** — for a re-sim that is the engine's own wall time — and clicking
  the row expands the rest of the daemon's processing record: the load/sim
  split, how much faster than realtime it simulated, what its engine log said
  (**desyncs above all**: a re-simulation that desynced describes a game that
  never happened and looks perfectly normal on disk), and the `.brp` size
  breakdown `pack -stats` prints. It never refreshes itself:
  reads happen when the landing page opens, when you page, when you press **Reload**,
  and when your own upload lands or fails — so the pager stamps the clock time of the
  read. The menu entry carries a count of the jobs still in flight (counted
  server-side over the whole table, so it is true on any page). A backend without the
  route (the Go viz server, which runs no ingest pipeline) says so instead of showing
  an empty table.
- **Games** — **admin-only** (`?admin=true`): the **games mirror** (`GET /api/games`),
  every game BAR published that the worker's cron has recorded, captured or not —
  the other half of the catalog, and the list the re-sim backfill draws from. One
  row per game, latest-**ended** first (the order the mirror learns games in, and the
  one order it has an index for): when it ended, duration, map, size, preset, the
  top players a side, the lobby name (when the teiserver poll matched one), settings
  badges, engine version, links out to gex/BAR and into the replay here once one is
  published, and a **Here** pill saying what this site has of it — `published`, or
  the state of its last ingest job (`processing`, `queued`, `failed`). **50 per page**
  with a Prev/Next pager that states the range shown and deliberately **no total
  and no page count**: counting the mirror means reading a table that grows by
  ~2000 rows a day, so the listing asks for one row more than it shows and reads
  "there is a next page" off that row's existence. Read on open, on paging, and on
  **Reload**; the page is not in the URL. A backend without the route (the Go viz
  server keeps no mirror) says so.

The selection lives in the URL as `?tab=queue`, so it is shareable and survives a
refresh, and opening a replay from a section returns there on `back`. Without
`?admin=true` the Queue entry is hidden and `?tab=queue` falls back to Replays, so
the section is not reachable by URL alone — the route itself stays open, like the
per-job status the uploading browser polls.

## The replay catalog (Durable Object + SQLite)

The **Replays** section is a **replay list with per-game stats** —
when the game started, how long it ran, which map, the team-size spec ("8v8"), and the
download size — ordered most recent game first. Those stats live inside each `.brp`'s
meta record, which a bucket listing can't see, so they are kept in a small SQLite table
inside a **Durable Object** (`src/worker/replayindex.ts`, single instance, migration
`v1: new_sqlite_classes`):

| URL | What |
| --- | --- |
| `GET /api/replays` | the catalog, newest game first (rows with no start time last) — `[{id, rid, startUnix, durationSec, map, gameSize, sizeBytes, settings, players, playerCount, widgetVersion, widgetSha, widgetDate}]`, nulls for unknown stats. Filterable: `?from=&to=` (unix seconds or `YYYY-MM-DD`, `to` covers the whole day), `?map=`, `?minPlayers=&maxPlayers=` (Gaia excluded), `?minDuration=&maxDuration=` (seconds; a row with no recorded duration matches neither), `?player=` (case-insensitive name prefix), `?settings=lava,zombies` (all must be present). Paged by `?limit=&offset=` — absent limit means the whole listing. No params = everything; unknown params are ignored |
| `GET /api/replays/maps` | `{maps: [...]}` — the catalog's distinct map names, for the filter bar's combobox. A maintained list (the DO's `unique_values` table, updated as replays are published) behind a one-minute in-memory cache, not a scan of the catalog. The only filter data the front-end fetches: the settings chips are a hardcoded vocabulary, the ranges have fixed domains, the player and id fields are free text |
| `PUT /api/replays/<id>` | upsert one row (same JSON shape, minus `id`); called by `pack -upload` / the ingest daemon after a replay's files land in the bucket |

Two fields on a row are **server-owned and never accepted from a PUT**, both about work
in flight rather than about the replay:

- `processing` — some job for this game is in `processing`. Computed on every read as an
  `EXISTS` over the jobs table, never stored, so nothing has to remember to clear it: it
  goes false the moment the job stops running, however it stopped. The list shows it as a
  **pill at the head of the Settings cell** — "processing: 52%" once the job reports a
  percentage (read off the jobs row's live progress at the same moment `processing` is
  derived, as `processingPercent`), the bare word through the phases with nothing to
  measure — filled and pulsing among the muted setting
  badges, because it is not a setting, it is why the row is there.
- `placeholder` — the row exists *only* because a job is working on the game; nothing has
  been published. The DO inserts one whenever a job enters `processing` (seeded from the
  games mirror, so it shows the map and roster), and the viewer refuses to open it — a
  placeholder row is rendered with no internal links at all. Publishing clears the mark;
  a job that ends **without** publishing deletes the row, so a failed re-sim leaves no
  dead entry behind.

A game that was already published and is being re-simulated gets the pill but stays
openable — there is a revision to play. The Go viz server has no pipeline and sends
neither field; the front-end reads a missing value as false.

`rid` is the **revision** the replay's pieces are actually served under:
publishes are append-only — `pack -upload` (and the ingest daemon) put the
pieces at `replays/<gameId>-<rev>…` where `rev` is the first 8 hex of the
source stream's SHA-256, and the catalog row (still keyed by the bare gameId)
points at the current revision. No served object is ever overwritten or
deleted, which is what makes the `/replays/*` `immutable` cache-control sound:
a re-upload lands under a fresh rid and the row moves, superseded revisions
stay servable (old shared links keep playing) but are hidden from the landing
list. `rid: null` means a pre-revisioning upload living under the bare id.

`settings` is a flat object of notable game-settings flags rendered as badges in the
list — keys like `ranked`, `lava` (water-is-lava), `mods` (any tweakdefs*/tweakunits*
set), `scavUnits`, `extraUnits`, `noAir`/`noNukes`/`noLrpc`/`noEndgameLrpc`, and the
enum-valued `quickStart`/`comBuilders` — with boolean or short string values; only
present flags are sent (a vanilla ranked game is `{"ranked": true}`). `pack` distills
them from the demo startscript's `[modoptions]` (`viz.SettingsFlags` in Go — modoptions
are NOT stored in the `.brp`, so this rides only the PUT); `pack -no-demo` uploads have
`settings: null` and just show an empty cell.

`widgetVersion` / `widgetSha` / `widgetDate` record **which build of the
Replay uploader widget produced the capture** behind the current revision. The
widget writes all three into its stream's `GAME` line and the publisher carries
them into the PUT, because a player's installed copy can be arbitrarily old and
nothing else in the system knows what it was. Version and date are the
constants the widget bumps together (`1.7.0`, `2026-08-16`); the SHA is the git
commit of the exact file, stamped into the copy served at `/replay_uploader.lua`
when it is published (`tools/sync-assets.mjs`) — so it identifies the bytes,
not just the release name, which is the distinction that matters for a file
that keeps the same version for weeks. They are three plain columns rather than
one JSON blob so "which builds are in the wild" is a SQL question.

A widget installed straight from the repo was never stamped and reports no SHA;
a re-sim revision has no uploader widget at all. Both send nothing, and the
upsert `COALESCE`s these columns (like `view`), so a later publish that knows
nothing cannot erase a build a previous one recorded. The row describes the
current revision, so per-revision provenance lives in `uploads[]`: each entry
is `{rid, ally, widget?}` and keeps the build that produced *that* upload.

Writes can be guarded with a shared secret: `npx wrangler secret put REPLAY_PUT_TOKEN`
makes the PUT require `Authorization: Bearer <token>`; `pack` sends the same-named env
var. Without the secret (local dev) the endpoint is open.

The front-end merges `GET /api/replays` with `/index.json`, so a replay whose files are
in the bucket but was never registered still appears (with only its byte size). To
(re-)register one replay by hand:

```sh
curl -X PUT https://<worker-host>/api/replays/<gameId> \
  -H "authorization: Bearer $REPLAY_PUT_TOKEN" -H "content-type: application/json" \
  -d '{"startUnix":1752000000,"durationSec":1987,"map":"Isidis crack 1.1","gameSize":"8v8","sizeBytes":8400000,"settings":{"ranked":true,"lava":true}}'
```

The Go viz server (`cmd/barreplay-viz`) serves the same `GET /api/replays` shape
computed live from its `.brp` files (`internal/viz/catalog.go`), so the shared front-end
works against both backends; the row shape must stay in lockstep with
`src/worker/replayentry.ts`. It does **not** implement the filters — it lists a local
directory of a few captures — so it ignores those query params and has no
`/api/replays/maps` route, and the front-end hides the filter bar when that route is
missing. It *does*
honour `?limit=&offset=`: paging is not a filter, and the shared front-end reads "there
is a next page" off being handed one row more than it asked to show, so ignoring them
would make its Next button lie.

### The list is paged

50 rows a page, Prev/Next above the table, **no page count** — counting the pages means
counting the whole catalog on every listing. Instead the front-end asks for **51** rows
and shows 50: whether the 51st came back is the entire answer to "is there a next page".
The page lives in memory, not the URL (unlike the filters): "page 3" describes a moment
in a growing list, not a set of replays. Changing any filter returns to the first page.

## The games mirror (cron)

A **cron trigger runs every minute** (`triggers.crons` in `wrangler.jsonc`, handler in
`src/worker/index.ts`, logic in `src/worker/games.ts`) and records the newest games BAR
published into a second DO table, `games`:

```
GET https://api.bar-rts.com/replays?page=1&limit=24&hasBots=false&endedNormally=true
```

`replays` is what somebody **captured**; `games` is what was **played**, keyed by the same
gameId — so a `games` row with no `replays` row is a re-sim candidate nobody had to paste a
link for. Nothing serves it yet: there is **no route and no UI** for the table.

A run reads that one page (never a second — at a run a minute it covers far more than a
minute of BAR's game rate), asks the DO which of the 24 ids are new, and spends one
`/replays/<id>` detail fetch on each new game — the listing carries no modoptions, so that
is where `settings` comes from, via the same `settingsFlags`/`playersFromApi` the admin
refresh route uses. A tick that finds nothing new is a **single** request and logs nothing.
A detail that fails is simply not recorded and is retried next tick.

| Column | From |
| --- | --- |
| `start_unix`, `duration_sec`, `map`, `game_size`, `player_count`, `players`, `settings` | the same vocabulary a catalog row uses, so the two compare without translating |
| `map_file` | the map's archive name — what BAR's maps API keys on |
| `preset` | `duel` / `team` / `ffa`, stored verbatim |
| `engine_version`, `game_version` | the exact builds a re-simulation has to run |

Mirrored games index into the **same** `replay_settings` table as the catalog, so
exactly one row owns an id's entries: the catalog row if there is one, the `games` row
otherwise (`gamesInsert` skips an id `replays` holds). The maps list
(`GET /api/replays/maps`) is likewise maintained only from published replays — the
mirror is thousands of games nothing has published, and the filter bar must not offer
options that match no listable replay.

Trigger it by hand against `vite dev` — this really calls the BAR API and writes
to the local DO:

```sh
curl http://127.0.0.1:5173/cdn-cgi/handler/scheduled
```

### Lobby names (teiserver poll)

The same cron tick also polls **teiserver's web UI** for the active lobbies
(`src/worker/teiserver.ts` — parsers and session adapted from `mabn/claudebar`):

```
GET https://server4.beyondallreason.info/battle/lobbies
```

The point is the **lobby name** ("Chillmus most welcome | 8v8"), which exists nowhere in
BAR's published history — it is only observable **live**, so the poll opens an observation
(DO table `lobbies`) the first tick a lobby is seen in progress: name, map, `started_unix`
back-dated by the page's own running clock, and the **non-spectator roster** from one
`/battle/lobbies/show/<id>` fetch (spectators churn too much to be a signal; the roster is
captured at the start, when it is most trustworthy). When the finished game later appears
in the rts-api mirror, `ReplayIndex.lobbiesMatch` pairs observation and game — no shared
id exists, so the match is heuristic: same **map** (normalized), **start time** within
`[-60 s, +300 s]`, and ≥ 50% **roster overlap** (lowercased names; a roster-less
observation matches on map+time alone but loses to any real roster). Best candidate wins
ties (smaller Δt); each side matches at most once. The winner's name lands in
`games.lobby_name` (+ `lobby_id`), which a later re-sync cannot erase — the column is
deliberately outside `gamesInsert`'s upsert list. A match also **retires its
observation**: the matched game has certainly ended, even when back-to-back games never
let the lobby leave the in-progress set, so the next tick opens a fresh observation for
the game now running — one lobby names game after game, one `lobbies` row per game
(renames between games record per-game too). Matched observations are pruned after
48 h; unmatched ones are kept as the record of why a game has no name.

The name is **served, not copied**: `GET /api/replays` joins `games.lobby_name` per read
into each row's `lobbyName`, so it appears the moment the match lands, with no republish.
`games.map_file` rides the same join into `mapFile`, which is what the list's small map
thumbnails key on (`api.bar-rts.com/maps/<file>/texture-thumb.jpg`, lazy-loaded; rows
without a mirror row guess the file from the map name and hide the image on a 404).
In the list, the **Players column header is a switch** — click it to swap the column
between the rosters and the lobby name (a dash where no match exists). The choice lives
in the URL as `?col=lobby` (absent = players), so it is shareable and survives a refresh
and a round trip through a replay. The Go viz server has no games mirror, omits the
field, and the header stays inert there — a `?col=lobby` link still lists players.

The teiserver **web session** (the Guardian cookie jar) persists in the one-row DO table
`teiserver_session`, so the steady state is **one authed GET per minute** — no re-login —
plus one show-page fetch per newly started lobby (0-2 in practice). Login happens only
when the stored session is missing or expired (a redirect back to `/login`).

Credentials are secrets, and without them the step is **skipped entirely**:

```sh
npx wrangler secret put TEISERVER_EMAIL
npx wrangler secret put TEISERVER_PASSWORD
```

For local dev put them in `.dev.vars`; `TEISERVER_BASE` there points the poll at a mock
server instead of the real one (never set it in production).

### Feeding the re-sim daemon

`GET /api/jobs?kind=resim` (the daemon's poll) does not come back empty while the mirror
holds games nothing has published: with no pending job it **queues one** and returns it,
so an engine host never idles waiting for somebody to paste a link.

Which game: of the **20 newest eligible** ones, the one with the **most players**. An hour
of engine time buys an 8v8 as cheaply as the duel that finished a minute later, so within
a window of games that are all recent, size decides (ties go to the newer game; an unknown
roster sorts last but is not refused). The window counts *candidates*, not the mirror's
last 20 rows — every game handed out gains a job row and stops being eligible, so a window
over raw recency would be permanently empty after twenty of them.

- Only for `kind=resim`. An upload job is bytes somebody sent; there is no stream to
  invent for a game nobody uploaded.
- A candidate must have **no job row at all**, finished and failed ones included —
  otherwise a game that cannot re-simulate comes back every poll, an hour of engine time
  at a time. Pasting its link is still the retry.
- A candidate must be **unmodded**: no `tweakdefs`/`tweakunits` slot set, which is exactly
  what the settings' `mods` flag records. That also excludes the modes shipping as tweak
  blobs (lava, zombies) — they are modded games. A game whose settings the API never gave
  stays eligible; unknown is not the same as modded.
- The backfill fires only into an **empty** pending list, so at most one auto-queued job
  is ever waiting; check and insert are one DO call, so two daemons cannot both take it.

Consequence worth knowing: `bringest -resim`'s **catalog scan** (games with a one-sided
upload and no full-view revision) only runs when the queue is empty, which now is rarely.
Those games get picked up more slowly than before.

### Testing it

The sync's logic (which URLs, which games earn a detail fetch, what a row holds) is
`tests/games.test.ts` under the node runner, against a fake API. The **DO half** — the
`games` table, `gamesUnknown`'s dedupe, and the ownership rule over the derived tables —
is `tests/do/replayindex.test.ts`, which runs **inside workerd** via
`@cloudflare/vitest-pool-workers` (`vitest.config.ts`, bindings read from
`wrangler.jsonc`) because `replayindex.ts` imports `cloudflare:workers` and its
behaviour *is* its SQL. Note there is no per-test storage isolation to configure in this
version of the pool, so each test addresses its own DO instance; see the helper at the
top of that file.

## Layout

```
worker/
  wrangler.jsonc          Worker config (name, main, account_id, assets + R2 + DO bindings, cron trigger)
  vite.config.ts          Vite + @cloudflare/vite-plugin
  index.html              viewer page (Vite entry)
  public/app.js           viewer logic (copied from internal/viz/web, URLs point at R2)
  public/style.css
  public/setup.html       the widget-install guide (/setup), self-contained: no fingerprinted
                          subresources, since only index.html gets the hash substituted
  public/icons, ranks/    synced from internal/viz/bardata by tools/sync-assets.mjs (gitignored)
  public/replay_uploader.lua  the widget /setup hands out, synced from assets/lua by the same
                          script (gitignored — source of truth is assets/lua/replay_uploader.lua)
  src/worker/index.ts     wrangler entry: re-exports the app + the Durable Object class
  src/worker/app.ts       Hono app: serve R2 (index.json, replays/**), /api/replays,
                          /api/upload + jobs, SPA fallback (no workerd imports — node-testable)
  src/worker/replayindex.ts  the catalog + ingest-jobs Durable Object (SQLite)
  src/worker/replayentry.ts  catalog row shape + PUT body validation (node-testable, no workerd)
  src/worker/jobs.ts      the ingest job contract (kind, state, row shape), shared by the DO
                          and the routes — its own module because app.ts must import the kinds
                          as VALUES and may not pull `cloudflare:workers` into its graph
  src/worker/gameid.ts    pull a gameId out of a pasted replay link (twin of barapi.ParseGameID)
  src/worker/preamble.ts  minimal .brepstream preamble scan for /api/upload (gameId, ally team)
  tools/sync-assets.mjs   copies the vendored icons + the uploader widget into public/ before dev/build
  tools/smoke.mjs         boots the BUILT worker (vite preview -> workerd + the real asset
                          layer) and checks what it serves; `npm run deploy` gates on it
  tools/r2put.ts          shared upload backend: parallel S3 PUTs (with R2 creds) or parallel wrangler
  tools/upload.ts         upload a barreplay-static bundle (npm run upload)
```

## Producing and uploading replay data

```sh
# 0. create the buckets once (prod + the preview one `wrangler dev` binds)
npx wrangler r2 bucket create barreplay-replays
npx wrangler r2 bucket create barreplay-replays-preview

# 1. from the repo root: build the packer and pack captures into a bucket mirror
go build ./cmd/barreplay-static
./barreplay-static -out ./static ./snapshots/*.brp     # writes index.json + replays/**

# 2. upload to real R2 (walks only replays/**; no index.json — the listing is dynamic)
cd worker
npm run upload -- ../static <id>         # ONE replay to real R2 (the common case)
npm run upload -- ../static              # every replay in the dir, to real R2
npm run upload -- ../static <id> --local # into the local dev simulator (for `npm run dev`)
```

The default is **real R2**. The bucket must exist first — `npx wrangler r2 bucket create
barreplay-replays` — and you need either R2 API credentials (fast path, below) or a
wrangler login (`npx wrangler login`) to the account in `wrangler.jsonc` (`account_id`).

### Upload speed: the S3 fast path

Go publishers (`pack -upload r2`, the ingest daemon) upload **natively** when
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are set: a minimal SigV4 signer in
`internal/packer/r2.go` (pinned against aws4fetch's signatures) PUTs 16
objects in flight against `https://<account>.r2.cloudflarestorage.com` — no
node process involved. `-upload local` PUTs each piece through the running
dev worker's bearer-guarded `PUT /replays/*` route instead (the dev server
binds the simulator's bucket; a whole replay lands in milliseconds, vs ~1s of
node+wrangler startup **per object** through `wrangler r2 object put`). Only
the fallbacks — r2 without credentials, or local with the dev server not
running — shell into the TS tooling below.

The TS upload tools go through `tools/r2put.ts`, which picks a transport:

- **S3 API (fast).** Set `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` (create a token
  under Cloudflare dash → R2 → *Manage R2 API Tokens*, "Object Read & Write" on the
  bucket) and objects are PUT straight against
  `https://<account_id>.r2.cloudflarestorage.com` with [`aws4fetch`](https://github.com/mhart/aws4fetch)
  signing, 16 in flight in one process — a whole replay in a couple of seconds. The
  account id comes from `wrangler.jsonc` (`CLOUDFLARE_ACCOUNT_ID` overrides).
- **wrangler (fallback, and always for `--local`).** One `wrangler r2 object put` per
  object, 8 in flight (the local simulator stays serial — concurrent processes against
  the same miniflare state flake with 500s). Each spawn pays ~2 s of node+wrangler
  startup, which is why the old serial upload was slow; parallelism hides most of it,
  credentials stay wrangler's.

Either way each replay's `.brw` head is uploaded **after all its other objects** (a
completion barrier, not just ordering): the head is what the live listing keys on, so a
half-uploaded replay never appears in the picker.

Because the listing is built live, you upload **one replay at a time** —
`npm run upload -- ../static <gameId>` pushes just that replay's `.brw`, `.resources`, and
chunk files, and it shows up in the picker immediately. For a bulk import, `rclone`/`aws s3
sync ./static/replays -> bucket/replays` against R2's S3 API works too (same R2 API
token).

For a fresh capture there is a one-step shortcut: `cmd/pack` converts the raw stream
AND uploads in the same run (it shells into these same tools, so the auth options are
identical — export the R2 credentials to get the fast path). It also registers the
replay in the catalog (PUT /api/replays/<id>, see above) so it appears in the landing
list with its stats — point it at the deployed worker with `-index-url` or
`BARREPLAY_INDEX_URL` (for `-upload local` it defaults to the vite dev server):

```sh
# from the repo root:
BARREPLAY_INDEX_URL=https://<worker-host> \
go run ./cmd/pack -upload r2 ./caps/<gameId>.brepstream      # convert + push to real R2
go run ./cmd/pack -upload local ./caps/<gameId>.brepstream   # ...or seed the local dev simulator
```

Note on local buckets: both dev servers (`npm run dev` and `npx wrangler dev`) bind the
**preview** bucket, so seeding the simulator needs `--local --preview` with the upload
tool (`pack -upload local` passes both automatically).

## Drag & drop uploads (the ingest pipeline)

The landing page accepts a dropped `.brepstream` (the Replay uploader widget's
capture). The viewer serves exactly one wire format — the version-4 `.brp`
pieces — and the Worker deploys no Go and no transcoder, so the intake is split
between the Worker (cheap validation + storage) and a **Go daemon** running
wherever the repo lives (`cmd/bringest`, e.g. a VM):

| URL | What |
| --- | --- |
| `POST /api/upload` | open; validates the stream's preamble (`src/worker/preamble.ts`), archives the raw bytes at `streams/<gameId>/<ts>-a<ally>.brepstream` (append-only, never listed, never served publicly), inserts a pending `upload` job, returns `{job, gameId, streamKey}` |
| `POST /api/resim` | open; `{link}` → a pending `resim` job for a game **nobody uploaded** (see below) |
| `GET /api/jobs/<id>` | open; the job's state for the requesting browser's poll (`pending → processing → done \| error`) |
| `GET /api/jobs` | bearer-guarded; a daemon's work queue (pending + stalled-processing jobs of ONE kind, oldest first). `?kind=upload` (**the default**, so a deployed daemon is never handed work it cannot run) or `?kind=resim` |
| `GET /api/queue` | open; the same jobs for the landing page's **Queue** section, paged — `?offset=&limit=` (default 25, capped at 100) → `{jobs, total, active, offset}`, unfinished first then recently finished. `total`/`active` count the whole table, not the page. The archive key is left out, since those bytes are guarded |
| `GET /api/games` | open; a page of the **games mirror** for the landing page's **Games** section — `?offset=&limit=` (default 50, capped at 100) → `{games, offset}`, latest-ended first, each row a mirrored game plus `lobbyName`, `syncedUnix`, `published` (a playable catalog row exists) and `jobState` (its last ingest job). No total: the section reads "next page" off an extra row |
| `POST /api/jobs/<id>` | bearer-guarded; daemon transitions (`processing`, `done`, `error` + message, `stats`). `{state:"processing", claim:true, kind}` is a **claim**, which fails with 409 when another daemon already holds the job; a plain `processing` is the heartbeat a long job sends to keep the stale-job rule from offering it away |
| `GET /api/streams/<gameId>/<file>` | bearer-guarded; the daemon downloads the archived stream (it speaks only HTTPS to the Worker — no S3 reads, no inbound connectivity) |

The daemon polls, claims a job, downloads the stream, and publishes it through
the same `internal/packer` pipeline as `pack -upload`: demo fetch from the BAR
API for the rich metadata (falling back to the stream's own GAME preamble when
the API doesn't know the game), `.brp` conversion, revisioned static-bundle
upload, catalog PUT, then reports `done`. With the R2 credentials exported
(the intended deployment) the upload is **native Go** — concurrent SigV4 PUTs
straight against the bucket's S3 endpoint, so the host needs no node at all;
without them it falls back to shelling these tools via npx. The browser's
dropzone follows along and opens the replay when it lands. Uploads are
accepted while the daemon is down — jobs wait as `pending`, and a
`processing` job whose daemon died is re-offered after 15 minutes.

```sh
# on the VM / wherever the repo + worker/node_modules live:
export BARREPLAY_INDEX_URL=https://<worker-host>
export REPLAY_PUT_TOKEN=...                # if the worker guards writes
export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...   # S3 fast path for the puts
go run ./cmd/bringest              # poll every 10s, forever
go run ./cmd/bringest -once        # drain the backlog and exit
go run ./cmd/bringest -upload local -index-url http://127.0.0.1:5173  # against `npm run dev`
```

The raw archives under `streams/` accumulate on purpose (nothing in the bucket
is ever deleted): they are the substrate for the planned multi-player merge
(docs/widget-remote-upload.md), keyed by gameId with the recorder's ally team
(`-a<n>`, `-spec` for spectators) in the name.

### Re-simulating a replay nobody uploaded

A game with no `.brepstream` behind it has no way into the pipeline above, and
`bringest -resim` cannot find it either: that loop's work list is a scan of the
catalog for one-sided uploads, which by construction cannot see a game that was
never uploaded at all. The Queue section's paste box is that missing door — put
in a link from any site that shows BAR replays and the engine host publishes it:

```
https://gex.honu.pw/match/<gameId>
https://bar-rts.com/replays/<gameId>
https://www.beyondallreason.info/replays?gameId=<gameId>
<gameId>                                    # the bare 32 hex chars
```

`src/worker/gameid.ts` pulls the id out (the TypeScript twin of
`barapi.ParseGameID` — the two must stay in lockstep, since the Go side is what
eventually looks the game up). `POST /api/resim` then refuses everything it
should, before an hour of somebody's engine time is spent:

- the id has to parse;
- **`api.bar-rts.com` has to know the game.** Unlike an upload, a re-sim cannot
  degrade past a missing demo — the demo *is* the simulation input;
- the game must **not already be in the catalog**;
- a game already queued or running returns *that* job, so re-pasting a link is
  harmless rather than a second hour of work.

The box is admin-only, like the Queue section it sits in; the route itself is
open, like the row-refresh and point-of-view controls (the browser holds no
bearer token, and the refusals above are what keeps it cheap to expose).

A re-sim runs for far longer than the 15 minutes after which a silent
`processing` job is presumed dead and offered to somebody else, so the daemon
**heartbeats** — it re-reports `processing` every 60 s, which is also what makes
the queue row's *Updated* cell move while the engine works. The claim itself
(`claim:true`) is refusable, so two daemons polling the same round cannot both
run the same game.

```sh
# on the engine host (needs spring-headless + working GL — see CLAUDE.md):
go run ./cmd/bringest -resim -data ~/bar-data
```

That one process serves both halves: the requests first, then its catalog scan
for one-sided uploads. Upload jobs are untouched — run a plain `bringest`
alongside, on any host, with no engine at all.

### Where players get the widget (`/setup`)

The dropzone only helps someone who already has a capture, so its banner links
to **`/setup`** (`public/setup.html`): download `replay_uploader.lua`, drop it
in `…\data\LuaUI\Widgets\`, enable it from F11, upload the `.brepstream` each
game leaves in `…\data`. Three things make that page work:

- `tools/sync-assets.mjs` copies `assets/lua/replay_uploader.lua` into
  `public/` (gitignored, like the icons) so the repo keeps ONE copy of the
  widget and the download can never go stale against the decoder. It also
  STAMPS the copy: `__WIDGET_SHA__` becomes the SHA of the last commit that
  touched the widget, which is how a capture can later name the exact bytes
  that produced it (see the catalog's `widgetSha`). A widget with uncommitted
  changes is published unstamped — and `npm run smoke`, and so `npm run
  deploy`, fails on that rather than shipping captures with no provenance.
- `wrangler.jsonc` excludes `/replay_uploader.lua` from `run_worker_first`:
  through the Worker its `public/_headers` `no-cache` rule would be dead, and
  this is the one file whose bytes change under a stable URL.
- `src/worker/app.ts` routes `GET /setup` to the `/setup.html` asset. Without
  it the extensionless path reaches the catch-all, where the asset layer's
  single-page-application handling answers with the viewer's `index.html`.

The Go viz server serves the same page and widget from its embedded copies
(`internal/viz/server.go`), so the relative link in `index.html` resolves on
both backends.

## Commands

```sh
npm install
npm run dev         # vite dev — runs the Worker in workerd + HMR (needs a local R2, see below)
npm run build       # sync icons + widget, build client bundle + Worker into dist/
npm run preview     # vite preview — the client bundle alone, no Worker behind it
npm run test        # both suites below
npm run test:node   # node tests over the real Hono routes + pure modules (fake bindings, no workerd)
npm run test:do     # vitest in workerd (@cloudflare/vitest-pool-workers): the Durable Object's SQL
npm run smoke       # boot the BUILT worker in workerd and check what it actually serves
npm run typecheck   # tsc --noEmit
npm run cf-typegen  # regenerate worker-configuration.d.ts from wrangler.jsonc
npm run deploy      # test → sync+build → smoke → wrangler deploy (needs Cloudflare auth)
```

`npm run deploy` is the whole deploy: nothing has to be run before or after it.
The chain is spelled out in `package.json` rather than hidden in hooks —

1. `npm test` — the route-level node tests **and** the Durable Object tests.
2. `npm run build` — whose `prebuild` syncs the vendored icons **and the
   uploader widget** into `public/` (both gitignored, so a build is the only
   thing that puts them there) and stamps the asset hash + data origin.
3. `npm run smoke` (`tools/smoke.mjs`) — boots the built Worker under
   `vite preview` and asserts what it really serves.
4. `wrangler deploy`.

Step 3 exists because steps 1 and 2 cannot see the **asset layer**, which is
where this project's deploy bugs live. The node tests use a fake `ASSETS`
binding that answers any path it is handed, and `vite dev` serves `public/`
through plain static middleware. Only the real asset server redirects `.html`
URLs to their extensionless form, answers unmatched paths with `index.html`,
and applies `public/_headers`. All three have already shipped something that
passed every local check: `/favicon.ico` as the whole HTML document, and
`/setup` as an infinite redirect loop (the route rewrote it to `/setup.html`,
which the asset layer bounced straight back). The smoke checks are those
failure modes, one per line of output — including that the served
`replay_uploader.lua` is byte-for-byte the repo's copy.

`npm run typecheck` is deliberately **not** in the chain: it currently reports
pre-existing `noUnusedLocals` errors in `tests/`, so wiring it in would block
every deploy on unrelated cleanup.

To ship without the guards (a hotfix, or when `wrangler` is the only step that
matters), call the last step directly: `npm run build && npx wrangler deploy`.

For local dev, seed the local R2 with a packed bundle (`wrangler dev` binds the
`preview_bucket_name`):

```sh
npm run upload -- ../static --local
```

## Serving replay data straight from the bucket (`cdn-bar.fogofwar.dev`)

The Worker runs **before** Cloudflare's cache, not behind it. So a `/replays/*`
request served through the Worker is an R2 `GetObject` — a billed Class B
operation — **every time**, no matter what `cache-control` the response carries;
that header only ever helps a browser that already has the file. Binding the
bucket to its own hostname puts the cache in front of R2 instead: a cache hit is
answered at the edge, never becomes a `GetObject`, and so costs nothing.

The viewer therefore fetches the four bulk per-replay pieces (`.brw`, `.keys`,
`/c<n>`, `.resources`) from `cdn-bar.fogofwar.dev`, and everything else —
`/index.json`, `/api/*` — from the Worker, because the Worker *builds* those
(a bucket scan, the catalog Durable Object); they are not objects a bucket
could serve.

`replay.fogofwar.dev` (Worker)      SPA, /api/*, /index.json, uploads
`replay.bartools.workers.dev`       the same Worker on its workers.dev hostname
                                    (`workers_dev: true` in wrangler.jsonc —
                                    explicit, because configured routes flip
                                    wrangler's default to off)
`cdn-bar.fogofwar.dev` (R2 direct)  replays/** — cached at the edge

### One-time setup

```sh
# 1. bind the bucket to its hostname (--zone-id from the fogofwar.dev zone's
#    dashboard overview). The zone must be in the same account as the bucket.
npx wrangler r2 bucket domain add barreplay-replays \
  --domain cdn-bar.fogofwar.dev --zone-id <ZONE_ID> --min-tls 1.2

# 2. allow the viewer's origins to read it cross-origin. Without this the
#    browser blocks every replay fetch — the Worker path was same-origin and
#    needed none. r2-cors.json lists every hostname the viewer is served from
#    (the custom domain AND replay.bartools.workers.dev); RE-RUN this whenever
#    an origin is added to that file, or the new hostname loads a page whose
#    every replay piece the browser refuses.
npx wrangler r2 bucket cors set barreplay-replays --file r2-cors.json
npx wrangler r2 bucket cors list barreplay-replays   # verify it took
```

**3. Add a Cache Rule** for `cdn-bar.fogofwar.dev` in the dashboard
(Caching → Cache Rules): match `Hostname equals cdn-bar.fogofwar.dev`, action
**Eligible for cache**. This step is not optional and is easy to skip: by
default Cloudflare caches only a fixed list of file extensions, and **none of
these files qualify** — `.brw`, `.keys` and the extensionless `c0`, `c1`, … are
all unrecognised. Without the rule the hostname works, looks fine, and still
bills a Class B operation on every single read.

Verify by requesting the same piece twice and watching `cf-cache-status` go
`MISS` then `HIT`:

```sh
URL=https://cdn-bar.fogofwar.dev/replays/<id>.brw
curl -s -o /dev/null -D - "$URL" | grep -i cf-cache-status
curl -s -o /dev/null -D - "$URL" | grep -i cf-cache-status   # want HIT
```

Use a **GET**, not `curl -I`. Cloudflare never serves HEAD requests from
cache and answers every one of them `DYNAMIC`, so `curl -I` reports a
perfectly healthy hostname as uncached and sends you hunting for a
misconfiguration that is not there. `-o /dev/null -D -` is a real GET with the
body discarded.

Read the three statuses as: `DYNAMIC` = not eligible for cache (the Cache Rule
is missing or not matching), `MISS` = eligible but not in this datacenter yet,
`HIT` = served from the edge, never reached R2, no Class B operation. The cache
is per-datacenter, so the first request from any region is always a `MISS`.
A browser may also answer from its own cache without asking Cloudflare at all,
which is why this check uses curl.

### What the code does for this

- **`vite.config.ts`** stamps the origin into `index.html`'s `__DATA_ORIGIN__`
  placeholder at build time (`$DATA_BASE` overrides; an empty value pins the
  viewer back to same-origin). `vite dev` and the Go viz server blank it, so
  both keep serving their own files — that is why `app.js` routes those four
  URLs through `dataURL()` rather than hardcoding a host.
- **Uploads store `content-type` and `cache-control` on the object.** R2 replies
  with stored metadata verbatim on the direct path, so it can no longer be a
  serve-time fixup. The derivation is `objectHTTPMeta`, duplicated in
  `internal/packer/r2.go`, `tools/r2put.ts` and `src/worker/app.ts` — all three
  write into this bucket, so all three must agree.

### Backfilling replays published before this

Objects uploaded earlier carry no `cache-control`, so the edge will not hold
them and they keep costing a Class B read each. Re-uploading them fixes it —
`pack` is content-addressed and append-only, so re-publishing lands on the same
keys — or copy each object onto itself with the new metadata. Until then those
replays simply stay as expensive as they were; nothing breaks.

### Rolling it back

Set `DATA_BASE=` for the build and redeploy. The viewer goes back to
same-origin, the Worker serves everything again, and the bucket hostname can
stay bound — nothing else references it.
