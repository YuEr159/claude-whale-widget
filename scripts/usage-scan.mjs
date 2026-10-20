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
  // 概览卡片用：模型按「消息条数」排名（含未收录价格的第三方模型，
  // 只记模型名与条数，不记金额）；按小时统计消息数取峰值。
  const byModelCount = new Map()
  const byHour = new Array(24).fill(0)
  // 逐日轮次（用户输入次数），给 GitHub 式的轮次柱状图用。
  const byTurnDay = new Map()
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
      // 便宜的预筛：99% 的行既不含 usage 也不是 user 行，先跳过大半，
      // 省掉 JSON.parse 的开销。
      const hasUsage = line.includes('"usage"')
      const hasUser = line.includes('"type":"user"')
      if (!hasUsage && !hasUser) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        unparsed += 1
        continue
      }
      // 轮次：一条用户真正输入的消息算一轮。
      // 工具结果回填的行也标成 user，靠 promptId / toolUseResult 区分。
      if (row?.type === 'user') {
        const isToolResult = row.toolUseResult !== undefined || row.promptId === undefined
        if (!isToolResult) {
          const day = dayKey(row.timestamp)
          const stamp = Date.parse(row.timestamp)
          if (day && !(stamp < cutoff)) {
            byTurnDay.set(day, (byTurnDay.get(day) ?? 0) + 1)
          }
        }
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

      // 峰值时段：按本地时区的小时归组。
      const hour = new Date(row.timestamp).getHours()
      if (hour >= 0 && hour < 24) byHour[hour] += 1

      // 常用模型：所有模型都计数，包括未收录价格的。
      byModelCount.set(model, (byModelCount.get(model) ?? 0) + 1)

      // 逐模型明细收录**所有**模型：未收录价格的第三方模型也要出现在排行里，
      // 只是 cost 记 0，由界面标成「未收录价格」——否则模型页在只用第三方
      // 模型的机器上会整页空白。
      const price = priceOf(model)
      const cost = price
        ? (input * price.input +
            output * price.output +
            cacheWrite * price.cacheWrite +
            cacheRead * price.cacheRead) /
          1_000_000
        : 0
      bucket.cost += cost

      let entry = byModel.get(model)
      if (!entry) {
        entry = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          messages: 0,
          // 这个模型是否有价格；界面据此决定显示金额还是「未收录价格」。
          isPriced: price !== undefined,
        }
        byModel.set(model, entry)
      }
      entry.input += input
      entry.output += output
      entry.cacheRead += cacheRead
      entry.cacheWrite += cacheWrite
      entry.messages += 1
      entry.cost += cost
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

  // 峰值时段：消息最多的小时；并列时取较早的那个。
  let peakHour = null
  let peakCount = 0
  for (let hour = 0; hour < 24; hour += 1) {
    if (byHour[hour] > peakCount) {
      peakCount = byHour[hour]
      peakHour = hour
    }
  }

  // 常用模型：按消息条数取第一名。
  // `auto` / `<synthetic>` 是引擎的内部标识，用户眼里它不是一个模型，
  // 所以只在没有别的候选时才拿它兜底。
  const isPlaceholder = model =>
    model === 'auto' ||
    model === '(unknown)' ||
    model.startsWith('<') ||
    model.startsWith('imported-from')
  let favoriteModel = null
  let favoriteCount = 0
  let fallbackModel = null
  let fallbackCount = 0
  for (const [model, count] of byModelCount) {
    if (isPlaceholder(model)) {
      if (count > fallbackCount) {
        fallbackCount = count
        fallbackModel = model
      }
      continue
    }
    if (count > favoriteCount) {
      favoriteCount = count
      favoriteModel = model
    }
  }
  if (favoriteModel === null) {
    favoriteModel = fallbackModel
    favoriteCount = fallbackCount
  }

  const messages = total.messages
  const totalTokens =
    total.input + total.output + total.cacheRead + total.cacheWrite

  return {
    /** 扫描覆盖的日志文件数（只用于说明覆盖范围，不含路径）。 */
    files: files.length,
    /** 概览：有消息的会话数、有消息的天数、峰值小时（0–23）、常用模型。 */
    overview: {
      // 一个日志文件对应一个会话（文件名就是 sessionId）；同名的只算一次。
      sessions: new Set(files.map(file => path.basename(file, '.jsonl'))).size,
      activeDays: daysSorted.length,
      peakHour,
      peakHourMessages: peakCount,
      favoriteModel,
      favoriteModelMessages: favoriteCount,
      totalMessages: messages,
      totalTokens,
    },
    /** 统计窗口内最早再往前推的日期，让界面能说「最近 N 天」。 */
    windowDays: days,
    today: { day: today, ...todayBucket },
    total,
    daily,
    /** 逐日轮次（用户输入次数），只含有轮次的日子。 */
    turnsDaily: [...byTurnDay.entries()]
      .map(([day, turns]) => ({ day, turns }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
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
