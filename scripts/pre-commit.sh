#!/bin/sh
# 每次提交把版本号递增一位，并让它进入同一个提交。
#
# 为什么放在 pre-commit 而不是 post-commit：插件安装时会把文件**复制**到
# 缓存目录，而 `plugin update` 靠版本号判断有没有新东西——版本号必须与代码
# 在同一个提交里，否则「代码变了但版本号还是旧的」，update 依然说已是最新。
#
# 安装/卸载本 hook（克隆仓库后跑一次即可）：
#   ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
# 或在 Windows 上直接把本文件复制成 .git/hooks/pre-commit。
set -e

cd "$(git rev-parse --show-toplevel)"

# 递增脚本自己会打印 `旧 -> 新`，直接把它作为日志。
OUTPUT=$(node scripts/bump-version.mjs)

git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
echo "[pre-commit] 版本号 $OUTPUT（已加入本次提交）"
