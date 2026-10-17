#!/bin/bash
# build.sh — cross-compile the patched engine of this series for Windows
# (spring-headless.exe), for the FogOfWar.exe volunteer re-sim worker.
#
#   build.sh <recoil CLONE with the series applied> <work dir>
#
# The source is prepared exactly as for the Linux build (docs/building-recoil.md,
# "The PATCHED build"): a real clone of the 2026.07.04 tag, every submodule but
# AI/Skirmish/*, then `git am` of ../series AND of this directory's
# windows-series (Windows-only build fixes on top; see that file). The engine
# takes its version from git describe, so it must be a real clone, not a
# worktree.
#
# It runs Recoil's own pinned amd64-windows image (Ubuntu 24.04 + MinGW-w64
# gcc, posix threads, and BAR's mingwlibs64), the image that builds the
# official Windows release, with the official configure.sh. Differences from
# that release: -O3 -DNDEBUG with no -g (the release keeps -g and splits the
# debug info off), AI disabled, and only spring-headless is built.
#
# NO PGO+LTO, unlike the Linux build of this revision: pgo/profile.tar.xz is
# GCC profile data keyed to the Linux build's object paths and compiler, so it
# does not apply here. Same patches, plainer codegen.
#
# Output: <work>/out/spring-headless.exe. It links against the same DLLs as the
# stock release's spring-headless.exe (libIL, libcurl, libfreetype-6, zlib1 and
# system DLLs), so it runs from inside a stock install, beside the stock exe,
# as spring-headless-patched.exe — the engine resolves base/ relative to itself.
set -euo pipefail
SRC=$(cd "$1" && pwd); WORK=$(mkdir -p "$2" && cd "$2" && pwd)
source "$SRC/docker-build-v2/images_versions.sh"
IMG="ghcr.io/beyond-all-reason/recoil-build-amd64-windows@${image_version[amd64-windows]}"
DOCKER=${DOCKER:-docker}
F="-O3 -DNDEBUG"
mkdir -p "$WORK/out" "$WORK/cache"
$DOCKER run --rm --user=0:0 -v "$SRC":/build/src:ro -v "$WORK/out":/build/out:rw \
	-v "$WORK/cache":/build/cache:rw "$IMG" bash -c "
git config --global safe.directory '*'
cd /build/src/docker-build-v2/scripts && ./configure.sh -DAI_TYPES=NONE \
	-DCMAKE_CXX_FLAGS_RELWITHDEBINFO='$F' -DCMAKE_C_FLAGS_RELWITHDEBINFO='$F'
cd /build/out && ninja -j\$(nproc) spring-headless
status=\$?
chown -R $(id -u):$(id -g) /build/out /build/cache   # the container runs as root
exit \$status"
echo "built: $WORK/out/spring-headless.exe"
