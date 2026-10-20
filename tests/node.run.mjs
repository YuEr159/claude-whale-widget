#!/usr/bin/env node
/**
 * 不依赖 `claude plugin test`（旧版 CLI 没有这个子命令）的等价测试运行器。
 *
 * `tests/unit.test.ts` 是给新版本 `claude plugin test` 用的正式用例；这里用
 * node 直接跑同一批断言，保证在任何装了 Node 的机器上都能验证纯函数与 SVG。
 *
 * 因为 .ts 在旧 Node 上不能直接 import，这里用 esbuild-free 的做法：把源文件
 * 里用到的纯函数在运行时用 `node --experimental-strip-types` 编译执行。
 * Node 22.6+ 支持 `--experimental-strip-types`；本机 Node 24 已默认支持 .ts。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { costOf, priceOf } from '../hooks/pricing.ts'
import { clip, countdown, pct, tokens, usd } from '../hooks/format.ts'
import { bandSummary, toUsageView } from '../hooks/usage-view.ts'
import { moodOf, whaleSvg } from '../hooks/whale-art.ts'

test('价格表只认官方模型，缓存按 1.25x / 0.1x', () => {
  const opus = priceOf('claude-opus-5-5')
  assert.ok(opus)
  assert.equal(opus.input, 4)
  assert.ok(Math.abs(opus.cacheWrite - 5) < 1e-9)
  assert.ok(Math.abs(opus.cacheRead - 0.4) < 1e-9)
  assert.equal(priceOf('deepseek-v4-flash'), undefined)
  assert.equal(priceOf('qwen3.8-27b'), undefined)
  assert.equal(priceOf('<synthetic>'), undefined)
  assert.equal(priceOf('auto'), undefined)
})

test('长前缀优先匹配', () => {
  assert.equal(priceOf('claude-opus-5-5')?.input, 4)
  assert.equal(priceOf('claude-opus-5')?.input, 5)
})

test('一轮花费四类 token 相加', () => {
  const cost = costOf('claude-opus-5-5', {
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite: 1_000_000,
    cacheRead: 1_000_000,
  })
  assert.ok(Math.abs((cost ?? 0) - 29.4) < 1e-6)
})

test('未收录模型不产生金额', () => {
  assert.equal(
    costOf('some-gateway-model', { input: 1000, output: 1000, cacheWrite: 0, cacheRead: 0 }),
    undefined,
  )
})

test('金额格式化', () => {
  assert.equal(usd(0), '$0')
  assert.equal(usd(0.0034), '$0.0034')
  assert.equal(usd(0.345), '$0.345')
  assert.equal(usd(12.3456), '$12.35')
  assert.equal(usd(undefined), '—')
})

test('百分比与 token', () => {
  assert.equal(pct(23.5), '24%')
  assert.equal(pct(7), '7%')
  assert.equal(pct(undefined), '—')
  assert.equal(tokens(1234), '1234')
  assert.equal(tokens(15_721), '1.6万')
  assert.equal(tokens(2.5e8), '2.50亿')
})

test('倒计时分档', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  assert.equal(countdown('2026-10-20T14:13:00Z', now), '2h13m')
  assert.equal(countdown('2026-10-20T12:45:00Z', now), '45m')
  assert.equal(countdown('2026-10-22T15:00:00Z', now), '2d3h')
  assert.equal(countdown('2026-10-20T11:00:00Z', now), '即将重置')
  assert.equal(countdown(undefined, now), '')
})

test('截断', () => {
  assert.equal(clip('abcdef', 10), 'abcdef')
  assert.equal(clip('abcdef', 4), 'abc…')
})

test('情绪随用量', () => {
  assert.equal(moodOf(10, false), 'idle')
  assert.equal(moodOf(10, true), 'working')
  assert.equal(moodOf(60, false), 'busy')
  assert.equal(moodOf(85, false), 'tired')
  assert.equal(moodOf(98, false), 'sleep')
  assert.equal(moodOf(undefined, true), 'working')
})

test('usage 视图挑窗口', () => {
  const view = toUsageView({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-20T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 61 },
    ],
    cost: { usd: 1.25 },
    context: { tokens: 1000, window: 1_000_000, percent: 0.1 },
  })
  assert.equal(view.fiveHour?.percentUsed, 23.5)
  assert.equal(view.sevenDay?.percentUsed, 61)
  assert.equal(view.costUsd, 1.25)
  assert.equal(view.contextPercent, 0.1)
})

test('常驻条摘要口径', () => {
  const view = toUsageView({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-20T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 70 },
    ],
    cost: { usd: 2 },
    context: { window: 1_000_000, percent: 12 },
  })
  const now = Date.parse('2026-10-20T12:00:00Z')
  assert.ok(bandSummary(view, 'window', now).includes('5h 40%'))
  assert.equal(bandSummary(view, 'session', now), '本会话 $2.00')
  assert.equal(bandSummary(view, 'cost', now), '上下文 12%')
  assert.equal(bandSummary(view, 'context', now), '5h 40% · 7d 70%')
})

test('无额度窗口时退回上下文 + 会话花费', () => {
  const view = toUsageView({
    rateLimits: [],
    cost: { usd: 0.5 },
    context: { window: 200_000, percent: 33 },
  })
  assert.equal(bandSummary(view, 'window', 0), '上下文 33% · 本会话 $0.50')
})

test('SVG 合法、文字转义、动画可选', () => {
  const svg = whaleSvg('idle', ['余额 <b>&', '¥1.23', '5m'])
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.endsWith('</svg>'))
  assert.ok(svg.includes('&lt;b&gt;&amp;'))
  assert.ok(!svg.includes('<b>'))
  assert.ok(!whaleSvg('sleep', ['休息'], { isAnimating: false }).includes('animateTransform'))
  assert.ok(whaleSvg('working', ['x']).includes('animateTransform'))
})
