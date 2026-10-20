/**
 * 纯计算：把一次 `$.session.usage()` 的结果整理成界面要的几行文字。
 *
 * 这里不碰 `$`，只做数据整形，方便单测，也避免把 `$` 传进辅助函数
 * （插件校验器要求 `$` 只出现在 `$.noun.method(...)` 的调用点）。
 */
import type { BandMetric } from '../types'
import { pct, countdown, diffLines } from './format.ts'
import { usdEstimate } from './provenance.ts'

export type RateLimitView = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type UsageView = {
  fiveHour?: RateLimitView
  sevenDay?: RateLimitView
  /** 全部额度窗口，详细面板按原生 /usage 的标题逐一列出。 */
  limits: LimitView[]
  costUsd?: number
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
  /** 调用时传了 `{ breakdown }` 才有：上下文按分项的明细，形状见 usage-detail.ts。 */
  breakdown?: unknown
}

/** 一条额度窗口，与 usage-detail 的 LimitView 同形。 */
export type LimitView = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** 从一个未知形状的 usage 结果里挑字段；形状不对就当作「没有数据」。 */
export function toUsageView(usage: unknown): UsageView {
  if (!usage || typeof usage !== 'object') return { limits: [] }
  const source = usage as {
    rateLimits?: unknown
    cost?: { usd?: unknown } | null
    context?: { tokens?: unknown; window?: unknown; percent?: unknown; breakdown?: unknown } | null
  }

  const rawLimits = Array.isArray(source.rateLimits) ? source.rateLimits : []
  // 只有 kind 是字符串、percentUsed 是数字的条目才算一个窗口。
  const limits: LimitView[] = []
  for (const item of rawLimits) {
    if (!item || typeof item !== 'object') continue
    const one = item as { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }
    if (typeof one.kind !== 'string' || typeof one.percentUsed !== 'number') continue
    limits.push({
      kind: one.kind,
      percentUsed: one.percentUsed,
      resetsAt: typeof one.resetsAt === 'string' ? one.resetsAt : undefined,
    })
  }
  const pick = (kind: string): RateLimitView | undefined => limits.find(item => item.kind === kind)

  const context = source.context
  const cost = source.cost

  return {
    fiveHour: pick('five_hour'),
    sevenDay: pick('seven_day'),
    limits,
    costUsd: typeof cost?.usd === 'number' ? cost.usd : undefined,
    contextPercent: typeof context?.percent === 'number' ? context.percent : undefined,
    contextTokens: typeof context?.tokens === 'number' ? context.tokens : undefined,
    contextWindow: typeof context?.window === 'number' ? context.window : undefined,
    breakdown: context?.breakdown,
  }
}

/** 用量条要显示的一段代码改动。 */
export type BandDiff = {
  added: number
  removed: number
}

/** 改动行数的文字：`+128 -34`；两边都是 0 时为空串。 */
export function bandDiffText(diff: BandDiff | undefined): string {
  if (!diff) return ''
  return diffLines(diff.added, diff.removed)
}

/**
 * 用量条那一行摘要，按选中的几类口径拼接。
 *
 * 多选时**按 `BAND_METRIC_OPTIONS` 的固定次序**拼，与勾选先后无关——条子上
 * 的数字位置一旦随点击顺序漂移，读者就得每次重新找。同一类只出现一次。
 * `diff` 是一个并列口径：选中它时把代码改动写进摘要，还没有改动就明说。
 * 其余口径下这里**不拼**改动——增删要用两种颜色区分（diffAdded /
 * diffRemoved），拼成纯字符串就没法上色了；改由调用方在同一个 Text 里
 * 用嵌套 Text 追加。
 *
 * 之所以能做到「实时」：用量条在渲染时读了 `totals`，而 `$.state.set`
 * 会重绘读过该值的绘制点——Edit / Write 一写入，条子就跟着重画，
 * 不靠定时轮询。
 */
export function bandSummary(
  view: UsageView,
  metrics: readonly BandMetric[],
  now: number,
  diff?: BandDiff,
): string {
  const five = pct(view.fiveHour?.percentUsed)
  const seven = pct(view.sevenDay?.percentUsed)
  const hasLimits = Boolean(view.fiveHour || view.sevenDay)
  // `window` 已经写出了 5h 那一半，`context` 若照常输出就会把 `5h 24%`
  // 连着印两遍。所以两条都选时让 `context` 只补 7d 这一半。
  const windowShowsFive = metrics.includes('window') && hasLimits

  const one = (metric: BandMetric): string => {
    switch (metric) {
      case 'diff':
        return bandDiffText(diff) || '本会话还没有代码改动'
      case 'session':
        return `本会话 ${usdEstimate(view.costUsd)}`
      case 'cost':
        return `上下文 ${pct(view.contextPercent)}`
      case 'context':
        // 没有订阅额度窗口时（第三方网关、API key 计费）两个百分比都是空的，
        // 与其在条子上挂两个破折号，不如退回上下文 + 花费——那两项在任何
        // 计费方式下都有读数。
        if (!hasLimits) {
          return `上下文 ${pct(view.contextPercent)} · 本会话 ${usdEstimate(view.costUsd)}`
        }
        return windowShowsFive ? `7d ${seven}` : `5h ${five} · 7d ${seven}`
      default:
        // `window` 是默认口径，所以也要有这条退路。
        if (!hasLimits) {
          return `上下文 ${pct(view.contextPercent)} · 本会话 ${usdEstimate(view.costUsd)}`
        }
        return view.fiveHour
          ? `5h ${five} · ${countdown(view.fiveHour.resetsAt, now)} 后重置`
          : `5h ${five} · 7d ${seven}`
    }
  }

  const seen = new Set<BandMetric>()
  // 按**文本**再去一次重：两条口径在没有额度窗口时都会退回
  // 「上下文 … · 本会话 …」，并排出现就是同一句话写了两遍。
  const seenText = new Set<string>()
  const parts: string[] = []
  for (const option of BAND_METRIC_OPTIONS) {
    if (!metrics.includes(option.value) || seen.has(option.value)) continue
    seen.add(option.value)
    const text = one(option.value)
    if (text.length === 0 || seenText.has(text)) continue
    seenText.add(text)
    parts.push(text)
  }
  return parts.join(' · ')
}

/** 面板气泡里的三行。 */
export function bubbleLines(view: UsageView, now: number): string[] {
  return [
    view.fiveHour ? `5 小时窗口 ${pct(view.fiveHour.percentUsed)}` : '额度窗口 —',
    usdEstimate(view.costUsd),
    view.fiveHour?.resetsAt ? `${countdown(view.fiveHour.resetsAt, now)} 后重置` : '',
  ].filter(line => line.length > 0)
}

/**
 * 用量条能显示的口径，面板与默认值共用。
 *
 * 这几项的次序就是拼接口径的次序——读者选了「额度窗口」与「代码改动」时，
 * 条子上先出现额度、再出现改动，不会因为勾选先后而变。标签必须与
 * `bandSummary` 里 `one()` 真正画出来的内容对上，否则勾「上下文占用」却
 * 看到 `5h 23% · 7d 41%` 那种错位。
 */
export const BAND_METRIC_OPTIONS: ReadonlyArray<{ value: BandMetric; label: string }> = [
  { value: 'window', label: '额度窗口' },
  { value: 'context', label: '上下文占用' },
  { value: 'cost', label: '5h + 7d' },
  { value: 'session', label: '本会话花费' },
  { value: 'diff', label: '代码改动' },
]

/**
 * 本地数据的「新鲜度」：距上次扫描多久。
 *
 * `isStale` 超过两个扫描周期时为真，界面据此提示「数据可能过期」。
 * 没有扫描过（`lastRunAt` 为 null）不算过期，那是「还没跑」。
 */
export function freshnessOf(
  lastRunAt: number | null,
  now: number,
  scanIntervalMs: number,
): { ageMs: number | null; text: string; isStale: boolean } {
  if (lastRunAt === null) return { ageMs: null, text: '尚未统计', isStale: false }
  const ageMs = Math.max(0, now - lastRunAt)
  const minutes = Math.floor(ageMs / 60_000)
  const text =
    minutes < 1 ? '刚刚更新' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`
  // 间隔为 0（只在手动刷新时扫）时不判过期——那是用户的选择。
  const isStale = scanIntervalMs > 0 && ageMs > scanIntervalMs * 2
  return { ageMs, text, isStale }
}
