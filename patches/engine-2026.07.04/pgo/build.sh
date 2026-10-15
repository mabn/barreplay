#!/bin/bash
# build.sh — build the PGO+LTO patched engine of this series (revision 3 on).
#
#   build.sh <recoil checkout with the series applied> <work dir> [gen|use]
#
# use (default): unpack profile.tar.xz and build spring-headless with
#   -O3 -flto=4 -fprofile-use -fprofile-partial-training   (no -g)
#   in the official pinned build image, with the LTO-aware gcc-ar/gcc-ranlib
#   (plain `ar` writes no LTO symbol index and the link loses every symbol in
#   a static library). Output: <work>/build-use/spring-headless.
# gen: the INSTRUMENTED build (-fprofile-generate, linked -Wl,-u,__gcov_dump
#   so the bench harness can write the profile before its _exit) — for making
#   a new profile: run it on training replays, then tar the profile dir back
#   into profile.tar.xz (that is a new revision of the series).
#
# The profile's .gcda names encode the object paths under /build/out, and the
# profile dir must be mounted at the SAME absolute path in the gen run and the
# use build, which is why both live under <work>. A changed profile needs a
# CLEAN build dir: ninja does not track .gcda files, and under LTO the profile
# is applied when each object is compiled, not at the link.
#
# Training of the current profile: the medium gate replay 4936896a…, the
# sandboxed-BAR game c04fd06a…, and verylarge1 6a37d06a… up to frame 65580
# (docs/worklog-engine-speed.md).
set -euo pipefail
SRC=$(cd "$1" && pwd); WORK=$(mkdir -p "$2" && cd "$2" && pwd); MODE=${3:-use}
HERE=$(cd "$(dirname "$0")" && pwd)
source "$SRC/docker-build-v2/images_versions.sh"
IMG="ghcr.io/beyond-all-reason/recoil-build-amd64-linux@${image_version[amd64-linux]}"
PROF=$WORK/prof
DOCKER=${DOCKER:-docker}
if [ "$MODE" = gen ]; then
	F="-O3 -g -DNDEBUG -fprofile-generate=$PROF -fprofile-update=prefer-atomic"
	L="-fuse-ld=gold -fprofile-generate=$PROF -Wl,-u,__gcov_dump"
	X=""
else
	rm -rf "$PROF"; tar -C "$WORK" -xJf "$HERE/profile.tar.xz"
	F="-O3 -DNDEBUG -flto=4 -fprofile-use=$PROF -fprofile-partial-training -Wno-missing-profile -Wno-coverage-mismatch"
	L="-fuse-ld=gold -flto=4 -fprofile-use=$PROF -fprofile-partial-training"
	X="-DCMAKE_AR=/usr/bin/gcc-ar-13 -DCMAKE_RANLIB=/usr/bin/gcc-ranlib-13 -DCMAKE_CXX_COMPILER_AR=/usr/bin/gcc-ar-13 -DCMAKE_C_COMPILER_AR=/usr/bin/gcc-ar-13 -DCMAKE_CXX_COMPILER_RANLIB=/usr/bin/gcc-ranlib-13 -DCMAKE_C_COMPILER_RANLIB=/usr/bin/gcc-ranlib-13"
fi
OUT=$WORK/build-$MODE; rm -rf "$OUT"; mkdir -p "$OUT" "$PROF"
$DOCKER run --rm --user=0:0 -v "$SRC":/build/src:ro -v "$OUT":/build/out:rw -v "$PROF":"$PROF":rw "$IMG" bash -c "
git config --global safe.directory '*'
cd /build/src/docker-build-v2/scripts && ./configure.sh -DAI_TYPES=NONE \
	-DCMAKE_CXX_FLAGS_RELWITHDEBINFO='$F' -DCMAKE_C_FLAGS_RELWITHDEBINFO='$F' \
	-DCMAKE_EXE_LINKER_FLAGS='$L' -DCMAKE_SHARED_LINKER_FLAGS='$L' $X
cd /build/out && ninja -j\$(nproc) spring-headless"
echo "built: $OUT/spring-headless"
