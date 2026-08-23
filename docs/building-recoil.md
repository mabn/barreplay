# Building the Recoil engine from source (validated recipe)

Validated 2026-07-06 on a GPU-less 4-core Ubuntu 24.04 cloud VM by re-simulating
replay `96224c6a18eaee9ff95a7d95e603e6d1` (engine 2025.06.24, `Beyond All Reason
test-30591-f79033c`, map "Eternal Consequences 1.2", 14:22 game) with a
source-built `spring-headless` and diffing the `.brsnap` against a capture made
with the official release binary: **byte-identical** after stripping only the
`BRSNAP PROF` lines (wall-clock timings, inherently non-deterministic). Building
from source is the prerequisite for the engine-patch speed lever noted in
CLAUDE.md ("Replay speed is governed by the local server").

## Why the official Docker build environment

The engine's release binaries are produced inside a pinned Docker image
(Ubuntu 18.04 + gcc-13 + `spring-static-libs`), so building in that same image
reproduces the official toolchain and flags exactly — no dependency hunting, and
maximum confidence that sync behaviour matches the demo's recording engine. The
image is public on ghcr.io; only `docker` is needed on the host.

## Recipe

```sh
# 1. The replay pins the engine version exactly (demo header / api.bar-rts.com
#    "engineVersion"). Clone that tag; skip the AI bots (CircuitAI is huge).
git clone --branch 2025.06.24 --depth 1 https://github.com/beyond-all-reason/RecoilEngine.git recoil
cd recoil
# THE SUBMODULE SET IS ALSO PER TAG: this list is what 2025.06.24 needed, and
# 2026.07.04 additionally requires fmt, mimalloc, nowide, streflop, sse2neon and
# tools/unitsync/python (without them configure fails with "does not contain a
# CMakeLists.txt file", naming one at a time). When in doubt initialise
# everything except AI/Skirmish/* — CircuitAI is the only genuinely huge one.
git submodule update --init --recursive --depth 1 \
    rts/lib/RmlUi rts/lib/cereal rts/lib/entt rts/lib/fastgltf rts/lib/gflags \
    rts/lib/lunasvg rts/lib/simdjson rts/lib/tracy tools/pr-downloader
# keep the tree clean or `git describe` taints the version string the engine
# reports (must equal the tag, e.g. "2025.06.24", for the demo to match)

# 2. Pull the pinned build image. THE DIGEST IS PER TAG — read it from the tag
#    you just checked out, never from a previous build's notes.
source docker-build-v2/images_versions.sh
IMG="ghcr.io/beyond-all-reason/recoil-build-amd64-linux@${image_version[amd64-linux]}"
docker pull "$IMG"

# 3. Configure with the official release flags (docker-build-v2/scripts/configure.sh:
#    RELWITHDEBINFO, -O3) + AI disabled. src is mounted read-only, exactly like
#    the official build.sh (which also works if you have a TTY; this variant
#    doesn't need one and tolerates running as root).
mkdir -p build-linux .cache/ccache-linux
drun() { docker run --rm --user=0:0 \
    -v "$(pwd)":/build/src:ro \
    -v "$(pwd)/.cache/ccache-linux":/build/cache:rw \
    -v "$(pwd)/build-linux":/build/out:rw \
    "$IMG" bash -c "$1"; }
drun 'git config --global safe.directory "*" && cd /build/src/docker-build-v2/scripts && ./configure.sh -DAI_TYPES=NONE'

# 4. Build only what barreplay needs (~35 min on 4 cores, 1183 objects;
#    a full default build with the graphical client is much longer).
drun 'cd /build/out && ninja -j$(nproc) spring-headless tools/pr-downloader/src/pr-downloader base/springcontent.sdz base/spring/bitmaps.sdz'

# 5. Assemble the engine dir barreplay expects (<data>/engine/<version>/).
#    The binary lands at build-linux/spring-headless (build root, not
#    rts/builds/headless/). It carries ~780 MB of debug info; strip if you care.
D=<BARdata>/engine/2025.06.24
mkdir -p "$D"
cp build-linux/spring-headless build-linux/tools/pr-downloader/src/pr-downloader "$D"
cp -r build-linux/base cont/fonts "$D"

"$D"/spring-headless --version   # must print exactly "spring-headless version 2025.06.24 (Headless)"

# NOTE: keep the binary INSIDE that dir. The engine resolves base/springcontent.sdz
# relative to its own executable, so running a build from somewhere else via
# -engine dies with "failed to open archive 'Spring content v1'" — and barreplay
# then reports a missing widget output, which looks like a widget problem.
```

Then a normal run picks it up automatically:

```sh
barreplay -data <BARdata> -out ./snaps -progress <gameId>
```

`barreplay` resolves the game's rapid tag, and `pr-downloader` (the one just
built) fetches game + map as usual. A map can also be fetched without
pr-downloader: query
`https://files-cdn.beyondallreason.dev/find?category=map&springname=<name>` and
download the `mirrors[0]` URL into `<BARdata>/maps/` (the springfiles-compatible
endpoint from CLAUDE.md; verify the `md5` field).

## The PATCHED build the re-sim daemon prefers

`bringest -resim` runs `spring-headless-patched` if it finds one beside the stock
binary (`-patched-engine`, default on; `engine.Locate` looks at exactly that one
path). That build is this same recipe with `patches/engine-<version>/` applied
first — byte-identical output, faster and much smaller in memory, which is why
preferring it can be a default. `RESULTS.md` and `MEMORY.md` in that directory
carry the measurements; what follows is how to produce one.

```sh
# 1. Clean checkout of the tag, then the series, in this order. bench-harness
#    first because the rest were authored on top of it; H31 before H30; the
#    memory patch last. Nothing else in the series touches the file 0003 does,
#    so only the speed patches are order-sensitive among themselves.
P=<barreplay>/patches/engine-2026.07.04
git checkout -b patched 2026.07.04
git am "$P/experiments/tools/bench-harness.patch" \
       "$P/0001-demo-unpaced-playback.patch" \
       "$P/0002-headless-replay-unsynced-cuts.patch" \
       "$P/experiments/H1-skip-prevframe-transform-save.patch" \
       "$P/experiments/H2-tickallanims-sort-skip-bfs-scratch.patch" \
       "$P/experiments/H3-threadpool-clock-storm.patch" \
       "$P/experiments/H4-skip-eager-piece-walk.patch" \
       "$P/experiments/H5-formt-batch-claiming.patch" \
       "$P/experiments/H6-cob-unchecked-fetch.patch" \
       "$P/experiments/H23-tickallanims-switch-dispatch.patch" \
       "$P/experiments/H31-movemath-flat-collision-cache.patch" \
       "$P/experiments/H30-yardmap-coarse-exitonly-grid.patch" \
       "$P/experiments/H21-cob-jumptable-dispatch.patch" \
       "$P/experiments/H45-qtpfs-relink-grid-no-reinit.patch" \
       "$P/experiments/H49-headless-skip-smt-tiles.patch" \
       "$P/0003-static-mempool-lazy-zeroing.patch"

# 2. Build exactly as above (steps 2-4), then install BESIDE the stock binary,
#    under the -patched name. Both live in the same dir on purpose: the engine
#    resolves base/springcontent.sdz relative to its own executable, so a
#    separate <version>-patched dir would duplicate the whole base/ + fonts
#    payload per version.
D=<BARdata>/engine/2026.07.04
cp build-linux/spring-headless "$D/spring-headless-patched"

# 3. GATE IT before letting the daemon publish from it. The contract is that a
#    patched build produces the SAME .brp, so the check is an md5 against a
#    capture from the stock binary (references in
#    patches/engine-2026.07.04/experiments/tools/refs.txt).
barreplay -data <BARdata> -engine "$D/spring-headless-patched" -out /tmp/out <gameId>
md5sum /tmp/out/<gameId>.brp
```

A missing patched build is a warning, not a failure — nothing downloads these,
so a daemon routinely meets engine versions nobody has patched and runs those at
stock speed. Which build ran is recorded per job as `jobStats.enginePatched`,
because the capture itself cannot say: being byte-identical is the whole point.

## Observations from the validated run

- **GPU-less headless works on 2025.06.24.** The icon-atlas wall described in
  CLAUDE.md ("GPU / headless caveat") did not occur: `CTextureRenderAtlas::
  CreateAtlasTexture` fails fast under the null-GL stubs (`FBO::IsValid()` is
  false, the retry is a cheap per-draw no-op) and the game reaches "playing"
  normally. The 14:22 game re-simmed in 1m18s wall = 35 s load + 42 s sim
  (606 sim-fps, 20.2× realtime) on 4 cores with default `-disable-widgets`
  `-throttle-draw`.
- **Version fidelity matters end to end**: the demo header's engine version,
  the git tag built, the directory name under `engine/`, and the binary's
  self-reported version must all agree; a dirty source tree breaks the last one.
- **Determinism check**: with the same widget config and `-every`, two captures
  of the same demo differ only in `BRSNAP PROF*` lines. `grep -v "^BRSNAP PROF"`
  both `.brsnap` files and `diff` — anything else indicates a real divergence
  (wrong engine build, wrong game archive, or a sync bug).
- GitHub **release-asset downloads** (`github.com/**/releases/download/…`) can
  be blocked in restricted environments even when `git clone` and `ghcr.io`
  pulls work — another reason the source build path matters.
