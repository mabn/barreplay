#!/bin/bash
# bench-ckpt.sh — benchmark the engine on a LATE-GAME state without
# re-simulating the game up to it every time.
#
# A re-simulation is cheap while there are few units and gets up to ~20x
# slower once a big game has thousands of them, so timing a whole replay (or
# a small one) says little about the part that costs the hours. This harness
# runs a replay ONCE up to a chosen frame, checkpoints the whole engine
# process there with CRIU, and then restores that image as often as wanted,
# timing the next N sim frames from exactly the same state each time.
#
#   bench-ckpt.sh dump  <engine-binary> <replay> <frame>   # once per build
#   bench-ckpt.sh trial <engine-binary> <replay> <frame> <frames> [n]
#   bench-ckpt.sh ab    <binA> <binB> <replay> <frame> <frames> [pairs]
#
# <replay> is a gameId or a name from REPLAYS below. <engine-binary> must sit
# in <data>/engine/<version>/ beside the stock engine (it finds base/ there)
# and must carry the bench harness with its PARK point
# (patches/engine-2026.07.04/experiments/tools/bench-harness.patch). A
# checkpoint only restores into the binary that made it, so `ab` dumps each
# build once (cached under $CKPT/<binary>/<replay>-<frame>) and interleaves
# their trials; builds that pass the byte-identity gate reach the same state at
# <frame>, so the trials are comparable.
#
# PERF="<perf record args>" (e.g. PERF="-F 999 -e cycles") also records a
# profile of the window into the checkpoint dir.
#
# Each trial prints the bench harness line: frames, units alive at the start,
# cycles, instructions (main thread) and the window's SimFrame wall time.
#
# Needs: criu (apt install criu) and root for it, which this script gets
# through sudo docker (a privileged container entering the host's namespaces;
# the restore runs in its own systemd scope so the container's exit does not
# kill it). perf counters need kernel.perf_event_paranoid <= 1.
set -u

REPLAYS="verylarge1=6a37d06acbb455b1d19179d8ec965f10 medium=4936896a8b258d038cbd28f55eb15ed2 isthmus=6122896ac3328104d12093d975c61214"
BR=${BR:-$(cd "$(dirname "$0")/../.." && pwd)}
DATA=${DATA:-$BR/.bardata}
CKPT=${CKPT:-$HOME/dev/perf3/ckpt}
BARREPLAY=${BARREPLAY:-$BR/barreplay-bench}
IMG=${CRIU_IMAGE:-ghcr.io/beyond-all-reason/recoil-build-amd64-linux@sha256:31b3667ba0d37620b4ad9b45d1840c8d3e95317f2b233044d2e17697ce8fe61d}

die() { echo "bench-ckpt: $*" >&2; exit 1; }
hostroot() { sudo -n docker run --rm --privileged --pid=host --net=host --ipc=host "$IMG" nsenter -t 1 -m -u -i -n -p -- "$@"; }
gameid() {
	for kv in $REPLAYS; do [ "${kv%%=*}" = "$1" ] && { echo "${kv#*=}"; return; }; done
	echo "$1"
}
bindir() { # <binary path or name> -> absolute path
	case "$1" in
		/*) echo "$1" ;;
		*) ls -d "$DATA"/engine/*/"$1" 2>/dev/null | head -1 ;;
	esac
}

# dump <bin> <replay> <frame>: re-simulate to <frame>, park, checkpoint.
dump() {
	local bin=$(bindir "$1") id=$(gameid "$2") frame=$3
	[ -x "$bin" ] || die "no engine binary $1"
	local dir="$CKPT/$(basename "$bin")/$2-$frame"
	rm -rf "$dir"; mkdir -p "$dir/img" "$dir/files"
	[ -x "$BARREPLAY" ] || (cd "$BR" && go build -o "$BARREPLAY" ./cmd/barreplay) || die "build barreplay"
	echo "== dump: $(basename "$bin") $2 ($id) up to frame $frame"
	(cd "$BR" && BARREPLAY_BENCH_START=$frame BARREPLAY_BENCH_N=1 BARREPLAY_PARK="$dir/park" \
		"$BARREPLAY" -data "$DATA" -progress=true -engine "$bin" -out "$dir/out" "$id" > "$dir/barreplay.log" 2>&1) &
	local brpid=$!
	while [ ! -s "$dir/park.ready" ]; do
		kill -0 $brpid 2>/dev/null || die "the re-simulation ended before frame $frame (see $dir/barreplay.log)"
		sleep 2
	done
	local pid=$(cat "$dir/park.ready")
	echo "parked: engine pid $pid at frame $frame"
	# The files the engine has open: CRIU reopens them by path on restore, so
	# each trial puts back the copy taken here (the run goes on writing to them).
	: > "$dir/files/manifest"
	for fd in /proc/$pid/fd/*; do
		local p=$(readlink "$fd")
		case "$p" in
			/*) [ -f "$p" ] || continue
				local k=$(echo "$p" | md5sum | cut -c1-12)
				cp -p "$p" "$dir/files/$k" && echo "$k $p" >> "$dir/files/manifest" ;;
		esac
	done
	hostroot criu dump -t "$pid" -D "$dir/img" -j --manage-cgroups=ignore --tcp-established \
		-o dump.log -v2 || die "criu dump failed (see $dir/img/dump.log)"
	wait $brpid 2>/dev/null
	echo "checkpoint: $dir ($(du -sh "$dir/img" | cut -f1))"
}

# trial <bin> <replay> <frame> <frames>: restore once, time <frames> frames.
trial1() {
	local bin=$(bindir "$1") replay=$2 frame=$3 n=$4
	local dir="$CKPT/$(basename "$bin")/$replay-$frame"
	[ -d "$dir/img" ] || dump "$1" "$replay" "$frame" >&2
	while read -r k p; do cp -p "$dir/files/$k" "$p"; done < "$dir/files/manifest"
	rm -f "$dir/park.go" "$dir/result"
	hostroot systemd-run --scope --quiet criu restore -D "$dir/img" -j -d --manage-cgroups=ignore \
		--tcp-established -o restore.log -v2 || die "criu restore failed (see $dir/img/restore.log)"
	local perfpid=
	if [ -n "${PERF:-}" ]; then
		# Profile exactly the timed window: attach to the restored engine
		# (CRIU restores its pid) before releasing it; stops when it exits.
		local pid=$(cat "$dir/park.ready")
		perf record $PERF -p "$pid" -o "$dir/perf-$(date +%s).data" > "$dir/perf.log" 2>&1 &
		perfpid=$!
		sleep 1
	fi
	echo "$n $dir/result" > "$dir/park.go"
	local t=0
	while [ ! -s "$dir/result" ]; do
		sleep 0.5; t=$((t + 1))
		[ $t -gt 7200 ] && die "no result after an hour"
	done
	sleep 0.2
	[ -n "$perfpid" ] && wait $perfpid 2>/dev/null
	tail -1 "$dir/result"
}

case "${1:-}" in
	dump)  dump "$2" "$3" "$4" ;;
	trial) for i in $(seq 1 "${6:-1}"); do echo "$(basename "$2") $(trial1 "$2" "$3" "$4" "$5")"; done ;;
	ab)    for i in $(seq 1 "${7:-3}"); do
	           if [ $((i % 2)) -eq 1 ]; then o="$2 $3"; else o="$3 $2"; fi
	           for b in $o; do echo "pair $i $(basename "$b") $(trial1 "$b" "$4" "$5" "$6")"; done
	       done ;;
	*) sed -n '2,32p' "$0"; exit 2 ;;
esac
