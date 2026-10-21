#!/bin/bash
# capall.sh <kHz>: cap every cpu's max frequency (4000000 = uncapped)
IMG=ghcr.io/beyond-all-reason/recoil-build-amd64-linux@sha256:31b3667ba0d37620b4ad9b45d1840c8d3e95317f2b233044d2e17697ce8fe61d
sudo -n docker run --rm --privileged $IMG sh -c "for c in /sys/devices/system/cpu/cpu[0-9]*; do echo $1 > \$c/cpufreq/scaling_max_freq; done"
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq | sort | uniq -c
