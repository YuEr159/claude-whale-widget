/**
 * 把 `~/.claude/projects/**\/*.jsonl` 的会话日志聚合成「今天的 token 与估算花费」。
 *
 * 隐私（**本文件是唯一接触日志内容的地方**）：
 *   - 只读 `type`、`timestamp`、`message.id`、`message.model`、`message.usage` 五个字段；
 *   - 绝不读 `cwd`、`sessionId`、`message.content`、`tool_result`、prompt 文本、文件路径；
 *   - 不写任何缓存文件，不把日志字节发给任何进程或网络；
 *   - 输出只有数字和模型名，模型名会按「是否为官方 Claude 模型」过滤后回传。
 *
 * 该脚本由宿主 mod 用 `node` 启动，参数是「根目录」和「要统计的天数」，
 * stdout 输出一行 JSON。设计成独立文件是为了用真 node 流式读大文件：
 * 单个日志可能有上百 MB，而 mod 自己的 `$.fs.read` 有 4 MiB 上限。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 官方模型的前缀；只有以它开头的模型才计价并列进逐模型明细。 */
const OFFICIAL_PREFIX = 'claude-'

/** 与 hooks/pricing.ts 保持一致的官方价格（美元 / 每百万 token）。 */
const PRICES = [
  ['claude-fable-5-1', 10, 50],
  ['claude-mythos-5-1', 10, 50],
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-4-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  ['claude-haiku-3-5', 0.8, 4],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-opus', 15, 75],
  ['claude-3-haiku', 0.25, 1.25],
]

function priceOf(model) {
  const id = model.toLowerCase()
  for (const [prefix, input, output] of PRICES) {
    if (id.startsWith(prefix)) {
      return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 }
    }
  }
  return undefined
}

function dayKey(timestamp) {
  // 用本地时区切天：日志里的 timestamp 是 UTC ISO 串。
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return undefined
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 日志里同一条 assistant 消息会被写成多行（流式增量），必须按 message.id 去重，
 * 否则用量会被重复累加几倍。
 */
function collectFiles(root, days) {
  const cutoff = Date.now() - days * 86_400_000
  const files = []
  const walk = dir => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(full)
          if (stat.mtimeMs >= cutoff) files.push(full)
        } catch {
          /* 单个文件读不到就跳过，不影响整体 */
        }
      }
    }
  }
  walk(root)
  return files
}

/**
 * @param {string} root  日志根目录（`~/.claude/projects`）
 * @param {number} days  统计最近多少天
 */
export function aggregate(root, days) {
  const cutoff = Date.now() - days * 86_400_000
  const files = collectFiles(root, days)

  /** 去重键是 message.id；同一条消息可能跨文件重复出现。 */
  const seen = new Set()
  const byDay = new Map()
  const byModel = new Map()
  let unparsed = 0
  let skipped = 0

  const bucketOf = day => {
    let bucket = byDay.get(day)
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 }
      byDay.set(day, bucket)
    }
    return bucket
  }

  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let start = 0
    while (start < text.length) {
      let end = text.indexOf('\n', start)
      if (end < 0) end = text.length
      const line = text.slice(start, end)
      start = end + 1
      if (line.length === 0) continue
      // 便宜的预筛：99% 的行不含 usage，先跳过大半，省掉 JSON.parse 的开销。
      if (!line.includes('"usage"')) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        unparsed += 1
        continue
      }
      if (row?.type !== 'assistant') continue
      const message = row.message
      const usage = message?.usage
      if (!usage) continue

      const day = dayKey(row.timestamp)
      if (!day) continue
      // 文件按修改时间粗筛，但同一个文件里可能混着更早的行：逐行再按日期裁一次，
      // 否则「最近 7 天」里会冒出 20 多天前的数据。
      if (Date.parse(row.timestamp) < cutoff) continue

      const id = message.id
      if (typeof id === 'string' && id.length > 0) {
        if (seen.has(id)) {
          skipped += 1
          continue
        }
        seen.add(id)
      }

      const input = Number(usage.input_tokens) || 0
      const output = Number(usage.output_tokens) || 0
      const cacheRead = Number(usage.cache_read_input_tokens) || 0
      const cacheWrite = Number(usage.cache_creation_input_tokens) || 0
      const model = typeof message.model === 'string' ? message.model : '(unknown)'

      const bucket = bucketOf(day)
      bucket.input += input
      bucket.output += output
      bucket.cacheRead += cacheRead
      bucket.cacheWrite += cacheWrite
      bucket.messages += 1

      const price = priceOf(model)
      if (price) {
        const cost =
          (input * price.input +
            output * price.output +
            cacheWrite * price.cacheWrite +
            cacheRead * price.cacheRead) /
          1_000_000
        bucket.cost += cost

        // 只有官方模型才进到这一支（priceOf 只认官方），key 直接用模型名。
        const key = model
        let entry = byModel.get(key)
        if (!entry) {
          entry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 }
          byModel.set(key, entry)
        }
        entry.input += input
        entry.output += output
        entry.cacheRead += cacheRead
        entry.cacheWrite += cacheWrite
        entry.messages += 1
        entry.cost += cost
      }
    }
  }

  const today = dayKey(new Date().toISOString())
  const daysSorted = [...byDay.keys()].sort()
  let total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 }
  const daily = daysSorted.map(day => {
    const b = byDay.get(day)
    total = {
      input: total.input + b.input,
      output: total.output + b.output,
      cacheWrite: total.cacheWrite + b.cacheWrite,
      cacheRead: total.cacheRead + b.cacheRead,
      cost: total.cost + b.cost,
      messages: total.messages + b.messages,
    }
    return { day, ...b }
  })

  const todayBucket = byDay.get(today) ?? {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    cost: 0,
    messages: 0,
  }

  return {
    /** 扫描覆盖的日志文件数（只用于说明覆盖范围，不含路径）。 */
    files: files.length,
    /** 统计窗口内最早再往前推的日期，让界面能说「最近 N 天」。 */
    windowDays: days,
    today: { day: today, ...todayBucket },
    total,
    daily,
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost),
    skippedDuplicates: skipped,
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const root = process.argv[2]
  const days = Number(process.argv[3]) || 7
  try {
    process.stdout.write(JSON.stringify(aggregate(root, days)))
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    )
    process.exitCode = 1
  }
}
