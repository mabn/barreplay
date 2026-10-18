#!/bin/bash
# memwatch.sh <engine basename> <limit-kB> <outprefix>: waits for the engine
# (a run: its command line has --write-dir; barreplay's --version probe has not),
# logs its RSS every 2 s (VmRSS: no page-table walk, so it costs a trial
# nothing); past the limit, gdb backtraces of every thread + smaps, then kill.
# SCAN=1 adds the huge-page collapse scan every 20 s (heavy; not for trials).
name=$1; lim=$2; out=$3; last=0
until pid=$(pgrep -f "^[^ ]*/engine/[^ ]*/$name .*--write-dir" | head -1) && [ -n "$pid" ]; do sleep 0.5; done
echo "pid $pid" > $out.rss
while kill -0 $pid 2>/dev/null; do
  rss=$(awk '/^VmRSS:/{print $2}' /proc/$pid/status 2>/dev/null)
  echo "$(date +%T) rss=$rss" >> $out.rss
  if [ "${SCAN:-0}" = 1 ] && [ $(( $(date +%s) - last )) -ge 20 ]; then
    last=$(date +%s); python3 -I "$(dirname "$0")/thpscan.py" $pid >> $out.scan 2>&1
  fi
  if [ -n "$rss" ] && [ "$rss" -gt "$lim" ]; then
    sudo -n gdb -p $pid -batch -ex "info threads" -ex "thread apply all bt 30" > $out.bt 2>&1
    sudo -n cat /proc/$pid/smaps > $out.smaps 2>/dev/null
    kill -9 $pid; echo "killed $pid at $rss kB" >> $out.rss; exit 0
  fi
  sleep 2
done
