/**
 * 用量概览：把本地扫描结果整形成「概览 / 模型」两页要的卡片与热力图。
 *
 * 布局参照 Claude 桌面端的用量页：一组指标卡 + 一张按天/按小时的色块图。
 * 这里不碰 `$`，只做数据整形，方便单测。
 */
import type {
  ContextPart,
  ContextPartKind,
  ContextTurn,
  LocalDay,
  LocalModel,
  LocalOverview,
  TurnDay,
} from '../types'
import { tokens, usd } from './format.ts'

/** 概览页的一张指标卡。 */
export type StatCard = {
  label: string
  value: string
  /** 值的补充说明，没有就省略。 */
  hint?: string
}

/** 把小时数写成 `5 PM` / `9 AM` / `12 PM`，与原生用量页一致。 */
export function hourLabel(hour: number | null): string {
  if (hour === null || !Number.isFinite(hour)) return '—'
  const normalized = ((Math.floor(hour) % 24) + 24) % 24
  const suffix = normalized < 12 ? 'AM' : 'PM'
  const display = normalized % 12 === 0 ? 12 : normalized % 12
  return `${display} ${suffix}`
}

/**
 * 模型名的脱敏写法：保留前三位与末尾，中间用 `*`。
 *
 * 原生用量页也这么做（`Dee**** 4 Flash`）。这里的目的不是隐藏模型身份，
 * 而是避免长 id 撑破卡片；模型全名在「模型」页里完整显示。
 */
export function maskModel(model: string | null): string {
  if (!model) return '—'
  const text = model.replace(/^claude-/, '')
  if (text.length <= 6) return text
  const head = text.slice(0, 3)
  const tail = text.slice(-4)
  const stars = '*'.repeat(Math.min(Math.max(text.length - 7, 3), 6))
  return `${head}${stars} ${tail}`
}

/** 概览页的四张卡。`windowDays` 用于标注统计范围。 */
export function overviewCards(
  overview: LocalOverview | undefined,
  days: LocalDay[],
  windowDays: number,
  totalCost: number,
): StatCard[] {
  if (!overview) {
    return [
      { label: '会话', value: '—' },
      { label: '消息', value: '—' },
      { label: '总 token', value: '—' },
      { label: '活跃天数', value: '—' },
      { label: '峰值时段', value: '—' },
      { label: '常用模型', value: '—' },
    ]
  }
  return [
    { label: '会话', value: String(overview.sessions) },
    { label: '消息', value: overview.totalMessages.toLocaleString('en-US') },
    { label: '总 token', value: tokens(overview.totalTokens) },
    { label: `活跃天数 / ${windowDays}`, value: String(overview.activeDays) },
    {
      label: '峰值时段',
      value: hourLabel(overview.peakHour),
      hint: overview.peakHourMessages > 0 ? `${tokens(overview.peakHourMessages)} 条` : undefined,
    },
    {
      label: '常用模型',
      value: maskModel(overview.favoriteModel),
      hint: overview.favoriteModelMessages > 0 ? `${tokens(overview.favoriteModelMessages)} 条` : undefined,
    },
  ]
}

/**
 * 热力图的色阶：把每天（或每小时）的量映射到 0–4 档。
 *
 * 分档用「占最大值的比例」，而不是绝对阈值——不同机器的用量差几个数量级，
 * 绝对阈值会让大多数格子落在同一档。
 */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

/** 热力图的一格。 */
export type HeatCell = {
  /** 展示用的短标签（日期 `MM-DD` 或小时 `5 PM`）。 */
  label: string
  value: number
  level: 0 | 1 | 2 | 3 | 4
}

/** 把逐日汇总折成热力图的格子。 */
export function dayHeat(days: LocalDay[]): { cells: HeatCell[]; max: number } {
  const values = days.map(day => day.input + day.output + day.cacheRead + day.cacheWrite)
  const max = values.reduce((top, value) => (value > top ? value : top), 0)
  const cells = days.map((day, index) => ({
    label: day.day.length >= 10 ? day.day.slice(5) : day.day,
    value: values[index] ?? 0,
    level: heatLevel(values[index] ?? 0, max),
  }))
  return { cells, max }
}

/**
 * 按周汇总的「日历」布局：每列一周、每行一天，和原生用量页的方块图同形。
 *
 * 返回的 `columns` 是若干列，每列 7 格（周日到周六），缺的日期留空。
 * 不足一周的尾巴补空，保证每列一样高。
 */
export function calendarHeat(days: LocalDay[]): {
  columns: Array<Array<HeatCell | null>>
  max: number
} {
  const { cells, max } = dayHeat(days)
  if (cells.length === 0) return { columns: [], max: 0 }

  const columns: Array<Array<HeatCell | null>> = []
  let column: Array<HeatCell | null> = []
  let weekday = 0

  // 第一列从第一天的星期几开始，前面补空。
  const firstDay = new Date(`${days[0]?.day ?? ''}T00:00:00`)
  if (!Number.isNaN(firstDay.getTime())) {
    weekday = firstDay.getDay()
    for (let index = 0; index < weekday; index += 1) column.push(null)
  }

  for (const cell of cells) {
    column.push(cell)
    if (column.length === 7) {
      columns.push(column)
      column = []
    }
  }
  if (column.length > 0) {
    while (column.length < 7) column.push(null)
    columns.push(column)
  }
  return { columns, max }
}

/**
 * 引擎的内部标识，不是用户眼里的「模型」：
 * `auto` 是自动选路、`<synthetic>` 是本地生成的消息、`imported-from-dsh` 等
 * 是导入来源标记。它们混进排行会把真正的模型挤下去。
 */
export function isPlaceholderModel(model: string): boolean {
  return (
    model === 'auto' ||
    model === '' ||
    model.startsWith('<') ||
    model.startsWith('imported-from')
  )
}

/** 模型页的一行。 */
export type ModelRow = {
  model: string
  tokens: number
  cost: number | null
  messages: number
  /** 相对最大值的比例，用于画条形。 */
  share: number
}

/**
 * 把逐模型汇总排成模型页的行。
 *
 * 排序按 token 总量而不是金额：第三方模型没有价格，按金额排会把它们全压在
 * 底部，看不出实际用量。
 */
export function modelRows(models: LocalModel[]): ModelRow[] {
  const withTokens = models.filter(model => !isPlaceholderModel(model.model)).map(model => ({
    model: model.model,
    tokens: model.input + model.output + model.cacheRead + model.cacheWrite,
    // 用扫描脚本给的 isPriced 判断，而不是「cost 是否大于 0」——
    // 一个官方模型如果这轮用量极少，金额可能四舍五入成 0，不该被当成未收录。
    cost: model.isPriced ? model.cost : null,
    messages: model.messages,
    share: 0,
  }))
  const max = withTokens.reduce((top, row) => (row.tokens > top ? row.tokens : top), 0)
  return withTokens
    .map(row => ({ ...row, share: max > 0 ? row.tokens / max : 0 }))
    .sort((a, b) => b.tokens - a.tokens)
}

/** 条形：`████████░░░░`，按 `share` 填充固定宽度。 */
export function barText(share: number, width = 12): string {
  const ratio = Math.max(0, Math.min(1, share))
  const filled = Math.round(ratio * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

/** 概览底部那一行总计：`共 47.3亿 tok · $12.34`。 */
export function overviewFooter(overview: LocalOverview | undefined, totalCost: number): string {
  if (!overview) return '还没有统计数据'
  return `共 ${tokens(overview.totalTokens)} tok · ${usd(totalCost)}`
}

// ---------------- 上下文构成 ----------------

/**
 * 把引擎给的行名归一成稳定键。
 *
 * 引擎只给行名和主题色。主题色在深浅色主题下语义不同、随版本可能变，
 * 而行名是 `/context` 一直打印的那几个；所以按行名归一，配色才跨轮跨主题稳定。
 * 认不出的归 `other`，不丢，只是同色。
 */
export function contextPartKind(name: string): ContextPartKind {
  const text = name.trim().toLowerCase()
  if (text.startsWith('system prompt') || text === 'system') return 'system'
  if (text.startsWith('system tool') || text === 'tools') return 'tools'
  if (text.startsWith('memory file')) return 'memory'
  if (text.startsWith('mcp tool')) return 'mcp'
  if (text.startsWith('custom agent') || text === 'agents') return 'agents'
  if (text.startsWith('message')) return 'messages'
  return 'other'
}

/**
 * 从一轮的 breakdown 里取「已用」构成。
 *
 * 只保留 `kind === 'used'` 的行：`free` 是剩余空间、`buffer` 是压缩预留、
 * `deferred` 在窗口之外，三者都不是「窗口被什么占着」的答案，画进构成会把
 * 柱子的语义搅乱。返回的 token 之和可能略小于 `totalTokens`（引擎的取整），
 * 差值在画图时补给最后一类，不让柱子出现缝隙。
 *
 * @param rows 引擎 breakdown 的 `categories`
 */
export function contextParts(rows: ReadonlyArray<{ name: string; tokens: number; kind: string }>): ContextPart[] {
  // 同一个 kind 可能由多行合并而来（例如多个记忆文件各占一行），
  // 行名保留最先遇到的那个，只为展示，聚合与配色都看 kind。
  const merged = new Map<ContextPartKind, ContextPart>()
  for (const row of rows) {
    if (row.kind !== 'used') continue
    if (!Number.isFinite(row.tokens) || row.tokens <= 0) continue
    const kind = contextPartKind(row.name)
    const prev = merged.get(kind)
    merged.set(kind, { name: prev?.name ?? row.name, kind, tokens: (prev?.tokens ?? 0) + row.tokens })
  }
  return [...merged.values()].sort((a, b) => b.tokens - a.tokens)
}

/** 分类的展示名与配色键，面板与图例共用一份。 */
export const CONTEXT_PART_LABELS: ReadonlyArray<{
  kind: ContextPartKind
  label: string
  color: string
}> = [
  { kind: 'system', label: '系统提示', color: 'promptBorder' },
  { kind: 'tools', label: '工具定义', color: 'suggestion' },
  { kind: 'memory', label: '记忆文件', color: 'remember' },
  { kind: 'mcp', label: 'MCP 工具', color: 'ide' },
  { kind: 'agents', label: '自定义 agent', color: 'permission' },
  { kind: 'messages', label: '对话消息', color: 'claude' },
  { kind: 'other', label: '其他', color: 'subtle' },
]

/** 分类的展示名；未列出的键原样返回。 */
export function contextPartLabel(kind: ContextPartKind): string {
  return CONTEXT_PART_LABELS.find(item => item.kind === kind)?.label ?? kind
}

/** 分类的配色键；未知键用最淡的那档。 */
export function contextPartColor(kind: ContextPartKind): string {
  return CONTEXT_PART_LABELS.find(item => item.kind === kind)?.color ?? 'subtle'
}

// ---------------- 堆叠柱状图 ----------------

/** 堆叠柱的一层：某一段的高度与配色键。 */
export type StackSegment = {
  /** 占比，用于画该段占几行。 */
  ratio: number
  /**
   * 该段属于哪一类，决定颜色。
   *
   * 前三个是窗口的三段骨架（已用 / 压缩缓冲 / 空闲）；有构成数据时，
   * 「已用」再按内容类别细分，键直接是 `ContextPartKind`。
   */
  kind: 'used' | 'buffer' | 'free' | ContextPartKind
}

/** 一根柱子：按轮次排列，堆叠出上下文窗口的构成。 */
export type StackBar = {
  /** 横轴标签（轮次序号或日期）。 */
  label: string
  /** 从下往上的层：已用 → 压缩缓冲 → 空闲。 */
  segments: StackSegment[]
  /** 这一轮的总占比（0–100），标注在柱顶。 */
  percent: number
  /** 已用 token 数，供提示与排序。 */
  tokens: number
  /** 这一轮是否有分类构成；没有时柱子退回单色「已用」。 */
  hasParts: boolean
}

/**
 * 把逐轮上下文占比折成堆叠柱。
 *
 * 每一根柱子代表一轮：柱高固定为窗口的 100%，内部按「已用 / 压缩缓冲 / 空闲」
 * 分段堆叠。这样一眼能看出两件事：柱子左侧的已用段有多高（上下文占比），
 * 以及占比随轮次的走势。
 *
 * 有构成数据（`turn.parts`）时，「已用」那一段再按内容类别细分——这正是
 * dsh-context 的核心读法：不只看到窗口满了多少，还看到被什么占满。
 * 缺构成的老记录退回单色，两种柱子可以画在同一张图里。
 *
 * @param turns      逐轮记录，按时间升序
 * @param maxBars    最多画几根（从最新的往回取）
 * @param bufferPct  压缩缓冲占窗口的百分比；未知时为 0
 */
export function contextStack(
  turns: ContextTurn[],
  maxBars = 24,
  bufferPct = 0,
): { bars: StackBar[]; peak: number } {
  const recent = turns.slice(-Math.max(1, maxBars))
  const clamped = (value: number) => Math.max(0, Math.min(100, value))

  const bars = recent.map(turn => {
    const used = clamped(turn.percent)
    const buffer = clamped(bufferPct)
    // 已用与缓冲不能相加超过 100%，否则柱子在视觉上会溢出。
    const shownBuffer = Math.min(buffer, Math.max(0, 100 - used))
    const free = Math.max(0, 100 - used - shownBuffer)

    const segments: StackSegment[] = []
    const parts = turn.parts?.filter(part => part.tokens > 0) ?? []
    if (parts.length === 0) {
      segments.push({ ratio: used / 100, kind: 'used' })
    } else {
      // 用 token 占比而不是「percent 平均分」：一次请求里系统提示几十 k、
      // 对话消息几百 k，平均分会把它们画成一样宽，正好抹掉要看的差别。
      const partTotal = parts.reduce((sum, part) => sum + part.tokens, 0)
      if (partTotal > 0) {
        for (const part of parts) {
          segments.push({ ratio: (part.tokens / partTotal) * (used / 100), kind: part.kind })
        }
      } else {
        segments.push({ ratio: used / 100, kind: 'used' })
      }
    }
    if (shownBuffer > 0) segments.push({ ratio: shownBuffer / 100, kind: 'buffer' })
    if (free > 0) segments.push({ ratio: free / 100, kind: 'free' })

    return {
      label: String(turn.seq),
      segments: segments.filter(segment => segment.ratio > 0),
      percent: used,
      tokens: turn.tokens,
      hasParts: parts.length > 0,
    }
  })

  const peak = bars.reduce((top, bar) => (bar.percent > top ? bar.percent : top), 0)
  return { bars, peak }
}

/**
 * 把柱子光栅化成字符网格：`rows` 行高、每根柱子 `width` 格宽。
 *
 * 返回 `cells[row][bar][col]` 的分段类型（或 `null` 表示空格）。
 * 从下往上填，同一根柱子里分段按顺序堆叠。
 */
export function rasterizeStacks(
  bars: StackBar[],
  rows: number,
  width = 1,
): Array<Array<Array<StackSegment['kind'] | null>>> {
  const grid: Array<Array<Array<StackSegment['kind'] | null>>> = []
  for (let row = 0; row < rows; row += 1) {
    grid.push(bars.map(() => new Array<StackSegment['kind'] | null>(width).fill(null)))
  }

  bars.forEach((bar, barIndex) => {
    let cursor = rows
    for (const segment of bar.segments) {
      const height = Math.round(segment.ratio * rows)
      const from = Math.max(0, cursor - height)
      for (let row = from; row < cursor; row += 1) {
        for (let col = 0; col < width; col += 1) {
          const line = grid[row]
          if (line) line[barIndex]![col] = segment.kind
        }
      }
      cursor = from
    }
  })
  return grid
}

/**
 * 堆叠柱的配色。
 *
 * 窗口的三段骨架与内容分类共用这一个入口：`used` 是没有构成数据时的单色，
 * 内容分类则各有一色（与图例同源）。这样字符版与矢量版拿到的颜色一致。
 */
export function stackColor(kind: StackSegment['kind'] | null): string | undefined {
  if (kind === null) return undefined
  if (kind === 'used') return 'claude'
  if (kind === 'buffer') return 'subtle'
  if (kind === 'free') return 'inactive'
  return contextPartColor(kind)
}

/** 堆叠柱图的说明文字：`最近 24 轮 · 峰值 42%`。 */
export function stackCaption(barCount: number, peak: number): string {
  if (barCount === 0) return '还没有逐轮数据（跑一轮对话后出现）'
  return `最近 ${barCount} 轮 · 峰值 ${Math.round(peak)}%`
}

/** 图例的一项。 */
export type StackLegendItem = {
  kind: StackSegment['kind']
  label: string
  color: string
}

/**
 * 按这一屏实际出现过的分段生成图例。
 *
 * 不画固定的三色图例：有构成数据时柱子里会出现六七种颜色，固定图例解释不了它们；
 * 反过来只有老记录时列一堆分类名又是噪音。所以图例跟着数据走，但**顺序固定**
 * （按 `CONTEXT_PART_LABELS` 的次序，再补缓冲与空闲），翻页时颜色与位置的对应不跳。
 */
export function stackLegendOf(bars: StackBar[]): StackLegendItem[] {
  const present = new Set<StackSegment['kind']>()
  for (const bar of bars) {
    for (const segment of bar.segments) present.add(segment.kind)
  }

  const items: StackLegendItem[] = []
  // 老记录没有分类构成，用单色「已用」画；它和新记录的分类柱可以同屏，
  // 所以图例里允许两者并存。
  if (present.has('used')) items.push({ kind: 'used', label: '已用（无构成）', color: 'claude' })
  for (const part of CONTEXT_PART_LABELS) {
    // `other` 是兜底键，没出现就不列；其余分类同理，出现才列。
    if (!present.has(part.kind)) continue
    items.push({ kind: part.kind, label: part.label, color: part.color })
  }
  if (present.has('buffer')) items.push({ kind: 'buffer', label: '压缩缓冲', color: 'subtle' })
  if (present.has('free')) items.push({ kind: 'free', label: '空闲', color: 'inactive' })
  return items
}

// ---------------- 轮次历史（GitHub 式柱状图） ----------------

/** 一根按天的轮次柱。 */
export type TurnBar = {
  day: string
  turns: number
  /** 占最大值的比例，用于画柱高。 */
  ratio: number
}

/**
 * 把逐日轮次折成柱状图，对应 GitHub 贡献图那一排「每天一根柱」的读法。
 *
 * 与贡献图的区别：这里用**柱高**表示轮次（贡献图用色块深浅），因为高度差
 * 比深浅更容易一眼看出起伏。
 *
 * 缺的日子补 0，保证柱子的横向间距均匀——否则跳过的空档会让时间轴变形。
 *
 * @param days       逐日轮次
 * @param windowDays 一共要看多少天；不足的向前补 0
 * @param endDay     右端是哪一天（`YYYY-MM-DD`）；省略时取最后一条记录所在日
 */
export function turnBars(days: TurnDay[], windowDays: number, endDay?: string): TurnBar[] {
  if (windowDays <= 0) return []
  const byDay = new Map(days.map(item => [item.day, item.turns]))

  // 右端：显式指定 > 最后一次记录所在日 > 系统今天。
  const anchor = endDay ?? (days.length > 0 ? days[days.length - 1]!.day : localDayKey(new Date()))
  const anchorDate = new Date(`${anchor}T00:00:00`)
  const bars: TurnBar[] = []
  if (Number.isNaN(anchorDate.getTime())) return []

  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(anchorDate)
    date.setDate(date.getDate() - offset)
    const key = localDayKey(date)
    bars.push({ day: key, turns: byDay.get(key) ?? 0, ratio: 0 })
  }

  const max = bars.reduce((top, bar) => (bar.turns > top ? bar.turns : top), 0)
  return bars.map(bar => ({ ...bar, ratio: max > 0 ? bar.turns / max : 0 }))
}

/**
 * 把轮次历史按「天」切成页，而不是按记录条数：`turnsDaily` 只含有轮次的日子，
 * 按条数切会让每页覆盖的天数忽长忽短，柱子宽窄跳动。
 *
 * `offset` 是往左（历史）翻了几页，0 表示最右边、贴住最新一天。
 */
export function turnPages(
  days: TurnDay[],
  windowDays: number,
  offset: number,
): { endDay: string; maxOffset: number; page: number; pages: number } {
  const size = Math.max(1, Math.floor(windowDays))
  const today = localDayKey(new Date())
  if (days.length === 0) {
    return { endDay: today, maxOffset: 0, page: 1, pages: 1 }
  }

  const latest = days[days.length - 1]!.day
  const earliest = days[0]!.day
  const span = dayGap(earliest, latest) + 1
  const pages = Math.max(1, Math.ceil(span / size))
  const clamped = Math.max(0, Math.min(Math.floor(offset), pages - 1))
  return {
    endDay: shiftDay(latest, -clamped * size),
    maxOffset: pages - 1,
    page: pages - clamped,
    pages,
  }
}

/** 两个 `YYYY-MM-DD` 相差几天；日期非法时返回 0。 */
function dayGap(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/** 把 `YYYY-MM-DD` 往前（负数）或往后挪几天。 */
function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return day
  date.setDate(date.getDate() + delta)
  return localDayKey(date)
}

/** 本地时区的 `YYYY-MM-DD`，与扫描脚本的切天口径一致。 */
function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 把轮次柱光栅化成字符网格，`rows` 行高。
 *
 * 每根柱子占一列；柱高按 `ratio` 四舍五入——轮次为 0 的日子也画一格底部，
 * 这样时间轴不断档，和 GitHub 贡献图里「当天没贡献仍占一格」的做法一致。
 */
export function rasterizeTurnBars(
  bars: TurnBar[],
  rows: number,
): Array<Array<'bar' | 'empty'>> {
  const grid: Array<Array<'bar' | 'empty'>> = []
  for (let row = 0; row < rows; row += 1) {
    grid.push(bars.map(() => 'empty' as const))
  }
  bars.forEach((bar, index) => {
    const height = bar.turns <= 0 ? 1 : Math.max(1, Math.round(bar.ratio * rows))
    const from = Math.max(0, rows - height)
    for (let row = from; row < rows; row += 1) {
      grid[row]![index] = 'bar'
    }
  })
  return grid
}

/** 轮次柱的历史范围说明：`最近 30 天 · 峰值 684 轮`。 */
export function turnBarsCaption(bars: TurnBar[]): string {
  if (bars.length === 0) return '还没有轮次数据'
  const max = bars.reduce((top, bar) => (bar.turns > top ? bar.turns : top), 0)
  const total = bars.reduce((sum, bar) => sum + bar.turns, 0)
  return `最近 ${bars.length} 天 · ${total} 轮 · 峰值 ${max} 轮`
}
