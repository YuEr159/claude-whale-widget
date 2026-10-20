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
import { CHART_PALETTES } from './panel-fill.ts'
import type { ChartPalette } from './panel-fill.ts'
import { tokens } from './format.ts'
import { contextStack, turnBars } from './usage-overview.ts'
import type { ModelStackBar, TurnBar } from './usage-overview.ts'

/**
 * 配色总纲：以 DeepSeek 的品牌蓝（#4D6BFE）为核心的一套**冷色阶**。
 *
 * 三条约束同时成立：
 *   1. **分得开**——六个分类沿色相环铺开（蓝 → 青 → 绿 → 紫 → 靛），
 *      并且明度也拉开（同一个色相族里靠亮度再分一层），相邻两类不会糊在一起。
 *   2. **是冷色**——色相全部落在 200°–280° 一带，没有黄、橙、红。
 *   3. **对得上 Claude 的橙**——Claude 的品牌色是暖橙，冷暖互补，放在一起
 *      对比强但不相撞；所以这套图在 Claude 的面板里不会显得「串色」。
 */

/**
 * 图表颜色全部来自面板算好的调色板（`ThemeColors.chart`）。
 *
 * 这里**不写死任何色值**，原因见 `panel-fill.ts` 的 `ChartPalette`：
 * 两套主题需要的是两组不同的色值，不是同一支色的两个透明度。图表的每个
 * 绘制函数都收一个 `palette` 参数，由渲染层从主题算出后传进来。
 */

/** 一支颜色的「填充」写法：`fill` + `fill-opacity`，两套主题共用一个值。 */
function fillOf(color: string, opacity: number): string {
  return `fill="${color}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}`
}

/** 同上，用于线条。 */
function strokeOf(color: string, opacity: number): string {
  return `stroke="${color}"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ''}`
}

/**
 * 内容分类的色相分配（两套主题共用这一套色相，只差明度）。
 *
 * 与 `usage-overview.ts` 的 `CONTEXT_PART_LABELS` 是同一套语义色：那边给的是
 * 主题键（终端用），这边给的是十六进制（SVG 用），两边的**色相**必须一一对应，
 * 否则同一张图在桌面端和终端会读出不同含义。具体色值在两套调色板里。
 *
 * 色相分配（由深到浅、由冷到更冷）刻意拉开距离：
 *   messages（对话消息，占比最大）用核心蓝，是主角；
 *   system（系统提示）往紫走，与蓝区分；
 *   tools（工具定义）用青绿，冷色但色相明显不同；
 *   memory（记忆文件）用靛青，比 tools 更蓝；
 *   mcp（MCP 工具）用紫罗兰，比 system 更艳；
 *   agents（自定义 agent）用深青，压在中间一档。
 *   other 是中性灰兜底，不与任何分类撞色。
 */
export const PART_KINDS = [
  'messages',
  'system',
  'tools',
  'memory',
  'mcp',
  'agents',
  'other',
] as const

/**
 * 一段的填充写法，直接进 SVG 的 `rect` 属性串。
 *
 * 骨架三段（已用 / 压缩缓冲 / 空闲）用同一支主色靠不透明度分层；内容分类
 * 各有自己的实色。具体取哪支色由 `palette` 决定——深色一套、浅色一套。
 */
export function segmentFill(kind: string, palette: ChartPalette): string {
  if (kind === 'used') return fillOf(palette.used, palette.usedOpacity)
  if (kind === 'buffer') return fillOf(palette.used, palette.bufferOpacity)
  if (kind === 'free') return fillOf(palette.used, palette.freeOpacity)
  return fillOf(palette.parts[kind] ?? palette.parts.other ?? palette.used, 1)
}

/**
 * 模型堆叠柱的分段配色：同一支 DeepSeek 蓝按色相与明度铺开。
 *
 * 模型数量不固定（一个网关可能挂着十几个名字），所以不能像上下文分类那样
 * 给每个模型固定一色。改成按**排序后的序号**取色：色阶沿色相环从核心蓝走到
 * 青、再走到紫，明度也交错开，相邻两段不会糊在一起。排在前面的模型（用量最大）
 * 拿到最饱和的核心蓝，往后的逐渐变浅、偏移——读者不用看名字也能判断哪段是主力。
 *
 * 色阶用完时循环，但模型页只画前几段（见 `MODEL_STACK_KEEP`），循环不会出现。
 *
 * 两套主题各一份：浅色版是同一批色相压暗过的，保证在白底上也分得开
 * （逐支实测 ≥ 4.5）。
 */
const MODEL_SCALE_DARK = [
  '#4D6BFE', // 230° 核心蓝（DeepSeek）
  '#7AA2F7', // 219° 浅靛
  '#22C3D6', // 187° 青绿
  '#A78BFA', // 257° 紫
  '#1E6F8C', // 194° 深青
  '#C084FC', // 271° 品紫
  '#5B7CFA', // 228° 蓝，介于核心与浅靛之间
  '#7C8394', // 中性灰兜底
] as const

const MODEL_SCALE_LIGHT = [
  '#3B54D6', // 核心蓝，压暗
  '#3468C0', // 浅靛 → 深靛
  '#0E7C8A', // 青绿 → 深青
  '#7C4DDB', // 紫 → 深紫
  '#1E6F8C', // 深青，本来就够深
  '#9333EA', // 品紫 → 深品紫
  '#4A63C8', // 介于核心与浅靛之间
  '#6E7486', // 中性灰
] as const

/**
 * 第 `index` 段（按用量降序）的配色。
 *
 * `palette` 决定用深色还是浅色那一套色阶——两套的**色相顺序一致**，
 * 所以读者换主题后各模型之间的相对位置仍然读得出来。
 */
export function modelFill(index: number, isLight = false): string {
  const scale = isLight ? MODEL_SCALE_LIGHT : MODEL_SCALE_DARK
  return scale[Math.abs(index) % scale.length] ?? scale[0]
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
 * 每轮一根柱子，柱内自下而上叠：已用（按内容类别细分）、压缩缓冲。
 * 纵轴按这一屏的峰值自适应，不强行撑满 100%，所以柱子高低本身就表达用量大小。
 *
 * 横轴标轮次序号（不是时间）：逐轮记录的时间间隔可能极不均匀，按时间排会
 * 把两轮挤在一天里、把中间隔了几小时的地方拉成长长的空档，反而看不清走势。
 *
 * 压缩发生的那一轮，柱子左侧竖一条虚线：压缩后上下文骤降，读者看到柱子
 * 突然变矮时，要能一眼分清是「压缩造成的」还是「自己少用了」。
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
  palette: ChartPalette = CHART_PALETTES.dark,
): string {
  const height = 112
  // 左侧留出纵轴刻度与轴线的位置：刻度数字要放在轴线左边，给 26px。
  // 底部留出横轴刻度数字的位置，所以比上面多几像素。
  const padding = { top: 10, right: 6, bottom: 26, left: 26 }
  const plotWidth = Math.max(1, width - padding.left - padding.right)
  const plotHeight = Math.max(1, height - padding.top - padding.bottom)

  const { bars, peak, yMax } = contextStack(turns, maxBars, bufferPct)
  if (bars.length === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" ${fillOf(palette.label, 1)}>还没有逐轮数据</text>` +
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
      const fill = segmentFill(segment.kind, palette)
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(segmentHeight, 0.5).toFixed(2)}" ${fill}/>`,
      )
      cursor = y
    }
  })

  // 带构成数据的柱子有几根：图注要如实说，避免读者以为所有柱子都细分了。
  const partsCount = bars.filter(bar => bar.hasParts).length
  const compactCount = bars.filter(bar => bar.isAfterCompact).length

  // 左侧纵轴：一条轴线 + 上界与 0 两处刻度。纵轴是自适应的，柱子的绝对高度
  // 需要一个参照；把上界直接写在轴顶，比在图注里另起一句「纵轴 35%」更省一次
  // 视线转移——读者看柱子时视线本来就在画面里。
  const axisTop = padding.top
  const axisBottom = padding.top + plotHeight
  parts.push(
    `<line x1="${padding.left}" y1="${axisTop}" x2="${padding.left}" y2="${axisBottom}" ${strokeOf(palette.axis, 1)} stroke-width="1"/>`,
  )
  // 基线
  parts.push(
    `<line x1="${padding.left}" y1="${axisBottom}" x2="${width - padding.right}" y2="${axisBottom}" ${strokeOf(palette.axis, 1)} stroke-width="1"/>`,
  )
  // 上界刻度：轴顶向左伸一小段，数字右对齐贴着轴线。
  parts.push(
    `<line x1="${padding.left - 3}" y1="${axisTop}" x2="${padding.left}" y2="${axisTop}" ${strokeOf(palette.axis, 1)} stroke-width="1"/>`,
    `<text x="${padding.left - 4}" y="${axisTop + 3}" text-anchor="end" font-size="9" ${fillOf(palette.label, 1)}">${Math.round(yMax)}%</text>`,
  )
  // 0 刻度：同样向左伸一小段。
  parts.push(
    `<line x1="${padding.left - 3}" y1="${axisBottom}" x2="${padding.left}" y2="${axisBottom}" ${strokeOf(palette.axis, 1)} stroke-width="1"/>`,
    `<text x="${padding.left - 4}" y="${axisBottom + 3}" text-anchor="end" font-size="9" ${fillOf(palette.label, 1)}">0</text>`,
  )

  // 压缩虚线：画在「压缩后那一轮」柱子的左缘，从柱脚贯穿到图顶。
  // 放在柱子之后画，虚线才不会被柱身盖住看不见。
  bars.forEach((bar, index) => {
    if (!bar.isAfterCompact) return
    const x = (padding.left + index * slot + gap / 2).toFixed(2)
    parts.push(
      `<line x1="${x}" y1="${axisTop}" x2="${x}" y2="${axisBottom}" ${strokeOf(palette.compact, 1)} stroke-width="1" stroke-dasharray="2 2"/>`,
    )
  })

  // 横轴刻度：轮次序号。柱子多时按可读间距抽稀，保证数字之间不会叠在一起——
  // 每个标签至少占 18px，否则跳过。首尾两根一定标出来，读者才知道看的是哪一段。
  const labelStep = Math.max(1, Math.ceil(18 / slot))
  bars.forEach((bar, index) => {
    if (index % labelStep !== 0 && index !== bars.length - 1) return
    const center = padding.left + index * slot + slot / 2
    parts.push(
      `<text x="${center.toFixed(2)}" y="${axisBottom + 12}" text-anchor="middle" font-size="9" ${fillOf(palette.label, 1)}">${escapeXml(bar.label)}</text>`,
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<title>${escapeXml(`上下文占比：最近 ${bars.length} 轮，峰值 ${Math.round(peak)}%（纵轴 0–${Math.round(yMax)}%）${partsCount > 0 ? `，其中 ${partsCount} 轮按内容构成着色` : ''}${compactCount > 0 ? `，${compactCount} 处压缩` : ''}`)}</title>` +
    parts.join('') +
    `</svg>`
  )
}


/** 热图色标：同一支蓝，靠不透明度分出深浅。 */
export const HEAT_FILL = '#4D6BFE'

/**
 * 五档不透明度，从「几乎没有」到「最热」。
 *
 * 用**不透明度**而不是五支实色，是为了同时照顾深色与浅色主题：SVG 作为图片
 * 绘制时背景是透明的，同样的 `fill-opacity` 在深色底上表现为暗蓝、在浅色底上
 * 表现为淡蓝，两边都读得出深浅，不必知道当前是哪套主题。写死五支深色实色的话，
 * 浅色主题下整个矩阵会变成一片压不住的深色块；写死浅色则深色主题下最淡的一档
 * 直接消失。
 */
export const HEAT_OPACITY = [0.13, 0.3, 0.5, 0.72, 1] as const

/**
 * 0 值格子的底色：一块中性灰，同样半透明。
 *
 * 用中性灰而不是蓝色系的最淡一档：0 是「这天没有用量」，不是「用量最少的
 * 那一档」，颜色上要与有量的格子分属两个体系。半透明让它在深浅两种主题下
 * 都自然融进背景，只是一层可辨认的底色。
 */
export const HEAT_ZERO_FILL = '#8b90a3'
export const HEAT_ZERO_OPACITY = 0.16

/**
 * 热图的一格该填什么颜色与不透明度：五档，按这一屏的最大值分。
 *
 * 与 `usage-overview.ts` 的 `heatLevel()` 同一套分档口径（0.25 / 0.5 / 0.75），
 * 只是那边返回档位给字符版用，这边直接给 SVG 的 fill 与 opacity。
 */
export function heatCell(value: number, max: number): { fill: string; opacity: number } {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) {
    return { fill: HEAT_ZERO_FILL, opacity: HEAT_ZERO_OPACITY }
  }
  const ratio = value / max
  const level = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1
  return { fill: HEAT_FILL, opacity: HEAT_OPACITY[level] }
}

/**
 * 热图外框的高度（CSS 像素）。
 *
 * 方块边长是**固定值**（`HEAT_CELL`），所以高度只由 7 行决定，与面板宽度无关。
 * 面板变宽时增加的是**列数**（也就是覆盖的天数），而不是方块大小——这样
 * 一个方块永远代表一天，读者不用在不同宽度下重新适应格子的大小。
 */
export function turnHeatHeight(): number {
  return Math.round(HEAT_TOP + 7 * HEAT_CELL + 6 * HEAT_CELL_GAP + HEAT_BOTTOM)
}

/** 热图的留白与方块尺寸；画布、高度公式、列数计算共用一个口径。 */
const HEAT_SIDE = 2
const HEAT_TOP = 11
/** 底部留白：图注一行就放在这里。最右侧右对齐。 */
export const HEAT_BOTTOM = 15
/** 方块边长固定：一个方块代表一天，宽度变化只改变天数。 */
export const HEAT_CELL = 11
export const HEAT_CELL_GAP = 2
/** 一列 7 天。 */
const HEAT_ROWS = 7

/**
 * 给定画布宽度能放下多少列（周）。
 *
 * 这是「随窗口宽度增加而色块数量增加」的落点：宽度每多一格，就多露出
 * 一周的数据。最小 1 列，免得极窄面板算出差值。
 */
export function heatColumnCount(width: number): number {
  const plotWidth = Math.max(HEAT_CELL, width - HEAT_SIDE * 2)
  return Math.max(1, Math.floor((plotWidth + HEAT_CELL_GAP) / (HEAT_CELL + HEAT_CELL_GAP)))
}

/** 这些列能覆盖多少天；热图的窗口就取这么大。 */
export function heatWindowDays(width: number): number {
  return heatColumnCount(width) * HEAT_ROWS
}

/**
 * 数据实际横跨多少天（首尾两端都算）。
 *
 * 扫描窗口之外的日子本来就没有记录，把它们补成 0 格会让读者以为「那阵子
 * 完全没用」——其实只是没扫。所以画布最多撑到数据真实跨度。
 */
function spanDays(days: TurnDay[]): number {
  if (days.length === 0) return 0
  const first = Date.parse(`${days[0]!.day}T00:00:00`)
  const last = Date.parse(`${days[days.length - 1]!.day}T00:00:00`)
  if (Number.isNaN(first) || Number.isNaN(last)) return 0
  return Math.max(1, Math.round((last - first) / 86_400_000) + 1)
}

/**
 * 热图读数口径：轮次或消息数。
 *
 * 两个量在同一块矩阵上切换显示比挤成两张图好读——形状可比，读者只需要
 * 换一个心里的标尺。
 */
export type HeatMetric = 'turns' | 'messages'

/** 轮次历史的热图矩阵：按周分列、每列 7 天，方块是固定大小的圆角正方。 */
export function turnHeatSvg(
  days: TurnDay[],
  width: number,
  metric: HeatMetric = 'messages',
  palette: ChartPalette = CHART_PALETTES.dark,
): string {
  // 列数由宽度决定，窗口天数跟着列数走：宽度增加 → 多露出几周历史。
  // 但点数不能超过「数据实际跨度」——`turnBars` 会往前补 0，补到 483 天时
  // 超出扫描范围的那一段看起来就是「那阵子完全没用」，那是假象。
  const maxColumns = heatColumnCount(width)
  const span = spanDays(days)
  const windowDays = Math.min(maxColumns * HEAT_ROWS, span > 0 ? span : maxColumns * HEAT_ROWS)
  const bars = turnBars(days, windowDays)
  if (bars.length === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 60" width="${width}" height="60" role="img">` +
      `<text x="${width / 2}" y="30" text-anchor="middle" font-size="11" ${fillOf(palette.label, 1)}>还没有轮次数据</text>` +
      `</svg>`
    )
  }

  // 按周切列：每列 7 天竖排。第一列可能不满一周，补成空格，
  // 让同一行的格子落在同一个星期几上——这是矩阵可读的前提。
  const cells: TurnBar[][] = []
  for (let index = 0; index < bars.length; index += HEAT_ROWS) {
    cells.push(bars.slice(index, index + HEAT_ROWS))
  }

  const cell = HEAT_CELL
  const cellGap = HEAT_CELL_GAP
  const radius = Math.max(1, Math.min(3, cell * 0.22))
  const gridWidth = cells.length * cell + (cells.length - 1) * cellGap
  // 贴右：最新的一天在最右列，左侧可能留一点余量（不足一个方块的宽度）。
  const left = Math.max(HEAT_SIDE, width - gridWidth - HEAT_SIDE)
  const top = HEAT_TOP
  const height = turnHeatHeight()

  const valueOf = (bar: TurnBar) => (metric === 'turns' ? bar.turns : bar.messages)
  const max = bars.reduce((peak, bar) => Math.max(peak, valueOf(bar)), 0)
  const total = bars.reduce((sum, bar) => sum + valueOf(bar), 0)
  const unit = metric === 'turns' ? '轮' : '条消息'

  const parts: string[] = []
  cells.forEach((column, columnIndex) => {
    column.forEach((bar, rowIndex) => {
      const x = left + columnIndex * (cell + cellGap)
      const y = top + rowIndex * (cell + cellGap)
      const value = valueOf(bar)
      const { fill, opacity } = heatCell(value, max)
      const tip =
        metric === 'turns'
          ? `${bar.day} · ${bar.turns} 轮 · ${bar.messages} 条消息`
          : `${bar.day} · ${bar.messages} 条消息 · ${bar.turns} 轮`
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${radius.toFixed(2)}" ry="${radius.toFixed(2)}" fill="${fill}" fill-opacity="${opacity.toFixed(2)}"><title>${escapeXml(tip)}</title></rect>`,
      )
    })
  })

  // 一行说明右对齐：口径 · 最近多少天 · 总量 · 峰值。这行就是整块的图注，
  // 上方不再另起标题——同一件事说两遍会让画面多一道横线。
  const caption = `${metric === 'turns' ? '轮次' : '消息'} · 最近 ${bars.length} 天 · 共 ${total.toLocaleString('en-US')} ${unit} · 峰值 ${max.toLocaleString('en-US')} ${unit}`
  parts.push(
    `<text x="${width - HEAT_SIDE}" y="${height - 4}" text-anchor="end" font-size="9" ${fillOf(palette.label, 1)}>${escapeXml(caption)}</text>`,
  )

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<title>${escapeXml(`热图（${metric === 'turns' ? '轮次' : '消息数'}）：最近 ${bars.length} 天，共 ${total} ${unit}，峰值 ${max} ${unit}`)}</title>` +
    parts.join('') +
    `</svg>`
  )
}

/**
 * 模型页的逐日堆叠柱：每天一根，柱内按模型堆叠。
 *
 * 与上下文柱同一套版式（左侧纵轴、0 与上界两处刻度），但纵轴单位是 token
 * 而不是百分比。柱子之间留一道细缝，读者才能数出「一天一根」。
 *
 * `order` 由调用方给出（与图例、下方明细行共用同一份），不在这里重新排序：
 * 两处各排一次，一旦算法不一致，颜色就会与模型错位。
 */
export function modelStackSvg(
  bars: ModelStackBar[],
  width: number,
  yMax: number,
  order: string[],
  palette: ChartPalette = CHART_PALETTES.dark,
): string {
  const height = 96
  const padding = { top: 10, right: 2, bottom: 14, left: 34 }
  const plotWidth = Math.max(1, width - padding.left - padding.right)
  const plotHeight = Math.max(1, height - padding.top - padding.bottom)

  if (bars.length === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" ${fillOf(palette.label, 1)}>还没有逐模型数据</text>` +
      `</svg>`
    )
  }

  const slot = plotWidth / bars.length
  const gap = Math.min(3, Math.max(0.6, slot * 0.28))
  const barWidth = Math.max(0.8, slot - gap)
  const rank = new Map<string, number>()
  order.forEach((model, index) => rank.set(model, index))

  const parts: string[] = []
  bars.forEach((bar, index) => {
    const x = padding.left + index * slot + gap / 2
    let cursor = padding.top + plotHeight
    // 自下而上按 order 堆叠；不在 order 里的段（理论上不该有）排在最后。
    const ordered = [...bar.segments].sort(
      (a, b) => (rank.get(a.model) ?? 999) - (rank.get(b.model) ?? 999),
    )
    for (const segment of ordered) {
      const share = yMax > 0 ? segment.tokens / yMax : 0
      const segmentHeight = share * plotHeight
      const y = cursor - segmentHeight
      const fill = fillOf(
        segment.model === '其他'
          ? palette.parts.other ?? palette.barEmpty
          : modelFill(rank.get(segment.model) ?? 0, palette.isLight),
        1,
      )
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(segmentHeight, 0.5).toFixed(2)}" ${fill}><title>${escapeXml(`${bar.day} · ${segment.model} · ${Math.round(segment.tokens).toLocaleString('en-US')} tok`)}</title></rect>`,
      )
      cursor = y
    }
  })

  // 左侧纵轴：0 与上界两处刻度，与上下文柱同一个版式。
  const axisTop = padding.top
  const axisBottom = padding.top + plotHeight
  parts.push(
    `<line x1="${padding.left}" y1="${axisTop}" x2="${padding.left}" y2="${axisBottom}" ${strokeOf(palette.axis, 1)} stroke-width="1"/>`,
    `<line x1="${padding.left}" y1="${axisBottom}" x2="${width - padding.right}" y2="${axisBottom}" ${strokeOf(palette.axis, 1)} stroke-width="1"/>`,
    `<line x1="${padding.left - 3}" y1="${axisTop}" x2="${padding.left}" y2="${axisTop}" ${strokeOf(palette.axis, 1)} stroke-width="1"/>`,
    `<text x="${padding.left - 4}" y="${axisTop + 3}" text-anchor="end" font-size="8" ${fillOf(palette.label, 1)}">${escapeXml(tokens(yMax))}</text>`,
    `<text x="${padding.left - 4}" y="${axisBottom + 3}" text-anchor="end" font-size="9" ${fillOf(palette.label, 1)}">0</text>`,
  )

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<title>${escapeXml(`逐模型用量：最近 ${bars.length} 天，纵轴 0–${tokens(yMax)} tok`)}</title>` +
    parts.join('') +
    `</svg>`
  )
}

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
