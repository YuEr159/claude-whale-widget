#!/usr/bin/env node
/**
 * 把版本递增 hook 装进当前仓库。
 *
 * `.git/hooks/` 不进版本库，所以克隆下来的仓库默认没有 pre-commit hook——
 * 版本号不会自己涨，改完代码 `plugin update` 依然说「已是最新」。这个脚本
 * 补上这一步，克隆后跑一次即可：
 *
 *   node scripts/install-hooks.mjs
 *
 * 它只写 `.git/hooks/pre-commit` 一个文件（git 默认的 hooks 目录），
 * 不碰 `core.hooksPath`，也不覆盖已有的自定义 hook——发现已经有就报错退出，
 * 由人决定怎么处理。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'scripts', 'pre-commit.sh')
const HOOKS_DIR = path.join(ROOT, '.git', 'hooks')
const TARGET = path.join(HOOKS_DIR, 'pre-commit')

function main() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error('[install-hooks] 这里不是 git 仓库根目录')
    process.exit(1)
  }
  if (!fs.existsSync(HOOKS_DIR)) fs.mkdirSync(HOOKS_DIR, { recursive: true })

  if (fs.existsSync(TARGET)) {
    const held = fs.readFileSync(TARGET, 'utf8')
    const mine = fs.readFileSync(SOURCE, 'utf8')
    if (held !== mine) {
      console.error('[install-hooks] .git/hooks/pre-commit 已存在且内容不同，未覆盖。')
      console.error('              确认那是你自己的 hook 后，手工合并或先删掉它再跑一次。')
      process.exit(1)
    }
    console.log('[install-hooks] 已是最新，无需改动')
    return
  }

  fs.copyFileSync(SOURCE, TARGET)
  // Windows 上 chmod 是空操作，但 Git for Windows 会按 shebang 执行，够用。
  fs.chmodSync(TARGET, 0o755)
  console.log('[install-hooks] 已安装 .git/hooks/pre-commit：每次提交自动递增版本号')
}

main()
