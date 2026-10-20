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
import { clip, countdown, displayWidth, padCell, pct, tokens, usd } from '../hooks/format.ts'
import { BAND_METRIC_OPTIONS, bandDiffText, bandSummary, freshnessOf, toUsageView } from '../hooks/usage-view.ts'
import {
  addModelSpend,
  countPatchLines,
  duration,
  limitRows,
  meterText,
  sortModelSpends,
  toContextDetail,
  unpricedNote,
  windowSourceText,
} from '../hooks/usage-detail.ts'
import { WHALE_MIN_HEIGHT, moodOf, whaleSizeFor, whaleSvg } from '../hooks/whale-art.ts'
import {
  barText,
  canonicalModelName,
  heatLevel,
  hourLabel,
  isPlaceholderModel,
  maskModel,
  modelDetailRows,
  modelGrainFor,
  modelGrainLabel,
  modelRows,
  modelStackBars,
  modelStackCaption,
  contextPartKind,
  contextParts,
  contextStack,
  stackLegendOf,
  rasterizeStacks,
  rasterizeTurnBars,
  turnBars,
  turnBarsCaption,
} from '../hooks/usage-overview.ts'
import {
  HEAT_CELL,
  HEAT_OPACITY,
  HEAT_ZERO_FILL,
  HEAT_ZERO_OPACITY,
  contextChartSvg,
  heatColumnCount,
  heatWindowDays,
  modelFill,
  modelStackSvg,
  pageOf,
  turnHeatHeight,
  turnHeatSvg,
} from '../hooks/chart-art.ts'
import { UNPRICED, usdEstimate } from '../hooks/provenance.ts'
import { CHART_PALETTES, FILLS, isLightTheme, panelFillFor } from '../hooks/panel-fill.ts'

test('价格表：官方模型按 1.25x / 0.1x 缓存计，DeepSeek Flash 单独一套', () => {
  const opus = priceOf('claude-opus-5-5')
  assert.ok(opus)
  assert.equal(opus.input, 4)
  assert.ok(Math.abs(opus.cacheWrite - 5) < 1e-9)
  assert.ok(Math.abs(opus.cacheRead - 0.4) < 1e-9)
  assert.equal(priceOf('<synthetic>'), undefined)
  assert.equal(priceOf('auto'), undefined)

  // DeepSeek Flash：非高峰价，缓存命中是输入价的 2%，不收缓存写入费。
  const flash = priceOf('deepseek-flash')
  assert.ok(flash)
  assert.equal(flash.input, 0.15)
  assert.equal(flash.output, 0.6)
  assert.equal(flash.cacheRead, 0.003)
  assert.equal(flash.cacheWrite, 0)
})

test('DeepSeek Flash 的型号写法大小写与前后缀都模糊识别', () => {
  // 网关里出现过的各种写法都要落到同一条规则上。
  for (const id of [
    'deepseek-flash',
    'DeepSeek-Flash',
    'DEEPSEEK-FLASH',
    'deepseek-v4-flash',
    'DeepSeek-V4.1-Flash-1017',
    'deepseek-ai/DeepSeek-Flash',
  ]) {
    assert.ok(priceOf(id), `${id} 应当被识别为 Flash`)
    assert.equal(priceOf(id).input, 0.15)
  }
  // 不是 Flash 的 DeepSeek 型号仍按未收录处理，不拿 Flash 的价硬套。
  assert.equal(priceOf('deepseek-v4-pro'), undefined)
  assert.equal(priceOf('deepseek-chat'), undefined)
})

test('Qwen 3.8 27B 与 Kimi K3 按 OpenRouter 基础价收录', () => {
  // 数字来自 OpenRouter 的模型接口，单位已从「每 token」换算成「每百万 token」。
  const qwen = priceOf('qwen3.8-27b')
  assert.ok(qwen)
  assert.equal(qwen.input, 0.04)
  assert.equal(qwen.output, 1.35)
  assert.equal(qwen.cacheRead, 0.018, '缓存读是输入价的 45%，不是 Anthropic 的 10%')
  assert.equal(qwen.cacheWrite, 0, '这类模型不单独收缓存写入费')
  // 网关会加命名空间前缀，也要认得出来。
  assert.equal(priceOf('qwen/qwen3.8-27b').input, 0.04)

  const kimi = priceOf('kimi-k3')
  assert.ok(kimi)
  assert.equal(kimi.input, 0.239)
  assert.equal(kimi.output, 11.936)
  assert.equal(kimi.cacheRead, 0.21)
  assert.equal(priceOf('moonshotai/kimi-k3').output, 11.936)
  assert.equal(priceOf('Kimi-K3').input, 0.239)

  // 金额按四类 token 相加，与手算一致。
  const cost = costOf('qwen3.8-27b', {
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite: 0,
    cacheRead: 1_000_000,
  })
  assert.ok(Math.abs(cost - (0.04 + 1.35 + 0.018)) < 1e-9)
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
  assert.deepEqual(detail?.rows[0], { name: 'Messages', tokens: 40_000, kind: 'used' })
  assert.ok(windowSourceText(detail).includes('模型自身上限'))
  assert.equal(toContextDetail({ categories: [] }), undefined)
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
  assert.ok(bandSummary(view, ['window'], now).includes('5h 40%'))
  // 金额一律带估算标记：面板里没有一笔钱来自账单。
  assert.equal(bandSummary(view, ['session'], now), '本会话 ≈$2.00')
  assert.equal(bandSummary(view, ['cost'], now), '上下文 12%')
  assert.equal(bandSummary(view, ['context'], now), '5h 40% · 7d 70%')
  assert.equal(
    bandSummary(toUsageView({ rateLimits: [], cost: { usd: 0.5 }, context: { window: 200_000, percent: 33 } }), ['window'], 0),
    '上下文 33% · 本会话 ≈$0.50',
  )
  // 多选：按固定次序拼接，与勾选先后无关；重复项只出现一次。
  assert.equal(
    bandSummary(view, ['context', 'window'], now),
    '5h 40% · 2h00m 后重置 · 5h 40% · 7d 70%',
  )
  assert.equal(
    bandSummary(view, ['window', 'context', 'window'], now),
    '5h 40% · 2h00m 后重置 · 5h 40% · 7d 70%',
  )
  assert.deepEqual(BAND_METRIC_OPTIONS.map(o => o.value).sort(), ['context', 'cost', 'diff', 'session', 'window'].sort())
})

test('代码改动：单独成段、零值省略、其余口径不重复', () => {
  const view = toUsageView({ rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], cost: { usd: 2 } })
  const now = Date.parse('2026-10-20T12:00:00Z')
  const diff = { added: 128, removed: 34 }

  assert.equal(bandSummary(view, ['diff'], now, diff), '+128 -34')
  assert.equal(bandSummary(view, ['diff'], now, { added: 0, removed: 0 }), '本会话还没有代码改动')
  // 其余口径的摘要里不含改动：增删要分色，由渲染层追加。
  assert.ok(!bandSummary(view, ['window'], now, diff).includes('+128'))
  // 只有一边有改动时，零的那一边不显示。
  assert.equal(bandDiffText({ added: 5, removed: 0 }), '+5')
  assert.equal(bandDiffText({ added: 0, removed: 3 }), '-3')
  assert.equal(bandDiffText({ added: 0, removed: 0 }), '')
})

test('鲸鱼尺寸连续，高度严格按画布比例且不低于最小高度', () => {
  let maxJump = 0
  for (let columns = 16; columns <= 140; columns += 1) {
    const jump = Math.abs(whaleSizeFor(columns + 1).width - whaleSizeFor(columns).width)
    if (jump > maxJump) maxJump = jump
  }
  assert.ok(maxJump <= 5, `最大跳变 ${maxJump}px`)
  assert.equal(whaleSizeFor(200).width, 300)
  for (const columns of [1, 10, 40, 100, 200]) {
    const { width, height } = whaleSizeFor(columns)
    assert.ok(Math.abs(height / width - 320 / 620) < 1e-12, `${columns} 列比例失守`)
    assert.ok(height >= WHALE_MIN_HEIGHT - 1e-9, `${columns} 列高度 ${height} 低于下限`)
  }
})

test('概览与模型页的整形', () => {
  assert.equal(hourLabel(17), '5 PM')
  assert.equal(hourLabel(0), '12 AM')
  assert.equal(maskModel('deepseek-v4-flash'), 'deepseek-v4-flash')
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

test('模型名归并：同一款模型的几种写法合成一行', () => {
  // 网关会给同一个模型换着写法记，四种写法都该落到同一个展示名上。
  for (const id of [
    'deepseek-flash',
    'DeepSeek-Flash',
    'deepseek-v4-flash',
    'deepseek-v4-1-flash',
    'deepseek-ai/DeepSeek-Flash',
  ]) {
    assert.equal(canonicalModelName(id), 'DeepSeek Flash', `${id} 应当归并为 DeepSeek Flash`)
  }
  // 不同档位不合并。
  assert.equal(canonicalModelName('deepseek-v4-pro'), 'DeepSeek Pro')
  assert.equal(canonicalModelName('GLM-5.3-Flash'), 'GLM Flash')
  assert.notEqual(canonicalModelName('GLM-5.3'), 'GLM Flash')
  assert.equal(canonicalModelName('kimi-k3'), 'Kimi')
  // 认不出的原样保留，不被吞成一个兜底名。
  assert.equal(canonicalModelName('probe'), 'probe')
})

test('模型明细：归并后金额相加，全无价格才是 null', () => {
  const rows = modelDetailRows([
    // 同一款 Flash 的两个写法：各自的估算值要加起来。
    { model: 'deepseek-flash', isPriced: true, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.15, messages: 10 },
    { model: 'DeepSeek-Flash', isPriced: true, input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: 0.6, messages: 5 },
    // 没有价格的模型：金额是 null，不是 0。
    { model: 'qwen3.8-27b', isPriced: false, input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 },
    // 占位标识不进表。
    { model: 'auto', isPriced: false, input: 900, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 9 },
  ])

  assert.equal(rows.length, 2, '两个 Flash 写法应当合成一行，占位标识被过滤')
  const flash = rows.find(row => row.model === 'DeepSeek Flash')
  assert.ok(flash)
  assert.equal(flash.input, 1_000_000)
  assert.equal(flash.output, 1_000_000)
  assert.ok(Math.abs((flash.cost ?? 0) - 0.75) < 1e-9, '两个写法的金额应当相加')
  assert.deepEqual(flash.aliases.sort(), ['DeepSeek-Flash', 'deepseek-flash'].sort())

  const qwen = rows.find(row => row.model === 'Qwen 27B')
  assert.ok(qwen)
  assert.equal(qwen.cost, null, '没有公开价格的模型不该记成 0')
})

test('表格对齐：按显示宽度补空格，中文与英文混排也不歪', () => {
  // 中文占两格：`模型` 是 4 列宽，不是 2。
  assert.equal(displayWidth('模型'), 4)
  assert.equal(displayWidth('DeepSeek Flash'), 14)
  assert.equal(displayWidth('abc'), 3)
  // 补到同一宽度后，显示宽度必须相等——否则表格会歪。
  const cells = ['模型', 'DeepSeek Flash', 'Qwen 27B', 'GLM Flash']
  const widths = cells.map(text => displayWidth(padCell(text, 14)))
  assert.deepEqual(new Set(widths), new Set([14]))
  // 右对齐：空格在前。
  assert.equal(padCell('5', 4, 'right'), '   5')
  assert.equal(padCell('5', 4, 'left'), '5   ')
  // 超宽时按显示宽度截断，不留半格。
  assert.ok(displayWidth(clip('DeepSeek Flash', 6)) <= 6)
})

test('上下文堆叠柱与轮次柱', () => {
  const { bars, peak, yMax } = contextStack([
    { seq: 1, percent: 20, tokens: 1000, at: 0 },
    { seq: 2, percent: 90, tokens: 2000, at: 1 },
  ], 24, 10)
  assert.equal(bars.length, 2)
  assert.equal(peak, 90)
  // 纵轴自适应：取峰值（90 + 10 缓冲）的 1.1 倍并向上取整到 5 的倍数 = 110 → 夹到 100。
  assert.equal(yMax, 100)
  // 柱子的总高是「已用 + 缓冲」占纵轴的比例，不再是恒定 100%。
  for (const bar of bars) {
    const total = bar.segments.reduce((sum, s) => sum + s.ratio, 0)
    assert.ok(total <= 1 + 1e-9, `柱子溢出：${total}`)
    assert.ok(total > 0)
  }
  assert.equal(rasterizeStacks(bars, 4).length, 4)

  const tb = turnBars([
    { day: '2026-10-18', turns: 10, messages: 100 },
    { day: '2026-10-20', turns: 30, messages: 300 },
  ], 4)
  assert.equal(tb.length, 4)
  assert.equal(tb[tb.length - 1].turns, 30)
  assert.equal(tb[tb.length - 1].ratio, 1)
  assert.equal(tb.find(b => b.day === '2026-10-19').turns, 0)
  // 图注同时给轮次与消息数：两个量都是读者会问的「这段时间用了多少」。
  assert.ok(turnBarsCaption(tb).includes('40 轮'))
  assert.ok(turnBarsCaption(tb).includes('400 条消息'))
})

test('纵轴自适应：低用量时柱子矮，不必撑满画布', () => {
  // 整段用量都只有两三成：旧几何下柱子照样满格，看不出「其实很空」。
  const { bars, yMax } = contextStack([
    { seq: 1, percent: 20, tokens: 1, at: 0 },
    { seq: 2, percent: 30, tokens: 1, at: 1 },
  ], 24, 0)
  // 峰值 30 → 1.1 倍向上取整到 5 的倍数 = 35。
  assert.equal(yMax, 35)
  const heights = bars.map(bar => bar.segments.reduce((sum, s) => sum + s.ratio, 0))
  // 最高那根顶到 30/35 ≈ 86%，留一点头；矮的那根明显更矮。
  assert.ok(Math.abs(heights[1] - 30 / 35) < 1e-9)
  assert.ok(Math.abs(heights[0] - 20 / 35) < 1e-9)
  // 自适应模式不画空闲段：它会把柱子重新补满，抵消自适应的意义。
  assert.ok(!bars.some(bar => bar.segments.some(s => s.kind === 'free')))
})

test('图表翻页：0 贴住最新，越翻越往历史走', () => {
  const items = Array.from({ length: 60 }, (_, index) => index)
  const newest = pageOf(items, 24, 0)
  assert.deepEqual(newest.slice, items.slice(36, 60))
  assert.equal(newest.pages, 3)
  assert.equal(newest.page, 3)
  assert.equal(newest.maxOffset, 2)

  const older = pageOf(items, 24, 1)
  assert.deepEqual(older.slice, items.slice(12, 36))
  assert.equal(older.page, 2)

  const oldest = pageOf(items, 24, 99)
  assert.deepEqual(oldest.slice, items.slice(0, 12))
  assert.equal(oldest.page, 1)

  // 不足一页时只有一页，翻不动。
  const tiny = pageOf(items.slice(0, 5), 24, 3)
  assert.equal(tiny.slice.length, 5)
  assert.equal(tiny.maxOffset, 0)
  assert.equal(tiny.pages, 1)
})

test('轮次热图：窗口固定（默认半年），不再分页', () => {
  // 数据跨 30 天：窗口给 7 天时就只画最后 7 天，给 180 天时补齐成 180 格。
  const days = [
    { day: '2026-09-21', turns: 3, messages: 30 },
    { day: '2026-10-20', turns: 9, messages: 90 },
  ]
  const bars = turnBars(days, 7)
  assert.equal(bars.length, 7)
  assert.equal(bars[bars.length - 1].day, '2026-10-20')
  assert.equal(bars[bars.length - 1].turns, 9)
  // 180 天窗口：缺的日子补 0，时间轴不断档。
  const half = turnBars(days, 180)
  assert.equal(half.length, 180)
  assert.equal(half[half.length - 1].day, '2026-10-20')
  assert.equal(half.filter(bar => bar.turns === 0).length, 178)
})

test('两张图在空数据时也给出合法 SVG', () => {
  for (const svg of [contextChartSvg([], 320), turnHeatSvg([], 320, 7)]) {
    assert.ok(svg.startsWith('<svg'))
    assert.ok(svg.endsWith('</svg>'))
    assert.ok(!svg.includes('NaN'))
  }
})

test('轮次热图：方块固定大小、按周分列、色标随当屏最大值自适应', () => {
  // 每天唯一：日期重复会被按天索引覆盖，测出来的就不是「有高有低」的分布。
  const days = Array.from({ length: 60 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, 1 + index))
    return {
      day: date.toISOString().slice(0, 10),
      turns: index === 3 ? 40 : 4,
      messages: index === 3 ? 400 : 40,
    }
  })
  const svg = turnHeatSvg(days, 320)

  // 圆角矩形：rx 与 ry 都在且相等，宽高相等（圆角正方）。
  // 属性顺序不固定，所以逐条 rect 里按名取，不靠位置。
  const rects = [...svg.matchAll(/<rect\b([^>]*)>/g)].map(m => m[1])
  assert.ok(rects.length > 0, '应当画出方块')
  const attr = (body, name) => {
    const hit = new RegExp(`${name}="([\\d.]+)"`).exec(body)
    return hit ? Number(hit[1]) : undefined
  }
  for (const body of rects) {
    assert.equal(attr(body, 'rx'), attr(body, 'ry'), '圆角两轴必须相等')
    assert.equal(attr(body, 'width'), attr(body, 'height'), '方块必须是正方形')
    // 方块大小固定：与窗口宽度无关。
    assert.equal(attr(body, 'width'), HEAT_CELL, '方块边长应当是固定值')
  }
  const ys = new Set(rects.map(body => attr(body, 'y')))
  assert.equal(ys.size, 7, '固定 7 行')

  // 色标自适应：最热的那天用最不透明的一档，其余按比例落在较淡的档。
  assert.ok(svg.includes(`fill-opacity="${HEAT_OPACITY[4].toFixed(2)}"`), '最热的一格应当最实')
  assert.ok(svg.includes(`fill-opacity="${HEAT_OPACITY[1].toFixed(2)}"`), '低用量的一格应当较淡')

  // 同样的数据、把峰值拉高，最热色仍出现（说明是按当屏最大值算，不是绝对阈值）
  const hotter = days.map(d => (d.turns > 0 ? { ...d, turns: d.turns * 10 } : d))
  const hotSvg = turnHeatSvg(hotter, 320)
  assert.ok(hotSvg.includes(`fill-opacity="${HEAT_OPACITY[4].toFixed(2)}"`))
})

test('热图默认按消息数着色，0 值用中性底而不是最淡一档', () => {
  // 三天里中间那天没有用量：`turnBars` 补出来的 0 值格子必须与「用量最少
  // 的一格」区分开。窗口跨度由数据自己决定（这里是 3 天）。
  const days = [
    { day: '2026-10-18', turns: 5, messages: 500 },
    { day: '2026-10-20', turns: 1, messages: 10 },
  ]
  // 默认口径就是消息数：不看参数也该按消息着色。
  const svg = turnHeatSvg(days, 320)
  assert.ok(svg.includes(HEAT_ZERO_FILL), '0 值格子应当用中性底色')
  assert.ok(
    svg.includes(`fill-opacity="${HEAT_ZERO_OPACITY.toFixed(2)}"`),
    '0 值底色应当半透明，深浅主题都成立',
  )
  assert.match(svg, /消息 · 最近 \d+ 天 · 共 510 条消息 · 峰值 500 条消息/)

  // 切到轮次口径：图注与量纲跟着变。
  const turnSvg = turnHeatSvg(days, 320, 'turns')
  assert.match(turnSvg, /轮次 · 最近 \d+ 天 · 共 6 轮 · 峰值 5 轮/)
})

test('热图：窗口宽度决定列数，方块大小不变', () => {
  // 「随窗口宽度增加而色块数量增加」——列数变多、天数变多，方块不放大。
  assert.ok(heatColumnCount(900) > heatColumnCount(320), '宽面板应当放下更多列')
  assert.ok(heatColumnCount(320) > heatColumnCount(120), '窄面板列数更少')
  assert.equal(heatWindowDays(900), heatColumnCount(900) * 7)
  // 高度只由 7 行固定方块决定，与宽度无关。
  assert.equal(turnHeatHeight(), turnHeatHeight())
  assert.equal(HEAT_CELL % 1, 0, '方块边长是整数像素')

  // 同一份数据在两种宽度下：窄的格子更少、方块一样大。
  // 日期必须逐天递增——重复的日期会被按天索引覆盖，跨度变 1 天。
  const days = Array.from({ length: 400 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1 + index))
    return {
      day: date.toISOString().slice(0, 10),
      turns: index % 7,
      messages: index,
    }
  })
  const widths = [200, 900].map(width => {
    const svg = turnHeatSvg(days, width)
    const rects = [...svg.matchAll(/<rect\b([^>]*)>/g)].map(m => m[1])
    const cells = rects.map(body => Number(/width="([\d.]+)"/.exec(body)?.[1]))
    return { count: rects.length, cell: cells[0] }
  })
  assert.ok(widths[1].count > widths[0].count, '宽面板应当有更多格子')
  assert.equal(widths[0].cell, widths[1].cell, '方块大小不随宽度变')
})

test('上下文分类：按行名归一，只取已用行', () => {
  // 引擎 /context 的行名；大小写与后缀都要能吃下。
  assert.equal(contextPartKind('System prompt'), 'system')
  assert.equal(contextPartKind('System tools'), 'tools')
  assert.equal(contextPartKind('Memory files'), 'memory')
  assert.equal(contextPartKind('MCP tools'), 'mcp')
  assert.equal(contextPartKind('Custom agents'), 'agents')
  assert.equal(contextPartKind('Messages'), 'messages')
  assert.equal(contextPartKind('Slash commands'), 'other')

  const parts = contextParts([
    { name: 'System prompt', tokens: 12_000, kind: 'used' },
    { name: 'Messages', tokens: 300_000, kind: 'used' },
    { name: 'Memory files', tokens: 3_000, kind: 'used' },
    { name: 'Free space', tokens: 600_000, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 45_000, kind: 'buffer' },
    { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
  ])
  // free / buffer / deferred 都不是「窗口被什么占着」，不进构成。
  assert.deepEqual(parts.map(p => p.kind), ['messages', 'system', 'memory'])
  assert.equal(parts[0].tokens, 300_000)
})

test('上下文分类：同一类合并，零值与坏值丢弃', () => {
  const parts = contextParts([
    { name: 'Memory files', tokens: 1_000, kind: 'used' },
    { name: 'Memory files', tokens: 2_000, kind: 'used' },
    { name: 'Messages', tokens: 0, kind: 'used' },
    { name: 'Messages', tokens: Number.NaN, kind: 'used' },
    { name: 'System prompt', tokens: -5, kind: 'used' },
  ])
  assert.equal(parts.length, 1)
  assert.equal(parts[0].kind, 'memory')
  assert.equal(parts[0].tokens, 3_000)
})

test('有构成数据时柱子按内容分类堆叠，高度按自适应纵轴算', () => {
  const turns = [
    {
      seq: 1,
      percent: 50,
      tokens: 1000,
      at: 0,
      parts: [
        { name: 'Messages', kind: 'messages', tokens: 300_000 },
        { name: 'System prompt', kind: 'system', tokens: 100_000 },
        { name: 'Memory files', kind: 'memory', tokens: 100_000 },
      ],
    },
    // 老记录：没有 parts，退回单色「已用」。
    { seq: 2, percent: 20, tokens: 500, at: 1 },
  ]
  // 峰值 50 + 10 缓冲 = 60 → ×1.1 = 66 → 向上取整到 5 的倍数 = 70。
  const { bars, yMax } = contextStack(turns, 24, 10)
  assert.equal(yMax, 70)
  assert.equal(bars.length, 2)
  assert.equal(bars[0].hasParts, true)
  assert.equal(bars[1].hasParts, false)

  // 第一根：三种分类按 token 比例分掉 50%，再加 10 缓冲；自适应模式不画空闲。
  const kinds = bars[0].segments.map(s => s.kind)
  assert.deepEqual(kinds, ['messages', 'system', 'memory', 'buffer'])
  // 三种分类合计 50%，占纵轴 50/70。
  const usedShare = bars[0].segments
    .filter(s => s.kind !== 'buffer')
    .reduce((acc, s) => acc + s.ratio, 0)
  assert.ok(Math.abs(usedShare - 50 / 70) < 1e-9)
  // 最大那一类占已用的 3/5。
  assert.ok(Math.abs(bars[0].segments[0].ratio - (300_000 / 500_000) * (50 / 70)) < 1e-9)

  // 第二根只有「已用 / 缓冲」两段，没有空闲补满。
  assert.deepEqual(bars[1].segments.map(s => s.kind), ['used', 'buffer'])
})

test('图例跟着这一屏出现过的分段走，顺序稳定', () => {
  const withParts = contextStack([{
    seq: 1,
    percent: 60,
    tokens: 1,
    at: 0,
    parts: [
      { name: 'Messages', kind: 'messages', tokens: 5 },
      { name: 'System prompt', kind: 'system', tokens: 3 },
      { name: 'MCP tools', kind: 'mcp', tokens: 1 },
    ],
  }], 24, 20)
  const legend = stackLegendOf(withParts.bars)
  // 顺序按 CONTEXT_PART_LABELS：system → tools → memory → mcp → agents → messages，
  // 末尾才是缓冲。自适应纵轴下不再画空闲段，所以图例里也没有它。
  assert.deepEqual(legend.map(item => item.kind), ['system', 'mcp', 'messages', 'buffer'])
  // 没出现过的分类不进图例。
  assert.ok(!legend.some(item => item.kind === 'memory'))
  assert.ok(!legend.some(item => item.kind === 'tools'))
})

test('只有老记录时图例退回两段骨架', () => {
  const legacy = contextStack([{ seq: 1, percent: 30, tokens: 1, at: 0 }], 24, 10)
  const legend = stackLegendOf(legacy.bars)
  assert.deepEqual(legend.map(item => item.kind), ['used', 'buffer'])
})

test('固定纵轴 100% 时保留旧行为：柱子补满，含空闲段', () => {
  const { bars, yMax } = contextStack(
    [{ seq: 1, percent: 30, tokens: 1, at: 0 }],
    24,
    10,
    { yMax: 100 },
  )
  assert.equal(yMax, 100)
  assert.deepEqual(bars[0].segments.map(s => s.kind), ['used', 'buffer', 'free'])
  const sum = bars[0].segments.reduce((acc, s) => acc + s.ratio, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `柱子应当补满到 100%，实际 ${sum}`)
})


// ---------------- 深浅主题的对比度 ----------------
//
// 这一组不是「看着还行」的检查：它按 WCAG 的公式算出每支色在两套背景上的
// 对比度，低于阈值就失败。图表是纯 SVG，颜色写死在调色板里，没有主题键
// 可以交给引擎解析——所以**只能靠这组断言保证浅色主题下也读得出来**。
//
// 阈值取 WCAG 的常见档：文字 4.5，图形元素 3.0。背景取两套主题各自的
// 面板底色（不是纯黑纯白），因为图表实际画在那上面。

const sRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
const toLin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = h => {
  const [r, g, b] = sRGB(h).map(toLin)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** 两色的对比度，1–21。 */
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** 把半透明色叠到背景上，得到实际呈现的颜色。 */
const over = (fg, alpha, bg) => {
  const f = sRGB(fg)
  const b = sRGB(bg)
  return (
    '#' +
    f
      .map((c, i) => Math.round((c * alpha + b[i] * (1 - alpha)) * 255).toString(16).padStart(2, '0'))
      .join('')
  )
}

// 两套主题下面板里图表所在的底色：深色取面板底，浅色取卡片底。
const DARK_BG = '#1a1a1a'
const LIGHT_BG = '#ffffff'

test('深色主题：每支图表色的对比度都过线', () => {
  const p = CHART_PALETTES.dark
  for (const [kind, color] of Object.entries(p.parts)) {
    const ratio = contrast(color, DARK_BG)
    assert.ok(ratio >= 3, `分类 ${kind} 在深色底上只有 ${ratio.toFixed(2)}，低于 3.0`)
  }
  assert.ok(contrast(p.label, DARK_BG) >= 4.5, '刻度文字要 4.5')
  assert.ok(contrast(p.axis, DARK_BG) >= 3, '轴线要 3.0')
  assert.ok(contrast(p.compact, DARK_BG) >= 3, '压缩标记要 3.0')
  // 主色（柱子的主角）也当图形元素看。
  assert.ok(contrast(p.used, DARK_BG) >= 3, '主色要 3.0')
})

test('浅色主题：每支图表色的对比度都过线', () => {
  const p = CHART_PALETTES.light
  for (const [kind, color] of Object.entries(p.parts)) {
    const ratio = contrast(color, LIGHT_BG)
    assert.ok(ratio >= 3, `分类 ${kind} 在浅色底上只有 ${ratio.toFixed(2)}，低于 3.0`)
  }
  assert.ok(contrast(p.label, LIGHT_BG) >= 4.5, '刻度文字要 4.5')
  assert.ok(contrast(p.axis, LIGHT_BG) >= 3, '轴线要 3.0')
  assert.ok(contrast(p.compact, LIGHT_BG) >= 3, '压缩标记要 3.0')
  assert.ok(contrast(p.used, LIGHT_BG) >= 3, '主色要 3.0')
})

test('两套主题的分段色彼此分得开：已用 > 缓冲 > 空闲', () => {
  for (const [name, p, bg] of [
    ['深色', CHART_PALETTES.dark, DARK_BG],
    ['浅色', CHART_PALETTES.light, LIGHT_BG],
  ]) {
    const used = over(p.used, p.usedOpacity, bg)
    const buffer = over(p.used, p.bufferOpacity, bg)
    const free = over(p.used, p.freeOpacity, bg)
    const cUsed = contrast(used, bg)
    const cBuffer = contrast(buffer, bg)
    const cFree = contrast(free, bg)
    // 三段是「越来越靠近背景」的次序，别反了。
    assert.ok(cUsed > cBuffer, `${name}：已用应当比压缩缓冲更显眼`)
    assert.ok(cBuffer > cFree, `${name}：压缩缓冲应当比空闲更显眼`)
    // 相邻两段之间也要有可见差别，否则柱子看起来是一整块。
    assert.ok(cUsed - cBuffer > 0.4, `${name}：已用与缓冲差别太小`)
    assert.ok(cBuffer - cFree > 0.2, `${name}：缓冲与空闲差别太小`)
  }
})

test('模型色阶在两套主题下都能按序号区分', () => {
  for (const [name, isLight, bg] of [
    ['深色', false, DARK_BG],
    ['浅色', true, LIGHT_BG],
  ]) {
    const colors = [0, 1, 2, 3, 4].map(i => modelFill(i, isLight))
    // 每一支本身都要看得见。
    for (const [i, color] of colors.entries()) {
      assert.ok(contrast(color, bg) >= 3, `${name} 第 ${i} 支对比度不足`)
    }
    // 相邻两支不能撞成一样（同一支色出现两次就说明色阶配错了）。
    assert.equal(new Set(colors).size, colors.length, `${name}：模型色阶有重复`)
  }
})

// ---------------- 模型页的粒度 ----------------
//
// 范围一拉长，柱子数就必须压下来，否则 365 根每根 2.4px 糊成一片。
// 这一组验证「分桶」本身：桶的个数、桶键是哪一天、桶里的 token 是相加
// 而不是取平均。

test('粒度按范围切换：30/60 按天、180 按周、365 按月', () => {
  assert.equal(modelGrainFor(30), 'day')
  assert.equal(modelGrainFor(60), 'day')
  assert.equal(modelGrainFor(180), 'week')
  assert.equal(modelGrainFor(365), 'month')
  // 边界两侧不能跳成同一档。
  assert.equal(modelGrainFor(210), 'week')
  assert.equal(modelGrainFor(211), 'month')
})

test('按周分桶：周一为周始，桶里的 token 相加', () => {
  // 2026-10-19 是周一。造三天的数据：周一、周三（同一周）、下周一。
  const days = [
    { day: '2026-10-19', models: [{ model: 'm', input: 10, output: 0, cost: 0 }] },
    { day: '2026-10-21', models: [{ model: 'm', input: 20, output: 0, cost: 0 }] },
    { day: '2026-10-26', models: [{ model: 'm', input: 40, output: 0, cost: 0 }] },
  ]
  const { bars } = modelStackBars(days, 14, 6, 'week')
  // 桶键是桶里最早的一天：10-19 那一桶装 10+20，10-26 那一桶装 40。
  const byKey = new Map(bars.map(bar => [bar.day, bar.total]))
  assert.equal(byKey.get('2026-10-19'), 30, '同一周的两天应当相加')
  assert.equal(byKey.get('2026-10-26'), 40, '下一周单独一桶')
})

test('按周分桶：周日归上一周，不另起一桶', () => {
  // 2026-10-18 是周日，2026-10-19 是周一：两者必须分属不同桶。
  const days = [
    { day: '2026-10-18', models: [{ model: 'm', input: 5, output: 0, cost: 0 }] },
    { day: '2026-10-19', models: [{ model: 'm', input: 7, output: 0, cost: 0 }] },
  ]
  const { bars } = modelStackBars(days, 7, 6, 'week')
  const keys = bars.map(bar => bar.day)
  assert.ok(keys.includes('2026-10-12'), '周日 10-18 属于以 10-12 开头的那一周')
  assert.ok(keys.includes('2026-10-19'), '周一 10-19 是新的一桶')
  assert.notEqual(keys.indexOf('2026-10-12'), keys.indexOf('2026-10-19'))
})

test('按月分桶：桶键是当月一日，同月合并', () => {
  const days = [
    { day: '2026-09-05', models: [{ model: 'm', input: 10, output: 0, cost: 0 }] },
    { day: '2026-09-28', models: [{ model: 'm', input: 15, output: 0, cost: 0 }] },
    { day: '2026-10-02', models: [{ model: 'm', input: 20, output: 0, cost: 0 }] },
  ]
  const { bars } = modelStackBars(days, 60, 6, 'month')
  const byKey = new Map(bars.map(bar => [bar.day, bar.total]))
  assert.equal(byKey.get('2026-09-01'), 25, '九月两天合并')
  assert.equal(byKey.get('2026-10-01'), 20, '十月单独')
})

test('桶数是窗口跨度除以粒度，不是天数', () => {
  const days = [{ day: '2026-10-20', models: [{ model: 'm', input: 1, output: 0, cost: 0 }] }]
  // 365 天按月：最多 13 个桶（跨年时会有 13 个月份），绝不会是 365 个。
  const monthly = modelStackBars(days, 365, 6, 'month').bars.length
  assert.ok(monthly <= 13, `按月应当 ≤13 根柱子，实际 ${monthly}`)
  assert.ok(monthly >= 12, `按月应当 ≥12 根柱子，实际 ${monthly}`)
  // 180 天按周：约 27 个桶。
  const weekly = modelStackBars(days, 180, 6, 'week').bars.length
  assert.ok(weekly <= 28 && weekly >= 26, `按周应当 26–28 根，实际 ${weekly}`)
  // 30 天按天：正好 30 根。
  assert.equal(modelStackBars(days, 30, 6, 'day').bars.length, 30)
})

test('图注写明粒度：同样的柱子数，按天与按月说的不是一回事', () => {
  const bars = modelStackBars(
    [{ day: '2026-10-20', models: [{ model: 'm', input: 100, output: 0, cost: 0 }] }],
    30, 6, 'day',
  ).bars
  assert.ok(modelStackCaption(bars, 'day').includes('按天'))
  assert.ok(modelStackCaption(bars, 'day').includes('30 天'))
  assert.ok(modelStackCaption(bars, 'month').includes('按月'))
  assert.ok(modelStackCaption(bars, 'month').includes('个月'))
})

test('三张图的 SVG 属性写法合法：不能出现空引号', () => {
  // 回归：把写死的 fill="..." 换成 fillOf() 拼接时，旧的收尾引号没删干净，
  // 生成出 fill="#9aa0b4"">60%</text> 这种属性。SVG 解析器直接判整张图非法，
  // 于是三张图一起从面板上消失——而当时的测试只检查「包含某些文字」，
  // 全部照过。这条断言守的是「属性语法本身」。
  const pal = [CHART_PALETTES.dark, CHART_PALETTES.light]
  const turns = [
    { seq: 1, percent: 40, tokens: 100, at: 0, parts: [{ name: 'M', tokens: 20, kind: 'messages' }] },
    { seq: 2, percent: 70, tokens: 100, at: 1, afterCompact: true },
  ]
  const days = [{ day: '2026-10-20', turns: 3, messages: 9 }]
  const stacked = modelStackBars(
    [{ day: '2026-10-20', models: [{ model: 'm', input: 10, output: 0, cost: 0 }] }],
    30,
  )
  for (const p of pal) {
    const list = [
      contextChartSvg(turns, 400, 2, 10, p),
      turnHeatSvg(days, 400, 'messages', p),
      modelStackSvg(stacked.bars, 400, stacked.yMax, stacked.models, p),
    ]
    for (const svg of list) {
      // 属性值闭合后紧跟另一个引号，说明拼串时漏删/多加了引号。
      assert.ok(!svg.includes('""'), 'SVG 里出现了空引号：' + svg.slice(Math.max(0, svg.indexOf('""') - 60), svg.indexOf('""') + 6))
      // 每个属性都必须有值。
      assert.ok(!/\s[a-zA-Z-]+=""/.test(svg), 'SVG 里有空属性值')
      // 开闭标签数量配平——少一个闭标签同样会让整张图被拒。
      const open = (svg.match(/<(?!\/)[a-z]/g) || []).length
      const close = (svg.match(/<\/[a-z]|\/>/g) || []).length
      assert.equal(open, close, `SVG 标签不配平：${open} 开 / ${close} 闭`)
    }
  }
})

test('金额一律带估算标记，零与缺失值除外', () => {
  assert.equal(usdEstimate(2), '≈$2.00')
  assert.equal(usdEstimate(0.5), '≈$0.50')
  // 0 与缺失值没有精度可谈，不加符号。
  assert.equal(usdEstimate(0), '$0')
  assert.equal(usdEstimate(undefined), '—')
  assert.equal(usdEstimate(null), '—')
  assert.equal(UNPRICED, '未收录价格')
})

test('压缩标记：只落在压缩后的第一轮', () => {
  const turns = [
    { seq: 1, percent: 20, tokens: 1, at: 0 },
    { seq: 2, percent: 80, tokens: 1, at: 1, afterCompact: true },
    { seq: 3, percent: 30, tokens: 1, at: 2 },
  ]
  const { bars } = contextStack(turns, 24, 0)
  assert.deepEqual(bars.map(bar => bar.isAfterCompact), [false, true, false])
  // 老记录里没有这个字段：一律按「否」处理，不会凭空画线。
  const legacy = contextStack([{ seq: 1, percent: 10, tokens: 1, at: 0 }], 24, 0)
  assert.equal(legacy.bars[0].isAfterCompact, false)
})

test('压缩处画竖向虚线，其余柱子不画', () => {
  const svg = contextChartSvg(
    [
      { seq: 1, percent: 20, tokens: 1, at: 0 },
      { seq: 2, percent: 80, tokens: 1, at: 1, afterCompact: true },
    ],
    320,
    24,
    0,
  )
  // 虚线是唯一带 dasharray 的元素，数量应当与压缩处一致。
  const dashes = svg.match(/stroke-dasharray/g) ?? []
  assert.equal(dashes.length, 1)
  assert.ok(svg.includes('stroke-dasharray="2 2"'))
  // 图的说明文字里也要提一句，读屏用户才知道那里发生了什么。
  assert.ok(svg.includes('1 处压缩'))
})

test('横轴标出轮次序号，密集时抽稀但首尾保留', () => {
  const turns = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    percent: 20,
    tokens: 1,
    at: index,
  }))
  const svg = contextChartSvg(turns, 320, 30, 0)
  // 最后一个轮次序号一定出现；第一个也在（index 0 必然被 0 % step 选中）。
  assert.ok(svg.includes('>1</text>'))
  assert.ok(svg.includes('>30</text>'))
  // 抽稀生效：30 根柱子、320px 宽时不可能把 30 个数字全画出来。
  const labels = svg.match(/text-anchor="middle" font-size="9"/g) ?? []
  assert.ok(labels.length < 30, `标签数 ${labels.length} 似乎没有抽稀`)
  assert.ok(labels.length >= 4, `标签数 ${labels.length} 太少，横轴读不出位置`)
})

test('面板底色跟着主题走，读不到时退回深色', () => {
  assert.equal(isLightTheme('light'), true)
  assert.equal(isLightTheme('light-daltonized'), true)
  assert.equal(isLightTheme('dark'), false)
  assert.equal(isLightTheme(undefined), false)

  const rows = [{ key: 'theme', value: 'light' }]
  assert.equal(panelFillFor(rows).backgroundColor, FILLS.light.backgroundColor)
  assert.equal(panelFillFor([{ key: 'theme', value: 'dark' }]).backgroundColor, FILLS.dark.backgroundColor)
  // 没有 config 行（老引擎、被管理员锁掉）时按深色处理。
  assert.equal(panelFillFor(undefined).backgroundColor, FILLS.dark.backgroundColor)
  assert.equal(panelFillFor([]).backgroundColor, FILLS.dark.backgroundColor)
})
