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
go build ./cmd/pack             # build the .brepstream -> .brp converter -> ./pack
go build ./cmd/barreplay-static # build the .brp -> static-hosting bundle packer (for worker/)
go build ./cmd/insights         # build the game-summary backfill CLI (one replay, or -all)
go build ./cmd/winfit           # build the win-probability model fitter (reads insights files; -categories fits lava / large ranked / ranked / unranked separately)
go build ./cmd/bringest         # build the drag&drop upload daemon (polls the worker's job queue)
(cd cmd/fogofwar && GOOS=windows go build -tags desktop,production -ldflags "-H windowsgui" -o FogOfWar.exe .)   # the Windows desktop re-simulator (its own module: Wails; see cmd/fogofwar below). NOT stripped (-s -w): a stripped unsigned Go exe is a classic antivirus false positive. Icon/version/manifest come from the committed rsrc_windows_amd64.syso (go run ./winres to regenerate)
# RELEASES of FogOfWar.exe are built by .github/workflows/fogofwar.yml, never on a plain push: Actions > FogOfWar > Run workflow (empty version = unsigned test artifact; a version like 0.3.0 = release fogofwar/v0.3.0) or push the tag fogofwar/v<x.y.z>. It stamps the version into winres + main.version; the exe is unsigned. docs/fogofwar-release.md
go run ./cmd/publish-engine -data <BARdata>   # gate, strip and upload the patched engine build under <data>/engine/*/ to R2, then print the patchedBuilds pin to commit and the tag to push (hosts download it once the pin is merged; -dry = everything but the upload; -gate <gameIds> for a version with no default gate replay)
go run ./cmd/publish-engine -data <BARdata> -windows <spring-headless.exe>   # the WINDOWS build of the same series (patches/engine-<ver>/windows/build.sh, MinGW cross-compile) for FogOfWar.exe: gated under Wine against the stock LINUX engine, uploaded to engines/<ver>/windows-amd64/, pinned in patchedBuildsWindows (needs wine64)
go run ./cmd/insights <gameId|link|rid>   # compute a PUBLISHED replay's game summary and publish replays/<rid>.insights<N>.json beside it (-upload r2 default, local, or empty + -out to just write it; -all walks the catalog, -from/-to narrow it to games started in a date range (YYYY-MM-DD or unix seconds); -j N replays at once, default 4; -force recomputes; a local .brp/.brepstream with -rid gives full costs; everything read from the real bucket is kept under ~/.cache/barreplay/<bucket host>/ so a re-run downloads only what is new — -cache DIR moves it, -cache= turns it off)
go run ./cmd/upload-maps <dir>   # upload the BAR team's high-res map PNGs to the replay bucket as maps/highres/<file name> (image/png; same-size objects skipped, so a rerun resumes; -j 8 at once, -dry lists only; R2 keys from ./.env)
go test ./...                   # all unit tests (no engine required)
go vet ./... && gofmt -l .      # lint; gofmt -l prints nothing when clean
go run ./cmd/barreplay -no-run <link|gameId|file.sdfz>   # download+parse only, no engine
go run ./cmd/pack ./caps/<gameId>.brepstream   # THE default publish: raw stream -> FULL .brp (fetches the demo for map/versions/players; -id overrides, -no-demo skips) -> stats -> upload to R2 + register in the deployed worker's catalog, revisioned. -upload, -stats and -rev all default ON, so the bare command does the whole job
go run ./cmd/pack -upload= ./caps/<gameId>.brepstream   # pack + stats only, publish NOTHING (also how to analyze an existing .brp without republishing it)
go run ./cmd/pack -upload local ./caps/<gameId>.brepstream   # ...to the dev simulator instead
# -upload names a whole DESTINATION: the bucket AND the worker that serves+catalogs it, paired in
# internal/packer/targets.go ("r2" -> https://replay.fogofwar.dev, "local" -> http://127.0.0.1:5173)
# and shared with bringest. NEITHER CLI has an index-URL flag: naming the two halves separately made it
# possible to upload pieces to one deployment and register the row in the other, which nothing downstream
# can detect. Adding a destination to that one map makes it valid, documented and usable in both CLIs.
# $REPLAY_PUT_TOKEN authenticates the PUT.
# Publishes land in MONTH FOLDERS (internal/packer/names.go): replays/<YYYY-MM>/ = the game's UTC start month
# (capture meta, else the BAR API's startTime, else replays/undated/). A capture that saw EVERY team
# (packer.CapturesAllTeams: a spectator's recorder record, Meta.Resim from the re-sim's GAME line, or a declared
# view "full" — bringest -resim, pack -view full) takes the game's MAIN name, <YYYY-MM>/<gameId>.brp, when the
# game has none; everything else is <YYYY-MM>/<gameId>-<rev>.brp. "Has none" is asked of the catalog row's uploads
# (each entry carries its rev, so a republish of the main's exact bytes uploads nothing) and then ENFORCED by a
# conditional PUT (If-None-Match: *; 412 -> the suffixed name), so a main is never overwritten. The row keeps
# pointing at its main when a suffixed upload follows (ReplayIndex.upsert). The rid is that whole relative path,
# so readers (app.js ridPath, cmd/insights) need no layout knowledge; flat replays from before stay as they are.
# Publishes are REVISIONED by default: pieces land at replays/<gameId>-<rev> (rev = sha256[:8] of the PACKED
# .brp, NOT of the input stream: two packs of one capture can differ — a codec change, or -no-demo vs the
# demo fetch — and hashing the input gave them the SAME immutable keys, so the second silently overwrote
# the first. The .brp writer is deterministic, so an unchanged republish still re-lands on the same keys)
# and the catalog row's rid points at the current one — append-only, nothing in the bucket is ever
# overwritten or deleted (-rev=false uses the bare id). -stats prints a .brp size breakdown: per-section
# sizes + top-10 unit defs by encoded bytes with per-instance cost (snapshot.ComputeBRPStats, self-checked
# against the codec; raw captures pack first, then report).
go run ./cmd/barreplay-static -out ./static ./snapshots/*.brp   # pack .brp -> static bundle for R2 hosting (see worker/)
go run ./cmd/bringest   # drag&drop upload daemon: poll the deployed worker's job queue and publish uploaded .brepstreams, printing each one's .brp size breakdown like pack -stats (-stats=false quiets it; -once drains and exits; -upload local targets the dev simulator — one flag picks the queue, bucket and catalog together; -resim -data <BARdata> runs the re-sim worker instead: it drains the re-sims REQUESTED from the queue page's paste box, then scans the catalog for games with only a one-sided upload, publishing each full view as another revision; the UPLOAD mode — never -resim — also holds a WebSocket to the worker and computes ON-DEMAND SUMMARIES while a reader waits: a summary the viewer found stale or missing is computed, published and handed to the page in seconds; -insights=false skips it, -insights-slots N at once (default 2), -cache as for insights)
```

Tests are hermetic: `barapi` uses a mock HTTP server, `demofile` tests against the
real fixture `internal/demofile/testdata/sample_header.sdfz`, `snapshot`/`capture`
are pure, `internal/packer` exercises its demo-metadata fetch against a mock
BAR API serving that same fixture, and `cmd/bringest` runs its loop
against a mock worker API. None of them launch the engine or touch the network.

## Architecture (where things live)

```
cmd/barreplay/main.go     CLI: link/gameId/.sdfz -> full pipeline
cmd/pack/main.go          CLI: convert .brepstream captures to .brp; -stats prints the
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
                          UploadStatic — writes the static bundle (viz.WriteStaticBundle: the
                          .brp, one object) and
                          uploads it to the worker's R2 bucket so it appears in the deployed
                          viewer with no redeploy. For "r2" with R2 API credentials in the env
                          (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) the upload is NATIVE Go
                          (r2.go: a minimal SigV4 signer — pinned byte-for-byte against an
                          aws4fetch fixture, the signer the TS path uses against R2 — with 16
                          concurrent PUTs, one retry on 5xx, and the .brw-heads-last barrier —
                          moot for a publish today, which is ONE object, the .brp;
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
                          revision (an archived .brp is never repacked: it is fully decoded once
                          as a check and given the demo's self-destruct orders and modoptions via
                          packer.AddDemoOrders; WHOSE VIEW an upload of either kind is published
                          under comes from its FRAMES, not its own claim — packer.ViewFromFrames
                          counts the sides owning an identified unit in the first 10 s, when no
                          side can have seen another yet: two or more = "full", one = "ally";
                          with no opening frames a one-sided claim stands and a full one becomes
                          "unknown" (packer.UploadView); the verdict rides jobStats.viewCheck) (demo fetch falling back to the stream's own GAME metadata
                          when the BAR API doesn't know the game), and reports done/error for
                          the browser to poll. -once drains the backlog and exits; jobs survive
                          daemon downtime as pending, stalled "processing" jobs are re-offered
                          after 15 min. It asks for ?kind=upload and additionally SKIPS anything
                          that is not one: the daemon and the worker deploy independently, so a
                          worker too old to filter still serves it re-sims, which it must leave
                          PENDING (not fail) for the host that can run them.
                          -resim (needs -data on an engine-capable host) runs a DIFFERENT worker
                          instead of the upload loop, over ONE work list: GET
                          /api/jobs?kind=resim. That list is fed from three places the daemon
                          cannot tell apart and does not need to — the landing page's
                          paste-a-replay-link box; a publish that left a game ONE-SIDED, which
                          announces its own re-simulation (ReplayIndex.upsert -> jobAnnounce);
                          and, when nothing is pending, one game the WORKER queues on the spot
                          out of the games mirror (ReplayIndex.jobsOffer). All three are in the
                          queue, on a row, before any engine starts.
                          It used to have a second half, a CATALOG SCAN: list every replay, keep
                          the rows whose current upload is one-sided with no full-view revision
                          beside it, re-simulate each. That searched for exactly the games the
                          publish now announces — the same work, found by asking a question of
                          every catalog row on a timer instead of being told once by the event
                          that changes the answer. It was both expensive (the listing alone cost
                          the worker's DO millions of row reads a day; see ROW BUDGET under
                          worker/) and blind: until a daemon happened to look, nothing in the
                          queue said the work existed. With it gone the daemon keeps no
                          in-process state at all — no failed-game memory, nothing to forget on
                          restart. Each job is CLAIMED (POST
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
                          processing forever. It also beats once as the job STARTS and once
                          more, inside stop, as it ENDS (FogOfWar's app jobs the same), so a run
                          shorter than one interval still charts two points.
                          Every job re-simulates the demo headlessly via internal/resim (the
                          cmd/barreplay pipeline packaged as one call: demo download -> provision
                          -> widget inject -> engine run -> .brp) and publishes the full-view
                          capture as another revision of the same game — which is also what
                          retires it: the row's uploads list gains an ally-null entry, so the
                          publish-time predicate stops being true and nothing queues it again.
                          A FAILED re-sim records the failure on its own row and leaves the
                          queue; retrying it means asking again, by pasting the link (refused
                          while the game is in the catalog — for those, POST /api/jobs is the
                          door) or by publishing another upload of the game.
                          The three feeders cannot produce the same job twice: a pasted
                          request is refused while its game is in the catalog, an announce
                          dedupes on an active job for the game, and the mirror backfill takes
                          only games with no catalog row AND no job row of any state. Upload jobs
                          are untouched (run a plain bringest alongside, on any host, with no
                          engine).
                          Both loops share one workerAPI (the JSON helper, the bearer token, the
                          job transitions), which is why -resim needs $REPLAY_PUT_TOKEN: the job
                          routes are guarded. No new configuration in practice — packer already
                          reads that same var for the catalog PUT.
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
                          -patched-engine (DEFAULT ON, -resim only) prefers a locally
                          built PATCHED engine for the replay's version:
                          `spring-headless-patched` sitting BESIDE the stock binary in
                          <data>/engine/<version>/ (engine.Config.PatchedEngine, resolved
                          by engine.Locate). Those are the byte-identical patches in
                          patches/engine-<version>/ — a re-sim on one produces the SAME
                          .brp, faster (measured 200 -> 248 fps on a 16-player 13-minute
                          game) and in ~1.5 GB less memory (RESULTS.md and MEMORY.md have
                          the two axes), which is why preferring it can be the default and
                          why the capture cannot record which build made it. From revision 5
                          (2026.7.4-barreplay.5) the series also carries the whole speed work
                          (patches/engine-<ver>/speed/, docs/engine-speed-plan.md), its switch
                          words defaulting to the work's final setting (speed/0161;
                          $BARREPLAY_TOGGLES/2/3 still override, 0 = off), built with the sync
                          checker compiled out — so a re-sim on it ALWAYS reports 0 desyncs (see
                          SummarizeInfolog) and the publish gate is the check — and for generic
                          x86-64 like the release (docs/building-recoil.md "Revision 5"). It lives beside the
                          stock binary rather than in its own <version>-patched dir because
                          the engine resolves base/springcontent.sdz relative to its own
                          executable, so a separate dir would duplicate the whole base/ +
                          fonts payload per version. The lookup is STRICTLY that one path:
                          findBinary's usual wildcard-then-$PATH search would hand back
                          ANOTHER version's patched binary whenever this version has none,
                          and since a version mismatch Locate did not choose is a hard
                          error, one patched build on the host would then fail every job
                          for every other version. A host that has none DOWNLOADS the
                          published one (engine.EnsurePatchedEngine, internal/engine/
                          patcheddl.go, run by internal/resim right after EnsureEngine):
                          building takes ~35 min in the pinned image and must be gated, so
                          ONE gated build per version is uploaded by cmd/publish-engine to
                          engines/<version>/spring-headless-patched-<semver>.gz and its
                          SHA-256 pinned in patchedBuilds. The SEMVER (patchrev.go
                          PatchedVersion) is the engine version without leading zeros plus
                          -barreplay.<N>, N the revision of patches/engine-<version>/series: a
                          digest of the series file and every patch it lists, pinned in
                          patchSeries, and TestPatchSeriesIsPinned fails when they change
                          until the new digest is appended — so a name says exactly which
                          patches went in. A pre-release, not +build metadata, which semver
                          ignores when ordering. One name, one binary: the PUT is
                          conditional and a different binary under a taken name is refused.
                          The source commit is tagged patched-engine/<semver> (never
                          v<semver>: the Go module proxy would read that as a version of
                          this module); publish-engine prints the tag command. THE PIN IN THE REPO IS THE TRUST ANCHOR,
                          not the bucket: a download that does not hash to it is refused
                          and never reaches the path Locate prefers (temp file + rename),
                          and a pin is added only for a binary that passed the gate, so
                          the table is also the record of what was verified. Any other
                          patched binary already on the host — an EARLIER published build
                          (PatchedBuild.Superseded, which only lets the log say which) or
                          one made locally — is REPLACED with the pinned build, so every
                          host runs the latest gated one (Marcin's call: update by default).
                          -keep-patched-engine (engine.Config.KeepPatchedEngine) keeps it
                          instead, e.g. while testing a fresh local build before its pin
                          lands — without it the daemon would swap that build back for
                          the older pinned one.
                          Missing is a WARNING, not a failure — only versions somebody
                          has patched, gated and published have a build, so a daemon
                          routinely meets versions nobody has patched and must still run
                          them at stock speed; a failed download warns the same way. An
                          explicit -engine wins over the preference (the operator named a
                          binary). The chosen build is logged once and recorded on the job
                          row as jobStats.enginePatched, since timings from a patched and a
                          stock host are not comparable and the capture is silent by
                          design.
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
                          engine.SummarizeInfolog's read of infolog.txt. EVERY job also records
                          WHAT made it (buildinfo.go): the bringest binary's git sha, dirty flag,
                          commit time and BUILD time (the toolchain's vcs stamp on `go build`; `git`
                          in the working dir under `go run`, which stamps nothing; the executable's
                          mtime as the build time; -ldflags -X main.buildSha/buildTime override),
                          the widget build (the stream's own for an upload, the EMBEDDED widget's
                          version for a re-sim, whose capture names none) and the .brp container
                          version — and WHERE (hostinfo.go, read once at startup): hostname, total
                          RAM (/proc/meminfo MemTotal), physical cores (distinct physical/core id
                          pairs in /proc/cpuinfo, omitted when it names no topology), logical
                          threads and the CPU model, shown in the queue row's details panel (Host,
                          Host RAM in GiB, Host CPU) — a re-sim's timings and its OOM failures mean
                          nothing without the box. A re-sim's healthcheck also carries elapsedSec, which the queue
                          page adds to etaSec for the Took cell's estimated total. The size report rides
                          along as text, with the daemon's TEMP PATH rewritten to the basename
                          first — it is gone by the time anyone reads the page and is nobody
                          else's business. Reported on FAILURE too: resim.Run fills its
                          Options.Stats in AS IT GOES precisely so a run that dies at minute
                          forty still says how far it got and what its log said. The catalog-scan
                          half has no job row, so its stats go only to the log.
                          An IDLE -resim daemon says so: one "nothing queued to re-simulate"
                          when the queue first comes up empty, then a reminder every
                          idleNoteEvery=10min carrying how long it has been. A process
                          printing nothing is indistinguishable from a wedged one, and the
                          empty answer covers every reason at once (no unpublished games left
                          in the mirror, a backfill resting, another host holding the work) —
                          the daemon cannot tell them apart, and they all mean the engine is
                          not being used. A line per 10s poll would bury everything else in
                          the log.
                          -progress (DEFAULT ON) prints cmd/barreplay's frame/ETA line during a
                          re-sim; -log (default ./bringest.log) APPENDS everything printed to a
                          file as well as stderr (log.go). The tee swaps os.Stderr for a pipe
                          rather than
                          threading a writer around, so it also captures what internal/resim and
                          internal/packer print; main is os.Exit(run()) so the deferred flush
                          runs on every exit path, and loadEnvFile RETURNS its lines (it must run
                          before the flags that name the log file) so they land in it too.
                          Every line in the FILE is prefixed with an RFC3339 local timestamp
                          (stampWriter) — and only the file: the terminal is a live view, where
                          the clock is redundant and 25 columns in front of every progress line
                          are not, while the file is what gets read months later, when "how long
                          did that take" has no other source. It was not always so: the
                          simWallShare curve behind the ETA (see internal/engine) had to be
                          measured off a log with no times in it at all, by leaning on
                          -progress's fixed 2s tick to reconstruct one — which works only for
                          runs of an unbroken progress line and tells you nothing about the
                          minutes around them. Stamping cannot be line-at-a-time: what comes off
                          the pipe is whatever chunk the reader got, splitting and joining lines
                          arbitrarily, so stampWriter tracks whether it is mid-line and stamps at
                          each line's START — which is also the more useful reading (when the run
                          reported, not when the next one did). Nothing is held back waiting for
                          a newline, so a process dying mid-print still leaves its half line.
cmd/fogofwar/             FogOfWar.exe: a Windows desktop app that re-simulates ONE pasted game
                          (link or id) on the user's own PC and writes <gameId>.brp — internal/
                          resim.Run, the same call bringest -resim makes. Each finished .brp is
                          UPLOADED (upload.go: the open POST /api/upload, then GET /api/jobs/<id>
                          until plain bringest has published it; the history row says queued/
                          published/failed, and a failed upload never fails the run). An
                          AUTO-REPLAY switch (autoreplay.go) re-simulates, while idle, the first
                          of the site's 10 newest games (GET /api/games?limit=10) that is not
                          MODDED (no "mods" settings flag; unknown settings count as modded —
                          Marcin's call), not published, has no pending/processing job and is not in the local
                          history (failed ones included), looking again a minute later when none
                          qualifies; Stop on an auto-picked run turns it off, three failures in a
                          row pause it 10 min. The run screen lists the finished replays under the running game as tiles (app.js renderDone), so an auto-replay session shows what it has done. History rows and tiles open /replays/<gameId> in the browser
                          (FOGOFWAR_SITE overrides the site). Wherever a game is shown (preview,
                          run banner, result, history) it carries its LOBBY NAME (the site's GET
                          /api/games?id=, absent when the mirror never matched a lobby) and its
                          settings TAGS (preview.go gameTags: viz.SettingsFlags over the BAR
                          API's gameSettings, badged like app.js settingsBadges). It takes no jobs from the queue,
                          but every run IS one (report.go): an "app" job created over the open POST /api/app/jobs
                          when the run starts, healthchecked every 10 s with bringest's JobProgress (so the queue
                          page charts it), and ended with done/error and a jobStats that mirrors bringest's
                          (RunStats, size report, widget/.brp version, patched build) plus app {version, installId,
                          auto, settings, runs}, phases (wall time per phase, downloads included), peak engine
                          RSS/swap, uploadJob, and host {RAM, cores, CPU model, Windows name + build, free RAM and
                          disk at start} — NO hostname (a volunteer's PC name is theirs). Best-effort: a site it
                          cannot reach never costs a run. INSTALL ID: a UUIDv7 made on first launch (config.json
                          installId), on every app job and on the .brp upload (/api/upload?install=&app=). Its OWN Go module (go.mod with a replace onto the
                          repo root) because it needs third-party code the root keeps out: Wails
                          v2 (the window is a WebView2 page; frontend/dist is plain HTML/CSS/JS,
                          embedded, no Node, no build step — opened in a browser it runs a MOCK
                          backend, ?mock=setup|ready|running|done|fail, which is how it is
                          developed and screenshotted) and bodgit/sevenzip (Windows has no 7z for
                          the engine release; wired in through engine.Extract7z). app.go's
                          exported methods are the page's whole API, kept narrow (no paths or
                          commands from the page; OpenReplay only opens the site's /replays/<gameId> for a valid game id).
                          DISK LIMIT (config diskLimitGB, default 10, a settings slider): before each
                          run engine.PruneDataDir (internal/engine/prune.go) deletes leftovers (unfinished
                          packages, abandoned widget streams, pool files no package lists) and then the
                          least recently USED demos, game packages (+ their now-unreferenced pool files),
                          maps and engine versions until the data dir fits, always keeping the newest of
                          each kind and the setup's engine. EnsureContent/EnsureEngine touch what a run
                          uses, so mtime is last use. Nothing bounded it before: a volunteer's folder
                          reached 45 GB and pr-downloader then refused the next game for want of 1 GiB.
                          The replays folder keeps only the newest 50 <gameId>.brp files (replays.go
                          pruneReplays, after each run; nothing else in a user-picked folder is touched).
                          TRAY (tray.go, tray_windows.go over energye/systray on its own locked thread):
                          an icon in the notification area; minimising (the page's button, or any other way,
                          caught by the pump polling WindowIsMinimised) HIDES the window and its taskbar
                          button, a click on the icon (or its menu's Open) brings it back, and closing
                          always asks (the page's dialog, the tray menu's Quit, beforeClose for Alt+F4).
                          With no icon up nothing is ever hidden, so the window cannot become unreachable.
                          HOW A RUN ENDED (session.go): a Go crash goes into fogofwar.log with its stack
                          (logtee.go crashToLog, debug.SetCrashOutput; a windowed app has no stderr), a
                          hidden top-level window (session_windows.go) logs WM_QUERYENDSESSION/
                          WM_ENDSESSION (shutdown, sign-out, Restart Manager), Wails's OnSuspend/OnResume
                          log sleep, and session.json is rewritten every minute with what the app is doing,
                          plus the close reason; at the next start an unclosed record is logged with whether
                          Windows booted since (restart/power loss) or not (killed from outside).
                          ONE FOLDER (Marcin's call, 0.2.20): the FogOfWar folder (Config.Home,
                          the one setting for where things go; by default the folder FogOfWar.exe
                          is in when writable and not a temp dir, else %LOCALAPPDATA%\FogOfWar)
                          holds settings.json (faster-engine toggle, memory floor, disk limit,
                          install id, history), session.json, fogofwar.log, webview\, work\,
                          data\ (engine, game, maps; the engine's write dir) and replays\. No
                          admin rights: %LOCALAPPDATA%\FogOfWar (FOGOFWAR_HOME overrides) holds
                          only config.json, {"home": ...}. Older layouts (0.2.19's dataDir/
                          outputDir with <data>\fogofwar\, and before it everything in
                          config.json) load and are moved in on start (loadConfig's old layout,
                          relocate: renames, so the data folder moves for free on one drive and
                          downloads again across drives; replays are copied). Changing the
                          folder in settings moves everything the same way (App.moveTo); the
                          WebView2 data, held open, goes at the next start (config.json's
                          "previous"). fogofwar.log (every line the
                          pipeline prints: logtee.go swaps os.Stderr for a pipe, which also feeds
                          pr-downloader's "[Progress] N%" into the download bars). FIRST LAUNCH
                          (setup.go) downloads the engine, the published patched build and the
                          game that the newest game on api.bar-rts.com needs, then waits. The
                          engine runs with --only-local (engine.Config.OnlyLocal: no listening
                          socket, so no firewall prompt), CREATE_NO_WINDOW and below-normal
                          priority (engine/platform_windows.go hideChild), and the app puts
                          itself in a kill-on-close job object so a killed window takes its
                          engine with it. Windows ports in internal/engine: platform_windows.go
                          (GlobalMemoryStatusEx for the memory guard and MemTotal,
                          GetProcessTimes/K32GetProcessMemoryInfo for the engine's RSS/CPU),
                          DownloadProgress (byte counts for any engine download), and the
                          Windows patched build: PatchedBuildKey's engines/<v>/windows-amd64/
                          spring-headless-patched-<semver>.exe.gz, pinned in
                          patchedBuildsWindows (2026.07.04 rev 5 pinned; a version with no pin
                          runs stock on Windows).
cmd/publish-engine/main.go CLI: publish a patched engine build for every re-sim host to
                          download (see the -patched-engine note above), the WHOLE job in one
                          command: name it (engine version from its --version, revision from
                          ./patches — an unpinned series is refused), re-simulate the
                          version's gate replay (gateReplays; -gate overrides) on the STOCK
                          engine, `strip --strip-debug` a copy into the engine dir (the
                          engine finds base/ relative to itself), re-simulate the replay on
                          THAT copy — the exact file the pin vouches for — and require
                          byte-identical .brp files, then PutIfAbsent a gzip to
                          engines/<version>/spring-headless-patched-<semver>.gz (native R2
                          credentials only; ./.env is read; an existing object must hold the
                          same binary) and print the patchedBuilds line and the
                          patched-engine/<semver> tag. The gate compares stock vs patched
                          under THIS checkout rather than against fixed md5s, which go stale
                          whenever the widget or codec changes the capture. A failed gate
                          keeps both captures. Run from the repo root; it takes the data
                          dir's lock, so a bringest -resim on the same -data must be idle.
                          -windows publishes the WINDOWS build of the series instead
                          (windows.go; built by patches/engine-<ver>/windows/build.sh in
                          Recoil's pinned MinGW image, plus windows/windows-series fixes):
                          it installs the stock Windows release beside the native one
                          (engine.EnsureWindowsEngine, <data>/engine/<ver>-windows-amd64),
                          strips the exe into it and gates it UNDER WINE against the stock
                          LINUX engine — byte-identical across platforms, the claim the
                          volunteer pool rests on — through a wrapper that rewrites absolute
                          unix paths to Z: (a bare /tmp/x write-dir makes the Windows build's
                          archive scan find nothing). No PGO (the profile is Linux GCC data).
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
                          ORDERS (orders.go -> Demo.SelfD): the stream is the input log, so
                          SELF-DESTRUCT orders are read from it too — NETMSG_SELECT tracks
                          each player's selection, NETMSG_COMMAND applies to it, AICOMMAND/
                          _TRACKED/AICOMMANDS name units directly (layouts from Recoil's
                          BaseNetProtocol.cpp/NetCommands.cpp; verified on a 2026.07.04 demo
                          whose commander self-destructs at f2416 and dies at f2580). They
                          join the capture as "selfd" EVENTS (Demo.SelfDEvents; capture.
                          AddEvents for the streaming re-sim, snapshot.MergeEvents in pack) —
                          a new kind in the string table, no format change — and `pack
                          -upload` of an already-packed .brp adds them in place
                          (packer.AddDemoOrders -> snapshot.AddEventsBRP: only E and the
                          meta change, no re-simulation; a file that has them is left alone).
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
                          SimETA (simeta.go) turns that stream of frame readings into the two
                          numbers a person watching a re-sim wants, and is shared by
                          WatchProgress (which prints them) and internal/resim's watcher (which
                          reports them to a job), so the log and the queue page cannot disagree.
                          Both are harder than they look because a sim frame is NOT a fixed
                          amount of work: measured over 29 completed re-sims, the last third of
                          a game's frames processes at a median of 0.29x the rate of the first
                          third, since the thing being simulated grows. So remaining/rate — the
                          obvious ETA, and what this used to do — announces "ETA 03:49" four
                          minutes into a 55-minute run: over the first tenth of a game it
                          predicted a MEDIAN of 0.23x the true time left, over the last tenth
                          2.8x, and it landed within 2x of the truth only 37% of the time.
                          The fix is the simWallShare curve: the share of a re-simulation's
                          total wall time already spent by the time it reaches a given fraction
                          of the demo's frames (the headline entry — half the FRAMES are done
                          after 30% of the TIME), median-averaged over those 29 runs and
                          interpolated between 5% steps. ETA = elapsed x (work ahead) / (work
                          done), which divides the curve out against the run's OWN elapsed time
                          — so a host of any speed and a demo of any length calibrate themselves
                          after a couple of minutes, which is why ONE table covers everything
                          (the shape correlates with neither game length, r=+0.27, nor host
                          speed, r=-0.09). Leave-one-out over the 29: a median error of 27% and
                          96% of readings within 2x, with no bias at any point in a run.
                          The RATE is a plain average over a 60-second trailing window rather
                          than an exponential average of consecutive readings, because the
                          engine only logs one frame in 300: at a late-game 10 fps the infolog
                          moves every ~30s, so consecutive readings are 0, 0, 0, 0, 0, 60 and
                          the old average swung +-40% every tick. The window predicts the rate
                          the next minute actually runs at to within 37% where the old one was
                          off by 150%. A frame going BACKWARDS restarts the estimator: the
                          infolog is per data dir, so a fresh run reads the tail of the previous
                          one's until the engine truncates it, and that stale frame would
                          otherwise be credited as work already done. Nothing is reported until
                          there is something to say — no rate under 10s of history, no ETA under
                          30s of run — since the log's own granularity dominates before that.
                          SummarizeInfolog (infolog.go) reduces a finished run's infolog.txt to
                          size/lines/last frame plus DESYNC and warning counts — substring
                          heuristics, not a parse of a grammar the engine promises, and the
                          desync count is the point: a re-simulation that desynced describes a
                          game that never happened and is indistinguishable from a good capture
                          on disk. Except on a patched build from revision 5 on, which compiles
                          the sync checker out and so has nothing to compare: its 0 says nothing. Best-effort like everything reading the engine's leavings —
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
                          lives: engine.LastLoggedFrame for the sim frame, fed to an
                          engine.SimETA for the percentage, the rate and the time remaining (see
                          the internal/engine entry — the ETA is NOT remaining frames over the
                          current rate, which reads "nearly done" through the whole first half
                          of a run), and engine.SampleProcess for the engine's RSS and CPU.
                          Before the engine has simulated a frame there is nothing to measure,
                          and that is the first 20s of every job (median over 29 phase-stamped
                          runs; p90 30s) — a tenth of a median job and most of a short one, in
                          which the row could only say "loading". Options.Forecaster
                          (forecast.go) fills it: a guess at the whole run's length from the one
                          fact known before any work happens, the demo's duration, which
                          barapi.Resolve returns BEFORE the download so the ETA is there from
                          the job's first beat. Progress reports what is LEFT of it, counting
                          down with the clock across the fetch/provision/load phases, and
                          RETIRES it for good the moment the simulation reports (Progress.
                          measured) — a forecast that outlived its measurement would reappear
                          as the packing's ETA, and a run that beat its forecast would claim
                          minutes of work it had finished; an expired one goes quiet rather
                          than sitting at "0s left". It is a GUESS and is much rougher than
                          what replaces it: sim time grows as roughly the SQUARE of game time
                          (same reason as the cost curve — each frame costs more than the last),
                          but a 20-minute game can be a duel or a 16-player slugfest and the
                          demo's length does not say which, so even fitted to one host the
                          median error is 24-43%. Worth showing anyway, because it answers "is
                          this three minutes or an hour", which a blank cell cannot. THE SCALE
                          IS PER-HOST, which is why the Forecaster LEARNS rather than shipping
                          a constant: the exponent is a property of BAR, the multiplier in front
                          of it is a property of the machine, and the two hosts measured here
                          differ by 3x — enough that one's constant is out by a factor of two on
                          the other. Each finished run is Observed (outside the Stats block, so
                          a run that fails on the way out still teaches what it spent) and the
                          scale is the median of the last 20, which converges in a handful of
                          jobs. A restart forgets it — the first job after one uses the shipped
                          default and every job after that is calibrated, which beats a state
                          file whose staleness nobody would notice. cmd/bringest holds ONE
                          across the whole daemon (ro is copied per job, the pointer is shared);
                          a nil one is inert and simply means no ETA until the engine simulates. A phase change
                          clears the sim numbers (they described the phase that ended) but keeps
                          the process reading (the process did not).
                          Options.MinFreeBytes is the MEMORY GUARD (0 = engine.
                          DefaultMinFreeBytes, negative = off): the engine runs under a context
                          of Run's own so engine.WatchMemory can end it when the HOST drops below
                          the floor — see "Running out of memory" below for why stopping first
                          matters. The reading is kept in a memGuard (first one wins: by the time
                          the engine has died the host may have recovered, and a healthier number
                          would describe the recovery rather than the decision) and its error
                          BEATS every other explanation Run can give, deliberately: we sent that
                          signal, so "the engine was killed" and whatever the truncated stream
                          then failed to parse into are both true and both useless.
internal/insights/        the GAME SUMMARY's data: Compute reduces a replay (Input — a parsed .brp
                          via FromBRP, or a replay rebuilt from its published pieces) to the
                          Insights file stored beside each revision as
                          replays/<rid>.insights<Version>.json. One pass over the frames with the
                          events interleaved at their frames: per-side army value (the team
                          stats bar's rule: armed, mobile, priced, not a commander, weighted by
                          build progress) and income every StepSec, army split by category (no
                          tech level exists in the defs, so ground units split by PRICE:
                          <250/<800/<3000 metal, and anything at 3000+ is experimental, flying
                          or not — v5), every
                          death with its last sampled position and cost, tech milestones from a
                          CURATED def-name table (defs.go — the defs carry no tier), chat and
                          pings. A piece is immutable, so ANY change to what is computed is a
                          new Version written beside the old one. Comparative sections need a
                          full-view capture (POV) and two sides; CostCoverage says when only
                          armed mobile defs are priced (a replay rebuilt from old pieces).
                          SIDES are ally teams with a human player OR an AI (insights.go
                          aiTeams: a team with a faction and no human — eight BARbs are an
                          8v8's other half, named "AI 1".."AI 8"); Gaia (no faction) and a
                          scavenger/raptor team (>= half its units _scav/raptor defs) are not.
                          stories.go adds what NO capture can attribute to a killer and so never
                          tries: each side's army centre per step (Series.Front), battles and
                          six awards picked from per-unit tracks (ids are recycled, so a new def
                          or a reappearance after death is a new life) — ties to the earlier
                          unit, one unit never takes two. BATTLES (Version 3) are PEAKS of
                          killing, not clusters: the densest 1500-elmo, 30 s box of lost metal
                          — divided by both armies' value at the time, or every battle lands in
                          the last twenty minutes, where everything costs more — grown while
                          the rate nearby stays >= a fifth of the peak (one quiet 10 s bin
                          bridged, at most 5 min), its deaths removed, repeated up to 24 (battleMaxN; 12 cut a
                          real game's 34-minute air battle, 16 an 8-minute bomber fight); a
                          peak abutting a battle already found joins it. The old rule (deaths
                          chained within 1500 elmos and 45 s of quiet) chained a whole late
                          game into ONE "battle" (10:00-55:47 on a real 8v8). A battle that starts within 60 s of
                          another's end, near it, where >= 30% of the metal killed in either
                          was killed by the same (team, def) of killer is the SAME FORCE
                          PUSHING ON and joins it (stories.go mergeAdvances; captures with
                          causes only). ELIMINATIONS
                          (wipes.go, Insights.Eliminated) come from a v6 capture's teamdied
                          facts (Input.TeamDied; nil = no facts section), else are inferred: a
                          team's LAST burst of deaths (gaps <= 1 s, >= 8) with no live unit of
                          it seen after. Deaths at or after a team's elimination are WIPED —
                          units blown up by a player leaving, not fought for — and battles,
                          the costliest/unfinished awards and the page's moment stories skip
                          them; the page draws them faint on its losses chart. A player who
                          HANDS their units over and leaves (a burst of >= 8 "given" events,
                          nothing owned after) is out too, with Elimination.To naming the
                          recipient (withHandoffs; v7): the engine destroys nothing and records
                          no teamdied, so neither rule above sees it. The page says "X leaves,
                          handing their units to Y". A player who RESIGNS is recorded dead
                          (teamdied) and THEN has their units shared out: a give burst within
                          handoffNear = 60 s of a recorded elimination gives it the same To. A
                          handoff is never a swing's story (the army stayed on the board,
                          losses.ts Knockout.handoff); the story says "Meanwhile X leaves...".
                          THE SUMMARY ENDS WHERE THE GAME WAS DECIDED (gameend.go): once every
                          side but one is out (a resign vote, or the last commanders dying),
                          Compute cuts the input at the start of the run of eliminations that
                          emptied the last side to go (teams of one side out within 10 s of
                          its LAST elimination count as one surrender — measured from the
                          last, never chained, since in a final push teams fall one after
                          another and chaining them ended a real 8v8 a minute before its
                          resign; v7) and computes everything up to there — the engine then
                          blows up the losing side's whole army, which dwarfed every real loss
                          on every chart. Recorded teamdied facts give the cut up front; an
                          inferred one costs a first pass over the whole game (whose
                          eliminations are kept, since the cut input lost the bursts they were
                          read from). One player leaving mid-game ends nothing; an FFA runs on
                          until one side is left. Clips still play past the end.
                          players.go is the per-player report (Insights.Players, full view
                          only): built/lost/chat per step, the commander's path + death +
                          first contact (a 900-elmo grid shared with an enemy), leaks and a
                          play style card. Two leaks are easy to get wrong: FLOATING counts
                          only while the WHOLE SIDE sits at >=98% metal storage (overflow is
                          shared with allies, so one full player is not waste), and "not
                          building" needs build targets, which a v4 capture lacks (null, not
                          0 — Input.HasTargets). The commander path FOLLOWS ONE unit
                          (followCommander: the one followed last sample while it is there,
                          else the one nearest where the path left off) — a team holding a
                          teammate's commander after they left is routine, and taking the
                          first commander in the frame zigzagged between the two.
                          WriteStaticBundle writes the insights piece
                          beside the .brp on EVERY publish (a compute failure only warns), so
                          a publish uploads exactly two objects.
                          VERSION 5 marks SELF-DESTRUCTS (Deaths.SelfD, pass.go selfDestructed):
                          a death with the owner's "selfd" order standing (the engine toggles,
                          so a second order cancels; at most selfdMaxSec = 60 s before) and no
                          other unit named as its cause. It is a loss only when the unit WENT IN
                          A FIGHT (pass.go fought): its blast killed something within blastSec =
                          3 s (credited to it in a capture with causes — an enemy, or its own
                          side's buildings, both worth telling), or it was hurt in the last
                          fightSec = 20 s. Otherwise its owner cashed it in (a commander blown
                          up for its metal) and it is an owner removal like a reclaim (Marcin's
                          rule). A counted one reads "self-destructs their commander" on the
                          page rather than "falls". A .brp packed before the demo's orders were
                          read has no selfd events, so cmd/insights reads them from the demo
                          when the input has none (packer.DemoSelfD; best-effort like the
                          winners; the orders are kept in -cache as demo-orders/<gameId>.json).
                          VERSION 4 stops counting what an owner REMOVED as a loss (pass.go
                          removedByOwner, only when the capture records causes): a unit
                          reclaimed by its own side (cause weapon -12, the engine's reclaim id)
                          and a STRUCTURE destroyed with no cause at all (a mex/geo upgrade, a
                          cancelled build, a self-destruct) or ANY UNFINISHED unit destroyed
                          with no cause (a cancelled build in a lab; a finished mobile one
                          with no cause is a crash, still a loss — a cancelled build refunds
                          its metal). An unfinished unit that IS lost is priced at the share of
                          it BUILT (pass.go lossCost: its last sampled build progress; one
                          never sampled is worth 0) everywhere a loss is counted, and
                          "Unfinished business" goes only to a BUILDING destroyed unfinished
                          — wind farms reclaimed for
                          space used to read as a lost fight. An EVOLUTION is never a loss in any
                          capture (evolve.go): BAR's evolving commanders are swapped at once
                          (a new unit created AND finished in one frame, the old one destroyed
                          with no cause, same team, same frame), so each such instant spawn
                          takes one causeless death of its team in that frame — that death is
                          no loss and the spawn is not "built". A real 8v8 evolved all 16
                          commanders at 10:00 and read as "8 commanders fall". It adds Series.Value (everything a side
                          owns, priced and weighted by build progress — the denominator of the
                          page's loss SHARE, since a 15 s loss of 5k metal is a disaster at
                          minute 3 and noise at minute 40) and Battle.Teams (per team: metal
                          lost in the battle and the peak army within the battle's radius +
                          600 elmos, from one presence sample per step, plus KILLED: the enemy
                          metal the engine credited to the team there WHEREVER IT FIRED FROM,
                          so a long-range gun or a nuke from across the map is in the fight it
                          hit — zero in captures that name no killers), from which the page
                          names the players carrying a fight (moments.ts fighters: >= 10% of
                          their side's army + lost + killed there).
                          Version 4 also lets every award SAY WHICH UNIT it is: Award.Unit
                          (the id), F0/F1 (its life) and Path ([frame, x, z] every 5 s, at
                          most 400) — a card draws the route, and its clip FOLLOWS the unit
                          (Clip.follow / Clip.path: app.js followClipUnit keeps the camera on
                          it, drawClipRing pulses a ring round it, drawClipPath draws where it
                          has been bright and where it is going faint). Marathon and Tourist
                          play the whole life (clip speeds up to 64x), the losses their last
                          20 s. IMMORTAL is a unit that FELL to <= 30% health and AFTER that
                          was credited (destroyed-event causes) with enemies worth >= 3x its
                          own cost and >= 1500 metal, and lived — surviving damage is what most
                          of an army does; no causes, no Immortal, and most games have none.
                          CLOSE CALL skips units under closeCallCost = 400 metal (commanders
                          always count). MOST HEALED (key "healed") is the army unit of >= 400
                          metal that regained the most hp between samples while finished (a
                          floor), if >= its own health. UNIT MENTIONS carry their strategic
                          icon: names.ts named() puts unitRef (icon + name) before every unit
                          name in a sentence, and award cards lead with it; tooltips and clip
                          titles stay text.
                          BIGGEST BLOW (stories.go biggestBlow) replaced "Most expensive loss":
                          the most metal ONE PLAYER lost within 30 s (blowWindow; wiped deaths
                          and owner removals excluded) — a base going up — rather than the
                          single costliest unit, which in a big game is one of dozens of
                          identical Juggernauts. Its F is the window's costliest death (where
                          the card's map dot and the clip zoom), F0/F1 the window; the clip
                          plays the window (clipEvent).
                          GROUNDED FLEET (transports.go, key "idle"): a player's air transports
                          of one def that never carried a unit — >= idleMin = 5 and >= 75% of
                          those they built (a factory left repeating its last order). The defs
                          carry no transport flag, so transportRE is a curated name table; a
                          carry is read off positions (carryFrame: a same-team ground unit
                          within 32 elmos in two consecutive samples while the transport moved
                          >= 64). Unit/Path are the last one built, F0/F1 the build span.
                          OWN BLASTS AND FRIENDLY FIRE (friendly.go; captures with causes only):
                          the engine credits a dying unit's explosion (a chain of fusions) to
                          the exploding unit or to nobody, exactly like a weapon kill. A
                          battle's BattleLoss.Own is the metal of a side's losses its OWN side
                          destroyed (ownFire: killer on the same side, or an explosion with no
                          killer named), OwnDef the def that did most of it, Trigger the enemy
                          (team, def) whose kill came at most 5 s before the first of them. When
                          Own is >= 50% and >= 1000 metal of the side that lost more, nobody
                          "wins" the battle (moments.ts ownBlast): it reads "Blue
                          Advanced Fusion Reactors blow up, set off by [MANTA]'s Basilica" in
                          the swing list, the battle tooltip and a swing story, with no
                          "ahead" box. FRIENDLY FIRE (key "friendly") is the LIVING unit (it
                          did not die within 3 s: that would be its blast) that destroyed the
                          most metal of ANOTHER team of its side within 10 s, at least 2000;
                          Award.Pos is where its costliest victim stood.
                          Merged battles (the abutting-peak rule and mergeAdvances) are capped
                          at battleAdvanceMax = 8 min and mergeAdvances at a 3000-elmo radius:
                          chained merges grew one 8v8's centre into a 27-minute "battle".
                          A swing story that counts losses over its whole window (an
                          elimination, a commander's death, one big loss) carries that span
                          as its focus (deathSpan), so the clip marks a band, not an instant.
                          POWER PLANTS COUNT 2.5x (defs.go powerWorth, isPowerPlant: wind,
                          tidal, solar, fusion, geo by name; storage shares their UnitGroup)
                          WHEREVER A BATTLE'S WINNER IS DECIDED — losing a fusion loses its
                          output too (Marcin's rule). VERSION 10 counts every OTHER lost
                          building at 2x too (defs.go buildingWorth; a building has to be
                          rebuilt just to stand where its side stood), but only in a capture
                          that names killers: without them a reclaim or an upgrade reads as a
                          loss. Measured on 2,271 battles of 164 re-sims, 2x moved 6% of the
                          verdicts and 68% of those named the eventual winner; 3x overshot
                          (experiments/buildingworth). BattleLoss.Worth carries it, Def.Worth
                          (v10; before it Def.Power) gives the page's own tallies the per-def
                          figure (model.ts defWorth, moments.ts SideLoss.worth),
                          and every verdict — gapBattles' decisive/win/even, a fight story's
                          "wins"/"trades", the Battles list's "ahead" box — compares worth,
                          while every number SHOWN stays plain metal (model.ts lossWorth).
                          swing.go (Version 2) adds the WINNER (Insights.Winner, a side index
                          from Meta.Winners, -1 unknown) and the SWING line: P(side 0 wins)
                          per step from a logistic model (WinModel) over three antisymmetric
                          features — log ratios of army value, last-minute metal income and
                          cumulative income — so an even game is 50% by construction and
                          the model is never told who won. Moments are the biggest shifts
                          over a minute (>=12 points, 2 min apart, at most 6), each window
                          trimmed to where the line actually moved and tied to the battle
                          overlapping it. VERSION 7 splits each moment's move in the model's
                          logit into what carried it (Moment.Army / Moment.Eco, shares toward
                          the gaining side, income = last-minute + cumulative), DROPS EVERY
                          moment starting in the first earlyShare = 30% of the game (both
                          armies and economies still grow from nothing there, so the line
                          swings on who built sooner; the page tells that stretch's decisive
                          battles instead, see gapBattles), and drops a
                          moment starting in the first earlyEcoSec = 4 min (a short game) that income
                          carried (Eco >= 0.5) unless the other side lost an ECONOMY
                          BUILDING in it (defs.go isEcoBuilding: UnitGroup metal/energy, a
                          name pattern for captures without groups) — every opening is two
                          economies growing a few seconds apart. The page (moments.ts
                          growthStory) names in a no-fight story only what carried >= 20% of
                          the shift, says for income whether the losing side's FELL or the
                          other's grew faster, and gives the model's own numbers (last-minute
                          income, metal mined so far); no story says a side "lost nothing". A moment the model says ARMY carried
                          under 20% of (Moment.Army < 0.2) is told this way EVEN WITH A FIGHT in
                          its window (moments.ts builtNotFought) — an even trade that left the
                          armies' balance where it was did not move the line, the incomes did — with
                          the fighting a one-line "Meanwhile" note, no battle badge, and the side
                          that put more into its army instead said so; a fall in income names the
                          mines/converters the side lost in the window.
                          A FIGHT THE GAINING SIDE LOST (lost more worth there) while its
                          army still grew faster than the other's (moments.ts armyGrew) is
                          not why the line moved: it is told as the build-up, titled "...
                          despite losing a fight in the middle", with the fight a "Meanwhile
                          Red won the fight ..." sentence counting only its part INSIDE
                          the moment's window (notableLoss names one unit carrying >= 30% and
                          3000+ metal of it: "including a half-built Epic Pulsar"), and the
                          swing row shows each side's army and income plus "in the fight"
                          losses (MomentStory.lostFight; Marcin, f9c2cb6a's swing A).
                          VERSION 8 says WHAT DID THE KILLING, for the page's BATTLE PHRASES
                          (worker/src/summary/phrases.ts; Marcin's ask: "won battle" every
                          time is boring). Each battle side's BattleLoss.By lists the enemy
                          (team, def) units credited with its losses: deaths, metal, and how
                          many of the killers did it (captures with causes only). Every Def
                          carries a Class (classes.go): bomber/fighter/gunship/air/ship,
                          lrgun, nuke, experimental (mobile, >= 3000 metal), army, commander,
                          defence, factory, eco, building, unit. The air roles, ships, long-
                          range guns and nukes are curated NAME TABLES read off BAR's own icon
                          assignments (icontypes: air_bomber*, air_hover*, ship_*, ...) since
                          the defs carry no role; an unknown def falls to a generic class, so a
                          phrase that needs a role never fires on a guess. battlePhrase fires a
                          rule only when the numbers are sure (the killers of >= 60% of the
                          loss known, the class >= 60% of the metal, the subject the side that
                          lost less), in order: a failed bombing run (the loser lost mostly
                          bombers: "Blue Falcons intercept the Red Thunders" / "... are shot
                          down"), nuke, long-range guns, bombers ("bomb"/"level" a base, 20k+
                          of buildings), air battle, gunships, one experimental def doing half
                          the killing, naval, defences holding (only when the attacker lost
                          1.5x), a swarm (one def under 60 metal, 30+ units), an economy raid,
                          and a factory that was a quarter of the loss. Otherwise marginPhrase
                          rotates its words by battle number, SCALED BY THE FIGHT'S SIZE (the
                          loser's metal; Marcin: a 2.8k-for-628 kill is no "overwhelms"):
                          under 5k a skirmish ("wins a skirmish", "picks off Red units"),
                          5k+ "decisively wins"/"outfights"/"beats", and "overwhelms"/
                          "smashes" only when BOTH 20k+ and a 4x margin hold (Marcin); a 10x loss of 30% of an army and >= 10k
                          "crushes", never "routs" (Marcin's call); "Bloody stalemate" for an
                          even fight that cost both armies 15% and >= 10k each; a swarm
                          "overwhelms" only at 20k+ and 4x. Units are named by the
                          side's COLOUR alone, "Blue Juggernauts" (Marcin's call, also for
                          ownBlastTitle), which nameRuns colours like "Blue team". The phrases
                          title the gap battles in the swing list and a fight swing whose
                          battle is told whole; a phrase never overrides a trade the numbers
                          contradict.
                          Version 10 adds BUILDING rules after the factory one: a loss mostly of
                          defences is "Blue breaks the Red defences" (5k+) or "picks off Red
                          defences", one mostly of other buildings "Blue wrecks / breaks into /
                          raids Ann's base" (20k+ and 4x worth / 5k+ / less).
                          BUILD-UP AND BASE STORIES (moments.ts, version 10; Marcin's ask:
                          insightful, not just "X built more eco"). growthStory names the
                          buildings when Moment.Build >= 0.2 ("out-builds Red in economy and
                          buildings", "on every front", "builds up a bigger base", "Red's base
                          shrinks while Blue out-builds its army") and reads
                          the army with its standing defences when they are >= 10% of it
                          (armyDefences; the title says "defences" only when they moved at least
                          half as much as the armies). Under each side it SHOWS what was built:
                          "built since M:SS" and "lost since M:SS" rows of icons with counts
                          (MomentStory.buildLines, unitchips.ts fillUnits with its verb) for the
                          story's kinds — economy = eco + mex, buildings = eco + mex + other,
                          army = the defences. A BASE GOING UP is a story of its own (baseLoss:
                          the losing side's fought-for building losses >= 1000 metal, >= 15% of
                          what it had standing and >= half of everything it lost in the window):
                          "Red loses 35% of its base in the south-east, mostly its
                          economy", with a "buildings: N lost" icon row under it. It leads
                          (after an elimination, before a commander, who rides along as ", with
                          Ann's commander") when buildings moved the line more than the armies
                          and no one battle holds half of it — that battle's phrase is the
                          better title; otherwise an elimination or commander title gains " as
                          Red loses 24% of its base", and a fight with no battle and no
                          army drop is told as the base. Every story names a side by its
                          COLOUR alone (moments.ts and quips.ts take model.ts sideShort:
                          "Blue loses 43% of its army"; Marcin's call, sides are never "Blue
                          team"), the way the battle phrases always did; sideName's "Blue
                          team" is for labels (legends, column heads). QUIPS (quips.ts): a line of colour
                          under a build-up or base story of a v10 file, on plain facts only (a
                          forest of 15+ wind turbines, 8+ of one defence, a 20-piece wall, 6+
                          converters, a 20k+ building, a first fusion or a nuke silo the other
                          side has no anti for, idle builders, three mines lost, half a base
                          gone), words rotated by the moment's number, at most QUIPS_MAX = 2 a
                          page and no rule twice (fewQuips). names.ts matches a unit's PLURAL
                          too ("41 Wind Turbines" gets its icon and keeps its s).
                          PLACES (places.ts): compass() says "the middle", never "the centre"
                          (Marcin's call), and a map with community area names uses them.
                          Supreme Isthmus has Marcin's labels: each base's air, eco, beach,
                          geo, front and geo sea, named by the colour of the side that STARTED
                          in that half (its first Series.Front point; unknown = compass), so
                          a battle reads "at Blue geo" and a bombed base "Blue geo's base";
                          the middle, north/south sea and north/south island name no side.
                          Points are fractions of the map's own size (24x24 = 12288 elmos),
                          not of Insights.Bounds, which take in aircraft past the edge.
                          WinModel.Coef started as HAND-SET PRIORS
                          (Fitted=false, which the page states); VERSION 6 ships cmd/winfit's
                          fit over 933 games from the 10 days before 2026-10-11; v7 refits it
                          over 1191 games with 25k metal (250 m/s for income) of VIRTUAL METAL
                          added to both sides before every ratio (swingArmyK etc.: the opening's
                          few hundred metal no longer swing the line; Marcin's pick of
                          0.3k/1k/5k/10k/25k tested) — 1.904 army, 4.925 last-minute income,
                          3.988 cumulative income: income carries
                          the line). Per-category fits (winfit -categories) differed mainly
                          in steepness and gained little, so it stays ONE model.
                          VERSION 9 (Marcin's ask: right more often, and every big move of
                          the line something that can be NAMED) adds a fourth feature, the
                          log ratio of metal each side has DESTROYED so far (Killed: the
                          other side's fought-for losses, wiped deaths excluded, any capture)
                          and stretches the income window from 1 to 3 minutes
                          (swingIncomeSteps 12) — 1.597 army, 5.294 income, 4.149 cumulative,
                          1.788 destroyed, over 1217 games. Out of sample (experiments/
                          winmodel, 5 folds) accuracy and log loss are unchanged (77.0%,
                          0.478 — they sit at a ceiling: value, a time-varying model,
                          medians and the players' OpenSkill all added nothing), but the line
                          moves 2.41 -> 1.61 points a step, and of its 12-point moves past the
                          opening 44% -> 66% come with a fight the losing side lost or an
                          elimination (1.71 -> 0.57 unnamed moves a game). The unnamed ones
                          were nearly all last-minute income. Moment.Army counts the
                          destroyed feature as army (fighting moved it).
                          VERSION 10 PUTS THE BUILDINGS IN THE LINE (buildings.go; Marcin's ask,
                          the buildings-vs-units study in experiments/buildingworth +
                          experiments/winmodel, PR #120). Each side's STANDING buildings are
                          measured per step like its army (cost x build progress,
                          Series.Buildings by Series.BuildingCats: defence, eco = power plants,
                          converters and builder structures, mex, other = factories, radar,
                          storage, walls), each def's category riding Def.Stand. buildingCat is
                          the study's rule and the coefficients were fitted on it, so changing
                          it needs a refit; refineCat only moves a def between eco/mex/other by
                          NAME for the page, which the line cannot see (all three are one
                          input). Standing DEFENCES join the army input; the rest are a FIFTH
                          input (swingBuildK = 10k virtual metal); and in a capture that names
                          killers a destroyed building counts killBuildingWorth = 3x in metal
                          destroyed (without killers a reclaim or upgrade reads as destroyed, so
                          plain metal). TWO MODELS (WinModels, Swing.Model): "lava" for
                          lavabalance's lava games (gamecat.LavaTweaks on two sides of eight
                          humans, no AI: modelFor) and "ranked8v8" for EVERY other game
                          (Marcin's call) — fitted apart they beat one model out of sample in
                          every group (log loss lava 0.511 -> 0.463, ranked 0.421 -> 0.408 on
                          Isthmus, 0.449 -> 0.380 elsewhere); coefficients in swing.go's
                          WinModels comment. The lobby's tweaks are NOT in the .brp, so
                          Input.ModOptions comes from the demo (packer passes them through
                          viz.WriteStaticBundleWith) or the BAR API's detail (insightsrun's
                          gameFacts, cached with the winners); unknown means ranked. A replay
                          rebuilt from pieces prices only armed mobile defs, so its buildings
                          are priced and sorted by legacybuildings.json
                          (experiments/buildingworth -table over the study's 166 games); an
                          unknown def counts nothing. Moment.Build is the share of a moment's
                          shift the buildings carried (Army + Eco + Build = 1), and
                          Moment.Built/BuiltFrom are the structures each side FINISHED in the 3
                          minutes up to F1, by def, at most momentBuiltDefs = 8 of each building
                          category — what the page's build-up stories show as icons.
                          WINNERS come from the demo's tail (demofile.Demo.Winners: one byte
                          per winning ally team right after the packet stream, per
                          rts/System/LoadSave/demofile.h) into snapshot.Meta.Winners via
                          BaseMeta, so every demo-backed pack carries them; anything without
                          (older .brps, rebuilt pieces) gets them from the BAR API's
                          AllyTeams[].winningTeam in cmd/insights (barapi.Replay.Winners).
experiments/winmodel/      compares win-model VARIANTS on insights files (any version from 6;
                          pre-7 files cut at the decision like v7 does): out-of-fold accuracy,
                          log loss, jitter, 5-point zigzags, and the share of big moves an
                          event can name. Where Version 9's model came from; add a variant to
                          variants.go to try another idea. With -bw/-defcat (buildingworth's
                          output) it also tries building weights: losses by unit category
                          (killW), standing metal by category added to the army or as its own
                          input; -events prints the calibration gap at minutes a side lost one
                          category (does the line lag a lost base?), -bootcoef N each
                          coefficient's game-bootstrap interval, -games/-score restrict the fit
                          or only the scoring to listed games, and every variant's log loss is
                          compared with the first's, paired by game.
experiments/buildingworth/ per game, each side's STANDING metal by unit category (army, con,
                          com, def, eco = power/converters/build turrets, mex, bld) every 15 s,
                          for winmodel -bw. Reads .brp files, or (-legacy) an older replay's
                          published pieces as KEYFRAMES ONLY (zero-filled chunk bodies, so a
                          minute's resolution for a fraction of the download), priced by def
                          name from a .brp run since those heads price only armed mobile defs.
                          -groups sorts games into ranked Isthmus / ranked other maps / lava
                          (internal/gamecat) from their BAR API details. Why it exists: the
                          v6 summaries rebuilt from pieces price every BUILDING at 0, so any
                          building-loss test on published summaries mostly measures nothing.
                          -table writes internal/insights/legacybuildings.json (every building's
                          category and cost by def name from its .brp runs), which prices the
                          buildings of replays rebuilt from pieces.
cmd/winfit/main.go        CLI: fits insights.WinModel to games with a known winner and prints
                          the coefficients to paste into swing.go. Input is insights files:
                          `insights -upload= -all -out ./ins` (compute-only mode SAVES an
                          already-published file instead of skipping it) then `winfit ./ins`.
                          Every step is a sample weighted 1/steps (each game counts once),
                          mirrored so there is no side bias; Newton's method with a small L2;
                          refuses under 20 games; reports log loss/accuracy of the current and
                          fitted weights overall and at 25/50/75/90% of a game. It reads files
                          of Version 10 or later (the five inputs). -model lava|ranked8v8 fits one
                          of the two models on the games it is for (lava games by their BAR API
                          details, cached like -categories). A refit changes
                          what is computed, so it is a new insights Version.
                          -categories also fits each game CATEGORY on its own (internal/gamecat:
                          lava games lavabalance rates — the lobby's tweak stack, ported from
                          claudebar's lava.ts, NOT the map_waterislava flag — ranked two-team
                          games of >= 10 players, other ranked, unranked), from each game's
                          api.bar-rts.com detail, cached under the user cache dir
                          (barreplay/api.bar-rts.com/replays/). An unreadable insights file is
                          skipped with a warning; cmd/insights no longer accepts (or serves from
                          its cache) an empty body, which is how 0-byte files got there.
internal/insightsrun/     what cmd/insights does, as a package (Runner: New(Options), One, Each,
                          CatalogRids), so cmd/bringest's on-demand summary service runs the SAME
                          code as the backfill. The entry below describes it; cmd/insights is now
                          only its flags. One() takes a revision id in every form the catalog
                          serves — flat <gameId>-<rev> and month-folder <YYYY-MM|undated>/<gameId>
                          [-<rev>] (ridRE) — a bare gameId being a GAME, resolved to its row.
                          A reader waits on it (on-demand summaries), so nothing in it runs
                          one thing after another that could overlap: a rebuilt replay's
                          pieces download 8 at a time (viz.ReadStaticBundle) while the BAR
                          API's winners and the demo's orders are fetched beside them, and
                          insights decodes chunks decodeAhead = 3 ahead of its pass. A 51-
                          chunk 8v8 went from 32 s to 10 s on a 4-core host.
cmd/insights/main.go      CLI: the summary BACKFILL, one replay at a time (or -all). Old replays
                          have no .brp anywhere, only their split pieces, so it resolves a
                          gameId/link through the catalog (current rid + the row's view, the
                          only record of whose POV a rebuilt replay is), reads replays/<rid>.brp
                          from the destination's DataURL when the bucket has one (full costs),
                          else rebuilds from .brw/.keys/c<n>/.resources (viz.ReadStaticBundle ->
                          insights.FromPieces: army costs only, POV "unknown" when the row has no
                          view), and uploads the one file via packer.UploadPieces (no catalog
                          write). An existing insights file is skipped unless -force. A LOCAL
                          capture (.brp, or a .brepstream it packs first) is the way back
                          to full costs for a pieces-only replay — e.g. an upload's archived
                          stream — with -rid naming the published revision it belongs to.
                          LOCAL CACHE (cache.go): every object fetch reads (a .brp, a piece,
                          a published insights file) is kept at <cache>/<bucket host>/<key>,
                          and each summary it publishes is stored there too — so the second
                          -all, the -upload= -all -out pass that collects files for winfit,
                          and the recompute after a refit download only what is new. Sound
                          only because the bucket is append-only: a key never changes bytes
                          (the one exception, -force republishing a summary under its own
                          name, goes through the cache too); misses are NOT remembered, since
                          a 404 becomes an object the moment something is published there.
                          -cache defaults to "auto" = os.UserCacheDir()/barreplay for r2 and
                          NO cache for local, whose simulator bucket gets wiped and refilled
                          (a main replay's unsuffixed key can come back holding another
                          capture). Writes go through a temp file + rename so a killed run
                          leaves no truncated copy, and so that -j's replays in flight, which
                          share ONE cache, can race on a key (each writes its own temp file,
                          the last rename wins with the same bytes; only the closing line's
                          tallies take a lock); a cache that cannot be written only warns.
                          Keys are refused unless they are clean relative paths, since the
                          rid in them comes from the catalog.
                          Nothing writes pieces any more, so the rebuild tests (here and in
                          internal/viz) read testdata/legacy/: a bundle cut by the last
                          encoder that wrote them, beside the .brp it came from.
worker/src/summary/       the GAME SUMMARY page as a LIBRARY: mountSummary(el, insights, {onClip, onSeek})
                          draws an insights file and nothing else — no import from app.js, no
                          globals, its CSS injected once and scoped under .brs-root — so another
                          site (lavabalance) can mount the same pages. TypeScript, so unlike
                          app.js it is BUNDLED: the Vite summary-bundle plugin runs esbuild over
                          index.ts into one ES module fingerprinted by its own hash
                          (summary.<rev>.js; /summary.dev.js under `vite dev`), and index.html
                          hands app.js its URL as window.__SUMMARY_JS__ (placeholder token
                          __SUMMARY_MODULE__ — NOT the global's name, the same textual-replace
                          trap as __DATA_ORIGIN__). Browser code, so it has its own tsconfig
                          (the Workers types redefine DOM names): `npx tsc -p src/summary`.
                          Pure parts (format.ts, model.ts — e.g. comparable(): two sides AND a
                          full-view capture, the only case a side-by-side chart is honest) are
                          node-tested in tests/summary.test.ts. In the viewer it is the replay
                          page's SUMMARY TAB (app.js applyReplayTab/showSummary): ?tab=summary
                          on the /replays/<id> path (pushed, so back returns to the playback;
                          the legacy ?tab= normalization therefore only applies on "/"), the
                          library imported on first open, the insights fetched from the data
                          origin, a 404 saying the summary is not built yet, onClip = openClip
                          and onSeek = seekToFrame (back to the Replay tab at that sim frame).
                          The two tabs are <a href> links (replayTabHref), so a middle- or
                          ctrl-click opens either in a new browser tab; a plain click stays
                          in the page. The clip window over the (centred) summary opens ONLY
                          when a moment is clicked — never on its own when the tab opens
                          (Marcin's call: an unasked-for popup over the page). ✕ and
                          Escape close it. It drags by its title bar
                          and resizes from any edge (initClipWindow; edge presses are taken in
                          the capture phase so they do not also pan the map), and its rect is
                          kept in localStorage ('barreplay.mapwindow', clamped to the
                          viewport); the default is the middle of the screen (clipDefaultRect).
                          Embedded (?embed=clip) none of this applies.
                          WATCHING (watch.ts): anything on the page with a moment behind it — a
                          chart time, a swing, a battle, a death, a milestone, an award — hands
                          the host a Clip {f0, f1, at?, atEnd?, x?, z?, r?, title?, titleRuns?} — `at`
                          is the INSTANT it is about, which the viewer marks on the clip's
                          slider (#clipmark); PLAYBACK starts LEAD_IN_SEC = 5 s before it
                          (Clip.start) while the clip itself reaches back as far before it
                          as it runs after (at least CONTEXT_SEC = 20 s), so the moment sits
                          mid-timeline with context to scroll back to (clipAround: 20 s
                          after; clipSpan: to 5 s past an end; clipAt: at least 20 s, at
                          most a minute). A swing's clip is about
                          the moment's FOCUS (moments.ts: the commander death, the costliest
                          loss, or the densest 10 s x 1500-elmo burst of losses), not the
                          start of the minute the line took to move, and zooms there.
                          A FIGHT moment is told as ONE EVENT with a START AND AN END: the
                          battle (Insights.Battles) running in the window where the most metal
                          went down (biggestFight — chosen by place as well as time, since two
                          fights on opposite sides of the map at once are two stories), with
                          its own span as Focus.f..f1 and only the deaths within its radius +
                          600 elmos counted; what died elsewhere meanwhile is a separate
                          "Elsewhere at the time" sentence when it is big enough to matter.
                          A battle one swing would tell whole that runs over ANOTHER swing's event is told in part too (momentStories; a long merged fight swallowed the next swing's bombing run). The window it searches is the moment's +- one step (momentWindow),
                          since a raid's buildings often blow up just after the line moved.
                          A side the line moved toward that still lost MORE there is not said
                          to win: the title states the trade ("trades 114k metal for 69.9k").
                          With NO battle there, the fight is still ONE event: the burst's spot
                          (moments.ts burstEvent: every death in the window within 1500 elmos
                          of the densest 10 s burst, first to last), so the sentence counts
                          exactly what the clip plays rather than the whole map's window.
                          When NO battle holds the losses (spread over the map) and the losing
                          side's army fell by >= ARMY_DROP_SHARE (25%) in the window, the moment
                          is told as that: "Blue loses 43% of its army[, mostly aircraft]"
                          (moments.ts armyDrop), clipped over the whole window — the line moves
                          on the army, which the losses chart (a share of everything owned)
                          barely shows. The swing chart shades each moment's minute in the
                          side's colour, since its dot marks where the line ARRIVED.
                          A span clip (watch.ts clipEvent) plays the WHOLE event however long,
                          20 s of context before it, and carries atEnd, which widens the
                          slider's #clipmark into a band over the event; capping it at a
                          minute hid the end of a two-minute fight its story was counting. Titles
                          and every player/side name are drawn in that player's in-game
                          colour (names.ts, model.nameRuns); a side is named by its leader's
                          colour ("Blue team", model.colorName), "Team N" when two sides
                          would share a name. onClip winning
                          over onSeek, which only takes the start. The viewer PLAYS IT IN PLACE
                          (app.js openClip/startClip/closeClip, index.html #clip): the replay's
                          own #wrap — the map canvases — moves into a small window over the
                          summary, zoomed to the clip's spot, at a speed that fits the clip
                          into ~20 s (CLIP_WALL_SEC), stopping at f1, with just play, a slider (which SCRUBS fractionally — app.js scrub/posForFrame — so units interpolate between samples while it is dragged)
                          and the speed; Esc closes it with the summary where it was, "Open in
                          Replay" carries on at that frame. Asked for because every click
                          used to throw the reader out of the summary. fitView DEFERS while
                          the viewport is 0x0 (fitPending, refit by resize), since a replay
                          first loaded behind the summary tab has no size to fit.
                          TOOLTIPS (tooltip.ts) are one instant HTML box (.brs-tip, fixed,
                          flipping at the window's edges) used by every section — native
                          <title> tooltips were slow and unstyled. tip() binds one element,
                          tipLayer() delegates for many marks (the killing-fields zones), and
                          charts in one chartGroup() share a crosshair whose tooltip lists
                          every member's readout, which is how the panels under "Who was
                          winning" read as one chart. A row carrying `metric` is one SIDE's
                          reading of it: those rows pivot into a table (a column per side, a
                          line per metric) so the two sides' numbers line up. A panel label
                          can carry an (i) whose hover explains the panel (advantage.ts label).
                          NOTICES (model.ts notices) open the page: an OUTDATED file says
                          which features its version lacks (VERSION_FEATURES — add a line
                          with every version bump), and a v7+ full-view file whose capture
                          names no killers (Insights.Causes false) says what that costs.
                          Sections (sections/*.ts, in page order in index.ts) each
                          return null when the file cannot support them: the side-by-side
                          charts (advantage, army composition) need comparable(); race to
                          tech and killing fields need a full-view capture (a one-sided one
                          knows only its own milestones and the deaths it saw). KILLING
                          FIELDS draws ZONES, not deaths (zones.ts): a big game's ~90k dots
                          painted the map solid, so fought-for deaths (not those going down
                          with an eliminated team) bin into half-zone cells, the heaviest
                          cell left takes every cell within a zone radius (a twelfth of the
                          map), repeated up to 40 times; each zone is a pie (area = metal,
                          wedges = who lost it) whose click plays its busiest 30 s. chart.ts is
                          the shared time-axis frame (crosshair readout, click = a clip);
                          mapview.ts draws world-space marks over api.bar-rts.com terrain
                          (best-effort, plain background otherwise). Side colours go through
                          model.readable(), which lifts BAR's darkest team colours (#0000ff)
                          until they read on the dark panels. PLAYERS (sections/player.ts,
                          reportsShown — full view and a players list) is a section with a TAB
                          per player grouped by side, a map drawing EVERY commander's path at
                          once with the chosen one bold (a path is also a way to pick; a jump
                          no commander walks in a step is drawn as a gap), the diary/leaks/
                          style beside it and the built/lost strip below; names in the Sides
                          cards select a tab. "Who was winning" stacks the swing line, ARMY VALUE, METAL
                          INCOME and METAL DESTROYED (advantage.ts comparePanel) on one time axis and crosshair, with eliminations marked on the swing line;
                          the three panels sit FOLDED in a <details> under the line (Marcin's call: the line is what a reader came for), which
                          is why the swing chart draws its own minutes axis. METAL DESTROYED is the win model's fourth input (losses.ts
                          destroyedBySide = the other side's fought-for losses, Go's Killed): its Value mode, the default, draws per-step
                          BARS like a player's Built and lost (first side up, second down), and its Ratio compares the totals so far
                          with the model's own 25k k; under that line Ratio adds a second chart, METAL DESTROYED PER 15S (advantage.ts
                          windowRatio, Marcin's ask): per 15 s window on its own, the lead of whoever destroyed more, a bar up or down
                          in its colour on a log scale capped at 10x, with 500 metal added to both sides (WINDOW_K). The two
                          ratio panels default to RATIO (series.ts leadPct: ONE white line, the first side's
                          lead UP like the swing line above it, +20% / -20%, shaded in the
                          leader's colour,
                          smoothed by the win model's own k; the axis spans the min and max
                          lead from 40% to 95% of the game (series.ts ratioDomain, RATIO_WINDOW,
                          Marcin's call), since the opening minutes and a decided game's last
                          ones run to thousands of percent — past it the line runs into a
                          16 px strip where an SVG mask fades it out (chart.ts fadeMask,
                          TimeChartSpec.overflow), never along a solid edge, and the tooltip
                          has the number) with a Ratio/Value
                          switch (scale.ts pairToggle); Value shows both sides' numbers with
                          a Linear/Log switch, log default, hidden under Ratio. The swings
                          list under it lays each swing out like a battle detail — the two
                          sides' columns side by side, each with its fighters and its losses
                          as icon chips (unitchips.ts fillUnits, at most SWING_CHIPS), the
                          side the line moved toward boxed with the shift — and the whole
                          row plays the clip, as do the chart's lettered dots, whose tooltip IS that row (swing.ts entryRow, inert). Swings are
                          LETTERED (A, B, C...) because battles are NUMBERED, and a long stretch
                          with no swing is filled with BATTLES (moments.ts gapBattles: the
                          biggest battle in the widest gap over an eighth of the game, at least
                          4 min, until none is left or none holds a battle >= 10% of the
                          game's biggest; at most 12 entries; in the opening EARLY_SHARE = 30%,
                          which lists no swings, ONLY the decisive battles: loser lost >= 3x
                          the winner and >= 1000 metal that was >= 20% of its army then, at
                          most 4, however small next to the game's biggest; and any STORY
                          battle: at most 2 min long, >= 1000 metal lost by one side and both
                          sides' losses >= 15% of both armies then — a raid or a bombing run
                          too small next to the game's biggest yet decisive for the moment;
                          at most LIST_MAX = 20 entries, one per time and place), each told as "Red
                          decisively wins battle (5)" with the battles list's white-circle
                          badge — the line lists only its biggest shifts, and a decided fight
                          can move it little. A swing told as one battle carries the badge too. LOG
                          SCALES (chart.ts TimeChartSpec.log: symlog, ticks at powers of ten,
                          labels closer than a line apart dropped); every y tick drops a fraction of only zeros, "1.0k" -> "1k" (chart.ts tickText, Marcin's call): metal income and army
                          composition each carry a Linear/Log toggle (scale.ts scaleToggle,
                          which redraws the chart in place); composition defaults to LOG, and
                          there places each side's TOTAL on the log axis and splits it by
                          SHARE — stacking by value through a log would hand the bottom band
                          most of the height whatever its size. The BATTLES
                          section (once "Map story"; no army-centre lines since v7) numbers its battles in the order they happened, on the map and
                          in a one-line-per-battle list, and over both a TIMELINE (battles.ts
                          timeline; Marcin's "C+B": a linear loss scale made every late battle
                          look bigger than an early rout): each battle a bubble at its time,
                          UP for the first side ahead, DOWN for the second, as far out as
                          log10 of the loss ratio (gridlines 2x/5x/10x, capped at 10x), its
                          area the metal lost, a faint ring the armies nearby, a line its
                          span, as a FIREBALL (yellow to amber, never red, ringed by flame tongues — flameRing; Marcin) when ownBlast decided it. Each list row carries the same
                          verdict as a bar from a centre line (lean) ending in a dot sized by
                          the metal lost, plus "blue : red" losses; the MAP draws the same
                          bubbles (colour, size, fireball) where each was fought. All three
                          share ONE tooltip (battleTip: the battle's own detail panel —
                          fighters, two per side then "+N" (fighterNames max), and the two
                          sides' losses side by side, first side left — cached per battle).
                          Nothing is SELECTED (Marcin: hover + clip is enough): pointing lights
                          the battle in all three, a click plays its clip, marked on the slider as its whole span (clipEvent, like every clip of something with a duration — a killing-fields zone's busiest 30 s too). The tooltip
                          shows the two sides' losses SIDE BY SIDE, each KIND of unit as its
                          untinted BAR icon with a count (Battle.lost[].units, v4: def/n/metal,
                          costliest first, at most 48). Defs sharing a bitmap are one kind,
                          added up (losskinds.ts lossKinds), and only the kinds carrying 90%
                          of the metal show; the rest sit behind a "+N more" chip. The side that
                          lost less is BOXED in its colour with an "ahead" chip (no verdict
                          sentence), and each side's fighters sit over its own column.
                          Race to tech's clips zoom to and FOLLOW the milestone's unit
                          (Milestone.unit/pos, v4); the player's Built and lost strip is
                          log by default with a Linear/Log toggle. ICONS (icons.ts unitIcon) come from
                          the viewer's /icons/icontypes.json, looked up by the insights def's
                          `icon` (its iconType) then its name; SummaryOptions.iconBase names
                          the origin, defaulting to the one the module was loaded from, null
                          = names; a def with no icon reads as its name.
                          The library draws versions 1-10 (INSIGHTS_VERSIONS [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]; v2 adds
                          winner + swing, v3 eliminations and peak battles, v4 owner removals
                          left out, owned value and battle teams, v5 self-destructs marked, v6 fitted
                          win weights, v7 the game ends at the resign rather than the first team knocked
                          out before it, swing drivers and no opening economy swings, v8 battle killers and unit classes for the battle phrases, v9 the calmer win model with metal destroyed and a 3-minute income window, v10 lost buildings at 2x in battle verdicts, standing buildings in the win line with a lava and a ranked 8v8 model, and the build-up and base stories) and app.js fetches .insights10, then 9, 8, 7, 6, 5, 4, 3, 2, 1. A version bump needs `insights -all` after
                          the deploy, or published replays keep their older summary — except the ones people OPEN, which
                          update themselves: see ON-DEMAND SUMMARIES under worker/ (so
                          `insights -all` is now only for having every summary current at once).
                          ACHIEVEMENTS (achievements/ + demo.ts; Marcin's ask: run purely in the
                          client "to see how well it works"): 258 rules from the shortlist that a
                          demo + the BAR API can decide, listed under Awards. The BROWSER downloads
                          the game's demo through the worker's /api/bar/demos/<file> (OVH sends no
                          CORS; same caching as the map proxy), parses it in TypeScript (demo.ts:
                          startscript, orders, selections, chat, pauses, leaves, the tail's winners
                          and per-team end-of-game totals), and names build orders from the
                          published .brp's def table (SummaryOptions.brpUrl, two Range reads of the
                          meta). AICOMMAND instance 255 is NO AI (a player's Lua widget — area mex,
                          build lines): those orders are the player's. Widget orders arrive one per
                          unit, so action counts use Player.acts (one per frame and command).
                          Nothing is stored; thresholds are the shortlist's, untuned.
                          HIDDEN BY DEFAULT (Marcin's call): the block shows only when the
                          page URL carries an `achievements` query parameter, any value
                          (SummaryOptions.achievements, set from location.search by app.js
                          and by embed.ts from the HOST page's URL).
                          EMBEDDING ON ANOTHER SITE (lavabalance's game pages): the other site
                          IMPORTS THE LIBRARY AT RUN TIME — import("https://replay.fogofwar.dev/
                          embed/summary.js") — so a deploy here reaches it with no change, pin or
                          rebuild on its side (a build-time pnpm pin came first, and every
                          summary fix then needed a lavabalance PR too). That URL is a one-line
                          LOADER (`export * from "./summary.<hash>.js"`) that the summary-bundle
                          plugin writes beside the fingerprinted build of embed.ts, both under
                          /embed/: the loader is no-cache, the build immutable, and BOTH answer
                          `access-control-allow-origin: *` (a cross-origin module import is
                          refused without it). Those headers come from public/_headers, which
                          is why /embed/* is excluded from run_worker_first; the smoke checks
                          all three. `vite dev` serves /embed/summary.js as a fresh bundle.
                          The module's entry
                          (embed.ts, mountGameSummary(el, gameId)) keeps every fact about where
                          things live HERE: it resolves the game's rid through GET /api/replays?id=
                          on replay.fogofwar.dev, fetches the newest insights from cdn-bar, and by
                          default PLAYS a clicked moment in a clip window over the host page
                          (embed.ts clipPlayer): an iframe of /replays/<gameId>?embed=clip, the
                          viewer's own clip player ALONE (app.js initEmbedClip; body.clip-embed
                          hides everything but #clip), so the map, streaming and drawing stay
                          the viewer's and nothing is reimplemented. Clips go in by postMessage
                          ('barreplay:clip' — a unit's route is too long for a URL), only once
                          the frame posts 'barreplay:ready' from loadReplay (a clip opened
                          before the data draws a null map). ✕/Escape post 'barreplay:close'
                          (dismissClip; closeClip is a no-op embedded, since the tab logic
                          calls it during load) and the host HIDES the frame, keeping it, so
                          the next clip starts at once. "Open in Replay" there, like onSeek's
                          default, opens /replays/<gameId>?f=<frame> in a new tab (app.js
                          seekFromURL reads ?f= once per load, then drops it). It also
                          points iconBase at replay.fogofwar.dev (bundled elsewhere, the
                          module's own origin would be the other site's). That
                          needs three CROSS-ORIGIN reads, each set up separately: /api/replays
                          answers `access-control-allow-origin: *` (app.ts), /icons/icontypes.json
                          the same (public/_headers), and the bucket's policy (r2-cors.json, which
                          lists lavabalance's origins — re-apply it with the README's CORS step
                          whenever it changes).
internal/viz/readbundle.go ReadStaticBundle: the inverse of WriteStaticBundle, rebuilding a
                          BRPFile from published pieces through a PieceFetcher. Defs come back
                          from the head only (names, footprints, armyCost -> MetalCost, CanFly
                          from an "air*" icon), parsed by its OWN legacyHead types — the pieces
                          outlive whatever the encoder becomes — and a v4
                          head yields BRPFile.Legacy, which DecodeChunk decodes with the 8 old
                          core columns (build = finished, target = none) — snapshot/brp.go's
                          frameCodec.cols.
internal/capture/         parse the widget's .brepstream -> snapshot records (brep.go; the
                          text preamble + comm-record parsing in lines.go). The BRSNAP text
                          stream it used to read too is GONE — nothing wrote it once the
                          re-sim moved to .brepstream (widget 1.8.0). 'C' records carry one
                          JSON payload each — a chat message or a map drawing — through
                          parseComm, whose
                          sanitizeCommText length-caps the player-authored text and strips
                          control characters before it can reach a browser.
internal/viz/             publish side of the viewer: the catalog row (catalog.go), the icon table
                          the front-end resolves units against (icons.go -> bardata/icons/icontypes.json)
internal/viz/static.go    a replay's published form: its .brp alone (plus index.json), for serverless hosting
worker/                   Cloudflare Worker (Hono + Vite) hosting the viewer as static files from R2 (no playback server);
                          worker/public + worker/index.html are THE front-end (the one copy in the repo).
                          COLOURS (the LAVA scheme, Marcin's pick of the redesign mockups): every
                          chrome colour in style.css is a token on :root — a maroon-black page
                          under an ember glow at the top, SMOKE panels (translucent darkenings,
                          so the glow shows through; anything floating over content takes the
                          opaque --float instead), teal (--accent, which replaced gold: Marcin
                          was "not a fan of this yellow") for the selected and the clickable,
                          lilac for work in flight — so a restyle is an edit of that block. The
                          canvases cannot use var(), so they read the tokens through app.js
                          themeColor. Team, unit, resource and status-chip colours
                          are NOT tokens: they say something, and stay what they were. The
                          SUMMARY keeps its own palette (worker/src/summary/styles.ts, the
                          --brs-* variables, which the embed also themes) and #summary paints
                          its own background, so the glow stops at its edge; setup.html, being
                          self-contained, repeats the values inline.
                          UI CACHE-BUSTING: index.html references /app.<rev>.js /
                          /style.<rev>.css — the hash is in the FILENAME, not a ?v= query, so a
                          given byte sequence's URL never changes and public/_headers serves it
                          immutable for a year. __ASSET_REV__ is stamped with
                          sha256(app.js+style.css)[:8] by the Vite asset-rev plugin
                          (vite.config.ts, build AND dev), and index.html itself is served
                          no-cache (the Hono serveEntry route) — so a UI deploy propagates on a
                          plain reload, no hard refresh. Vite copies public/ VERBATIM and
                          fingerprints nothing, so the plugin emits the hashed copies itself
                          (generateBundle) and rewrites the hashed URL back to the plain file
                          under `vite dev`.
                          STATIC ASSET CACHING: run_worker_first is ["/*", "!/icons/*",
                          "!/ranks/*", ... "!/embed/*"] (the last for the embed's CORS/cache
                          headers, see EMBEDDING ON ANOTHER SITE). The "/*" preserves the original guarantee (no route
                          falls through to the asset layer's single-page-application handling,
                          which would answer /api/* with index.html — the reason a plain LIST of
                          worker paths is a trap). The exclusions hand the two vendored prefixes
                          to the asset layer, which matters twice: a cold replay load requests
                          300-650 unit icons, each an invocation when routed through the Worker,
                          and public/_headers applies ONLY to asset-layer responses — through the
                          Worker its cache-control rules are silently dead. Icons are NOT
                          fingerprinted and cannot be: each icon's path is baked into the
                          unitIcons map of every older replay's published .brw, so renaming
                          would 404 the icons of every replay already published — hence a
                          week's max-age rather than immutable, and purge the zone after
                          re-syncing the vendored bitmaps. The same goes for the ICON TABLE,
                          /icons/icontypes.json (generated into internal/viz/bardata/icons/
                          by `go test ./internal/viz -run IconTypes -update`, and kept current
                          by that test): it rides the same prefix, so a viewer may hold a stale
                          copy for up to a week after BAR's icon set changes.
                          HOSTNAMES: the worker is served from replay.fogofwar.dev (a wrangler
                          Custom Domain — a PER-HOSTNAME cert, so no wildcard and no Advanced
                          Certificate Manager; the zone must live in the worker's own account)
                          AND from replay.bartools.workers.dev — workers_dev: true is EXPLICIT
                          in wrangler.jsonc, because with routes configured wrangler's default
                          flips to off and a deploy would disable the subdomain. Either origin
                          serves the same viewer unchanged (the bulk pieces go to the absolute
                          cdn-bar.fogofwar.dev data origin from both), which is why the
                          workers.dev origin is also in r2-cors.json — re-apply that policy to
                          the bucket when its origins change (README's CORS step) or the
                          browser blocks every replay piece on the new hostname.
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
                          PRODUCTION DATA, READ-ONLY (`npm run dev:prod`): the dev server
                          with wrangler.proddev.jsonc (entry src/worker/proddev.ts) in place
                          of wrangler.jsonc, its REPLAY_INDEX and BUCKET swapped for stand-ins
                          (src/worker/readonly.ts) that reach production through a REMOTE
                          service binding to the proxy Worker replay-prod-readonly
                          (src/prodproxy, wrangler.prodproxy.jsonc, deployed by hand with
                          `npm run deploy:prodproxy`, no public route). The proxy binds the
                          production DO by script_name and answers only R2 get/head/list and
                          the ReplayIndex methods on READ_METHODS — everything else is a 403
                          THERE, so read-only does not depend on local code. A new
                          ReplayIndex read is refused until listed (and the proxy redeployed).
                          No cron and a local, daemon-less SummaryHub in that mode.
                          The BULK replay pieces (the .brp, plus the .brw/.resources/.keys/
                          c<n> of older replays) are NOT fetched
                          from it: they come from cdn-bar.fogofwar.dev, the R2 bucket bound
                          directly to a hostname. A Worker runs BEFORE Cloudflare's cache, so
                          every /replays/* read through it is a billed Class B GetObject no
                          matter what cache-control it sets; served straight from the bucket a
                          cache HIT never reaches R2 and costs nothing. /api/* stays on the
                          worker because it BUILDS it (the catalog DO).
                          app.js routes exactly those URLs through dataURL(), whose origin
                          comes from index.html's __DATA_ORIGIN__ placeholder: stamped by the
                          Vite dataBase plugin on a BUILD only ($DATA_BASE overrides), BLANKED
                          by `vite dev` (which is the origin for its own files) — empty means
                          same-origin, and app.js ignores any value
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
                          .brp, .keys or the extensionless c<n>, so without the rule everything still
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
                          start times last), PAGED by ?limit=&offset= (every response capped at
                          CATALOG_LIMIT_MAX = 200 rows — absent/junk/oversized limits all serve
                          the cap, never the whole catalog; walk offset until a short page for
                          more) and FILTERED by its query params (parseReplayFilter:
                          from/to — unix seconds or YYYY-MM-DD, where a YYYY-MM-DD `to` covers the
                          whole day — map, minPlayers/maxPlayers, minDuration/maxDuration in
                          seconds, id = a lowercase-hex PREFIX of the game's own id (a
                          range over the PRIMARY KEY, so a whole id is one seek; a prefix
                          because what people have is a paste — of the id, or of the head of
                          one out of a link — and non-hex is REFUSED rather than answered
                          with an empty list, since there is no such thing as a partly-typed
                          id that is merely wrong), player = a case-insensitive name
                          PREFIX, settings = comma-separated flags that must ALL be present; no
                          params = the whole catalog, unknown params ignored so an older front-end
                          still works). Filtering is SQL: the flag predicate hits the derived
                          table replay_settings(replay_id, flag), DELETED and rebuilt from the
                          row on every write (upsert, refreshFromApi) so it cannot drift and a
                          re-publish that drops a flag stops matching it; those predicates are
                          index-backed (replays_start / replays_map / replays_count and the
                          derived table's covering index — verified with EXPLAIN QUERY PLAN).
                          The PLAYER predicate is the exception that reads the roster JSON on
                          the rows directly (a LIKE over a JSON-encoded, LIKE-escaped needle):
                          its old derived table replay_players cost ~48 rows written per
                          mirrored game to maintain — the write half of the 2026-08-23 outage
                          (see ROW BUDGET) — and a bounded scan of the small catalog on a
                          human-initiated query costs nothing that matters. The WHERE
                          clause is built from the predicates actually set, NOT a fixed
                          `(? IS NULL OR col = ?)` chain, which hides the column behind an OR and
                          forces a scan. schema_meta.derived_version (DERIVED_VERSION) runs a
                          one-time pass on the next wake when it is bumped (ensureDerived holds
                          the current bump's work), which is how rows predating the derived
                          data were backfilled; the SCHEMA itself is versioned separately —
                          the schema_version table holds the stamp of the last COMPLETED
                          migration, the constructor reads that one row (a missing table means
                          a pre-stamp database and migrates), and the DDL runs only when the
                          stamp is old, because CREATE TABLE IF NOT EXISTS is write-classified
                          even as a no-op and the overage gate kills whole requests. BUMP
                          SCHEMA_VERSION with any DDL change, or it never deploys.
                          GET /api/replays/maps serves {maps: [...]}, the catalog's distinct map
                          names — the filter bar's combobox choices, and the ONLY filter data the
                          front-end fetches (the settings chips are a hardcoded vocabulary, the
                          ranges have fixed domains, player/id are free text). It is a MAINTAINED
                          list, not a scan: upsert folds a publish's map into the unique_values
                          row (key='maps', value = a sorted JSON array) when it is new, and
                          mapNames serves that one row behind a one-minute in-memory cache. It
                          replaced GET /api/replays/facets, which ran DISTINCT scans plus a
                          full roster walk over the whole catalog on every landing-page load —
                          the single biggest rows-read line in /api/admin/sqlstats (~4000 rows/call).
                          PUT /api/replays/<id> upserts (called by pack -upload
                          and the ingest daemon; optionally guarded by the REPLAY_PUT_TOKEN wrangler
                          secret as a bearer token; GET /api/admin/sqlstats, /api/admin/queue and
                          /api/admin/jobs/<id>/samples and the maintenance POSTs /view,
                          /refresh-settings, /api/admin/resim and /api/admin/jobs/<id>/disabled are
                          ADMIN routes behind Cloudflare Access — see the landing-page
                          entry below). A publish that leaves the game ONE-SIDED
                          also QUEUES ITS RE-SIMULATION: upsert asks wantsFullView of the merged
                          uploads list (replayentry.ts — recorded from inside, no full-view
                          revision anywhere in it) and, when it is true, announces a "resim" job
                          under an id the route generates. A capture from a playing client only
                          ever saw its own side, so the game wants the spectator's view that
                          only a re-simulation can produce — and a publish is the ONLY moment
                          that can become true, which is why it is announced here rather than
                          searched for. It replaced a catalog scan in the re-sim daemon that
                          asked the same question of every row on a ten-second timer (see
                          cmd/bringest and ROW BUDGET). jobAnnounce rather than resimEnqueue,
                          because the game is in the catalog by definition here — this call is
                          what puts it there — which resimEnqueue refuses; the announce still
                          dedupes on an active job, so a second teammate's upload of the same
                          game adds no second hour of engine time, and the re-sim's own publish
                          (view "full") cannot re-queue itself. Rows are keyed by the BARE gameId and carry a
                          nullable `rid` (the <gameId>-<rev> revision the pieces are actually served
                          under — see the internal/packer entry; the front-end fetches at rid ?? id.
                          SHAREABLE LINKS carry the BARE id as a PATH: /replays/<gameId> is the
                          canonical URL — app.js resolveReplayFile maps it to the served revision,
                          from the loaded listing when in hand, else one GET /api/replays?id=
                          <gameId> — and every GUI link uses it except an explicit alt-upload
                          link, which names its revision outright; /replays/<rid> keeps playing
                          forever, since nothing is deleted, and legacy ?replay= links still
                          resolve (init normalizes them to the path form via replaceState).
                          BOTH backends serve the SPA entry at the page paths — /replays/<id>
                          with NO extension (the dot is the whole dispatch against the data
                          pieces under the same prefix: <id>.brp (and an older replay's .brw/
                          .keys/.resources) have one,
                          chunks have a second segment) plus /queue /games /sqlstats — the
                          worker via a /replays/:id route ahead of the R2 wildcard and the Go
                          server inside handleReplays; the smoke harness checks all four
                          against the real asset layer)
                          plus a nullable `settings` object (notable game-settings badges: ranked/
                          unranked, lava, mods, zombies, ruins, …) sourced from the demo fetch — see
                          the internal/packer entry — plus `players` (per-ally rosters by OS with the
                          ally's true count, from viz.BuildCatalogEntry, capped at
                          catalogPlayersPerAlly / CATALOG_PLAYERS_PER_ALLY = 32 — a FILTER limit, not
                          a display one: the list filters by "was this player in the game" and can
                          only match names a row stores, so the old cap of 5 left every 8v8 hiding
                          three players a side; rows published under it get their full roster back
                          from the admin refresh-settings route, which re-derives from the BAR API.
                          Each entry is {name, os?, rank?}: `rank` is BAR's CHEVRON level at the
                          time of THAT game, 0..7, which under BAR's "Role" rank method buckets
                          in-game hours (0: <5h, 1: 5h, 2: 15h, 3: 100h, 4: 250h, 5: 1000h) with
                          6/7 reserved for contributors and tournament winners — so it is the one
                          reading a row carries of how long a player had been playing BAR, which
                          the OS does not say. Both halves fill it: playersFromApi off the API's
                          Player.rank (every mirrored game and every refreshed row), catalogPlayers
                          off the .brp meta's PlayerInfo.Rank. It is ABSENT rather than 0 when
                          unknown, because 0 is a real level (an account under five hours) — which
                          is also why the Go side guards it (startscriptRank): the .brp meta stores
                          Rank as an int32 with omitempty, so a recorded 0 and a capture with no
                          startscript behind it decode identically, and only a player the
                          startscript named can report a 0 honestly),
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
                          from the .brp's Meta.Recorder ("full" when a spectator who kept full view on
                          the whole game — RecorderInfo.SawAll, read off the GAME line's fullView and
                          the stream's "view" facts (widget >= 1.10.1) — else "ally" +
                          uploaderAlly), and a re-sim — whose capture has no recorder record at
                          all, since only the live uploader widget writes one — declares "full"
                          through packer.UploadOptions.View (set by bringest -resim), without
                          which the row would keep the marking of the one-sided upload it just
                          superseded. Everything else is HAND-SET via POST /api/admin/replays/<id>/view
                          (admin, like refresh-settings; body {view, ally}, validated by
                          parseViewRequest) from the viewer header's POV dropdown — which, also
                          like refresh-settings, appears only in admin mode (app.js
                          adminMode() — an Access sign-in; it edits a row every visitor
                          reads, so it is maintenance, not a viewing preference) —
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
                          POST /api/admin/replays/<id>/refresh-settings (admin) re-derives one
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
                          Row shape + PUT validation + the filter contract live in
                          src/worker/replayentry.ts
                          (pure, node-tested) and MUST stay in lockstep with internal/viz/catalog.go,
                          whose BuildCatalogEntry builds the PUT body from the packed .brp (the
                          front-end also degrades against a backend with no filtering behind its
                          catalog — a plain static host — by hiding the filter bar when
                          /api/replays/maps 404s. The one Go-side piece the
                          filters DO depend on is catalogPlayersPerAlly, because BuildCatalogEntry is
                          what builds the roster the worker stores). The front-end landing page
                          (no ?replay= in the URL) is a LEFT MENU (index.html #rail, app.js
                          homeTab/applyHomeTab/markRail — the SAME menu on every page, see the
                          replay-page note below) over these sections: "Replays" (the catalog list, the
                          default), "Games" (the games MIRROR — see the GAMES MIRROR entry;
                          app.js refreshGames/renderGames, GAMES_PAGE=20 rows per page,
                          CURSOR-paged: Next hands back the reply's `next`, Prev walks back
                          down the trail of cursors this visit came through (gamesTrail),
                          the pager states the range and NO total or page count; the cursors
                          are component state, not in the URL, and a backend that 404s
                          the route is what the section says; the replay list's FILTER BAR
                          moves over to it (placeFilters, Player hidden; the filters stay in
                          the URL, so they carry between the two sections, and the replay
                          list re-reads on the way back when they changed — listQuery; a map
                          the catalog's datalist does not know applies as typed on Enter); open to every visitor, since
                          it is public games rather than the pipeline's state), "Queue"
                          (the ingest jobs, below) and "SQL" (the DO's row accounting).
                          Queue and SQL are ADMIN-ONLY — the entry is hidden when signed
                          out (CSS, like the row refresh button) and homeTab() maps
                          the tab back to "replays" for everyone else (ADMIN_TABS), so a
                          shared /queue link cannot walk past the hidden entry and
                          refreshQueue never fires. ADMIN MODE IS BEING SIGNED IN, nothing
                          else (worker/src/worker/access.ts, worker/README.md "Admin
                          login"; the ?admin=true flag is gone): app.js probeAdmin asks
                          GET /api/admin/me once at boot — every visit, one cheap 401
                          for an ordinary visitor — and adminMode() is true only on a
                          200, i.e. the browser carries a CLOUDFLARE ACCESS cookie for a
                          person the worker's policy allows. EVERY ADMIN ROUTE LIVES
                          UNDER /api/admin/ and the PREFIX is the gate: one
                          app.use("/api/admin/*", requireAdmin) registered before any
                          route, so a route added there is guarded by where it is. An Access
                          application protects ONE path, /admin/login, at the edge; the
                          worker VERIFIES the resulting CF_Authorization JWT itself with
                          jose — jwtVerify over createRemoteJWKSet, the repo's one npm
                          runtime dependency besides hono (signature against the team's
                          published keys, aud, iss, exp; jose owns the key-set cache)
                          on every /api/admin/* route — queue, sqlstats, jobs/<id>/samples,
                          resim, replays/<id>/view, replays/<id>/refresh-settings,
                          jobs/<id>/disabled, and me — so the gate holds on the workers.dev hostname (no
                          Access rule runs there) and against scripts. Config is two
                          vars, ACCESS_TEAM_DOMAIN + ACCESS_AUD; missing = FAIL-CLOSED
                          (401 with configured:false, and the header says so). The
                          configured REPLAY_PUT_TOKEN bearer is an admin identity too
                          (an operator's curl); ADMIN_OPEN=true in .dev.vars opens it for
                          local dev only. LOCAL DEV SIGNS IN FOR REAL by borrowing the
                          deployed login (app.ts /admin/login, three hops): a loopback
                          host with no assertion header bounces to
                          PUBLIC_ORIGIN/admin/login with next = its own
                          http://127.0.0.1:<port>/admin/callback; the deployed handler,
                          holding the Cf-Access-Jwt-Assertion header Access just set,
                          forwards the token ONLY to a loopback /admin/callback
                          (access.ts devCallbackNext — nowhere else, a credential on the
                          strength of a link); the dev server's callback verifies it
                          like any admin route and stores it as its own CF_Authorization
                          cookie (accessCookie, HttpOnly/Lax, expiring with the token).
                          /admin/logout clears that cookie on any origin and is the
                          menu's sign-out entry (the admin's initial, the address in its
                          tooltip — the menu is 72px); signed out, the foot of the menu
                          carries a muted sign-in entry (#adminnote), on every page. Just above
                          it, a CREDITS entry (#railcredits) opens #creditsdialog (app.js
                          initCredits): BAR's artwork and its licences, the open replay's map
                          and its author (mapCredit, from the maps API record loadMap reads),
                          the Recoil engine (GPL v2+) and where the patches' source is — keep
                          it in step with internal/viz/bardata/README.md's licence list. A 404 from /api/admin/me (a backend
                          with no login and no admin routes) shows nothing and no admin
                          controls. Every admin fetch in app.js treats a
                          401 as adminSignedOut (controls off, sign-in link back). Why: app.js is served unminified, the
                          routes were open, and on 2026-09-15 a script from an OVH host
                          was feeding every ranked game to POST /api/admin/resim within
                          minutes of it ending (~60/h against one host clearing 2-3). The Queue is the pipeline's state —
                          every uploader's jobs and their failure messages — which is
                          maintenance, not something a visitor came for.
                          Which section is shown lives in the
                          URL as the PATH — /queue, /games, /sqlstats, with "/" the replay
                          list (legacy ?tab= links normalize) — so a pick is shareable and
                          survives a refresh; it PUSHES a history entry, because switching
                          section is navigation, not a narrowing of what is listed, and back
                          from a replay returns to the section through history.
                          The dropzone sits above both sections (a drop is accepted from either,
                          and its progress line stays visible while the Queue is watched).
                          "Replays" renders the catalog with
                          superseded revisions of cataloged games hidden (their direct
                          /replays/<rid> links keep playing — nothing is deleted); picking a
                          replay navigates to /replays/<id>, the header title returns to the
                          list. The LEFT MENU (index.html #rail) is ONE menu, the same on
                          every page and never switching its entries (Marcin's call): the
                          logo, Replays/Queue/Games/SQL (links to the section paths; a click
                          from a replay page goes to the list view), the admin corner at the
                          foot. While a replay is open its two views — Replay and Summary,
                          the ?tab=summary tabs — appear as a SUB MENU under Replays
                          (#replaytabs): boxed together with Replays, smaller, hung off a
                          guide line, the selected one marked on it. It stays 72px wide
                          (Marcin: the replay area is what matters). A "NEW!" tag in the accent colour
                          points at Summary from just outside the menu (.newtag, part of
                          the link) and nudges toward it until this browser has opened the
                          summary once by any route (app.js initNewTag/summarySeen,
                          localStorage 'barreplay.summaryseen'), then stays put (Marcin's
                          ask). The header also leads
                          the replay's title with a "Replays" back link (#backlink). Both
                          pages are a CSS GRID (body.home / body.replay-page): the menu as a
                          full-height first column, the header beside it, then the section
                          (#home) or, on a replay page, the map and bottom bar column and
                          #side as a full-height last column. On a replay page (mockup D,
                          the "broadcast" layout) nothing there is a flat panel: the header
                          has no rule, the map floats on the page, #side holds two CARDS —
                          the game (#teamcard: the clock, the team statistics bar, ONE
                          player table) and the chat (#chatwrap) — and #bottombar is a card
                          too, the PLAYBACK STRIP (see the viewer section below); the view
                          toggles are the map's Layers popover. body.admin-mode is set by
                          probeAdmin itself, since the menu's admin entries show on a replay
                          opened directly, where no table render sets it. #side is a body child rather than inside #wrap
                          because the summary's clip player moves #wrap into its window; the
                          grid places every piece explicitly, so where closeClip puts #wrap
                          back does not matter. The list's Players
                          column shows each side's top names by OS (3 per side for a two-team game,
                          1 when there are more sides; full roster + OS in the tooltip) with a ◉ on
                          the side that recorded the current upload, the Links cell adds an alt·T<n>
                          SPA link per other uploaded revision (from the row's `uploads`), and
                          admin mode reveals a per-row ⟳ button calling the refresh-settings route.
                          A FREE-FOR-ALL abbreviates in BOTH the Size and the Players column, past
                          the same side count (app.js FFA_MIN_SIDES = 4, so a row can never read
                          "8v8" beside an ellipsis): Size prints "FFA (<players>)" with the spec on
                          its tooltip — the head count comes along because the word alone drops the
                          one number the spec was really carrying, and it is summed from the SPEC
                          (specPlayers, null unless every part parses) rather than the row's own
                          playerCount, so the cell and its tooltip cannot disagree — and Players
                          draws the first two sides and ends "v …" carrying a count of the rest. BAR records a 16-player FFA as
                          "1v1v1v1v1v1v1v1v1v1v1v1v1v1v1v1" with sixteen names beside it, which
                          between them stretched the table until Map wrapped to three lines and the
                          Links and Settings columns were pushed off the page. FOUR sides rather
                          than three, because an 8v8 played with scavengers is recorded as "8v8v1"
                          — two sides plus a team nobody plays — and that is not an FFA. The Games
                          section's twin columns and the queue's Size cell abbreviate identically.
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
                          `processing` pill (carrying the job's live percent when it
                          reports one — "processing: 52%", via the row's processingPercent,
                          read off the jobs row's progress JSON in the same list read;
                          the one filled, pulsing badge among the muted ones —
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
                          fields (date from/to, map — a COMBOBOX over a datalist of the
                          catalog's maps (from /api/replays/maps), so typing part of a name
                          shrinks the list to the maps containing it; ?map= stays an exact
                          match, applied when the text
                          names exactly one map — a player-count RANGE, a duration RANGE,
                          player name — free text, matched as a prefix server-side, debounced
                          300 ms (its completion datalist is gone with the facets endpoint:
                          offering one meant walking every roster in the catalog) — and
                          GAME ID, which is a paste target rather than something anyone
                          types: app.js gameIdIn takes the longest hex run out of whatever
                          arrives, so a gex or bar-rts link, a ?replay= URL or a log line all
                          resolve to the id, while a bare prefix stays a prefix and anything
                          with no id in it is passed through for the server to reject), then
                          the settings chips with Clear/count pushed to the far end.
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
                          is the same shape over a fixed 2..32 domain (PLAYERS_MIN/MAX, step 1;
                          it used to span a sizes facet), its right thumb at 32 equally open
                          ("16+"). The thumbs push instead of
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
                          next page" off that row's existence, so nothing counts anything. For
                          the DO half, a page is only cheap while its ORDER BY can be answered
                          by replays_start: `start_unix DESC, id` walks the index and stops at
                          the LIMIT, where the `start_unix IS NULL, ...` this used to lead with
                          sorted the WHOLE catalog in a temp b-tree first and made the LIMIT
                          decorative (3000 rows read to return 50, against 101). The expression
                          was redundant anyway — NULL is smaller than every value, so DESC
                          already puts those rows last.
                          ?limit=&offset= page the listing (the DO appends LIMIT/OFFSET to the
                          ordered query; ignoring them would make the Next button lie), and an
                          absent limit serves the SAME 200-row cap as an explicit one
                          (CATALOG_LIMIT_MAX in app.ts): the whole-catalog response is gone,
                          so a caller that really wants everything walks offset in cap-sized
                          pages until a short page. The page is
                          in-process state, NOT in the URL (like the queue's pager and unlike
                          the filters): "page 3" describes a moment in a growing list, not a set
                          of replays. Any filter change returns to the first page. Every control writes a URL param and
                          re-queries GET /api/replays — the filtering is the server's, so the count it
                          reports is the true number of matches, not what happened to be fetched. The
                          state lives in the URL (history.replaceState, so filtering is not
                          navigation and the back button leaves the list rather than stepping through
                          keystrokes), which makes a filtered list shareable and survive a refresh,
                          and replayHref carries it into a replay so returning lands on the same list.
                          The bar stays HIDDEN unless GET /api/replays/maps answers — a backend with no
                          filtering behind its catalog (a plain static host) must not show one, since
                          a filter bar that silently does nothing is worse than none.
                          THE CATALOG IS THE ONLY LISTING. There used to be an /index.json the
                          worker built per request by listing the bucket's whole replays/ prefix,
                          merged in to show uploads that were never registered (the admin
                          "Unregistered" button, ?orphans=true) and as the whole listing when
                          /api/replays failed. It was removed: the bucket had grown to 130k+
                          objects, so one request was hundreds of list calls (and a dev:prod
                          page whose /api/replays failed spent minutes on it). An unregistered
                          upload therefore does not list; its /replays/<id> link still plays,
                          and PUT /api/replays/<id> registers it. knownReplayURL does not treat
                          replayList as the catalog — it is a filtered page — so any well-formed
                          id is attempted and loadReplay reports a real failure rather than
                          silently bouncing a shared link to the list.
                          DRAG&DROP UPLOADS: the landing page's dropzone POSTs a raw .brepstream OR an
                          already-packed .brp to /api/upload (told apart by the first bytes, never the
                          file name; a .brp's head is checked by src/worker/brphead.ts — magic, version
                          5/6, the gzipped M meta's gameId and recorder — and archived the same way with
                          a .brp extension, which is what tells bringest not to pack it) (open endpoint; the Hono app lives in src/worker/app.ts, kept
                          free of workerd imports so worker/tests drive the real routes; index.ts is
                          the wrangler entry re-exporting the DO class). The worker never transcodes
                          (viewer serves the .brp wire only; the Go pipeline produces it): it scans
                          the preamble (src/worker/preamble.ts — gameId + recorder's ally team),
                          archives the raw bytes at streams/<YYYY-MM>/<gameId>/<ts>-<hash8>-a<ally>.brepstream
                          (the month is the game's start from the games mirror, else the upload's
                          own UTC month; archives from before month folders stay at
                          streams/<gameId>/..., and both shapes download)
                          (job KIND "upload"; see the resim door below for the other kind)
                          (the hash is sha256[:4 bytes] of the body and is what makes the key unique:
                          gameId and the a<ally> suffix are equal for two teammates uploading the same
                          game, or for a halfway capture and the full one, and Workers clamp Date.now()
                          to the last I/O so it does not advance within a request — concurrent uploads
                          collided and the second overwrote the first. Timestamp stays first so the
                          prefix sorts oldest-first, so identical bytes are re-archived, not deduped)
                          (append-only prefix, never listed, never served publicly;
                          the substrate for the future multi-player merge), and inserts a job row in
                          the DO's jobs table. cmd/bringest (see its entry) polls
                          GET /api/jobs, downloads via GET /api/streams/<gameId>/<file> (both
                          bearer-guarded), publishes, and POSTs done/error; the browser polls the
                          open GET /api/jobs/<id> and auto-opens the replay on done.
                          RE-SIM REQUESTS: the pipeline's OTHER door, for a game nobody
                          uploaded — nothing else reaches those except the mirror backfill, and
                          that picks its own. The Queue section's paste box POSTs a
                          replay link to the admin-gated POST /api/admin/resim, which parses the gameId out of
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
                          ALREADY SIMULATED (a full view in the catalog; one published only
                          one-sided is queued normally) is not refused but RECORDED as a
                          DISABLED job whose `note` (jobs.note) says "Already simulated at
                          .brp format version N" — N read off the full view's file header
                          (brpFormatVersion, a 5-byte Range read; omitted when unreadable) —
                          so it shows on the queue page and enabling it is how to have it
                          re-simulated anyway; and a game already queued or running,
                          which returns THAT job (so re-pasting a link is harmless rather than a
                          second hour of work). The catalog check, the duplicate check and the
                          insert are ONE DO call (resimEnqueue) — the DO is single-threaded, so
                          that is atomic for free, where three round trips would let two pastes
                          of the same link both insert.
                          THE PUBLIC REQUEST (POST /api/resim/request {gameId}, OPEN): what the
                          viewer shows for a /replays/<gameId> link with nothing published (no
                          .brp, no .brw: app.js showNotSimulated, in place of the bucket's 404
                          page) — "not simulated yet" and a Request button. ReplayIndex.
                          resimRequest dedupes like jobAnnounce (a queued game hands back its
                          job, which the page follows and then loads the replay in place),
                          answers "published" for a playable game, and is CAPPED: at most
                          PUBLIC_RESIM_MAX_PENDING = 10 public requests (note "Requested from
                          the replay page") may wait at once, 429 past it — the open door's
                          bound, since the admin paste box's gate is what it lacks.
                          ANNOUNCED WORK (ReplayIndex.jobAnnounce, and POST /api/jobs on top
                          of it): a job row for a game the OPEN door refuses because it is
                          already in the catalog. That is resimEnqueue minus the catalog check,
                          and it is the entire difference. Two things need it, and both are
                          published games that still want a full view: the one-sided publish
                          above (which calls the DO method directly — no HTTP hop, and atomic
                          with the row it just wrote), and a re-sim that FAILED, whose game the
                          paste box will now refuse forever and whose retry is this route. It
                          dedupes on an ACTIVE job for the game, so two callers get the same row
                          back and only one can claim it; a finished or failed job does not block
                          a fresh one, which is exactly what makes the retry possible. GUARDED,
                          like /api/admin/resim is now (Access) and was not: this is the one door into
                          the jobs table with no refusals behind it. /api/admin/resim's refusals
                          were once the whole argument for leaving it open; a script feeding
                          it every ranked game (2026-09-15) showed they cannot price an hour
                          of engine time, which is why it is admin-gated too. Only kind
                          "resim" — an upload job is bytes somebody sent, and there is no stream
                          to invent. The gameId goes through the same parseGameId a pasted link
                          does, since the route cannot tell one caller from another.
                          Claiming an announced job marks the game's EXISTING catalog row
                          processing without turning it into a placeholder (a revision exists,
                          so it stays openable), and a failure leaves that row untouched —
                          dropCatalogPlaceholder only ever deletes placeholder = 1.
                          DISABLING A JOB (jobs.disabled + POST /api/admin/jobs/<id>/disabled +
                          ReplayIndex.jobSetDisabled): the queue page's per-row switch. A COLUMN,
                          not a fifth state — the four states describe how far the WORK got, and
                          being held back is not a stage of that; it is also reversible, which a
                          state would make awkward. It does two things. Nothing is OFFERED the
                          job (jobsPending, jobClaim and, because the mirror backfill takes only
                          games with NO job row of any state, the auto-queue for its game too —
                          which is the durable way to say "never re-simulate this one"), and a
                          "processing" row is RESET to pending with its live progress cleared.
                          The reset is not cosmetic: nothing here can reach into a daemon on
                          somebody else's machine and stop its engine, so a row left claimed
                          would simply be handed out again once its stale window expired. For the
                          same reason a still-running daemon's HEARTBEATS are ignored on a
                          disabled job (jobUpdate returns early) — they would put it straight
                          back into "processing" a second after the reset — while its TERMINAL
                          report is still taken, since the work happened and what came of it is
                          worth recording. Disabling also drops the game's catalog PLACEHOLDER
                          (nothing is being worked on and nothing was published, so the replay
                          list must not keep an un-openable row), but leaves a real published row
                          alone, and KEEPS the job's samples — they are the record of work that
                          really happened, and the charts are the reason to look at a job you had
                          to turn off. A disabled job still BLOCKS a new one for its game
                          (walking around it with a fresh row is exactly what "will not be picked
                          up" rules out), which is why jobAnnounce/resimEnqueue report a distinct
                          "disabled" status: the paste box can then say why nothing will happen,
                          and a daemon treats anything but "queued" as not-its-work either way.
                          queuePage's unfinished-first ordering and its `active` count both
                          exclude disabled rows, so a held-back job does not sit at the top of
                          the queue forever nor inflate the menu's in-flight badge. The route is
                          an ADMIN route (requireAdmin), like the other maintenance routes the
                          admin UI drives (/refresh-settings and /view): the browser carries
                          the Access cookie, which is what lets the button exist without a
                          bearer token.
                          JOB ERROR KINDS: jobs.error_kind is a nullable classification OF the
                          error message (JOB_ERROR_KINDS in jobs.ts — currently just "oom"),
                          reported by the daemon alongside it. It exists because a queue full of
                          red rows should say which failures are the MACHINE's fault rather than
                          the game's, without anyone parsing a sentence: an "oom" job would have
                          worked on a bigger box, and every other failure would not. A CLOSED
                          set, because the queue page renders each kind specifically and an
                          unknown one has nothing to render; parseJobErrorKind DROPS anything
                          else rather than 400ing, so a daemon newer than the worker can still
                          report that its job failed. It follows `error` exactly and is NOT
                          COALESCEd like the stats — it is a property of that message, so a
                          transition clearing the message clears the classification with it.
                          ON-DEMAND SUMMARIES (POST /api/insights + the SummaryHub Durable
                          Object, src/worker/summaryhub.ts + summaryhubdo.ts): the viewer's
                          Summary tab, finding the newest file it reads (INSIGHTS_VERSIONS[0])
                          missing for the revision it shows, POSTs {rid, version} and WAITS. It is
                          NOT a job (Marcin's call: synchronous, nothing on the queue page). The
                          route answers with the SUMMARY ITSELF, read from the bucket (x-summary:
                          fresh when it was already there — the reader's 404 was the CDN's, cached
                          4h — or computed), 404s a revision that is not published (.brp or .brw),
                          and otherwise awaits SummaryHub.compute: the hub hands the request to a
                          daemon holding a WebSocket to it (GET /api/insights/connect, bearer-
                          guarded, ?version=&slots= — the daemon dials OUT, so NAT is fine), which
                          computes it with internal/insightsrun, publishes it, and answers on the
                          socket. CAPACITY IS THE HUB'S, IN MEMORY: requests go only to a daemon
                          computing that VERSION, up to its slots; past them up to HUB_DEFAULTS
                          .maxQueued wait, past that "busy"; a 15 s deadline, queue
                          wait included (Marcin's pick — how long a reader is kept waiting; a
                          timed-out computation still finishes and publishes for the next visit)
                          (a timed-out request keeps its daemon's slot until it answers); readers
                          of one replay share one computation, and a reader asking AGAIN after its 15 s ran out joins the one still running (per-reader deadlines; a page with NO summary at all re-asks on 504 for up to NO_SUMMARY_WAIT_MS = 2 min, app.js freshSummary / embed.ts requestSummary, since a big game's first summary takes longer than 15 s); a "not built yet" with a daemon connected can also be a viewer and daemon on DIFFERENT insights versions (the hub only sends a request to a daemon computing the version asked for, and answers "unavailable" otherwise), which a worker deploy fixes; a failure is remembered 10 min so
                          a broken replay costs a daemon once. Busy/unavailable answer 503,
                          timeout 504, failed 502. The page BLOCKS on the request (Marcin's call:
                          synchronous) — a stale summary is not drawn while the current one is
                          computed, the library's mountLoading scene shows instead (loading.ts: monkeys
                          hammering a bar chart, rotating captions, Marcin's ask) — and every non-200
                          means it falls back to the older file, if there is one. Its own DO class so socket traffic
                          never wakes ReplayIndex (no SQL, no ROW BUDGET); Hibernation API, the
                          daemon's "ping" keepalive answered "pong" by the runtime
                          (setWebSocketAutoResponse) without waking it, per-socket facts in the
                          attachment, and nothing in flight across an eviction (an instance with a
                          request in progress is never evicted). OPEN and answering any origin
                          (the lavabalance embed asks with a text/plain body — no preflight — and
                          waits for it like the viewer does): what it can cost is bounded by the slots and the
                          queue. Only plain bringest serves it (cmd/bringest/summaries.go over
                          ws.go, a stdlib WebSocket client: net/http does the handshake and hands
                          back the connection, the framing is hand-written) — never -resim, whose
                          host's time is the engine's. It reconnects with backoff and drops a link
                          silent for 90 s. The dispatcher's rules are node-tested
                          (tests/summaryhub.test.ts), the DO's socket handling in workerd
                          (tests/do/summaryhub.test.ts).
                          APP JOBS (kind "app", FogOfWar.exe): created ALREADY processing by the OPEN POST
                          /api/app/jobs {gameId, installId, stats} and reported on over the OPEN POST
                          /api/app/jobs/<id> (Marcin: no authentication for now), which refuses anything but
                          an "app" job (403) — the guarded /api/jobs/<id> stays the daemons' door. Never offered
                          to a daemon (DAEMON_KINDS = upload|resim for GET /api/jobs and claims); the cron fails
                          one silent for APP_JOB_STALE_SEC = 5 min (appJobsExpire, a jobs_kind seek); a Retry of
                          one is an ordinary resim. jobs.install_id (schema 8, partial index jobs_install) ties
                          an install's app jobs and .brp uploads together: GET /api/admin/queue?install=<id>
                          (jobsByInstall), reached from a row's Install line on the queue page.
                          The app uploads its .brp with ?appJob=<its app job>, which makes the upload
                          job a CHILD (jobs.parent_id, schema 9, partial index jobs_parent; accepted
                          only for an app job of the same game): bringest still publishes it as any
                          upload, but the queue lists only the app row and shows the publish inside it
                          (QueueJob.publish, app.js publishText) — two rows for one run read as two runs.
                          JOB KINDS: jobs.kind is "upload" | "resim" | "app", a KIND rather than a fifth
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
                          reason. It rides the OPEN reads (/api/jobs/<id>, /api/admin/queue) like the
                          stats do.
                          JOB SAMPLES (job_samples table + GET /api/admin/jobs/<id>/samples): every
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
                          would otherwise throw inside the bind and 500 the healthcheck. eta_sec
                          was added after the others (the estimate was always reported and only
                          ever overwritten in place), so rows written before it chart as a gap.
                          Past
                          MAX_JOB_SAMPLES = 720 (two hours of beats) jobSampleThin HALVES the
                          series in place, keeping its first and last sample and every other one
                          between: the chart keeps its full span at half resolution, where
                          dropping the oldest would lose the load phase and refusing to record
                          would lose the end — the part that says how it died. Retention is the
                          cron's job (index.ts, its own try so it cannot take the mirror down):
                          jobSamplePrune drops the samples of jobs finished more than
                          JOB_SAMPLE_RETENTION_SEC = 30 days ago, which is the only rule stopping
                          the one table here that grows on its own. It runs ONCE AN HOUR (the
                          cron's PRUNE_MINUTE) and is driven from the JOBS table over a BAND of
                          finishing times — the last cutoff to this one, remembered in
                          schema_meta — so each finished job is visited exactly once, on the run
                          after it ages out. Both narrowings are the ROW BUDGET (see below): the
                          obvious query, `SELECT DISTINCT job_id FROM job_samples` every minute,
                          reads every healthcheck ever recorded to name a few dozen job ids the
                          jobs table can name from an index, and it was the single biggest
                          consumer in this worker. Samples whose job row is GONE are no longer
                          hunted for, because nothing here deletes a job row. The route is an ADMIN route like the rest of the queue reads and is fetched
                          PER EXPANDED ROW, not with the queue page — 25 rows would otherwise
                          carry thousands of points nobody looked at; an unknown job answers with
                          an empty series rather than a 404, since a job that never beat and one
                          that does not exist are the same thing to the view.
                          GAMES MIRROR (games table + src/worker/games.ts + the cron in
                          index.ts): every minute a scheduled handler (which also prunes job_samples —
                          see JOB SAMPLES above) reads api.bar-rts.com's replay listing
                          (/replays?page=<n>&limit=50&hasBots=false&endedNormally=true;
                          GAMES_BASE_QUERY + gamesPageUrl) and records the games this worker
                          has not seen. It is the OTHER half of the picture: `replays` is what somebody
                          captured, `games` is what was PLAYED, keyed by the same gameId, so the
                          two are views of one game and a row in `games` with none in `replays`
                          is a re-sim candidate nobody has to paste a link for. It is SERVED
                          to the landing page's "Games" section (see the landing-page entry
                          above) by GET /api/games -> ReplayIndex.gamesPage: one page,
                          latest-ENDED first, KEYSET-paged — ?after=<endUnix>:<id> is the
                          order key of the previous page's last row (games.ts
                          encodeGamesCursor/parseGamesCursor; the reply's `next`, null on
                          the last page) and the query resumes strictly after it. The order
                          key is games.END_UNIX, a STORED column (start + duration, written
                          by gamesInsert, backfilled by the schema-7 migration) rather than
                          the expression it replaced, so it can lead the four (x, end_unix
                          DESC, id) indexes the listing walks: games_end (the plain listing
                          and every walk below), games_map_end, games_count_end and
                          games_durmin_end (on duration_sec / 60). A page deep in the
                          mirror costs the same as the first (rowcost.test.ts bounds it),
                          where an OFFSET stepped over every row before it and shifted under
                          a list that gains a game a minute. Games with no start (none
                          observed) are not listed. Each row is joined with whether a
                          playable catalog row exists and the state of the game's last job,
                          both seeks. No total and no count anywhere: `next` is read off one
                          row more than the page shows.
                          FILTERS (the Games page's bar, the replay list's own, moved there
                          by app.js placeFilters): from/to on END time, map (exact),
                          min/maxPlayers, min/maxDuration, idPrefix (?id= is fetch-by-ids
                          below), settings — parsed by the same parseReplayFilter. NO player
                          name: the mirror's rosters are indexed nowhere (see ROW BUDGET).
                          gamesPage DRIVES the walk from the most selective index the filter
                          names — the PK range for an id prefix of 4+ characters, else
                          games_map_end, else ONE seek per player count (lo..32 plus a "> 32"
                          branch) or per duration minute (lo..90 plus "> 90"), merged by end
                          — and checks everything else row by row. Settings chips are such a
                          per-row check (an EXISTS on replay_settings' covering index), never
                          a driver: the common flags hold most games, and a rare one (lava
                          ~2%) is too sparse to drive by end order without sorting all its
                          rows. A walk stops after GAMES_SCAN_MAX = 2000 rows; when that cut
                          it short before the page filled, the reply says `partial: true`
                          and `next` resumes past what was searched, so the page reads "Next
                          keeps looking" instead of a short page passing for the end.
                          FETCH-BY-IDS: ?id=<id>[,<id>...] (up to 100 ids) answers exactly
                          the named games instead of a listing page (ReplayIndex.gamesByIds:
                          chunked IN() PK seeks with the same per-row joins, rows in asked
                          order, unknown ids absent, `next` always null; limit/after are
                          ignored beside it, a malformed or over-count id list is a 400).
                          The columns deliberately echo the catalog's vocabulary (start_unix,
                          duration_sec, map, game_size, player_count, players, settings) plus
                          what only the API knows: map_file (what BAR's maps API keys on),
                          preset (duel/team/ffa, stored verbatim so a value the API adds later
                          survives), and engine_version/game_version — the two builds a re-sim
                          must run and nothing else.
                          Enough pages to cover the last 2h of START TIMES, not one page:
                          the listing is ordered by start time DESCENDING, so a game that
                          started a while ago sits deep in it the moment it ends (at ~2000
                          games/day one that started ~90 min ago is already ~120 rows down),
                          and the old single 24-row page never saw it — long and older games
                          were silently missed. So the sync now walks pages of GAMES_PAGE_LIMIT
                          (50) until the oldest start on a page is at least GAMES_COVERAGE_SEC
                          (2h) old, or a short page ends the list, or GAMES_MAX_PAGES (6, ~300
                          games) caps it — the cap being what keeps a clock skew or a listing
                          that never ages out from turning the once-a-minute cron into a walk
                          of history (a gap bigger than the window is a backfill, a different
                          job). Every game that STARTED within the window is therefore seen
                          whatever its length; games LONGER than 2h can still slip past, which
                          a start-time window cannot help. Page 1 failing is the run; a LATER
                          page failing ends the walk with what earlier pages gathered. Two
                          things keep this inside the ROW BUDGET: the page cap bounds the fetch,
                          and gamesUnknown — now handed a whole window of ids at once — CHUNKS
                          its IN(...) (past SQLite's bind-param cap otherwise) into PK-index-
                          backed seeks, so its cost is the id count, not the mirror's size
                          (rowcost.test.ts bounds it). The LISTING
                          carries no modoptions, so each genuinely NEW id costs one
                          /replays/<id> detail fetch — 4 at a time, once per game, never again —
                          which is where settings and the roster come from, through the same
                          settingsFlags/playersFromApi the admin refresh route uses, so a
                          mirrored game and a refreshed catalog row read identically. Known ids
                          cost nothing: a steady-state tick is ONE request (gamesUnknown filters
                          the page first). A detail that fails is simply not recorded, so the
                          next tick retries it; a detail whose createdAt is under
                          DETAIL_SETTLE_SEC = 5s old is likewise left for the next tick
                          (`unsettled` in the result and the log line): the BAR API creates
                          the replay row first and inserts its players one at a time over
                          ~1s (measured 2.4s worst on 200 games), and a detail read in
                          between is missing players — an 8v8 landed as "7v6" that way, 3 of
                          200 recent games — and nothing ever re-reads a mirrored game, so
                          it would stay wrong; a failing LISTING throws (that is the run), and
                          the handler logs rather than rethrows, since a minute-by-minute stream
                          of failed crons is worse signal than one self-healing blip. Nothing is
                          logged on a tick that changed nothing.
                          BACKFILL (guarded POST /api/games/backfill + tools/backfill-games.ts):
                          the cron only ever reaches back GAMES_COVERAGE_SEC (2h) from the
                          newest game, so games an older build missed (the pre-2h-window one
                          silently dropped ~12% of a 48h span, almost all >30min) or any gap
                          wider than the window are beyond it. The route is the manual recovery
                          door: its body is verbatim /replays/<id> details (a bare array or
                          {games:[...]}), which it maps through the SAME gameFromApi the sync
                          uses, dedups with gamesUnknown and inserts — making NO outbound call
                          itself, so the free plan's 50-subrequest-per-invocation cap is a
                          non-issue and the batching lives in the caller. tools/backfill-games.ts
                          is that caller: from a trusted host it pages the BAR listing back
                          --hours, subtracts what the mirror already has, fetches the detail for
                          only the missing games, and POSTs them in batches with $REPLAY_PUT_TOKEN
                          (--dry just reports the count). Re-running is a no-op (gamesUnknown).
                          ?refresh=true skips that dedup and REWRITES the named rows from the
                          posted details (gamesInsert is an upsert that leaves the lobby
                          columns alone) — `backfill-games.ts --refresh <id>,<id>` is the one
                          command that repairs a row mirrored from a half-written detail.
                          LAVA SYNC (src/worker/lavasync.ts + the LAVABALANCE service binding
                          in wrangler.jsonc): freshly-finished candidate games are handed to
                          the sibling lavabalance worker (claudebar/lavabalance, same account
                          — the LOS OpenSkill ratings for the lava game mode), which ingests a
                          game as the VERBATIM /replays/<id> detail POSTed to its open
                          /api/games — plus, when the teiserver poll matched a lobby onto the
                          game, the lobby info as EXTRA top-level fields on that detail
                          (lobbyName + the lobbyDetails blob with the party roster; the BAR
                          reply carries neither key, so nothing collides; an unmatched game
                          submits the plain detail). VERBATIM is load-bearing beyond the tweak
                          classifier: the detail's per-player `rank` is how lavabalance learns
                          each player's CHEVRON at game time (it stores it per game, in
                          game_players.bar_rank), and nothing here selects fields, so that
                          arrives for free — tests/lavasync.test.ts pins the property rather
                          than the plumbing. That is why the cron runs the LOBBY sync
                          BEFORE this one: the match is arrival-driven, landing on the same
                          tick `lavaCandidates > 0` triggers this sync, and a submission that
                          ran first would hand lavabalance the game without its parties —
                          which is also why lobbiesMatch CLEARS lava_offered_unix, giving a
                          game whose lobby landed late exactly one re-offer (the UPDATE is
                          write-once on lobby_name, so it cannot loop; lavabalance fills a
                          NULL lobby column on a game it already holds).
                          WHAT BARREPLAY REMEMBERS: which games it has offered, one mark per
                          game — games.lava_offered_unix, set by ReplayIndex.lavaMarkOffered
                          after lavabalance ANSWERS a batch, read by gamesLavaPending. A run
                          that throws marks nothing and the next re-offers the lot, so a crash
                          still costs nothing; re-submission comes back "duplicate". CANDIDATES
                          are the mirror's LAVA-SHAPED games: the `lava` flag (map_waterislava)
                          on an 8v8 roster — what lavabalance itself requires of every game it
                          stores — offered oldest-STARTED first, because its fold runs forward
                          from a (startTime, id) head and stores anything behind it unranked
                          for good. Its classifier stays the authority on what a lava game IS
                          (the mode ships as tweakdefs; only it reads those).
                          WHY, because both halves replaced something that deadlocked from
                          2026-09-11 to 09-14: the sync was STATELESS, deriving its queue from
                          lavabalance's newest STORED game (GET /api/games?limit=1) and offering
                          everything that ended at/after it, and its pre-filter was the MODS
                          flag on the theory that tweaked games are rare (~0 in 24). Both were
                          measured wrong. There were 405 modded games in three days, and since
                          lavabalance stores only what its classifier accepts, every one it
                          declined stayed ahead of the watermark: a night of zombie and
                          noob-friendly lobbies left 33 such games in front of the queue, past
                          MAX_LAVA_BATCH=20, and the sync re-offered the same 20 rejects hourly
                          for three days while 72 real lava games queued behind them. Nothing
                          logged an error because nothing failed — hence `more` in
                          LavaSyncResult, so a backlog says so in the log line. A queue whose
                          head can be held by work the consumer refuses has to be drained by
                          the producer.
                          CADENCE: a tick that just mirrored a lava-shaped game
                          (GameSyncResult.lavaCandidates > 0 — known for free from the details
                          the games sync already fetched, and deliberately the SAME predicate
                          as the query, since the two drifting is what hid the stall) runs it
                          at once, plus one hourly sweep (LAVA_SYNC_MINUTE), which is both the
                          retry after a failed trigger and what drains a backlog — never every
                          tick, because the candidate query (ReplayIndex.gamesLavaPending: the
                          (flag, replay_id) index seek for 'lava' + a games PK seek each,
                          rowcost-bounded) costs the count of lava-flagged games ever mirrored,
                          and 1440 of those a day is the ROW BUDGET pattern to avoid.
                          LAVA_OFFER_HORIZON_SEC (7 days) bounds that query and the first run
                          after the column was added, when every lava game in the mirror is
                          unoffered and nearly all are long since stored; if the count ever
                          grows enough to matter, the shape that fixes it is a pending-work
                          table, not a wider index. DRAINING: a run works through the queue
                          in batches of MAX_LAVA_BATCH=20 — one POST and one lavaMarkOffered
                          each — and keeps going until the queue is empty or MAX_LAVA_RUN=200
                          games. The BATCH is the unit of progress (marked before the next is
                          read), which is what makes the loop safe: a run that dies in batch
                          four keeps one to three, and the next run resumes. MAX_LAVA_BATCH
                          was once described as a per-invocation SUBREQUEST cap; that was
                          reasoning from the FREE plan's 50, and this Worker is on Workers
                          PAID, where the limit is 10,000 (200 details + 10 service-binding
                          POSTs = 210). The ceiling is there for the limits that are real at
                          this size: api.bar-rts.com's goodwill — politeness here is
                          structural, no backoff anywhere, just DETAIL_CONCURRENCY=4, one
                          detail per game ever, and this cap — and the cron's envelope (30s
                          CPU under an hourly interval, 15min wall; ~10-15s at 200). Two
                          things end a run early rather than press on: a batch whose every BAR
                          detail failed, and a batch that comes back entirely already-taken,
                          which means marking did not shrink the queue and continuing would
                          re-fetch the same games to the ceiling. A failed BAR detail is left
                          unmarked and retried next run; DETAIL_TIMEOUT_MS=8000 keeps a hung
                          one from holding a multi-batch run open across ticks.
                          lavasync.ts is pure like games.ts (both
                          fetches injected — the cron passes the service binding's), tested
                          in tests/lavasync.test.ts; the vitest pool STUBS the LAVABALANCE
                          binding (vitest.config.ts), since without one workerd refuses to
                          boot over a service binding to a worker the test runtime lacks.
                          The lavabalance worker needs NO change and no redeploy ordering: a
                          service binding invokes its ordinary fetch handler.
                          Mirrored games index their SETTINGS into the SAME replay_settings
                          table as the catalog — ROSTERS are indexed NOWHERE: replay_players
                          is gone (the migration drops it), because keeping the mirror's
                          rosters indexed cost ~48 rows written per game — 16 names, each a
                          row plus two index entries, ~2000 games a day — which alone spent
                          the free tier's 100k-rows-written daily allowance and took every
                          route down (see ROW BUDGET); the player filter reads the roster
                          JSON on the catalog rows directly instead.
                          Ownership stays the one rule to keep:
                          exactly one row owns an id's replay_settings entries — the catalog
                          row if there is one (its flags are the capture that was published),
                          the games row otherwise — enforced by gamesInsert skipping an id
                          `replays` holds. The same rule shapes the maps list: only upsert
                          feeds unique_values('maps'), so a mirrored game's map — thousands of
                          games nothing has published — never becomes a filter option that
                          matches no listable replay.
                          index.ts therefore exports `{ fetch, scheduled }` rather than the Hono
                          app itself — a cron handler cannot live in app.ts, which stays free of
                          workerd imports so the node tests can drive it. games.ts keeps that
                          same freedom (it takes the index and `fetch` as arguments), so
                          tests/games.test.ts drives the whole sync against a fake API. The SQL
                          half — the table, gamesUnknown's dedupe, the ownership rule, the
                          maps-list maintenance — is tests/do/replayindex.test.ts, running INSIDE
                          workerd under @cloudflare/vitest-pool-workers (vitest.config.ts,
                          bindings read from wrangler.jsonc, so the test worker cannot diverge
                          from the deployed one; `npm test` runs both suites). That version of
                          the pool has NO per-test storage isolation to configure — vitest-3's
                          isolatedStorage is not among its options — so each test addresses its
                          own DO instance rather than the production idFromName("index").
                          End-to-end was checked once by hand:
                          curl /cdn-cgi/handler/scheduled against `vite dev` mirrored 24 real
                          games, and the second call added none.
                          LOBBY NAMES (teiserver poll, src/worker/teiserver.ts + the same
                          cron): the tick's second step — BEFORE the lava sync, see its entry
                          — and again 30 s later in the same invocation (index.ts
                          LOBBY_POLL_SEC: the cron's minute is too coarse) — because a mirrored game carries no
                          LOBBY NAME — that exists only while the lobby is alive, on
                          teiserver's web UI (server4.beyondallreason.info/battle/lobbies, a
                          Phoenix dead render scraped with small regexes; parsers and the
                          cookie-jar CSRF login adapted from mabn/claudebar). The first tick a
                          lobby is seen in progress opens an OBSERVATION in the DO's `lobbies`
                          table — name, map, started_unix back-dated by the page's own running
                          clock, and the NON-SPECTATOR roster from one show-page fetch
                          (spectators churn; the roster is captured at the start, when it is
                          most honest; a failed show fetch records the observation with a null
                          roster rather than dropping it — that moment never comes back).
                          The show page's whole players table is kept, not just the names:
                          parseLobbyShowRoster resolves team/PARTY/rating/bonus/faction per
                          player by header label, and that roster
                          plus the index page's locked/passworded/member/spectator counts
                          land in ONE lobby_details JSON column (teiserver.ts LobbyDetails,
                          the jobs.stats pattern — nothing filters on it in SQL). The flat
                          `players` name list stays what the MATCH reads, untouched.
                          THE LAST STATE BEFORE THE GAME ENDED (lobby_details.end, LobbyEndState):
                          each tick compares a running lobby's index row (map | player count,
                          teiserver.ts lobbySig; spectators churn and are left out) with the
                          lobbies.seen_sig last recorded, and on a change re-reads the show page
                          and overwrites `end` (ReplayIndex.lobbiesUpdate, json_set) — so who left
                          or dropped, and a map switched after the lobby went in progress, are
                          kept, and the match accepts the end map and roster as well as the start
                          ones. Only changes write (a few per game), never a row per lobby per tick.
                          PARTY IS A COLOUR, NOT TEXT (teiserver.ts partyKey): teiserver
                          gives each party of 2+ a distinct background colour and renders an
                          otherwise EMPTY cell — `<td style="background-color: #62ea6b;"
                          width="50">&nbsp;</td>` — so the parser takes the RAW `<td>` and
                          reads the colour, normalized to lower case, as an opaque key
                          (equality only; unstyled cell = unpartied; a key always means a
                          real party, since teiserver colours nothing else). Reading the
                          cell's TEXT is the trap and it shipped once: every field around it
                          parsed fine while `party` came back null for 1093 players across
                          89 games, because the cell really is empty. The fixture in
                          tests/teiserver.test.ts therefore carries the colour markup — a
                          fixture with party text in that cell tests a rendering that does
                          not exist. Same rule, and the same parse, as claudebar's
                          lavabalance/src/teiserver.ts, which drives these same pages.
                          When the finished game later reaches the rts-api mirror,
                          ReplayIndex.lobbiesMatch pairs them: no shared id exists, so the
                          match is same map (normalized) + started within [-600s,+300s] of the
                          game's start + >=50% roster overlap (lowercase names; a null-roster
                          observation passes on map+time but scores below any real roster).
                          It is ARRIVAL-DRIVEN, from the games side: each run considers the
                          games MIRRORED since the last one (games_synced index, watermark in
                          schema_meta) and then the observations that started around THEM —
                          not every unnamed game inside some open observation's window, which
                          is the same set reached from the end that costs a slice of the
                          mirror as old as the oldest observation, re-read every minute
                          forever (see ROW BUDGET). Nothing is lost: the observation is always
                          the older of the two — opened while the lobby was still PLAYING the
                          game, where the game reaches rts-api only once it has ended — so a
                          game that did not match on the tick it landed has nothing new to
                          match against on the next one. The two questions asked of `lobbies`
                          every minute (which observations are open, which matched ones are
                          old enough to drop) each answer to a PARTIAL index, because the
                          table keeps every unmatched observation forever.
                          Best candidate WINS ties (smaller time delta) — a name on the row
                          beats abstaining — one-to-one both ways, and the name lands in
                          games.lobby_name (+lobby_id), which is deliberately OUTSIDE
                          gamesInsert's upsert list so a re-sync cannot erase it. The same
                          write-once UPDATE also COPIES the observation's lobby_details onto
                          the games row (equally outside the upsert list): the observation
                          is pruned 48h after a match, so match time is the detail's only
                          route to permanence. GET /api/games serves it parsed as
                          `lobbyDetails` (GAMES_LIST_SELECT/gameListRow, both the listing
                          and ?id=); /api/replays deliberately does not. A match
                          also RETIRES its observation (ended_unix): the matched game has
                          certainly ended even if the lobby never left the in-progress set
                          (back-to-back games inside one cron gap), so the next tick opens a
                          FRESH observation for the game the lobby is running by now — one
                          lobby names game after game, one `lobbies` row per game (the
                          composite key (lobby_id, started_unix); name/map/roster are all
                          per-game, so renames between games record correctly). Matched
                          observations prune after 48h; unmatched ones are kept forever as
                          the record of why a game has no name. GET /api/admin/lobbies/misses?hours=N
                          (ReplayIndex.lobbyMisses, teiserver.ts lobbyNearMisses) reads that record: every
                          game that ended in the window with no lobby, its nearest observations and which
                          gate (map, time, roster overlap) each failed. Measured 2026-11-01: ~3.5% unmatched. SERVED: the DO's list JOINS
                          lobby_name per read (a scalar subselect on games' primary key;
                          games.map_file rides the same join into `mapFile` — the archive
                          name behind the list's 18px map THUMBNAILS, fetched lazily from
                          /api/bar/maps/<file>/texture-thumb.jpg (the caching BAR proxy,
                          see the map terrain note under the viewer); rows without a
                          mirror row fall back to mapFileGuess and a wrong guess just 404s
                          into no thumbnail via onerror), so
                          GET /api/replays rows carry a `lobbyName` — never stored on the
                          replays row, never accepted from a PUT, appearing the moment the
                          match lands with no republish; a backend without the mirror omits
                          the key entirely, which is how the front-end knows not to offer
                          the column. In the LIST the Players column header is a SWITCH
                          (app.js playersColumn): clicking it swaps the column between the
                          rosters and the lobby name (dash when unmatched) — offered only
                          when any row carries the key, since a toggle to a column of dashes
                          on the Go backend would be worse than none. The choice lives in
                          the URL (?col=lobby, replaceState like the filters, absent =
                          players so a fresh URL stays clean; replayHref carries it into a
                          replay), and on a backend without the field a ?col=lobby link
                          degrades to players without touching the param, like a /queue link outside admin mode. The web SESSION (the Guardian
                          cookie jar) persists in the one-row teiserver_session table, so the
                          steady state is ONE authed GET per tick, no login (an expired
                          session shows as a redirect to /login: drop the cookie, log in once,
                          retry). Credentials are the TEISERVER_EMAIL/TEISERVER_PASSWORD
                          wrangler secrets; without them the step is skipped entirely, its own
                          try/catch keeps a teiserver outage from costing the games sync, and
                          TEISERVER_BASE (dev only) points the poll at a mock. teiserver.ts is
                          pure like games.ts (injected fetch, a narrowed LobbyIndex port), so
                          tests/teiserver.test.ts drives parsers, session and sync against
                          fixtures modelled on captured real pages; the SQL half lives with
                          the DO tests. Note the workerd trap it dodges in webFetch: calling
                          an injected global fetch as `this.fetchImpl(...)` binds `this` to
                          the session and workerd throws "Illegal invocation" — detach first.
                          QUEUE BUTTON (app.js queueGameButton): beside it in the same admin
                          column, each Games row has a Queue button POSTing {link: id, force:
                          true} to /api/admin/resim. force swaps resimEnqueue for jobAnnounce,
                          so an admin can queue a PUBLISHED game too (a one-sided upload, a
                          capture worth redoing); it still dedupes on an active job and
                          honours a disabled one. A row whose job is pending/processing shows
                          a disabled "Queued".
                          LAVABALANCE PREVIEW (app.js previewLavabalance, index.html
                          #lbdialog): each Games row carries an admin-only (signed in)
                          LOS button — lavabalance, the sibling worker keeping the LOS
                          (OpenSkill) ratings, ingests a game through its open POST
                          /api/games, whose body is the VERBATIM api.bar-rts.com/replays/
                          <id> detail in a one-element array. The button opens a native
                          <dialog> showing exactly that body — fetched by the BROWSER, the
                          way the map loader talks to the same API (it allows any
                          origin), so no worker route exists — plus a paste-ready curl
                          (lavabalanceCurl) that
                          pipes the detail from the BAR API into the POST, with nothing
                          inlined that shell quoting could mangle. The page POSTS NOTHING:
                          the upload is the operator's shell command, so a wrong click
                          costs a look, not a row in the rating fold. The AUTOMATIC push
                          is the LAVA SYNC (see the games-mirror entry): the cron submits
                          candidates over the LAVABALANCE service binding; the button stays
                          as the manual door and the way to see exactly what is sent.
                          WIDGET-INSTALL GUIDE: the dropzone banner links (relatively, so it
                          resolves on any origin serving the page) to /setup — public/setup.html, four numbered
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
                          REDIRECT LOOP.
                          ROW BUDGET (the constraint behind half the SQL above): the DO's
                          SQLite is billed by ROWS READ — every row a query scans, index
                          entries included — and the Workers Free plan allows 5 million a DAY
                          (100k rows WRITTEN, 5 GB stored; paid is 25 billion reads/month).
                          Three callers here are machines on a timer: the cron every minute,
                          and an ingest daemon polling every 10s from each host running one.
                          So a query whose cost is the size of a TABLE rather than the size of
                          its ANSWER is not a slow query, it is an outage on a schedule — and
                          it was one: a full scan of the games mirror per poll, the whole
                          catalog listed per poll, and a `SELECT DISTINCT job_id FROM
                          job_samples` per cron tick together read ~15x the daily allowance,
                          after which EVERY route 500s ("Exceeded allowed rows read in
                          Durable Objects free tier", thrown from the constructor, since that
                          is where the first SQL of any request runs) until the counter resets
                          at 00:00 UTC. The tables that make this bite all grow forever and
                          none of them is bounded by anything a person does: the mirror gains
                          ~2000 games a day, job_samples a point per running job per 10s.
                          worker/tests/do/rowcost.test.ts is the guard — it seeds tables far
                          bigger than the deployment's and asserts each polled and cron read
                          stays SMALL, so a new scan fails the suite instead of the account.
                          The WRITE allowance bites the same way and also did: the mirror's
                          roster indexing wrote 59 rows per game (index maintenance bills a
                          row per index per insert — non-obvious from the statements), which
                          at ~2000 games/day exceeded 100k/day on its own; the fix was to stop
                          indexing mirror rosters (see the games-mirror entry above), and
                          rowcost.test.ts now bounds the recurring writes too. NOTE the
                          overage enforcement gates EVERY SQL statement once either daily
                          budget is spent — reads included, and a plain SELECT then throws
                          the WRITE-overage error ("Exceeded allowed rows written") if that
                          is the budget that ran out — so the ReplayIndex constructor never
                          lets a failure escape: schema DDL runs only when the read-only
                          schema_version stamp check (schemaCurrent) says it is due, and
                          both the migration and the versioned derived rebuild log-and-serve
                          on failure, retried on every construction until they land.
                          The rule for anything added to those paths: bound it in SIZE (an
                          index, or an explicit window) and, if it cannot be, in RATE (a
                          cooldown, a watermark, an hourly tick). queuePage was the latest
                          to go: its unfinished-first CASE led the ORDER BY, which no index
                          can satisfy, so every read joined and sorted the WHOLE jobs table
                          (measured live: 2122 rows to return one, on 451 jobs that are never
                          deleted). It is now two indexed queries assembled in the method —
                          the in-flight set read whole off jobs_state (bounded by work in
                          flight, which drains), the settled rows walked in display order off
                          the jobs_settled PARTIAL index (over exactly the rows heartbeats
                          never touch, so a beat costs it nothing) and stopped at the page
                          edge — plus `total` from a maintained schema_meta counter
                          (jobs_count, incremented by jobInsert, sound because nothing ever
                          deletes a job row) and `active` free off the in-flight set already
                          in hand.
                          SQL STATS (GET /api/admin/sqlstats): the LIVE counterpart of the rowcost
                          suite — the DO bills every statement's rowsRead/rowsWritten to the
                          public method running it (installSqlAccounting: an exec shim plus
                          per-method wrappers, outermost method wins so helpers bill their
                          caller) and serves the tally per method with `since`/`elapsedSec`,
                          because the numbers mean nothing without their window. IN MEMORY —
                          persisting a measurement of the write budget would spend it — so a
                          deploy or eviction resets it (the cron keeps the instance warm
                          between those). A single call past SQL_WARN_ROWS_READ/_WRITTEN
                          logs itself, which is how a new scan announces itself in the live
                          logs without an event per poll.
                          (The third of the three read scans, the re-sim
                          daemon listing the whole catalog every ten seconds, is gone entirely:
                          the publish announces that work now — see PUT /api/replays above.)
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
                          shows those jobs — one row per job with its game (plus a copy-id
                          button), MAP, START time (the header toggles it to the END time,
                          kept in localStorage), SIZE, DURATION, SETTINGS pills, a gex link, the KIND, state, what the
                          work TOOK, age and failure detail, a link to the replay ONLY once it
                          is published (the row's `published`, joined by QUEUE_SELECT: a catalog
                          row that is not a placeholder; plain text until then — it used to be
                          read off replayList, a filtered page, and linked out to bar-rts.com),
                          and a count of the jobs in flight on the menu entry
                          itself. The table spans the full width (no 1650px cap). Size, duration,
                          map, start and settings are JOINED ON by the worker
                          (ReplayIndex.queuePage), not stored on the job: the jobs table knows a
                          gameId and nothing else, and a queue of bare ids cannot answer the
                          first question anyone has about an hour of engine time — is this an
                          8v8 worth it, or a three-minute duel? The catalog is preferred (it
                          describes what was actually captured) and the games mirror is the
                          fallback, which is what covers a re-sim of a game nobody has uploaded,
                          i.e. most of this queue; a game NEITHER knows (a drag&drop upload from
                          a private lobby) lists with an empty `game` and dashes. That query is
                          the one place three tables meet, and every column in its ORDER BY is
                          qualified because `id` is in all three and `updated_unix` in two — an
                          unqualified one there is an ambiguous-column ERROR, not a wrong answer.
                          The gex link is always present, unlike the Game cell's bar-rts
                          fallback, which is only there while the game is unpublished here. Above the table sits the re-sim paste box (app.js initResim/
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
                          (queueOpen), NOT in the URL — unlike the section path and the filters, "the third
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
                          on a "processing" row means nobody is home. A failure the daemon could
                          NAME carries a chip beside the state (ERROR_KIND_LABELS in app.js, the
                          front-end half of JOB_ERROR_KINDS): "out of memory" is the one worth
                          spotting down a column of red rows, since it is a fact about the host
                          rather than a verdict on the replay. A kind the page has no label for
                          renders as a plain error, exactly as an unclassified failure does.
                          The row's last cell is the ACTION MENU (actionCell; a FAILED row also
                          gets its retry as an always-lit button beside it, "Re-sim" for a
                          re-simulation): one ⋯ button
                          opening a dropdown (one open at a time, closeJobMenus on any other
                          click or Escape) with what can be done to the job. Disable/Enable
                          (setJobDisabled -> POST /api/admin/jobs/<id>/disabled, see the worker
                          entry) is offered only on a pending or running job — a finished one
                          is already never handed out, so a switch there would do nothing — or
                          a disabled one, so it can be let go. RETRY (retryJob -> POST
                          /api/admin/jobs/<id>/retry -> ReplayIndex.jobRetry) is offered on a
                          finished or failed job and queues the SAME work again under a FRESH
                          id — a re-sim through jobAnnounce (so a job already covering the game
                          is handed back as "duplicate"/"disabled" and the page says so), an
                          upload against its archived stream. Never in place: the old row is
                          the record of the attempt, its error, stats and samples. It exists
                          because a failed re-sim had no door from the browser — the paste box
                          refuses a game with a job row and POST /api/jobs takes a bearer token.
                          The menu stopPropagations, since the row itself is an expand toggle.
                          A menu rather than a row of buttons because the entries grew past
                          one and the cell is the narrowest thing on the page. A held-back
                          row reads "disabled" in the STATE column rather than "pending", which
                          would be the misleading half of the truth on something nothing will
                          ever pick up (the real state rides the tooltip); the button is ghosted
                          until the row is hovered, except on a disabled row where it stays lit,
                          since that is the row somebody is looking for.
                          CHARTS (app.js jobCharts/buildChart, styles .jobcharts/.chart*): the
                          expansion also draws the job's whole healthcheck history, fetched then
                          and only then (loadJobSamples, cached per job and dropped by an
                          explicit re-read so a fresh page never sits beside a stale curve).
                          FOUR SEPARATE PLOTS — engine memory, engine CPU, simulation, and the
                          estimated time left (the one series that should be going DOWN: a
                          stretch where it climbs is the run getting slower faster than it is
                          getting on, which no other chart states outright) — never
                          one with four scales: bytes, percent-of-a-core and percent-of-a-game
                          share no axis, and overlaying them would invent a correlation that is
                          not in the data. They share an X (the same beats), which is what lets
                          ONE crosshair read all four at a moment, with one tooltip listing
                          every measure plus the phase (what explains a flat stretch); the same
                          readings come from keyboard focus + arrows, so no value is behind a
                          pointer. ONE hue for all three (style.css --lilac, the colour the
                          collapsed row's bar and every "processing" chip use, on --well): each
                          chart has a single series, so colour carries no information and the
                          title is what says what is plotted — and a single series needs no
                          legend. Marks are 2px lines over a 10% wash with hairline SOLID grid
                          one step off the surface. The line BREAKS over a gap rather than
                          drawing through zero (an engine that had not started is missing, not
                          idle), and a measure the run never reported gets no plot at all, since
                          an empty axis would claim a reading of zero. Exactly one direct mark
                          per chart (spec.mark), chosen to say what the axis cannot: on an
                          autoscaled chart the top tick IS the peak, so 'peak' draws a bare dot
                          (WHEN it happened); 'last' labels where the run ENDED UP, which is what
                          simulation and the ETA need since their axes say nothing about this
                          particular run — for the ETA that is "how much was left when it stopped
                          reporting", the whole story of one that died. simulation additionally
                          fixes its domain 0-100 because the whole is known; autoscaling would
                          draw a stalled run exactly like a finished one.
                          SWAP is the exception that skips itself (spec.skipIfZero): zero is the
                          healthy answer and very nearly always the answer, and a flat line along
                          the baseline of an axis reading "1 B" is worse than no chart — so it is
                          drawn only when the engine actually swapped, and its APPEARING is the
                          signal. The zero case is still stated in words in the grid above
                          ("Engine swap: none"), which is where it belongs: a line that showed up
                          only in the bad case would leave every healthy run silent about the one
                          thing being watched for. The one-line Detail summary is the opposite —
                          it carries swap only when there IS some, being already five readings
                          long.
                          Both formatters exist for a reason —
                          `tick` must fit the 46px gutter, `fmt` has a tooltip line to explain
                          itself, and using one for both put "650% of one core" through the left
                          edge of the figure. For BYTE scales the tick is fmtSizeShort, not
                          fmtSize, for exactly the same reason one step further: "846.0 MB" is
                          nine characters and runs off the edge where "846 MB" does not, and a
                          tick is meant to be a round number anyway (the precise value is on the
                          direct label and in the tooltip). X labels are ELAPSED time, not clock
                          time: "it spiked at minute 32" is the reading.
                          It reads GET
                          /api/admin/queue (ReplayIndex.queuePage: unfinished jobs first, then the most
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
                          number is deliberately NOT in the URL (unlike the section path and the filters):
                          "page 3 of the queue" describes a moment in a pipeline, not a set of
                          replays, so there is nothing to share or restore. The route is ADMIN-GATED
                          (Cloudflare Access, see the landing-page entry), unlike the per-job
                          status the uploading browser polls, and it omits
                          the row's streamKey — the archive bytes are behind the bearer-guarded
                          /api/streams route and the view has no use for the key (GET
                          /api/jobs/<id>, the poll, answers with the same subset for the same
                          reason). It is distinct
                          from the daemon's GET /api/jobs, which is a WORK QUEUE (guarded, ONE
                          kind at a time, and it deliberately hides a healthy "processing" job —
                          precisely the row a person watching wants to see), and which also
                          MAKES work: a "resim" poll with nothing pending queues a mirrored
                          game nothing has published and returns that (ReplayIndex.jobsOffer).
                          WHICH game: TWO scans decide, asked in order.
                          FIRST the LAVA PRIORITY lookup (ReplayIndex.lavaCandidate): the
                          most recently ENDED 8v8 lava game of the last
                          LAVA_WINDOW_SEC=24h that is still a candidate. Its window is
                          measured in TIME, and that is the point — the ranked window
                          below is measured in RANK, and on a mirror the daemon cannot
                          keep up with (~2000 games a day against one publish an hour)
                          the head of that list never empties, so a game not among the
                          newest 200 candidates when a host is free is not merely
                          outranked, it is INVISIBLE and stays invisible forever.
                          Measured on the deployment: the two 8v8 lava games with no
                          capture sat at candidate ranks 1621 and 1634, eight windows
                          deep. Preferring lava inside the ranking would have found
                          neither — a rank the window never reads is not a rank. LAVA is
                          the settings flag (SETTINGS_LAVA_FLAG = map_waterislava), which
                          is the closest thing the mirror has to the mode lavabalance
                          rates: that mode ships as tweakdefs only its own classifier can
                          identify (see LAVA SYNC), but every one of its lobbies also sets
                          map_waterislava — over two days of the mirror, 42 of the 45 8v8
                          games carrying the flag were LAVA SUPREME hosts and the other
                          three were lava-map team games, the same thing to a spectator.
                          8v8 is the game_size SPEC, not player_count=16 (a 4v4v4v4 FFA is
                          16 players too). No ranking beyond recency inside it: every 8v8
                          is sixteen players. The walk is games_end stopped at the
                          window's edge, so it costs a DAY of BAR's output (~2200 rows,
                          measured; rowcost.test.ts bounds it) whatever the mirror has
                          grown to — a seek through every lava game ever mirrored would
                          grow forever, which the ROW BUDGET rules out on the 10s poll
                          path — and it stops at the FIRST match, so a lava game near the
                          head costs a handful. It rests LAVA_COOLDOWN_SEC=5min on the
                          EMPTY answer, longer than the ranked window's minute because
                          the empty answer is the common one here (an 8v8 lava game
                          finishes a couple of times an hour) and much more expensive
                          than jobsPending; its OWN meta key (lava_after), so neither
                          scan's rest can silence the other. Only the empty answer rests,
                          for the same reason as below.
                          LAVA ORDERING (Marcin, 2026-10-17: lava first, NEWEST first): a
                          resim poll's pending list is reordered with its 8v8 lava jobs at the
                          head, latest-ENDED first (lavaEnds), and the lava lookup runs even
                          when work is pending, jumping that list when its game ended later
                          than every queued lava game. The daemon runs ONE job per poll
                          (runQueued returns after it; the loop re-polls at once), so a lava
                          game that ends while another runs is what the next poll gets.
                          LAVA RETRIES (lavaRetryCandidate, after the pending list, before the
                          ranked window): a failed job is never re-offered by the scans, which
                          lost every lava 8v8 that ran out of memory on the 8 GB host (19 of
                          29 uncaptured in four days; the other 10 were the pre-1.11.1 widget
                          sandbox). The resim poll carries ?mem=<host RAM> (bringest, from
                          hostinfo), and a lava 8v8 whose jobs are all failures (none active,
                          done or disabled), with no catalog row, is offered again when it
                          ran out of memory and no host with >= this RAM ever did on it
                          (stats.host.memBytes; none = 0). No other failure is retried
                          automatically (Marcin's call). Walks the jobs_failed partial index over two weeks
                          (LAVA_RETRY_WINDOW_SEC), rests 5 min per GiB size on the empty
                          answer; a poll without ?mem= gets no retries.
                          THEN the ranked window: of the BACKFILL_WINDOW=200 most recently ENDED
                          eligible ones, the one
                          that is MODDED, and failing that the one with the MOST PLAYERS —
                          an hour of engine time buys an 8v8 as cheaply as the duel that
                          happened to finish a minute later, so within a window of games that
                          are all recent, size decides (ties go to the latest-ended, an unknown
                          roster goes last but is not refused). END time (start_unix +
                          duration_sec), not start time, because end order is ARRIVAL order:
                          the mirror only learns a game once it is over, so ordered by start
                          an hour-long game entered the walk already buried under the ~80
                          shorter games that started after it — which is how a 59-minute
                          modded 16-player FFA kept losing to fresh duels; and 200 rather
                          than 20 because a daemon that surfaces once an hour faces ~80 new
                          games each time, so a 20-game window meant "the last 15 minutes"
                          and the modded preference never had anything rare to prefer.
                          Modded beats bigger because it
                          is rarer and less replaceable: an 8v8 nobody re-simulates today is
                          one of forty played this hour, where a game running somebody's
                          tweakdefs is the only one of its kind, and those tweaks are most of
                          what a spectator view of it is FOR. The window is over
                          CANDIDATES, not over the mirror's last 20 rows: every game handed out
                          gains a job row and stops being eligible, so a window over raw recency
                          would be permanently empty after twenty of them and the daemon would
                          idle with thousands of games left. The rules are all about not repeating
                          work: only for kind=resim (an upload job is bytes somebody sent, and
                          there is no stream to invent); only a game with no catalog row and NO
                          JOB ROW AT ALL — finished and FAILED ones included, or a game that
                          cannot re-simulate would be handed out again every poll, an hour of
                          engine time at a time (pasting its link is still a retry, exactly as
                          for a failed request); and only into an EMPTY pending list, so at most
                          one auto-queued job ever waits — the next poll finds THAT one instead
                          of making another. Check and insert are one RPC, so two daemons
                          polling together cannot both take the same game. The MODS preference
                          is an EXISTS over replay_settings' (flag, replay_id) index, selected
                          as a column and RANKED on rather than filtered on, and the flag name
                          is a shared constant (SETTINGS_MODS_FLAG) rather than a literal the
                          query could silently stop matching. It was a refusal until it was
                          measured — modded games are ~0 in 24 of BAR's output, so excluding
                          them bought nothing and skipped the only games in the mirror that are
                          not interchangeable. A game with NO settings recorded (the API gave
                          none) is neither refused nor preferred; it ranks by size, as it did
                          before. And the scan is
                          cheap because it STOPS EARLY, not because it looks at a slice, and
                          because games_end — an index on (end_unix DESC, id, player_count),
                          end_unix being the stored end time (it replaced games_backfill_end,
                          an EXPRESSION index on start + duration that the ORDER BY had to
                          match textually) —
                          COVERS exactly what the walk reads, so it never touches the games
                          table and its id tiebreak needs no sort (the rowcost test guards
                          that the planner never sorts the mirror into a temp b-tree). It
                          walks games_end latest-ended-first and quits at the 200th
                          candidate, which on a mirror no host can keep up with is the first
                          two hundred rows
                          it touches. The distinction is the design. A fixed window over the
                          newest N games costs the same in the good case and LIES in the bad
                          one — with those N all taken it reports an empty mirror while
                          thousands of older candidates sit behind it, and the daemon sleeps
                          in front of a queue it cannot see (that shipped; the symptom was
                          "bringest: nothing queued to re-simulate" on a host with a backlog
                          of thousands). An empty answer must mean the MIRROR is empty. What a
                          stale head costs instead is one index entry and one row per game
                          stepped over — 861 rows to walk past 400 taken ones — and only once
                          the daemon has published its way through the recent past, which is
                          exactly when older work is the right answer. The RATE bound applies
                          only to the genuinely-empty answer (BACKFILL_COOLDOWN_SEC=60s, in
                          schema_meta — the cron's own period, since a new candidate can only
                          appear when the mirror gains a game). It is the one
                          query on the 10s poll path whose cost grows with the mirror — which
                          grows ~2000 games a day forever — and an unbounded walk of it 8640
                          times a day is what first exhausted the account's daily rows-read
                          allowance. Only the empty answer rests, because only it repeats: a
                          scan that queues a game is followed by the daemon going away to run
                          it, and every poll until it returns is answered by jobsPending out of
                          an index. Resting after a SUCCESSFUL scan is the same bug seen from
                          the other side — it put the deployment on a strict five-minute grid
                          for jobs that took ninety seconds, an engine host idle most of the
                          day; a minute of rest on the empty answer is the whole of what is
                          left. It makes a GET write,
                          which is the price of leaving the daemon's protocol untouched: a
                          backfilled job is indistinguishable from one a person queued a minute
                          earlier, so no deployed daemon needs to know this happens. The job id
                          comes from the ROUTE (crypto.randomUUID, like the other two job
                          creators), which is also what keeps the DO deterministic under test. A
                          backend with no ingest pipeline 404s the route; the section then says so
                          rather than showing an empty table that would read as "nothing is
                          queued", and asks it nothing further.
                          Uploads (tools/upload.ts) go
                          through tools/r2put.ts: parallel S3 PUTs when R2_ACCESS_KEY_ID/
                          R2_SECRET_ACCESS_KEY are set (fast, aws4fetch), else parallel `wrangler r2
                          object put`; a publish is one .brp, which is its own listing
                          marker; an older bundle's .brw heads upload after a completion
                          barrier so a half-uploaded replay never lists
snapshot/                 PUBLIC data model + pluggable Writer (owns the on-disk format: the .brp binary).
                          The Writer's record types are Meta, Frame, Event and Comm
                          (snapshot.Comm = one thing a player wrote or drew) plus the
                          re-sim's ANALYSIS records (snapshot/analysis.go, .brp v6): Fact
                          (game end, eliminations, departures, the weapon table, the
                          engine's team stats), Hit (every damage callin as the engine
                          delivered it), UnitEnd (where each unit's life ended),
                          Visibility (per-side LOS/radar per unit) and, since protocol 5,
                          Projectile (one track of a long-range projectile or one firing
                          of a heavy beam) and Blast (a strong explosion that ended no
                          track: a unit's own death blast, a cluster sub-munition) —
                          snapshot/projectiles.go, sections R and W. DamageWindow and
                          UnitLife (per-second sums, lifetime totals) are what
                          internal/combat DERIVES from the hits — and what older captures
                          stored, which is still read. snapshot.DiscardAnalysis
                          is the embeddable no-op for writers that want none of them.
internal/combat/          SOURCE DATA IN THE FILE, JUDGEMENT IN THE READER: Derive turns
                          the raw hits + unit ends + destroyed events into damage windows,
                          lives, credited kills (a chain of exploding reactors goes to
                          whoever killed the first; a shell landing after its shooter died
                          goes to the shooter's team) and the BIG BLASTS (Options:
                          thresholds, blast window). The widget used to do all of this
                          itself, which froze every choice into the capture; re-simulating
                          old games is the one expensive thing, so anything that might be
                          tuned lives here. Deterministic; experiments/brp-analysis runs it.
assets/lua/replay_uploader.lua   THE widget, in two modes (widget >= 1.8.0; the separate
                          snapshot_widget.lua sampler is gone). Published as-is it is the
                          player-installable live-game uploader. Injected by the Go tool
                          (engine.WriteWidget, embedded as assets.WidgetLua) with __RESIM__=1
                          and its switches substituted (__SAMPLE_EVERY__, __OUTPUT_PATH__,
                          __PROFILE__, __DISABLE_WIDGETS__, __DAMAGE__, __VISIBILITY__,
                          __PROJECTILES__ —
                          each compared against the literal "1", so the published copy with
                          the tokens left in place reads as the uploader) it is the
                          re-simulation sampler: GetInfo name "BAR Replay Snapshotter" (what
                          widgetconfig.go seeds), handler access, full view, max speed, the
                          default suite disabled, quitforce at game over, the "[barreplay]"
                          log tag, units at hp <= 0 recorded rather than buried (the grey
                          crashing aircraft), and the protocol-4 analysis records — killer
                          per death on E (as the engine gave it), G facts, H hits, U unit
                          ends, V visibility,
                          P profiler readings (docs/brepstream-format.md). cmd/barreplay's
                          -damage/-visibility/-projectiles (default on) map to
                          Config.SkipDamage/SkipVisibility/SkipProjectiles.
                          PROTOCOL 5 (widget 1.9.0, re-sim only) adds R projectile and beam
                          TRACKS, W blasts and the "stock" fact (design + measurements:
                          docs/projectiles-and-explosions.md). What is watched is classified
                          from WeaponDefs at Initialize (nukes, anti-nukes, EMP, tactical,
                          Junos, long-range artillery, rockets, heavy beams, and since widget
                          1.11.0 LONG-RANGE AA — class 9 "aa": damages[0] <= 1 like all AA, but
                          range >= 1500 and >= 100 to some other armour class, i.e. the
                          Mercury, the Screamer and leglraa's railgun; a homing one has its
                          path sampled like a strategic track; death/self-d
                          explosions with damage >= 400 and radius >= 64), never from unit
                          names — mods change the numbers. Captures from older widgets hold no
                          AA tracks: the widget never recorded them, so only a fresh re-sim
                          shows them. Two non-obvious mechanisms: LuaUI
                          MAY watch explosions itself (Script.SetWatchExplosion), but BAR's
                          handler does not forward Explosion, so the widget installs it the
                          way it hooks UnitDamaged (handler UpdateCallIn, which needs an
                          ExplosionList to exist); and ProjectileCreated never reaches LuaUI,
                          so a launch is found when a tracked launcher's reloadFrame changes,
                          in GameFramePost (after the frame's unit and projectile updates),
                          by a GetProjectilesInSphere around its muzzle. A beam is one record
                          per firing: the engine fires a beamtime beam as one beam per frame,
                          each ending in an Explosion at its hit point. The section lives in
                          one closure (`local projectiles = (function() ... end)()`) because
                          the main chunk was at Lua 5.1's 200-local limit. The blast record is
                          W, not B: a B where a record tag is expected is the start of a
                          segment's header line. The uploader mode records G end/teamdied/
                          playerleft facts and "given" events but never a killer.
                          The uploader mode has ONE more substitution token (__WIDGET_SHA__, stamped by
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
                          than the retired text stream) — named via the "GameID" GameRulesParam
                          (BAR's game_id.lua gadget; barwidgets.lua does NOT forward the
                          engine's GameID callin to widgets). Since 1.6.0 it also
                          records what players WRITE and DRAW ('C' records — see the
                          chat/drawings note under the wire protocol below)
                          (crowd-sourced capture plan: docs/widget-remote-upload.md)
tools/brep-harness/       stubbed-Spring Lua harness: runs the REAL widget over a
                          deterministic fake game, once per mode (`harness.lua <widget>` and
                          `harness.lua <widget> resim`), to (re)generate the
                          internal/capture/testdata fixtures that pin the Lua encoder <-> Go
                          decoder lockstep (TestHarnessGolden decodes each and compares a
                          line-per-record dump with a committed golden; `go test
                          -run TestHarnessGolden -update` rewrites them — read the diff);
                          needs lua5.4. The script also kills, transfers and crashes units,
                          eliminates a team and ends the game, so every analysis record is
                          exercised. Its projectileScript (resim) drives GameFramePost every
                          sim frame over fixed launchers kept out of the LCG-driven unit list
                          (so the rest of the fixture is unchanged by it): an LRPC shot with
                          cluster sub-munitions, a recycled projectile id deleted with no
                          explosion, an intercepted nuke and one that lands, a sweeping beam
                          with gaps, a fusion's death blast, a shell still flying at game
                          over, stockpile changes — and weapons that must NOT be watched.
                          Its commScript drives AddConsoleLine/MapDrawCmd over every chat
                          shape and draw type — INCLUDING the console lines that must NOT be
                          recorded (engine noise, the widget's own heartbeat echo, an unknown
                          speaker, the "added point" line duplicating a MapDrawCmd), so a
                          parser that got greedier shows up as extra comms in the fixture test
```

Key design rule: **the on-disk format lives only in `snapshot/`** behind the `Writer`
interface. To change it implement `snapshot.Writer`; nothing in `capture`/`engine`
changes. `capture.ConsumeBrep(r, baseMeta, w)` is the seam between the widget's
stream and the writer.

### On-disk format v6: `.brp` (snapshot/brp.go)

Full byte-level spec: `docs/brp-format.md` — keep it in sync with any codec change
(`docs/brp-optimizations.md` records the measured evaluation behind the format's
design decisions). The only output format — the retired v1 JSONL measured a real
33-min 8v8 game at **476 MB where the .brp is ~8 MB (~62x)**. Quantized once:
whole elmos/hp, velocity as per-sample-interval
displacement, build progress 1/255, resources 0.1; `t` is derived as `frame/30`,
not stored; **y/dvy are not stored at all** — the viewer renders the x/z plane and
ground-unit elevation is terrain noise, so decoded `Pos.Y`/`VelY` are 0). Container:
`"BRP1" <ver u8 = 6>` then tagged sections `<tag u8><len u32le><payload>` — `M` meta
JSON (Meta + precomputed bounds/frameTeams/counts + the **chunk index** + the
**section layout**: every later section's tag and length in file order, which is how
a browser holding only the head of the file finds the rest; always the FIRST
section, and the writer puts `E`/`C` right behind it so the viewer's first Range
read usually covers all three; `snapshot.IndexBRP` adds the layout to a file written
before it existed, which is what `WriteStaticBundle` runs every publish through), `K` **all
core keyframes as ONE gzip stream**, `F` core delta-frame chunks (columns: id def
team x z hp maxHp dvx dvz build target — build + the build/assist target moved into
the core in v5 so the browser can draw construction bars and builder→target lines),
`X` extra (team resources — the viewer reads the whole section once and decodes it,
`decodeEconomy` in app.js), `E` events, `C` **comms**
(everything the players wrote or drew: chat + map points/lines/erases, columnar
like `E` with two string tables and whole-elmo positions delta-coded against the
previous comm — freehand drawing is a run of short segments, so those deltas are
1-2 bytes; OMITTED entirely when a capture has none, which is every .brp packed
from a pre-1.6.0 widget stream, so readers must treat a missing `C` as "none"),
and in v6 the re-sim's analysis sections `G` facts, `H` hits, `U` unit ends,
`V` visibility, `R` projectile tracks and `W` blasts (older v6 captures have `D` damage windows and `S` lives instead) (each omitted when empty, written LAST — after `X`, in the
layout like every other section — and none read by the viewer) plus four
CAUSE columns appended to `E` (killer unit/def/team + weapon; the old owner's
team for a `given` event) — detected by the bytes left after the team column,
so a v5 events section reads unchanged. Unknown tags are
skipped, so sections can be added compatibly; the Go reader accepts 5 and 6
and rejects everything else (v1–v3 existed only pre-release, v4 shipped without
build/target in core; regenerate a .brp from its .brepstream with pack). The
frame columns did not change in v6. The JS decoder
keys its column count off the container's version byte (the .brp's, or an older
replay's .brw), accepts 4..6 and still plays published v4 bundles (their units decode as build=finished/target=none).

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
`engine.Run` (widget writes `<data>/barreplay/<gameId>.brepstream`) → `capture.ConsumeBrep`
reads that file → `capture.ReplaceComms` (the demo's comms win over the widget's) →
`snapshot.NewBRPWriter`.

Note the widget writes its stream to its **own file** (path substituted from
`Config.SnapshotStreamPath`), not to stdout: the tool drains the engine's stdout (watching
only for the widget's first `[barreplay]` line, which marks the load/sim boundary) and
parses the file after the engine exits. `-progress` still works off `infolog.txt` (the
widget's heartbeat lines keep `[f=]` markers flowing there).

### Widget wire protocol (.brepstream)

The widget writes a `.brepstream` (text preamble, then binary records — byte-level
spec: `docs/brepstream-format.md`) to its output file; `internal/capture` parses that
file after the run. Evolve the widget and `capture` together. (The re-sim used to
write the BRSNAP text stream instead; that format and its parser are gone, and
`pack` no longer accepts `.brsnap`.)

**Why a file, not `Spring.Echo`:** the engine flushes its log on every Echo *and* caps
each Echo at a few hundred units (a real replay hit 617), so streaming snapshots through
stdout was slow and silently truncated. `System` exposes `io` to widgets (BAR's own
`savetable.lua` uses `io.open`), so the widget opens the substituted `__OUTPUT_PATH__`
and writes each sampled frame as one binary record, flushing every sample and closing
in `GameOver`/`Shutdown`. No size cap. Only the small `[barreplay]` heartbeat lines
still go through `Spring.Echo` (for `infolog.txt` / `-progress`).

**Path sandbox (non-obvious):** Spring's `LuaIO::fopen` runs `IsSafePath`, which rejects
**absolute paths** and any `..`, so the widget can only write a *relative* path resolved
against the engine's working directory. `engine.Run` sets `cmd.Dir` to the write-dir and
passes the widget a relative `LuaUI/Config/barreplay/<gameId>.brepstream`
(`engine.StreamRelPath` -> `Config.SnapshotStreamPath`); the tool reads it from
`<data>/LuaUI/Config/barreplay/<gameId>.brepstream` after the run and moves it to
`<out>/<gameId>.brepstream`. An absolute path makes `io.open` return nil → no file at all.
**BAR's own sandbox (game builds from the 2026.10.13 release, test-31614 on)** adds a
second rule on top: the widget handler gives user widgets an `io.open` that WRITES only
under `LuaUI/Config` and `LuaUI/Widgets` (luaui/barwidgets.lua `checkUserWritePath`), which
is why the stream lives there — the old `barreplay/` path was refused, every re-sim of a
game on those builds ended with "open widget output ...: no such file", and the uploader
(`LuaUI/Config/barreplay/` too since widget 1.11.1) could not record live games either.
The same release also took handler access away from user widgets
(`widget.widgetHandler` is a restricted proxy), so on those builds the re-sim cannot
disable BAR's widget suite (slower runs) and its hits name no attacker (both log an
"unavailable" line). The Explosion hook cannot install either (the proxy has UpdateCallIn,
but the real handler refuses a name it has no list for), and NO other source of
explosions reaches a headless engine: BAR's `VisibleExplosionBatch` comes from the unsynced
half of its gfx_explosion_lights gadget, and luarules/gadgets.lua skips every unsynced
`gfx_`/`gui_`/`snd_` gadget when `Platform.isHeadless` (widget 1.11.1 relied on it and
re-sims of those builds recorded every track as vanished and no blast at all). So since
1.11.2 the ends are INFERRED when the hook is missing: open tracks are swept EVERY frame
(15 otherwise) and a projectile gone closes as exploded one frame past where it was last
seen (position + velocity), a beam firing gets one hit at its weapon target, and a unit's
death (or, for kill codes -10/-18, self-destruct) weapon becomes its blast in
UnitDestroyed unless the kill code says reclaimed/unknown or the unit was unfinished
(CUnit::KillUnit's rule). Tracks and beams so closed carry R flag bit 3
(`snapshot.TrackEndInferred`); a projectile deleted without exploding then reads as an
explosion, and cluster sub-munitions, ownerless and Lightning/DGun hits are missing.
Whether the widget holds the REAL handler is asked by `realHandler()` (does its
knownWidgets record this widget?), never by a member existing: BAR's hardened proxy
(branch fix/widget-env-hardening, the migration guide at
gist.github.com/efrec/e8f302dce2b9d137020ceaccd0750b48) answers every real-handler member
with an empty table or a do-nothing function, and checking `wh.UnitDamaged` there "hooked"
a no-op and dropped every hit. The harness's `sandboxed` mode (harness_sandboxed fixture,
a proxy that fakes members the same way, and no explosion is ever delivered) runs exactly
this: its track ends match the resim fixture's within a frame's travel, flagged inferred.
**The patched engine gets all of it back (widget >= 1.12.0, patch
`patches/engine-2026.07.04/0004-engine-event-log.patch`).** BAR's sandbox builds a user
widget's `Spring` as a full copy of the engine's, so a function the ENGINE adds reaches
the widget whatever the handler does; what the handler controls is callins. So the
engine records explosions and hits itself and the widget PULLS them:
`Spring.SetEngineEventLog(explosions, damage)` switches two unsynced event clients on
(`rts/Lua/LuaEngineEventLog.cpp`), `Spring.GetLoggedExplosions([t])` /
`GetLoggedDamage([t])` drain them as flat arrays (stride 11 / 16: every Explosion and
UnitDamaged argument plus what the widget used to read off the live unit — owner's team,
health after the hit, position, the projectile's shooter). The explosion client is
ordered -100, ahead of every Lua handle, because `CEventHandler::Explosion` stops at the
first client that claims one; the damage client 1999, just before LuaUI, so its health
reading is the one LuaUI's callin made. Both return nothing to a caller without full
read (a playing client cannot see enemy fire through them) and are off — unregistered —
until switched on. The widget prefers the log whenever the functions exist: explosions
drained at the top of GameFramePost (where the callin landed them, before the
vanished-track sweep) and filtered to the watched weapons; hits drained before each
window flush, at the top of UnitDestroyed (a U row counts the hits before it) and at game
end; no UnitDamaged callin defined, so no Lua call per hit. The harness's `enginelog`
mode (sandboxed proxy + stubbed log) decodes IDENTICAL to the resim fixture
(`TestEngineLogMatchesResim`). With the log the explosions are REAL (ids, owners, ownerless ones, exact
ends) and the inference above stays off; the inference is what a stock engine gets.

Because that `cmd.Dir` is the data dir, **`engine.Locate` absolutizes `Config.DataDir` and
every binary path it resolves** (`filepath.Abs`) — otherwise a relative `-data .bardata`
gets re-resolved against *itself* by the child: exec looked for
`.bardata/.bardata/engine/<ver>/spring-headless` and failed with a "no such file or
directory" naming a binary that plainly exists (the lookup had checked it against the
parent's cwd), and `--write-dir` doubled the same way. Regression test:
`TestLocateAbsolutizesRelativeDataDir`.

```
preamble (text lines, the old BRSNAP grammar):
BRSNAP GID <gameId> / BRSNAP GAME <json> / BRSNAP DEF <json> / BRSNAP T ... / BRSNAP P ... / BRSNAP READY
records (<tag u8><len u32le><payload>):
F  one sampled frame (keyframe or delta: units, dead ids, team economy)
E  unit lifecycle event, text; protocol 4 adds the cause columns (killer / old owner)
C  one player comm: chat message or map drawing (JSON)
G  game fact (JSON: end, teamdied, playerleft; re-sim also wdefs, teamstats)
H  every damage callin     (re-sim, -damage)
U  where unit lives ended  (re-sim, -damage)
V  per-side visibility     (re-sim, -visibility)
R  projectile/beam tracks  (re-sim, -projectiles; protocol 5)
W  strong explosions       (re-sim, -projectiles; protocol 5)
Q  shield charge           (both modes; protocol 6)
P  engine profiler reading (re-sim, -profile)
X  end of stream
```

The **unit defs are dumped in full** (`DEF` JSON: name, humanName, costs, buildTime,
maxHealth, speed, footprint `xsize`/`zsize`, `iconType`, builder/factory/fly flags,
weaponCount), not just id→name — mods add
and modify unit types, and the id space depends on the exact game build the replay pins.
Since protocol 4 a DEF also carries `techLevel`, `unitGroup`, `isCommander`,
`maxWeaponRange` and the `deathWeapon`/`selfdWeapon` explosion ids (from
customParams/weapon defs; for the game summary). **Players** are
seeded from the **demo startscript** (`demofile.BaseMeta`, used by both `cmd/barreplay`
and `pack`'s demo fetch), the authoritative
source for per-player metadata the live engine list lacks: country flag (`countrycode`),
ladder rank, OpenSkill rating ("OS", the bracketed `skill`) + uncertainty, `accountid`, and
`boss`. The widget's `P` line (name/team/spectator) is a fallback for a raw stream with no
startscript behind it — `capture` merges it by player id so a seeded player is never
duplicated. **Team colours** ride the `T` line; `capture` backfills each `TeamInfo.PlayerName`
from the first non-spectator player on that team.
Each sampled frame also carries one resource row per team with its current metal/energy, storage
caps, and per-game-second income — `GetTeamResources`' income return is ALREADY per
game-second (the engine accumulates it over `TEAM_SLOWUPDATE_RATE` = 30 sim frames), so
protocol >= 3 widgets write it as-is. Widgets before that wrongly multiplied it by 30;
`capture` repairs those streams at decode time (`repairIncome` in lines.go: any stream
without a `GAME` line declaring `protocol >= 3` gets its income divided by gameSpeed).
Each unit row carries, besides position and health, the unit's velocity (as the
per-sample displacement), `buildProgress` (0..255; from `GetUnitHealth`'s 5th return)
and its build/assist target.

**Chat and map drawings (`C` records; widget >= 1.6.0).**
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
falls back to `<n>ms` via `os.clock` if the hi-res timer is absent). The
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

## The viewer (`internal/viz` + `worker/`)

The browser playback of a finished capture lives in `worker/` (the front-end) and
is served as **plain static files** from R2 by the Cloudflare Worker; `internal/viz`
is the Go side that publishes a `.brp` (`static.go`, used by `pack -upload` and
`cmd/barreplay-static`), generates the viewer's icon table (`icons.go`) and builds
the catalog row the publisher registers (`catalog.go`). Nothing here touches the
engine. **The viewer reads the current .brp version only** — convert a raw
`.brepstream` once with `pack` (the converter owns the legacy parsing;
viz has none). The URL scheme is `/api/replays` and
`/replays/<id>.brp` — the whole published replay, Range-read — plus, for OLDER
replays, `/replays/<id>.brw`, `.resources`, and (older still) `.keys` and
`/replays/<id>/c<n>`.
`/api/replays` is the replay catalog (stats for the landing list — see the worker/
entry above), served by the worker from its Durable Object table; the rows are
built by `viz.BuildCatalogEntry` (`internal/viz/catalog.go`) at publish time.
(There used to be a Go HTTP server, `cmd/barreplay-viz`, serving the same URLs over
a local directory of `.brp` files; it was removed as unused. Local viewing is `npm
run dev` in `worker/` plus `pack -upload local`.)

- **A published replay is its `.brp`, nothing else** (`app.js` "reading a published
  .brp": `loadBrpHead`, `headFromBrp`, `decodeEconomy`). The first request is a Range
  read of the head of the file (`BRP_PROBE` = 256 KB): the 10-byte header, the `M`
  meta and — because the writer puts them right behind it — `E` events and `C`
  comms. The meta's section layout places every other section; a head bigger than
  the probe costs exactly one more read for the rest of the meta and one for E+C
  (adjacent wherever they are, so one span), and a FILE smaller than the probe — the
  206 comes back short — or a server that ignores Range (200) is kept whole
  (`brpWhole`) and every later piece is sliced from it. Every one of those Range
  reads goes through `rangeFetch`, which keeps them in the CACHE STORAGE API
  (one cache per file, the `RANGE_CACHE_KEEP` = 12 most recent kept, never on a
  loopback host, whose simulator bucket is refilled under the same keys): the
  browser's HTTP cache cannot be relied on for them although cdn-bar serves
  them immutable and as HITs — Firefox never stores a sub-range request at all,
  and Chrome's one sparse entry per URL lost the head, keys and economy on
  every reload (measured), and everything when a page was left mid-download.
  Sound only because a published key never changes bytes. Everything a published
  head used to carry precomputed is derived in the browser from the meta's full
  unit-def table (`headFromBrp`): internal names (`unitDefs`, the icon/footprint
  lookup key), human names (`unitNames`, "Construction Bot", what units are LABELLED
  with — only where it differs from the internal one; `defName` falls back),
  footprints (STRUCTURES only, `!canMove || isBuilding` — neither alone suffices:
  nano turrets are immobile builders, some factories report canMove; sizes in
  8-elmo squares), `armyCost` (the metal price of each ARMED, MOBILE def — the
  sidebar's army value; the commander half of BAR's rule stays in `defIsCom`), the
  team roster plus every team seen only in frames (`frameTeams` — nothing renders
  colourless), players, bounds and the chunk index with ABSOLUTE ranges (`keys`,
  each chunk's `off`). Icons come from `/icons/icontypes.json`, the icon table
  generated from BAR's icontypes.lua: static per BAR version, so it ships with the
  viewer instead of riding in every replay; a def resolves by its `iconType` key
  first, then its name. The ECONOMY is the `X` section, read once after the head and
  decoded in JS (`decodeEconomy`, the twin of snapshot/brp.go's extra-stream codec,
  values rounded half away from zero like Go). The section has no frame numbers —
  they live in the frame stream — so records are kept PER SAMPLE and filed under
  their sim frame as each chunk's frames decode (`publishEconomy`); deriving the
  frame from chunk.frame + k*sampleEvery is wrong wherever a capture skipped a
  sample (the harness fixture does). The lockstep is pinned by
  worker/tests/fixtures/viewer.brp + viewer.economy.json, written by internal/viz's
  `TestViewerFixtureUpToDate` (regenerate with `-update`; when the bytes differ it
  compares CONTENT — decoded meta and gunzipped sections — because compress/flate's
  output changes between Go releases while the format does not) and decoded by app.js's
  own functions in worker/tests/appjs.test.ts. OLDER replays (no `.brp` — the first
  read 404s) are read as they always were: `/replays/<id>.brw` is a small binary
  **"BRW1" container** of a gzipped `J` head JSON (exactly what `headFromBrp`
  now builds, computed by Go at publish time) plus the file's `E` and `C` sections
  byte-for-byte; the economy is `/replays/<id>.resources` (JSON `[{f, r}]`); and the
  frames are either Range-read from a `.brp` at the head's `keys`/`off` ranges or,
  older still, fetched from `/replays/<id>.keys` + one `/replays/<id>/c<n>` per chunk
  when the head has no `keys`. Those objects stay in the bucket and keep playing. In
  the browser, `app.js` gunzips each response with
  the native `DecompressionStream` and unpacks frames into the same flat stride-9
  `Int32Array` (`[id, def, team, x, z, hp, maxHp, dvx, dvz]`) the renderer always
  used.
- **`app.js` keys-first streaming**: right after the head, the viewer fetches
  the keys range and pipes the response body through `DecompressionStream`, slicing
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
  the file's meta record. `headFromBrp` also fills `footprints`
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
- **The playback strip (`index.html` `#bottombar`, `app.js` `drawStrip`)**: a
  round play button, a step either way, the speed, the TIMELINE and the clock
  ("11:31 / 20:57"; the sim frame moved to the team card). First/last are the
  Home/End keys, not buttons. The timeline is a canvas drawing the WHOLE GAME
  behind the slider — which side's army was ahead when (first side's lead above
  the centre line in its colour, the second's below), an accent tick wherever
  somebody said something, the minutes under it, and the downloaded ranges
  (`#buffbar`) along the graph's foot — with the native range input laid over it,
  its track invisible and its thumb styled as the playhead (a line through the
  strip, a dot on the centre). The lead is `tsArmyValue`, the team statistics
  bar's own reading, so the two cannot disagree, read per sample as each chunk
  arrives (`noteStripChunk`: a point a minute once the keyframes are in, a point a
  sample once the chunk is), as the log of the ratio with `STRIP_LEAD_FLOOR`
  metal added to both and a 4:1 lead reaching the edge. Two sides and a cost
  table, or the bare track. The canvas repaints only when something in it
  changed, never per playback tick: the playhead is the thumb, and the x axis is
  the slider's own (sample index, inset by half a thumb at each end).
- **The player table (`app.js` `renderPlayers`, on the team card)**: every
  player in ONE table under one header row (PLAYER, OS, METAL, ENERGY), side
  after side, so the columns line up across the whole game — the reason for the
  one panel (Marcin disliked teams split apart). Each side opens with a row in
  its leader's colour, named like the summary names it (`sideNames`: "Blue team",
  "Team N" when two would share a name — `sideColorName` is model.ts colorName
  repeated, and the two must agree), with its player count and summed OS; a
  free-for-all, all sides of one, gets no side rows. Spectators are one line at
  the foot, every name in its tooltip.
- **Team statistics bar (`app.js` `renderTeamStats`, on the team card under
  the clock and above the player table, ruled off from it — these rows are
  about the two SIDES, the table about the players)**:
  BAR's spectator team comparison
  (`luaui/Widgets/gui_spectator_hud.lua`), reproduced for the three metrics a
  capture can answer — metal income, energy income, and ARMY VALUE. One row per
  metric: the metric's name, then each side's value in a KNOB of that side's
  colour, two BARS between them in a darkened version of each colour sharing
  the leftover width in proportion to the values (BAR's `leftBarWidth`), and
  riding the split a third knob carrying the LEAD — the leader's margin over
  the TRAILING side rather than its share of the total, so a 2:1 game reads
  "100%" and a side at zero reads "∞" rather than 100%. That knob takes the
  LEADING side's colour, which is what says whose lead it is (the number alone
  is a bare margin that could belong to either end of the row); a DEAD HEAT has
  no leader to name and takes the neutral `TS_TIE_KNOB` instead, as BAR's own
  `colorKnobMiddleGrey` does. A number written ACROSS a block of team colour is
  what makes both readable at once, and is why the row is shaped this way: the
  colour says whose the number is, `textColorOn` picks the ink off that
  colour's luminance (white on a navy team, black on a yellow one), and neither
  has to compromise for the other. Drawing the number IN the team colour
  instead was tried and reverted — BAR's default blue is a contrast of 2.0
  against a dark panel, where small text wants 4.5. Values
  format like BAR's own `formatResources(v, true)` (`fmtStat`: 7.0k, 504k, 3.7M,
  192M) rather than `fmtNum`, whose trailing-zero trimming would let a reading
  jitter in width from "7k" to "7.01k" as the game ran.
  The two INCOME rows read a MEAN over the last `TS_AVG_SEC` = 5 game-seconds
  (`tsIncomeAvg`, averaging the economy timeline's samples — evenly spaced, so
  averaging them and integrating over time agree, and a partly-filled window at
  the start of a replay still reads right), not the sample under the playhead.
  The engine's per-second income is genuinely twitchy — build pulses, converters
  toggling, wind gusting — so at 1 Hz both knobs stepped to a new number every
  sample and the row was unreadable while the replay played; measured on a
  synthetic 2v2 the sample-to-sample movement drops from 2.3 to 0.8 metal/s, and
  the reversals with it. ARMY VALUE is deliberately NOT smoothed: it is a stock
  rather than a rate, so its jumps are units dying, which is the thing the row
  is for — and it is read off the displayed FRAME, where a window would need
  frames a sparsely-loaded timeline may not hold, unlike the economy timeline
  which is fetched whole.
  The widget's SHAPE is copied; its game-HUD FINISH is not — no bevels, no lit
  top edge, no gradients, since next to this sidebar's flat surfaces those read
  as a transplant from another program (a faithful copy shipped once and was
  rejected on sight). Knobs size to their own text and carry tabular figures,
  so "504k" beside "7.0k" each get the room they need and no knob breathes in
  and out as its last digit changes during playback; the bars carry `min-width:
  0` over a zero basis, so a side with nothing collapses its bar rather than
  pushing the row wider than the sidebar. A flat restyle that dropped the knobs
  — team-coloured numbers on the plain track over a 3px split band — was tried
  in between and rejected as well: it is where the contrast problem above came
  from, and the two rejections together are why the knobs are the part to leave
  alone. Nothing OUTSIDE this bar was
  re-tinted: the player list, the chat log and the map tooltip keep the raw team
  colour they have always used, which was asked for explicitly after a change
  that lightened them. Drawn ONLY for a TWO-ALLY game: the row's whole shape is a
  comparison of two sides and there is nothing to split in an FFA. The sides come
  from the PLAYER roster rather than the team list, which is also what keeps Gaia
  and the scavenger team out of them — no player controls those. BAR's MP and EP
  (metal/energy ever produced) are deliberately absent: those are engine running
  totals (`GetTeamResourceStats`) that a sampled capture never recorded. ARMY
  VALUE sums the metal cost of every ARMED, MOBILE unit a side owns that is not a
  commander, weighted by the sampled build progress so a unit under construction
  counts for the metal actually sunk into it. The rule is SPLIT across the two
  sides on purpose: the armed/mobile half needs the unit-def table and is applied
  where the head is built (`headFromBrp`'s `armyCost`, which prices only the defs
  that pass it; for an older replay, the same rule ran in Go at publish time), the
  commander half stays in `defIsCom` (`COMMANDER_RE`), this repo's one definition
  of a commander. An older bundle published before `armyCost` existed carries
  none, so the AV row is DROPPED rather than drawn as 0 against 0 — republishing
  the `.brp` (`pack`) brings it back without a re-simulation. Each row is likewise dropped when the economy timeline has no
  reading for it, and the whole bar hides when no row is left.
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
  O(marks × erases) per animation tick. CHAT lands in two places. The chat card holds the
  conversation SO FAR: only lines already said at the playhead are shown (`.chatrow.future`
  is `display:none`, so the log never spoils what has not happened), clicking one seeks
  back to when it was said, and the box STICKS TO THE BOTTOM — scroll away and it stops
  following, scroll back down and it resumes (`chatStick`, re-evaluated from the box's own
  scroll event, which our own scrolling also fires and simply re-confirms, so no suppress
  flag is needed). Its pills FILTER it (`chatIn`/`setChatFilter`): All, Allies (the team
  channel) and Spec — everything SPECTATORS said, on any channel, since most of their talk
  goes to everyone and the spectator channel alone would hide it; a pill appears only when
  it keeps something. The map shows the same message as a BUBBLE over
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
  a team with nothing left, gets no bubble and lives only in the chat card. The whole
  layer switches off from the map's Layers popover ("Chat bubbles") — one of the few view
  toggles that earns a control rather than a `const`, since bubbles sit on top of the
  map you may be trying to read. The panel hides
  itself when the capture recorded no chat — which is what every replay published before
  the `C` section looks like.
- **EFFECTS: projectiles, beams and blasts** (`app.js` "effects" part,
  `public/fx-projectiles.js` / `fx-beams.js` / `fx-blasts.js`): a v6 re-sim from
  widget 1.9.0 carries `R` tracks, `W` blasts and the `wdefs` weapon table in `G`.
  None of it is in the head (`headFromBrp` only records where it is, `fxAt`):
  `loadEffects` reads the three sections in one Range read (they sit side by side
  at the end) while the Layers popover's "Effects" switch is on, decodes them with
  `decodeProjectiles`/`decodeBlasts` (twins of snapshot/projectiles.go, pinned by
  worker/tests/fixtures/viewer.fx.json — Go's own decode of the viewer fixture)
  and puts `tracks`/`projectiles`/`beams`/`blasts`/`weapons`/`facts` and
  `fxIndex.{projectiles,beams,blasts}.between(f0, f1)` (128-frame buckets) on
  `data`. `drawOverlay` calls `drawEffects` with the fractional sim frame, which
  calls one function per fx file. Each fx file is a plain script sharing app.js's
  globals, loaded BEFORE it and fingerprinted with it (vite.config.ts
  SUBRESOURCES, index.html, public/_headers, the dev middleware and the smoke
  regex all name them). A replay without the sections hides the switch.
  fx-projectiles.js draws the FLIGHT only (impacts are fx-blasts.js's): a
  team-coloured fading trail and a class-coloured head, grown with height.
  `projPos` places a row between records: a row with a path (nukes, anti-nukes,
  EMP, tactical, Junos) is a Catmull-Rom curve through launch, path and end; a
  pathless row with horizontal velocity is ballistic (the engine's own
  `y0 + vy t + g t(t+1)/2`, eased onto the recorded end over the flight since
  the stored velocity is quantized); a pathless starburst rocket flies a gentle
  accelerating bow from launch to end.
- **SHIELDS** (`public/fx-shields.js`, loaded and fingerprinted like the fx
  files; drawOverlay calls `drawShields` under every other mark, loadReplay
  calls `loadShields`): Marcin's pick "C" — the EDGE of the area each ally
  team's shields cover (overlapping shields merge into one outline, O(n²)
  circle tests), coloured by charge, plus a small charge gauge round every
  generator; a drained or switched-off shield leaves the outline as a dashed
  ring. No fill, no per-pixel work: one path per colour bucket. When the
  paint interval averages over 33 ms it DROPS TO A SIMPLER LOOK on its own
  (the outline alone, one colour, one stroke; the down shields stay dashed, since a big fight both drains them and triggers the drop), coming back after 300 fast
  paints, at most twice per page; `?shields=full|simple|off` pins it. The map's Layers popover has a Shields switch (shown when a def is a shield generator), the unit tooltip a one-row Shield line (charge bar + `power / full`, `? / full` without Q data, `off`), and the `?debug` FPS meter (any value) adds the shield look and its ms/paint. Reach
  and full charge come from the unit defs (`shieldRadius`/`shieldPower`,
  widget 1.10.0) else the file's SHIELD_DEFS table; the CHARGE from the
  `.brp` `Q` section (`decodeShields`, twin of snapshot/shields.go), each
  reading held until the unit's next. A capture without it — every replay
  before widget 1.10.0 — draws the outline in a neutral colour with no gauge.
- **`internal/viz/icons.go`** renders **real BAR unit icons**. It embeds the vendored icon
  PNGs and BAR's `icontypes.lua` (a unit-name→bitmap gamedata table) under `bardata/`, and
  **parses the Lua data table directly in Go** (a small line/brace scanner, no `gopher-lua`)
  — keeping the repo stdlib-only. It also replicates the file's trailing `_scav` synthesis
  (inverted-path variants) and keeps only entries whose bitmap file actually exists in the
  embedded FS, so the table never advertises a 404. It also parses each type's `size`
  multiplier. The result is the ICON TABLE, `bardata/icons/icontypes.json`
  (`IconTypesJSON`; regenerated by `go test ./internal/viz -run IconTypes -update`,
  and that test fails while it is stale), served with the bitmaps at
  `/icons/icontypes.json`: the icon set is static per BAR version, so it lives
  with the viewer, never in a replay. `headFromBrp` resolves `unitIcons`
  (name→`{p,s}`) for just the def names in the replay; the front-end draws every unit as its icon, **team-tinted** (BAR icons are grayscale
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
  (0.016% of a 60fps budget), so it is not gated on playback speed. That bar is
  YELLOW (`BUILD_BAR_COLOR`, the build line's own colour, so a construction site
  and the builders feeding it read as one thing), which frees green for the
  HEALTH BAR: a thin green bar over any FINISHED unit missing at least
  `DAMAGE_MIN_FRAC` (2%) of its health — a bar a pixel short of full is noise,
  and in a real fight it is most of the map, since hp is quantized to whole
  points and a unit grazed by one stray shot reads as damaged exactly like one
  about to die — drawn only at `HEALTH_BAR_MIN_SCALE` (0.25 screen px per elmo)
  or closer — zoomed further out a unit is a few px wide, the bars' 10px minimum
  width makes neighbours overlap, and the whole-map view people read the front
  line in turns into a band of noise. It is deliberately NOT interpolated the
  way the build bar is: build progress really does creep between samples, where
  damage arrives in hits, so lerping it would draw a drain that never happened.
  An UNFINISHED unit's health rises with its build progress, so it gets a
  health bar only when it has LESS hp than that progress accounts for (hit
  while being built: hp < build x maxHp x UNFINISHED_SLACK = 0.9, measured
  within 2.5% of 1 for 99% of undamaged builds) — and a
  unit with no recorded maxHp (an unidentified radar contact, 0/0) gets
  neither. The health bar is `BAR_H_SMALL` (2px) rather than `BAR_H` (3px) on a
  unit the bar is already WIDER than, i.e. one whose icon falls under the
  `BAR_MIN_W` (10px) width floor: the raiders (corak, armpw — icon size 0.735,
  so ~9px) then read as a bar with a unit under it, where a commander at 22px
  does not. The test is the px actually drawn, so a building that grows into
  its footprint when zoomed in keeps the full height. One predicate,
  `damagedEnough`, serves both the pre-scan and the bar pass — they must agree
  or the scan enables a pass that draws nothing. The layer switches off from
  the Layers popover's "HP bars" (`showHealthBars`, `#togglehp`) — the second
  view toggle to earn a control rather than a `const`, for the chat bubbles'
  reason: in a big fight it is a bar over nearly every unit on screen, which is
  sometimes what you are trying to look at. It folds into the same per-draw
  `wantHealth` gate as the zoom, so switching it off skips the scan and the bar
  pass rather than drawing nothing expensively. The BUILD bars are deliberately
  not part of it: there are only ever a handful, and a construction site with no
  bar is indistinguishable from a finished building.
- **SELF-DESTRUCT COUNTDOWNS** (`app.js` `selfds`/`drawSelfDestructs`): a
  pulsing 💣 over a unit from its `selfd` order to its death or the order
  cancelling it (the engine toggles). A death with NO cause is the blast going
  off, so its frame is exact and the seconds left are shown; killed first,
  cancelled, or no end within 60 s, it is the bomb without a number.
- **RECLAIM LINES** (`app.js` `drawReclaimLines`, `RECLAIM_LINE_SEC` = 3): a
  purple line from a builder to what it is reclaiming, drawn for the last 3 s
  before the target disappears. Derived with NO format change from the destroyed
  event's cause (weapon -12 = reclaimed, killer = the builder), so it shows only
  what was reclaimed to completion, only on captures that record causes (v6
  re-sims), and only the finish of a long reclaim.
- **DEAD UNITS** (`app.js` `deadHp`/`DEAD_COLOR`): a unit whose health is gone
  but which the engine has not removed is drawn in `#9fb0bf` grey instead of its
  team colour, in every path that colours a unit (both icon renderers, both dot
  fallbacks, the footprint rectangles and the ghost buildings). The case that
  makes it worth doing is a crashing aircraft: Recoil does not delete one when
  its health runs out, it drops the hull, which still does damage where it
  lands — so the capture holds a real unit at or below 0 hp and the viewer used
  to draw a corpse in full team colour, reading as something still in the fight.
  The test is `maxHp > 0 && hp <= 0`, and the `maxHp > 0` half is the same guard
  `damagedEnough` carries for the same reason: an unidentified radar contact
  records 0/0, which is health UNKNOWN, not health gone, and greying every radar
  blip would be most of an enemy's map. Such records only reach the viewer at
  all because no destroyed event has been written for the unit yet — once one
  is, `capture.graveyard` (internal/capture/lines.go) drops every later record
  of that id, so a corpse is on screen exactly while it is still doing
  something. Two things follow the grey. `damagedEnough` gained `hp > 0`, so a
  corpse gets no health bar: an empty dark bar over an icon already greyed says
  the same thing twice. And the damage flash skips it — a falling wreck loses
  health every sample without being shot at, so it would otherwise strobe red
  the whole way down. The 2D glyph memo keys the grey variant at `DEAD_SLOT`
  (4092), the slot below the flash targets' 4095-4093, which team ids (u8)
  cannot reach. Captures from the UPLOADER widget carry none of this: it buries
  a unit the sample its health reads `<= 0` and never writes the record, so the
  grey is a re-simulated (full-view) capture's to show. The 2D
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
- The **real map terrain** behind the units is loaded **client-side** (`loadMap`
  in `app.js`): the browser takes the head's `mapName` (from the capture's meta),
  resolves it to the API's **file name** (see below), and asks BAR's maps API
  THROUGH THE WORKER'S CACHING PROXY (`MAP_API = '/api/bar'`, app.ts `barProxy`:
  `/api/bar/maps/<file>`, `/api/bar/maps/<file>/texture-{mq,lq,thumb}.jpg` and
  `/api/bar/replays/<gameId>`, nothing else) — `/maps/<file>` for the world extent in
  elmos (the API's width/height are map units × 512) and `…/texture-mq.jpg` for the
  terrain image. **Resolving the file name is not a string transform** (non-obvious):
  the API keys maps on the archive file the map's author uploaded, so
  `mapFileGuess` (lowercase, spaces→`_`) is right for only ~85% of BAR's map list —
  `Frozen_Ford_V2` keeps its capitals (`frozen_ford_v2` 404s), `Eye Of Horus 1.6` is
  stored as `Eye Of Horus_1.6` (spaces and all), `Desolation v1` is just `desolation`.
  So `resolveMapFile` tries the guess and, on any non-200, falls back to
  `…/replays/<gameId>`, whose `Map` object carries the authoritative
  `{fileName,width,height}` — which also gives a `pack -no-demo` capture (empty
  `mapName`) its terrain back. The proxy exists for CACHING: api.bar-rts.com sends
  no cache-control on the JSON and `max-age=0` on the images, so every replay load
  downloaded its terrain again. barProxy caches the answer at the edge
  (`cf.cacheTtlByStatus`, a week) and tells the browser `max-age` a year and
  `immutable` on a 200 — a map's archive name names fixed content, and without
  `immutable` Firefox revalidates on every reload (a hard reload that still asks is
  answered 304 off the ETag) — but only 5 minutes on a 404, which must
  stay a 404 (it is how resolveMapFile learns the guess was wrong), and nothing on a
  5xx. It answers `access-control-allow-origin: *` because the summary EMBED draws its
  maps through it from another site (embed.ts passes `mapApi = <replayOrigin>/api/bar`;
  the viewer passes its own MAP_API). The image is loaded
  with `crossOrigin="anonymous"` so the canvas stays untainted. Best-effort: no name in the meta, an unknown map, or no outbound
  network just yields a plain background (and the field extent falls back to the
  sampled unit bounds). The front-end positions the texture at world
  `(0,0)`–`(width,height)` so units overlay correctly; the terrain layer is always
  on (no toggle). Caveat: the widget stream doesn't record the map name
  (only the demo startscript path does), so a `.brp` packed from a raw `.brepstream` with
  `pack -no-demo` has an empty `mapName` and renders the plain background; the
  default pack fetches the demo by gameId and fills it in.
  HIGH-RES TERRAIN: once the API texture is up, loadMap also asks the CDN
  hostname (`HIGHRES_MAP_ORIGIN`: the data origin, or cdn-bar under `vite dev`,
  since only the production bucket has them) for `maps/highres/<name>_<W>x<H>.png` (the BAR team's images, uploaded
  by cmd/upload-maps) and swaps it in when it arrives; a 404 keeps the API
  texture. The key is computed, never looked up (`highResMapFile`): the map name
  exactly as the startscript spells it (R2 is case-sensitive) with spaces as
  `_`, and the size from the map record already fetched: 4096 on the long side,
  the short side scaled to the aspect and rounded DOWN to a multiple of 4
  (checked against every uploaded file). `mapTexGen` is in the base layer's
  repaint key, since a texture swap changes nothing else in it.
- **`worker/public/`** (+ `worker/index.html`) is plain HTML/Canvas/vanilla-JS — **no
  framework, no build step for the app itself** (Vite only wraps it for the Cloudflare
  deploy). `app.js` reads the flat unit arrays by index (no per-unit objects), renders
  via WebGL instanced sprites (2D-canvas fallback), and does timeline scrub / play /
  zoom / pan / hover-tooltip. Colours are assigned per ally-team (a base hue per ally,
  lightness varied per team within it).

Guarding it: `internal/viz/static_test.go` checks that a bundle is the `.brp` alone
(byte-for-byte for a fresh capture), keeps the icon table current, and writes the
viewer fixture (worker/tests/fixtures: a two-chunk capture with a skipped sample, a
frame-only team, every footprint rule, an armed mobile def, an icon by iconType)
together with the economy Go decodes from it; worker/tests/appjs.test.ts runs app.js's
own reader over that fixture — head, events, comms, ranges, the economy against Go's,
the request count. snapshot/brp_test.go guards the section layout and `IndexBRP`. No
engine or browser needed.

### Serverless static hosting (`internal/viz/static.go` + `cmd/barreplay-static` + `worker/`)

Because nothing decodes a frame to serve one — the head is a pure function of the `.brp`
meta and every section the browser reads is an independently-gzipped byte range — the
whole playback path is served as **plain static files with no server**, and a replay
is ONE of them. `viz.WriteStaticBundle` writes, per capture, `replays/<id>.brp`: the
capture, validated and passed through `snapshot.IndexBRP` (which adds the section
layout to a file packed before it existed and leaves a fresh one byte-for-byte). It
used to also write a precomputed `.brw` head and a `.resources` economy JSON (and,
before that, split the frames into `.keys` + `/c<n>` files); nothing writes those any
more, and the bundles that have them still play. `WriteIndex` writes `index.json`,
listing a replay by its `.brp` or an older bundle's `.brw`. `cmd/barreplay-static` is
the CLI (and `packer.UploadStatic` the publisher's path); the `worker/` Cloudflare
project (Hono + Vite) serves the bundle from an R2 bucket and the SPA + vendored icons
(and the icon table) as static assets. Map terrain is fetched browser-side from
`api.bar-rts.com` through the worker's caching proxy (`/api/bar/*`, only there to add
cache headers), and the worker has no playback logic. The
codec lockstep is between snapshot/brp.go and app.js (`decodeFrames`, `decodeEvents`,
`decodeComms`, `decodeEconomy`, `headFromBrp`).

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
dir as both the engine location and `--write-dir`. The engine can also be **built from
source at the replay's exact tag** — validated recipe in `docs/building-recoil.md`
(official pinned Docker build image, ~35 min on 4 cores; capture verified byte-identical
to one from the official binary). That's the path for engine patches, and for
environments where GitHub release-asset downloads are blocked but `git`/`ghcr.io` work.

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

## Benchmarking the late game (`tools/bench-ckpt`)

Whole runs of small replays say little about speed: a big game's late frames
(~10k units) are ~15-20x slower than its early ones and are where re-sims spend
their hours. `tools/bench-ckpt/bench-ckpt.sh` re-simulates a replay ONCE to a
frame, CRIU-checkpoints the parked engine (the bench harness's BARREPLAY_PARK
point, patch 0005), and restores it per trial to time the next N frames from the
same state: `dump`, `trial`, `ab`, `flame` (LBR flame graph). Root for CRIU comes
through sudo docker (privileged container + nsenter into pid 1); the restore runs
in a systemd scope. A checkpoint restores only into the binary that made it
(dump each build once). Nothing else may run an engine meanwhile (the restored
one needs its UDP port back, and a trial copies its files into the data dir).
Benchmark: "verylarge1" = 6a37d06acbb455b1d19179d8ec965f10 at frame 63780.
The work log is docs/worklog-engine-speed.md; the PGO+LTO build recipe
is patches/engine-2026.07.04/pgo/ (docs/building-recoil.md). Other options:
PERF= (perf record), PERFSTAT= (perf stat per thread), LUAPROF=1 (the Lua
sampling profiler of a measurement build), MAINCPU=/OTHERCPUS= (pinning),
BARREPLAY_ARGS= (extra barreplay flags for a dump).

**Read results by CYCLES on a laptop host.** The dev host throttles hard under
sustained load (2.6-3.3 GHz averaged over a whole game against ~3.8 in a short
trial), so one whole-game wall time moves +-10% with the package temperature.
Judge changes on the late window (interleaved rounds, main thread pinned,
cycles); use whole games for identity and the trend. Thread count: the
engine's default (4 here) beat 2 and 7 over a whole game; more threads heat
the package more than they help.

**The late game is fighters.** verylarge1 at 63780 has 5,711 aircraft of
10,496 units (experiments/unitmix): aircraft movement ~14% of the main core,
weapon auto-targeting ~11% (most of it BAR's AllowWeaponTarget Lua callin,
3,100 a frame). Measured and ruled out: parallel aircraft updates (55% of
updates have a collision neighbour already moved that frame), an air-only AA
candidate list (~0.3%), approximate simulation (the demo carries every
player's sync checksum every 60 frames).

## Running out of memory (why the engine is stopped, not killed)

A re-simulation of a big game wants 7-10 GB resident, which is more than a small
host has. Left alone that ends in a **global OOM kill**, and the cost is not
limited to the run: systemd stops an entire unit when one of its processes is
OOM-killed and the unit's `OOMPolicy` is `stop`, which is the DEFAULT for the
scopes a user manager creates (`DefaultOOMPolicy=stop`) — so an OOM-killed engine
takes the tmux pane it was started from, and everything else in it, with it.
(System-level `session-N.scope` units default to `continue`, which is why the
same crash sometimes costs only the engine and sometimes costs the window.)

Two defences, and only the second prevents the above:

- **`oom_score_adj = 1000`** on the engine (`engine.SetOOMScoreAdj`, applied by
  `engine.Run`). This decides WHO dies, not WHETHER: the engine is already the
  biggest process and so the kernel's usual pick, but "usually" is not a
  guarantee — a run that has only just started is small, and the process killed
  instead would be somebody's shell.
- **`engine.WatchMemory`** stops the engine first. It polls `/proc/meminfo`'s
  `MemAvailable` every 2s and, below the floor (`-min-free`, default 512 MiB;
  0 disables), cancels the context the engine was launched with. No global OOM
  means no systemd teardown and no collateral, and the run ends as an ordinary
  failed job whose message says the machine was too small. It watches the HOST
  rather than the engine on purpose: what matters is whether the machine is about
  to run out, and the engine is the disposable thing on it either way. A reading
  it cannot take is never a reason to stop a run — a net that fires on "I do not
  know" would kill every run on a kernel that publishes no such number.

Both `cmd/barreplay` and `bringest -resim` take `-min-free`. If the guard is
disabled, or an allocation spike outruns its 2s tick, the systemd behaviour above
is still in play; `OOMPolicy=continue` on the unit the daemon runs in (e.g.
`systemd-run --user --scope -p OOMPolicy=continue`) contains the damage to the
engine.

**Cutting the footprint so the guard fires less** (patches/engine-2026.07.04/MEMORY.md
has the measurements). The peak is a LOAD-time cost, not growth: on an 8v8 the
engine is within 500 MB of its peak by the time the first sim frame runs, which is
why the OOM'd jobs in the queue include 3v3s and 4v4s that never reached frame 0.
Two things were most of it, and neither is the simulation:

- **1.05 GiB of pre-zeroed `.bss`.** Recoil's `StaticMemPool` (weapon 758 MiB +
  projectile 142 + unit 138 + feature 45) `memset`s its whole page array in a
  constructor that runs before `main`, over memory the loader had already zeroed
  — so every run held all of it resident whatever the game's size. Fixed by
  `patches/engine-2026.07.04/0003-static-mempool-lazy-zeroing.patch`: zero only
  the pages actually handed out. The pool's invariant ("an unallocated page reads
  as zero") already guarantees the rest, so the sim cannot observe the change —
  gated byte-identical. The stock RELEASE binary has the same `.bss`, so this is
  upstream Recoil, not something the speed patches introduced.
- **512 MB of pre-zeroed bitmap arena.** `TextureMemPoolSize` defaults to 512 and
  `TexMemPool::Resize` fills it with zeroes at startup. `WriteEngineConfig` now
  always writes `TextureMemPoolSize = 0`, which selects the engine's on-demand
  bitmap allocator instead — a headless run then holds the few bitmaps alive at
  once. Config only, no engine change.

Measured together: medium replay peak RSS 5396 -> 3852 MiB, isthmus 8v8 ~5.9 ->
4392 MiB, both gated byte-identical, sim wall unchanged.

Running out of memory ABANDONS one re-simulation, never the loop: `resim.Run`
wraps `resim.ErrOutOfMemory`, the daemon reports the job failed with
`errorKind: "oom"` (see JOB ERROR KINDS under worker/) and carries straight on to
the next one — a host too small for the games it is handed would otherwise stop
dead on the first big one. Abandoning is also CLEAN: `removeAbandonedStream`
deletes the widget's raw stream on every error path, because it lives in the data
dir (the Lua sandbox forces that), it is hundreds of megabytes, and a daemon that
keeps failing would accumulate one per game until the disk was the next thing to
go. Only the success path moves it out.

## GPU / headless caveat (engine-version dependent)

Some Recoil builds' `spring-headless` initialize a **null GL context (version
0.0)** and build a unit-icon **render-to-texture atlas** at load (`CIconHandler` /
`CTextureRenderAtlas`). On a **GPU-less** machine that render never completes
(`atlasRendered=0` loops forever), so the game never reaches "playing" and LuaUI
widgets — including the snapshotter — never load. Symptoms in `infolog.txt`: stuck at
`[f=-000001]`, endless `CreateAtlasTexture ... IconsAtlas_0` lines, no capture output.
The demo does re-simulate up to that point (you'll see players connect, initial spawns,
and demo chat replay), so this is purely a rendering-init wall, not a logic problem.

**Engine 2025.06.24 does not hit this wall**: on a GPU-less cloud VM (no X, no GL) a
source-built `spring-headless` ran a full replay to completion — its
`CreateAtlasTexture` fails fast under the null-GL stubs (`FBO::IsReady()`/`IsValid()`
false) and the retry is a cheap per-draw no-op instead of a load blocker
(`docs/building-recoil.md` has the validated run). If you do hit the symptoms above on
some other engine build, run on a host with **working GL** (a real GPU, or a full
software-GL setup). Notes for a GPU-less runner:

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

- every heartbeat: a `[barreplay] prof Sim=…ms Lua=…ms …` line (top 8, infolog only) —
  shows whether per-frame cost drifts as unit count grows;
- at game over: a final `P` record (top 80 scopes) written into the stream
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
also writes a `P` record (top 30 scopes, with the frame and unit count) each
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
  **On sandboxed BAR builds (2026.10.13 on) that runtime path is gone** (user
  widgets get a proxy handler), and the seeded config now does the job: the
  config barreplay writes (`engine.widgetConfigLua`) lists every widget the
  game package ships at order 0 — the names read from the rapid package
  (`engine.gameWidgetNames`: `packages/<md5>.sdp` index -> `pool/` files ->
  `luaui/widgets/*.lua` GetInfo literals, 320 for a current build), which
  answers "the names vary by game version" — and switches the Widget
  Selector's profiler column off (it wrapped every widget callin in a timer).
  Only the selector and BAR's "hidden" widgets stay forced on. On a 10k-unit
  late game this measured -6.2% main-thread cycles and 5 minutes of a whole
  verylarge1 re-sim (docs/worklog-engine-speed.md, W1 and W4).
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
draws/s late game despite `MinDrawFPS=1`). The PATCHED engine removes the governor:
`patches/engine-2026.07.04/0001-demo-unpaced-playback.patch` releases a demo's packets
at the client's consumption rate instead of `internalSpeed`'s pace — sync-safe, since
pacing changes only when pre-recorded packets are released, never their content
(measured +35% sim fps on an 8v8, sim 93% of wall). A stock engine still runs governed.

## Conventions / gotchas

- LICENSING: the repo is MIT (LICENSE), `patches/` is GPL-2.0-or-later (patches/LICENSE, it derives from Recoil), `internal/viz/bardata/` keeps BAR's licences — LICENCE_NOTICE says which is which, and the Credits dialog repeats it.
- Go module: `github.com/mabn/barreplay`, Go 1.24. No third-party deps (stdlib only). The one exception is `cmd/fogofwar`, a separate module (Wails, 7z) so the root stays stdlib-only; `go test ./...` from the root does not reach it — run it in `cmd/fogofwar`.
- Unit-def internal names (`armcom`, `corllt`, …) and side names (`armada`, `cortex`)
  have no spaces — the preamble `T` parser relies on that.
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
  frame/total, in-game time, %, processing fps, speed-up (fps/30), and ETA — the last two
  from `engine.SimETA`, which is also what the ingest daemon reports to a job, so the log
  line and the queue page always agree. Total game
  length comes from the demo header `GameTime`; the engine sims at 30 frames/game-second.
- Development happens on branch `claude/bar-replay-snapshots-g8jmfj`; `main` is the base.
