#!/usr/bin/env bash
# 一键部署（Ubuntu/Debian 轻量应用服务器）：装 Docker → 构建 → 常驻运行
set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "[1/3] 安装 Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "[2/3] 构建镜像..."
docker build -t yingtan4k .

echo "[3/3] 启动容器（端口 8080）..."
docker rm -f yingtan4k >/dev/null 2>&1 || true
docker run -d --restart=always -p 8080:8080 --name yingtan4k yingtan4k

sleep 3
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "完成。接口地址：http://${IP:-你的服务器IP}:8080"
echo "自测：curl -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8080/home"
