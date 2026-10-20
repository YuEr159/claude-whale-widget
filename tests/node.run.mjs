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
import { BAND_METRIC_OPTIONS, bandSummary, freshnessOf, toUsageView } from '../hooks/usage-view.ts'
import {
  addModelSpend,
  contextHeadline,
  contextRowText,
  countPatchLines,
  detailOf,
  duration,
  limitRows,
  meterText,
  sortModelSpends,
  toContextDetail,
  unpricedNote,
  windowSourceText,
} from '../hooks/usage-detail.ts'
import { WHALE_ASPECT, moodOf, whaleSvg, whaleWidthFor } from '../hooks/whale-art.ts'
import {
  barText,
  heatLevel,
  hourLabel,
  isPlaceholderModel,
  maskModel,
  modelRows,
  contextStack,
  rasterizeStacks,
  rasterizeTurnBars,
  turnBars,
  turnBarsCaption,
} from '../hooks/usage-overview.ts'

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

test('SVG 合法、文字转义、动画可选', () => {
  const svg = whaleSvg('idle', ['余额 <b>&', '¥1.23', '5m'])
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.endsWith('</svg>'))
  assert.ok(svg.includes('&lt;b&gt;&amp;'))
  assert.ok(!svg.includes('<b>'))
  assert.ok(!whaleSvg('sleep', ['休息'], { isAnimating: false }).includes('animateTransform'))
  assert.ok(whaleSvg('working', ['x']).includes('animateTransform'))
})

test('数据新鲜度：刚更新、分钟、小时、过期判定', () => {
  const now = 1_000_000
  const never = freshnessOf(null, now, 300_000)
  assert.equal(never.text, '尚未统计')
  assert.equal(never.isStale, false)

  assert.equal(freshnessOf(now - 30_000, now, 300_000).text, '刚刚更新')

  const five = freshnessOf(now - 5 * 60_000, now, 300_000)
  assert.equal(five.text, '5 分钟前')
  assert.equal(five.isStale, false)

  assert.equal(freshnessOf(now - 11 * 60_000, now, 300_000).isStale, true)
  assert.equal(freshnessOf(now - 90 * 60_000, now, 300_000).text, '1 小时前')
  assert.equal(freshnessOf(now - 99 * 60_000, now, 0).isStale, false)
})

test('额度窗口按原生 /usage 的标题与顺序排列', () => {
  const rows = limitRows([
    { kind: 'seven_day', percentUsed: 70 },
    { kind: 'five_hour', percentUsed: 40 },
    { kind: 'seven_day_sonnet', percentUsed: 22 },
    { kind: 'spend_limit', percentUsed: 88 },
  ])
  assert.deepEqual(rows.map(r => r.title), [
    'Current session',
    'Current week (all models)',
    'Current week (Sonnet only)',
    'spend_limit',
  ])
})

test('额度条、时长、diff 计行', () => {
  assert.equal(meterText(50), '█████░░░░░')
  assert.equal(meterText(140), '██████████')
  assert.equal(duration(3_725_000), '1h 2m 5s')
  assert.deepEqual(
    countPatchLines([{ lines: ['@@ x @@', '--- a', '+++ b', ' same', '-old', '+new', '+more'] }]),
    { added: 2, removed: 1 },
  )
})

test('按模型累加与排序', () => {
  const one = addModelSpend([], {
    model: 'claude-opus-5-5', input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.5, turns: 1,
  })
  const two = addModelSpend(one, {
    model: 'claude-opus-5-5', input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0.25, turns: 1,
  })
  assert.equal(two[0].input, 300)
  assert.ok(Math.abs((two[0].cost ?? 0) - 0.75) < 1e-9)
  assert.equal(two[0].turns, 2)

  const sorted = sortModelSpends([
    { model: 'unknown-x', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, turns: 9 },
    { model: 'claude-opus', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2, turns: 1 },
  ])
  assert.equal(sorted[0].model, 'claude-opus')
  assert.ok(unpricedNote(sorted)?.includes('unknown-x'))
})

test('上下文 breakdown 整形', () => {
  const detail = toContextDetail({
    categories: [
      { name: 'Messages', tokens: 40_000, kind: 'used', color: 'promptBorder' },
      { name: 'Free space', tokens: 50_000, kind: 'free', color: 'inactive' },
    ],
    totalTokens: 50_000,
    rawMaxTokens: 100_000,
    percentage: 50,
    autocompactSource: 'auto',
    isAutoCompactEnabled: true,
    autoCompactThreshold: 90_000,
    model: 'Opus 5.5',
    gridRows: [[
      { categoryName: 'Messages', color: 'promptBorder', isFilled: true },
      { categoryName: 'Free space', color: 'inactive', isFilled: false },
    ]],
    memoryFiles: [{ path: '/x/CLAUDE.md', type: 'Project', tokens: 1200 }],
    mcpTools: [{ name: 'mcp__linear__issue', serverName: 'linear', tokens: 800 }],
    agents: [{ agentType: 'Explore', source: 'builtin', tokens: 300 }],
    skills: { totalSkills: 10, includedSkills: 4, tokens: 900 },
    slashCommands: { totalCommands: 6, includedCommands: 6, tokens: 400 },
  })
  assert.ok(detail)
  if (!detail) return
  assert.equal(detail?.rows.length, 2)
  assert.deepEqual(detail?.grid[0][0], { name: 'Messages', color: 'promptBorder', isFilled: true })
  assert.equal(detail?.grid[0][1].isFilled, false)
  assert.ok(contextHeadline(detail).includes('上下文 50%'))
  assert.ok(windowSourceText(detail).includes('模型自身上限'))
  assert.ok(contextRowText(detail.rows[0]).includes('(40%)'))
  assert.equal(toContextDetail({ categories: [] }), undefined)
})

test('面板详细程度默认详细', () => {
  assert.equal(detailOf({}), 'detail')
  assert.equal(detailOf({ panelDetail: 'simple' }), 'simple')
})


test('用量条摘要按偏好切换口径', () => {
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
  assert.equal(
    bandSummary(toUsageView({ rateLimits: [], cost: { usd: 0.5 }, context: { window: 200_000, percent: 33 } }), 'window', 0),
    '上下文 33% · 本会话 $0.50',
  )
  assert.deepEqual(BAND_METRIC_OPTIONS.map(o => o.value).sort(), ['context', 'cost', 'session', 'window'].sort())
})

test('鲸鱼尺寸连续，高度严格按画布比例', () => {
  let maxJump = 0
  for (let columns = 16; columns <= 140; columns += 1) {
    const jump = Math.abs(whaleWidthFor(columns + 1) - whaleWidthFor(columns))
    if (jump > maxJump) maxJump = jump
  }
  assert.ok(maxJump <= 5, `最大跳变 ${maxJump}px`)
  assert.equal(whaleWidthFor(10), 150)
  assert.equal(whaleWidthFor(200), 300)
  assert.ok(Math.abs((200 * WHALE_ASPECT) / 200 - 320 / 620) < 1e-12)
})

test('概览与模型页的整形', () => {
  assert.equal(hourLabel(17), '5 PM')
  assert.equal(hourLabel(0), '12 AM')
  assert.ok(maskModel('deepseek-v4-flash').includes('*'))
  assert.equal(heatLevel(90, 100), 4)
  assert.equal(heatLevel(0, 100), 0)
  assert.ok(isPlaceholderModel('auto'))
  assert.ok(!isPlaceholderModel('deepseek-v4-flash'))

  const rows = modelRows([
    { model: 'auto', isPriced: false, input: 900, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 90 },
    { model: 'deepseek-v4-flash', isPriced: false, input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 10 },
  ])
  assert.deepEqual(rows.map(r => r.model), ['deepseek-v4-flash'])
  assert.equal(rows[0].cost, null)
  assert.equal(rows[0].share, 1)
  assert.equal(barText(1, 4), '████')
})

test('上下文堆叠柱与轮次柱', () => {
  const { bars, peak } = contextStack([
    { seq: 1, percent: 20, tokens: 1000, at: 0 },
    { seq: 2, percent: 90, tokens: 2000, at: 1 },
  ], 24, 10)
  assert.equal(bars.length, 2)
  assert.equal(peak, 90)
  for (const bar of bars) {
    const total = bar.segments.reduce((sum, s) => sum + s.ratio, 0)
    assert.ok(Math.abs(total - 1) < 1e-9)
  }
  assert.equal(rasterizeStacks(bars, 4).length, 4)

  const tb = turnBars([
    { day: '2026-10-18', turns: 10 },
    { day: '2026-10-20', turns: 30 },
  ], 4)
  assert.equal(tb.length, 4)
  assert.equal(tb[tb.length - 1].turns, 30)
  assert.equal(tb[tb.length - 1].ratio, 1)
  assert.equal(tb.find(b => b.day === '2026-10-19').turns, 0)
  assert.ok(turnBarsCaption(tb).includes('峰值 30 轮'))
})
