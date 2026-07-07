#!/bin/bash
# build current recoil tree + bench N trials (wt=1), print min instructions over [6000,9000).
# usage: measure.sh <label> [trials]
set -u
export PATH=/usr/local/go/bin:$PATH
D=/home/mabn/dev/barreplay/.bardata/engine/2025.06.24
IMG=$(cat /home/mabn/dev/perf-runs/build-img.txt)
LABEL=${1:-cur}; TRIALS=${2:-3}
cd /home/mabn/dev/recoil
sudo docker run --rm --user=0:0 -v "$(pwd)":/build/src:ro -v "$(pwd)/.cache/ccache-linux":/build/cache:rw -v "$(pwd)/build-linux":/build/out:rw "$IMG" bash -c 'git config --global safe.directory "*" && cd /build/out && ninja -j$(nproc) spring-headless >/dev/null 2>&1; echo built' >/dev/null 2>&1
sudo cp build-linux/spring-headless "$D/spring-headless"; sudo chown "$(id -u):$(id -g)" "$D/spring-headless"
cd /home/mabn/dev/barreplay
# byte-identity gate (medium) at wt=2 — safety
./barreplay -data /home/mabn/dev/barreplay/.bardata -engine "$D/spring-headless" -out ./snaps -worker-threads 2 68694c6a70bfb0d3fefdf8faf824d802 >/dev/null 2>&1
MD=$(grep -v "^BRSNAP PROF" snaps/68694c6a70bfb0d3fefdf8faf824d802.brsnap | md5sum | awk '{print $1}')
REF=$(awk '{print $1}' /home/mabn/dev/perf-runs/medium-ref.md5)
GATE=IDENTICAL; [ "$MD" != "$REF" ] && GATE="*** DIFF ($MD) ***"
f=/tmp/meas_$LABEL.txt; rm -f "$f"
for i in $(seq 1 $TRIALS); do BARREPLAY_BENCH_START=6000 BARREPLAY_BENCH_N=3000 BARREPLAY_BENCH_OUT="$f" \
  ./barreplay -data /home/mabn/dev/barreplay/.bardata -engine "$D/spring-headless" -out ./snaps -worker-threads 1 68694c6a70bfb0d3fefdf8faf824d802 >/dev/null 2>&1; done
python3 -c "import re;xs=[int(re.search(r'instructions=(\d+)',l).group(1)) for l in open('$f')];print('$LABEL: min_instr=%d  n=%d  gate=$GATE'%(min(xs),len(xs)))"
