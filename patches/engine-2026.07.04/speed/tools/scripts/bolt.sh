#!/bin/bash
# bolt.sh <engine name> : BOLT a relocations-linked engine build with an LBR
# profile of verylarge1's late window (from its checkpoint) and install it as
# <engine name>b beside it. Needs the checkpoint dumped already.
set -eu
name=$1
BR=/home/mabn/dev/barreplay; E=$BR/.bardata/engine/2026.07.04; P=/home/mabn/dev/perf3
D=$P/ckpt/$name/verylarge1-63780
cd $BR
rm -f $D/perf-*.data
COOL=${COOL:-50000} MAINCPU=3 OTHERCPUS=0,1,2,4,5,6 TOGGLES=${TOGGLES:-3f} PERF="-e cycles:u -j any,u -c 200003" \
	tools/bench-ckpt/bench-ckpt.sh trial $E/$name verylarge1 63780 450 1 | grep -oE "wall_ms=[0-9.]+"
data=$(ls -t $D/perf-*.data | head -1)
/usr/lib/llvm-20/bin/perf2bolt -p "$data" -o $D/$name.fdata $E/$name 2>&1 | tail -3
/usr/lib/llvm-20/bin/llvm-bolt $E/$name -o $E/${name}b -data=$D/$name.fdata \
	-reorder-blocks=ext-tsp -reorder-functions=cdsort -split-functions -split-all-cold -split-eh \
	-icf=1 -use-gnu-stack -dyno-stats 2>&1 | tail -25
ls -la $E/${name}b
