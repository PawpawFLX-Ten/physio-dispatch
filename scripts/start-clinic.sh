#!/usr/bin/env bash
# 打包（缺 dist 时）并启动治疗室服务；终端打印局域网地址。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# node_modules 缺了，或者 package.json 比上次安装新，都要重装一遍。
if [[ ! -d node_modules || package.json -nt node_modules/.package-lock.json ]]; then
  echo "正在 npm install…"
  npm install
fi

if [[ ! -f client/dist/index.html ]]; then
  echo "正在打包前端…"
  npm run build
fi

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
export PORT HOST

echo "治疗室服务即将启动（仓库：$ROOT）"
echo "手机请连同一 Wi‑Fi，打开终端打印的 http://<局域网IP>:$PORT/"
exec node server/index.js
