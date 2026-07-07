#!/bin/bash
# precise interleaved A/B: $1=gameId $2=A-tag $3=B-tag $4=pairs
set -u
export PATH=/usr/local/go/bin:$PATH
cd /home/mabn/dev/barreplay
D=/home/mabn/dev/barreplay/.bardata/engine/2025.06.24
GAME=$1; ATAG=$2; BTAG=$3; PAIRS=${4:-5}
REF=""
[ -z "$REF" ] && REF=$(awk '{print $1}' /home/mabn/dev/perf-runs/$( [ "$GAME" = 68694c6a70bfb0d3fefdf8faf824d802 ] && echo medium || echo small)-ref.md5)
run() { # $1=tag
  cp "/home/mabn/dev/perf-runs/spring-headless.$1" "$D/spring-headless"
  sudo nice -n -15 taskset -c 0-2 ./barreplay -data /home/mabn/dev/barreplay/.bardata -engine "$D/spring-headless" -out ./snaps -worker-threads 2 "$GAME" >/dev/null 2>&1
  local sim=$(python3 /home/mabn/dev/perf-runs/simtime.py "$D/../../infolog.txt" 2>/dev/null)
  [ -z "$sim" ] && sim=$(python3 /home/mabn/dev/perf-runs/simtime.py /home/mabn/dev/barreplay/.bardata/infolog.txt)
  local md5=$(grep -v "^BRSNAP PROF" "snaps/$GAME.brsnap" | md5sum | awk '{print $1}')
  local ok=OK; [ "$md5" != "$REF" ] && ok="DIFF!"
  echo "$sim $ok"
}
AS=""; BS=""
for i in $(seq 1 $PAIRS); do
  if [ $((i%2)) -eq 1 ]; then a=$(run "$ATAG"); b=$(run "$BTAG"); else b=$(run "$BTAG"); a=$(run "$ATAG"); fi
  echo "pair=$i A=$a B=$b"
  AS="$AS ${a%% *}"; BS="$BS ${b%% *}"
done
python3 - "$AS" "$BS" <<'PY'
import sys
A=[float(x) for x in sys.argv[1].split()]; B=[float(x) for x in sys.argv[2].split()]
ma=sum(A)/len(A); mb=sum(B)/len(B)
print(f"MEAN A={ma:.3f}s B={mb:.3f}s  delta={(mb-ma):+.3f}s ({(mb-ma)/ma*100:+.2f}%)  B wins {sum(1 for a,b in zip(A,B) if b<a)}/{len(A)}")
PY
echo INTERLEAVE_DONE
