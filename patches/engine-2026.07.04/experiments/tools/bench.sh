#!/bin/bash
# instruction bench: min-of-N over sim frames [START,START+N) at wt=1 on medium
# usage: bench.sh <label> [trials] [replay]
set -u
export PATH=/usr/local/go/bin:$PATH
P=/home/mabn/dev/perf2
BR=/home/mabn/dev/barreplay
LABEL=${1:-cur}; TRIALS=${2:-3}; NAME=${3:-medium}
case "$NAME" in
  small)  ID=d53f896a4c7276e66540d53d13f3a31e ;;
  medium) ID=4936896a8b258d038cbd28f55eb15ed2 ;;
  large)  ID=d03a896a204dd8f8a4b4c488cfaec73e ;;
  isthmus) ID=6122896ac3328104d12093d975c61214 ;;
esac
# the engine finds base/springcontent.sdz + cont/fonts NEXT TO ITS OWN BINARY,
# so a build is tested by swapping the file INSIDE the engine dir, never by
# pointing -engine at a loose binary (that run dies with "failed to open
# archive 'Spring content v1'" and writes an empty capture).
ENGDIR=/home/mabn/dev/barreplay/.bardata/engine/2026.07.04
ENGBIN=${ENGBIN:-$P/spring-headless.cur}
cp "$ENGBIN" "$ENGDIR/spring-headless"
f=$P/bench_$LABEL.txt; rm -f "$f"
cd "$BR"
for i in $(seq 1 $TRIALS); do
  BARREPLAY_BENCH_START=${BENCH_START:-6000} BARREPLAY_BENCH_N=${BENCH_N:-3000} BARREPLAY_BENCH_OUT="$f" \
    ./barreplay -data "$BR/.bardata" -engine "$ENGDIR/spring-headless" -out "$P/out" -worker-threads 1 "$ID" >/dev/null 2>&1
done
python3 -c "
import re,sys
xs=[int(re.search(r'instructions=(\d+)',l).group(1)) for l in open('$f')]
cy=[int(re.search(r'cycles=(\d+)',l).group(1)) for l in open('$f')]
print('$LABEL: min_instr=%d n=%d spread=%.3f%% min_cycles=%d'%(min(xs),len(xs),(max(xs)-min(xs))/min(xs)*100,min(cy)))
"
