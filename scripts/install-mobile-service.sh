#!/usr/bin/env bash
# Install only the companion gateway; leaves the existing monitor untouched.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NODE=$(command -v node)
[[ -f "$ROOT/.env.mobile.local" ]] || { echo 'Create .env.mobile.local first.' >&2; exit 1; }
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/solar-mobile.service" <<EOF
[Unit]
Description=Solar Monitor mobile certificate gateway
After=network-online.target
[Service]
WorkingDirectory=$ROOT
ExecStart="$NODE" --disable-warning=ExperimentalWarning src/mobile-server.ts
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now solar-mobile.service
systemctl --user --no-pager status solar-mobile.service
