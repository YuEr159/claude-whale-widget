/**
 * 用量概览：把本地扫描结果整形成「概览 / 模型」两页要的卡片与热力图。
 *
 * 布局参照 Claude 桌面端的用量页：一组指标卡 + 一张按天/按小时的色块图。
 * 这里不碰 `$`，只做数据整形，方便单测。
 */
import type { LocalDay, LocalModel, LocalOverview } from '../types'
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
