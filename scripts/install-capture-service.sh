#!/usr/bin/env bash
# Run as root once. The actual capture runs as the owner with only CAP_NET_RAW.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
OWNER=${1:?Linux username required}
ROOT=${2:?Project directory required}
PORT=${3:-502}
id "$OWNER" >/dev/null
[[ $PORT =~ ^[0-9]+$ && $PORT -ge 1 && $PORT -le 65535 ]] || exit 1
[[ -f "$ROOT/scripts/run-capture-service.sh" && -x /usr/bin/tcpdump ]] || exit 1
cat > /etc/systemd/system/solar-capture.service <<EOF
[Unit]
Description=Solar passive Modbus packet capture
After=network-online.target
Wants=network-online.target
[Service]
User=$OWNER
ExecStart=/bin/bash "$ROOT/scripts/run-capture-service.sh" "$ROOT" "$PORT"
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=yes
UMask=0077
Restart=on-failure
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
EOF
loginctl enable-linger "$OWNER"
systemctl daemon-reload
systemctl enable --now solar-capture.service
systemctl --no-pager status solar-capture.service
