#!/bin/bash
# byte-identity gate: run <replay> with the engine binary $ENGBIN and compare .brp md5 to refs.txt
# usage: gate.sh <small|medium|large> [extra barreplay flags...]
set -u
export PATH=/usr/local/go/bin:$PATH
P=/home/mabn/dev/perf2
BR=/home/mabn/dev/barreplay
case "${1:?name}" in
  small)  ID=d53f896a4c7276e66540d53d13f3a31e ;;
  medium) ID=4936896a8b258d038cbd28f55eb15ed2 ;;
  large)  ID=d03a896a204dd8f8a4b4c488cfaec73e ;;
  *) echo "unknown replay $1"; exit 2 ;;
esac
NAME=$1; shift
ENGBIN=${ENGBIN:-$P/spring-headless.cur}
cd "$BR"
rm -f "$P/out/$ID.brp" "$P/out/$ID.brsnap"
mkdir -p "$P/out"
./barreplay -data "$BR/.bardata" -engine "$ENGBIN" -out "$P/out" "$@" "$ID" > "$P/out/$NAME.runlog" 2>&1
MD=$(md5sum "$P/out/$ID.brp" 2>/dev/null | awk '{print $1}')
REF=$(awk -v n="$NAME" '$1==n{print $3}' "$P/refs.txt")
SIM=$(grep -oE 'sim [0-9hms]+ \([0-9]+ frames, [0-9]+ fps' "$P/out/$NAME.runlog" | head -1)
if [ -z "$REF" ]; then echo "$NAME: NO-REF md5=$MD  $SIM"
elif [ "$MD" = "$REF" ]; then echo "$NAME: IDENTICAL  $SIM"
else echo "$NAME: *** DIFF *** md5=$MD ref=$REF  $SIM"; fi
