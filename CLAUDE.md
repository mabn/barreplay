# CLAUDE.md

Guidance for working in this repo. Keep it current when commands or architecture change.

## What this project is

`barreplay` downloads a Beyond All Reason (BAR) replay, **re-simulates it headlessly**
in the Recoil (Spring) engine, and records periodic **snapshots** of game state (unit
positions, types, teams, health, lifecycle events) to disk. A `.sdfz` replay stores
only the deterministic input stream — not positions — so the only way to recover
positions is to replay it in the engine and sample state from a read-only Lua widget.

## Build / test / common commands

```sh
go build ./cmd/barreplay        # build the capture CLI -> ./barreplay
go build ./cmd/barreplay-viz    # build the visualization server -> ./barreplay-viz
go build ./cmd/pack             # build the .brsnap/.brepstream -> .brp converter -> ./pack
go build ./cmd/barreplay-static # build the .brp -> static-hosting bundle packer (for worker/)
go build ./cmd/bringest         # build the drag&drop upload daemon (polls the worker's job queue)
go test ./...                   # all unit tests (no engine required)
go vet ./... && gofmt -l .      # lint; gofmt -l prints nothing when clean
go run ./cmd/barreplay -no-run <link|gameId|file.sdfz>   # download+parse only, no engine
go run ./cmd/barreplay-viz -snapshots ./snapshots        # serve the viewer at 127.0.0.1:8080
go run ./cmd/pack ./caps/<gameId>.brepstream   # THE default publish: raw stream -> FULL .brp (fetches the demo for map/versions/players; -id overrides, -no-demo skips) -> stats -> upload to R2 + register in the deployed worker's catalog, revisioned. -upload, -stats and -rev all default ON, so the bare command does the whole job; a .brsnap input works the same
go run ./cmd/pack -upload= ./caps/<gameId>.brsnap   # pack + stats only, publish NOTHING (also how to analyze an existing .brp without republishing it)
go run ./cmd/pack -upload local ./caps/<gameId>.brepstream   # ...to the dev simulator instead
# -upload names a whole DESTINATION: the bucket AND the worker that serves+catalogs it, paired in
# internal/packer/targets.go ("r2" -> https://replay.fogofwar.dev, "local" -> http://127.0.0.1:5173)
# and shared with bringest. NEITHER CLI has an index-URL flag: naming the two halves separately made it
# possible to upload pieces to one deployment and register the row in the other, which nothing downstream
# can detect. Adding a destination to that one map makes it valid, documented and usable in both CLIs.
# $REPLAY_PUT_TOKEN authenticates the PUT.
# Publishes are REVISIONED by default: pieces land at replays/<gameId>-<rev> (rev = sha256[:8] of the PACKED
# .brp, NOT of the input stream: two packs of one capture can differ — a codec change, or -no-demo vs the
# demo fetch — and hashing the input gave them the SAME immutable keys, so the second silently overwrote
# the first. The .brp writer is deterministic, so an unchanged republish still re-lands on the same keys)
# and the catalog row's rid points at the current one — append-only, nothing in the bucket is ever
# overwritten or deleted (-rev=false uses the bare id). -stats prints a .brp size breakdown: per-section
# sizes + top-10 unit defs by encoded bytes with per-instance cost (snapshot.ComputeBRPStats, self-checked
# against the codec; raw captures pack first, then report).
go run ./cmd/barreplay-static -out ./static ./snapshots/*.brp   # pack .brp -> static bundle for R2 hosting (see worker/)
go run ./cmd/bringest   # drag&drop upload daemon: poll the deployed worker's job queue and publish uploaded .brepstreams, printing each one's .brp size breakdown like pack -stats (-stats=false quiets it; -once drains and exits; -upload local targets the dev simulator — one flag picks the queue, bucket and catalog together; -resim -data <BARdata> runs the re-sim worker instead: it drains the re-sims REQUESTED from the queue page's paste box, then scans the catalog for games with only a one-sided upload, publishing each full view as another revision)
```

Tests are hermetic: `barapi` uses a mock HTTP server, `demofile` tests against the
real fixture `internal/demofile/testdata/sample_header.sdfz`, `snapshot`/`capture`
are pure, `internal/packer` exercises its demo-metadata fetch against a mock
BAR API serving that same fixture, and `cmd/bringest` runs its loop
against a mock worker API. None of them launch the engine or touch the network.

## Architecture (where things live)

```
cmd/barreplay/main.go     CLI: link/gameId/.sdfz -> full pipeline
cmd/barreplay-viz/main.go CLI: serve the browser playback UI over a snapshots dir
cmd/pack/main.go          CLI: convert .brsnap/.brepstream captures to .brp; -stats prints the
                          size breakdown (sections + per-unit-def bytes, measured by
                          snapshot/brpstats.go and rendered by packer.ReportStats —
                          a .brp input is analyzed directly, never repacked). The pack/upload
                          PIPELINE itself lives in internal/packer (shared with the ingest
                          daemon, which prints the SAME report for every replay it publishes);
                          cmd/pack is the flags + the indexURLs map
                          that turns -upload into a full destination (bucket + catalog worker).
                          Its defaults are the everyday publish (-upload r2 -stats -rev), so a
                          bare `pack <capture>` packs, reports and publishes; -upload= opts out
                          of the publish, which is also the way to analyze a .brp in place.
internal/packer/          the capture-to-published-replay pipeline: Pack (stream parse + demo
                          metadata fetch -> .brp), ContentRev (sha256[:8] of a file; publishers
                          hash the PACKED .brp so a repack cannot overwrite served pieces),
                          LookupTarget/TargetHelp/TargetList (targets.go: the ONE table of
                          publishing destinations, each pairing a bucket with the worker that
                          serves and catalogs it — both CLIs validate -upload against it and
                          derive the URL from it, so the two halves cannot disagree),
                          ReportStats (stats.go: the .brp size report — it only RENDERS,
                          snapshot.ComputeBRPStats measures — shared so `pack -stats` and
                          every bringest publish print the identical breakdown), and
                          UploadStatic — writes the static bundle (viz.WriteStaticBundle) and
                          uploads it to the worker's R2 bucket so it appears in the deployed
                          viewer with no redeploy. For "r2" with R2 API credentials in the env
                          (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) the upload is NATIVE Go
                          (r2.go: a minimal SigV4 signer — pinned byte-for-byte against an
                          aws4fetch fixture, the signer the TS path uses against R2 — with 16
                          concurrent PUTs, one retry on 5xx, and the .brw-heads-last barrier;
                          account/bucket from CLOUDFLARE_ACCOUNT_ID/R2_BUCKET or the worker
                          dir's wrangler.jsonc, R2_ENDPOINT overrides). "local" PUTs each piece
                          through the dev worker's bearer-guarded PUT /replays/* route (the dev
                          server binds the simulator bucket; wrangler spawns cost ~1s EACH, the
                          route is milliseconds). Only the fallbacks (r2 without credentials;
                          local with the dev server down) shell the worker project's upload
                          tooling (npx in -worker-dir, default ./worker).
                          ALL inputs convert to .brp first; the viewer serves the .brp wire only. Revisioned by default: pieces land under
                          <gameId>-<rev>, append-only (identical bytes re-land on the same keys;
                          NOTHING in the bucket is ever overwritten or deleted — that keeps the
                          /replays/* immutable cache-control sound; superseded revisions stay
                          servable, the front-end hides them). After the upload it upserts the
                          replay's stats into the worker's catalog (PUT
                          <index-url>/api/replays/<gameId> — the BARE id; the body's rid field
                          carries the revision — body from viz.BuildCatalogEntry plus settings
                          flags distilled from the demo startscript's [modoptions] via
                          viz.SettingsFlags — ranked/lava/mods/scavUnits/extraUnits/quickStart/
                          comBuilders/noAir/noNukes/noLrpc/noEndgameLrpc; modoptions are NOT stored
                          in the .brp, they ride only this PUT, so -no-demo uploads carry none;
                          the IndexURL comes from the -upload target via packer.LookupTarget
                          (targets.go) in BOTH CLIs — bucket and catalog are ONE destination and
                          neither can be named on its own; an empty IndexURL (only reachable by
                          a hand-built UploadOptions) skips the PUT with a warning.
                          $REPLAY_PUT_TOKEN = bearer token when the
                          worker guards writes). UploadOptions.View overrides the point of view
                          the row records ("full" from bringest -resim, whose capture has no
                          recorder record of its own). "local" uploads pass --local --preview
                          because both dev servers (vite dev / wrangler dev) bind the PREVIEW
                          bucket.
                          Pack wraps a demo-fetch failure in ErrDemoUnavailable so callers can
                          degrade to a no-demo pack (the ingest daemon does).
cmd/bringest/main.go      CLI: the drag&drop upload daemon. Polls the worker's job queue
                          (GET /api/jobs, bearer $REPLAY_PUT_TOKEN), claims each job (POST
                          /api/jobs/<id> state=processing), downloads the archived stream over
                          the guarded GET /api/streams/<gameId>/<file> route (daemon->worker is
                          HTTPS only: no S3 reads, no inbound connectivity — runs behind NAT),
                          publishes via internal/packer under the stream's content-addressed
                          revision (demo fetch falling back to the stream's own GAME metadata
                          when the BAR API doesn't know the game), and reports done/error for
                          the browser to poll. -once drains the backlog and exits; jobs survive
                          daemon downtime as pending, stalled "processing" jobs are re-offered
                          after 15 min. It asks for ?kind=upload and additionally SKIPS anything
                          that is not one: the daemon and the worker deploy independently, so a
                          worker too old to filter still serves it re-sims, which it must leave
                          PENDING (not fail) for the host that can run them.
                          -resim (needs -data on an engine-capable host) runs a DIFFERENT worker
                          instead of the upload loop, taking work from two places in order.
                          First the QUEUED re-sims — GET /api/jobs?kind=resim, which serves
                          two things the daemon cannot tell apart and does not need to: the jobs
                          behind the landing page's paste-a-replay-link box, and, when there are
                          none pending, one the WORKER queues on the spot out of the games mirror
                          (ReplayIndex.jobsOffer — see the worker/ entry). So this list is
                          effectively never empty while any mirrored game is unpublished, and the
                          CATALOG SCAN below, which used to be the daemon's steady diet, now runs
                          only when it is: one-sided uploads are no longer picked up promptly.
                          That is the trade — an engine host that never idles, against a
                          slower path for the games somebody actually recorded half of. Each is CLAIMED (POST
                          state=processing claim=true, which the worker refuses with 409 if
                          another daemon holds it), HEALTHCHECKED every 10s while the engine
                          runs, and reported
                          done or error, that message being what the requester reads on the
                          queue page. The HEALTHCHECK (POST state=processing, carrying
                          `progress`) is two things in one request. It is the old heartbeat: a
                          re-sim outlives the 90-min stale window, so without a beat the worker
                          would offer live work away mid-run, and the beat is also what moves
                          the queue row's Updated cell. And it is the run's LIVE SELF-REPORT —
                          resim.Progress, read fresh at each tick (a pull, so the cadence stays
                          the daemon's; see internal/resim) and converted by progressOf: the
                          phase in words ("fetching demo", "provisioning content", "starting
                          engine", "loading", "simulating", then the daemon's own "packing" /
                          "uploading"), the sim frame against the demo's length as a percentage,
                          an ETA, and the ENGINE PROCESS's RSS and CPU. Ten seconds because that
                          second job sets the pace: a re-sim is otherwise an hour in which the
                          row says nothing but "processing", which is indistinguishable from a
                          daemon that died — and the engine's memory/CPU are the only window
                          anyone has onto the host doing the work, which is somebody's machine
                          behind NAT. The healthcheck is cancelled AND JOINED before the terminal
                          report, since a beat still in flight would flip a finished row back to
                          processing forever. The CATALOG SCAN half gets none of this: it has no
                          job row to report onto (its resim call is passed a nil Progress).
                          Then the CATALOG SCAN, as before: GET /api/replays
                          for games whose current upload is one-sided (uploaderAlly set) with no
                          full-view revision yet (no ally-null entry in the row's uploads list).
                          Either way it re-simulates the demo headlessly via internal/resim (the
                          cmd/barreplay pipeline packaged as one call: demo download -> provision
                          -> widget inject -> engine run -> .brp) and publishes the full-view
                          capture as another revision of the same game. The scan half still needs
                          no queue state at all — the publish itself retires the candidate (the
                          uploads list gains an ally-null entry) — which is why only IT keeps the
                          in-process failed-game memory; a requested job records its failure on
                          its own row and so leaves the queue by itself, making a re-paste the
                          retry. The work lists cannot overlap: a request is refused while its
                          game is in the catalog, a scanned candidate is in it by definition, and
                          the mirror backfill takes only games with no catalog row AND no job
                          row of any state. Upload jobs are untouched (run a plain bringest alongside,
                          on any host, with no engine).
                          Both loops share one workerAPI (the JSON helper, the bearer token, the
                          job transitions), which is why -resim now needs $REPLAY_PUT_TOKEN where
                          it did not before: its old single call, GET /api/replays, is open, and
                          the job routes are not. No new configuration in practice — packer
                          already reads that same var for the catalog PUT.
                          Both loops are hermetically tested against mock worker APIs.
                          resim REFUSES to return a truncated capture — a signalled engine
                          (Ctrl-C/OOM/crash; a plain non-zero exit is normal, the engine leaves
                          via quitforce) or a capture spanning under minCoveragePct of the demo
                          is an error, never a value — because the caller publishes what it
                          returns: a killed 55-min re-sim once packed 347 of 100170 frames and
                          went straight to uploading them over the real replay. It also moves the
                          raw stream with copy+remove on EXDEV (OutDir is usually a temp dir on
                          another filesystem, so a plain os.Rename leaked a ~100-160 MB stream
                          into the data dir every run).
                          At startup it loads ./.env (internal/envfile) into the environment
                          BEFORE the flag defaults are evaluated (still true of $BAR_DATA_DIR;
                          the worker URL no longer reads the environment at all, it comes from
                          -upload), so the R2 keys and $REPLAY_PUT_TOKEN work without
                          `source .env` — read from the
                          WORKING DIR, so run it from the repo root. It logs the var COUNT
                          (never values) and warns when R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY
                          are still absent, because otherwise that failure surfaces only as an
                          unrelated-looking CLOUDFLARE_API_TOKEN error out of the wrangler
                          fallback. Only bringest auto-loads; pack/barreplay still need a source.
                          -stats (DEFAULT ON, both loops) prints the packed .brp's size
                          breakdown — the same packer.ReportStats report as `pack -stats` —
                          after each publish, to STDERR so the -log file keeps it; a
                          measuring failure is a warning, never a lost publish (the bytes
                          are already packed and about to be uploaded by then).
                          PROCESSING STATS (jobStats): every JOB-backed publish also reports
                          what it cost onto the job row (the worker's jobs.stats JSON column),
                          which is the only place a person not reading this daemon's log can
                          see it. An upload records pack/upload seconds and the .brp size; a
                          re-sim adds resim.RunStats — engine wall time split into load and
                          sim (the split comes from watching the engine's stdout for the
                          widget's first "[barreplay]" line, exactly as cmd/barreplay does it),
                          frames against the demo's length, speed-up, engine version, and
                          engine.SummarizeInfolog's read of infolog.txt. The size report rides
                          along as text, with the daemon's TEMP PATH rewritten to the basename
                          first — it is gone by the time anyone reads the page and is nobody
                          else's business. Reported on FAILURE too: resim.Run fills its
                          Options.Stats in AS IT GOES precisely so a run that dies at minute
                          forty still says how far it got and what its log said. The catalog-scan
                          half has no job row, so its stats go only to the log.
                          -progress (DEFAULT ON) prints cmd/barreplay's frame/ETA line during a
                          re-sim; -log (default ./bringest.log) APPENDS everything printed to a
                          file as well as stderr. The tee swaps os.Stderr for a pipe rather than
                          threading a writer around, so it also captures what internal/resim and
                          internal/packer print; main is os.Exit(run()) so the deferred flush
                          runs on every exit path, and loadEnvFile RETURNS its lines (it must run
                          before the flags that name the log file) so they land in it too.
internal/envfile/         tiny stdlib KEY=VALUE loader for ./.env. Accepts the bash-sourceable
                          subset (`export FOO=bar`, # comments, optional surrounding quotes) so
                          ONE file works both auto-loaded and sourced. Already-set vars WIN (the
                          file is a default, never an override); a missing file is a no-op; a
                          '#' in an unquoted value is kept, since secrets contain them and a
                          silently truncated key is worse than requiring quotes.
cmd/barreplay-static/main.go CLI: pack .brp -> static-file bundle (index.json + replays/**) for R2 hosting
internal/barapi/          resolve gameId via api.bar-rts.com; download .sdfz from OVH.
                          That API is github.com/beyond-all-reason/bar-db (BAR's infra docs:
                          "effectively https://api.bar-rts.com/"; the site half is the separate
                          Jazcash/bar-live-services) — the source of truth for the response shapes
                          this package, packer's demo fetch and the worker's /refresh-settings all
                          decode, and for the OVH demo path, which the API itself never returns.
                          Its GET /replays SEARCHES the ~2.7M-game history (filters: preset=
                          team|duel|ffa, players, maps, date, durationRangeMins, tsRange,
                          endedNormally, hasBots, reported; limit<=100, computeTotalResults=true
                          or totalResults is -1) — unused by this repo, but it is how you find
                          games to feed the re-sim queue. Multi-valued filters REPEAT the key
                          (players=a&players=b); the players[]= form is silently dropped and
                          answers unfiltered. See the package doc for the details.
internal/demofile/        gunzip + parse packed header + TDF startscript + the packet
                          stream's CHAT and MAP DRAWINGS (comms.go -> Demo.Comms). The
                          stream is what the SERVER broadcast, which makes it the
                          AUTHORITATIVE comm source and the one every pipeline prefers
                          (capture.ReplaceComms): chat is broadcast unfiltered — each
                          client filters for display — so it holds every side's ally
                          chat, the spectator channel and whispers with the sender's own
                          destination byte, and it is framed EXACTLY because the
                          KEYFRAME/NEWFRAME packets sit in the same stream (one per sim
                          frame; keyframes carry the number, so counting them is exact).
                          Unit positions are still NOT read from it — that is what the
                          re-simulation is for. Only three packet types are decoded
                          (chat 7, mapdraw 32, the two frame packets); everything else is
                          skipped by its chunk length, since a demo chunk holds exactly
                          one packet — which is what keeps the scan robust across engine
                          versions. Best-effort: a demo cut short by a crash (whose
                          header may not even declare a stream size) keeps whatever was
                          recovered before the break. It also DROPS the messages BAR's
                          own UI publishes on the chat channel — the player list's
                          "I need energy" buttons send an i18n KEY ("> :ui.playersList.
                          chat.giveEnergy:amount=2186:name=c0y") as an ordinary chat
                          packet from that player. Not a detail by volume: one real 8v8
                          sent 133 of them against 91 typed messages. Dropping them also
                          makes the demo agree EXACTLY with the widgets (whose console
                          parser already rejected them) — the two independent sources
                          then both report 98 messages for that game, which is the
                          cross-check that the packet decoding is right. Typed autohost
                          commands ("!cv resign") are kept: a person wrote those.
internal/engine/          locate spring-headless/pr-downloader, provision, launch, stream stdout.
                          Run records the child's pid (Engine.Pid) so a caller can watch the
                          run's resource use without Run growing a fourth return value — one
                          run per data dir (LockDataDir) means there is never a second live
                          process to confuse it with. SampleProcess/CPUPercent (procstat.go)
                          read /proc/<pid>/stat for RSS and cumulative CPU: indexed from the
                          LAST ')' because comm is the executable name in parentheses and may
                          contain spaces and parens, USER_HZ hardcoded at 100 (a sysconf call,
                          and this repo is cgo-free; a wrong value would only scale the
                          percentage), and best-effort like everything else that reads the
                          engine's leavings — a process that just exited is ok=false, never an
                          error. LastLoggedFrame exposes what WatchProgress polls (the newest
                          "[f=]" marker in the infolog), which is the ONLY running-progress
                          signal a headless replay emits.
                          SummarizeInfolog (infolog.go) reduces a finished run's infolog.txt to
                          size/lines/last frame plus DESYNC and warning counts — substring
                          heuristics, not a parse of a grammar the engine promises, and the
                          desync count is the point: a re-simulation that desynced describes a
                          game that never happened and is indistinguishable from a good capture
                          on disk. Best-effort like everything reading the engine's leavings —
                          a missing log yields a zero summary, never an error.
internal/resim/           the cmd/barreplay pipeline packaged as one call (Run: demo download
                          -> provision -> widget inject -> engine run -> .brp), for the ingest
                          daemon's -resim mode. Options.Stats is the record read AFTERWARDS
                          (filled in as it goes, so a run that dies at minute forty still says
                          how far it got); Options.Progress (progress.go) is the LIVE view read
                          from another goroutine WHILE it runs, which is how a job that will not
                          return for an hour reports in. Progress is a PULL — Snapshot under a
                          mutex, not a callback — so the reporting cadence stays the reporter's
                          (the daemon beats every 10s); a nil one is inert, which is what every
                          caller that does not want it passes. Run stamps the phase as it moves
                          (PhaseFetchingDemo/Provisioning/StartingEngine/Loading/Simulating/
                          Capturing — Simulating set from the stdout scanner's first
                          "[barreplay]" line, the same boundary that splits LoadSec from
                          SimSec), and SetPhase is exported because the phases after Run returns
                          belong to the caller. watchProgress samples every 5s while the engine
                          lives: engine.LastLoggedFrame for the sim frame (percent + an ETA off
                          an EWMA of the frame rate — the instantaneous rate swings hard,
                          because the engine's pacing governor idles it in bursts) and
                          engine.SampleProcess for the engine's RSS and CPU. A phase change
                          clears the sim numbers (they described the phase that ended) but keeps
                          the process reading (the process did not).
internal/capture/         parse the widgets' streams -> snapshot records (BRSNAP text in
                          capture.go, binary .brepstream in brep.go, shared preamble +
                          comm-record parsing in lines.go). COMM records (text) / 'C'
                          records (binary) carry one JSON payload each — a chat message or
                          a map drawing — through the SAME parser (parseComm), whose
                          sanitizeCommText length-caps the player-authored text and strips
                          control characters before it can reach a browser.
internal/viz/             serve the viewer (SPA embedded from worker/) + the static-shaped replay URLs
internal/viz/static.go    pack a .brp into plain static files (byte-identical to the served URLs) for serverless hosting
worker/                   Cloudflare Worker (Hono + Vite) hosting the viewer as static files from R2 (no playback server);
                          worker/public + worker/index.html are THE front-end (embedded into barreplay-viz via assets.go).
                          UI CACHE-BUSTING: index.html references /app.<rev>.js /
                          /style.<rev>.css — the hash is in the FILENAME, not a ?v= query, so a
                          given byte sequence's URL never changes and public/_headers serves it
                          immutable for a year. __ASSET_REV__ is stamped with
                          sha256(app.js+style.css)[:8] by the Vite asset-rev plugin
                          (vite.config.ts, build AND dev) and by the Go viz server at startup
                          (viz.assetRev), and index.html itself is served no-cache (the Hono
                          serveEntry route; the Go server serves all UI no-store) — so a UI
                          deploy propagates on a plain reload, no hard refresh. Vite copies
                          public/ VERBATIM and fingerprints nothing, so the plugin emits the
                          hashed copies itself (generateBundle) and rewrites the hashed URL back
                          to the plain file under `vite dev`; the Go server, which has no build
                          step, registers the hashed routes for the rev it computed.
                          STATIC ASSET CACHING: run_worker_first is ["/*", "!/icons/*",
                          "!/ranks/*"]. The "/*" preserves the original guarantee (no route
                          falls through to the asset layer's single-page-application handling,
                          which would answer /api/* with index.html — the reason a plain LIST of
                          worker paths is a trap). The exclusions hand the two vendored prefixes
                          to the asset layer, which matters twice: a cold replay load requests
                          300-650 unit icons, each an invocation when routed through the Worker,
                          and public/_headers applies ONLY to asset-layer responses — through the
                          Worker its cache-control rules are silently dead. Icons are NOT
                          fingerprinted and cannot be: each icon's path is baked into the
                          unitIcons map of every published .brw (internal/viz/icons.go writes
                          "icons/<file>"), so renaming would 404 the icons of every replay
                          already published — hence a week's max-age rather than immutable, and
                          purge the zone after re-syncing the vendored bitmaps.
                          HOSTNAMES: the worker is served from replay.fogofwar.dev (a wrangler
                          Custom Domain — a PER-HOSTNAME cert, so no wildcard and no Advanced
                          Certificate Manager; the zone must live in the worker's own account).
                          NO STAGING/PREVIEW deployment exists, and Workers preview URLs
                          CANNOT work here: previews are never generated for Workers that
                          implement a Durable Object (hard platform limitation; this one
                          implements ReplayIndex — no toggle or wrangler flag changes that,
                          which was learned the hard way). A separate staging Worker was
                          tried and scrapped: binding production's DO via script_name runs
                          production's DEPLOYED DO code, so any branch adding a DO method
                          500s on staging (observed with queuePage), and an own-DO staging
                          tests against an empty catalog — neither serves pre-prod testing.
                          Verify changes with worker/tests (`npm test` = the node runner over
                          the routes and pure modules, PLUS vitest-in-workerd over tests/do —
                          the Durable Object, whose behaviour is its SQL and which plain node
                          cannot import) + `npm run smoke` + `vite dev`,
                          then deploy.
                          The BULK replay pieces (.brw/.keys/c<n>/.resources) are NOT fetched
                          from it: they come from cdn-bar.fogofwar.dev, the R2 bucket bound
                          directly to a hostname. A Worker runs BEFORE Cloudflare's cache, so
                          every /replays/* read through it is a billed Class B GetObject no
                          matter what cache-control it sets; served straight from the bucket a
                          cache HIT never reaches R2 and costs nothing. /index.json and /api/*
                          stay on the worker because it BUILDS them (bucket scan, catalog DO).
                          app.js routes exactly those four URLs through dataURL(), whose origin
                          comes from index.html's __DATA_ORIGIN__ placeholder: stamped by the
                          Vite dataBase plugin on a BUILD only ($DATA_BASE overrides), BLANKED
                          by `vite dev` and by the Go viz server (which is the origin for its
                          own files) — empty means same-origin, and app.js ignores any value
                          that is not an absolute http(s) origin, so an unsubstituted
                          placeholder degrades rather than breaks. The placeholder token is
                          deliberately NOT the global's name (window.__DATA_BASE__): both
                          substituters do a plain textual replace, and a token that also
                          matched the identifier rewrote it into `window.https://... =`.
                          Two things are external setup, not code, and BOTH are silent when
                          missing: an R2 CORS policy (worker/r2-cors.json — the fetches are
                          cross-origin now; without it the browser blocks every piece) and a
                          Cache Rule making the hostname eligible for cache — Cloudflare's
                          default cache list is by file extension and matches NONE of .brw,
                          .keys or the extensionless c<n>, so without the rule everything still
                          bills Class B while looking perfectly healthy. See worker/README.md
                          for the runbook. Consequence for uploads: content-type and
                          cache-control are STORED on each object (objectHTTPMeta, duplicated
                          in internal/packer/r2.go, worker/tools/r2put.ts and
                          worker/src/worker/app.ts — all three write this bucket, so all three
                          must agree), because R2 serves stored metadata verbatim on the direct
                          path and no worker is there to fix it up. Objects published before
                          that carry none: they still serve (the worker recomputes on its own
                          hostname) but are uncacheable at the edge until re-uploaded.
                          The replay CATALOG (per-game stats: start time, duration, map, team-size
                          spec like "8v8", bundle bytes) lives in a SQLite table inside a Durable
                          Object (src/worker/replayindex.ts, single instance, wrangler migration v1
                          new_sqlite_classes): GET /api/replays lists it newest-game-first (null
                          start times last), PAGED by ?limit=&offset= (absent limit = the whole
                          listing) and FILTERED by its query params (parseReplayFilter:
                          from/to — unix seconds or YYYY-MM-DD, where a YYYY-MM-DD `to` covers the
                          whole day — map, minPlayers/maxPlayers, minDuration/maxDuration in
                          seconds, player = a case-insensitive name
                          PREFIX, settings = comma-separated flags that must ALL be present; no
                          params = the whole catalog, unknown params ignored so an older front-end
                          still works). Filtering is SQL, not a pass over the JSON: name and flag
                          predicates hit the derived tables replay_players(replay_id, name_lower,
                          name) and replay_settings(replay_id, flag), which are DELETED and rebuilt
                          from the row on every write (upsert, refreshFromApi) so they cannot drift
                          and so a re-publish that drops a player stops matching them; every
                          predicate is index-backed (replays_start / replays_map / replays_count and
                          the two derived tables' covering indexes — verified with EXPLAIN QUERY
                          PLAN, no sequential scans). The prefix match is a >= / < RANGE rather than
                          LIKE, since SQLite's case-insensitive LIKE cannot use an index. The WHERE
                          clause is built from the predicates actually set, NOT a fixed
                          `(? IS NULL OR col = ?)` chain, which hides the column behind an OR and
                          forces a scan. schema_meta.derived_version (DERIVED_VERSION) triggers a
                          one-time rebuild of playerCount + both tables on the next wake when it is
                          bumped, which is also how rows predating them were backfilled.
                          GET /api/replays/facets serves the distinct maps/sizes/player names/flags
                          plus the catalog's date span, so the filter bar offers only choices that
                          match something; it is computed over the WHOLE catalog, never the current
                          result set (options that vanish as you filter cannot be used to change
                          your mind). PUT /api/replays/<id> upserts (called by pack -upload
                          and the ingest daemon; optionally guarded by the REPLAY_PUT_TOKEN wrangler
                          secret as a bearer token). Rows are keyed by the BARE gameId and carry a
                          nullable `rid` (the <gameId>-<rev> revision the pieces are actually served
                          under — see the internal/packer entry; the front-end fetches at rid ?? id)
                          plus a nullable `settings` object (notable game-settings badges: ranked/
                          unranked, lava, mods, zombies, ruins, …) sourced from the demo fetch — see
                          the internal/packer entry — plus `players` (per-ally rosters by OS with the
                          ally's true count, from viz.BuildCatalogEntry, capped at
                          catalogPlayersPerAlly / CATALOG_PLAYERS_PER_ALLY = 32 — a FILTER limit, not
                          a display one: the list filters by "was this player in the game" and can
                          only match names a row stores, so the old cap of 5 left every 8v8 hiding
                          three players a side; rows published under it get their full roster back
                          from the admin refresh-settings route, which re-derives from the BAR API),
                          a derived `playerCount` (total players, Gaia/scavengers excluded — the
                          size the list filters on: derivePlayerCount sums the ROSTER's counts and
                          only falls back to the gameSize spec, because gameSize is built from the
                          TEAM list where a scavenger ally survives, rendering an 8v8-with-scavs as
                          "8v8v1"), a nullable
                          `uploaderAlly` (the recording client's side, from the .brp meta's
                          `recorder` — the live uploader widget's GAME line; null for re-sim/
                          spectator captures), the WIDGET-PROVENANCE trio widgetVersion/
                          widgetSha/widgetDate, and a server-owned `uploads` list
                          ([{rid, ally, widget?}],
                          accumulated across PUTs via mergeUploads — never accepted from a PUT
                          body) remembering every revision ever published for the game.
                          The widget trio records WHICH BUILD of the uploader widget produced
                          the capture behind the current revision: version+date are the
                          constants the widget bumps together and has to (a player's installed
                          copy can be arbitrarily old, so the stream is the only place this can
                          be learned), and the sha is the git commit of the exact file, stamped
                          into the published download by worker/tools/sync-assets.mjs — the
                          difference between "1.7.0" and "the 1.7.0 that was being served that
                          week". THREE COLUMNS, not one JSON blob, because the point is to be
                          able to ask "which builds are in the wild" / "which replays came from
                          the build with that bug" in SQL without opening a blob per row.
                          sanitizeEntry shape-checks the sha (lowercase hex 7-64) since it is
                          the one field meant to be matched against a git history; version/date
                          are free-form and length-capped. All three are COALESCEd by the
                          upsert exactly like `view`: an unstamped widget (installed from the
                          repo), a re-sim revision and a pre-1.7.0 stream all state nothing,
                          and silence must not erase what an earlier publish knew. Since the
                          row describes only the CURRENT revision, per-revision provenance
                          lives in the uploads entries, each of which carries the build that
                          produced that upload.
                          `view` ("full"|"ally"|"unknown"|null) states WHOSE POINT OF VIEW the
                          capture is from, because `uploaderAlly` alone cannot: null there is
                          ambiguous between a spectator (saw everything), a re-sim, and a row
                          predating the recorder fields — and most rows are the last case, which
                          nothing can derive after the fact. It is set two ways. A PUBLISHING
                          PUT states it when the capture knows: viz.BuildCatalogEntry fills it
                          from the .brp's Meta.Recorder ("full" when Spectator, else "ally" +
                          uploaderAlly), and a re-sim — whose capture has no recorder record at
                          all, since only the live uploader widget writes one — declares "full"
                          through packer.UploadOptions.View (set by bringest -resim), without
                          which the row would keep the marking of the one-sided upload it just
                          superseded. Everything else is HAND-SET via POST /api/replays/<id>/view
                          (open, like refresh-settings; body {view, ally}, validated by
                          parseViewRequest) from the viewer header's POV dropdown — which, also
                          like refresh-settings, appears only under ?admin=true (app.js
                          adminMode(), carried into the replay view by replayHref; it edits a row
                          every visitor reads, so it is maintenance, not a viewing preference) —
                          and setView
                          also re-stamps the current rid's uploads entry so the per-revision
                          history agrees. upsert COALESCEs it (`view = COALESCE(excluded.view,
                          view)`): a PUT that states a view wins (it describes the revision the
                          row now points at), silence keeps what is there — deliberately UNLIKE
                          uploader_ally, which upsert overwrites unconditionally and which a
                          later recorder-less PUT therefore nulls while mergeUploads preserves
                          the truth in uploads[]; that asymmetry is why every deployed row read
                          uploaderAlly=null. sanitizeEntry ACCEPTS view from the PUT body (only
                          `uploads` is server-owned) — refusing it, so that setView alone could
                          write the column, is what made every fresh upload arrive unmarked even
                          though its stream named the recording side.
                          POST /api/replays/<id>/refresh-settings (open; admin UI) re-derives one
                          row's settings AND players from the BAR API's stored demo metadata (its
                          replay detail carries the demo modoptions verbatim as gameSettings, plus
                          the AllyTeams roster) via settingsFlags + playersFromApi in replayentry.ts
                          — settingsFlags is the TypeScript twin of viz.SettingsFlags, the two MUST
                          stay in lockstep — so badges/rosters refresh without repacking/
                          re-uploading (players are only overwritten when the API names anyone).
                          The front-end deliberately hides some recorded flags (HIDDEN_SETTINGS in
                          app.js: scavUnits/extraUnits/noAir — too common to badge) and suppresses
                          `mods` next to lava/zombies (those modes ship as tweak blobs, which is
                          what `mods` detects) — display choices only, the data stays in the rows.
                          Row shape + PUT validation + the filter/facet contract live in
                          src/worker/replayentry.ts
                          (pure, node-tested) and MUST stay in lockstep with internal/viz/catalog.go,
                          which serves the same GET /api/replays computed live from .brp files so the
                          shared front-end works against both backends (the Go server leaves rid
                          null — its files are unrevisioned — and implements NO filtering: it lists a
                          local directory, so it ignores the query params and 404s /facets, which is
                          exactly what keeps the filter bar off there. The one Go-side piece the
                          filters DO depend on is catalogPlayersPerAlly, because BuildCatalogEntry is
                          what builds the roster the worker stores). The front-end landing page
                          (no ?replay= in the URL) is a LEFT MENU (app.js homeTab/applyHomeTab,
                          #homenav) over two sections: "Replays" (the catalog list, the default)
                          and "Queue" (the ingest jobs, below), which is ADMIN-ONLY — the entry is
                          hidden without ?admin=true (CSS, like the row refresh button) and
                          homeTab() maps the tab back to "replays" for everyone else, so a shared
                          ?tab=queue link cannot walk past the hidden entry and refreshQueue never
                          fires. It is the pipeline's state — every uploader's jobs and their
                          failure messages — which is maintenance, not something a visitor came for.
                          Which section is shown lives in the
                          URL as ?tab=, like the filters, so a pick is shareable and survives a
                          refresh — but it PUSHES a history entry, because switching section is
                          navigation, not a narrowing of what is listed; replayHref carries the
                          param into a replay so back returns to the section it was opened from.
                          The dropzone sits above both sections (a drop is accepted from either,
                          and its progress line stays visible while the Queue is watched).
                          "Replays" renders the catalog with
                          superseded revisions of cataloged games hidden (their
                          direct ?replay= links keep playing — nothing is deleted); picking a replay
                          sets ?replay=, the header title returns to the list. The list's Players
                          column shows each side's top names by OS (3 per side for a two-team game,
                          1 when there are more sides; full roster + OS in the tooltip) with a ◉ on
                          the side that recorded the current upload, the Links cell adds an alt·T<n>
                          SPA link per other uploaded revision (from the row's `uploads`), and
                          ?admin=true reveals a per-row ⟳ button calling the refresh-settings route.
                          WORK IN PROGRESS (rows the pipeline owns): a game with a job in
                          "processing" is in this list too, so the work is visible while it runs
                          rather than only once it lands — the DO inserts a PLACEHOLDER catalog
                          row when any job enters that state (ensureCatalogPlaceholder, from
                          jobClaim and from a jobUpdate reporting processing), seeded from the
                          games mirror so it shows the map and roster instead of five dashes.
                          Such a row is NOT OPENABLE: there is nothing published, so app.js gives
                          it no internal links at all (a `linkish()` span in place of every cell's
                          <a>, class `unopenable` on the tr, no pointer, no click) — the row's
                          `placeholder` flag is what says so, since a null rid cannot: the Go
                          server's rows have none and play fine. Its Settings cell LEADS with a
                          `processing` pill (the one filled, pulsing badge among the muted ones —
                          it is not a game setting but the reason the row exists, so it must not
                          be hunted for among them). A row that WAS already published and is being
                          re-simulated gets the same pill and stays openable, since a revision
                          exists to play. Both flags are server-owned and neither is stored as
                          state to maintain: `processing` is an EXISTS over the jobs table
                          computed per read (jobs_game index), so it clears itself the moment the
                          job stops running — no path can leave a row saying "processing"
                          forever; `placeholder` is cleared by the publishing upsert, and a job
                          that ends WITHOUT publishing deletes the row (dropCatalogPlaceholder),
                          so a failed re-sim leaves no dead entry in a list of playable things.
                          The derived tables are deliberately left alone by that delete: their
                          entries were copied from the games row, which still describes the game.
                          Consequence elsewhere: resimEnqueue's "already published" check reads
                          `placeholder = 0`, or pasting the link of a game being worked on would
                          be refused as published instead of answered with the job doing it.
                          FILTER BAR (app.js initFilters, above the table), in TWO ROWS: the
                          fields (date from/to, map, a player-count RANGE, a duration RANGE,
                          player name — a datalist of the known names, debounced 300 ms), then
                          the settings chips with Clear/Unregistered/count pushed to the far end.
                          Two rows because one wrapped at some widths and not others, which moved
                          the buttons around as the catalog gained flags.
                          Both ranges are ONE function (initDualRange): two <input type=range>
                          stacked over a single track — real inputs, so keyboard and focus rings
                          come free — with only the domain, step and wording differing. A thumb
                          parked at its END writes NO param, which is what makes the full span
                          genuinely unfiltered rather than a filter matching everything, and is
                          also what gives DURATION its open top end: 0..DURATION_MAX_SEC=1h in
                          minutes, where the right thumb at 1h simply stops restricting, so
                          every longer game is included ("20m+" rather than "20m–1h"). Players
                          spans the facets' own min..max, step 1, and hides itself when the
                          catalog holds fewer than two distinct sizes. The thumbs push instead of
                          crossing, dragging paints every frame but only queries after a 250 ms
                          pause (a drag is otherwise a query per pixel), and because both inputs
                          are full-width and stacked, which thumb a press grabs is settled on
                          HOVER — hit testing happens before the press — by whichever is nearer,
                          with the pointer's side of an exactly-overlapping pair breaking the
                          tie. Players replaced an exact-count <select> that could only ask for
                          one size at a time; the API took min/max all along, and now takes
                          minDuration/maxDuration in SECONDS (six digits, so a hand-written URL
                          can ask for a three-hour game the slider cannot reach; a row with no
                          recorded duration matches NEITHER bound, since there is nothing to
                          compare).
                          PAGING (app.js PAGE_SIZE=50, renderPager, #homepager above the table):
                          Prev/Next and the range being shown ("101–150"), and deliberately NO
                          page count — counting the pages means counting the whole catalog on
                          every listing, and the range answers the question the number was for.
                          The listing asks for one row MORE than it shows and reads "there is a
                          next page" off that row's existence, so nothing counts anything.
                          ?limit=&offset= are served by BOTH backends (the DO appends
                          LIMIT/OFFSET to the ordered query; the Go server slices its sorted
                          listing — it ignores the FILTER params, but ignoring these would make
                          the shared Next button lie), and an absent limit still means the whole
                          listing, which is what bringest's catalog scan asks for. The page is
                          in-process state, NOT in the URL (like the queue's pager and unlike
                          the filters): "page 3" describes a moment in a growing list, not a set
                          of replays. Any filter change returns to the first page. Orphan mode
                          is the exception that pages in the BROWSER: merging in unregistered
                          uploads means knowing which of them a catalog row already covers,
                          which one page of rows cannot answer — and that mode already reads the
                          whole bucket. Every control writes a URL param and
                          re-queries GET /api/replays — the filtering is the server's, so the count it
                          reports is the true number of matches, not what happened to be fetched. The
                          state lives in the URL (history.replaceState, so filtering is not
                          navigation and the back button leaves the list rather than stepping through
                          keystrokes), which makes a filtered list shareable and survive a refresh,
                          and replayHref carries it into a replay so returning lands on the same list.
                          While any filter is active the /index.json-only stubs are dropped: they have
                          no map, size, roster or settings, so no filter could be true of them. The
                          bar stays HIDDEN unless GET /api/replays/facets answers — the Go viz server
                          serves the same catalog shape from local files with no filtering behind it,
                          and a filter bar that silently does nothing is worse than none.
                          /index.json is NOT merged into the list by default, because it is not a
                          file: the worker BUILDS it per request by paging the bucket's whole
                          replays/ prefix (~3.4k objects — every head/keys/resources and 64-sample
                          chunk of every published revision, 1000 per round trip), measured at ~1.5 s
                          against the catalog's ~90 ms. All it adds is uploads whose files exist but
                          which were never registered, so it is fetched only when it can change what
                          is shown: when /api/replays is unavailable (it is then the WHOLE listing —
                          an old deployment or a plain static host) or on ?orphans=true, the admin
                          bar's "Unregistered" button (a button, not something ?admin=true does to
                          every page load; disabled while a filter is active, since a stub has no
                          metadata any filter could match). Consequence: an unregistered upload is
                          invisible until someone asks for it. knownReplayURL therefore no longer
                          treats replayList as the catalog — it is a filtered subset that also omits
                          stubs, so any well-formed id is attempted and loadReplay reports a real
                          failure rather than silently bouncing a shared ?replay= link to the list.
                          DRAG&DROP UPLOADS: the landing page's dropzone POSTs a raw .brepstream to
                          /api/upload (open endpoint; the Hono app lives in src/worker/app.ts, kept
                          free of workerd imports so worker/tests drive the real routes; index.ts is
                          the wrangler entry re-exporting the DO class). The worker never transcodes
                          (viewer serves the .brp wire only; the Go pipeline produces it): it scans
                          the preamble (src/worker/preamble.ts — gameId + recorder's ally team),
                          archives the raw bytes at streams/<gameId>/<ts>-<hash8>-a<ally>.brepstream
                          (job KIND "upload"; see the resim door below for the other kind)
                          (the hash is sha256[:4 bytes] of the body and is what makes the key unique:
                          gameId and the a<ally> suffix are equal for two teammates uploading the same
                          game, or for a halfway capture and the full one, and Workers clamp Date.now()
                          to the last I/O so it does not advance within a request — concurrent uploads
                          collided and the second overwrote the first. Timestamp stays first so the
                          prefix sorts oldest-first, so identical bytes are re-archived, not deduped)
                          (append-only prefix, never listed by /index.json, never served publicly;
                          the substrate for the future multi-player merge), and inserts a job row in
                          the DO's jobs table. cmd/bringest (see its entry) polls
                          GET /api/jobs, downloads via GET /api/streams/<gameId>/<file> (both
                          bearer-guarded), publishes, and POSTs done/error; the browser polls the
                          open GET /api/jobs/<id> and auto-opens the replay on done.
                          RE-SIM REQUESTS: the pipeline's OTHER door, for a game nobody uploaded
                          — which is invisible to bringest -resim's catalog scan, since that
                          looks for one-sided UPLOADS. The Queue section's paste box POSTs a
                          replay link to the open POST /api/resim, which parses the gameId out of
                          it (src/worker/gameid.ts — accepts gex.honu.pw/match/<id>,
                          bar-rts.com/replays/<id>, ...info/replays?gameId=<id> and a bare id;
                          the TS twin of barapi.ParseGameID, which the two MUST stay in lockstep
                          on since Go is what looks the game up. It splits the URL BY HAND rather
                          than with `new URL`, which throws on a scheme-less paste — routine in a
                          copy-pasted link — where Go's url.Parse reads it as a path and finds
                          the id) and inserts a "resim" job. Everything it refuses, it refuses
                          BEFORE an hour of engine time is committed: an unparseable link (400);
                          a game api.bar-rts.com does not know (404 — unlike an upload a re-sim
                          cannot degrade past a missing demo, the demo IS the simulation input;
                          the fetch copies /refresh-settings' handling and lives in the ROUTE,
                          not the DO, so the node tests can stub globalThis.fetch); a game
                          already in the catalog (409); and a game already queued or running,
                          which returns THAT job (so re-pasting a link is harmless rather than a
                          second hour of work). The catalog check, the duplicate check and the
                          insert are ONE DO call (resimEnqueue) — the DO is single-threaded, so
                          that is atomic for free, where three round trips would let two pastes
                          of the same link both insert.
                          JOB KINDS: jobs.kind is "upload" | "resim", a KIND rather than a fifth
                          state because the four states describe both equally well — what
                          differs is the work, not the progress. The contract (JobKind,
                          JOB_KINDS, IngestJob) lives in its own src/worker/jobs.ts because
                          app.ts needs the kinds as VALUES and may not pull `cloudflare:workers`
                          into its module graph, which importing them from replayindex.ts would.
                          A resim row stores stream_key = '' (the column stays NOT NULL; SQLite
                          cannot drop that without a table rebuild, and the daemon branches on
                          the kind anyway). GET /api/jobs serves ONE kind and DEFAULTS TO
                          "upload" — load-bearing, since a deployed bringest asks without the
                          param and cannot run a re-sim. POST /api/jobs/<id> gained an opt-in
                          {claim:true}: it transitions only from pending or a stale processing
                          (jobClaim), so two daemons in one poll round cannot both take an hour
                          of work, while a plain "processing" stays unconditional because that
                          is the healthcheck AND because the upload daemon treats a failed
                          transition as a job error — it would take the job from whoever
                          legitimately holds it and mark it failed. A resim's stale window is
                          90 min rather than 15 (STALE_PROCESSING_RESIM_SEC), the backstop for a
                          daemon too old to beat.
                          JOB STATS: jobs.stats is ONE nullable JSON column (JobStats in jobs.ts,
                          cmd/bringest's jobStats struct the other half of the contract), not a
                          column per number — nothing queries these, the queue page just reads
                          them, and the two kinds barely overlap (an upload records what packing
                          and uploading cost, a re-sim adds an hour of engine time and its
                          infolog summary). Reported with the TERMINAL state, on FAILURE as well
                          as success — forty minutes that ended badly is the record most worth
                          having — and COALESCEd by jobUpdate so a heartbeat, which carries none,
                          cannot erase it. Every field is optional: an older daemon simply sends
                          less, and a failed job sends only what it got as far as measuring.
                          parseJobStats shape-checks only that it is a plain object under
                          MAX_JOB_STATS_BYTES (32 KB, nearly all of it the size report); anything
                          else is DROPPED rather than 400ing, since the stats describe work that
                          already happened and refusing them would lose the state transition too.
                          JOB PROGRESS: jobs.progress is the OTHER nullable JSON column
                          (JobProgress in jobs.ts, cmd/bringest's jobProgress struct the other
                          half), and is the stats' mirror image in every way that decides how it
                          is handled. Stats say what the work COST, are written once at the end
                          and kept forever; progress says what the work IS DOING, is overwritten
                          by every 10-second healthcheck, and is CLEARED by jobUpdate the moment
                          a job reaches a terminal state — a finished row still reading
                          "simulating, 43%, 12 minutes left" would be worse than one reading
                          nothing (`progress = CASE WHEN ? = 'processing' THEN COALESCE(?,
                          progress) ELSE NULL END`, so a beat that carries none keeps the last
                          reading and an older daemon simply reports less). jobClaim clears it
                          too: taking over a stale job must not inherit the dead daemon's last
                          percentage. Fields: state (the phase in words — the only one that
                          means anything in every phase), frame/totalFrames/percent/etaSec/
                          simFps, and the engine process's rssBytes/cpuPct (percent of ONE core,
                          so a threaded engine exceeds 100). parseJobProgress shape-checks it
                          exactly as parseJobStats does, under MAX_JOB_PROGRESS_BYTES (2 KB —
                          it is a dozen small numbers), and drops rather than 400s for the same
                          reason. It rides the OPEN reads (/api/jobs/<id>, /api/queue) like the
                          stats do.
                          JOB SAMPLES (job_samples table + GET /api/jobs/<id>/samples): every
                          healthcheck is ALSO kept as its own row, which is what the queue page's
                          charts are drawn from. progress is the newest reading and is cleared
                          when the job ends; this is the SERIES, and it deliberately OUTLIVES the
                          job — the memory curve of a run that died at minute forty is exactly
                          the reading nobody has otherwise, because the live one is gone by then.
                          Written by jobUpdate at the same `now` the row's updated_unix gets, so
                          a point and its row agree, and stamped with the WORKER's clock so a
                          daemon with a skewed one cannot bend the time axis. Keyed (job_id,
                          at_unix) with an upsert, so a beat retried inside one second is the
                          same reading rather than a second point. Every field is COERCED on the
                          way in (`finite`): unlike everything previously done with a
                          JobProgress these land in typed SQL columns, and parseJobProgress is
                          shallow because its fields were only ever displayed — `{frame:{}}`
                          would otherwise throw inside the bind and 500 the healthcheck. Past
                          MAX_JOB_SAMPLES = 720 (two hours of beats) jobSampleThin HALVES the
                          series in place, keeping its first and last sample and every other one
                          between: the chart keeps its full span at half resolution, where
                          dropping the oldest would lose the load phase and refusing to record
                          would lose the end — the part that says how it died. Retention is the
                          cron's job (index.ts, its own try so it cannot take the mirror down):
                          jobSamplePrune drops the samples of jobs finished more than
                          JOB_SAMPLE_RETENTION_SEC = 30 days ago and of any job row that is gone,
                          which is the only rule stopping the one table here that grows on its
                          own. The route is OPEN like the rest of the queue reads and is fetched
                          PER EXPANDED ROW, not with the queue page — 25 rows would otherwise
                          carry thousands of points nobody looked at; an unknown job answers with
                          an empty series rather than a 404, since a job that never beat and one
                          that does not exist are the same thing to the view.
                          GAMES MIRROR (games table + src/worker/games.ts + the cron in
                          index.ts): every minute a scheduled handler (which also prunes job_samples —
                          see JOB SAMPLES above) reads ONE page of
                          api.bar-rts.com's replay listing —
                          /replays?page=1&limit=24&hasBots=false&endedNormally=true, the query
                          verbatim in GAMES_QUERY — and records the games this worker has not
                          seen. It is the OTHER half of the picture: `replays` is what somebody
                          captured, `games` is what was PLAYED, keyed by the same gameId, so the
                          two are views of one game and a row in `games` with none in `replays`
                          is a re-sim candidate nobody has to paste a link for. Nothing serves it
                          yet — there is no route and no UI, by request.
                          The columns deliberately echo the catalog's vocabulary (start_unix,
                          duration_sec, map, game_size, player_count, players, settings) plus
                          what only the API knows: map_file (what BAR's maps API keys on),
                          preset (duel/team/ffa, stored verbatim so a value the API adds later
                          survives), and engine_version/game_version — the two builds a re-sim
                          must run and nothing else.
                          One page, never a second: at a run a minute, page 1 covers far more
                          than a minute of BAR's game rate, so a gap closes itself and no run
                          walks history (a real backfill would be a different job). The LISTING
                          carries no modoptions, so each genuinely NEW id costs one
                          /replays/<id> detail fetch — 4 at a time, once per game, never again —
                          which is where settings and the roster come from, through the same
                          settingsFlags/playersFromApi the admin refresh route uses, so a
                          mirrored game and a refreshed catalog row read identically. Known ids
                          cost nothing: a steady-state tick is ONE request (gamesUnknown filters
                          the page first). A detail that fails is simply not recorded, so the
                          next tick retries it; a failing LISTING throws (that is the run), and
                          the handler logs rather than rethrows, since a minute-by-minute stream
                          of failed crons is worse signal than one self-healing blip. Nothing is
                          logged on a tick that changed nothing.
                          Mirrored games index into the SAME replay_players/replay_settings
                          tables as the catalog, which makes ownership the one rule to keep:
                          exactly one row owns an id's derived entries — the catalog row if there
                          is one (its roster is the capture that was published), the games row
                          otherwise — enforced by gamesInsert skipping an id `replays` holds, and
                          honoured by rebuildDerived. The consequence for the filter bar is that
                          /api/replays/facets now restricts both derived reads to ids present in
                          `replays`: the mirror is thousands of games nothing has published, and
                          a filter option matching no listable replay is exactly what that
                          endpoint exists to avoid.
                          index.ts therefore exports `{ fetch, scheduled }` rather than the Hono
                          app itself — a cron handler cannot live in app.ts, which stays free of
                          workerd imports so the node tests can drive it. games.ts keeps that
                          same freedom (it takes the index and `fetch` as arguments), so
                          tests/games.test.ts drives the whole sync against a fake API. The SQL
                          half — the table, gamesUnknown's dedupe, the ownership rule, the
                          facets restriction — is tests/do/replayindex.test.ts, running INSIDE
                          workerd under @cloudflare/vitest-pool-workers (vitest.config.ts,
                          bindings read from wrangler.jsonc, so the test worker cannot diverge
                          from the deployed one; `npm test` runs both suites). That version of
                          the pool has NO per-test storage isolation to configure — vitest-3's
                          isolatedStorage is not among its options — so each test addresses its
                          own DO instance rather than the production idFromName("index").
                          End-to-end was checked once by hand:
                          curl /cdn-cgi/handler/scheduled against `vite dev` mirrored 24 real
                          games, and the second call added none.
                          WIDGET-INSTALL GUIDE: the dropzone banner links (relatively, so it
                          resolves on both backends) to /setup — public/setup.html, four numbered
                          steps ending in a drag&drop upload. The page is deliberately
                          SELF-CONTAINED (inline CSS, no /style.<rev>.css): only index.html goes
                          through the __ASSET_REV__ substitution, so a second page referencing the
                          fingerprinted subresources would have to be taught to every substituter.
                          Its step 1 serves assets/lua/replay_uploader.lua, copied into public/ by
                          tools/sync-assets.mjs exactly like the vendored icons (gitignored — ONE
                          copy of the widget in the repo, so the download cannot drift from the
                          decoder) and, like them, EXCLUDED from run_worker_first: routed through
                          the worker its public/_headers no-cache rule would be silently dead, and
                          it is the one asset whose bytes change under a stable URL (its URL is
                          printed in a guide, so it cannot be fingerprinted). The /setup route in
                          app.ts exists only to serve the page no-cache; it hands the request to
                          ASSETS UNCHANGED, because the asset layer resolves the extensionless
                          path itself and its default HTML handling (auto-trailing-slash) answers
                          a /setup.html URL with a 307 to /setup — so rewriting the path fed that
                          bounce back into the same route and shipped /setup as an INFINITE
                          REDIRECT LOOP. The Go viz server serves the same page
                          and the same widget from its embedded copies (worker/assets.go embeds
                          public/setup.html; assets.ReplayUploaderLua is the widget).
                          DEPLOYING: `npm run deploy` is the whole thing — test -> build (whose
                          prebuild syncs the icons AND the widget into the gitignored public/
                          copies) -> smoke -> wrangler deploy, spelled out in package.json rather
                          than hidden in npm hooks. The smoke step (tools/smoke.mjs) boots the
                          BUILT worker under `vite preview` — workerd plus the REAL asset layer —
                          and checks what it actually serves. It is not redundant with
                          worker/tests: those drive the Hono routes with a fake ASSETS binding
                          that answers whatever path it is handed, and `vite dev` serves public/
                          through plain static middleware, so NEITHER can see the three asset-layer
                          behaviours that have each already shipped a broken page — the .html
                          redirect above, single-page-application answering an unmatched path with
                          index.html (/favicon.ico once served the whole HTML document), and
                          public/_headers applying only to asset-layer responses. Every request in
                          the smoke uses redirect:"manual", since the loop was a chain of 307s that
                          curl -L and a browser both reported as something else. It also
                          refuses to ship an UNSTAMPED widget (sync-assets leaves the SHA token
                          in place when the widget has uncommitted changes): every capture
                          recorded with that copy would carry no provenance, and nothing
                          downstream can recover it afterwards. typecheck is
                          deliberately NOT in the chain: it reports pre-existing noUnusedLocals
                          errors in tests/, so wiring it in would block every deploy.
                          QUEUE SECTION (app.js renderQueue): the landing page's second menu entry
                          shows those jobs — one row per job with its game, KIND, state, what the
                          work TOOK, age and failure detail, a link to the replay once the
                          catalog has it (and out
                          to bar-rts.com until then, which for a queued re-sim is the whole point
                          of the row), and a count of the jobs in flight on the menu entry
                          itself. Above the table sits the re-sim paste box (app.js initResim/
                          submitResim, #resimbox), the intake described under the worker routes
                          above; the two doors of the pipeline therefore bracket the section, the
                          dropzone above it and this inside it. The Took cell carries the one
                          number worth a column — the engine's own wall time for a re-sim, the
                          whole job's otherwise — and CLICKING THE ROW expands the rest of the
                          daemon's record (statsRow/statsLines): the load/sim split, frames
                          against the demo's length, speed-up, the engine-log summary, and the
                          .brp size breakdown verbatim in a scrolling <pre>. The row is the
                          toggle rather than a control of its own, minus clicks on a link, which
                          is there to be followed; which rows are open is plain component state
                          (queueOpen), NOT in the URL — unlike ?tab= and the filters, "the third
                          job's timings were expanded" is not a thing to share or restore.
                          A RUNNING job has no stats — those are written when the work ends — so
                          both of those cells answer from the live `progress` instead
                          (progressLines/progressText/fillProgressCell). Took shows how much
                          LONGER ("~14m 00s left"), since a job that has not finished has no
                          cost to report but does raise exactly that question; the Detail cell —
                          the same one a finished job puts its failure in, which cannot collide
                          because the worker clears progress at the moment an error appears —
                          gets a thin bar plus the words ("simulating · 43% · 14m 00s left ·
                          3.2 GB · 613% CPU"), and the expansion adds the frame counts, the sim
                          rate and the engine's memory and CPU. The BAR is drawn only once there
                          is a percentage, i.e. once the engine is simulating: the minutes before
                          that (demo download, provisioning, the engine's own load) have nothing
                          to measure, and a bar pinned at zero through them reads as a job that
                          is stuck rather than one that is working. The Updated cell doubles as
                          the liveness signal — the daemon beats every 10s, so an age of minutes
                          on a "processing" row means nobody is home.
                          CHARTS (app.js jobCharts/buildChart, styles .jobcharts/.chart*): the
                          expansion also draws the job's whole healthcheck history, fetched then
                          and only then (loadJobSamples, cached per job and dropped by an
                          explicit re-read so a fresh page never sits beside a stale curve).
                          THREE SEPARATE PLOTS — engine memory, engine CPU, simulation — never
                          one with three scales: bytes, percent-of-a-core and percent-of-a-game
                          share no axis, and overlaying them would invent a correlation that is
                          not in the data. They share an X (the same beats), which is what lets
                          ONE crosshair read all three at a moment, with one tooltip listing
                          every measure plus the phase (what explains a flat stretch); the same
                          readings come from keyboard focus + arrows, so no value is behind a
                          pointer. ONE hue for all three (#4b90c4, the same blue the collapsed
                          row's bar is filled with, validated against the #12181e surface): each
                          chart has a single series, so colour carries no information and the
                          title is what says what is plotted — and a single series needs no
                          legend. Marks are 2px lines over a 10% wash with hairline SOLID grid
                          one step off the surface. The line BREAKS over a gap rather than
                          drawing through zero (an engine that had not started is missing, not
                          idle), and a measure the run never reported gets no plot at all, since
                          an empty axis would claim a reading of zero. Exactly one direct mark
                          per chart, chosen to say what the axis cannot: an autoscaled chart's
                          top tick IS its peak, so the peak gets a bare dot (WHEN it happened);
                          the fixed-domain one (simulation, 0-100 because the whole is known —
                          autoscaling would draw a stalled run exactly like a finished one)
                          labels its END value instead. Both formatters exist for a reason —
                          `tick` must fit a 46px gutter, `fmt` has a tooltip line to explain
                          itself, and using one for both put "650% of one core" through the left
                          edge of the figure. X labels are ELAPSED time, not clock time: "it
                          spiked at minute 32" is the reading.
                          It reads GET
                          /api/queue (ReplayIndex.queuePage: unfinished jobs first, then the most
                          recently finished; ?offset=/?limit=, limit capped at QUEUE_LIMIT_MAX),
                          QUEUE_PAGE = 25 rows at a time with a Prev/Next pager. It NEVER refreshes
                          itself: every read is an explicit act — opening the landing page, paging,
                          the Reload button, or this browser's own upload landing/failing — so the
                          pager states the CLOCK time of the read (a relative "12s ago" would
                          freeze there and become false with nothing re-rendering it; the rows'
                          ages are as-of that read, with the exact moment in each cell's tooltip).
                          The reply's `total`/`active` are counted over the WHOLE jobs table, not
                          the page, so the pager and the menu's in-flight count stay true on any
                          page — one window of rows cannot say how many jobs are queued. The page
                          number is deliberately NOT in the URL (unlike ?tab= and the filters):
                          "page 3 of the queue" describes a moment in a pipeline, not a set of
                          replays, so there is nothing to share or restore. The route is OPEN, like
                          the per-job status the uploading browser already polls, but it omits
                          the row's streamKey — the archive bytes are behind the bearer-guarded
                          /api/streams route and the view has no use for the key (GET
                          /api/jobs/<id>, the poll, answers with the same subset for the same
                          reason). It is distinct
                          from the daemon's GET /api/jobs, which is a WORK QUEUE (guarded, ONE
                          kind at a time, and it deliberately hides a healthy "processing" job —
                          precisely the row a person watching wants to see), and which also
                          MAKES work: a "resim" poll with nothing pending queues a mirrored
                          game nothing has published and returns that (ReplayIndex.jobsOffer).
                          WHICH game: of the BACKFILL_WINDOW=20 newest eligible ones, the one
                          with the MOST PLAYERS — an hour of engine time buys an 8v8 as cheaply
                          as the duel that happened to finish a minute later, so within a window
                          of games that are all recent, size decides (ties go to the newer, an
                          unknown roster goes last but is not refused). The window is over
                          CANDIDATES, not over the mirror's last 20 rows: every game handed out
                          gains a job row and stops being eligible, so a window over raw recency
                          would be permanently empty after twenty of them and the daemon would
                          idle with thousands of games left. The rules are all about not repeating
                          work: only for kind=resim (an upload job is bytes somebody sent, and
                          there is no stream to invent); only a game with no catalog row and NO
                          JOB ROW AT ALL — finished and FAILED ones included, or a game that
                          cannot re-simulate would be handed out again every poll, an hour of
                          engine time at a time (pasting its link is still a retry, exactly as
                          for a failed request); only an UNMODDED game — no tweakdefs/tweakunits
                          slot, which is precisely what the settings' `mods` flag records, so
                          the refusal is an EXISTS over replay_settings' (flag, replay_id) index
                          and the flag name is a shared constant (SETTINGS_MODS_FLAG) rather
                          than a literal the query could silently stop matching; note this also
                          rules out the modes that SHIP as tweak blobs, lava and zombies, which
                          is the same statement twice rather than an oversight, and a game with
                          NO settings recorded (the API gave none) stays eligible, since
                          treating unknown as modded would empty the work list on a bad API
                          day; and only into an EMPTY pending list, so at most
                          one auto-queued job ever waits — the next poll finds THAT one instead
                          of making another. Check and insert are one RPC, so two daemons
                          polling together cannot both take the same game. It makes a GET write,
                          which is the price of leaving the daemon's protocol untouched: a
                          backfilled job is indistinguishable from one a person queued a minute
                          earlier, so no deployed daemon needs to know this happens. The job id
                          comes from the ROUTE (crypto.randomUUID, like the other two job
                          creators), which is also what keeps the DO deterministic under test. The Go viz server
                          has no ingest pipeline
                          and 404s the route; the section then says so rather than showing an
                          empty table that would read as "nothing is queued", and asks it nothing
                          further.
                          Uploads (tools/upload.ts) go
                          through tools/r2put.ts: parallel S3 PUTs when R2_ACCESS_KEY_ID/
                          R2_SECRET_ACCESS_KEY are set (fast, aws4fetch), else parallel `wrangler r2
                          object put`; .brw heads upload after a completion barrier so a
                          half-uploaded replay never lists
snapshot/                 PUBLIC data model + pluggable Writer (owns the on-disk format: the .brp binary).
                          The Writer's four record types are Meta, Frame, Event and Comm
                          (snapshot.Comm = one thing a player wrote or drew).
assets/lua/snapshot_widget.lua   embedded, read-only sampler (go:embed)
assets/lua/replay_uploader.lua   player-installable live-game variant: constants only, with
                          ONE substitution token (__WIDGET_SHA__, stamped by
                          worker/tools/sync-assets.mjs when the widget is published for
                          download — see the widget-provenance note under worker/ below;
                          an unstamped copy reports no SHA rather than the token, guarded by
                          a hex/length test rather than a comparison against the token, which
                          the substituter would itself replace). It records the player's own ally team plus, by
                          default (recordEnemies const), enemy units while the engine lists
                          them in GetAllUnits (LOS, radar, or the engine's radar-memory dot;
                          unidentified radar contacts carry def 0, identity/health carried
                          from the last LOS reading) — plus each unit's build/assist target
                          (GetUnitIsBuilding, the frame record's target column, flags bit 1).
                          An enemy the engine stops listing DISAPPEARS from the stream that
                          sample (dead-listed in the delta codec, no destroyed event — not a
                          death, it may be alive in fog; re-listed later = recorded afresh
                          under the same id). Widgets 1.1–1.4 instead froze such units as
                          "ghosts" (with an IsPosInLos scout-check to drop them);
                          that persistence was removed in 1.5.0 — old streams still decode
                          unchanged. Witnessed deaths are tombstoned: the
                          engine keeps returning a dead enemy's id, both as a frozen
                          radar-memory dot and — until its death sequence finishes — as the
                          killed unit itself, and neither may resurrect it; a health read of
                          0 or Spring.GetUnitIsDead is a death even with no UnitDestroyed
                          callin.
                          internal/capture repairs pre-1.2.0 captures at decode time
                          (capture.graveyard) —
                          to <write-dir>/<gameId>.brepstream — a binary
                          keyframe+delta stream (spec: docs/brepstream-format.md, decoder:
                          internal/capture/brep.go, ~6.5x smaller and ~4x cheaper per sample
                          than the text stream) — named via the "GameID" GameRulesParam
                          (BAR's game_id.lua gadget; barwidgets.lua does NOT forward the
                          engine's GameID callin to widgets); the
                          writeText constant additionally emits the legacy .brsnap text
                          stream (debug/reference; both formats from ONE game validate the
                          binary encoder without re-simulating). Since 1.6.0 it also
                          records what players WRITE and DRAW (COMM/'C' records — see the
                          chat/drawings note under the wire protocol below). NOT
                          embedded/injected by
                          the Go tool (crowd-sourced capture plan: docs/widget-remote-upload.md)
tools/brep-harness/       stubbed-Spring Lua harness: runs the REAL uploader widget over a
                          deterministic fake game to (re)generate the
                          internal/capture/testdata fixtures that pin the Lua encoder <-> Go
                          decoder lockstep (TestBrepstreamMatchesTextFixture); needs lua5.4.
                          Its commScript drives AddConsoleLine/MapDrawCmd over every chat
                          shape and draw type — INCLUDING the console lines that must NOT be
                          recorded (engine noise, the widget's own heartbeat echo, an unknown
                          speaker, the "added point" line duplicating a MapDrawCmd), so a
                          parser that got greedier shows up as extra comms in the fixture test
```

Key design rule: **the on-disk format lives only in `snapshot/`** behind the `Writer`
interface. To change it implement `snapshot.Writer`; nothing in `capture`/`engine`
changes. `capture.Consume(r, baseMeta, w)` is the seam between the engine's text
output and the writer.

### On-disk format v5: `.brp` (snapshot/brp.go)

Full byte-level spec: `docs/brp-format.md` — keep it in sync with any codec change
(`docs/brp-optimizations.md` records the measured evaluation behind the format's
design decisions). The only output format — the retired v1 JSONL measured a real
33-min 8v8 game at **476 MB where the .brp is ~8 MB (~62x)**. Quantized once:
whole elmos/hp, velocity as per-sample-interval
displacement, build progress 1/255, resources 0.1; `t` is derived as `frame/30`,
not stored; **y/dvy are not stored at all** — the viewer renders the x/z plane and
ground-unit elevation is terrain noise, so decoded `Pos.Y`/`VelY` are 0). Container:
`"BRP1" <ver u8 = 5>` then tagged sections `<tag u8><len u32le><payload>` — `M` meta
JSON (Meta + precomputed bounds/frameTeams/counts + the **chunk index**), `K` **all
core keyframes as ONE gzip stream**, `F` core delta-frame chunks (columns: id def
team x z hp maxHp dvx dvz build target — build + the build/assist target moved into
the core in v5 so the browser can draw construction bars and builder→target lines),
`X` extra (team resources — not sent to the browser), `E` events, `C` **comms**
(everything the players wrote or drew: chat + map points/lines/erases, columnar
like `E` with two string tables and whole-elmo positions delta-coded against the
previous comm — freehand drawing is a run of short segments, so those deltas are
1-2 bytes; OMITTED entirely when a capture has none, which is every .brp packed
from a pre-1.6.0 widget stream, so readers must treat a missing `C` as "none").
Unknown tags are
skipped, so sections can be added compatibly; any version byte other than 5 is
rejected in Go (v1–v3 existed only pre-release, v4 shipped without build/target in
core; regenerate a .brp from its .brsnap/.brepstream with pack). The JS decoder
keys its column count off the .brw container's version byte and still plays
published v4 bundles (their units decode as build=finished/target=none).

**Chunking (random access / streaming).** Frames are grouped into **chunks of 64
samples** (~1 min at 1 Hz), and the codec's prediction state resets at every chunk
boundary, so each chunk's first frame encodes fully absolute — a keyframe (the
video-codec model). **Keyframes live OUTSIDE the chunks (v4): concatenated, in
chunk order, into the single-gzip `K` section.** A viewer downloads `K` first (one
request, ~0.5 MB for a 33-min game) and decodes it progressively while it streams —
the whole timeline becomes scrubbable within seconds, before any chunk arrives —
then fetches chunks, which now hold **only delta frames** (one gzip stream each; a
single-frame chunk has none), so no byte is ever downloaded twice. Decoding a chunk
requires seeding the codec with its keyframe first (`BRPFile.DecodeChunk` does).
Merging the near-identical adjacent keyframes into one stream also compresses ~12%
better than v3's per-chunk keyframe streams. The `M` record's `chunks` array
indexes everything: first sim frame, sample count, the keyframe's RAW byte range in
the decompressed `K` (`kOff`/`kLen` — the boundaries the streaming consumer slices
at), and the delta byte ranges relative to the section payloads (`Section.Offset`
from `ReadContainer` gives absolute file positions, enabling HTTP-Range static
hosting). X keeps a keyframe+delta gzip pair per chunk but is never fetched by the
viewer.

Why it's small: a delta frame stores only an explicit **dead-id list** and a
**changed-unit list** (new units + units where any column differs from its
prediction); every other live unit costs zero bytes — the decoder re-materializes
it by advancing `x += dvx, z += dvz` (~66% of all unit records skip this way).
Changed units' columns are zigzag-varint **deltas against the same unit in the
previous sampled frame** (absolute when the id is new); x/z predict with the
previous frame's velocity displacement (`dv = round(vel*sampleEvery)` — exactly the
interpolation tangent the viewer uses), so constant-velocity movement is "no
change" and skips too. Chunks gzip at DefaultCompression (BestCompression measured
>10x slower for <2% size).

The K section and each chunk are **independently** gzipped so any server can hand
them to the browser byte-for-byte. Three codec implementations must stay in
lockstep: the encoder + Go decoder in `snapshot/brp.go` and the JS decoder in
`worker/public/app.js` (`decodeFrames`/`decodeEvents`). The writer is deterministic
(same capture → byte-identical file), which the "diff two runs to verify an
optimization" workflow relies on. `snapshot.ReadBRP` fully decodes;
`snapshot.ParseBRP` decodes only meta + index and hands back the raw sections;
`BRPFile.Keyframes()` gunzips K once (cached); `BRPFile.DecodeChunk(i)` decodes one
chunk (its K slice + its delta bytes). A roundtrip loses unit order within a frame
(sorted by id), sub-quantization precision, and y/dvy (decoded as 0) — nothing
else.

### Data flow

`barapi.Resolve/Download` → `demofile.Parse` (versions/map/gameId, **and the chat +
drawings out of the packet stream**) → `engine.Locate` → `engine.EnsureContent`
(pr-downloader) → `engine.WriteWidget` (substitutes the output-file path) →
`engine.EnableWidget` (seed widget config) → `engine.BuildStartscript` →
`engine.Run` (widget writes `<out>/<gameId>.brsnap` directly) → `capture.Consume`
reads that file → `capture.ReplaceComms` (the demo's comms win over the widget's) →
`snapshot.NewBRPWriter`.

Note the widget writes its BRSNAP stream to its **own file** (path substituted from
`Config.SnapshotStreamPath`), not to stdout: the tool drains the engine's stdout (watching
only for the widget's first `[barreplay]` line, which marks the load/sim boundary) and
parses the file after the engine exits. `-progress` still works off `infolog.txt` (the
widget's heartbeat lines keep `[f=]` markers flowing there).

### Widget wire protocol (BRSNAP)

The Lua widget writes tagged lines to its output file; `internal/capture` parses that
file after the run. Evolve the widget and `capture` together.

**Why a file, not `Spring.Echo`:** the engine flushes its log on every Echo *and* caps
each Echo at a few hundred units (a real replay hit 617), so streaming snapshots through
stdout was slow and silently truncated. `System` exposes `io` to widgets (BAR's own
`savetable.lua` uses `io.open`), so the widget opens the substituted `__OUTPUT_PATH__`
and writes each whole sampled frame (`F` line + all `U` lines) with one `out:write`,
flushing every sample and closing in `GameOver`/`Shutdown`. No size cap, one write per
frame. Only the small `[barreplay]` heartbeat lines still go through `Spring.Echo` (for
`infolog.txt` / `-progress`). `capture` still cross-checks each frame's `U` count against
the `F` line's declared `<count>` and warns on a mismatch.

**Path sandbox (non-obvious):** Spring's `LuaIO::fopen` runs `IsSafePath`, which rejects
**absolute paths** and any `..`, so the widget can only write a *relative* path resolved
against the engine's working directory. `engine.Run` sets `cmd.Dir` to the write-dir and
passes the widget a relative `barreplay/<gameId>.brsnap` (`Config.SnapshotStreamPath`);
the tool reads it from `<data>/barreplay/<gameId>.brsnap` after the run and moves it to
`<out>/<gameId>.brsnap`. An absolute path makes `io.open` return nil → no file at all.

Because that `cmd.Dir` is the data dir, **`engine.Locate` absolutizes `Config.DataDir` and
every binary path it resolves** (`filepath.Abs`) — otherwise a relative `-data .bardata`
gets re-resolved against *itself* by the child: exec looked for
`.bardata/.bardata/engine/<ver>/spring-headless` and failed with a "no such file or
directory" naming a binary that plainly exists (the lookup had checked it against the
parent's cwd), and `--write-dir` doubled the same way. Regression test:
`TestLocateAbsolutizesRelativeDataDir`.

```
BRSNAP DEF <json>                              full unit-def as JSON (preamble)
BRSNAP D <defID> <name>                        unit-def id -> internal name (legacy preamble)
BRSNAP T <teamID> <allyTeam> <side> <color>    team info (preamble; side "_" = none, color "#rrggbb")
BRSNAP P <playerID> <team> <spectator> <name...>   player info (preamble; name last, may have spaces)
BRSNAP READY                                   end of preamble
BRSNAP F <frame> <timeSec> <count>             start of a periodic snapshot
BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp> <vx> <vy> <vz> <build> <target>   one unit (follows an F line)
BRSNAP R <teamID> <metal> <energy> <mStore> <eStore> <mIncome> <eIncome>   team economy (follows an F line)
BRSNAP EV <frame> <kind> <id> <def> <team>     unit lifecycle event
BRSNAP COMM <json>                             one player comm: chat message or map drawing
BRSNAP PROF <totalMs> <name>                   engine time-profiler record (once, at game over)
BRSNAP PROFD <frame> <units> <totalMs> <name>  per-heartbeat profiler sample (-profile only)
```

The **unit defs are dumped in full** (`DEF` JSON: name, humanName, costs, buildTime,
maxHealth, speed, footprint `xsize`/`zsize`, `iconType`, builder/factory/fly flags,
weaponCount), not just id→name — mods add
and modify unit types, and the id space depends on the exact game build the replay pins.
The legacy `D` line (id→name) is still parsed for old `.brsnap` files. **Players** are
seeded from the **demo startscript** (`demofile.BaseMeta`, used by both `cmd/barreplay`
and `pack`'s demo fetch), the authoritative
source for per-player metadata the live engine list lacks: country flag (`countrycode`),
ladder rank, OpenSkill rating ("OS", the bracketed `skill`) + uncertainty, `accountid`, and
`boss`. The widget's `P` line (name/team/spectator) is a fallback for a raw `.brsnap` with no
startscript behind it — `capture` merges it by player id so a seeded player is never
duplicated. **Team colours** ride the `T` line; `capture` backfills each `TeamInfo.PlayerName`
from the first non-spectator player on that team.
Each sampled frame also emits one `R` line per team with its current metal/energy, storage
caps, and per-game-second income — `GetTeamResources`' income return is ALREADY per
game-second (the engine accumulates it over `TEAM_SLOWUPDATE_RATE` = 30 sim frames), so
protocol >= 3 widgets write it as-is. Widgets before that wrongly multiplied it by 30;
`capture` repairs those streams at decode time (`repairIncome` in lines.go: any stream
without a `GAME` line declaring `protocol >= 3` gets its income divided by gameSpeed).
Each `U` line carries, besides position and health, the unit's velocity (`vx/vy/vz`) and
`buildProgress` (1 = finished, <1 = under construction; from `GetUnitHealth`'s 5th return).
Both are appended after `maxHp`, so pre-velocity `.brsnap` streams still parse (capture reads
them only when the line has all 12 fields).

**Chat and map drawings (`COMM` / `C` records; both widgets, uploader >= 1.6.0).**
THE WIDGET PATH IS THE FALLBACK — whenever a demo is available its comms replace
these wholesale (`capture.ReplaceComms`, wired into cmd/barreplay, internal/resim
and internal/packer), because the demo has every channel and exact frames. The
widget capture is what a `pack -no-demo` or a game the BAR API does not know still
gets, and it is the only source for a live game not yet published. The replacement
is skipped when the demo yielded NO comms, since that is indistinguishable from a
truncated packet stream.
Recorded at the exact frame they happen, as one JSON payload per message or drawing
command (`chat`/`point`/`line`/`erase`; see docs/brepstream-format.md). Drawings come
from the `MapDrawCmd` callin, which is structured — author playerID + world
coordinates — and must return NOTHING: a truthy return TAKES the event, so the engine
would never draw the mark. Chat has no such callin: BAR's widget handler does not
forward `GotChatMsg` (`luaui/actions.lua` consumes it for chat actions), so the only
source is `AddConsoleLine` and the widget reverses the console grammar
`CGame::HandleChatMsg` prints — `<Name> body` (player), `[Name] body` /
`[Name (replay)] body` (spectator), `> <Name> body` (autohost relaying the
battleroom), with the channel as a body prefix (`Allies: `, `Spectators: `,
`Private: `, ` whispered <who>: `). A bracketed line counts as chat only when the name
is a player of THIS game (the same disambiguation BAR's own gui_chat applies) — which
is what keeps engine noise, and the widgets' own `[barreplay]`/`[replay-uploader]`
heartbeat echoes, out of the record. `<Name> added point:` console lines are dropped on
purpose: `MapDrawCmd` already delivered that marker, with coordinates. Both callins are
pcall-guarded and their failures are swallowed SILENTLY — an Echo inside
`AddConsoleLine` comes straight back through the same callin.
Comms captured this way are POINT-OF-VIEW-LIMITED exactly like unit visibility (the
engine fires the draw callin only for marks a client may see and delivers only the
chat channels it receives), and their FRAME STAMPS ARE APPROXIMATE: the engine does
not hand chat to Lua when it arrives, it flushes the console from
`CGame::UpdateUnsynced` — the draw-side chain `-throttle-draw` deliberately starves.
Measured on a real re-sim infolog, the widget's own `draws=` heartbeat counter IS
that flush rate: a median of 375 flushes per 300 sim frames (sub-frame accuracy) but
1-6 over the first ~2 minutes of game time, i.e. a stamp up to ~10 game-seconds late
exactly when people say "glhf". Nothing in the Lua console API carries a frame or a
timestamp (checked `Spring.GetConsoleBuffer` and the engine's `RawLine`), so this is
a floor for the widget path, not an oversight — and it is the reason the demo is
preferred wherever one exists. Volume is capped at 20000 records per capture
(`maxComms`) because the viewer downloads the whole set before playback.

The widget never touches synced state (only `Get*` reads, unsynced console commands, its
own output file, and unsynced widget-handler calls) so it cannot desync the replay. `__SAMPLE_EVERY__` is substituted at write time (`-every`, default 30 = 1 Hz).
It also echoes plain `[barreplay] ...` heartbeat lines (on load + every 300 frames ≈ 10s of
game time) for infolog visibility; when the heartbeat frame was also sampled it appends
`sample_time=<n>us` (the per-sample processing cost, timed via `Spring.GetTimer`/`DiffTimers`;
falls back to `<n>ms` via `os.clock` if the hi-res timer is absent). `capture` ignores any line without the `BRSNAP` tag. The
widget forces max playback speed via `setminspeed`/`setmaxspeed` in `Initialize` (re-asserted
each heartbeat) — without a loaded widget the replay runs realtime.

### Making BAR actually load the widget (non-obvious)

Dropping a widget into `<data>/LuaUI/Widgets/` with `enabled = true` is **not** enough. BAR's
widget handler (`luaui/barwidgets.lua`) auto-runs a *new user* widget only when
`self.allowUserWidgets and not allowuserwidgets` — but a **replay forces `allowuserwidgets = true`**,
so that clause is false and the widget is scanned yet left disabled. A user widget runs only if
its name is already in the saved order list `<data>/LuaUI/Config/<gameShortName>.lua` (BAR is
`BYAR`). So `engine.EnableWidget` (`internal/engine/widgetconfig.go`) seeds a minimal config
`return { order = { ["BAR Replay Snapshotter"] = 1 }, ... }`, backing up and restoring the user's
real config around the run (with self-heal if a prior run was interrupted). The widget name in
the seeded config must exactly match `GetInfo().name` in the Lua asset (a test guards this).

A **gadget** would be worse here: `luarules/gadgets.lua` only scans the write-dir when
`Spring.IsDevLuaEnabled()` (else `VFS.ZIP_ONLY`, game-archive only), so a dropped-in gadget
won't load without an extra dev flag. Widgets are the right injection point.

## Visualization tool (`cmd/barreplay-viz` + `internal/viz`)

A **separate, read-only** tool that serves a browser playback of a finished capture; it
never touches the engine. `barreplay-viz -snapshots <dir> [-addr host:port]` scans the
dir for `.brp` files and serves the viewer. **The viz tool reads the current .brp
version only** — convert a raw `.brsnap`/`.brepstream` once with `pack` (the
converter owns the legacy parsing; viz has none). The viz server and the `worker/`
static deployment share ONE URL scheme (`/index.json`, `/api/replays`,
`/replays/<id>.brw`, `.keys`, `.resources`, `/replays/<id>/c<n>`), so the single
front-end in `worker/public` works against both unchanged. `/api/replays` is the
replay catalog (stats for the landing list — see the worker/ entry above): the
worker serves it from its Durable Object table, the Go server computes the identical
shape from each file's meta (`internal/viz/catalog.go`, mtime-cached per file).

- **`internal/viz/wire.go` + `server.go`** implement the serving side:
  `/replays/<id>.brw` returns a small binary **"BRW1" container** (same section framing
  as `.brp`) of a gzipped `J` head JSON (meta, teams, unitDef names — BOTH the internal
  one (`unitDefs`, the icon/footprint lookup key) and the human-readable one
  (`unitNames`, "Construction Bot", which is what the viewer LABELS units with in the
  tooltip and event log; per-def absent when the capture recorded none, and absent
  wholesale from bundles published before it existed, so `app.js` `defName` falls back
  to `unitDefs` — a deployed replay keeps showing codes until it is republished),
  icons, footprints,
  players, bounds, `frameCount`, and the **chunk index** `{frame,count,kLen,len}` per
  chunk — `kLen` is the keyframe's RAW length inside the decompressed keys stream)
  plus the file's `E` events and `C` comms sections byte-for-byte — ~230 KB for a
  33-min game, so the page is interactive immediately. `/replays/<id>.keys` serves the `K` section
  byte-for-byte (every keyframe, one gzip stream); `/replays/<id>/c<n>` serves chunk
  n's delta bytes, **sliced straight out of the stored file**. The server never
  decodes a frame (except `.resources`, decoded once and cached): bounds/teams/index
  all come from the file's meta record (`snapshot.ParseBRP`), and parsed files are
  cached in-memory (mtime-keyed, ~4 entries) with `ETag`/304 revalidation so requests
  are cheap and re-visits free. In the browser, `app.js` gunzips each response with
  the native `DecompressionStream` and unpacks frames into the same flat stride-9
  `Int32Array` (`[id, def, team, x, z, hp, maxHp, dvx, dvz]`) the renderer always
  used.
- **`app.js` keys-first streaming**: right after the head, the viewer fetches
  `.keys` and pipes the response body through `DecompressionStream`, slicing
  keyframes out at the cumulative `kLen` boundaries as bytes arrive (`streamKeys`) —
  the first keyframe renders within the first network chunks, and **every minute of
  the timeline becomes scrubbable in a few seconds**, before any full chunk arrives.
  `data.frames` is a **sparse array**: keyframes land at their chunk-start indices as
  they decode, and a small fetch queue (2 in flight) then downloads each chunk's
  **delta file**, decoded seeded with its keyframe (`decodeFrames(raw, keyFrames[i])`;
  deltas that arrive before their keyframe wait in `pendingDelta`), playhead first,
  sequential in the background — so the whole replay "arrives gradually" (a
  buffered-ranges bar under the slider shows keyframe-only vs fully-loaded chunks,
  video-player style). Scrubbing an unloaded region renders its keyframe instantly
  (`dispIdx` falls back to it; the delta fetch starts after a 250 ms dwell), and
  playback holds on the keyframe at an unloaded spot until its chunk decodes. Verified
  headlessly (Playwright chromium) on the real capture: first keyframe at load, all
  31 keyframes streamed, instant mid-game scrub, and the completed download decodes
  to exactly the same 4.2M unit records as a full `ReadBRP`. `dvx`/`dvz` are the unit's
  **per-keyframe-interval velocity displacement**
  (`GetUnitVelocity` is per sim-frame, so the codec multiplies by `SampleEvery`) — used to
  **interpolate movement smoothly** between the 1 Hz samples rather than blinking. The
  front-end (`app.js` `interpPos`) fits a **cubic Hermite spline** between a unit's current
  sample (P0) and its next sample (P1, matched by id via `nextPosMap`), using each end's
  velocity displacement (`dvx/dvz`) as the tangent — so the unit leaves P0 at its frame-A
  velocity and arrives at P1 at its frame-B velocity, curving naturally and C1-continuous
  across samples (no boundary kink). Constant-velocity motion reduces to a straight line;
  tangents are length-capped (`TANGENT_CAP`× the chord) so an inconsistent velocity can't bend
  the path into a loop. A stationary unit (`dvx==dvz==0`) stays put — unless the next sample
  also has zero velocity but a DIFFERENT position (a radar-only contact: velocity reads nil,
  recorded as 0, while the wobbled position moves every sample), which glides linearly between
  the two points instead of jumping at the frame boundary. A unit absent from the
  next sample falls back to plain velocity extrapolation. GHOST BUILDINGS
  (viewer-side, all captures): an enemy STRUCTURE that leaves the capture with no
  destroyed event since its last sighting (widget >= 1.5.0 drops unlisted units;
  buildings don't move, so the last-known state stays true) is kept on the map
  semi-transparent (GHOST_ALPHA, per-instance alpha in the GL layout / a
  globalAlpha pass in 2D) and hoverable (last-known stats in the tooltip);
  mobile units never ghost. The ghost set is a pure function of the playhead —
  every keyframe indexes its structures as sightings as the .keys stream decodes
  (indexGhostSightings), and recomputeGhosts rebuilds the set on any
  display-frame change, so scrubbing in either direction shows the correct
  ghosts without watching the frames in between. Keyframe resolution (one per 64
  samples) is the deliberate trade: a structure only ever seen between two
  keyframes casts no ghost. Playback is a `requestAnimationFrame` loop over a continuous
  `playPos` (keyframe units), so **1× = real time** (1 game-second/second) and every speed
  interpolates.
  The column layout is defined by the `.brp` codec — `snapshot/brp.go` (Go encode+decode)
  and `decodeFrames` in `worker/public/app.js` (JS decode) must stay in lockstep, as must
  `STRIDE` (JS). The head's `bounds` (viewport fit) and team roster (Meta.Teams plus any team id
  seen only in frames/events — `frameTeams` — so nothing renders colourless) come from
  the file's meta record. `buildHead` also fills `footprints`
  (name→`{w,h}` in elmos) for **structures only** (`!UnitDef.CanMove || UnitDef.IsBuilding`):
  neither flag alone is enough — nano/build turrets are immobile but tagged builders (not
  buildings), while some factories report `CanMove`, so the union catches both and still
  excludes genuinely mobile units. `XSize`/`ZSize` are in 8-elmo squares, so it multiplies by
  8. Presence in the map == it's a structure, so the front-end draws a footprint rectangle
  only for those (mobile units carry no entry). This is
  best-effort — a capture predating the unit-def footprint dump has empty `XSize`, so no
  footprints; the layer is off by default (`showFootprints`). Unlike icons, footprints are drawn
  in world space, so they scale with zoom and are centred on the unit position (the footprint
  centre).
- **Chat + map drawings in the viewer (`app.js` `buildCommIndex`/`drawMarks`/
  `renderChat`)**: the head's `C` section decodes into `data.comms`, which splits two
  ways. MARKS (points, lines) draw in WORLD space on the overlay canvas — so a
  freehand scribble comes back as the shape its author traced — for
  `MARK_LIFETIME` = 60 game-seconds, matching BAR's own "Auto mapmark eraser" widget,
  fading over the last 8. The engine itself never expires a mark (only an explicit
  erase removes one), so the lifetime is a viewer choice; the ERASES are real and
  resolved once at load (`buildCommIndex` walks each erase backwards over the marks
  still inside the lifetime horizon and stamps `erasedAt` on those within 100 elmos of
  it — the engine's `CInMapDrawModel::EraseNear` radius, mirrored as
  `snapshot.CommEraseRadius`), which keeps drawing O(marks on screen) instead of
  O(marks × erases) per animation tick. CHAT lands in two places. The sidebar holds the
  conversation SO FAR: only lines already said at the playhead are shown (`.chatrow.future`
  is `display:none`, so the log never spoils what has not happened), clicking one seeks
  back to when it was said, and the box STICKS TO THE BOTTOM — scroll away and it stops
  following, scroll back down and it resumes (`chatStick`, re-evaluated from the box's own
  scroll event, which our own scrolling also fires and simply re-confirms, so no suppress
  flag is needed). The map shows the same message as a BUBBLE over
  its speaker, in team colour with black or white text picked by the colour's luminance
  (`textColorOn`), for `BUBBLE_LIFETIME` = 9 game-seconds — SCALED BY PLAYBACK SPEED,
  because that lifetime is game time but is read in wall time: at 16x it would be half a
  second on screen. `bubbleSpeedFactor` multiplies it by the speed while PLAYING (paused,
  the playhead does not move and nothing expires anyway; scrubbing is at the reader's own
  pace), capped at `BUBBLE_SPEED_CAP` = 16 — past that the bubbles linger long enough to
  bury the battle they are about. The factor is applied ONCE and the expiry frozen in
  `bubbleExpiry`: re-deriving the window from the current speed each frame measures it
  backwards from NOW, so touching the speed control popped old bubbles back in (window
  widens) and killed live ones (window narrows). The overlay is also fed a FRACTIONAL sim
  frame (`frameNumAt(idx) + renderFrac * sampleEvery`) — with the integer sample frame the
  fade stepped once per game-SECOND, the sampling rate, which at 1x reads as a stutter
  rather than a fade. The anchor is the speaker's
  COMMANDER — `COMMANDER_RE` = `^(arm|cor|leg)com` minus `boss`, which on a real BAR def
  table matches all 38 real commanders (including the `lvlN` and Legion upgrade paths)
  and rejects all 39 near-misses: DECOY commanders (`armdecom`), `comeffigylvl2`,
  `dummycom`, `mission_command_tower`, the scavenger bosses. Commanders die, so the
  fallback matters and is not rare: measured on a real full-view 8v8, 16/16 teams have
  one at t=0 but only 3/16 by t=20min, after which the bubble anchors to the centroid of
  whatever the team still owns — and once it owns NOTHING, to where it was last seen
  (`lastSeenOf` walks keyframes back from the playhead to the newest one still holding
  any of its units, preferring a commander there over the centroid, cached per team
  since only a wiped-out team ever asks). Being wiped out is exactly when people have
  something to say, so without that the messages most wanting a place on the map had
  none. A bubble never MOVES once it is up: `bubbleAnchor` freezes
  the position when a speaker's first live message appears and holds it until their whole
  stack has cleared, so neither a wandering commander nor a centroid drifting as the team
  builds and dies can drag the words across the map — and the next thing that player says
  is placed wherever they are by then. Freezing also makes the frame scan rare: it runs
  only on ticks where somebody NEW starts speaking. SPECTATORS own no units to speak from, so they
  all share one anchor — quiet ground as close to the MIDDLE as quiet ground gets
  (`quietSpot`), counted over every decoded keyframe and resolved once so it never
  wanders. Each cell scores its density plus a `QUIET_CENTRE_PULL`-weighted penalty for
  distance from centre, and the density is BLURRED over its 3x3 neighbourhood first —
  scoring cells alone picks a one-cell gap between two armies, empty but not calm.
  Tuned against a real 8v8's keyframes: unblurred on a 12 grid it chose dead centre with
  6.5% of the peak cell's traffic in it, where 16/0.3/blurred chooses a cell with NO
  units whose neighbourhood carries 2% of the peak, 27% of the way out to a corner.
  Sharing an anchor means sharing a stack (`SPEC_KEY`), which is why their bubbles name
  their author: black background, `(s) name:` always yellow, then the message — yellow
  to the spectator channel, white to everyone (`bubbleRuns` returns the coloured runs,
  laid left to right from the centred block). EVERY bubble, spectator or not, marks
  public chat with an `[ALL]` prefix (`chatBody`): team chat is the norm during a game,
  so an unmarked bubble is something said to that player's own side and the exception is
  what earns the label. A battleroom relay, or
  a team with nothing left, gets no bubble and lives only in the sidebar. The whole
  layer switches off from the sidebar's "Hide chat bubbles" — one of the few view
  toggles that earns a control rather than a `const`, since bubbles sit on top of the
  map you may be trying to read. The panel hides
  itself when the capture recorded no chat — which is what every replay published before
  the `C` section looks like.
- **`internal/viz/icons.go`** renders **real BAR unit icons**. It embeds the vendored icon
  PNGs and BAR's `icontypes.lua` (a unit-name→bitmap gamedata table) under `bardata/`, and
  **parses the Lua data table directly in Go** (a small line/brace scanner, no `gopher-lua`)
  — keeping the repo stdlib-only. It also replicates the file's trailing `_scav` synthesis
  (inverted-path variants) and keeps only entries whose bitmap file actually exists in the
  embedded FS, so the payload never advertises a 404. It also parses each type's `size`
  multiplier. `buildHead` fills `unitIcons` (name→`{path,size}`) for just the def names in the
  replay; the front-end draws every unit as its icon, **team-tinted** (BAR icons are grayscale
  luminance masks — bright→team colour, black→black — so the icon is `multiply`-composited
  into a team-colour field then clipped to its own alpha, preserving the internal detail;
  cached per icon×team) at a **constant
  screen size** (`ICON_PX_PER_SIZE * size`, independent of zoom, like BAR's minimap — so icons
  spread apart when zoomed in and overlap when zoomed out). The base px-per-size-unit is
  `iconScale`, FIXED at 12 — it and the render toggles (icons/grid/footprints/build
  lines/team colours) were a checkbox row above the canvas, now deleted along with the
  `?iconsize=` param that persisted the slider: they are plain `const`s at the top of
  app.js, so changing one is an edit rather than a UI state every draw path has to carry.
  A unit with no/loading icon shows a coloured dot so it is never invisible — and
  since a replay requests all 300-650 of its icons in one burst at load, a dropped
  response is routine, so `getImage` RETRIES a failed path (3 attempts, 2 s apart)
  instead of caching the failure; caching it dotted that unit type until the page was
  reloaded. The
  selected replay is kept in the URL, so a refresh/shared link restores it.
  Icon fitting (`growIcons`, always on) makes a *building's* icon grow to 90%
  of its footprint (`0.9 * min(fpW,fpH) * scale`) once that exceeds the constant size — i.e.
  it stays constant when zoomed out and fills the footprint when zoomed in; mobile units
  (no footprint) are unaffected. The icon is resolved by the unit-def's `iconType` key first
  (falling back to its name), so units whose iconType differs from their name still get an icon.
- **WebGL icon renderer (`app.js` `initGL`/`glBuildInstances`/`glRender`)**: the default
  icon path whenever WebGL2 with a *hardware* renderer is available. All grayscale icon
  bitmaps pack into **one atlas texture** (uploaded as bitmaps arrive, mipmapped,
  premultiplied alpha) that lives in GPU memory for the whole session. It starts at
  2048² and **GROWS to 4096² (`ATLAS_MAX`, capped by `MAX_TEXTURE_SIZE`) the first time a
  replay runs out of slots**, re-packing everything already in it (uv rects are
  normalized by the atlas size, so a resize invalidates all of them — `growAtlas` bumps
  a generation counter and `glBuildInstances` rebuilds the frame when it changes
  mid-build). This is not a corner case: BAR's icons are 128px, so 2048² holds ~181,
  while a modded game (scavengers/extra units) references **300-650 distinct bitmaps** —
  every deployed replay measured needs the growth, and before it, everything past the
  ceiling drew as a coloured dot for the rest of the session. Oversized bitmaps pack
  DOWNSCALED to `ATLAS_CELL` (128): four of BAR's icons are 256px, and packed native each
  one turns a shelf row 256 tall and costs ~150 slots. Each animation
  frame only writes a per-unit instance buffer `[center, size, uv rect, tint]` and issues
  a **single instanced draw call**, with the team tint applied in the fragment shader
  (`rgb * tint`, icon alpha — the same multiply+destination-in composite the 2D path
  bakes into per-team glyph canvases, so the output matches visually). Icons draw on the
  transparent overlay canvas `#glcv`; the 2D canvas keeps the base layer (map, grid,
  footprints) and **skips repainting entirely** on ticks where only icons moved (a
  `baseKey` of everything the base layer depends on). Software GL (SwiftShader/llvmpipe)
  is refused — its frames reach the compositor via pixel readback, slower than the 2D
  path — and everything falls back to the original per-unit `drawImage` loop, as it does
  on any init/context failure (`?gl=1` forces GL on, `?gl=0` forces the 2D path). The 2D
  BUILD BARS interpolate too (`interpBuild`): the stored build column is a 1 Hz
  step, so a bar visibly jumped once per sample until it was lerped toward the
  next sample's value like positions are. It guards on the DEF matching, unlike
  `interpPos` — the engine recycles unit ids and a bar rewinding to zero because
  the id now belongs to something else is far more noticeable than a position
  doing it. Measured at 2.7us/frame for 200 under-construction units among 2500
  (0.016% of a 60fps budget), so it is not gated on playback speed. The 2D
  path itself was also slimmed for unit-heavy replays: per-def icon/footprint tables
  built once per load (`buildDefTables`) instead of two string-hash lookups per unit per
  frame, per-draw def/glyph memos instead of per-unit `"path|color|px"` keys, an
  allocation-free `interpPos` (shared scratch), throttled sidebar DOM rebuilds during
  playback (200 ms min), and time-label writes only when the text changed. The SLIDER
  is the deliberate exception: it tracks the continuous `playPos` and so is written
  every tick while playing, because writing the sample index moved the thumb once per
  SAMPLE — a full wall-second apart at 1x, ticking like a clock hand while everything
  else animated. That needs `step="any"` in the markup (a stepped range SNAPS a
  fractional assignment, which is what made it step in the first place), and in turn
  the arrow-key handler suppresses the slider's NATIVE stepping when it has focus:
  under `step="any"` the browser's own arrow step is a hundredth of the timeline
  rather than one frame. Dragging is unaffected — `go()` rounds, and the round-trip
  writes the whole sample straight back.
- The **real map terrain** behind the units is loaded **entirely client-side** (`loadMap`
  in `app.js`): the browser takes the head's `mapName` (from the capture's meta),
  resolves it to the API's **file name** (see below), and talks straight
  to BAR's maps API — `https://api.bar-rts.com/maps/<file>` for the world extent in
  elmos (the API's width/height are map units × 512) and `…/texture-mq.jpg` for the
  terrain image. **Resolving the file name is not a string transform** (non-obvious):
  the API keys maps on the archive file the map's author uploaded, so
  `mapFileGuess` (lowercase, spaces→`_`) is right for only ~85% of BAR's map list —
  `Frozen_Ford_V2` keeps its capitals (`frozen_ford_v2` 404s), `Eye Of Horus 1.6` is
  stored as `Eye Of Horus_1.6` (spaces and all), `Desolation v1` is just `desolation`.
  So `resolveMapFile` tries the guess and, on any non-200, falls back to
  `…/replays/<gameId>`, whose `Map` object carries the authoritative
  `{fileName,width,height}` — which also gives a `pack -no-demo` capture (empty
  `mapName`) its terrain back. The API sends `access-control-allow-origin: *`, and the image is loaded
  with `crossOrigin="anonymous"` so the canvas stays untainted. The viz server has **no
  map code at all**. Best-effort: no name in the meta, an unknown map, or no outbound
  network just yields a plain background (and the field extent falls back to the
  sampled unit bounds). The front-end positions the texture at world
  `(0,0)`–`(width,height)` so units overlay correctly; the terrain layer is always
  on (no toggle). Caveat: the widget stream doesn't record the map name
  (only the demo startscript path does), so a `.brp` packed from a raw `.brsnap` with
  `pack -no-demo` has an empty `mapName` and renders the plain background; the
  default pack fetches the demo by gameId and fills it in.
- **`internal/viz/server.go`** embeds the SPA from **`worker/`** (`index.html` +
  `public/{app.js,style.css}` via `worker/assets.go` — the single copy of the
  front-end in the repo) and exposes `/index.json` (the replay list),
  `/replays/<id>.brw|.keys|.resources`, `/replays/<id>/c<n>`, and `/icons/<file>` +
  `/ranks/<n>.png` (the embedded icons, cached). It also serves the widget-install
  guide the landing banner links to — `/setup` (`public/setup.html`, embedded too)
  and `/replay_uploader.lua` (`assets.ReplayUploaderLua`) — so the relative link
  works here and not only on the Cloudflare deployment. The `<id>` segment is
  confined to the snapshots dir (maps to `<id>.brp`, basename only — rejects any
  path separator / traversal). UI/JSON assets are served `no-store` so a changed UI
  never serves stale.
- **`worker/public/`** (+ `worker/index.html`) is plain HTML/Canvas/vanilla-JS — **no
  framework, no build step for the app itself** (Vite only wraps it for the Cloudflare
  deploy). `app.js` reads the flat unit arrays by index (no per-unit objects), renders
  via WebGL instanced sprites (2D-canvas fallback), and does timeline scrub / play /
  zoom / pan / hover-tooltip. Colours are assigned per ally-team (a base hue per ally,
  lightness varied per team within it).

Guarding the tool: `internal/viz/viz_test.go` serves a synthetic `.brp` through the
real HTTP handler and checks the head payload (bounds, teams incl. frame-only ones,
footprints, chunk index) plus the pass-through contract: the keys and chunk responses
must be the stored file's exact byte ranges, and the listing shows only `.brp` files.
No engine or browser needed.

### Serverless static hosting (`internal/viz/static.go` + `cmd/barreplay-static` + `worker/`)

Because the viz server never decodes a frame — the head is a pure function of the `.brp`
meta and the keys/chunk responses are independently-gzipped byte ranges — the whole
playback path can be served as **plain static files with no server**.
`viz.WriteStaticBundle` precomputes, per capture: `replays/<id>.brw` (the head),
`replays/<id>.keys` (the `K` section), `replays/<id>.resources` (the economy JSON,
stored **uncompressed** — a pre-gzipped body double-compresses on Cloudflare), and one
`replays/<id>/c<n>` file per chunk with delta frames (single-frame chunks get no file).
`WriteIndex` writes `index.json`. These are **byte-identical** to the dynamic server at
the same URLs (guarded by `static_test.go`, which diffs the bundle against the real HTTP
handler), so the same `worker/public/app.js` runs against both backends with no URL
swapping at all. `cmd/barreplay-static` is the CLI; the `worker/` Cloudflare project
(Hono + Vite) serves the bundle from an R2 bucket and the SPA + vendored icons as static
assets. Map terrain is fetched browser-side straight from `api.bar-rts.com`, so the
worker has no map proxy and no playback logic. `static.go` shares the wire encoders
(`brpWirePayload`/`brpResourcesJSON`), so it stays in lockstep with the codec
automatically — the same three-way codec lockstep note applies.

## Running a real capture (needs the engine + content)

`barreplay -data <BARdata> -out ./snaps <replay-link>` will, in order: download the
`.sdfz`, parse it, ensure engine+game+map are present, inject the widget, and run
`spring-headless`. For that to work the host needs:

- `spring-headless` **matching the replay's engine version exactly** (sync-version must
  match or the re-sim desyncs). `engine.EnsureEngine` (`internal/engine/enginedl.go`)
  now **downloads it automatically** into `<BARdata>/engine/<version>/` when it is
  missing — callers run it just before `Locate` — so normally nothing to do. It needs
  `7z`/`7za` on `$PATH` (the release is a 7z and the stdlib cannot read one; install
  `p7zip-full`). `-no-provision` or `-engine` opts out.
- The game archive and map (auto-fetched by `pr-downloader` when a copy is found and
  `-no-provision` is not set; override identifiers with `-game`/`-map`).

**One run per data dir (non-obvious).** A run is NOT isolated within its data dir: it
rewrites shared state there — the widget order config (`EnableWidget` backs the user's
up and *restores* it afterwards), `_barreplay_script.txt`, the merged springsettings,
`infolog.txt`, and the widget's stream under `barreplay/`. Two concurrent runs corrupt
each other, and the symptom is remote from the cause: run B's teardown restores the
widget config out from under run A, whose widget then never loads, so A fails minutes
later with `open widget output ...: no such file or directory` and no hint another
process was involved (observed: it killed a re-sim 17% in). `engine.LockDataDir`
(`internal/engine/lock.go`) therefore takes an advisory `<data>/.barreplay.lock`
holding the pid + command line; `cmd/barreplay` and `internal/resim` acquire it before
any engine work and release it on return. A lock whose pid is dead is stale and gets
taken over, so a crash or `kill -9` never wedges the dir. To run two captures at once,
give them separate `-data` dirs (the engine auto-download will populate the new one).

**Version mismatch is now a hard error, not a fallback (non-obvious).** `findBinary`
searches `<data>/engine/*` and `$PATH`, which is right for an install that suffixes
the version (`"<ver> bar"`) but was catastrophic when the required build was simply
absent: it silently ran whatever was installed, the demo desynced within ~60 frames,
and the capture looked completely normal while describing a game that never happened
(observed: a 2026.07.04 replay re-simulated on 2025.06.24 produced 10k desync
warnings and was nearly published). `Locate` therefore runs `--version` on whatever it
found and refuses a mismatch. An explicit `-engine` only warns (operator's call), and
an *unparseable* banner also only warns — refusing on an unrecognized format would
break custom builds. Guard: `TestLocateRejectsMismatchedEngineVersion`.

### Provisioning the engine + content manually (validated recipe)

Only needed with `-no-provision`, or to pin a custom build — `EnsureEngine` above does
this automatically otherwise. The Recoil engine is on GitHub Releases
(`beyond-all-reason/RecoilEngine`). The
`recoil_<ver>_amd64-linux.7z` asset (~31 MB) bundles `spring`, `spring-headless`,
`spring-dedicated`, and `pr-downloader`. Extract it into a data dir (`7z x`); use that
dir as both the engine location and `--write-dir`.

`pr-downloader` defaults to `springrts.com`, which has **no BAR content**. The tool
therefore sets two env vars automatically in `engine.prdEnv` (each overridable — a
pre-set value in the environment wins):

- `PRD_RAPID_REPO_MASTER=https://repos.beyondallreason.dev/repos.gz` — **games/mods**
  (rapid). Also settable via `-rapid-repo`.
- `PRD_HTTP_SEARCH_URL=https://files-cdn.beyondallreason.dev/find` — **maps** (BAR maps
  are not in rapid; they resolve through this springfiles-compatible search endpoint).
- `PRD_RAPID_USE_STREAMER=false` — download rapid pool files individually over HTTP
  instead of via the streamer. The streamer is faster but **flaky on WSL / behind
  proxies**: it stalls mid-pool and leaves a `packages/<md5>.sdp.incomplete` (which the
  engine ignores, so the game archive is reported "not found" even though pr-downloader
  exits 0). Defaulted off for reliability; set `PRD_RAPID_USE_STREAMER=true` to opt back in.

`pr-downloader` re-queries (and can re-download) content on every call even when it is
already installed, so `EnsureContent` first checks the filesystem and skips the download
when the content is already there: a rapid game is a finalized `packages/<md5>.sdp` (the
md5 comes from the same versions.gz line as the tag; a `.sdp.incomplete` does not count),
and a map is an archive in `maps/` named after the normalized springname (lowercase,
spaces→`_`, e.g. `Hooked 1.1.1` → `hooked_1.1.1.sd7`, matched case-insensitively). This is
self-correcting — delete the content and it re-downloads. `-force-provision`
(`Config.ForceProvision`) forces the download; `-game`/`-map` overrides always run.

Provisioning is best-effort — a download failure is a warning, not a hard abort
(idempotent; skips content already installed). Behind a proxy you may still need
`PRD_SSL_CERT_FILE=<ca>` in the environment (the tool passes it through); the streamer
is already disabled by default (see above). The equivalent manual recipe:

```sh
# from inside the extracted engine/data dir:
PRD_RAPID_REPO_MASTER=https://repos.beyondallreason.dev/repos.gz \
PRD_RAPID_USE_STREAMER=false \
PRD_SSL_CERT_FILE=/path/to/ca-bundle.crt \   # only if the system trust store lacks the proxy CA
./pr-downloader --filesystem-writepath . --download-game "byar:git:<commit-sha>"
./pr-downloader --filesystem-writepath . --download-map "Isidis crack 1.1"
```

A replay pins **one exact game build**, so the moving `byar:test` tag is wrong: it
resolves to the latest test build, not the one the demo needs, and the engine then
aborts with `content_error: Dependent archive "…" not found`. The demo's `gameVersion`
is the build's *springname* (e.g. `Beyond All Reason test-30541-1efcf40`) but carries
only the **short** sha, and pr-downloader won't resolve a game by springname — you must
hand it the full `byar:git:<full-sha>` rapid tag.

`engine.resolveRapidGameTag` (`internal/engine/rapid.go`) does this automatically: it
reads the gzipped rapid index (`https://repos.beyondallreason.dev/byar/versions.gz`,
lines are `tag,md5,depends,springname`), matches the demo's springname exactly, and
downloads the resulting tag. The index is cached at **`<data>/cache/versions.gz`**: a
cache hit skips the download; a miss (new build not in the cached copy) triggers exactly
one refresh that atomically replaces the cache. It is best-effort — if the lookup fails
it falls back to passing the springname as-is; `-game <tag>` is the manual override. The
versions URL is derived from `-rapid-repo` (`…/repos.gz` → `…/byar/versions.gz`).

The wrapper startscript `barreplay` writes forces max speed:
`[game]{ demofile=<abs path>; } [modoptions]{ MinSpeed=9999; MaxSpeed=9999; }`.

## GPU / headless caveat (important)

This Recoil build's `spring-headless` still initializes a **null GL context (version
0.0)** and builds a unit-icon **render-to-texture atlas** at load (`CIconHandler` /
`CTextureRenderAtlas`). On a **GPU-less** machine that render never completes
(`atlasRendered=0` loops forever), so the game never reaches "playing" and LuaUI
widgets — including the snapshotter — never load. Symptoms in `infolog.txt`: stuck at
`[f=-000001]`, endless `CreateAtlasTexture ... IconsAtlas_0` lines, no `BRSNAP` output.
The demo does re-simulate up to that point (you'll see players connect, initial spawns,
and demo chat replay), so this is purely a rendering-init wall, not a logic problem.

Run on a host with **working GL** (a real GPU, or a full software-GL setup). Notes for
a GPU-less runner:

- The graphical `spring` binary can use software GL via **Xvfb + Mesa llvmpipe**
  (`LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe xvfb-run -a ./spring …`) — it needs
  `libsdl2-2.0-0` and `libopenal1` installed (not bundled) and is memory-heavy under
  software rendering.
- `spring-headless` under Xvfb does **not** help: it ignores the X display and keeps
  its null GL context.

## Profiling a run (where does the time go?)

The replay wall time has two parts, and the CLI splits them in its completion summary
(`engine total X = load Y + sim Z (N frames, fps, speed-up)`): **load** (engine boot, VFS
archive scan, map load, icon atlas — everything until the widget initializes, detected by
watching the engine's stdout for the first `[barreplay]` line while draining it) and
**sim** (frame processing). Load is a fixed cost; sim scales with game length and unit count.

For *what inside the sim* is expensive, the widget dumps the engine's **internal time
profiler** (the `/debug` overlay data) via `Spring.GetProfilerRecordNames()` /
`Spring.GetProfilerTimeRecord(name)`:

- every heartbeat: a `[barreplay] prof Sim=…ms Lua=…ms …` line (top 5, infolog only) —
  shows whether per-frame cost drifts as unit count grows;
- at game over: `BRSNAP PROF <totalMs> <name>` lines (top 40) written into the stream
  file, which `capture` collects into `capture.Stats.Profile` and the CLI prints as a
  sorted table with % of wall time.

**`-profile` (fine-grained mode, non-obvious):** by default the table only shows a few
coarse rows because `CTimeProfiler::AddTime` **drops all non-"special" timers while the
profiler is disabled** — only `SCOPED_SPECIAL_TIMER`s (`Sim`, `Draw`, `Lua::Callins::*`,
GC) always record. The detailed scopes (`Sim::Unit::{MoveType,SlowUpdate,Update,Weapon}`,
`Sim::Los`, `Sim::Path`, `Sim::Projectiles::*`, `Sim::Script`, …) exist but stay at 0.
`-profile` substitutes `__PROFILE__` so the widget runs `Spring.SendCommands("debug 1 0")`
in `Initialize`: arg 1 (`drawDebug`) enables profiler collection, arg 2 (`draw4Real=0`)
keeps the ProfileDrawer overlay off (nothing to draw headless). In this mode the widget
also writes `BRSNAP PROFD <frame> <units> <totalMs> <name>` samples (top 15 scopes) each
heartbeat, and the CLI prints a **growth table**: per-scope ms/sim-frame over the first vs
last third of the game, with the unit-count range — the direct answer to "what gets
expensive as the unit count grows". Profiling overhead is visible in the table itself as
`Misc::Profiler::AddTime`.

Caveats: profiler scopes **nest** (`Sim::Path` time is also counted inside `Sim`), so
entries overlap and don't sum to 100%. Records only exist for scopes the engine actually
entered; if the API is missing on some engine build the widget logs that and skips it.
`ThreadPool::{RunTask,AddTask,WaitFor}` are **inflated under `-profile`**: every tiny
task then pays two locked `Misc::Profiler::AddTime` calls, so judge threading changes by
plain-run wall time, never by the profiled totals. `ThreadPool::RunTask` also sums time
across all worker threads and can exceed 100% of wall.

The heartbeat line also reports `draws=<N>` (draw frames since the last heartbeat,
counted via the `widget:Update` callin — the engine's *real* draw rate, i.e. whether
`-throttle-draw` is holding) and `widgets=<N>` (currently active widget count — whether
the default suite stayed disabled). `-worker-threads N` injects the `WorkerThreadCount`
springsetting for the run (-1 = auto, 0/1 = no workers); it only changes local task
scheduling, so it cannot desync — sweep it with plain runs and pick the fastest.

Interpreting the split for optimization work:

- **Synced sim** (`Sim*` scopes, synced Lua = BAR's LuaRules gadgets, pathfinding, unit
  scripts, LOS) is the deterministic re-simulation itself — it *cannot* be skipped or
  approximated without desyncing. If `Sim::Unit::*`/`Sim::Script` dominate, the run is
  single-core bound (faster CPU or upstream engine work only). If `Sim::Path`, `Sim::Los`
  or `Sim::Projectiles::Collisions` dominate, those parts use the engine ThreadPool —
  check the `WorkerThreadCount` springsetting (default -1 = auto) actually spins up
  workers headless (`ThreadPool::RunTask` in the table is the tell).
- **Unsynced overhead** (LuaUI = BAR's own default widget suite, which loads in replays;
  logging/infolog flushes; draw-adjacent scopes) is fair game — it does not affect
  determinism and can in principle be disabled or reduced.

For a C++-level answer beyond the engine's own scopes, use `perf` on the running
process: `perf record -g -p $(pidof spring-headless)` then `perf report` (symbol quality
depends on how the release binary was built).

## Cutting unsynced overhead (default-on speedups)

Profiling showed ~40-50% of the sim-phase wall time is **unsynced** work that cannot
affect the deterministic re-sim: BAR's default widget suite (`Lua::Callins::Unsynced`)
and the draw-side update chain that runs even headless (`Update::WorldDrawer`, `Draw`,
unit/feature drawer updates). Two default-on optimizations remove it; since the sim is
untouched, the output snapshot file must stay **byte-identical** (the `.brp` writer is
deterministic) — diff against a previous run to verify any change here.

- **`-disable-widgets` (default true):** the snapshot widget disables every other active
  widget on the first `GameFrame`. This must happen at runtime: BAR's handler
  auto-enables any game-archive widget with `enabled=true` that is *absent* from the
  saved order list (order 12345), so a seeded config can only disable widgets it can
  name, and the suite's names vary by game version. The widget sets `handler = true` in
  `GetInfo()` (grants `widget.widgetHandler`), then calls the **queued**
  `widgetHandler:DisableWidget(name)` (applied between callins; never mutate the widget
  list mid-callin via the `*Raw` variants) for every `knownWidgets` entry that is
  `active` and not itself. pcall-guarded like the profiler dump.
- **`-throttle-draw` (default true):** in demo playback the engine yields from sim to
  draw every `GAME_SPEED/MinDrawFPS` sim frames and reserves `MinSimDrawBalance`
  (default **0.15** = 15%!) of CPU time for drawing; each draw runs the full unsynced
  update chain even with headless null-GL. `engine.WriteEngineConfig` writes
  `<data>/_barreplay_springsettings.cfg` = the user's `springsettings.cfg` (if any,
  preserving e.g. `WorkerThreadCount`) merged with `MinDrawFPS=1` +
  `MinSimDrawBalance=0.001` (≈1 draw/s), and `engine.Run` passes it via `--config`. The
  user's real config is never touched — important because the engine *writes runtime
  config changes back* to whatever file `--config` names. Both settings are read once at
  startup (`CGlobalConfig`), so `Spring.SetConfigInt` from the widget would not work.

**Replay speed is governed by the local server, not raw CPU (non-obvious).** In demo
playback the client process hosts a local `CGameServer` that releases the demo's
pre-recorded NEWFRAME packets paced by `modGameTime += dt * internalSpeed`, and
`LagProtection` (`rts/Net/GameServer.cpp`) continuously adjusts `internalSpeed` toward a
**hardcoded client-CPU target**: the client reports `GetTimePercentage("Sim")` (draw time
barely counts) every second, and the server holds that at 60% (`SpeedControl=1`, default)
or 75% (`SpeedControl=2`, injected by `-throttle-draw` — with one local client the
median/max distinction is moot, so this is a free ~+25% ceiling). Consequences: the sim
idles ~40%/~25% of wall time by design, and whenever the client outruns the feed its
packet queue starves, `ClientReadNet` returns empty-handed, and the main loop spins full
`UpdateUnsynced`+`Draw` passes (the heartbeat `draws=` counter exposes this: hundreds of
draws/s late game despite `MinDrawFPS=1`). Fully removing the governor (pin
`internalSpeed` to `userSpeedFactor` when a demo is being read) needs a small engine
patch — sync-safe, since pacing changes only when pre-recorded packets are released,
never their content — and is the main remaining speed lever (~25-35% at the 60% target).

## Conventions / gotchas

- Go module: `github.com/mabn/barreplay`, Go 1.24. No third-party deps (stdlib only).
- Unit-def internal names (`armcom`, `corllt`, …) and side names (`armada`, `cortex`)
  have no spaces — the BRSNAP `D`/`T` parsers rely on that.
- `fileName` from the API contains spaces; always `url.PathEscape` it (see `barapi.DownloadURL`).
- The demo header is little-endian, byte-packed; layout verified in
  `internal/demofile/demofile.go` against the real sample (magic `spring demofile`,
  version 5, headerSize 352).
- Output: `<out>/<gameId>.brp` (see "On-disk format v5"); read it back with
  `snapshot.ReadBRP`. On completion the CLI
  prints the engine wall-time (split into load + sim, with sim fps/speed-up), the engine
  profiler totals (see "Profiling a run"), `infolog.txt` size, and the snapshot's size.
- `-progress` (`cmd/barreplay` + `engine.WatchProgress`; **default on**, matching
  `bringest -progress` — a re-sim runs for tens of minutes, so a silent one is the
  surprising case; `-progress=false` opts out) polls the tail of
  `<data>/infolog.txt` every 2s, parses the newest `[f=<frame>]` marker, and prints
  frame/total, in-game time, %, processing fps, speed-up (fps/30), and ETA. Total game
  length comes from the demo header `GameTime`; the engine sims at 30 frames/game-second.
- Development happens on branch `claude/bar-replay-snapshots-g8jmfj`; `main` is the base.
