#!/bin/bash
# apply a patch onto the engine branch, rebuild, install as spring-headless.<tag>
# usage: step.sh <tag> <patchfile>   (patchfile "-" = just rebuild current tree)
set -u
P=/home/mabn/dev/perf2
TAG=${1:?tag}; PATCHF=${2:-"-"}
cd /home/mabn/dev/recoil
if [ "$PATCHF" != "-" ]; then
  git am --3way "$PATCHF" || { echo "AM-FAILED"; git am --abort 2>/dev/null; exit 1; }
fi
"$P/build.sh" > /tmp/build-$TAG.log 2>&1
if ! [ -x build-linux/spring-headless ]; then echo "BUILD-FAILED (see /tmp/build-$TAG.log)"; tail -20 /tmp/build-$TAG.log; exit 1; fi
if grep -q "FAILED:" /tmp/build-$TAG.log; then echo "BUILD-FAILED"; grep -A10 "FAILED:" /tmp/build-$TAG.log | head -30; exit 1; fi
sudo cp build-linux/spring-headless "$P/spring-headless.$TAG"
sudo chown "$(id -u):$(id -g)" "$P/spring-headless.$TAG"
cp "$P/spring-headless.$TAG" "$P/spring-headless.cur"
echo "BUILT $TAG  ($(git log --oneline -1))"
