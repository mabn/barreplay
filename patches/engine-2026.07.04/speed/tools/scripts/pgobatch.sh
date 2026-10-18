#!/bin/bash
# speed31 = speed30 (H87) + H88 + H89, built once with a PGO profile retrained on its own code
set -u
S=${SCRATCH:-/tmp}
W=/home/mabn/dev/barreplay-engine-build; BR=/home/mabn/dev/barreplay; E=$BR/.bardata/engine/2026.07.04
log() { echo "$(date -u +%H:%M) $*" >> $S/pipe31.log; }
cd $W/recoil && git checkout -q --detach speed31 && log "clone at $(git log --oneline -1)"
DOCKER="sudo -n docker" EXTRA_CMAKE="-DSYNCCHECK=OFF" timeout 5400 /home/mabn/dev/perf3/build-pgolto-g.sh $W/recoil $W/pgo31-work gen > $W/build-pgo31gen.log 2>&1 || { log "gen build failed"; exit 1; }
cp $W/pgo31-work/build-gen/spring-headless $E/spring-headless-pgo31gen && log "gen build done"
cd $BR && /home/mabn/dev/perf3/pgotrain.sh spring-headless-pgo31gen 387fbf >> $S/pipe31.log 2>&1
n=$(ls $W/pgo31-work/prof | wc -l); log "training done, $n gcda files"
tar -C $W/pgo31-work -cJf /home/mabn/dev/perf3/pgo31-profile.tar.xz prof && log "profile tarred"
PROFILE=/home/mabn/dev/perf3/pgo31-profile.tar.xz DOCKER="sudo -n docker" EXTRA_CMAKE="-DSYNCCHECK=OFF" timeout 5400 /home/mabn/dev/perf3/build-pgolto-g.sh $W/recoil $W/speed31-work > $W/build-speed31.log 2>&1 || { log "use build failed"; exit 1; }
cp $W/speed31-work/build-use/spring-headless $E/spring-headless-speed31 && log "use build done"
cd $BR && rm -rf $S/gate31 && BARREPLAY_TOGGLES=387fbf systemd-run --user --scope --quiet -p OOMPolicy=continue -p MemoryMax=11G -p MemorySwapMax=1G $S/barreplay-w6 -data .bardata -progress=false -engine $E/spring-headless-speed31 -out $S/gate31 4936896a8b258d038cbd28f55eb15ed2 > $S/gate31.log 2>&1
log "gate: $(md5sum $S/gate31/*.brp | cut -c1-32) $(grep 'engine total' $S/gate31.log)"
BARREPLAY=$S/barreplay-w6 TOGGLES=7fbf timeout 3000 tools/bench-ckpt/bench-ckpt.sh dump spring-headless-speed31 verylarge1 63780 > $S/dump-s31.txt 2>&1 && log "dumped"
COOL=50000 MAINCPU=3 OTHERCPUS=0,1,2,4,5,6 timeout 2400 tools/bench-ckpt/bench-ckpt.sh abt spring-headless-speed31 verylarge1 63780 450 7fbf 387fbf 3 > $S/abt31.txt 2>&1 && log "abt done"
COOL=50000 MAINCPU=3 OTHERCPUS=0,1,2,4,5,6 TOGGLES=7fbf timeout 2400 tools/bench-ckpt/bench-ckpt.sh ab spring-headless-speed24 spring-headless-speed31 verylarge1 63780 450 3 > $S/ab24-31.txt 2>&1 && log "ab done"
