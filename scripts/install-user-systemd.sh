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

# systemd 的 ExecStart/WorkingDirectory 按空格切参数：路径里的空格必须转义，
# 否则「Vibe Coding Projects」这类目录会让服务 203/EXEC 起不来。
function systemd_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/ /\\x20/g'
}

mkdir -p "$UNIT_DIR"
ESCAPED_ROOT="$(systemd_escape "$ROOT")"
# node 可能装在 nvm / 用户目录里，不在 systemd 默认 PATH：把它所在的 bin 目录带上。
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
cat >"$UNIT_PATH" <<EOF
[Unit]
Description=治疗室派工（局域网 Node 服务）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 不设 WorkingDirectory：它不吃 \x20 转义，带空格的路径会 200/CHDIR；
# start-clinic.sh 自己会 cd 到仓库根目录。
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Environment=PATH=$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin
# 可选机外备份目录，例如 U 盘或网盘同步夹：
# Environment=BACKUP_MIRROR_DIR=/path/to/mirror
ExecStart=$ESCAPED_ROOT/scripts/start-clinic.sh
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
