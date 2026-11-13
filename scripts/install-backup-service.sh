#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BACKUP_NODE=$(command -v node)
if [[ ! -e "$ROOT/.env.backup.local" ]]; then
  install -m 600 "$ROOT/deploy/backup.env.example" "$ROOT/.env.backup.local"
fi
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/solar-backup.service" <<UNIT
[Unit]
Description=Solar daily SQLite backup and optional R2 upload
[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart="$BACKUP_NODE" --disable-warning=ExperimentalWarning scripts/backup.ts
UMask=0077
NoNewPrivileges=yes
TimeoutStartSec=10min
UNIT
cat > "$UNIT_DIR/solar-backup.timer" <<'UNIT'
[Unit]
Description=Back up Solar daily
[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=5min
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now solar-backup.timer
systemctl --user start solar-backup.service
systemctl --user list-timers solar-backup.timer --no-pager
