#!/bin/bash
# fullrun.sh <engine name in .bardata/engine/2026.07.04> <tag> [toggles hex]: whole verylarge1
# re-sim, perf stat per thread on the engine, md5 of the .brp, package throttle count delta.
set -u
eng=$1; tag=$2; tog=${3:-0}
BIN=${BIN:-${SCRATCH:-/tmp}/barreplay-gate}
cd /home/mabn/dev/barreplay
rm -rf /home/mabn/dev/perf3/full-$tag
t0=$(cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count)
BARREPLAY_TOGGLES=$tog $BIN -data .bardata -progress=false ${ARGS:-} -engine .bardata/engine/2026.07.04/$eng -out /home/mabn/dev/perf3/full-$tag 6a37d06acbb455b1d19179d8ec965f10 > /home/mabn/dev/perf3/full-$tag.log 2>&1 &
bp=$!
until pid=$(pgrep -f "^[^ ]*/engine/[^ ]*/$eng( |$)" | head -1) && [ -n "$pid" ]; do sleep 0.5; done
# attach only once the thread pool exists: perf stat -p folds threads created later into their parent
until [ "$(ls /proc/$pid/task 2>/dev/null | wc -l)" -ge 8 ]; do sleep 1; done; sleep 10
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
