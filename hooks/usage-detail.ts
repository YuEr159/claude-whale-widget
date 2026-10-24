/**
 * 面板「详细」视图：把 Claude 原生 `/usage` 与 `/context` 的字段整理成界面
 * 要的行。纯计算，不碰 `$`，方便单测。
 *
 * 对应关系（与引擎文案一致）：
 *   /usage    额度窗口 Current session / Current week、会话总花费、会话时长、
 *             代码增删行数、Usage by model
 *   /context  上下文窗口的构成。逐项清单与 10×10 网格不在这里画——柱状图
 *             已经按同一批类别着色，只保留柱子表达不了的：窗口上限、压缩阈值、
 *             以及记忆文件 / MCP / agent / 技能的数量。
 *
 * 拿不到的两项，界面上如实写明，不拿别的数硬凑：
 *   `Total duration (API)` —— 引擎只给每轮的墙钟时长；
 *   子代理的消耗 —— 只在它自己的 `turn.complete` 里，主线程不汇总。
 */
import type { Prefs } from '../types'
import { tokens } from './format.ts'
import { usdEstimate } from './provenance.ts'

// ---------------- /usage：额度窗口 ----------------

/** `$.session.usage().rateLimits` 的一条，按界面需要的形状收窄。 */
export type LimitView = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** 额度窗口的一行：原生面板的标题 + 读数 + 重置时间。 */
export type LimitRow = {
  /** 原生面板的标题，如 `Current session`。 */
  title: string
  percentUsed: number
  resetsAt?: string
}

/** 原生 `/usage` 认识的三类窗口，其余原样列出。 */
const KNOWN_LIMIT_TITLES: Readonly<Record<string, string>> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_sonnet: 'Current week (Sonnet only)',
}

/**
 * 把 rateLimits 映射成原生 `/usage` 的窗口行。
 * 未知 kind（网关的 spend_limit 等）照样出行，标题就是 kind 本身。
 */
export function limitRows(limits: LimitView[]): LimitRow[] {
  const order = ['five_hour', 'seven_day', 'seven_day_sonnet']
  const rows: LimitRow[] = []
  for (const kind of order) {
    const limit = limits.find(item => item.kind === kind)
    if (limit) {
      rows.push({
        title: KNOWN_LIMIT_TITLES[kind] ?? kind,
        percentUsed: limit.percentUsed,
        resetsAt: limit.resetsAt,
      })
    }
  }
  for (const limit of limits) {
    if (order.includes(limit.kind)) continue
    rows.push({ title: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })
  }
  return rows
}

/**
 * 额度条：10 格方块，按比例填充。原生面板画整条进度条，这里用文本方块
 * 近似，终端和桌面都能画。
 */
export function meterText(percentUsed: number, width = 10): string {
  const ratio = Math.max(0, Math.min(1, percentUsed / 100))
  const filled = Math.round(ratio * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

// ---------------- /usage：会话总量 ----------------

/** 会话累计，存在 `$.state` 里；全部是数字，不含任何文件内容。 */
export type SessionTotals = {
  /** 主线程各轮墙钟时长之和，毫秒。 */
  wallMs: number
  /** 主线程的轮次数。 */
  turns: number
  /** Edit / Write 带来的新增行数。 */
  linesAdded: number
  /** Edit / Write 带来的删除行数。 */
  linesRemoved: number
}

export const EMPTY_TOTALS: SessionTotals = { wallMs: 0, turns: 0, linesAdded: 0, linesRemoved: 0 }

/** 时长：`1h 2m 3s`；不足一分钟只显示秒。 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * 数一个 unified diff 的增删行数。
 *
 * `lines` 里以 `+` / `-` 开头的是正文，文件头 `--- a/x` / `+++ b/x` 要排除。
 * 只返回两个数字，不保留任何行内容——这是隐私边界。
 *
 * **判文件头要连后面的空格一起看，不能只认三个符号。** 早先用
 * `startsWith('+++')` / `('---')` 一刀切，会误伤正文里本来就以 `++` / `--`
 * 开头的行：删掉一行 SQL 注释 `-- note` 时，diff 里那一行是 `--- note`，
 * 被当成文件头跳过；新增 `++i;` 同理。行数越多，少计得越多。
 *
 * 真正的文件头格式固定是 `--- <路径>` 与 `+++ <路径>`（三个符号之后一定
 * 跟一个空格）。而 `--- note` / `++i;` 这类正文，三个符号后面是别的字符，
 * 按这个区别就能分开，不必依赖文件头在数组里的位置。
 */
export function countPatchLines(
  patches: ReadonlyArray<{ lines: readonly string[] }>,
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const patch of patches) {
    for (const line of patch.lines) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

// ---------------- /usage：按模型 ----------------

/** 一个模型的累计用量，用于「Usage by model」。 */
export type ModelSpend = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 按官方价格估算；未收录价格的为 null。 */
  cost: number | null
  turns: number
}

/** 累加一轮用量：同一模型多轮相加，未收录价格的一律记 null。 */
export function addModelSpend(list: ModelSpend[], entry: ModelSpend): ModelSpend[] {
  const index = list.findIndex(item => item.model === entry.model)
  if (index < 0) return [...list, entry]
  const next = [...list]
  const prev = next[index]
  if (!prev) return list
  next[index] = {
    model: entry.model,
    input: prev.input + entry.input,
    output: prev.output + entry.output,
    cacheRead: prev.cacheRead + entry.cacheRead,
    cacheWrite: prev.cacheWrite + entry.cacheWrite,
    cost: prev.cost === null || entry.cost === null ? null : prev.cost + entry.cost,
    turns: prev.turns + entry.turns,
  }
  return next
}

/**
 * 本会话花费，按**插件自己的价目表**逐模型累加。
 *
 * **三条显示路径共用这一个函数**（面板顶部、输入框上方的用量条、鲸鱼气泡），
 * 因为它是同一条口径：只要有一款模型未收录价格，就返回 `undefined`，
 * 让调用方退回引擎读数。早先这段「every + reduce + 回退」在面板与用量条
 * 各写一遍，气泡再取一次——三份代码各自演化，同一个会话可能显示三个数。
 *
 * 为什么需要回退：`turn.complete` 写入的 `cost` 已经是按价目表算过的，
 * 未收录价格的是 `null`。少算一笔（当成 0）比显示引擎那套按默认模型估出的
 * 偏高数字更糟，所以只要有一款没价就整笔退回引擎读数，并在能说明的地方
 * 标注「按默认模型价估」。
 *
 * @returns 全部有价时的累加值；任何一款为 `null`、或列表为空时返回 `undefined`。
 */
export function sessionCostOf(models: readonly ModelSpend[]): number | undefined {
  if (models.length === 0) return undefined
  if (!models.every(entry => entry.cost !== null)) return undefined
  return models.reduce((sum, entry) => sum + (entry.cost ?? 0), 0)
}

/**
 * 用量条口径：老状态里没有这个字段、或是空数组时，退回默认值。
 *
 * 「空数组按默认处理」是刻意的——一条空白用量条比显示得多更糟。
 * 面板与用量条两侧共用，避免一处放开了空数组而另一处没有。
 *
 * 泛型让调用方拿回自己的字面量类型，不必再写一次断言。
 */
export function bandMetricsOf<T extends string>(
  prefs: { bandMetrics?: readonly string[] },
  fallback: readonly T[],
): readonly T[] {
  return Array.isArray(prefs.bandMetrics) && prefs.bandMetrics.length > 0
    ? (prefs.bandMetrics as readonly T[])
    : fallback
}

// ---------------- /context：分项 ----------------

export type ContextRowKind = 'used' | 'free' | 'buffer' | 'deferred'

/** 上下文分项的一行。 */
export type ContextRow = {
  name: string
  tokens: number
  kind: ContextRowKind
}

/**
 * 面板「上下文」一节的输入，字段与引擎 breakdown 同名。
 *
 * 逐项清单与 10×10 网格不再出现在界面上：柱状图已经按同一批类别着色，
 * 再列一遍是同一个数字说两遍。这里只保留柱子表达不了的几件事——窗口上限、
 * 压缩阈值、以及记忆文件 / MCP / agent / 技能的数量。
 */
export type ContextDetail = {
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  /** 窗口上限的来源，`auto` 表示模型自身上限。 */
  source: string
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  /** 仍供 `contextParts()` 归类与压缩阈值换算，不再逐行列出。 */
  rows: ContextRow[]
  model: string
  memoryFiles: { path: string; tokens: number }[]
  mcpTools: { name: string; server: string; tokens: number }[]
  agents: { type: string; tokens: number }[]
  slashCommands?: { total: number; included: number; tokens: number }
  skills?: { total: number; included: number; tokens: number }
}

/** 从一段未知形状的 breakdown 里取字段；形状不对返回 undefined。 */
export function toContextDetail(raw: unknown): ContextDetail | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  if (!Array.isArray(source.categories) || typeof source.rawMaxTokens !== 'number') return undefined

  const windowTokens = source.rawMaxTokens
  const rows: ContextRow[] = []
  for (const item of source.categories) {
    if (!item || typeof item !== 'object') continue
    const row = item as { name?: unknown; tokens?: unknown; kind?: unknown }
    if (typeof row.name !== 'string' || typeof row.tokens !== 'number') continue
    const kind: ContextRowKind =
      row.kind === 'free' || row.kind === 'buffer' || row.kind === 'deferred' ? row.kind : 'used'
    rows.push({ name: row.name, tokens: row.tokens, kind })
  }

  return {
    totalTokens: typeof source.totalTokens === 'number' ? source.totalTokens : 0,
    rawMaxTokens: windowTokens,
    percentage: typeof source.percentage === 'number' ? source.percentage : 0,
    source: typeof source.autocompactSource === 'string' ? source.autocompactSource : 'auto',
    isAutoCompactEnabled: source.isAutoCompactEnabled === true,
    autoCompactThreshold:
      typeof source.autoCompactThreshold === 'number' ? source.autoCompactThreshold : undefined,
    rows,
    model: typeof source.model === 'string' ? source.model : '',
    memoryFiles: pickList(source.memoryFiles, item =>
      typeof item.path === 'string' && typeof item.tokens === 'number'
        ? { path: item.path, tokens: item.tokens }
        : undefined,
    ),
    mcpTools: pickList(source.mcpTools, item =>
      typeof item.name === 'string' && typeof item.tokens === 'number'
        ? {
            name: item.name,
            server: typeof item.serverName === 'string' ? item.serverName : '',
            tokens: item.tokens,
          }
        : undefined,
    ),
    agents: pickList(source.agents, item =>
      typeof item.agentType === 'string' && typeof item.tokens === 'number'
        ? { type: item.agentType, tokens: item.tokens }
        : undefined,
    ),
    slashCommands: countOf(source.slashCommands, 'totalCommands', 'includedCommands'),
    skills: countOf(source.skills, 'totalSkills', 'includedSkills'),
  }
}

function pickList<T>(value: unknown, pick: (item: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const picked = pick(item as Record<string, unknown>)
    if (picked !== undefined) out.push(picked)
  }
  return out
}

function countOf(value: unknown, totalKey: string, includedKey: string) {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const total = item[totalKey]
  const included = item[includedKey]
  if (typeof total !== 'number' || typeof included !== 'number') return undefined
  return { total, included, tokens: typeof item.tokens === 'number' ? item.tokens : 0 }
}

/** 窗口来源的说明，对应原生 `/context` 的 `Auto-compact window` 一行。 */
export function windowSourceText(detail: ContextDetail): string {
  const sources: Readonly<Record<string, string>> = {
    auto: '模型自身上限',
    settings: '设置指定',
    env: '环境变量指定',
    clientdata: '账号指定',
    experiment: '实验配置',
    'model-default': '模型默认值',
    'unknown-model': '未知模型',
  }
  const source = sources[detail.source] ?? detail.source
  const compact = detail.isAutoCompactEnabled
    ? detail.autoCompactThreshold !== undefined
      ? `自动压缩于 ${tokens(detail.autoCompactThreshold)} tok`
      : '自动压缩已开'
    : '自动压缩已关'
  return `窗口 ${tokens(detail.rawMaxTokens)}（${source}） · ${compact}`
}
