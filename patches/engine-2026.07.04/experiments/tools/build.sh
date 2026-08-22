#!/bin/bash
# build spring-headless from /home/mabn/dev/recoil into build-linux; $1=configure to reconfigure
set -u
cd /home/mabn/dev/recoil
IMG=$(cat /home/mabn/dev/perf2/build-img.txt)
drun() { sudo docker run --rm --user=0:0 -v "$(pwd)":/build/src:ro \
   -v "$(pwd)/.cache/ccache-linux":/build/cache:rw -v "$(pwd)/build-linux":/build/out:rw \
   "$IMG" bash -c "$1"; }
if [ "${1:-}" = configure ]; then
  drun 'git config --global safe.directory "*" && cd /build/src/docker-build-v2/scripts && ./configure.sh -DAI_TYPES=NONE' || exit 1
fi
drun 'git config --global safe.directory "*" && cd /build/out && ninja -j$(nproc) spring-headless tools/pr-downloader/src/pr-downloader base/springcontent.sdz base/spring/bitmaps.sdz'
