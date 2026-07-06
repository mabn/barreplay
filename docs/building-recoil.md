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
git submodule update --init --recursive --depth 1 \
    rts/lib/RmlUi rts/lib/cereal rts/lib/entt rts/lib/fastgltf rts/lib/gflags \
    rts/lib/lunasvg rts/lib/simdjson rts/lib/tracy tools/pr-downloader
# keep the tree clean or `git describe` taints the version string the engine
# reports (must equal the tag, e.g. "2025.06.24", for the demo to match)

# 2. Pull the pinned build image (digest in docker-build-v2/images_versions.sh).
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
