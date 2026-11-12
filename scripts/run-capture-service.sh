#!/usr/bin/env bash
# Executed as the normal user by a system service with CAP_NET_RAW.
set -euo pipefail
ROOT=${1:?Project directory required}
PORT=${2:-502}
umask 077
SESSION="$ROOT/data/captures/$(date -u +%Y-%m-%dT%H-%M-%S)-service"
mkdir -p "$SESSION"
echo "Passive Modbus capture: $SESSION"
exec /usr/bin/tcpdump -i any -p -nn -s 0 -U -C 8 -W 8 -w "$SESSION/modbus.pcap" "tcp port $PORT"
