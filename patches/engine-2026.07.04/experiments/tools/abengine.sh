#!/bin/bash
# interleaved A/B of two ENGINE binaries on one replay.
# usage: abengine.sh <binA> <binB> <small|medium|large> [pairs] [extra barreplay flags...]
set -u
P=/home/mabn/dev/perf2; BR=/home/mabn/dev/barreplay
# Resolve the binaries BEFORE cd'ing away. A relative path here resolved
# against the barreplay dir instead, `cp` failed, and BOTH arms then ran
# whatever binary was already in the engine dir — an A/B that compared a build
# with itself and reported the difference as a result.
A=$(readlink -f "$1"); B=$(readlink -f "$2"); NAME=$3; PAIRS=${4:-4}; shift 4 || true
[ -x "$A" ] || { echo "no such binary: $1"; exit 2; }
[ -x "$B" ] || { echo "no such binary: $2"; exit 2; }
FLAGS=${*:-}
case "$NAME" in
  small)  ID=d53f896a4c7276e66540d53d13f3a31e ;;
  medium) ID=4936896a8b258d038cbd28f55eb15ed2 ;;
  large)  ID=d03a896a204dd8f8a4b4c488cfaec73e ;;
  isthmus) ID=6122896ac3328104d12093d975c61214 ;;
esac
REF=$(awk -v n="$NAME" '$1==n{print $3}' "$P/refs.txt")
ENGDIR=$BR/.bardata/engine/2026.07.04
cd "$BR"
run() {
  cp "$1" "$ENGDIR/spring-headless" || { echo COPY-FAILED; exit 2; }
  # shellcheck disable=SC2086
  ./barreplay -data "$BR/.bardata" -engine "$ENGDIR/spring-headless" -out "$P/out" $FLAGS "$ID" > /tmp/abe.log 2>&1
  local s=$(grep -oE "sim ([0-9]+m)?[0-9]+s" /tmp/abe.log | head -1)
  local m=$(md5sum "$P/out/$ID.brp" 2>/dev/null | awk '{print $1}')
  local ok=OK; [ "$m" != "$REF" ] && ok="DIFF"
  echo "${s// /_}|$ok"
}
AS=""; BS=""
for i in $(seq 1 "$PAIRS"); do
  if [ $((i%2)) -eq 1 ]; then a=$(run "$A"); b=$(run "$B"); else b=$(run "$B"); a=$(run "$A"); fi
  echo "pair=$i A=$a B=$b"
  AS="$AS ${a%%|*}"; BS="$BS ${b%%|*}"
done
python3 - "$AS" "$BS" <<'PY'
import sys, re
def secs(t):
    m = re.match(r'sim_(?:(\d+)m)?(\d+)s', t)
    return int(m.group(1) or 0)*60 + int(m.group(2)) if m else float('nan')
A=[secs(x) for x in sys.argv[1].split()]; B=[secs(x) for x in sys.argv[2].split()]
ma=sum(A)/len(A); mb=sum(B)/len(B)
print(f"A={A} B={B}")
print(f"MEAN A={ma:.1f}s B={mb:.1f}s  delta={(mb-ma):+.1f}s ({(mb-ma)/ma*100:+.2f}%)  B wins {sum(1 for a,b in zip(A,B) if b<a)}/{len(A)}")
PY
