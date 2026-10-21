#!/bin/bash
# cool.sh [milli-degC, default 50000]: wait until the package temperature is below it (max 10 min)
T=${1:-50000}; n=0
while [ "$(cat /sys/class/hwmon/hwmon1/temp1_input)" -ge "$T" ] && [ $n -lt 300 ]; do sleep 2; n=$((n+1)); done
cat /sys/class/hwmon/hwmon1/temp1_input
