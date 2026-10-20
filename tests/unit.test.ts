/**
 * 单元与渲染测试：`claude plugin test .` 会用引擎自己的宿主跑这些用例。
 *
 * 只测纯函数与「画出来的树」，不测任何 surface 的像素绘制。
 */
import { test, expect } from 'claude-code/testing'

import { costOf, priceOf } from '../hooks/pricing'
import { clip, countdown, pct, tokens, usd } from '../hooks/format'
import { bandSummary, toUsageView } from '../hooks/usage-view'
import { moodOf, whaleSvg } from '../hooks/whale-art'

test('价格表只认官方模型，且缓存按 1.25x / 0.1x 计', () => {
  const opus = priceOf('claude-opus-5-5')
  expect(opus).toBeDefined()
  expect(opus?.input).toBe(4)
  expect(Math.abs((opus?.cacheWrite ?? 0) - 5)).toBeLessThan(1e-9)
  expect(Math.abs((opus?.cacheRead ?? 0) - 0.4)).toBeLessThan(1e-9)

  // 第三方模型、合成消息、通配都不该套用官方价格
  expect(priceOf('deepseek-v4-flash')).toBeUndefined()
  expect(priceOf('qwen3.8-27b')).toBeUndefined()
  expect(priceOf('<synthetic>')).toBeUndefined()
  expect(priceOf('auto')).toBeUndefined()
})

test('长的模型前缀优先匹配', () => {
  // claude-opus-5-5 必须先于 claude-opus-5 命中，否则价格会错
  expect(priceOf('claude-opus-5-5')?.input).toBe(4)
  expect(priceOf('claude-opus-5')?.input).toBe(5)
})

test('一轮的美元花费按四类 token 相加', () => {
  // 1M 输入 @ $4 + 1M 输出 @ $20 + 1M 缓存写 @ $5 + 1M 缓存读 @ $0.4
  const cost = costOf('claude-opus-5-5', {
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite: 1_000_000,
    cacheRead: 1_000_000,
  })
  expect(Math.abs((cost ?? 0) - 29.4)).toBeLessThan(1e-6)
})

test('未收录模型不产生估算金额', () => {
  expect(
    costOf('some-gateway-model', { input: 1000, output: 1000, cacheWrite: 0, cacheRead: 0 }),
  ).toBeUndefined()
})

test('金额格式化：小额多保留几位，0 不显示小数', () => {
  expect(usd(0)).toBe('$0')
  expect(usd(0.0034)).toBe('$0.0034')
  expect(usd(0.345)).toBe('$0.345')
  expect(usd(12.3456)).toBe('$12.35')
  expect(usd(undefined)).toBe('—')
})

test('百分比与 token 取整', () => {
  expect(pct(23.5)).toBe('24%')
  expect(pct(7)).toBe('7%')
  expect(pct(undefined)).toBe('—')
  expect(tokens(1234)).toBe('1234')
  expect(tokens(15_721)).toBe('1.6万')
  expect(tokens(2.5e8)).toBe('2.50亿')
})

test('重置倒计时按小时/天/分钟分档', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  expect(countdown('2026-10-20T14:13:00Z', now)).toBe('2h13m')
  expect(countdown('2026-10-20T12:45:00Z', now)).toBe('45m')
  expect(countdown('2026-10-22T15:00:00Z', now)).toBe('2d3h')
  expect(countdown('2026-10-20T11:00:00Z', now)).toBe('即将重置')
  expect(countdown(undefined, now)).toBe('')
})

test('长文本按宽度截断并补省略号', () => {
  expect(clip('abcdef', 10)).toBe('abcdef')
  expect(clip('abcdef', 4)).toBe('abc…')
})

test('情绪随用量升高而变差，工作中优先显示工作态', () => {
  expect(moodOf(10, false)).toBe('idle')
  expect(moodOf(10, true)).toBe('working')
  expect(moodOf(60, false)).toBe('busy')
  expect(moodOf(85, false)).toBe('tired')
  expect(moodOf(98, false)).toBe('sleep')
  expect(moodOf(undefined, true)).toBe('working')
})

test('usage 视图挑出 5h/7d 两个窗口', () => {
  const view = toUsageView({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-20T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 61 },
    ],
    cost: { usd: 1.25 },
    context: { tokens: 1000, window: 1_000_000, percent: 0.1 },
  })
  expect(view.fiveHour?.percentUsed).toBe(23.5)
  expect(view.sevenDay?.percentUsed).toBe(61)
  expect(view.costUsd).toBe(1.25)
  expect(view.contextPercent).toBe(0.1)
})

test('常驻条摘要按偏好切换口径', () => {
  const view = toUsageView({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-20T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 70 },
    ],
    cost: { usd: 2 },
    context: { window: 1_000_000, percent: 12 },
  })
  const now = Date.parse('2026-10-20T12:00:00Z')
  expect(bandSummary(view, 'window', now)).toContain('5h 40%')
  expect(bandSummary(view, 'session', now)).toBe('本会话 $2.00')
  expect(bandSummary(view, 'cost', now)).toBe('上下文 12%')
  expect(bandSummary(view, 'context', now)).toBe('5h 40% · 7d 70%')
})

test('没有额度窗口时退回上下文与会话花费', () => {
  const view = toUsageView({ rateLimits: [], cost: { usd: 0.5 }, context: { window: 200_000, percent: 33 } })
  expect(bandSummary(view, 'window', 0)).toBe('上下文 33% · 本会话 $0.50')
})

test('SVG 是合法标签，文字做了转义，动画可选', () => {
  const svg = whaleSvg('idle', ['余额 <b>&', '¥1.23', '5m'])
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.endsWith('</svg>')).toBe(true)
  // 用户可读的文字必须转义，不能把尖括号原样塞进 markup
  expect(svg).toContain('&lt;b&gt;&amp;')
  expect(svg).not.toContain('<b>')

  const still = whaleSvg('sleep', ['休息'], { isAnimating: false })
  expect(still).not.toContain('animateTransform')
  expect(whaleSvg('working', ['x'])).toContain('animateTransform')
})
