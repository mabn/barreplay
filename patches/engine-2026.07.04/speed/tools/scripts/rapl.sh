#!/bin/bash
# rapl.sh: print package energy (uJ) via a privileged container
IMG=ghcr.io/beyond-all-reason/recoil-build-amd64-linux@sha256:31b3667ba0d37620b4ad9b45d1840c8d3e95317f2b233044d2e17697ce8fe61d
sudo -n docker run --rm --privileged $IMG cat /sys/class/powercap/intel-rapl:0/energy_uj
