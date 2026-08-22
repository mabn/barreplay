#!/bin/bash
# apply+build+gate+bench one candidate; appends a line to results.txt
# usage: try.sh <tag> <patchfile|-> [gate-replay...]
set -u
P=/home/mabn/dev/perf2
TAG=${1:?tag}; PATCHF=${2:--}; shift 2 || true
GATES=${*:-medium}
"$P/step.sh" "$TAG" "$PATCHF" || exit 1
G=""
for g in $GATES; do G="$G $("$P/gate.sh" "$g" | tail -1)"; done
B=$("$P/bench.sh" "$TAG" 3 | tail -1)
echo "$TAG |$G | $B" | tee -a "$P/results.txt"
