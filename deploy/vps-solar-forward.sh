#!/usr/bin/env bash
# Independent TCP relay. TLS and device authorization stay on the home gateway.
# Usage on the VPS: sudo bash vps-solar-forward.sh <home-wireguard-ip> [port=9443]
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
HOME_PEER=${1:?Pass the home WireGuard IP}
PORT=${2:-9443}
[[ $HOME_PEER =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo 'Expected a private WireGuard IPv4 address.' >&2; exit 1; }
[[ $PORT =~ ^[0-9]+$ && $PORT -ge 1024 && $PORT -le 65535 && $PORT -ne 8443 ]] || { echo 'Choose an unused port, separate from OwnSee.' >&2; exit 1; }
PROXYD=/usr/lib/systemd/systemd-socket-proxyd
[[ -x $PROXYD ]] || PROXYD=/lib/systemd/systemd-socket-proxyd
[[ -x $PROXYD ]] || { echo 'systemd-socket-proxyd not found.' >&2; exit 1; }
if ! systemctl is-enabled solar-mobile.socket >/dev/null 2>&1 && ss -ltnH "sport = :$PORT" | grep -q .; then
  echo "Port $PORT is already in use." >&2; exit 1
fi
cat > /etc/systemd/system/solar-mobile.socket <<EOF
[Unit]
Description=Solar mobile authenticated HTTPS relay
[Socket]
ListenStream=$PORT
[Install]
WantedBy=sockets.target
EOF
cat > /etc/systemd/system/solar-mobile.service <<EOF
[Unit]
Description=Solar mobile TCP relay through existing WireGuard
Requires=solar-mobile.socket
After=solar-mobile.socket wg-quick@wg0.service
[Service]
ExecStart=$PROXYD $HOME_PEER:$PORT
DynamicUser=yes
PrivateTmp=yes
NoNewPrivileges=yes
EOF
systemctl daemon-reload
systemctl enable --now solar-mobile.socket
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow "$PORT/tcp" comment 'Solar mobile HTTPS (client certificates required)'
fi
systemctl --no-pager status solar-mobile.socket
echo "Solar relay ready on TCP $PORT. Existing camera tunnel and relay were not changed."
