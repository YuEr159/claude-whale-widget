/**
 * 面板「详细」视图：把 Claude 原生 `/usage` 与 `/context` 的字段整理成界面
 * 要的行。纯计算，不碰 `$`，方便单测。
 *
 * 对应关系（与引擎文案一致）：
 *   /usage    额度窗口 Current session / Current week、会话总花费、会话时长、
 *             代码增删行数、Usage by model
 *   /context  上下文窗口的网格与逐项明细（系统提示、消息、工具、记忆文件……）
 *
 * 拿不到的两项，界面上如实写明，不拿别的数硬凑：
 *   `Total duration (API)` —— 引擎只给每轮的墙钟时长；
 *   子代理的消耗 —— 只在它自己的 `turn.complete` 里，主线程不汇总。
 */
import type { Prefs } from '../types'
import { pct, tokens, usd } from './format.ts'

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
 * `lines` 里以 `+` / `-` 开头的是正文，`+++` / `---` 是文件头，要排除。
 * 只返回两个数字，不保留任何行内容——这是隐私边界。
 */
export function countPatchLines(
  patches: ReadonlyArray<{ lines: readonly string[] }>,
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const patch of patches) {
    for (const line of patch.lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
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
  /** 按官方价格估算；未收录模型为 null。 */
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

/** `Usage by model` 的一行：`opus-5-5 · 12.3万 tok · $1.20 · 8 轮`。 */
export function modelLine(spend: ModelSpend): string {
  const total = spend.input + spend.output + spend.cacheRead + spend.cacheWrite
  const money = spend.cost === null ? '未收录模型' : usd(spend.cost)
  return `${spend.model.replace('claude-', '')} · ${tokens(total)} tok · ${money} · ${spend.turns} 轮`
}

/** 按花费降序，未收录价格的排最后（金额不可比）。 */
export function sortModelSpends(list: ModelSpend[]): ModelSpend[] {
  return [...list].sort((a, b) => {
    if (a.cost === null && b.cost === null) return b.turns - a.turns
    if (a.cost === null) return 1
    if (b.cost === null) return -1
    return b.cost - a.cost
  })
}

/** 有未收录价格的模型时给一句说明，避免把 0 当真实花费。 */
export function unpricedNote(list: ModelSpend[]): string | undefined {
  const unpriced = list.filter(item => item.cost === null)
  if (unpriced.length === 0) return undefined
  const names = unpriced.map(item => item.model.replace('claude-', '')).join('、')
  return `未收录价格的模型：${names}（token 已计入，金额未计）`
}

// ---------------- /context：分项 ----------------

export type ContextRowKind = 'used' | 'free' | 'buffer' | 'deferred'

/** 上下文分项的一行。 */
export type ContextRow = {
  name: string
  tokens: number
  kind: ContextRowKind
  /** 占窗口的百分比；`deferred` 行在窗口之外，没有意义。 */
  sharePercent: number
  /** 引擎给的主题色键；空串表示没给，由界面按 kind 兜底。 */
  color: string
}

/** 网格里的一格：分项名与引擎给的主题色。 */
export type GridCell = {
  name: string
  color: string
  isFilled: boolean
}

/** 面板「上下文明细」一节的输入，字段与引擎 breakdown 同名。 */
export type ContextDetail = {
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  /** 窗口上限的来源，`auto` 表示模型自身上限。 */
  source: string
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  rows: ContextRow[]
  model: string
  /** 网格，行优先；空数组表示引擎没给。 */
  grid: GridCell[][]
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
    const row = item as { name?: unknown; tokens?: unknown; kind?: unknown; color?: unknown }
    if (typeof row.name !== 'string' || typeof row.tokens !== 'number') continue
    const kind: ContextRowKind =
      row.kind === 'free' || row.kind === 'buffer' || row.kind === 'deferred' ? row.kind : 'used'
    rows.push({
      name: row.name,
      tokens: row.tokens,
      kind,
      sharePercent: windowTokens > 0 ? (row.tokens / windowTokens) * 100 : 0,
      color: typeof row.color === 'string' ? row.color : '',
    })
  }

  const grid = toGrid(source.gridRows)

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
    grid,
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

/** 引擎给的网格：每格保留分项名与颜色，未填充的也保留（画淡色格）。 */
function toGrid(value: unknown): GridCell[][] {
  if (!Array.isArray(value)) return []
  const out: GridCell[][] = []
  for (const line of value) {
    if (!Array.isArray(line)) continue
    const cells: GridCell[] = []
    for (const cell of line) {
      if (!cell || typeof cell !== 'object') continue
      const item = cell as { categoryName?: unknown; color?: unknown; isFilled?: unknown }
      cells.push({
        name: typeof item.categoryName === 'string' ? item.categoryName : '',
        color: typeof item.color === 'string' ? item.color : '',
        isFilled: item.isFilled === true,
      })
    }
    if (cells.length > 0) out.push(cells)
  }
  return out
}

/** 顶栏一句话：`上下文 42% · 42.1万/100万 tok`。 */
export function contextHeadline(detail: ContextDetail): string {
  return `上下文 ${pct(detail.percentage)} · ${tokens(detail.totalTokens)}/${tokens(detail.rawMaxTokens)} tok`
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

/** 一行分项的展示文字：`Messages 42.1万 tok (42%)`。 */
export function contextRowText(row: ContextRow): string {
  if (row.kind === 'free') return `${row.name} ${tokens(row.tokens)} tok`
  if (row.kind === 'deferred') return `${row.name} ${tokens(row.tokens)} tok（窗口外）`
  return `${row.name} ${tokens(row.tokens)} tok (${Math.round(row.sharePercent)}%)`
}

/** 按 kind 找名字，供网格着色时查表。 */
export function kindOfName(detail: ContextDetail): ReadonlyMap<string, ContextRowKind> {
  const map = new Map<string, ContextRowKind>()
  for (const row of detail.rows) map.set(row.name, row.kind)
  return map
}

/** 面板详细程度。 */
export type PanelDetail = 'simple' | 'detail'

/** 面板里「详细程度」的选项。 */
export const PANEL_DETAIL_OPTIONS: ReadonlyArray<{ value: PanelDetail; label: string }> = [
  { value: 'detail', label: '详细' },
  { value: 'simple', label: '简洁' },
]

/** 默认详细，贴近原生面板。 */
export const DEFAULT_PANEL_DETAIL: PanelDetail = 'detail'

/** 老状态里没有这个字段时按默认值读。 */
export function detailOf(prefs: Partial<Prefs>): PanelDetail {
  return prefs.panelDetail === 'simple' ? 'simple' : DEFAULT_PANEL_DETAIL
}
