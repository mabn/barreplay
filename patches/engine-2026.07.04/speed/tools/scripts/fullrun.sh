#!/bin/bash
# fullrun.sh <engine name in .bardata/engine/2026.07.04> <tag> [toggles hex]: whole verylarge1
# re-sim, perf stat per thread on the engine, md5 of the .brp, package throttle count delta.
set -u
eng=$1; tag=$2; tog=${3:-0}
BIN=${BIN:-/tmp/claude-1000/-home-mabn-dev-barreplay/5e100656-ada3-484a-90e6-092d07e172ef/scratchpad/barreplay-gate}
cd /home/mabn/dev/barreplay
rm -rf /home/mabn/dev/perf3/full-$tag
# start every run from the same package temperature (milli-degC; 0 = don't wait),
# so no run pays a pause during its load for the run before it
COOL_START=${COOL_START:-50000}
if [ "$COOL_START" != 0 ]; then
	waited=0
	while [ "$(cat /sys/class/hwmon/hwmon1/temp1_input)" -ge "$COOL_START" ] && [ $waited -lt 600 ]; do sleep 2; waited=$((waited + 1)); done
fi
t0=$(cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count)
# barreplay resolves the replay through api.bar-rts.com: a DNS blip once ended
# a run before its engine started (and the wait below then spun forever), so
# wait for the name, and launch again if barreplay exits with no engine
for attempt in 1 2 3; do
	for i in $(seq 120); do getent hosts api.bar-rts.com >/dev/null && break; sleep 5; done
	# capped scope of its own: a runaway engine dies by a cgroup OOM there instead
	# of a global OOM tearing down the scope this was started from
	BARREPLAY_TOGGLES=$tog systemd-run --user --scope --quiet -p OOMPolicy=continue -p MemoryMax=${MEMMAX:-12G} -p MemorySwapMax=${SWAPMAX:-1G} $BIN -data .bardata -progress=false ${ARGS:-} -engine .bardata/engine/2026.07.04/$eng -out /home/mabn/dev/perf3/full-$tag 6a37d06acbb455b1d19179d8ec965f10 > /home/mabn/dev/perf3/full-$tag.log 2>&1 &
	bp=$!
	# the run's engine has --write-dir on its command line; barreplay's earlier
	# `<engine> --version` probe has not, and latching onto that pid (gone a moment
	# later) once left a whole run without its governor and perf stat
	pid=""
	until pid=$(pgrep -f "^[^ ]*/engine/[^ ]*/$eng .*--write-dir" | head -1) && [ -n "$pid" ]; do
		kill -0 $bp 2>/dev/null || break
		sleep 0.5
	done
	[ -n "$pid" ] && break
	echo "fullrun: barreplay exited before its engine started (attempt $attempt): $(tail -1 /home/mabn/dev/perf3/full-$tag.log | cut -c1-200)" >&2
	sleep 30
done
[ -n "$pid" ] || { echo "fullrun: no engine after 3 attempts" >&2; exit 1; }
date +%s.%N > /home/mabn/dev/perf3/full-$tag.start
: > /home/mabn/dev/perf3/full-$tag.pauses
# attach only once the thread pool exists: perf stat -p folds threads created later into their parent
until [ "$(ls /proc/$pid/task 2>/dev/null | wc -l)" -ge 8 ]; do kill -0 $pid 2>/dev/null || { echo "fullrun: engine $pid gone before its thread pool" >&2; exit 1; }; sleep 1; done; sleep 10
# PIN=1: the main thread alone on cpu ${MAINCPU:-3}, every other thread on ${OTHERCPUS:-0,1,2,4,5,6}
# (cpu 7, the main thread's hyperthread sibling, left idle), as the bench harness runs
if [ "${PIN:-0}" = 1 ]; then
	for t in /proc/$pid/task/*; do taskset -p -c ${OTHERCPUS:-0,1,2,4,5,6} ${t##*/} >/dev/null; done
	taskset -p -c ${MAINCPU:-3} $pid >/dev/null
	# threads started later (the huge-page collapser, at frame 0) inherit the
	# main thread's cpu: move them off it while the engine runs
	( while kill -0 $pid 2>/dev/null; do
		for t in /proc/$pid/task/*; do [ "${t##*/}" != $pid ] && taskset -p -c ${OTHERCPUS:-0,1,2,4,5,6} ${t##*/} >/dev/null 2>&1; done
		sleep 10
	  done ) &
fi
perf stat --per-thread -e instructions:u,cycles:u,task-clock -p $pid -o /home/mabn/dev/perf3/full-$tag.stat &
sp=$!
# thermal governor (HOT=0 disables): SIGSTOP the engine near the throttling
# temperature, SIGCONT once cooled; the paused time is subtracted afterwards
HOT=${HOT:-88000}; COLD=${COLD:-55000}
pausefile=/home/mabn/dev/perf3/full-$tag.paused; echo 0 > $pausefile
if [ "$HOT" != 0 ]; then
	( paused=0
	  while kill -0 $pid 2>/dev/null; do
		if [ "$(cat /sys/class/hwmon/hwmon1/temp1_input)" -ge "$HOT" ]; then
			t0=$(date +%s.%N); kill -STOP $pid
			while [ "$(cat /sys/class/hwmon/hwmon1/temp1_input)" -ge "$COLD" ]; do sleep 0.5; done
			kill -CONT $pid; t1=$(date +%s.%N)
			echo "$t0 $t1" >> /home/mabn/dev/perf3/full-$tag.pauses
			paused=$(echo "$paused + $t1 - $t0" | bc); echo $paused > $pausefile
		fi
		sleep 0.25
	  done ) &
fi
wait $bp
sleep 1; kill -INT $sp 2>/dev/null; wait $sp 2>/dev/null
t1=$(cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count)
echo "$tag (t=$tog): $(grep 'engine total' /home/mabn/dev/perf3/full-$tag.log) md5=$(md5sum /home/mabn/dev/perf3/full-$tag/*.brp | cut -c1-32) throttle+$((t1-t0)) paused=$(cat $pausefile)s"
grep -E 'recoil-main|worker' /home/mabn/dev/perf3/full-$tag.stat | grep -E "task-clock|cycles" | head -10
# active sim time: sim minus the pauses that fell after the sim started
# (engine start + the reported load); pauses during load are load's business
python3 - /home/mabn/dev/perf3/full-$tag.log /home/mabn/dev/perf3/full-$tag.start /home/mabn/dev/perf3/full-$tag.pauses <<'PY'
import re, sys
log, start, pauses = sys.argv[1:4]
line = next((l for l in open(log) if "engine total" in l), "")
def secs(t):
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?", t)
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + float(m.group(3) or 0)
m = re.search(r"load (\S+) \+ sim (\S+) ", line)
if m:
    load, sim = secs(m.group(1)), secs(m.group(2))
    simStart = float(open(start).read()) + load
    inSim = 0.0
    for l in open(pauses):
        a, b = map(float, l.split())
        inSim += max(0.0, b - max(a, simStart))
    act = sim - inSim
    print(f"active sim: {int(act // 60)}m{act % 60:04.1f}s  (sim {sim:.0f}s, paused during sim {inSim:.0f}s, load {load:.0f}s)")
PY
