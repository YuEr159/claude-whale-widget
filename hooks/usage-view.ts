/**
 * 纯计算：把一次 `$.session.usage()` 的结果整理成界面要的几行文字。
 *
 * 这里不碰 `$`，只做数据整形，方便单测，也避免把 `$` 传进辅助函数
 * （插件校验器要求 `$` 只出现在 `$.noun.method(...)` 的调用点）。
 */
import type { Prefs } from '../types'
import { pct, countdown, usd } from './format.ts'

export type RateLimitView = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type UsageView = {
  fiveHour?: RateLimitView
  sevenDay?: RateLimitView
  costUsd?: number
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
}

/** 从一个未知形状的 usage 结果里挑字段；形状不对就当作「没有数据」。 */
export function toUsageView(usage: unknown): UsageView {
  if (!usage || typeof usage !== 'object') return {}
  const source = usage as {
    rateLimits?: unknown
    cost?: { usd?: unknown } | null
    context?: { tokens?: unknown; window?: unknown; percent?: unknown } | null
  }

  const limits = Array.isArray(source.rateLimits) ? source.rateLimits : []
  const pick = (kind: string): RateLimitView | undefined => {
    const hit = limits.find(
      (item): item is RateLimitView =>
        !!item &&
        typeof item === 'object' &&
        (item as { kind?: unknown }).kind === kind &&
        typeof (item as { percentUsed?: unknown }).percentUsed === 'number',
    )
    return hit ?? undefined
  }

  const context = source.context
  const cost = source.cost

  return {
    fiveHour: pick('five_hour'),
    sevenDay: pick('seven_day'),
    costUsd: typeof cost?.usd === 'number' ? cost.usd : undefined,
    contextPercent: typeof context?.percent === 'number' ? context.percent : undefined,
    contextTokens: typeof context?.tokens === 'number' ? context.tokens : undefined,
    contextWindow: typeof context?.window === 'number' ? context.window : undefined,
  }
}

/** 常驻条那一行摘要，按偏好切换口径。 */
export function bandSummary(view: UsageView, metric: Prefs['bandMetric'], now: number): string {
  const five = pct(view.fiveHour?.percentUsed)
  const seven = pct(view.sevenDay?.percentUsed)
  switch (metric) {
    case 'session':
      return `本会话 ${usd(view.costUsd)}`
    case 'cost':
      return `上下文 ${pct(view.contextPercent)}`
    case 'context':
      return `5h ${five} · 7d ${seven}`
    default:
      // 没有订阅额度窗口时（第三方网关、API key 计费），退回上下文占用 + 会话花费，
      // 这两项在任何计费方式下都有读数。
      if (!view.fiveHour && !view.sevenDay) {
        return `上下文 ${pct(view.contextPercent)} · 本会话 ${usd(view.costUsd)}`
      }
      return view.fiveHour
        ? `5h ${five} · ${countdown(view.fiveHour.resetsAt, now)} 后重置`
        : `5h ${five} · 7d ${seven}`
  }
}

/** 面板气泡里的三行。 */
export function bubbleLines(view: UsageView, now: number): string[] {
  return [
    view.fiveHour ? `5 小时窗口 ${pct(view.fiveHour.percentUsed)}` : '额度窗口 —',
    usd(view.costUsd),
    view.fiveHour?.resetsAt ? `${countdown(view.fiveHour.resetsAt, now)} 后重置` : '',
  ].filter(line => line.length > 0)
}
