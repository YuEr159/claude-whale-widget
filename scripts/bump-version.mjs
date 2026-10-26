#!/usr/bin/env node
/**
 * 版本号随提交递增。
 *
 * 为什么要有这个：插件从本地目录安装时，`claude plugin install` 会把文件
 * **复制**到 `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`，
 * 而 `plugin update` 只比较版本号——版本号不变它就回答「已是最新」，缓存里
 * 的旧代码永远不会被替换。开发期间改一行就得手动卸载重装，忘了就白改。
 *
 * 让版本号跟着提交走之后，`plugin update` 每次都能识别出新版本、重新拷贝。
 * 递增规则是语义化版本里最小的一档：
 *
 *   - 末位 +1（`1.0.7` → `1.0.8`），够用且永不上溢到次位；
 *   - 版本号跨过 99 时进位到次位（`1.0.99` → `1.1.0`），
 *     保持「看起来正常」的版本号，而不是 `1.0.142`。
 *
 * 这个脚本由 `.git/hooks/pre-commit` 调用，写回的值会被 `git add` 进
 * 同一个提交——所以仓库里的版本号与实际代码永远对得上，不需要人记。
 *
 * 用法：
 *   node scripts/bump-version.mjs          # 递增并写回两个 manifest
 *   node scripts/bump-version.mjs --check  # 只打印当前版本，不改文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_JSON = path.join(ROOT, '.claude-plugin', 'plugin.json')
const MARKETPLACE_JSON = path.join(ROOT, '.claude-plugin', 'marketplace.json')

/**
 * 递增一个 `MAJOR.MINOR.PATCH` 版本号。
 *
 * @param {string} version 形如 `1.0.0`
 * @returns {string} 递增后的版本号；形状不对时抛错，绝不猜
 */
export function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim())
  if (!match) throw new Error(`版本号形状不对：${JSON.stringify(version)}，应为 MAJOR.MINOR.PATCH`)
  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3]) + 1
  // 末位到 100 就进位，保持两位以内的补丁号。不这么做的话，一个开发周期
  // 里很容易攒出 `1.0.142` 这种一眼看不出含义的版本号。
  if (patch >= 100) {
    patch = 0
    minor += 1
  }
  if (minor >= 100) {
    minor = 0
    major += 1
  }
  return `${major}.${minor}.${patch}`
}

/** 读一个 JSON 文件并保留它的换行风格与缩进，写回时不制造整文件 diff。 */
function readJson(file) {
  const text = fs.readFileSync(file, 'utf8')
  return { data: JSON.parse(text), text }
}

function writeJson(file, data) {
  // 原文件用两空格缩进、末尾带换行；照原样写回，diff 才只有版本号那一行。
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** 两个 manifest 里的版本号必须一致，否则先按 `plugin.json` 对齐再递增。 */
function currentVersion() {
  const plugin = readJson(PLUGIN_JSON).data
  const market = readJson(MARKETPLACE_JSON).data
  const inMarket = market.plugins?.find(item => item.name === plugin.name)?.version
  if (!inMarket) throw new Error(`marketplace.json 里找不到插件「${plugin.name}」的版本号`)
  // 两边打架时以 plugin.json 为准：它是插件自己的清单，引擎先读它。
  if (inMarket !== plugin.version) {
    console.warn(`[bump-version] 两处版本号不一致（plugin ${plugin.version} / marketplace ${inMarket}），按 plugin.json 对齐`)
  }
  return plugin.version
}

function main() {
  const isCheck = process.argv.includes('--check')
  const before = currentVersion()
  if (isCheck) {
    process.stdout.write(before + '\n')
    return
  }
  const after = bumpPatch(before)
  // 插件名从 plugin.json 取，按名字在 marketplace 里找对应条目——不假定
  // 它排在第一位，marketplace 以后可能收录不止一个插件。
  const pluginName = readJson(PLUGIN_JSON).data.name
  for (const file of [PLUGIN_JSON, MARKETPLACE_JSON]) {
    const { data } = readJson(file)
    if (file === PLUGIN_JSON) {
      data.version = after
    } else {
      const entry = data.plugins?.find(item => item.name === pluginName)
      if (!entry) throw new Error(`marketplace.json 里找不到「${pluginName}」`)
      entry.version = after
    }
    writeJson(file, data)
  }
  // 输出给 pre-commit 用：它据此把这两个文件加进暂存区。
  process.stdout.write(`${before} -> ${after}\n`)
}

// 作为脚本直接运行时才执行；被测试 import 时只导出 `bumpPatch`。
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  try {
    main()
  } catch (error) {
    console.error(`[bump-version] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
