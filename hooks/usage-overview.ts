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
  ModelDay,
  ModelDayCell,
  TurnDay,
} from '../types'
import { tokens } from './format.ts'
import { usdEstimate } from './provenance.ts'

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
 * 模型名在卡片里的写法。
 *
 * 原生用量页会把中间几位打成 `*`（`Dee**** 4 Flash`），这里不跟：数据来自
 * 本机日志，没有任何要藏的东西，打码只会让人认不出是哪个模型、还把「这是
 * 匿名数据」的意思误传给读者。名字太长撑破卡片时才截断，并且是截断而不是
 * 打码——读者至少知道它被截了。
 */
export function maskModel(model: string | null): string {
  if (!model) return '—'
  const text = model.replace(/^claude-/, '')
  return text.length > 18 ? `${text.slice(0, 17)}…` : text
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

// ---------------- 模型页：逐日堆叠柱 ----------------

/** 模型页柱状图里最多分几段；超出部分并成「其他」。 */
export const MODEL_STACK_KEEP = 6

/**
 * 模型页的粒度：一根柱子代表一天，还是一周。
 *
 * 为什么需要它：柱子数受画布宽度限制。900px 画布下 365 根柱子每根只有
 * 2.4px，连柱内各段都分不开，整张图会糊成一片。范围一拉长，粒度就得跟着
 * 变粗——这是同一件事的两种画法，不是两张不同的图。
 *
 * 阈值对应四档范围：
 *   30 天 → 按天（30 根，每根 28.8px）
 *   60 天 → 按天（60 根，每根 14.4px）
 *  180 天 → 按周（26 根，每根 33.2px）
 *  365 天 → 按周（52 根，每根 16.6px）
 *
 * 365 天不按月：52 根每周柱子仍比 60 天那档（14.4px）宽，信息量却是按月
 * 的 4 倍多——按月只剩 12 根，「这个月哪一周花得多」就看不出来了。只有
 * 窗口长到一年以上，周柱子才会挤到不可用。
 */
export type ModelGrain = 'day' | 'week'

/** 给定范围天数，该用哪种粒度。 */
export function modelGrainFor(days: number): ModelGrain {
  return days <= 60 ? 'day' : 'week'
}

/** 粒度的中文名，图注与控件共用。 */
export function modelGrainLabel(grain: ModelGrain): string {
  return grain === 'day' ? '按天' : '按周'
}

/**
 * 某一天属于哪个桶，返回桶里最早那天的 `YYYY-MM-DD`。
 *
 * 以周一为一周之始：周日属于**上一**周。用周日当起始日的话，跨年时会出现
 * 跨两个年份、只有一两天的「周」，柱子的高度会莫名其妙地矮一截。
 */
function bucketKeyOf(date: Date, grain: ModelGrain): string {
  if (grain === 'day') return localDayKey(date)
  const start = new Date(date)
  const weekday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - weekday)
  return localDayKey(start)
}

/** 柱内的一段：某个模型在当天占的 token。 */
export type ModelStackSegment = {
  model: string
  /** 这一段 token 占当天总 token 的比例（0–1）。 */
  ratio: number
  tokens: number
}

/** 一根按天的模型柱。 */
export type ModelStackBar = {
  day: string
  segments: ModelStackSegment[]
  /** 当天总 token。 */
  total: number
}

/**
 * 把逐日逐模型用量折成堆叠柱。
 *
 * 段序按**窗口内的总量**降序固定下来，不按天各自排序：同一天的柱子之间要能
 * 横向比颜色，颜色与模型的对应就必须跨天稳定。超出 `keep` 段的模型并成
 * 「其他」，避免柱子被十几个小段切成看不清的碎片。
 *
 * 模型名先经 `canonicalModelName` 归并：`deepseek-flash` 与 `DeepSeek-Flash`
 * 是同一款，分开画会让图例出现两个看起来一样的名字。
 *
 * @param days   逐日逐模型用量
 * @param windowDays 一共看多少天；缺的日子补 0
 * @param keep   最多保留几个模型，其余并入「其他」
 */
export function modelStackBars(
  days: ModelDay[],
  windowDays: number,
  keep = MODEL_STACK_KEEP,
  grain: ModelGrain = 'day',
): { bars: ModelStackBar[]; models: string[]; peak: number; yMax: number } {
  if (windowDays <= 0) return { bars: [], models: [], peak: 0, yMax: 0 }

  // 归并后再按天聚合：同一天里同一款模型可能有两三个写法。
  const byDay = new Map<string, Map<string, number>>()
  for (const item of days) {
    let perModel = byDay.get(item.day)
    if (!perModel) {
      perModel = new Map()
      byDay.set(item.day, perModel)
    }
    for (const cell of item.models) {
      const tokens = Math.max(0, cell.input) + Math.max(0, cell.output)
      if (tokens <= 0) continue
      const name = canonicalModelName(cell.model)
      perModel.set(name, (perModel.get(name) ?? 0) + tokens)
    }
  }

  const anchor = days.length > 0 ? days[days.length - 1]!.day : localDayKey(new Date())
  const anchorDate = new Date(`${anchor}T00:00:00`)
  if (Number.isNaN(anchorDate.getTime())) return { bars: [], models: [], peak: 0, yMax: 0 }

  // 按粒度分桶：桶键取这一天 / 这一周 / 这一个月里**最早的一天**，图注与
  // tooltip 都按它显示。桶内的各模型 token 直接相加——柱高是「这段时间
  // 一共用了多少」，不是日均值：读者问的是「这一周花了多少」，而日均会把
  // 「这周用了七天」和「这周只用了一天」画成一样高。
  const ordered: Array<{ day: string; cells: Map<string, number> }> = []
  const buckets = new Map<string, Map<string, number>>()
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(anchorDate)
    date.setDate(date.getDate() - offset)
    const key = bucketKeyOf(date, grain)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = new Map()
      buckets.set(key, bucket)
    }
    const dayCells = byDay.get(localDayKey(date))
    if (!dayCells) continue
    for (const [model, value] of dayCells) {
      bucket.set(model, (bucket.get(model) ?? 0) + value)
    }
  }
  // Map 保留插入顺序，而上面是按时间从早到晚插的，所以桶天然有序。
  for (const [key, cells] of buckets) ordered.push({ day: key, cells })

  // 窗口内的模型总量决定段序与去留。
  const totals = new Map<string, number>()
  for (const { cells } of ordered) {
    for (const [model, value] of cells) {
      totals.set(model, (totals.get(model) ?? 0) + value)
    }
  }
  const models = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, keep))
    .map(([model]) => model)
  const kept = new Set(models)

  const bars: ModelStackBar[] = ordered.map(({ day, cells }) => {
    let other = 0
    for (const [model, value] of cells) {
      if (!kept.has(model)) other += value
    }
    const total = [...cells.values()].reduce((sum, value) => sum + value, 0)
    const segments: ModelStackSegment[] = []
    for (const model of models) {
      const value = cells.get(model) ?? 0
      if (value > 0) segments.push({ model, tokens: value, ratio: total > 0 ? value / total : 0 })
    }
    if (other > 0) {
      segments.push({ model: '其他', tokens: other, ratio: total > 0 ? other / total : 0 })
    }
    return { day, segments, total }
  })

  const peak = bars.reduce((top, bar) => Math.max(top, bar.total), 0)
  // 纵轴自适应，与上下文柱同一口径：峰值 1.1 倍向上取整到 5 的倍数。
  const raw = peak * 1.1
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))))
  const yMax = Math.max(magnitude, Math.ceil(raw / (magnitude / 2)) * (magnitude / 2))
  return { bars, models: [...models, ...(bars.some(bar => bar.segments.some(s => s.model === '其他')) ? ['其他'] : [])], peak, yMax }
}

/**
 * 模型柱的图注：`按周 · 最近 26 周 · 共 1.2亿 tok · 峰值 3.4千万 tok`。
 *
 * 粒度必须写在图注里：同样 26 根柱子，「按天 26 天」和「按周 26 周」
 * 说的是差了七倍的时间跨度，不写清楚读者会把半年的图当成一个月的。
 */
export function modelStackCaption(bars: ModelStackBar[], grain: ModelGrain = 'day'): string {
  if (bars.length === 0) return '还没有逐模型数据'
  const total = bars.reduce((sum, bar) => sum + bar.total, 0)
  const peak = bars.reduce((top, bar) => Math.max(top, bar.total), 0)
  const unit = grain === 'day' ? '天' : '周'
  return `${modelGrainLabel(grain)} · 最近 ${bars.length} ${unit} · 共 ${tokens(total)} tok · 峰值 ${tokens(peak)} tok`
}

/**
 * 把同一款模型的几种写法归成一个展示名。
 *
 * 网关会给同一个模型换着写法记：`deepseek-flash`、`DeepSeek-Flash`、
 * `deepseek-v4-flash`、`deepseek-v4-1-flash` 其实都是 Flash，拆成四行只会让
 * 读者以为是四个不同的模型。归并按「厂商 + 档位」两级：先认出厂商，再认出
 * 档位（flash / pro / max …），都认不出就保留原名。
 *
 * 返回的名字同时用作聚合键，所以必须稳定：同一种写法永远得到同一个名字。
 */
export function canonicalModelName(model: string): string {
  const id = model.trim().toLowerCase()
  if (id.length === 0) return model
  // DeepSeek：型号中间的版本号（v4 / v4.1 / v3）对「哪一档」没有影响，去掉。
  if (/deepseek/.test(id)) {
    if (/flash/.test(id)) return 'DeepSeek Flash'
    if (/\bpro\b|v4-pro/.test(id)) return 'DeepSeek Pro'
    return 'DeepSeek'
  }
  if (/^glm|zhipu/.test(id)) {
    if (/flash/.test(id)) return 'GLM Flash'
    return 'GLM'
  }
  if (/^kimi|moonshot/.test(id)) return 'Kimi'
  if (/^qwen|tongyi/.test(id)) {
    // qwen3.8-27b 这种带参数量的写法：参数量是同一档的不同尺寸，保留，
    // 但把前缀规整成统一大小写，免得 Qwen / qwen 分成两行。
    const size = /(\d+b)\b/.exec(id)?.[1]
    return size ? `Qwen ${size.toUpperCase()}` : 'Qwen'
  }
  return model
}

/** 模型页下方的一行：模型名、输入 / 输出 token、金额。 */
export type ModelDetailRow = {
  model: string
  /** 输入 token，含缓存读写。 */
  input: number
  /** 输出 token。 */
  output: number
  /** 估算美元；`null` 表示这一款里没有任何一个有公开价格。 */
  cost: number | null
  /** 归并进来的原始写法，用于提示这一行代表哪几个 id。 */
  aliases: string[]
  messages: number
}

/**
 * 模型页下方的明细行。
 *
 * 先把同一款模型的几种写法归并（见 `canonicalModelName`），再逐行给出
 * 输入 / 输出与金额。归并后金额是把各写法的估算值相加——每个写法各按自己的
 * 价格表算过，所以相加不会串味；全都没价才记 `null`。
 *
 * 输入口径与柱子的 `input` 一致（含缓存读写），这样柱子的段高与这一行的
 * 数字能对上；分开写「缓存」会让读者在两套口径之间换算。
 */
export function modelDetailRows(models: LocalModel[]): ModelDetailRow[] {
  const merged = new Map<string, ModelDetailRow>()
  for (const entry of models) {
    if (isPlaceholderModel(entry.model)) continue
    const name = canonicalModelName(entry.model)
    let row = merged.get(name)
    if (!row) {
      row = { model: name, input: 0, output: 0, cost: null, aliases: [], messages: 0 }
      merged.set(name, row)
    }
    row.input += entry.input + entry.cacheRead + entry.cacheWrite
    row.output += entry.output
    row.messages += entry.messages
    if (entry.isPriced) row.cost = (row.cost ?? 0) + entry.cost
    if (!row.aliases.includes(entry.model)) row.aliases.push(entry.model)
  }
  return [...merged.values()]
    // 有价格但这一款其实没用过（0 输入 0 输出）：金额算出来是 $0，画上去
    // 会让人以为「免费」，其实是「没有数据」。这种情况按未收录处理。
    .map(row => (row.cost !== null && row.input + row.output === 0 ? { ...row, cost: null } : row))
    .sort((a, b) => b.input + b.output - (a.input + a.output))
}

/** 概览底部那一行总计：`共 47.3亿 tok · $12.34`。 */
export function overviewFooter(overview: LocalOverview | undefined, totalCost: number): string {
  if (!overview) return '还没有统计数据'
  return `共 ${tokens(overview.totalTokens)} tok · ${usdEstimate(totalCost)}`
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
/**
 * 上下文各分类的显示名与配色。
 *
 * **配色以 DeepSeek 品牌蓝（#4D6BFE）为核心的冷色阶**，六个分类沿色相环
 * 铺开、明度也各差一档，相邻两类不会糊在一起。全部落在蓝–青–紫一段，
 * 没有黄橙红，因此与 Claude 品牌色（暖橙）形成冷暖对比，放在 Claude 的
 * 面板里不串色。
 *
 * 这里给的是**十六进制而不是主题键**。主题键（如 `'claude'`）会跟随用户
 * 主题解析成橙色之类的暖色，那正好和「冷色 + 与 Claude 色对比」的目标相反；
 * 而且同一张图在桌面端（SVG，十六进制）与终端（主题键）会读出不同含义。
 * 两边共用这一套固定色值，跨表面、跨主题都一致。
 *
 * 与 `chart-art.ts` 的 `PART_COLORS` 必须逐项相同。
 */
export const CONTEXT_PART_LABELS: ReadonlyArray<{
  kind: ContextPartKind
  label: string
  /** 深色主题下的颜色。 */
  dark: string
  /** 浅色主题下的颜色；同一色相，明度压低。 */
  light: string
}> = [
  { kind: 'system', label: '系统提示', dark: '#A78BFA', light: '#7C4DDB' },
  { kind: 'tools', label: '工具定义', dark: '#22C3D6', light: '#0E7C8A' },
  { kind: 'memory', label: '记忆文件', dark: '#7AA2F7', light: '#3468C0' },
  { kind: 'mcp', label: 'MCP 工具', dark: '#C084FC', light: '#9333EA' },
  { kind: 'agents', label: '自定义 agent', dark: '#1E6F8C', light: '#1E6F8C' },
  { kind: 'messages', label: '对话消息', dark: '#4D6BFE', light: '#3B54D6' },
  { kind: 'other', label: '其他', dark: '#7C8394', light: '#6E7486' },
]

/** 分类的展示名；未列出的键原样返回。 */
export function contextPartLabel(kind: ContextPartKind): string {
  return CONTEXT_PART_LABELS.find(item => item.kind === kind)?.label ?? kind
}

/** 分类的配色；未知键用最淡的那档。`isLight` 决定取深色还是浅色那支。 */
export function contextPartColor(kind: ContextPartKind, isLight = false): string {
  const item = CONTEXT_PART_LABELS.find(entry => entry.kind === kind)
  if (!item) return 'subtle'
  return isLight ? item.light : item.dark
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
  /** 这一轮之前刚发生过压缩：图上要在它左缘竖一条虚线。 */
  isAfterCompact: boolean
}

/**
 * 把逐轮上下文占比折成堆叠柱。
 *
 * 有构成数据（`turn.parts`）时，「已用」那一段再按内容类别细分——这正是
 * dsh-context 的核心读法：不只看到窗口满了多少，还看到被什么占满。
 * 缺构成的老记录退回单色，两种柱子可以画在同一张图里。
 *
 * **纵轴自适应**：默认不再把每根柱子撑到窗口的 100%。那样做时每根柱子一样高，
 * 真正想看的差别只剩柱内一小截，而下方一大片是「空闲」——既浪费画布，又要靠
 * 颜色去分辨「没用到」。改成按这一屏的峰值定纵轴后，高柱就是用量大，
 * 矮柱就是用量小，空出来的地方本身就在表达「还有余量」。
 *
 * 因此自适应模式下**不再输出 `free` 段**：它在旧几何里扮演「把柱子补满到
 * 100%」的角色，自适应后这个角色由空白承担，再画会把柱子又撑回去。
 *
 * @param turns      逐轮记录，按时间升序
 * @param maxBars    最多画几根（从最新的往回取）
 * @param bufferPct  压缩缓冲占窗口的百分比；未知时为 0
 * @param options    `yMax`：纵轴上限，`'auto'` 按峰值算（默认）；给数字则用它，
 *                   给 100 即旧行为（柱子撑满窗口，含空闲段）
 */
export function contextStack(
  turns: ContextTurn[],
  maxBars = 24,
  bufferPct = 0,
  options: { yMax?: number | 'auto' } = {},
): { bars: StackBar[]; peak: number; yMax: number } {
  const recent = turns.slice(-Math.max(1, maxBars))
  const clamped = (value: number) => Math.max(0, Math.min(100, value))

  // 先算出每轮「已用 + 缓冲」的合计，用来定纵轴；分段本身在同一遍里生成。
  const rows = recent.map(turn => {
    const used = clamped(turn.percent)
    const buffer = clamped(bufferPct)
    // 已用与缓冲不能相加超过 100%，否则柱子在视觉上会溢出。
    const shownBuffer = Math.min(buffer, Math.max(0, 100 - used))
    return { turn, used, shownBuffer }
  })

  const rawPeak = rows.reduce((top, row) => Math.max(top, row.used + row.shownBuffer), 0)
  const isAuto = (options.yMax ?? 'auto') === 'auto'

  if (isAuto) {
    // 纵轴上限取峰值的 1.1 倍再向上取整到 5 的倍数：最高的柱子顶到画布
    // 九成左右，留一点头，读数不会被裁在边上。下限 10% 避免全是 0 时
    // 除出巨大的相对高度。
    const ceiling = Math.max(10, Math.ceil((rawPeak * 1.1) / 5) * 5)
    const yMax = Math.min(100, ceiling)

    const bars = rows.map(({ turn, used, shownBuffer }) => {
      const segments = partSegments(turn, used, yMax)
      if (shownBuffer > 0) segments.push({ ratio: shownBuffer / yMax, kind: 'buffer' })
      return {
        label: String(turn.seq),
        segments: segments.filter(segment => segment.ratio > 0),
        percent: used,
        tokens: turn.tokens,
        hasParts: (turn.parts?.filter(part => part.tokens > 0).length ?? 0) > 0,
        isAfterCompact: turn.afterCompact === true,
      }
    })

    const peak = bars.reduce((top, bar) => (bar.percent > top ? bar.percent : top), 0)
    return { bars, peak, yMax }
  }

  const yMax = Math.max(1, Math.min(100, options.yMax as number))
  const bars = rows.map(({ turn, used, shownBuffer }) => {
    const free = Math.max(0, 100 - used - shownBuffer)
    const segments = partSegments(turn, used, yMax)
    if (shownBuffer > 0) segments.push({ ratio: shownBuffer / yMax, kind: 'buffer' })
    // 固定纵轴时才画空闲段（旧行为）：它把柱子补满，便于横向比「用了多少」。
    if (free > 0 && yMax >= 100) segments.push({ ratio: free / yMax, kind: 'free' })
    return {
      label: String(turn.seq),
      segments: segments.filter(segment => segment.ratio > 0),
      percent: used,
      tokens: turn.tokens,
      hasParts: (turn.parts?.filter(part => part.tokens > 0).length ?? 0) > 0,
      isAfterCompact: turn.afterCompact === true,
    }
  })

  const peak = bars.reduce((top, bar) => (bar.percent > top ? bar.percent : top), 0)
  return { bars, peak, yMax }
}

/**
 * 一轮的「已用」怎么分段：有构成就按各类 token 占比细分，没有就整段单色。
 *
 * 用 token 占比而不是「percent 平均分」：一次请求里系统提示几十 k、
 * 对话消息几百 k，平均分会把它们画成一样宽，正好抹掉要看的差别。
 */
function partSegments(turn: ContextTurn, used: number, yMax: number): StackSegment[] {
  const parts = turn.parts?.filter(part => part.tokens > 0) ?? []
  if (parts.length === 0) return [{ ratio: used / yMax, kind: 'used' }]
  const partTotal = parts.reduce((sum, part) => sum + part.tokens, 0)
  if (partTotal <= 0) return [{ ratio: used / yMax, kind: 'used' }]
  return parts.map(part => ({
    ratio: (part.tokens / partTotal) * (used / yMax),
    kind: part.kind,
  }))
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
export function stackColor(
  kind: StackSegment['kind'] | null,
  isLight = false,
): string | undefined {
  if (kind === null) return undefined
  // 骨架三段与 SVG 侧同一套语义色：`'claude'` 会解析成橙色，那是 Claude 的
  // 品牌色，放在这套冷色里会跳出来打架。
  // 终端没法用透明度分层，缓冲与空闲只能各给两支明度不同的实色。
  if (kind === 'used') return isLight ? '#3B54D6' : '#4D6BFE'
  if (kind === 'buffer') return isLight ? '#8C9BE8' : '#33407A'
  if (kind === 'free') return isLight ? '#DDE2F2' : '#23273a'
  return contextPartColor(kind, isLight)
}

/** 堆叠柱图的说明文字：`最近 24 轮 · 峰值 42%`。 */
/**
 * 堆叠柱的说明文字：`最近 12 轮 · 峰值 46%`。
 *
 * `yMax` 只给终端用：那边没有 Svg，画不出左侧纵轴，纵轴上限只能写在文字里。
 * 桌面端已经有轴上的 `0` 与上界刻度，不必再重复一次。
 */
export function stackCaption(barCount: number, peak: number, yMax?: number): string {
  if (barCount === 0) return '还没有逐轮数据（跑一轮对话后出现）'
  const axis = yMax !== undefined ? ` · 纵轴 ${Math.round(yMax)}%` : ''
  return `最近 ${barCount} 轮 · 峰值 ${Math.round(peak)}%${axis}`
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
export function stackLegendOf(bars: StackBar[], isLight = false): StackLegendItem[] {
  const present = new Set<StackSegment['kind']>()
  for (const bar of bars) {
    for (const segment of bar.segments) present.add(segment.kind)
  }

  const items: StackLegendItem[] = []
  // 老记录没有分类构成，用单色「已用」画；它和新记录的分类柱可以同屏，
  // 所以图例里允许两者并存。
  if (present.has('used'))
    items.push({
      kind: 'used',
      label: '已用（无构成）',
      color: isLight ? '#3B54D6' : '#4D6BFE',
    })
  for (const part of CONTEXT_PART_LABELS) {
    // `other` 是兜底键，没出现就不列；其余分类同理，出现才列。
    if (!present.has(part.kind)) continue
    items.push({ kind: part.kind, label: part.label, color: isLight ? part.light : part.dark })
  }
  if (present.has('buffer'))
    items.push({ kind: 'buffer', label: '压缩缓冲', color: isLight ? '#8C9BE8' : '#33407A' })
  if (present.has('free'))
    items.push({ kind: 'free', label: '空闲', color: isLight ? '#DDE2F2' : '#23273a' })
  return items
}

// ---------------- 轮次历史（热图矩阵） ----------------

/** 一天的量：轮次（用户输入次数）与消息数。 */
export type TurnBar = {
  day: string
  turns: number
  messages: number
  /** 轮次占最大值的比例，供字符版画柱高。 */
  ratio: number
}

/**
 * 把逐日用量补齐成连续的日序列，给热图矩阵用。
 *
 * 热图按「色深」读数，缺的日子必须补 0 并保留一格，否则时间轴会被压缩变形。
 *
 * @param days       逐日轮次与消息数
 * @param windowDays 一共要看多少天；不足的向前补 0
 * @param endDay     右端是哪一天（`YYYY-MM-DD`）；省略时取最后一条记录所在日
 */
export function turnBars(days: TurnDay[], windowDays: number, endDay?: string): TurnBar[] {
  if (windowDays <= 0) return []
  const byDay = new Map(days.map(item => [item.day, item]))

  // 右端：显式指定 > 最后一次记录所在日 > 系统今天。
  const anchor = endDay ?? (days.length > 0 ? days[days.length - 1]!.day : localDayKey(new Date()))
  const anchorDate = new Date(`${anchor}T00:00:00`)
  const bars: TurnBar[] = []
  if (Number.isNaN(anchorDate.getTime())) return []

  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(anchorDate)
    date.setDate(date.getDate() - offset)
    const key = localDayKey(date)
    const hit = byDay.get(key)
    bars.push({ day: key, turns: hit?.turns ?? 0, messages: hit?.messages ?? 0, ratio: 0 })
  }

  const max = bars.reduce((top, bar) => (bar.turns > top ? bar.turns : top), 0)
  return bars.map(bar => ({ ...bar, ratio: max > 0 ? bar.turns / max : 0 }))
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

/** 热图的历史范围说明：`最近 180 天 · 1,234 轮 · 38,264 条消息`。 */
export function turnBarsCaption(bars: TurnBar[]): string {
  if (bars.length === 0) return '还没有轮次数据'
  const turns = bars.reduce((sum, bar) => sum + bar.turns, 0)
  const messages = bars.reduce((sum, bar) => sum + bar.messages, 0)
  return `最近 ${bars.length} 天 · ${turns} 轮 · ${messages.toLocaleString('en-US')} 条消息`
}
