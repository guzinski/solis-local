#!/usr/bin/env bash
# One persistent reader, managed independently from the mobile gateway.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NODE=$(command -v node)
if systemctl is-active --quiet solar-monitor.service; then
  echo 'A system monitor service is already running; stop it before migrating.' >&2
  exit 1
fi
if ! systemctl --user is-active --quiet solar-monitor.service; then
  PORT=$(cd "$ROOT" && "$NODE" --input-type=module -e 'import {readConfig} from "./src/env.ts"; console.log(readConfig().httpPort)')
  if ss -ltnH "sport = :$PORT" | grep -q .; then
    echo "Port $PORT is in use. Stop the terminal monitor before enabling the service." >&2
    exit 1
  fi
fi
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/solar-monitor.service" <<EOF
[Unit]
Description=Solar Monitor persistent Modbus reader
After=network-online.target
[Service]
WorkingDirectory=$ROOT
ExecStart="$NODE" --disable-warning=ExperimentalWarning src/server.ts
Environment=MODBUS_REPLY_TIMEOUT_SECONDS=120
Environment=MODBUS_TRACE_PATH=data/diagnostics/modbus.jsonl
Restart=on-failure
RestartSec=30
TimeoutStopSec=10
UMask=0077
NoNewPrivileges=yes
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now solar-monitor.service
systemctl --user --no-pager status solar-monitor.service
