#!/bin/bash
# pkgcap.sh <watts>: set RAPL package long- and short-term power limits (0 = restore 100/125 W)
IMG=ghcr.io/beyond-all-reason/recoil-build-amd64-linux@sha256:31b3667ba0d37620b4ad9b45d1840c8d3e95317f2b233044d2e17697ce8fe61d
w=$1; if [ "$w" = 0 ]; then a=100000000; b=125000000; else a=$((w*1000000)); b=$((w*1000000)); fi
sudo -n docker run --rm --privileged $IMG sh -c "R=/sys/class/powercap/intel-rapl:0; echo $a > \$R/constraint_0_power_limit_uw; echo $b > \$R/constraint_1_power_limit_uw; cat \$R/constraint_0_power_limit_uw \$R/constraint_1_power_limit_uw \$R/enabled"
