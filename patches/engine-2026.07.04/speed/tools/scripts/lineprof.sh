#!/bin/bash
# lineprof.sh <engine name> <toggles>: one late-window trial with plain cycle samples of the
# main thread, then the source lines of CUnitHandler::Update's own samples (perf annotate -l)
S=${SCRATCH:-/tmp}
eng=$1; tog=$2; D=/home/mabn/dev/perf3/ckpt/$eng/verylarge1-63780
cd /home/mabn/dev/barreplay
pid=$(cat $D/park.ready)
COOL=50000 MAINCPU=3 OTHERCPUS=0,1,2,4,5,6 TOGGLES=$tog PERF="-e cycles:u -F 4999 -t $pid" timeout 900 tools/bench-ckpt/bench-ckpt.sh trial $eng verylarge1 63780 450 1 > $S/lineprof-$eng.trial 2>&1
f=$(ls -t $D/perf-*.data | head -1)
B=/home/mabn/dev/barreplay/.bardata/engine/2026.07.04/$eng
for fn in "CUnitHandler::Update" "CGameHelper::GenerateWeaponTargets" "luaV_execute"; do
	perf annotate -i $f --stdio -l --symbol="$fn" 2>/dev/null | grep -E "^\s+[0-9]+\.[0-9]+\s+\S+:[0-9]+" | sort -rn | head -25 > "$S/lineprof-$eng-${fn//:/_}.txt"
done
perf report -i $f --stdio --no-children --sort sym 2>/dev/null | grep -v "^#" | head -40 > $S/lineprof-$eng-top.txt
