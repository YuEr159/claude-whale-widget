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

/** 从 `$.session.usage()` 的返回里挑出界面要用的字段。 */
export function toUsageView(usage: {
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
  context: { tokens?: number; window: number; percent?: number }
}): UsageView {
  const fiveHour = usage.rateLimits.find(limit => limit.kind === 'five_hour')
  const sevenDay = usage.rateLimits.find(limit => limit.kind === 'seven_day')
  return {
    fiveHour,
    sevenDay,
    costUsd: usage.cost?.usd,
    contextPercent: usage.context.percent,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
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
