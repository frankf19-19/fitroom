#!/usr/bin/env bash
# 把網站打包成 App 用的 www/：複製 index.html 與靜態資源，並標記 App 模式
set -e
cd "$(dirname "$0")"
rm -rf www && mkdir -p www
cp ../index.html ../icon.svg ../icon-192.png ../icon-512.png ../manifest.json www/
# App 內不載入 manifest（避免瀏覽器 PWA 行為）
sed -i.bak 's#<link rel="manifest" href="manifest.json">##' www/index.html && rm -f www/index.html.bak
echo "www/ 已準備好：$(ls www | tr '\n' ' ')"
