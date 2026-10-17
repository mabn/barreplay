#!/bin/bash
# pgotrain.sh <instrumented engine name in .bardata/engine/2026.07.04> <toggles hex>
# Runs the training replays of the PGO profile on an instrumented (gen) build,
# one after another (libgcov merges each run's counters into the profile dir):
# the medium gate replay and the sandboxed-BAR game whole, then verylarge1 up
# to frame 65580 (the bench harness dumps the counters before its _exit).
set -u
eng=$1; tog=$2
BR=/home/mabn/dev/barreplay; E=$BR/.bardata/engine/2026.07.04; P=/home/mabn/dev/perf3
BIN=${BIN:-${SCRATCH:-/tmp}/barreplay-w6}
cd $BR
for g in 4936896a8b258d038cbd28f55eb15ed2 c04fd06a6d78e87c418d09f698e84071; do
	rm -rf $P/train-out
	BARREPLAY_TOGGLES=$tog $BIN -data .bardata -progress=false -engine $E/$eng -out $P/train-out $g > $P/train-$g.log 2>&1
	echo "$g: $(grep 'engine total' $P/train-$g.log)"
done
rm -rf $P/train-out
BARREPLAY_TOGGLES=$tog BARREPLAY_BENCH_START=63780 BARREPLAY_BENCH_N=1800 BARREPLAY_BENCH_OUT=$P/train-vl.txt \
	$BIN -data .bardata -progress=false -engine $E/$eng -out $P/train-out 6a37d06acbb455b1d19179d8ec965f10 > $P/train-vl.log 2>&1
echo "verylarge1: $(tail -1 $P/train-vl.txt 2>/dev/null)"
