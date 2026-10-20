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
#   bench-ckpt.sh flame <engine-binary> <replay> <frame> <frames> <out.svg> [title]
#   bench-ckpt.sh abt   <engine-binary> <replay> <frame> <frames> <togglesA> <togglesB> [pairs]
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
# flame records the window with LBR call stacks (the CPU's last-branch record:
# no frame pointers or DWARF needed, ~16 frames deep) and renders the MAIN
# thread as a flame graph with FlameGraph ($FLAMEGRAPH, default
# ~/dev/FlameGraph; git clone https://github.com/brendangregg/FlameGraph).
#
# PERF="<perf record args>" (e.g. PERF="-F 999 -e cycles") also records a
# profile of the window into the checkpoint dir.
#
# CPUSET="<cpu list>" pins every engine thread for the trial (taskset -a);
# MAINCPU=<cpu> OTHERCPUS=<list> pins the main thread alone and the rest apart.
#
# PERFSTAT="<events>" counts hardware events per thread over the window
# (perf stat) into <ckpt dir>/perfstat.txt.
#
# COOL=<milli-degC> waits before each trial until the package is that cool
# (with the fans pinned at max, ~48 C is reachable at idle on the dev host).
#
# TOGGLES=<hex> passes the experiment toggles of a build that has them (the
# go file's "t=<hex>"; g_brToggles in the engine) to each trial, and `abt`
# interleaves two toggle settings of ONE binary from the same checkpoint —
# variants of an experiment need no second build or dump. TOGGLES2=<hex> is the
# second word ("t2=<hex>"; g_brToggles2) once the first ran out of bits; in
# `abt` a setting written <t>/<t2> sets both.
# P4CHECK=1 adds "p4check": the engine's P4 (and P10) check mode for the
# trial, which runs every pipelined search in order too and counts mismatches
# (a correctness test; the timings mean nothing).
#
# BARREPLAY=<path> (dump only) names the barreplay binary to re-simulate with;
# by default it is built from this checkout at each dump. Its id is kept in the
# checkpoint (barreplay.id) and `ab` refuses two checkpoints made by different
# ones: the checkpoint freezes the capture widget, which is part of the timing.
#
# BARREPLAY_ARGS="<flags>" (dump only) passes extra barreplay flags to the
# re-simulation, e.g. "-worker-threads 7"; they are frozen into the checkpoint,
# so dump such a variant under its own binary name (a copy of the binary).
#
# LUAPROF=1 asks a build carrying the Lua sampling profiler (bench harness,
# Recoil branch luaprof) to write the window's Lua call stacks, folded, to
# <ckpt dir>/result.luaprof (1 kHz of main-thread CPU time).
#
# Each trial prints the bench harness line: frames, units alive at the start,
# cycles, instructions (main thread) and the window's SimFrame wall time.
#
# MEMMAX=<size> (default 11G) and SWAPMAX=<size> (default 1G) cap the engine's
# memory, dumps and restores alike, in a scope of its own with OOMPolicy=
# continue: a runaway engine then dies by a cgroup OOM inside that scope. A
# GLOBAL OOM instead tears down the whole user scope it was started from — the
# tmux pane, and whatever was driving the benchmark (it happened once, an
# engine at 14.6 GB on a replay that peaks at 3.7).
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
BARREPLAY=${BARREPLAY:-}
MEMMAX=${MEMMAX:-11G}; SWAPMAX=${SWAPMAX:-1G}
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
	alone
	rm -rf "$dir"; mkdir -p "$dir/img" "$dir/files"
	# The checkpoint freezes the capture widget's Lua state, so the barreplay that
	# made it decides which widget every trial runs. Unless BARREPLAY names one,
	# build it from this checkout now: a binary built once and kept goes stale
	# (a W5 widget against a W7 one read as H83 +7.6%, 2026-10-17).
	local br=$BARREPLAY
	if [ -z "$br" ]; then
		br=$BR/barreplay-bench
		(cd "$BR" && go build -o "$br" ./cmd/barreplay) || die "build barreplay"
	fi
	[ -x "$br" ] || die "no barreplay binary $br"
	echo "$(sha256sum "$br" | cut -c1-16) $(go version -m "$br" | awk '$2 ~ /^vcs\.(revision|modified)=/ {printf "%s ", $2}')" > "$dir/barreplay.id"
	echo "== dump: $(basename "$bin") $2 ($id) up to frame $frame"
	(cd "$BR" && BARREPLAY_BENCH_START=$frame BARREPLAY_BENCH_N=1 BARREPLAY_PARK="$dir/park" \
		systemd-run --user --scope --quiet -p OOMPolicy=continue -p MemoryMax="$MEMMAX" -p MemorySwapMax="$SWAPMAX" \
		"$br" -data "$DATA" -progress=true ${BARREPLAY_ARGS:-} -engine "$bin" -out "$dir/out" "$id" > "$dir/barreplay.log" 2>&1) &
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

# alone: nothing else may run an engine meanwhile. A restored engine needs its
# old UDP game-server port back (criu: "Address already in use"), and a trial
# copies the checkpoint's open files back into the DATA DIR — the infolog and
# the widget stream — which would clobber another run's. (Also a timing rule.)
alone() {
	if pgrep -f "^[^ ]*/engine/[^ ]*/spring-headless" > /dev/null; then
		die "another engine is running (pgrep -af spring-headless); trials and dumps need the host to themselves"
	fi
}

# samewidget <bin> <bin> <replay> <frame>: two checkpoints compare only if the
# same barreplay (so the same capture widget) made them; one without a record
# (dumped before it was kept) only warns.
samewidget() {
	local a="$CKPT/$(basename "$(bindir "$1")")/$3-$4/barreplay.id" b="$CKPT/$(basename "$(bindir "$2")")/$3-$4/barreplay.id"
	if [ -s "$a" ] && [ -s "$b" ]; then
		[ "$(cat "$a")" = "$(cat "$b")" ] || die "the two checkpoints were dumped by different barreplay builds (so different widgets): $(cat "$a") vs $(cat "$b"); redump one"
	else
		echo "bench-ckpt: warning: no barreplay record for one of the checkpoints; make sure both were dumped by the same barreplay" >&2
	fi
}

# trial <bin> <replay> <frame> <frames>: restore once, time <frames> frames.
trial1() {
	alone
	local bin=$(bindir "$1") replay=$2 frame=$3 n=$4
	local dir="$CKPT/$(basename "$bin")/$replay-$frame"
	[ -d "$dir/img" ] || dump "$1" "$replay" "$frame" >&2
	# a failed copy (a full disk) otherwise shows up only as CRIU refusing the
	# file's size ("bad size 0") with no hint why
	while read -r k p; do cp -p "$dir/files/$k" "$p" || die "restoring $p for the trial failed"; done < "$dir/files/manifest"
	rm -f "$dir/park.go" "$dir/result"
	if [ -n "${COOL:-}" ]; then
		# start every trial from the same package temperature (milli-degC)
		local waited=0
		while [ "$(cat /sys/class/hwmon/hwmon1/temp1_input)" -ge "$COOL" ] && [ $waited -lt 300 ]; do sleep 2; waited=$((waited + 1)); done
	fi
	hostroot systemd-run --scope --quiet -p OOMPolicy=continue -p MemoryMax="$MEMMAX" -p MemorySwapMax="$SWAPMAX" criu restore -D "$dir/img" -j -d --manage-cgroups=ignore \
		--tcp-established -o restore.log -v2 || die "criu restore failed (see $dir/img/restore.log)"
	if [ -n "${MAINCPU:-}" ]; then
		# the main thread (tid == pid) alone on MAINCPU, every other thread on OTHERCPUS
		local epid=$(cat "$dir/park.ready")
		for t in /proc/$epid/task/*; do
			local tid=${t##*/}
			if [ "$tid" = "$epid" ]; then taskset -p -c "$MAINCPU" "$tid" > /dev/null
			else taskset -p -c "${OTHERCPUS:?}" "$tid" > /dev/null; fi
		done
	fi
	if [ -n "${CPUSET:-}" ]; then
		# pin every thread of the restored engine before releasing it
		taskset -a -p -c "$CPUSET" "$(cat "$dir/park.ready")" > /dev/null || die "taskset failed"
	fi
	local perfpid=
	if [ -n "${PERF:-}" ]; then
		# Profile exactly the timed window: attach to the restored engine
		# (CRIU restores its pid) before releasing it; stops when it exits.
		local pid=$(cat "$dir/park.ready")
		perf record $PERF -p "$pid" -o "$dir/perf-$(date +%s).data" > "$dir/perf.log" 2>&1 &
		perfpid=$!
		sleep 1
	fi
	if [ -n "${PERFSTAT:-}" ]; then
		# hardware counters per thread over exactly the window
		perf stat -p "$(cat "$dir/park.ready")" --per-thread -e "$PERFSTAT" -o "$dir/perfstat.txt" &
		perfpid=$!
		sleep 1
	fi
	echo "$n $dir/result${LUAPROF:+ luaprof}${TOGGLES:+ t=$TOGGLES}${TOGGLES2:+ t2=$TOGGLES2}${P4CHECK:+ p4check}" > "$dir/park.go"
	local t=0
	while [ ! -s "$dir/result" ]; do
		sleep 0.5; t=$((t + 1))
		[ $t -gt 7200 ] && die "no result after an hour"
	done
	sleep 0.2
	if [ -n "${LUAPROF:-}" ]; then # the profile is written after the result line
		local epid=$(cat "$dir/park.ready")
		while kill -0 "$epid" 2>/dev/null; do sleep 0.2; done
	fi
	[ -n "$perfpid" ] && wait $perfpid 2>/dev/null
	tail -1 "$dir/result"
}

flame() {
	local bin=$(bindir "$1") replay=$2 frame=$3 n=$4 out=$5 title=${6:-}
	local dir="$CKPT/$(basename "$bin")/$replay-$frame" fg=${FLAMEGRAPH:-$HOME/dev/FlameGraph}
	local res=$(PERF="-F 499 -e cycles --call-graph lbr" trial1 "$1" "$replay" "$frame" "$n")
	local data=$(ls -t "$dir"/perf-*.data | head -1)
	perf script -i "$data" --comm recoil-main --no-inline 2>/dev/null | "$fg/stackcollapse-perf.pl" > "$data.folded"
	"$fg/flamegraph.pl" --title "${title:-$(basename "$bin") $replay frames $frame+$n, main thread}" \
		--subtitle "$(echo "$res" | grep -oE "units=[0-9]+|wall_ms=[0-9.]+" | tr '\n' ' ')" "$data.folded" > "$out"
	echo "$res"
	echo "flame graph: $out"
}

case "${1:-}" in
	dump)  dump "$2" "$3" "$4" ;;
	trial) for i in $(seq 1 "${6:-1}"); do echo "$(basename "$2") $(trial1 "$2" "$3" "$4" "$5")"; done ;;
	ab)    samewidget "$2" "$3" "$4" "$5"
	       for i in $(seq 1 "${7:-3}"); do
	           if [ $((i % 2)) -eq 1 ]; then o="$2 $3"; else o="$3 $2"; fi
	           for b in $o; do echo "pair $i $(basename "$b") $(trial1 "$b" "$4" "$5" "$6")"; done
	       done ;;
	flame) flame "$2" "$3" "$4" "$5" "$6" "${7:-}" ;;
	abt)   for i in $(seq 1 "${8:-3}"); do
	           if [ $((i % 2)) -eq 1 ]; then o="$6 $7"; else o="$7 $6"; fi
	           for t in $o; do echo "pair $i t=$t $(TOGGLES=${t%%/*} TOGGLES2=$([ "${t#*/}" != "$t" ] && echo "${t#*/}") trial1 "$2" "$3" "$4" "$5")"; done
	       done ;;
	*) sed -n '2,40p' "$0"; exit 2 ;;
esac
