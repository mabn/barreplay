#!/bin/bash
# ab.sh <binA-name> <binB-name> <gameId> <ref-md5> [pairs]
# Interleaved A/B of two engine builds that sit in the engine dir; prints sim
# seconds per run and whether each .brp matches the reference md5.
set -u
P=/home/mabn/dev/perf3; BR=/home/mabn/dev/barreplay
BA=${SCRATCH:-/tmp}/barreplay
E=$BR/.bardata/engine/2026.07.04
A=$1; B=$2; ID=$3; REF=$4; PAIRS=${5:-2}
cd $BR
run() {
  # BENCH=1: the bench harness times frames [BENCH_START, +BENCH_N) and then
  # _exit(0)s the engine, so that capture is TRUNCATED (its md5 is not the
  # reference). Without BENCH the run is whole and the md5 is the gate.
  if [ -n "${BENCH:-}" ]; then
    BARREPLAY_BENCH_START=${BENCH_START:-600} BARREPLAY_BENCH_N=${BENCH_N:-23400} BARREPLAY_BENCH_OUT=$P/bench-$1.txt \
      $BA -data .bardata -progress=false -engine $E/$1 -out $P/ab-out $ID > $P/ab-$1.log 2>&1
    echo "$(tail -1 $P/bench-$1.txt | grep -oE "(instructions|wall_ms)=[0-9.]+" | tr "\n" " ")"
    return
  fi
  rm -f $P/ab-out/$ID.brp
  $BA -data .bardata -progress=false -engine $E/$1 -out $P/ab-out $ID > $P/ab-$1.log 2>&1
  local s=$(grep -oE "sim ([0-9]+m)?[0-9]+s" $P/ab-$1.log | head -1 | sed 's/sim //')
  local m=$(md5sum < $P/ab-out/$ID.brp 2>/dev/null | cut -c1-32)
  local ok=OK; [ "$m" != "$REF" ] && ok="DIFF($m)"
  echo "$s $ok"
}
for i in $(seq 1 $PAIRS); do
  if [ $((i%2)) -eq 1 ]; then a=$(run $A); b=$(run $B); else b=$(run $B); a=$(run $A); fi
  echo "pair $i: $A=$a  $B=$b"
done
