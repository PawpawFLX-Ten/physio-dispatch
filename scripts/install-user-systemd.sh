#!/usr/bin/env bash
# 安装当前用户的 systemd 单元，开机登录后自动启动治疗室服务。
# 用法：
#   ./scripts/install-user-systemd.sh
#   CLINIC_ROOT=/path/to/repo ./scripts/install-user-systemd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${CLINIC_ROOT:-$ROOT}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/physio-dispatch.service"
PORT="${PORT:-8787}"
NODE_BIN="$(command -v node)"

if [[ ! -x "$ROOT/scripts/start-clinic.sh" ]]; then
  echo "找不到 $ROOT/scripts/start-clinic.sh" >&2
  exit 1
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node，请先安装 Node.js" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
cat >"$UNIT_PATH" <<EOF
[Unit]
Description=治疗室派工（局域网 Node 服务）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
# 可选机外备份目录，例如 U 盘或网盘同步夹：
# Environment=BACKUP_MIRROR_DIR=/path/to/mirror
ExecStart=$ROOT/scripts/start-clinic.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now physio-dispatch.service

echo "已安装并启动：$UNIT_PATH"
echo "查看状态：systemctl --user status physio-dispatch"
echo "看日志：journalctl --user -u physio-dispatch -f"
echo "若希望未登录也跑：loginctl enable-linger \"\$USER\""
