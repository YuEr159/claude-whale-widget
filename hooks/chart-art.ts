/**
 * 面板里的矢量图表：堆叠柱状图与轮次柱状图。
 *
 * 为什么不继续用字符拼：字符图受等宽网格限制，一根柱子只能落在整列、
 * 一段高度只能落在整行，柱宽与间距都被锁死；而且颜色只能靠字符逐个上色。
 * 改用 `Svg` 后可以画真正的矩形、坐标轴与刻度线，柱子宽度、圆角、
 * 行距都能自己定，缩放也更自然。
 *
 * 每个函数都返回一段完整的 `<svg>` 字符串，直接喂给桌面端的 `Svg` 元素。
 * 终端没有 `Svg`，那边仍走 `usage-overview.ts` 的字符光栅化。
 */
import type { ContextTurn, TurnDay } from '../types'
import { contextStack, turnBars } from './usage-overview.ts'

/** 图表统一的配色，与面板主题里的语义色对齐。 */
const COLORS = {
  used: '#6f8fe8',
  buffer: '#4a5a8a',
  // 空闲段是「背景的空余空间」，压到很淡：它只是衬托，不该和真实用量抢眼。
  free: '#23273a',
  axis: '#4a4f63',
  label: '#9aa0b4',
  bar: '#6f8fe8',
  barEmpty: '#3a3f55',
} as const

/**
 * 内容分类的矢量配色。
 *
 * 与 `usage-overview.ts` 的 `CONTEXT_PART_LABELS` 是同一套语义色的具体值：
 * 那边给的是主题键（终端用），这边给的是十六进制（SVG 用）。两边必须一一对应，
 * 否则同一张图在桌面端和终端会读出不同含义。
 */
export const PART_COLORS: Readonly<Record<string, string>> = {
  system: '#c98bb9',
  tools: '#d9a441',
  memory: '#7bb0d8',
  mcp: '#6fc7c0',
  agents: '#b394d6',
  messages: '#6f8fe8',
  // 兜底：认不出的分类统一用中性灰，不抢语义色的位置。
  other: '#5a6076',
}

/** 一段的分段键对应的矢量颜色。 */
export function segmentFill(kind: string): string {
  if (kind === 'used') return COLORS.used
  if (kind === 'buffer') return COLORS.buffer
  if (kind === 'free') return COLORS.free
  return PART_COLORS[kind] ?? PART_COLORS.other ?? COLORS.used
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 上下文占比的堆叠柱状图。
 *
 * 每轮一根柱子，柱内自下而上分三段：已用、压缩缓冲、空闲。所有柱子等高
 * （代表窗口的 100%），所以「柱内已用段有多高」直接就是占比。
 *
 * @param turns     逐轮记录，按时间升序
 * @param width     画布宽度，CSS 像素
 * @param maxBars   最多画几根
 * @param bufferPct 压缩缓冲占窗口的百分比
 */
export function contextChartSvg(
  turns: ContextTurn[],
  width: number,
  maxBars = 24,
  bufferPct = 0,
): string {
  const height = 96
  const padding = { top: 10, right: 2, bottom: 14, left: 2 }
  const plotWidth = Math.max(1, width - padding.left - padding.right)
  const plotHeight = Math.max(1, height - padding.top - padding.bottom)

  const { bars, peak } = contextStack(turns, maxBars, bufferPct)
  if (bars.length === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" fill="${COLORS.label}">还没有逐轮数据</text>` +
      `</svg>`
    )
  }

  // 柱子之间的间隙随槽位收窄，下限 0.4px：柱子多时宁可让缝隙细一点，
  // 也要保证每根柱子本身还看得见。柱宽下限 0.5px（亚像素也会被渲染出来）。
  const slot = plotWidth / bars.length
  const gap = Math.min(2, Math.max(0.4, slot * 0.3))
  const barWidth = Math.max(0.5, slot - gap)

  const parts: string[] = []
  bars.forEach((bar, index) => {
    const x = padding.left + index * slot + gap / 2
    let cursor = padding.top + plotHeight
    for (const segment of bar.segments) {
      const segmentHeight = segment.ratio * plotHeight
      const y = cursor - segmentHeight
      const fill =
        segmentFill(segment.kind)
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(segmentHeight, 0.5).toFixed(2)}" fill="${fill}"/>`,
      )
      cursor = y
    }
  })

  // 带构成数据的柱子有几根：图注要如实说，避免读者以为所有柱子都细分了。
  const partsCount = bars.filter(bar => bar.hasParts).length

  // 基线 + 峰值标注
  parts.push(
    `<line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="${COLORS.axis}" stroke-width="1"/>`,
  )
  parts.push(
    `<text x="${width - padding.right}" y="${padding.top - 2}" text-anchor="end" font-size="9" fill="${COLORS.label}">峰值 ${Math.round(peak)}%</text>`,
  )

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<title>${escapeXml(`上下文占比：最近 ${bars.length} 轮，峰值 ${Math.round(peak)}%${partsCount > 0 ? `，其中 ${partsCount} 轮按内容构成着色` : ''}`)}</title>` +
    parts.join('') +
    `</svg>`
  )
}

/**
 * 轮次历史的柱状图，读法参照 GitHub 贡献图：横轴是连续的日子，柱高是当天的
 * 用户输入次数。没有记录的天保留一格底，时间轴不断档。
 *
 * @param days       逐日轮次
 * @param width      画布宽度
 * @param windowDays 一共看多少天
 */
export function turnChartSvg(days: TurnDay[], width: number, windowDays: number): string {
  const height = 80
  const padding = { top: 10, right: 2, bottom: 14, left: 2 }
  const plotWidth = Math.max(1, width - padding.left - padding.right)
  const plotHeight = Math.max(1, height - padding.top - padding.bottom)

  const bars = turnBars(days, windowDays)
  if (bars.length === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" fill="${COLORS.label}">还没有轮次数据</text>` +
      `</svg>`
    )
  }

  const slot = plotWidth / bars.length
  const gap = Math.min(2, slot * 0.3)
  const barWidth = Math.max(1, slot - gap)
  const total = bars.reduce((sum, bar) => sum + bar.turns, 0)
  const max = bars.reduce((top, bar) => (bar.turns > top ? bar.turns : top), 0)

  const parts: string[] = []
  bars.forEach((bar, index) => {
    const x = padding.left + index * slot + gap / 2
    // 0 轮的日子也画一格底，和 GitHub 贡献图一致。
    const ratio = bar.turns <= 0 ? 0 : Math.max(bar.ratio, 0.06)
    const barHeight = ratio * plotHeight
    const y = padding.top + plotHeight - barHeight
    const fill = bar.turns <= 0 ? COLORS.barEmpty : COLORS.bar
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(barHeight, 1).toFixed(2)}" fill="${fill}"/>`,
    )
  })

  // 基线
  parts.push(
    `<line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="${COLORS.axis}" stroke-width="1"/>`,
  )
  // 右上角的极值标注
  parts.push(
    `<text x="${width - padding.right}" y="${padding.top - 2}" text-anchor="end" font-size="9" fill="${COLORS.label}">峰值 ${max} 轮</text>`,
  )
  // 左下角：范围与总数
  parts.push(
    `<text x="${padding.left}" y="${height - 3}" font-size="9" fill="${COLORS.label}">${escapeXml(`最近 ${bars.length} 天 · ${total} 轮`)}</text>`,
  )

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<title>轮次历史：最近 ${bars.length} 天，共 ${total} 轮，峰值 ${max} 轮</title>` +
    parts.join('') +
    `</svg>`
  )
}

/** 图例里的一项，供调用方按表面决定画字符还是 Svg。 */
export const CHART_LEGEND = [
  { key: 'used', label: '已用', color: COLORS.used },
  { key: 'buffer', label: '压缩缓冲', color: COLORS.buffer },
  { key: 'free', label: '空闲', color: COLORS.free },
] as const

// ---------------- 翻页 ----------------

/**
 * 从一段逐日数据里取「第 offset 页」的窗口，贴住最新一端。
 *
 * 面板本身只有纵向滚动，横向拉不动；所以给图表配一对翻页按钮，
 * 一页一个窗口。`offset` 是往左翻了几页，0 表示最右边（最新）。
 *
 * @param items 按时间升序
 * @param pageSize 一页多少条
 * @param offset 往左翻了几页
 */
export function pageOf<T>(items: T[], pageSize: number, offset: number): {
  slice: T[]
  /** 往左还能翻几页（0 表示已到最左）。 */
  maxOffset: number
  /** 当前页的编号，从 1 起（最左是 1）。 */
  page: number
  /** 一共几页。 */
  pages: number
} {
  const size = Math.max(1, pageSize)
  const pages = Math.max(1, Math.ceil(items.length / size))
  const clamped = Math.max(0, Math.min(Math.floor(offset), pages - 1))
  // offset 0 = 最新一页（最右），offset 增大往历史翻。
  const end = Math.max(0, items.length - clamped * size)
  const start = Math.max(0, end - size)
  return {
    slice: items.slice(start, end),
    maxOffset: pages - 1,
    page: pages - clamped,
    pages,
  }
}
