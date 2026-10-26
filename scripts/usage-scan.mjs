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
// 价目表与 `hooks/pricing.ts` **共用同一份数据**，不再各写一份副本。
// 早先两份手工复制、靠注释要求「保持一致」，没有任何测试比对。
import { priceOf } from '../hooks/pricing-data.mjs'

/** 官方模型的前缀；只有以它开头的模型才计价并列进逐模型明细。 */
const OFFICIAL_PREFIX = 'claude-'

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
 *
 * 返回每个文件的 `mtimeMs` 与 `size`：增量缓存靠这两个值判断「这个文件上次
 * 扫过之后有没有变」。它们只是文件系统的元数据，不是路径之外的任何内容。
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
          if (stat.mtimeMs >= cutoff) files.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size })
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
 * 解析**一个**日志文件，返回它贡献的增量。
 *
 * 抽成独立函数是为了增量缓存：文件没变就整段跳过，不再读 800 MB。
 * `seen` 由调用方传入并在文件之间共享——同一条 message.id 可能跨文件重复，
 * 去重必须跨文件才有意义。
 *
 * 返回的每一项都是可加的：天数、模型、逐日逐模型都只累加数字。
 */
function scanFile(file, cutoff, seen) {
  const out = {
    byDay: new Map(),
    byModel: new Map(),
    byModelCount: new Map(),
    byHour: new Array(24).fill(0),
    byTurnDay: new Map(),
    byDayModel: new Map(),
    unparsed: 0,
    skipped: 0,
    /**
     * 本文件里每一轮的上下文窗口占用，按时间顺序。
     *
     * 一条 assistant 消息在 jsonl 里会写成多行流式增量，只有**最后一行**
     * 的 usage 才是这一轮的真实读数（首行的 `output_tokens` 与
     * `cache_read_input_tokens` 都是 0）。所以这里先按 `message.id` 收齐
     * 末个快照，再按 `promptId` 归成「轮」——一轮里可能有多条 assistant
     * 消息（工具调用循环），取其中**最后一条**的窗口占用，因为那才是这一轮
     * 结束时窗口的样子。
     *
     * 记下的只有 token 数与模型名，没有内容、没有路径。
     */
    contextTurns: [],
    /** 本文件新增进 `seen` 的 message.id，缓存复用时据此补齐跨文件去重。 */
    seenIds: [],
    /** 本文件的会话标识（文件名即 sessionId），缓存复用时据此还原上下文序列。 */
    sessionId: '',
  }
  const bump = (map, key, delta) => map.set(key, (map.get(key) ?? 0) + delta)

  // 会话标识就是文件名（不含扩展名）。子代理日志放在 `subagents/` 下，
  // 它们的提示不在主会话的上下文窗口里，混进来会把曲线拉花。
  out.sessionId = path.basename(file, '.jsonl')

  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }

  /**
   * 本文件里**同一条消息的最后一个快照**，按 message.id 索引。
   *
   * 为什么必须取最后一个：一条 assistant 消息在 JSONL 里会被写成多行流式
   * 增量。第一行是「请求已发出、回复还没来」的状态——`output_tokens` 是 0、
   * `cache_read_input_tokens` 是 0，只有 `input_tokens` 是有值的。最后一行
   * 才是这一轮的真实读数。
   *
   * 早先按「先到先得」去重，等于**每一条消息都取第一行**。实测本机 30 天
   * 窗口：output 按首行是 15,951,781、按末行 24,671,912（少算 55%），
   * cacheRead 少算 22%；而 input 反而多算 81%，因为首行的 input 是完整
   * prompt、末行的 input 变成「新增部分」——两边口径根本不同。
   *
   * 先在本文件内归并，再走跨文件的 `seen` 去重：跨文件那份仍然是先到先得
   * （resume / fork 会把旧行抄进新文件，重复计一次没有问题），但文件内
   * 一定取到完整的那个快照。
   */
  const latestById = new Map()
  /** 没有 id 的行（老格式）直接按出现顺序累加，无法去重。 */
  const noIdRows = []
  /**
   * 当前是第几次用户提问（从 0 起，遇到真正的提问就 +1）。
   *
   * 上下文图的一根柱子应当对应**读者的一次提问**，而不是引擎的一次请求。
   * 一次提问里工具调用的往返循环会写出几十条 assistant 消息，逐条画柱子
   * 会让 19 次提问变成 694 根柱子（实测），读者根本对不上自己的操作。
   * 所以每条 assistant 消息都记下它属于哪一次提问，最后按这个分组取末条。
   */
  let turnIndex = 0
  /** 每一轮提问在窗口里留下的最后一个读数，按 `turnIndex` 索引。 */
  const contextByTurn = new Map()

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
      out.unparsed += 1
      continue
    }
    // 轮次：一条用户真正输入的消息算一轮。
    //
    // 工具结果回填的行也标成 `type: "user"`，必须排除。三种形态都要认：
    //   1. 带 `toolUseResult` 字段（主会话里的老写法）；
    //   2. 没有 `promptId`（同样是老写法）；
    //   3. **`message.content` 是 `tool_result` 数组**——子代理日志里就是这样，
    //      而且它**带** `promptId`，前两条都拦不住。
    //
    // 第 3 条是后补的：实测本机被判成轮次的 1665 行里有 683 行（41%）其实
    // 是工具结果，全在 `subagents/agent-*.jsonl` 里。轮次因此几乎翻倍，
    // 热图的「轮次」口径比「消息数」还高。
    if (row?.type === 'user') {
      const content = row.message?.content
      const hasToolResultContent =
        Array.isArray(content) && content.some(part => part?.type === 'tool_result')
      const isToolResult =
        row.toolUseResult !== undefined ||
        row.promptId === undefined ||
        hasToolResultContent
      if (!isToolResult) {
        const day = dayKey(row.timestamp)
        const stamp = Date.parse(row.timestamp)
        if (day && !(stamp < cutoff)) bump(out.byTurnDay, day, 1)
        // 新的一次提问：后面的 assistant 消息都归到这一轮。
        turnIndex += 1
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
    const stamp = Date.parse(row.timestamp)
    if (stamp < cutoff) continue

    const record = { row, message, usage, day, turnIndex }
    const id = message.id
    if (typeof id === 'string' && id.length > 0) {
      // 后写覆盖先写：同一个 id 在文件里出现多次时，留下的是最后那个快照。
      latestById.set(id, record)
    } else {
      noIdRows.push(record)
    }
  }

  for (const record of [...noIdRows, ...latestById.values()]) {
    const { row, message, usage, day } = record
    const stamp = Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : 0
    const id = message.id
    if (typeof id === 'string' && id.length > 0) {
      // 跨文件去重仍然先到先得：resume / fork 会把旧会话的行抄进新文件，
      // 那些是同一个 message.id，只该计一次。
      if (seen.has(id)) {
        out.skipped += 1
        continue
      }
      seen.add(id)
      out.seenIds.push(id)
    }

    const input = Number(usage.input_tokens) || 0
    const output = Number(usage.output_tokens) || 0
    const cacheRead = Number(usage.cache_read_input_tokens) || 0
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0
    const model = typeof message.model === 'string' ? message.model : '(unknown)'

    let bucket = out.byDay.get(day)
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 }
      out.byDay.set(day, bucket)
    }
    bucket.input += input
    bucket.output += output
    bucket.cacheRead += cacheRead
    bucket.cacheWrite += cacheWrite
    bucket.messages += 1

    // 峰值时段：按本地时区的小时归组。
    const hour = new Date(row.timestamp).getHours()
    if (hour >= 0 && hour < 24) out.byHour[hour] += 1

    // 常用模型：所有模型都计数，包括未收录价格的。
    bump(out.byModelCount, model, 1)

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

    let entry = out.byModel.get(model)
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
      out.byModel.set(model, entry)
    }
    entry.input += input
    entry.output += output
    entry.cacheRead += cacheRead
    entry.cacheWrite += cacheWrite
    entry.messages += 1
    entry.cost += cost

    // 逐日逐模型：只累加「输入（含缓存读）」与「输出」两个口径，
    // 与模型页柱子要表达的东西一一对应。引擎内部标识不进来。
    if (!model.startsWith('<') && model !== 'auto' && model !== '(unknown)' && model !== '') {
      let perDay = out.byDayModel.get(day)
      if (!perDay) {
        perDay = new Map()
        out.byDayModel.set(day, perDay)
      }
      const inTok = input + cacheRead + cacheWrite
      const cell = perDay.get(model)
      if (cell) {
        cell.input += inTok
        cell.output += output
        cell.cost += cost
      } else {
        perDay.set(model, { input: inTok, output, cost })
      }
    }

    // 上下文窗口占用：本轮输入（含缓存读写）就是这一轮**用完**之后的窗口
    // 内容量。输出不算——它是这一轮新生成、下一轮才会进窗口的东西。
    //
    // **零值丢掉。** 首轮请求发出时 `cache_read` 与 `cache_write` 都还是 0，
    // 只有 `input_tokens` 有值，那是真实读数；但流式写下的「请求已发出、
    // 回复还没来」那种空快照会算出 0，画到图上就是一根假谷底。
    //
    // **按提问归组，不按消息。** 一次提问里的工具调用循环会写出几十条
    // assistant 消息，逐条画柱子对不上读者的操作（实测一场 19 次提问的
    // 会话会画出 694 根柱子）。这里先用 `turnIndex` 收齐同一轮的所有消息，
    // 最后只取那一条——窗口在这一轮结束时最大，就取它。
    const contextTokens = input + cacheRead + cacheWrite
    if (contextTokens > 0) {
      const prev = contextByTurn.get(record.turnIndex)
      // 同一轮里取**时刻最新**的那条：工具循环的往返按时间递增，末条就是
      // 这一轮的终态。不做 `Math.max(tokens)`——上下文可能因压缩而下降，
      // 取最大值会把压缩后的真实读数抹掉。
      if (!prev || stamp >= prev.at) {
        contextByTurn.set(record.turnIndex, {
          at: stamp,
          tokens: contextTokens,
          output,
          model,
        })
      }
    }
  }

  // 归组结果按时刻排序后写进 `out`：`turnIndex` 只保证文件内递增，
  // 而同一场的消息可能分散在多个文件里（resume / fork）。
  out.contextTurns = [...contextByTurn.values()]
    .sort((a, b) => a.at - b.at)
    .map((item, index) => ({ ...item, seq: index + 1 }))
  return out
}

/**
 * 把一个文件的增量并进总账。
 *
 * 增量可以缓存、可以重放，所以合并必须是纯加法：同一批文件重放多少次，
 * 只要调用方保证每个文件只并一次，结果就与全量扫描一致。
 */
function mergeScan(acc, part) {
  acc.unparsed += part.unparsed
  acc.skipped += part.skipped
  // 上下文序列按会话归集。同一个会话可能跨多个文件（resume / fork 会把
  // 旧行抄进新文件），但**只保留读数最多的那一份**：抄来的旧行与原件
  // 是同一批读数，两边都收会画出一段重复的锯齿。
  const turns = part.contextTurns ?? []
  if (turns.length > 0 && part.sessionId) {
    const held = acc.contextBySession.get(part.sessionId)
    if (!held || turns.length > held.length) acc.contextBySession.set(part.sessionId, turns)
  }
  part.byHour.forEach((count, hour) => {
    acc.byHour[hour] += count
  })
  for (const [day, b] of part.byDay) {
    let bucket = acc.byDay.get(day)
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 }
      acc.byDay.set(day, bucket)
    }
    bucket.input += b.input
    bucket.output += b.output
    bucket.cacheRead += b.cacheRead
    bucket.cacheWrite += b.cacheWrite
    bucket.cost += b.cost
    bucket.messages += b.messages
  }
  for (const [model, entry] of part.byModel) {
    let held = acc.byModel.get(model)
    if (!held) {
      held = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0, isPriced: entry.isPriced }
      acc.byModel.set(model, held)
    }
    held.input += entry.input
    held.output += entry.output
    held.cacheRead += entry.cacheRead
    held.cacheWrite += entry.cacheWrite
    held.messages += entry.messages
    held.cost += entry.cost
  }
  for (const [model, count] of part.byModelCount) {
    acc.byModelCount.set(model, (acc.byModelCount.get(model) ?? 0) + count)
  }
  for (const [day, turns] of part.byTurnDay) {
    acc.byTurnDay.set(day, (acc.byTurnDay.get(day) ?? 0) + turns)
  }
  for (const [day, perDay] of part.byDayModel) {
    let held = acc.byDayModel.get(day)
    if (!held) {
      held = new Map()
      acc.byDayModel.set(day, held)
    }
    for (const [model, cell] of perDay) {
      const prev = held.get(model)
      if (prev) {
        prev.input += cell.input
        prev.output += cell.output
        prev.cost += cell.cost
      } else {
        held.set(model, { ...cell })
      }
    }
  }
}

/**
 * 一天的用量：轮次（用户输入次数）与消息数。
 *
 * 两者分别统计：轮次来自 `type: "user"` 且不是工具回填的行，消息数来自
 * `type: "assistant"` 且带 usage 的行（已按 message.id 去重）。
 *
 * **增量缓存**：`cache` 是上一次扫描留下的按文件指纹（`mtimeMs:size`）索引。
 * 没变的文件直接取上次的结果，只有新增或改动过的文件才重新读。日志是只追加的，
 * 一个 400 天窗口里绝大多数文件都不会再变，所以这一步把每次扫描从「读 800 MB」
 * 降到「读几个刚写过的文件」。缓存只存在内存里（由调用方持有），不落盘。
 *
 * @param {string} root  日志根目录（`~/.claude/projects`）
 * @param {number} days  统计最近多少天
 * @param {Map<string, {fingerprint: string, part: object}>} [cache]
 */
export function aggregate(root, days, cache, sessionId) {
  const cutoff = Date.now() - days * 86_400_000
  const files = collectFiles(root, days)
  const acc = {
    byDay: new Map(),
    byModel: new Map(),
    byModelCount: new Map(),
    byHour: new Array(24).fill(0),
    byTurnDay: new Map(),
    byDayModel: new Map(),
    unparsed: 0,
    skipped: 0,
    /**
     * 每个会话的上下文序列：`sessionId` → 逐轮读数。
     *
     * **不并进 `byDay` 那样的日粒度桶。** 上下文窗口是**会话级的**——它随
     * 单场对话一路增长、压缩、再增长，把两个会话的读数按天混在一起画，
     * 得到的曲线既不描述任何一场对话，也读不出「什么时候快满了」。
     * 所以这里保留会话边界，由界面只取当前这一场。
     */
    contextBySession: new Map(),
  }
  /** 去重键是 message.id；同一条消息可能跨文件重复出现。 */
  const seen = new Set()
  let reused = 0
  let rescanned = 0

  for (const file of files) {
    const fingerprint = `${file.mtimeMs}:${file.size}`
    const held = cache?.get(file.path)
    // **当前会话的文件永远重读。** 它的上下文序列要原样回传，而缓存里
    // 只留当前会话那一份、其余会话的清掉（见 `packCache`）；如果当前会话
    // 的文件也命中缓存，第二次扫描就会拿到一个被清空的序列，曲线凭空变短。
    // 这场会话只有一个文件，重读几十毫秒，远小于「曲线莫名只剩几根柱子」。
    //
    // 重读前要把它的 id 从 `seen` 里摘掉：这些 id 是它自己上一次扫出来的，
    // 留着会让 `scanFile` 把每一条都当成「别的文件里已计过」而全部跳过，
    // 结果是既有数字照旧、而上下文序列为空。
    const isCurrentSession = sessionId && path.basename(file.path, '.jsonl') === sessionId
    if (isCurrentSession && held) {
      for (const id of held.seenIds) seen.delete(id)
    }
    if (!isCurrentSession && held && held.fingerprint === fingerprint) {
      // 没变：并进上次的结果。它见过的 message.id 也要放回 `seen`——
      // 跨文件去重靠这个集合，缺了它们后面读到的文件会重复计数。
      for (const id of held.seenIds) seen.add(id)
      mergeScan(acc, held.part)
      reused += 1
      continue
    }
    const part = scanFile(file.path, cutoff, seen)
    // 记下这个文件自己见过的 message.id：缓存复用时要把它们重新放回
    // `seen`，否则后读的文件会与缓存里的文件重复计数。
    const seenIds = part.seenIds
    // **别的会话的上下文序列就地丢掉**，别等 `packCache`——留在这里会让
    // 下一次扫描的内存里也压着几十份用不上的序列。`part.contextTurns`
    // 已经并进 `acc`（当前会话那份），这里删掉不影响返回结果。
    const cacheTurns = part.sessionId === sessionId ? part.contextTurns : []
    if (cache) {
      cache.set(file.path, { fingerprint, part: { ...part, contextTurns: cacheTurns }, seenIds })
    }
    mergeScan(acc, part)
    rescanned += 1
  }

  const { byDay, byModel, byModelCount, byHour, byTurnDay, byDayModel } = acc
  const unparsed = acc.unparsed
  const skipped = acc.skipped

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
      //
      // **排除子代理日志。** 一次 `Task` 调用会产出 `subagents/agent-*.jsonl`，
      // 文件名各不相同，照文件名数就会把它们各算成一个会话。实测本机 281 个
      // 日志文件里 171 个是子代理的，会话数因此虚高 2.55 倍。
      sessions: new Set(
        files
          .filter(file => !file.path.includes('subagents'))
          .map(file => path.basename(file.path, '.jsonl')),
      ).size,
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
    /**
     * **当前这一场会话**的上下文窗口占用曲线（按时间顺序）。
     *
     * 只给当前会话：上下文是会话级的东西，别的会话的读数对「我现在这个窗口
     * 有多满」没有意义。`sessionId` 由插件用 `$.session.id()` 传进来，
     * 与本文件自己的 sessionId 是同一个值（transcript 的文件名）。
     *
     * 每项只有时刻、token 数、输出数与模型名——没有内容、没有路径。
     */
    contextTurns: (sessionId ? acc.contextBySession.get(sessionId) : undefined) ?? [],
    /**
     * 逐日轮次与消息数。取「有轮次」与「有消息」两边的并集：
     * 只补轮次会漏掉纯 assistant 记录的日子，只补消息会漏掉只有提问的日子。
     */
    turnsDaily: [...new Set([...byTurnDay.keys(), ...byDay.keys()])]
      .map(day => ({
        day,
        turns: byTurnDay.get(day) ?? 0,
        messages: byDay.get(day)?.messages ?? 0,
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost),
    /**
     * 逐日逐模型用量（in = 输入含缓存读/写，out = 输出）。
     *
     * 只含非占位模型；零值日不补，界面按窗口自己补 0。
     */
    modelDaily: [...byDayModel.entries()]
      .map(([day, perDay]) => ({
        day,
        models: [...perDay.entries()]
          .map(([model, v]) => ({ model, input: v.input, output: v.output, cost: v.cost }))
          .sort((a, b) => b.input + b.output - (a.input + a.output)),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    skippedDuplicates: skipped,
  }
}

/**
 * 把内存里的缓存折成可 JSON 序列化的形状。
 *
 * 缓存本来是一堆 Map，JSON 存不下 Map，所以逐层摊平成数组。只含
 * 「文件路径 → 指纹 + 该文件的数字增量」，没有任何日志正文。
 */
/** 缓存里 message.id 列表的总长度上限（字符）。 */
const SEEN_IDS_BUDGET = 2_000_000

/**
 * 把缓存压成可 JSON 序列化的数组。
 *
 * **`seenIds` 会按预算裁剪。** 它是缓存里最大的一块——每个文件的每一条消息
 * 的 id 都要留着，因为跨文件去重（resume / fork 会把旧行抄进新文件）靠它。
 * 实测本机 281 个文件 / 3.7 万条消息时它占 1.24 MB，而宿主 `process.run`
 * 的 stdout 只能保留前 4 MiB；再积累一年多就会撞线，stdout 变成半截 JSON，
 * 面板永久停在解析错误上。
 *
 * 裁剪策略：总额超预算时，**从最老的文件开始清空**。理由是最新的会话才
 * 最可能与「刚 fork 出来的文件」撞 id，老文件的 id 重复概率低。被清空的
 * 文件仍保留它的聚合数字，只是不再参与跨文件去重——代价是极少数老消息
 * 可能被计两次，远小于「整个面板坏掉」。
 *
 * **`contextTurns` 只缓存当前会话那一份。** 上下文曲线是会话级的东西，
 * 面板只画当前这一场；把每个文件的完整序列都塞进缓存，等于同一份数据存
 * 了几百遍——实测 400 天窗口下它单独就占 3.06 MB，加上 `seenIds` 直接
 * 把 stdout 顶过 4 MiB，扫描永久报「输出超过 4 MiB」。别的会话的序列在
 * 合并时就没有意义，索性不缓存。
 *
 * @param cache 上一次扫描留下的缓存
 * @param sessionId 当前会话；只保留它的上下文序列，其余一律丢弃
 */
function packCache(cache, sessionId) {
  const out = []
  // 按文件修改时间排序，最老的先被裁。
  const ordered = [...cache.entries()].sort((a, b) => a[1].fingerprint.localeCompare(b[1].fingerprint))
  const totalIds = ordered.reduce((sum, [, held]) => sum + held.seenIds.length * 24, 0)
  let budget = SEEN_IDS_BUDGET
  const keepIds = new Set()
  // 从最新往回挑，直到用完预算。
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const [file, held] = ordered[index]
    const cost = held.seenIds.length * 24
    if (totalIds > SEEN_IDS_BUDGET && budget - cost < 0) continue
    budget -= cost
    keepIds.add(file)
  }

  for (const [file, held] of cache) {
    out.push([
      file,
      held.fingerprint,
      [...held.part.byDay.entries()],
      [...held.part.byModel.entries()],
      [...held.part.byModelCount.entries()],
      held.part.byHour,
      [...held.part.byTurnDay.entries()],
      [...held.part.byDayModel.entries()].map(([day, perDay]) => [day, [...perDay.entries()]]),
      held.part.unparsed,
      held.part.skipped,
      keepIds.has(file) ? held.seenIds : [],
      held.part.sessionId ?? '',
      // 只有当前会话的序列值得留；别的会话不会上屏，缓存它们纯属浪费预算。
      held.part.sessionId === sessionId ? (held.part.contextTurns ?? []) : [],
    ])
  }
  return out
}

/** `packCache` 的逆操作；形状不对就当作没有缓存。 */
function unpackCache(raw) {
  if (!Array.isArray(raw)) return new Map()
  const cache = new Map()
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 11) continue
    const [
      file,
      fingerprint,
      byDay,
      byModel,
      byModelCount,
      byHour,
      byTurnDay,
      byDayModel,
      unparsed,
      skipped,
      seenIds,
      sessionId,
      contextTurns,
    ] = row
    if (typeof file !== 'string' || typeof fingerprint !== 'string') continue
    cache.set(file, {
      fingerprint,
      part: {
        byDay: new Map(byDay ?? []),
        byModel: new Map(byModel ?? []),
        byModelCount: new Map(byModelCount ?? []),
        byHour: Array.isArray(byHour) ? byHour : new Array(24).fill(0),
        byTurnDay: new Map(byTurnDay ?? []),
        byDayModel: new Map((byDayModel ?? []).map(([day, perDay]) => [day, new Map(perDay ?? [])])),
        unparsed: Number(unparsed) || 0,
        skipped: Number(skipped) || 0,
        seenIds: Array.isArray(seenIds) ? seenIds : [],
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        contextTurns: Array.isArray(contextTurns) ? contextTurns : [],
      },
      seenIds: Array.isArray(seenIds) ? seenIds : [],
    })
  }
  return cache
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const root = process.argv[2]
  const days = Number(process.argv[3]) || 7
  // 第四个参数是当前会话的 id（transcript 文件名），用来挑出这一场的上下文曲线。
  // 不给就只返回空数组——上下文是会话级的东西，没有会话就无从谈起。
  const sessionId = typeof process.argv[4] === 'string' ? process.argv[4] : ''
  // 缓存通过 stdin 传入、经 stdout 回传：插件在两次扫描之间把它留在内存里。
  // 不写任何缓存文件——PRIVACY.md 的「不落盘」承诺因此照旧成立。
  let cache = new Map()
  try {
    // **只有 stdin 是管道时才读。** `readFileSync(0)` 在终端里会一直等到
    // EOF——按 README 的方式手动跑 `node scripts/usage-scan.mjs <root> 7`
    // 调试时，进程会无输出地挂住，看起来像卡死。`isTTY` 为真说明前面坐的是
    // 人，不是宿主，这时直接走全量扫描。
    if (!process.stdin.isTTY) {
      const input = fs.readFileSync(0, 'utf8')
      if (input.trim().length > 0) cache = unpackCache(JSON.parse(input))
    }
  } catch {
    /* 没有 stdin 或内容坏了：退回全量扫描，不影响正确性 */
  }
  try {
    const result = aggregate(root, days, cache, sessionId)
    process.stdout.write(JSON.stringify({ ...result, cache: packCache(cache, sessionId) }))
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    )
    process.exitCode = 1
  }
}
