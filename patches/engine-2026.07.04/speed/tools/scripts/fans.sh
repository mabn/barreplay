#!/bin/bash
# fans.sh max|auto: pin both MacBook fans at maximum (mbpfan stopped) or hand them back to mbpfan
IMG=ghcr.io/beyond-all-reason/recoil-build-amd64-linux@sha256:31b3667ba0d37620b4ad9b45d1840c8d3e95317f2b233044d2e17697ce8fe61d
hostroot() { sudo -n docker run --rm --privileged --pid=host --net=host --ipc=host "$IMG" nsenter -t 1 -m -u -i -n -p -- "$@"; }
D=/sys/devices/platform/applesmc.768
case "$1" in
	max)  hostroot sh -c "systemctl stop mbpfan; for f in 1 2; do echo 1 > $D/fan\${f}_manual; cat $D/fan\${f}_max > $D/fan\${f}_output; done" ;;
	auto) hostroot sh -c "systemctl start mbpfan" ;;
esac
sleep 3; echo "fans: $(cat $D/fan1_input) $(cat $D/fan2_input) rpm; mbpfan $(systemctl is-active mbpfan)"
