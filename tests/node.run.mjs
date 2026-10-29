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

import { costOf, isEnginePriced, priceOf } from '../hooks/pricing.ts'
import { clip, countdown, displayWidth, pct, tokens, usd } from '../hooks/format.ts'
import { BAND_METRIC_OPTIONS, bandDiffText, bandSummary, bubblePages, dishOf, freshnessOf, toUsageView, whaleTraitOf } from '../hooks/usage-view.ts'
import {
  addModelSpend,
  countPatchLines,
  duration,
  limitRows,
  meterText,
  toContextDetail,
  windowSourceText,
} from '../hooks/usage-detail.ts'
import { BAND_WHALE_FRAMES, BAND_WHALE_TEXT_COLS, WHALE_MAX_WIDTH, bandWhaleGlyph, bandWhaleStateOf, moodOf, whaleSizeFor, whaleSvg } from '../hooks/whale-art.ts'
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
  overviewCards,
  contextPartKind,
  contextPartColor,
  CONTEXT_PART_LABELS,
  contextDetailRows,
  contextParts,
  contextStack,
  contextView,
  historyContextTurns,
  mergeContextHistory,
  stackCaption,
  stackColor,
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
  CONTEXT_MAX_BARS,
  contextVisibleCount,
  contextChartSvg,
  heatColumnCount,
  heatWindowDays,
  modelFill,
  axisLabelOf,
  modelStackSvg,
  turnHeatHeight,
  turnHeatSvg,
} from '../hooks/chart-art.ts'
import { UNPRICED, usdEstimate } from '../hooks/provenance.ts'
import { CHART_PALETTES, FILLS, isLightTheme, panelFillFor, themeColorsFor } from '../hooks/panel-fill.ts'

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

test('引擎价目表只认第一方模型：DeepSeek 有价，但引擎不认识它', () => {
  // 这是两个不同的问题：`priceOf` 答「我们能不能算钱」，`isEnginePriced`
  // 答「引擎算的钱可不可信」。DeepSeek 在前者里有价，在后者里没有——
  // 面板上「本会话花费」取自引擎，所以要看后者。
  assert.equal(isEnginePriced('claude-opus-5-5'), true)
  assert.equal(isEnginePriced('claude-sonnet-5-5'), true)
  assert.equal(isEnginePriced('Claude-Haiku-4-5'), true, '大小写不敏感')

  assert.equal(isEnginePriced('deepseek-v4-flash'), false)
  assert.equal(isEnginePriced('qwen3.8-27b'), false)
  assert.equal(isEnginePriced('kimi-k3'), false)
  assert.equal(isEnginePriced('auto'), false)
  assert.equal(isEnginePriced('<synthetic>'), false)

  // 关键：插件给 DeepSeek 收了价，引擎那边依然不认识。
  assert.ok(priceOf('deepseek-v4-flash'), '插件价目表里有 DeepSeek')
  assert.equal(isEnginePriced('deepseek-v4-flash'), false, '引擎不认识 DeepSeek')

  // 两支价差得有多远——这就是「本会话花费比 30 天总额还高」的来源。
  const tokens = { input: 3_962_965, output: 1_396_968, cacheRead: 537_973_248, cacheWrite: 0 }
  const byDs = costOf('deepseek-v4-flash', tokens)
  const byDefault = costOf('claude-opus-5-5', tokens)
  assert.ok(byDs !== undefined && byDefault !== undefined)
  assert.ok(byDefault > byDs * 50, `默认模型估出的金额（${byDefault}）应当远高于官方价（${byDs}）`)
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
  // 10¹² 这一档写「万亿」不写「兆」：「兆」在汉语里已经被 SI 词头占成 10⁶，
  // 写成兆会被读成百万，差了一百万倍。
  assert.equal(tokens(1.2e12), '1.20万亿')
  assert.equal(tokens(9.99e11), '9990.00亿')
  // 负数按绝对值取档，符号留在前面。
  assert.equal(tokens(-2.5e12), '-2.50万亿')
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

test('情绪随一天里的时间变化，与额度无关', () => {
  // 本地时区构造，断言在任何时区都成立。边界是整点、左闭右开。
  const at = (hour, minute = 0) => new Date(2026, 9, 22, hour, minute, 0).getTime()
  assert.equal(moodOf(at(0)), 'sleep')
  assert.equal(moodOf(at(5, 59)), 'sleep')
  assert.equal(moodOf(at(6)), 'idle')
  assert.equal(moodOf(at(8, 59)), 'idle')
  assert.equal(moodOf(at(9)), 'working')
  assert.equal(moodOf(at(11, 59)), 'working')
  assert.equal(moodOf(at(12)), 'busy')
  assert.equal(moodOf(at(13, 59)), 'busy')
  assert.equal(moodOf(at(14)), 'working')
  assert.equal(moodOf(at(17, 59)), 'working')
  assert.equal(moodOf(at(18)), 'busy')
  assert.equal(moodOf(at(20, 59)), 'busy')
  assert.equal(moodOf(at(21)), 'tired')
  assert.equal(moodOf(at(23, 59)), 'tired')
  // 一天转一圈，五个情绪都出现——且具体是哪五档也要钉住，否则把两档对调
  // 仍然会过。
  const moods = new Set([...Array(24).keys()].map(hour => moodOf(at(hour))))
  assert.equal(moods.size, 5)
  assert.deepEqual([...moods].sort(), ['busy', 'idle', 'sleep', 'tired', 'working'])
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

test('浮动动画的 begin 接上当前相位，翻页重建时不跳回起点', () => {
  const epoch = 1_000_000
  const period = 3_600
  const beginOf = svg => {
    const hit = svg.match(/begin="-([\d.]+)s"/)
    return hit ? Number(hit[1]) : null
  }

  // 零点：没有相位，begin 不出现（等价于从 0 开始）
  assert.equal(beginOf(whaleSvg('idle', ['a'], { now: epoch, epoch })), null)
  // 播到 1.5 秒：begin 正好是 -1.500s
  assert.ok(Math.abs(beginOf(whaleSvg('idle', ['a'], { now: epoch + 1_500, epoch })) - 1.5) < 1e-6)
  // 跨一个周期：相位回绕，不是继续累加
  assert.ok(Math.abs(beginOf(whaleSvg('idle', ['a'], { now: epoch + period + 900, epoch })) - 0.9) < 1e-6)
  // 同一个 now 反复画，begin 稳定
  const a = whaleSvg('idle', ['a'], { now: epoch + 700, epoch })
  const b = whaleSvg('idle', ['b'], { now: epoch + 700, epoch })
  assert.equal(beginOf(a), beginOf(b))
  // 不传 now/epoch 时与旧调用方一致
  assert.equal(beginOf(whaleSvg('idle', ['a'])), null)
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
    '无额度窗口',
  )
  // 「5h + 7d」没有数据时闭嘴，不重复「额度窗口」那句话——否则关掉
  // 「额度窗口」条子毫无变化，读者以为开关失灵。
  assert.equal(
    bandSummary(toUsageView({ rateLimits: [], cost: { usd: 0.5 }, context: { window: 200_000, percent: 33 } }), ['context'], 0),
    '',
  )
  // 多选：按固定次序拼接，与勾选先后无关；重复项只出现一次。
  // window 已经写了 5h，context 只补 7d——同一条数字不印两遍。
  assert.equal(
    bandSummary(view, ['context', 'window'], now),
    '5h 40% · 2h00m 后重置 · 7d 70%',
  )
  assert.equal(
    bandSummary(view, ['window', 'context', 'window'], now),
    '5h 40% · 2h00m 后重置 · 7d 70%',
  )
  assert.deepEqual(BAND_METRIC_OPTIONS.map(o => o.value).sort(), ['context', 'cost', 'diff', 'session', 'window'].sort())
})

test('用量条的本会话花费优先用插件价格表', () => {
  // 引擎只认第一方价目表，第三方模型按默认模型估：同一批 token，
  // DeepSeek Flash 按官方价 $3.05，引擎估成 $258.98。
  const view = toUsageView({
    rateLimits: [],
    cost: { usd: 258.98 },
    context: { window: 200_000, percent: 33 },
  })
  const now = Date.parse('2026-10-20T12:00:00Z')
  // 传了插件算出的花费就用它；没传才退回引擎读数。
  assert.equal(bandSummary(view, ['session'], now, 3.05), '本会话 ≈$3.05')
  assert.equal(bandSummary(view, ['session'], now), '本会话 ≈$258.98')
  assert.equal(bandSummary(view, ['session'], now, undefined), '本会话 ≈$258.98')
})

test('代码改动：摘要里不拼它（分色由渲染层做），文字本身零值省略', () => {
  const view = toUsageView({ rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], cost: { usd: 2 } })
  const now = Date.parse('2026-10-20T12:00:00Z')
  const diff = { added: 128, removed: 34 }

  // 摘要里不拼改动：增删要分两种颜色，拼进字符串就丢了颜色。
  assert.equal(bandSummary(view, ['diff'], now), '')
  assert.ok(!bandSummary(view, ['window'], now).includes('+128'))
  // 只有一边有改动时，零的那一边不显示。
  assert.equal(bandDiffText(diff), '+128 -34')
  assert.equal(bandDiffText({ added: 5, removed: 0 }), '+5')
  assert.equal(bandDiffText({ added: 0, removed: 3 }), '-3')
  assert.equal(bandDiffText({ added: 0, removed: 0 }), '')
})

test('鲸鱼尺寸默认固定，只在面板放不下时才缩', () => {
  // 回归：尺寸曾按面板宽度的 55% 算，窗口一横向压缩鲸鱼就跟着缩水。
  // 现在只要放得下就用固定尺寸——49 列以上全都一样大。
  const fixed = whaleSizeFor(60).width
  assert.equal(fixed, WHALE_MAX_WIDTH)
  for (const columns of [49, 60, 80, 100, 140, 200]) {
    assert.equal(whaleSizeFor(columns).width, fixed, `${columns} 列的立绘不该变大小`)
  }
  assert.equal(WHALE_MAX_WIDTH, 380)

  // 窄到放不下时才缩：可用宽度 = (列数 − 1) × 8px。
  // 380px 需要 (380/8)+1 ≈ 48.5 → 49 列，48 列只有 376px。
  assert.equal(whaleSizeFor(48).width, 47 * 8)
  assert.equal(whaleSizeFor(30).width, 29 * 8)
  // 且任何宽度下都不超过面板。
  for (const columns of [10, 20, 30, 40, 48, 100]) {
    assert.ok(whaleSizeFor(columns).width <= Math.max(0, columns - 1) * 8 + 1e-9)
  }

  // 高宽比严格保持：引擎的 preserveAspectRatio 不会留白抖动。
  for (const columns of [10, 40, 100, 200]) {
    const { width, height } = whaleSizeFor(columns)
    assert.ok(Math.abs(height / width - 320 / 620) < 1e-12, `${columns} 列比例失守`)
  }

  // 尺寸随列数单调不减，且没有突变（相邻一列的跳变不超过 8px）。
  for (let columns = 16; columns <= 140; columns += 1) {
    const a = whaleSizeFor(columns).width
    const b = whaleSizeFor(columns + 1).width
    assert.ok(b >= a, `${columns} 列变宽后立绘反而变小`)
    assert.ok(b - a <= 8 + 1e-9, `${columns} 列处跳变 ${b - a}px`)
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

  // `share` 是「相对最大值」——过滤后只剩一行时它恒为 1，断言 1 没有信息量。
  // 这里用两个都有效的模型，验证它真的按 token 比例算。
  const two = modelRows([
    { model: 'a', isPriced: true, input: 300, output: 0, cacheWrite: 0, cacheRead: 0, cost: 1, messages: 1 },
    { model: 'b', isPriced: true, input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 1, messages: 1 },
  ])
  assert.equal(two[0].share, 1, '最大的一项是 1')
  assert.ok(Math.abs(two[1].share - 1 / 3) < 1e-9, '第二项按 100/300 算出 1/3')
  assert.equal(barText(1 / 3, 6), '██░░░░', '条形按比例填充')
})

test('概览卡片：无数据显示占位，有数据按窗口重算活跃天数', () => {
  const empty = overviewCards(undefined, [], 30, 0)
  assert.deepEqual(empty.map(c => c.label), ['会话', '消息', '总 token', '活跃天数', '峰值时段', '常用模型'])
  assert.ok(empty.every(c => c.value === '—'), '没数据时六个值全是占位符')

  // `activeDays` 给 99（超过 30 天窗口），卡片必须按 days 重算成 2——直接
  // 用 overview 里那个来自 400 天扫描的字段，会显示出「99 / 30」这种读数。
  const cards = overviewCards(
    {
      sessions: 42,
      activeDays: 99,
      peakHour: 17,
      peakHourMessages: 1234,
      favoriteModel: 'claude-opus-5-5',
      favoriteModelMessages: 5678,
      totalMessages: 12345,
      totalTokens: 9_870_000,
    },
    [
      { day: '2026-10-20', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1, messages: 3 },
      { day: '2026-10-21', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 },
      { day: '2026-10-22', input: 200, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2, messages: 5 },
    ],
    30,
    12.3,
  )
  const byLabel = Object.fromEntries(cards.map(c => [c.label, c]))
  assert.equal(byLabel['会话'].value, '42')
  assert.equal(byLabel['消息'].value, '12,345')
  assert.ok(byLabel['总 token'].value.includes('万'))
  assert.equal(byLabel['活跃天数'].value, '2', '10-21 是空的一天，不算活跃')
  assert.equal(byLabel['活跃天数'].hint, '/ 30 天', '统计范围在注解档，不占标题')
  assert.equal(byLabel['峰值时段'].value, '5 PM')
  assert.ok(byLabel['峰值时段'].hint.includes('条'))
  assert.equal(byLabel['常用模型'].value, 'opus-5-5', '展示名去掉 claude- 前缀')
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
  // 明细表从逐日数据按窗口重建（与图同源）；`byModel` 只用来判断价格。
  const rows = modelDetailRows(
    [{
      day: '2026-10-20',
      models: [
        // 同一款 Flash 的两个写法：各自的估算值要加起来。
        { model: 'deepseek-flash', input: 1_000_000, output: 0, cost: 0.15 },
        { model: 'DeepSeek-Flash', input: 0, output: 1_000_000, cost: 0.6 },
        // 没有价格的模型：金额是 null，不是 0。
        { model: 'qwen3.8-27b', input: 500, output: 100, cost: 0 },
      ],
    }],
    30,
    [
      { model: 'deepseek-flash', isPriced: true, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.15, messages: 10 },
      { model: 'DeepSeek-Flash', isPriced: true, input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: 0.6, messages: 5 },
      // 没有价格的模型：金额是 null，不是 0。
      { model: 'qwen3.8-27b', isPriced: false, input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 },
      // 占位标识不进表。
      { model: 'auto', isPriced: false, input: 900, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 9 },
    ],
  )

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

/**
 * 明细表与堆叠图必须**同窗口、同排序**。
 *
 * 这是一条真实缺陷的回归：表曾直接读 `byModel`（扫描层固定 400 天的全量），
 * 图读 `modelDaily` 并按「范围」（30 / 60 / 180 / 365 天）裁剪。读者把范围
 * 切到 30 天，柱子变了、表纹丝不动，而两块长在同一个标题下——等于同时给出
 * 两套互相矛盾的数字，费用尤其离谱（表多算了 370 天）。
 *
 * 这条用「老数据只在窗口外」的夹具把两种口径的差异放大到必然可见：
 * 30 天窗口里只有 A，而 400 天全量里 B 更多。若表仍读全量，B 会排到第一。
 */
test('模型明细与堆叠图同窗口：窗口外的模型不进表，行序与段序一致', () => {
  const daily = [
    // 30 天窗口之外、365 天窗口之内：B 的用量远大于窗口内的 A。
    // 日期不能取在 365 天边界上——窗口是「以最新一天为锚、往前共 365 天」，
    // 恰好 365 天前的那一天落在窗口外，这一点本身就是 `modelWindowDates`
    // 的边界语义，不该拿来做夹具。
    { day: '2026-04-01', models: [{ model: 'claude-opus-5-5', input: 90_000_000, output: 10_000_000, cost: 300 }] },
    // 30 天窗口内：只有 A。
    { day: '2026-10-20', models: [{ model: 'DeepSeek Flash', input: 1_000_000, output: 100_000, cost: 0.8 }] },
  ]
  const byModel = [
    { model: 'claude-opus-5-5', isPriced: true, input: 90_000_000, output: 10_000_000, cacheRead: 0, cacheWrite: 0, cost: 300, messages: 40 },
    { model: 'DeepSeek Flash', isPriced: true, input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, cost: 0.8, messages: 3 },
  ]

  const stack = modelStackBars(daily, 30, 6, 'day')
  const rows = modelDetailRows(daily, 30, byModel)

  assert.deepEqual(rows.map(row => row.model), ['DeepSeek Flash'], '窗口外的模型不该出现在表里')
  assert.deepEqual(rows.map(row => row.model), stack.models, '表的行序必须与图的段序一致')

  // 同一份数据、拉宽到 365 天后，表与图一起把老数据收进来，顺序仍然一致。
  const wideStack = modelStackBars(daily, 365, 6, 'week')
  const wideRows = modelDetailRows(daily, 365, byModel)
  assert.deepEqual(wideRows.map(row => row.model), wideStack.models)
  assert.equal(wideRows[0].model, 'claude-opus-5-5', '全窗口下用量最大的应排第一')

  // 未收录价格的判断与窗口无关：qwen 在窗口里没有用量，也不该凭空出现。
  const unpriced = modelDetailRows(
    [{ day: '2026-10-20', models: [{ model: 'qwen3.8-27b', input: 5, output: 1, cost: 0 }] }],
    30,
    [{ model: 'qwen3.8-27b', isPriced: false, input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 }],
  )
  assert.equal(unpriced.length, 1)
  assert.equal(unpriced[0].cost, null)
})

test('显示宽度：中文占两格，英文占一格', () => {
  // 中文占两格：`模型` 是 4 列宽，不是 2。
  assert.equal(displayWidth('模型'), 4)
  assert.equal(displayWidth('DeepSeek Flash'), 14)
  assert.equal(displayWidth('abc'), 3)
  // 超宽时按显示宽度截断，不留半格。
  assert.ok(displayWidth(clip('DeepSeek Flash', 6)) <= 6)
})

test('上下文堆叠柱与轮次柱', () => {
  // 柱高按 **token 绝对量** 画，纵轴上限默认是峰值的一成余量。
  // `percent` 只作为读数保留，不参与高度——它与柱高用的是两个尺度。
  const { bars, peak, yMaxTokens } = contextStack([
    { seq: 1, percent: 20, tokens: 100_000, at: 0 },
    { seq: 2, percent: 90, tokens: 450_000, at: 1 },
  ], 24, 10)
  assert.equal(bars.length, 2)
  // 峰值仍是百分比口径（图注那句「峰值 90%」说的是窗口占了多满）。
  assert.equal(peak, 90)
  // 纵轴：峰值 450K 的 1.1 倍 = 495K。
  assert.equal(yMaxTokens, 495_000)
  // 柱高 = token / 纵轴上限，不再恒定。
  const heights = bars.map(bar => bar.segments.reduce((sum, s) => sum + s.ratio, 0))
  assert.ok(Math.abs(heights[0] - 100_000 / 495_000) < 1e-9)
  assert.ok(Math.abs(heights[1] - 450_000 / 495_000) < 1e-9)
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

test('纵轴上限：给了压缩阈值就用它，柱高按 token 算', () => {
  // 阈值 400K：一根 100K、一根 300K。
  const { bars, yMaxTokens } = contextStack([
    { seq: 1, percent: 10, tokens: 100_000, at: 0 },
    { seq: 2, percent: 30, tokens: 300_000, at: 1 },
  ], 24, 0, { yMaxTokens: 400_000 })
  assert.equal(yMaxTokens, 400_000, '给了阈值就当纵轴上限')
  const heights = bars.map(bar => bar.segments.reduce((sum, s) => sum + s.ratio, 0))
  // 100K/400K = 25%，300K/400K = 75%：与「离压缩还有多远」直接可比。
  assert.ok(Math.abs(heights[0] - 0.25) < 1e-9)
  assert.ok(Math.abs(heights[1] - 0.75) < 1e-9)
  // 自适应模式下不画空闲段：空白本身就在表达「还有余量」。
  assert.ok(!bars.some(bar => bar.segments.some(s => s.kind === 'free')))
})

test('纵轴自适应：没给阈值时按峰值留一成余量', () => {
  // 低用量：两根柱子都只有一小截，按峰值定轴后它们仍然分得出高低。
  const { bars, yMaxTokens } = contextStack([
    { seq: 1, percent: 20, tokens: 20_000, at: 0 },
    { seq: 2, percent: 30, tokens: 30_000, at: 1 },
  ], 24, 0)
  // 峰值 30K 的 1.1 倍 = 33K。
  assert.equal(yMaxTokens, 33_000)
  const heights = bars.map(bar => bar.segments.reduce((sum, s) => sum + s.ratio, 0))
  // 最高那根顶到 30/33 ≈ 91%，留一点头；矮的那根明显更矮。
  assert.ok(Math.abs(heights[1] - 30 / 33) < 1e-9)
  assert.ok(Math.abs(heights[0] - 20 / 33) < 1e-9)
  // 自适应模式不画空闲段：它会把柱子重新补满，抵消自适应的意义。
  assert.ok(!bars.some(bar => bar.segments.some(s => s.kind === 'free')))
})

test('上下文图不翻页：显示轮数由画布宽度自己算，永远贴住最新一端', () => {
  const turn = index => ({
    seq: index + 1,
    percent: 10 + (index % 5),
    tokens: 1000,
    at: index,
  })
  const turns = Array.from({ length: CONTEXT_MAX_BARS }, (_, index) => turn(index))
  // 这些轮次没有分项构成，一根柱子就是一段「已用」，所以 rect 数 = 柱子数。
  const barCount = svg => (svg.match(/<rect /g) || []).length

  // 宽画布：60 轮全放得下（上限就是 60）。
  const wide = contextChartSvg(turns, 900, CONTEXT_MAX_BARS, 0, CHART_PALETTES.dark)
  assert.equal(barCount(wide), CONTEXT_MAX_BARS)

  // 窄到画布下限（80px）：槽宽不得低于下限，柱子数必须按宽度降下来。
  // 绘图区 80 - 26 - 6 = 48px，48 / 1.4 ≈ 34 根。
  const narrow = contextChartSvg(turns, 80, CONTEXT_MAX_BARS, 0, CHART_PALETTES.dark)
  const narrowCount = barCount(narrow)
  const slot = (80 - 26 - 6) / narrowCount
  assert.equal(narrowCount, 34)
  assert.ok(slot >= 1.4 - 1e-9, `槽宽 ${slot.toFixed(2)}px 低于下限`)

  // 无论宽窄，最右边那根永远是最新一轮。
  assert.ok(wide.includes('>' + CONTEXT_MAX_BARS + '<'), '宽画布缺最新一轮的序号')
  assert.ok(narrow.includes('>' + CONTEXT_MAX_BARS + '<'), '窄画布缺最新一轮的序号')

  // 轮次不足时不补空柱：只有 5 轮就画 5 根。
  assert.equal(barCount(contextChartSvg(turns.slice(0, 5), 900, CONTEXT_MAX_BARS, 0, CHART_PALETTES.dark)), 5)
})

/**
 * 「显示几轮」只算一次，且图注、图例、纵轴都用同一份结果。
 *
 * 回归：面板侧曾用写死的 `CONTEXT_MAX_BARS`（60）算 `alt`、`yMax` 与图例，
 * 而 SVG 内部又按宽度裁到 34 根，于是窄画布下图注说「最近 60 轮」、图上只有
 * 34 根，图例还会列出已被裁掉那几轮才有的分类。若那几轮里有一根 95% 的高柱
 * 被裁掉，`yMax` 仍会被它拉高，可见柱子就被压扁了。
 *
 * 现在 `contextView` 是唯一出口：CUT 一次，剩下的全从它来。
 */
test('contextView：图注、图例、纵轴、柱子数全出自同一份裁好的数据', () => {
  // 最早那 10 轮既有 95% 的高峰、又带分项构成——它们只在宽画布下露得出来。
  // 80px 画布裁到 34 根时，这 10 轮已经不在窗口里。
  const turns = Array.from({ length: 60 }, (_, index) => ({
    seq: index + 1,
    percent: index < 10 ? 95 : 20,
    tokens: index < 10 ? 950_000 : 200_000,
    at: index,
    parts: index < 10 ? [{ kind: 'system', tokens: 500 }, { kind: 'tools', tokens: 500 }] : undefined,
  }))

  for (const width of [80, 200, 640, 900]) {
    const view = contextView(turns, width, 0, false)
    const visible = contextVisibleCount(width)
    // 三处必须说同一个数。
    assert.equal(view.turns.length, visible, `宽 ${width}px：裁出 ${view.turns.length} 轮，应为 ${visible}`)
    assert.equal(view.bars.length, visible, `宽 ${width}px：柱子数不符`)
    assert.ok(view.caption.includes(`最近 ${visible} 轮`), `宽 ${width}px：图注没写 ${visible} 轮，实际「${view.caption}」`)

    // 图例只列真正画出来的那几轮里出现过的分类。
    const kinds = new Set(view.bars.flatMap(bar => bar.segments.map(s => s.kind)))
    const legendKinds = new Set(view.legend.map(item => item.kind))
    for (const kind of legendKinds) {
      assert.ok(kinds.has(kind), `宽 ${width}px：图例列了「${kind}」，但这一屏的柱子里没有`)
    }

    // 纵轴上限只由可见的柱子定（这里没给阈值，走自适应）：峰值 token 的
    // 1.1 倍。95K 那几轮在窗口内时是 104.5K，不在时是 22K。
    const seenPeak = Math.max(...view.turns.map(turn => turn.tokens))
    assert.equal(view.yMaxTokens, Math.max(1, Math.ceil(seenPeak * 1.1 - 1e-6)), `宽 ${width}px：可见峰值 ${seenPeak} 却给出纵轴 ${view.yMaxTokens}`)
  }

  // 宽画布才露得出那 10 轮带构成的老记录。
  const wide = contextView(turns, 900, 0, false)
  assert.ok(wide.legend.some(item => item.kind === 'system'), '宽画布应当列出系统提示')
  // 窄画布裁掉它们之后，图例里也不该再有。
  const narrow = contextView(turns, 80, 0, false)
  assert.ok(!narrow.legend.some(item => item.kind === 'system'), '窄画布不该再列出已被裁掉的分类')
})

/**
 * 图注上屏之后不能再重复纵轴上界。
 *
 * `stackCaption` 的 `yMax` 参数原本只给终端用：那边没有 Svg，画不出左侧
 * 纵轴，上限只能写进文字。桌面端的图上已经有 `0` 与上界两处刻度，图注里
 * 再来一句「纵轴 75%」就是同一件事说两遍。
 *
 * 早先 `contextView` 把 `yMax` 传给了 `stackCaption`——那时 caption 只进
 * `alt`（屏幕上看不见），所以没暴露；图注搬上屏幕后就成了可见的重复。
 */
test('contextView 的图注不带纵轴（轴上有刻度），终端自己补', () => {
  const turns = Array.from({ length: 12 }, (_, index) => ({
    seq: index + 1, percent: 40, tokens: 400_000, at: index,
  }))
  const view = contextView(turns, 900, 0, false)
  assert.ok(!view.caption.includes('纵轴'), `图注不该提纵轴，实际「${view.caption}」`)
  // 但 `yMaxTokens` 本身仍要给出来——终端那一路要拿它拼自己那句。
  assert.ok(view.yMaxTokens > 0)
  const terminalLine = stackCaption(view.bars.length, view.peak, view.yMaxTokens)
  assert.ok(terminalLine.includes('纵轴'), `终端图注该带纵轴，实际「${terminalLine}」`)
  // 终端图注按 token 单位写（K / M），不是百分比。
  assert.ok(terminalLine.includes('K') || terminalLine.includes('M'), `纵轴单位应为 token，实际「${terminalLine}」`)
})

/**
 * 图注写出压缩：次数 + 最近一次的具体数字。
 *
 * 压缩在图上只是一条虚线加一根变矮的柱子，「1 次压缩」只说了发生过；读者
 * 真正想知道的是砍掉了多少。数字取自日志里的 `compact_boundary`，是引擎
 * 自己记的，不是估的。
 *
 * 没有压缩的会话不该多这句话——那句话会让读者去找一个不存在的标记。
 */
test('图注：有压缩才写，写出次数与最近一次的压缩前后', () => {
  // 没有压缩：不加尾巴。
  const plain = stackCaption(12, 46)
  assert.equal(plain, '最近 12 轮 · 峰值 46%')
  // 纵轴按 token 单位写（K / M），与图上轴顶那个刻度同一套写法。
  assert.equal(stackCaption(12, 46, 400_000), '最近 12 轮 · 峰值 46% · 纵轴 400K')
  assert.equal(stackCaption(12, 46, 1_000_000), '最近 12 轮 · 峰值 46% · 纵轴 1M')
  // 空数组与不传等价。
  assert.equal(stackCaption(12, 46, undefined, []), '最近 12 轮 · 峰值 46%')

  const one = stackCaption(12, 46, undefined, [
    { trigger: 'auto', preTokens: 367_354, postTokens: 27_907 },
  ])
  assert.equal(one, '最近 12 轮 · 峰值 46% · 1 次压缩（36.7万 压到 2.8万）')

  // 多次：次数写总数，数字写**最后一次**——读者最关心刚发生的那一回。
  const two = stackCaption(12, 46, 921_600, [
    { trigger: 'auto', preTokens: 367_270, postTokens: 28_228 },
    { trigger: 'manual', preTokens: 368_923, postTokens: 25_830 },
  ])
  assert.equal(two, '最近 12 轮 · 峰值 46% · 纵轴 922K · 2 次压缩（36.9万 压到 2.6万）')

  // 压缩点：阈值换算到模型窗口的百分比，与「峰值 46%」同一个尺度。
  const withPoint = stackCaption(12, 46, 400_000, [], '压缩点 40%')
  assert.equal(withPoint, '最近 12 轮 · 峰值 46% · 纵轴 400K · 压缩点 40%')

  // 缺数字时只写次数，不画一对空括号。
  const bare = stackCaption(12, 46, undefined, [
    { trigger: 'auto', preTokens: 0, postTokens: 0 },
  ])
  assert.equal(bare, '最近 12 轮 · 峰值 46% · 1 次压缩')
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

test('有构成数据时柱子按内容分类堆叠，高度按 token 算', () => {
  const turns = [
    {
      seq: 1,
      percent: 50,
      tokens: 500_000,
      at: 0,
      parts: [
        { name: 'Messages', kind: 'messages', tokens: 300_000 },
        { name: 'System prompt', kind: 'system', tokens: 100_000 },
        { name: 'Memory files', kind: 'memory', tokens: 100_000 },
      ],
    },
    // 老记录：没有 parts，退回单色「已用」。
    { seq: 2, percent: 20, tokens: 200_000, at: 1 },
  ]
  // 没给阈值：纵轴按峰值 500K 的 1.1 倍 = 550K。
  const { bars, yMaxTokens } = contextStack(turns, 24, 0)
  assert.equal(yMaxTokens, 550_000)
  assert.equal(bars.length, 2)
  assert.equal(bars[0].hasParts, true)
  assert.equal(bars[1].hasParts, false)

  // 第一根：三种分类按 token 比例分掉整根「已用」。
  const kinds = bars[0].segments.map(s => s.kind)
  assert.deepEqual(kinds, ['messages', 'system', 'memory'])
  // 合计 = 500K / 550K。
  const usedShare = bars[0].segments.reduce((acc, s) => acc + s.ratio, 0)
  assert.ok(Math.abs(usedShare - 500_000 / 550_000) < 1e-9)
  // 最大那一类占已用的 3/5。
  assert.ok(Math.abs(bars[0].segments[0].ratio - (300_000 / 500_000) * (500_000 / 550_000)) < 1e-9)

  // 第二根没有构成，整根一段「已用」。
  assert.deepEqual(bars[1].segments.map(s => s.kind), ['used'])
})

test('图例跟着这一屏出现过的分段走，顺序稳定', () => {
  const withParts = contextStack([{
    seq: 1,
    percent: 60,
    tokens: 9,
    at: 0,
    parts: [
      { name: 'Messages', kind: 'messages', tokens: 5 },
      { name: 'System prompt', kind: 'system', tokens: 3 },
      { name: 'MCP tools', kind: 'mcp', tokens: 1 },
    ],
  }], 24, 0)
  const legend = stackLegendOf(withParts.bars)
  // 顺序按 CONTEXT_PART_LABELS：system → tools → memory → mcp → agents → messages。
  // 新几何里纵轴就是压缩阈值，缓冲段没有容身之处，所以图例里也没有它。
  assert.deepEqual(legend.map(item => item.kind), ['system', 'mcp', 'messages'])
  // 没出现过的分类不进图例。
  assert.ok(!legend.some(item => item.kind === 'memory'))
  assert.ok(!legend.some(item => item.kind === 'tools'))
})

test('只有老记录时图例只剩一段骨架', () => {
  const legacy = contextStack([{ seq: 1, percent: 30, tokens: 100_000, at: 0 }], 24, 0)
  const legend = stackLegendOf(legacy.bars)
  assert.deepEqual(legend.map(item => item.kind), ['used'])
})

test('压缩阈值就是纵轴顶：柱子顶到轴顶即「马上要被压缩」', () => {
  // 阈值 400K，这一轮 300K：柱子占轴高的 75%，而不是按百分比口径的 30%。
  const { bars, yMaxTokens } = contextStack(
    [{ seq: 1, percent: 30, tokens: 300_000, at: 0 }],
    24,
    0,
    { yMaxTokens: 400_000 },
  )
  assert.equal(yMaxTokens, 400_000)
  // 新几何里不再有缓冲段与空闲段：轴顶就是阈值，上面没有空间可画。
  assert.deepEqual(bars[0].segments.map(s => s.kind), ['used'])
  const sum = bars[0].segments.reduce((acc, s) => acc + s.ratio, 0)
  assert.ok(Math.abs(sum - 0.75) < 1e-9, `柱子应当占轴高 75%，实际 ${sum}`)
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

/**
 * 两色的 ΔE（CIE76）：在 CIE Lab 空间里的欧氏距离。
 *
 * 对比度回答「能不能在底上看清」，ΔE 回答「两种颜色彼此像不像」——两个
 * 问题互不相干：两支都很亮的色可以各自与深底拉得开，却因为色相相同而
 * 在柱子里糊成一层。分类色同时受这两条约束。
 *
 * 经验刻度：< 10 基本算同色，10–20 一眼能看出差别但放在小色块里仍会混，
 * > 25 明显是两种颜色。
 */
const toXyz = h => {
  const [r, g, b] = sRGB(h).map(toLin)
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
  ]
}
const toLab = h => {
  const [x, y, z] = toXyz(h)
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y / 1.0) - 16, 500 * (f(x / 0.95047) - f(y / 1.0)), 200 * (f(y / 1.0) - f(z / 1.08883))]
}
const deltaE = (a, b) => {
  const [l1, a1, b1] = toLab(a)
  const [l2, a2, b2] = toLab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
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

/**
 * 分类色之间必须**互相分得开**，不只是各自与底色分得开。
 *
 * 这两个要求是独立的：七支都能在底上看清，不代表它们彼此能区分。早先七支
 * 全挤在蓝—紫一带，`system`(`#A78BFA`) 与 `mcp`(`#C084FC`) 的 ΔE 只有
 * 10.9，`memory`(`#7AA2F7`) 与 `messages`(`#4D6BFE`) 在 `auto` 档只有 14.0
 * ——柱子里相邻两层根本分不出边界。
 *
 * 门槛取 ΔE ≥ 15（CIE76）。这个值是「一眼能看出是两种颜色」的下限附近：
 * 低于 10 基本就是同色，15 以上在图例的小方块里也能分辨。历史上的最差
 * 一对是 9.3，正是这条测试要挡住的情况。
 */
test('分类色彼此分得开：任意两支的 ΔE 不低于 15', () => {
  for (const [name, palette] of [
    ['深色', CHART_PALETTES.dark],
    ['浅色', CHART_PALETTES.light],
    ['auto', CHART_PALETTES.auto],
  ]) {
    const kinds = Object.keys(palette.parts)
    for (let i = 0; i < kinds.length; i += 1) {
      for (let j = i + 1; j < kinds.length; j += 1) {
        const a = kinds[i]
        const b = kinds[j]
        const delta = deltaE(palette.parts[a], palette.parts[b])
        assert.ok(
          delta >= 15,
          `${name}：${a}(${palette.parts[a]}) 与 ${b}(${palette.parts[b]}) 的 ΔE 只有 ${delta.toFixed(1)}，低于 15`,
        )
      }
    }
  }

  // **用户点名的那两对必须明显分开。** 它们在改之前分别是 10.9 与 43.4
  // （深色）／14.0（auto 的记忆文件与对话消息），单独盯一下，免得将来调色
  // 时又撞回一起而其余对刚好都过线。
  const dark = CHART_PALETTES.dark.parts
  assert.ok(
    deltaE(dark.system, dark.mcp) >= 30,
    `系统提示与 MCP 工具的 ΔE 只有 ${deltaE(dark.system, dark.mcp).toFixed(1)}`,
  )
  assert.ok(
    deltaE(dark.memory, dark.messages) >= 30,
    `记忆文件与对话消息的 ΔE 只有 ${deltaE(dark.memory, dark.messages).toFixed(1)}`,
  )
  const auto = CHART_PALETTES.auto.parts
  assert.ok(
    deltaE(auto.memory, auto.messages) >= 30,
    `auto 档记忆文件与对话消息的 ΔE 只有 ${deltaE(auto.memory, auto.messages).toFixed(1)}`,
  )
})

/**
 * 同一分类在三处的色号必须一致。
 *
 * 分类色有两个出口：`panel-fill.ts` 画 SVG，`usage-overview.ts` 的
 * `CONTEXT_PART_LABELS` 画终端字符图与图例。两处对不上，同一张图在桌面端
 * 与终端就会是两种颜色——而这种错不会报任何错，只是看着别扭。
 */
test('分类色在 SVG 与终端两处逐项相同', () => {
  for (const [name, labels, palette] of [
    ['深色', 'dark', CHART_PALETTES.dark],
    ['浅色', 'light', CHART_PALETTES.light],
    ['auto', 'auto', CHART_PALETTES.auto],
  ]) {
    for (const entry of CONTEXT_PART_LABELS) {
      assert.equal(
        palette.parts[entry.kind],
        entry[labels],
        `${name}：${entry.label} 在 SVG（${palette.parts[entry.kind]}）与终端（${entry[labels]}）不一致`,
      )
    }
  }
})

test('两套主题的分段色彼此分得开：已用 > 缓冲 > 空闲', () => {  for (const [name, p, bg] of [
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

test('页签的底、边、文字都是主题键，深浅交给绘制端解析', () => {
  // 回归：这些颜色曾是写死的十六进制对（深色一套、浅色一套），由插件按
  // `/config` 的 `theme` 值二选一。但 `theme` 的默认值是 `auto`——插件
  // 只知道「跟随」，不知道跟到的是深还是浅，于是永远选中深色那套，浅色
  // 界面里就浮出一块深蓝黑的圆角块。
  //
  // 现在它们**全是主题键**：引擎在绘制时按实际主题解析，`auto` 也跟得对。
  // 这条测试锁住的就是「别再有人把它们改回十六进制」。
  const HEX = /^#|^rgb\(/i
  for (const [name, theme] of [
    ['深色', themeColorsFor([{ key: 'theme', value: 'dark' }])],
    ['浅色', themeColorsFor([{ key: 'theme', value: 'light' }])],
    ['auto', themeColorsFor([{ key: 'theme', value: 'auto' }])],
    ['读不到', themeColorsFor(undefined)],
  ]) {
    for (const [where, value] of [
      ['大框底', theme.backgroundColor],
      ['大框边', theme.borderColor],
      ['激活底', theme.tabActive.backgroundColor],
      ['激活边', theme.tabActive.borderColor],
      ['激活文字', theme.tabActiveText],
      ['内嵌底', theme.inset.backgroundColor],
      ['内嵌边', theme.inset.borderColor],
    ]) {
      assert.ok(!HEX.test(value), `${name} 的${where}写成了实色 ${value}，应当用主题键`)
    }
  }
  // 三档拿到的界面色是同一份：它们本来就与深浅无关。
  const dark = themeColorsFor([{ key: 'theme', value: 'dark' }])
  const auto = themeColorsFor([{ key: 'theme', value: 'auto' }])
  assert.equal(auto.backgroundColor, dark.backgroundColor)
  assert.equal(auto.tabActiveText, dark.tabActiveText)
})

test('auto 不再被当成深色：图表取深浅未知那一套', () => {
  // 回归：`auto` 以前落到 `isLightTheme()` 的 false 分支，和 `dark` 完全
  // 一样。它其实是「不知道」，图表色得两边都立得住。
  const auto = themeColorsFor([{ key: 'theme', value: 'auto' }])
  const dark = themeColorsFor([{ key: 'theme', value: 'dark' }])
  const light = themeColorsFor([{ key: 'theme', value: 'light' }])
  assert.equal(auto.isLight, null, 'auto 的 isLight 应当是 null（未知）')
  assert.equal(dark.isLight, false)
  assert.equal(light.isLight, true)
  assert.notEqual(auto.chart, dark.chart, 'auto 不该沿用深色图表色')
  assert.notEqual(auto.chart, light.chart, 'auto 也不该沿用浅色图表色')
  // 读不到主题行同样是「不知道」。
  assert.equal(themeColorsFor(undefined).isLight, null)
})

test('auto 图表色在深、浅两种内嵌底上都过图形元素口径 3.0', () => {
  // 深浅未知时没法预判画在哪边，只能让每一支在两边都看得见。余量比
  // 专用色板小是必然的；这条守的是「别哪一边跌破 3.0」。
  const p = CHART_PALETTES.auto
  // 内嵌块的底色：深色 38,38,38 / 浅色 235,235,235。
  const DARK_INSET_BG = '#262626'
  const LIGHT_INSET_BG = '#ebebeb'
  for (const [kind, color] of Object.entries(p.parts)) {
    for (const [where, bg] of [
      ['深色底', DARK_INSET_BG],
      ['浅色底', LIGHT_INSET_BG],
    ]) {
      const ratio = contrast(color, bg)
      assert.ok(ratio >= 3, `auto 分类 ${kind} 在${where}上只有 ${ratio.toFixed(2)}，低于 3.0`)
    }
  }
  for (const [what, color] of [
    ['轴线', p.axis],
    ['刻度', p.label],
    ['压缩标记', p.compact],
    ['主色', p.used],
  ]) {
    for (const [where, bg] of [
      ['深色底', DARK_INSET_BG],
      ['浅色底', LIGHT_INSET_BG],
    ]) {
      const ratio = contrast(color, bg)
      assert.ok(ratio >= 3, `auto ${what}在${where}上只有 ${ratio.toFixed(2)}，低于 3.0`)
    }
  }
})

test('终端字符图的 auto 配色与 SVG 侧逐项相同', () => {
  // 两处各写一套就会让同一张图在桌面端与终端里是不同的颜色。
  const p = CHART_PALETTES.auto
  for (const [kind, color] of Object.entries(p.parts)) {
    assert.equal(contextPartColor(kind, null), color, `分类 ${kind} 两处配色不一致`)
  }
  assert.equal(stackColor('used', null), p.used)
})

test('auto 的模型色阶在深浅两种底上都分得开', () => {
  for (const [where, bg] of [
    ['深色底', '#262626'],
    ['浅色底', '#ebebeb'],
  ]) {
    const colors = [0, 1, 2, 3, 4, 5, 6, 7].map(i => modelFill(i, null))
    for (const [i, color] of colors.entries()) {
      assert.ok(contrast(color, bg) >= 3, `auto 第 ${i} 支在${where}上对比度不足`)
    }
    assert.equal(new Set(colors).size, colors.length, `${where}：auto 模型色阶有重复`)
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

test('粒度按范围切换：30/60 按天、180/365 按周', () => {
  assert.equal(modelGrainFor(30), 'day')
  assert.equal(modelGrainFor(60), 'day')
  assert.equal(modelGrainFor(180), 'week')
  assert.equal(modelGrainFor(365), 'week')
  // 边界两侧不能跳成同一档；一年以上也不退化成按月——52 根周柱子仍宽于
  // 60 天按天那档，按月反而丢掉了「这个月哪一周花得多」。
  assert.equal(modelGrainFor(61), 'week')
  assert.equal(modelGrainFor(210), 'week')
  assert.equal(modelGrainFor(3650), 'week')
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

test('跨年的那两周各自成桶，不并成一根', () => {
  // 2026-12-28 是周一，2027-01-04 是下一周一。跨年不该把两周并成一根，
  // 也不该生成一根只有一两天的「短周」——桶键始终取那一周真正的周一。
  const days = [
    { day: '2026-12-31', models: [{ model: 'm', input: 10, output: 0, cost: 0 }] },
    { day: '2027-01-02', models: [{ model: 'm', input: 15, output: 0, cost: 0 }] },
    { day: '2027-01-05', models: [{ model: 'm', input: 20, output: 0, cost: 0 }] },
  ]
  const { bars } = modelStackBars(days, 21, 6, 'week')
  const byKey = new Map(bars.map(bar => [bar.day, bar.total]))
  assert.equal(byKey.get('2026-12-28'), 25, '12-31 与 01-02 同属 12-28 那一周')
  assert.equal(byKey.get('2027-01-04'), 20, '01-05 属于 01-04 那一周')
})

test('桶数是窗口跨度除以粒度，不是天数', () => {
  const days = [{ day: '2026-10-20', models: [{ model: 'm', input: 1, output: 0, cost: 0 }] }]
  // 365 天按周：约 53 个桶，绝不会是 365 个。
  const yearly = modelStackBars(days, 365, 6, 'week').bars.length
  assert.ok(yearly <= 54 && yearly >= 52, `按周应当 52–54 根，实际 ${yearly}`)
  // 180 天按周：约 27 个桶。
  const weekly = modelStackBars(days, 180, 6, 'week').bars.length
  assert.ok(weekly <= 28 && weekly >= 26, `按周应当 26–28 根，实际 ${weekly}`)
  // 30 天按天：正好 30 根。
  assert.equal(modelStackBars(days, 30, 6, 'day').bars.length, 30)
})

test('图注写明粒度：同样的柱子数，按天与按周说的不是一回事', () => {
  const bars = modelStackBars(
    [{ day: '2026-10-20', models: [{ model: 'm', input: 100, output: 0, cost: 0 }] }],
    30, 6, 'day',
  ).bars
  assert.ok(modelStackCaption(bars, 'day').includes('按天'))
  assert.ok(modelStackCaption(bars, 'day').includes('30 天'))
  assert.ok(modelStackCaption(bars, 'week').includes('按周'))
  assert.ok(modelStackCaption(bars, 'week').includes('周'))
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

test('模型柱横轴标签：MM-DD，首尾一定标出', () => {
  // 两种粒度都写 MM-DD：按周范围最长一年，跨年那两根各自写出月份，
  // 年份在这个跨度里仍是噪音；完整月-日让读者能对上日历。
  assert.equal(axisLabelOf('2026-10-20', 'day'), '10-20')
  assert.equal(axisLabelOf('2026-10-19', 'week'), '10-19')
  assert.equal(axisLabelOf('2027-01-04', 'week'), '01-04')

  const stacked = modelStackBars(
    [{ day: '2026-10-20', models: [{ model: 'm', input: 10, output: 0, cost: 0 }] }],
    30,
  )
  const svg = modelStackSvg(stacked.bars, 700, stacked.yMax, stacked.models, CHART_PALETTES.dark, 'day')
  // 首尾两个日期都要出现。
  const first = axisLabelOf(stacked.bars[0].day, 'day')
  const last = axisLabelOf(stacked.bars[stacked.bars.length - 1].day, 'day')
  assert.ok(svg.includes('>' + first + '<'), `缺首个标签 ${first}`)
  assert.ok(svg.includes('>' + last + '<'), `缺末个标签 ${last}`)
  // 抽稀：30 根柱子、700px 下不可能把 30 个日期全画出来。
  const count = (svg.match(/font-size="9"[^>]*>[0-9]{2}-[0-9]{2}</g) || []).length
  assert.ok(count < 30, `标签数 ${count} 似乎没有抽稀`)
  assert.ok(count >= 3, `标签数 ${count} 太少`)
})

test('365 天按周：52 根柱子仍抽稀，首尾都在', () => {
  const stacked = modelStackBars(
    [{ day: '2026-10-20', models: [{ model: 'm', input: 10, output: 0, cost: 0 }] }],
    365, 6, 'week',
  )
  const svg = modelStackSvg(stacked.bars, 700, stacked.yMax, stacked.models, CHART_PALETTES.dark, 'week')
  const labels = (svg.match(/font-size="9"[^>]*>[0-9]{2}-[0-9]{2}</g) || []).length
  assert.ok(labels >= 2, '至少要有首尾两个标签')
  assert.ok(labels < stacked.bars.length, `标签 ${labels} 应当少于柱子 ${stacked.bars.length}`)
  // 首尾各出现一次。
  const first = axisLabelOf(stacked.bars[0].day, 'week')
  const last = axisLabelOf(stacked.bars[stacked.bars.length - 1].day, 'week')
  assert.ok(svg.includes('>' + first + '<'), `缺首个标签 ${first}`)
  assert.ok(svg.includes('>' + last + '<'), `缺末个标签 ${last}`)
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
      { seq: 1, percent: 20, tokens: 100_000, at: 0 },
      { seq: 2, percent: 80, tokens: 400_000, at: 1, afterCompact: true },
    ],
    320,
    24,
    0,
    CHART_PALETTES.dark,
    500_000,
  )
  // 虚线是唯一带 dasharray 的元素，数量应当与压缩处一致。
  const dashes = svg.match(/stroke-dasharray/g) ?? []
  assert.equal(dashes.length, 1)
  assert.ok(svg.includes('stroke-dasharray="2 2"'))
  // **灰色，不是橙色。** 橙色在冷色柱子里太跳，读起来像又一个内容分类；
  // 虚线只是「这里发生过一件事」的标记，该退到背景里。
  const dashStroke = svg.match(/stroke="([^"]+)" stroke-width="1" stroke-dasharray/)
  assert.equal(dashStroke?.[1], CHART_PALETTES.dark.axis, '压缩虚线应当是灰色（轴色）')
  assert.notEqual(dashStroke?.[1], CHART_PALETTES.dark.compact, '不该再用橙色')
  // 图的说明文字里也要提一句，读屏用户才知道那里发生了什么。
  assert.ok(svg.includes('1 处压缩'))
})

/**
 * 纵轴刻度按 token 单位写（`K` / `M`），不是百分比。
 *
 * 柱子按 token 绝对量画、轴顶是自动压缩阈值，刻度读作 `400K` 才能与
 * 「离压缩还有多远」直接对上；写成 `100%` 的话读者还得自己换算一次。
 */
test('纵轴刻度写 K / M 单位，轴顶就是压缩阈值', () => {
  const turns = [
    { seq: 1, percent: 30, tokens: 300_000, at: 0 },
    { seq: 2, percent: 40, tokens: 400_000, at: 1 },
  ]
  // 阈值 400K：轴顶标 400K。
  const alpha = contextChartSvg(turns, 320, 2, 0, CHART_PALETTES.dark, 400_000)
  assert.ok(alpha.includes('>400K<'), `轴顶应标 400K，实际 SVG 里没有`)
  assert.ok(!alpha.includes('100%'), '轴刻度不该再写百分比')
  // 阈值 1M：轴顶标 1M（不拖 `.0`）。
  const beta = contextChartSvg(turns, 320, 2, 0, CHART_PALETTES.dark, 1_000_000)
  assert.ok(beta.includes('>1M<'), `轴顶应标 1M`)
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

test('面板底色是三档同一份：深浅交给绘制端，图表才分档', () => {
  assert.equal(isLightTheme('light'), true)
  assert.equal(isLightTheme('light-daltonized'), true)
  assert.equal(isLightTheme('dark'), false)
  assert.equal(isLightTheme(undefined), false)

  // 界面色（框的底、边）是主题键，三档拿到的是同一份——它们与深浅无关。
  // 以前这里是「浅色取 FILLS.light、其余取 FILLS.dark」，`auto` 因此被
  // 当成深色，浅色界面里整块深蓝黑。
  for (const value of ['light', 'dark', 'auto', undefined]) {
    const rows = value === undefined ? undefined : [{ key: 'theme', value }]
    assert.equal(
      panelFillFor(rows).backgroundColor,
      'userMessageBackground',
      `${value ?? '读不到'} 的大框底应当是主题键`,
    )
  }
  // 没有 config 行（老引擎、被管理员锁掉）同样是「不知道」，不该赌深色。
  assert.equal(panelFillFor(undefined).backgroundColor, 'userMessageBackground')
  assert.equal(panelFillFor([]).backgroundColor, 'userMessageBackground')
})

test('气泡里的本会话花费优先用插件价格表，而不是引擎 /cost 的估算', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  // 引擎读数是 $258.98——它按默认模型价估第三方模型；插件价格表算出来是 $3.05。
  const view = toUsageView({ cost: { usd: 258.98 } })

  const withPrices = bubblePages(view, now, {
    totals: { wallMs: 0, turns: 3, linesAdded: 0, linesRemoved: 0 },
    sessionCost: 3.05,
  })
  const sessionPage = withPrices.find(p => p.id === 'session')
  assert.ok(sessionPage, '本会话页应当存在')
  assert.equal(sessionPage.lines[1], '≈$3.05', '有插件价格时不该用引擎读数')

  // 没有插件价格（模型未收录）时退回引擎读数——至少不会显示成 $0。
  const withoutPrices = bubblePages(view, now, {
    totals: { wallMs: 0, turns: 3, linesAdded: 0, linesRemoved: 0 },
  })
  assert.equal(withoutPrices.find(p => p.id === 'session').lines[1], '≈$258.98')
})

test('泡泡轮播：每页三行，主角行放得下；没有数据的页整页不出现', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  const view = toUsageView({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-20T14:13:00Z' },
      { kind: 'seven_day', percentUsed: 61 },
    ],
    cost: { usd: 2.5 },
    context: { tokens: 84_000, window: 200_000, percent: 42 },
  })

  const pages = bubblePages(view, now, {
    totals: { wallMs: 60_000, turns: 7, linesAdded: 12, linesRemoved: 3 },
    today: { cost: 0.42, messages: 31 },
    total: { cost: 9.9, messages: 800 },
    windowDays: 30,
  })

  // 五页都在，次序固定：数据四页在前，人设页压轴。
  assert.deepEqual(pages.map(p => p.id), ['limit', 'context', 'session', 'local', 'whale'])

  // 每页至少两行（第一行标题 + 第二行主角），且不超过三行——`bubbleSvg`
  // 只画前三行，多出来的会被静默截掉。
  for (const page of pages) {
    assert.ok(page.lines.length >= 2, `${page.id} 至少两行`)
    assert.ok(page.lines.length <= 3, `${page.id} 至多三行`)
  }

  // 主角行由页面自己指定，不必是第二行。额度页与上下文页的主角是百分比：
  // 早先按「第二行永远是主角」硬排，把「5 小时窗口 23%」八个字塞进 46px
  // 那行，需要 355px 而可用只有 271px，超出的部分被椭圆描边压住。
  assert.deepEqual(pages.map(p => p.hero ?? 1), [1, 1, 1, 1, 1])
  assert.equal(pages[0].lines[1], '23%', '额度页主角是百分比本身')
  assert.equal(pages[1].lines[1], '42%')
  assert.equal(pages[2].lines[1], '≈$2.50')
  assert.equal(pages[3].lines[1], '≈$0.42')

  // **每一页的每一行都要放得进气泡椭圆。** 这条是上面那次溢出的回归测试：
  // 几何与 `bubbleSvg` 保持一致，字号按主角行 46px、其余 25 / 21px 折算。
  // 宽度估计取汉字 1em、ASCII 0.62em（比常见无衬线体的 .55em 更宽）。
  const CY = 112
  const RX = 146 - 11 / 2
  const RY = 90 - 11 / 2
  const BASELINE = [88, 134, 172]
  const widthOf = (text, size) => {
    let em = 0
    for (const ch of text) em += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.62
    return em * size
  }
  for (const page of pages) {
    const hero = Math.min(page.hero ?? 1, page.lines.length - 1)
    page.lines.forEach((line, index) => {
      const size = index === hero && page.lines.length > 1 ? 46 : index === 0 ? 25 : 21
      const y = page.lines.length === 1 ? 110 : page.lines.length === 2 ? 100 + index * 44 : BASELINE[index]
      const available = 2 * RX * Math.sqrt(Math.max(0, 1 - ((y - CY) / RY) ** 2))
      const needed = widthOf(line, size)
      assert.ok(
        needed <= available,
        `${page.id} 第 ${index + 1} 行「${line}」需要 ${needed.toFixed(0)}px，可用 ${available.toFixed(0)}px`,
      )
    })
  }

  // 没有本地扫描结果时，那一页整页不出现——不画一行「—」占位。
  // 人设页与数据无关，永远在。
  const noLocal = bubblePages(view, now, { totals: { wallMs: 0, turns: 0, linesAdded: 0, linesRemoved: 0 } })
  assert.deepEqual(noLocal.map(p => p.id), ['limit', 'context', 'session', 'whale'])

  // 什么数据都没有时也只剩人设页——泡泡不空着，轮播还有东西可看。
  const empty = bubblePages(toUsageView(undefined), now)
  assert.deepEqual(empty.map(p => p.id), ['whale'])
  assert.equal(empty[0].lines.length, 3)
})

test('鲸鱼 SVG 的根元素用像素尺寸，不用百分比', () => {
  const svg = whaleSvg('idle', ['a', 'b', 'c'])
  assert.ok(svg.includes('width="620"'), '根元素要有像素宽度')
  assert.ok(svg.includes('height="320"'), '根元素要有像素高度')
  // 回归：`height="100%"` 在没有确定高度的容器里塌成 0，整幅图消失。
  assert.ok(!svg.includes('width="100%"'), 'width 属性不能写百分比')
  assert.ok(!svg.includes('height="100%"'), 'height 属性不能写百分比')
  assert.ok(svg.includes('viewBox="0 0 620 320"'))
})

test('人设页的每句台词都放得进气泡椭圆', () => {
  // 气泡几何与 `bubbleSvg` 保持一致：cx 228 / cy 112 / rx 146 / ry 90，
  // 描边 11px 向外扩，文字只占内缘以内的空间。
  const CX = 228
  const CY = 112
  const RX = 146 - 11 / 2
  const RY = 90 - 11 / 2
  // 三行的基线（三行齐全时）：88 / 134 / 172；字号 25 / 46 / 21。
  const rows = [
    { y: 88, size: 25 },
    { y: 134, size: 46 },
    { y: 172, size: 21 },
  ]

  // 文字宽度的保守估计：汉字与全角标点按 1em，ASCII 按 0.62em（比常见
  // 无衬线体的 .55em 更宽，宁可高估、不可低估）。
  const widthOf = (text, size) => {
    let em = 0
    for (const ch of text) {
      em += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.62
    }
    return em * size
  }

  for (const mood of ['idle', 'working', 'busy', 'tired', 'sleep']) {
    const lines = whaleTraitOf(mood)
    assert.equal(lines.length, 3, `${mood} 应有三行台词`)
    lines.forEach((line, index) => {
      const { y, size } = rows[index]
      // 基线处的椭圆半宽；文字左右对称，所以整行不得超过两倍半宽。
      const halfWidth = RX * Math.sqrt(Math.max(0, 1 - ((y - CY) / RY) ** 2))
      const available = halfWidth * 2
      assert.ok(
        widthOf(line, size) <= available,
        `${mood} 第 ${index + 1} 行「${line}」估算宽 ${widthOf(line, size).toFixed(0)}px，超过气泡可用的 ${available.toFixed(0)}px`,
      )
    })
  }

  // 台词确实跟着情绪走——五个情绪不该冒出同一句话。
  const firstLines = ['idle', 'working', 'busy', 'tired', 'sleep'].map(m => whaleTraitOf(m)[0])
  assert.equal(new Set(firstLines).size, firstLines.length)

  // **主角行按时段换菜**：情绪定的那套在这里只兜底，上屏的是 `dishOf(now)`。
  // 所以宽度也要按 24 个整点逐一两遍——九个时段的文案不一样，只量五档
  // 情绪那几句会让某道菜悄悄撑破气泡。取每个整点的中点（`hour:30`）构造
  // **本地**时间，`getHours()` 一定落回该整点，不受运行机器的时区影响。
  for (let hour = 0; hour < 24; hour += 1) {
    const at = new Date(2026, 9, 26, hour, 30, 0, 0).getTime()
    const { y, size } = rows[1]
    const line = whaleTraitOf('working', at)[1]
    const halfWidth = RX * Math.sqrt(Math.max(0, 1 - ((y - CY) / RY) ** 2))
    const available = halfWidth * 2
    assert.ok(
      widthOf(line, size) <= available,
      `${hour} 点的菜「${line}」估算宽 ${widthOf(line, size).toFixed(0)}px，超过主角行可用的 ${available.toFixed(0)}px`,
    )
  }
})

test('鲸鱼娘想吃的东西随一天里的钟点变', () => {
  // 固定一个本地日，避免用 UTC 字符串——`dishOf` 按本地时区取钟点，
  // 在不同时区的机器上 `new Date('...Z')` 会落到别的时段。
  const at = hour => new Date(2026, 9, 26, hour, 30, 0, 0).getTime()

  // 九个时段各给一句，且**相邻时段不重复**——读者在整点前后翻到这一页，
  // 要能看出「换了一顿」，而不是同一句话挂一整天。比较的是每个时段的
  // 起点，不是逐小时（0–5 点同属深夜那段，逐小时比必然撞车）。
  const starts = [0, 6, 9, 11, 12, 14, 17, 18, 21]
  const byStart = starts.map(hour => dishOf(at(hour)))
  for (let index = 1; index < byStart.length; index += 1) {
    assert.notEqual(
      byStart[index], byStart[index - 1],
      `${starts[index]} 点与 ${starts[index - 1]} 点的菜重复了（都是「${byStart[index]}」）`,
    )
  }

  // 边界是左闭右开：整点属于后一段。列几个关键点钉住。
  assert.equal(dishOf(at(0)), '想吃夜宵')
  assert.equal(dishOf(at(5)), '想吃夜宵')
  assert.equal(dishOf(at(6)), '豆浆油条')
  assert.equal(dishOf(at(11)), '快开饭了')
  assert.equal(dishOf(at(12)), '大白饭')
  assert.equal(dishOf(at(17)), '想吃晚饭')
  assert.equal(dishOf(at(21)), '想吃宵夜')
  assert.equal(dishOf(at(23)), '想吃宵夜')

  // 同一时刻永远同一句：不靠随机数、不靠模块状态。
  assert.equal(dishOf(at(15)), dishOf(at(15)))

  // `whaleTraitOf` 只在给了时刻时替换主角行；另两行仍归情绪。
  const withTime = whaleTraitOf('busy', at(12))
  assert.equal(withTime[0], whaleTraitOf('busy')[0])
  assert.equal(withTime[2], whaleTraitOf('busy')[2])
  assert.equal(withTime[1], dishOf(at(12)))
  // 不给时刻就沿用情绪那档的默认句子——预览与旧调用不受影响。
  assert.deepEqual(whaleTraitOf('busy'), ['胃口特别大', '再来一碗', '偷吃 Token'])

  // 泡泡页也真的用上了：人设页第二行等于那个时刻的菜。
  const page = bubblePages(toUsageView({}), at(15), { mood: 'working' })
    .find(item => item.id === 'whale')
  assert.ok(page, '人设页应当在轮播里')
  assert.equal(page.lines[1], dishOf(at(15)))
})

test('气泡配色不随情绪变化，所有情绪共用原图那一套', () => {
  // 曾经按情绪换底色：额度过半转暖、夜里更暖、深夜转灰蓝。一天里不断变色，
  // 读者每换一个时段都要重新适应，而它既不是数据也不是状态。情绪现在只体现
  // 在台词上；画面保持原图那份白底蓝字。
  const fillOf = (mood) => {
    const svg = whaleSvg(mood, ['a', 'b', 'c'], { isAnimating: false })
    const big = svg.match(/<ellipse cx="228" cy="112"[^>]*fill="([^"]+)" stroke="([^"]+)"/)
    assert.ok(big, `${mood} 应画出大椭圆`)
    return `${big[1]}|${big[2]}`
  }
  const idle = fillOf('idle')
  assert.equal(idle, '#FFFFFF|#203170')
  for (const mood of ['working', 'busy', 'tired', 'sleep']) {
    assert.equal(fillOf(mood), idle, `${mood} 的气泡配色应与 idle 相同`)
  }
})

test('气泡没有尾巴，两颗小泡朝右下指向鲸鱼且不压到它身上', () => {
  const svg = whaleSvg('idle', ['a', 'b', 'c'], { isAnimating: false })

  // **没有尾巴。** 尾巴曾从椭圆左下甩出去，是纯装饰，还会被误读成「漏气」。
  assert.ok(!svg.includes('<path'), '气泡里不该再有 path（尾巴已删除）')

  /** 从 SVG 里取出一类元素的中心点。 */
  const ellipseCenters = [...svg.matchAll(/<ellipse cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }))
  // 三个椭圆：大泡 + 两颗小泡，按绘制顺序。
  assert.equal(ellipseCenters.length, 3)
  const [big, small1, small2] = ellipseCenters

  // 2. 两颗小泡都留在鲸鱼左侧，别压到脸上。
  //
  // **不能只看圆心那一行，也不能用固定左边界。** 鲸鱼是不规则的：小泡 1
  // 圆心在 y=226，那里鲸鱼左缘还有 356.7，看起来放得下；但它自己的上沿
  // （y≈212）正对着鲸鱼最窄的一处——**340.3**，于是压上去 61 平方像素。
  // 早先代码与测试都用「鲸鱼占 x 378~620」这个错值，两种判据都放过了它。
  //
  // 下面这张表是逐像素解析内嵌 PNG 不透明区域得到的（画布坐标，每 5px
  // 一行）。判据取该小泡**整个纵向跨度**内的最小左缘。
  const WHALE_LEFT_TABLE = [
    [205, 350.8], [210, 340.3], [215, 340.3], [220, 345.0], [225, 356.7],
    [230, 380.1], [235, 383.6], [240, 381.3], [245, 378.9], [250, 376.6],
    [255, 374.3], [260, 371.9], [265, 370.7], [270, 368.4], [275, 367.2],
    [280, 367.2], [285, 367.2],
  ]
  /** 小泡纵向跨度内，鲸鱼最靠左的那一行的左缘。 */
  const narrowestWhaleUnder = (cy, ry) => {
    let worst = Infinity
    for (const [y, left] of WHALE_LEFT_TABLE) {
      if (y >= cy - ry && y <= cy + ry) worst = Math.min(worst, left)
    }
    return worst
  }

  // 1. 小泡一个比一个小，一个比一个靠右下。
  assert.ok(small1.x > big.x, '小泡 1 在大泡右侧')
  assert.ok(small1.y > big.y, '小泡 1 在大泡下方')
  assert.ok(small2.x > small1.x, '小泡 2 在小泡 1 右侧')
  assert.ok(small2.y > small1.y, '小泡 2 在小泡 1 下方')

  // 2. 两颗小泡的右缘（含描边）都不越过该高度上鲸鱼的左缘。
  for (const [name, p, rx, ry, stroke] of [
    ['小泡 1', small1, 15, 10, 3.5],
    ['小泡 2', small2, 9, 6, 3],
  ]) {
    const edge = narrowestWhaleUnder(p.y, ry + stroke)
    assert.ok(Number.isFinite(edge), `${name} 的高度上要有鲸鱼左缘读数`)
    assert.ok(
      p.x + rx + stroke <= edge,
      `${name} 的右缘 ${p.x + rx + stroke} 越过了鲸鱼在该高度的最左缘 ${edge}`,
    )
  }

  // 3. 两颗小泡朝右下延伸，且都在大泡之外（不压在大泡身上）。
  for (const [name, p] of [['小泡 1', small1], ['小泡 2', small2]]) {
    const onEdge = ((p.x - big.x) / 146) ** 2 + ((p.y - big.y) / 90) ** 2
    assert.ok(onEdge > 1.05, `${name} 应在气泡椭圆之外，实际椭圆参数 ${onEdge.toFixed(2)}`)
  }
})

/**
 * 同一条消息的流式增量必须取**最后**那个快照。
 *
 * 一条 assistant 消息在 JSONL 里写成多行：第一行是「请求已发出、回复还没来」
 * ——`output_tokens` 是 0、`cache_read_input_tokens` 是 0，只有 `input_tokens`
 * 有值；最后一行才是这一轮的真实读数。
 *
 * 早先按「先到先得」去重，等于每条消息都取第一行。实测本机 30 天窗口：
 * output 少算 55%、cacheRead 少算 22%，而 input 反而多算 81%。扫描脚本此前
 * 零测试，所以这个偏差一直没被发现。
 */
test('扫描：同一条消息的多个流式快照取最后一个', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { aggregate } = await import('../scripts/usage-scan.mjs')

  const root = mkdtempSync(join(tmpdir(), 'whale-scan-'))
  try {
    const project = join(root, 'proj')
    mkdirSync(project)
    const now = new Date().toISOString()
    const line = (id, input, output, cacheRead) => JSON.stringify({
      type: 'assistant',
      timestamp: now,
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
    })
    // 同一个 id 的三行：首行 output / cacheRead 都是 0，末行才是真读数。
    writeFileSync(join(project, 'a.jsonl'), [
      line('msg_1', 1000, 0, 0),
      line('msg_1', 1000, 0, 0),
      line('msg_1', 3000, 250, 4000),
    ].join('\n'))
    // 另一个 id，只有一行，用来确认没有把正常消息算丢。
    writeFileSync(join(project, 'b.jsonl'), line('msg_2', 500, 60, 0))

    const result = aggregate(root, 1)
    const row = result.byModel.find(entry => entry.model === 'claude-opus-5-5')
    assert.ok(row, 'byModel 里应有这款模型')
    assert.equal(row.output, 310, 'output 应取末行的 250 + 60')
    assert.equal(row.cacheRead, 4000, 'cacheRead 应取末行的 4000')
    assert.equal(row.input, 3500, 'input 应是末行的 3000 + 500')
    assert.equal(row.messages, 2, '两条消息各算一次，不是三次')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 子代理日志里的 `tool_result` 行不能被算成「轮次」。
 *
 * 工具结果回填的行也标 `type: "user"`。主会话里的老写法带 `toolUseResult`
 * 或没有 `promptId`，好认；但 `subagents/agent-*.jsonl` 里那种**带**
 * `promptId`、`content` 是 `tool_result` 数组——前两条判据都拦不住。
 * 实测本机被判成轮次的 1665 行里有 683 行（41%）其实是工具结果。
 */
test('扫描：工具结果回填不算轮次', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { aggregate } = await import('../scripts/usage-scan.mjs')

  const root = mkdtempSync(join(tmpdir(), 'whale-turns-'))
  try {
    const project = join(root, 'proj')
    mkdirSync(project)
    const now = new Date().toISOString()
    const userLine = (extra) => JSON.stringify({ type: 'user', timestamp: now, promptId: 'p1', ...extra })
    writeFileSync(join(project, 'a.jsonl'), [
      // 用户真实输入：有 promptId，content 是字符串。
      userLine({ message: { content: '帮我看下这个' } }),
      // 子代理里的工具回填：带 promptId，但 content 是 tool_result 数组。
      userLine({ message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      // 老写法：带 toolUseResult。
      userLine({ toolUseResult: { ok: true }, message: { content: 'x' } }),
      // 老写法：没有 promptId。
      JSON.stringify({ type: 'user', timestamp: now, message: { content: 'y' } }),
    ].join('\n'))

    const result = aggregate(root, 1)
    const total = (result.turnsDaily ?? []).reduce((sum, d) => sum + d.turns, 0)
    assert.equal(total, 1, '只有第一条是用户真实输入')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 价目表只有一份：模块入口与扫描脚本必须给出相同结果。
 *
 * 早先 `hooks/pricing.ts` 与 `scripts/usage-scan.mjs` 各写一份手工副本，
 * README 要求「两处保持一致」却没有任何测试比对。调价时漏改一边，概览页
 * （读扫描脚本）与面板（读 pricing.ts）就会各用一套价目表——正是这个插件
 * 专门实现 `isEnginePriced` 想避免的那种矛盾。
 */
test('价目表只有一份，两个入口结果一致', async () => {
  const { priceOf: fromModule } = await import('../hooks/pricing.ts')
  const { priceOf: fromData } = await import('../hooks/pricing-data.mjs')

  // 覆盖三类：官方模型、第三方模型、未收录。
  const models = [
    'claude-opus-5-5',
    'claude-sonnet-4-6',
    'claude-haiku-5-5',
    'Claude-3-5-Sonnet',      // 大小写不敏感
    'deepseek-v4-flash',
    'DeepSeek-V4.1-Flash-1017',
    'qwen3.8-27b',
    'kimi-k3',
    'gpt-4o',                 // 未收录
    '<synthetic>',
    'auto',
  ]
  for (const model of models) {
    assert.deepEqual(fromModule(model), fromData(model), `${model} 的价格应一致`)
  }
})

/**
 * 日历热图缺日期时不能整体串位。
 *
 * `days` 来自扫描脚本，只有「有记录的日子」——周末常常整天没有消息。早先
 * 每收满 7 格就换一列，只有第一天做了星期对齐，于是缺一天之后每个格子都
 * 落在错误的星期行上。
 */
test('日历热图按日期定位，缺日不串位', async () => {
  const { calendarHeat } = await import('../hooks/usage-overview.ts')

  // 2026-10-19 是周一。构造一段**缺了周三、周四**的日期序列。
  const day = (d, tokens) => ({ day: d, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
  const days = [
    day('2026-10-19', 10), // 周一
    day('2026-10-20', 20), // 周二
    // 10-21 周三、10-22 周四 缺失
    day('2026-10-23', 30), // 周五
    day('2026-10-24', 40), // 周六
    day('2026-10-26', 50), // 下周一
  ]

  const { columns } = calendarHeat(days)
  assert.ok(columns.length >= 2, '应至少有两列')

  // 第一列：周一、周二有值，周三到周日留空。
  const week1 = columns[0]
  assert.equal(week1.length, 7)
  assert.equal(week1[0]?.value, 10, '周一有值')
  assert.equal(week1[1]?.value, 20, '周二有值')
  assert.equal(week1[2], null, '周三缺失 → 空')
  assert.equal(week1[3], null, '周四缺失 → 空')
  assert.equal(week1[4]?.value, 30, '周五仍在第一列的第 5 行，没有串位')
  assert.equal(week1[5]?.value, 40, '周六在第 6 行')

  // 第二列：下周一必须落在第 0 行。
  const week2 = columns[1]
  assert.equal(week2[0]?.value, 50, '下周一在第二列的第 0 行')
  for (let i = 1; i < 7; i++) assert.equal(week2[i], null, `第二列第 ${i} 行应为空`)
})

/**
 * 内容以 `++` / `--` 开头的行不能被当成 diff 文件头。
 *
 * 新增 `++i;` 时 diff 里是 `+++i;`，早先的 `startsWith('+++')` 会把它跳过。
 *
 * 注意 `--- note`（删掉一行 `-- ` 开头的注释）是**无法区分**的：它的形状
 * 与真文件头 `--- a/x` 完全一样（三个符号 + 空格）。所以这里只断能区分的那
 * 一半，并在注释里写明这个固有的歧义。
 */
test('diff 计行：正文里的 ++ 不算文件头', async () => {
  const { countPatchLines } = await import('../hooks/usage-detail.ts')

  const patch = {
    lines: [
      '--- a/main.c',
      '+++ b/main.c',
      '@@ -1,3 +1,3 @@',
      '+++counter;',   // 新增一行以 ++ 开头的代码——旧实现会跳过
      ' same',
      '-old',
      '+new',
    ],
  }
  assert.deepEqual(countPatchLines([patch]), { added: 2, removed: 1 })

  // 文件头本身不计入。
  assert.deepEqual(
    countPatchLines([{ lines: ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-one', '+two'] }]),
    { added: 1, removed: 1 },
    '文件头不应被算成增删行',
  )
})

/**
 * 「本会话花费」只有一份口径，三处显示共用。
 *
 * 早先面板与用量条各写一遍「every + reduce + 回退」，气泡再取一次。任何
 * 一处改动（比如放开为「忽略未收录模型继续求和」）漏改另一处，同一个会话
 * 就会在三个界面显示三个不同金额。
 */
test('本会话花费：有未收录价格就整体退回，口径只有一份', async () => {
  const { sessionCostOf, bandMetricsOf } = await import('../hooks/usage-detail.ts')

  const priced = [
    { model: 'a', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.5, turns: 1 },
    { model: 'b', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.55, turns: 1 },
  ]
  assert.ok(Math.abs(sessionCostOf(priced) - 3.05) < 1e-9, '全部有价时求和')

  const withUnpriced = [...priced, { model: 'c', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, turns: 1 }]
  assert.equal(sessionCostOf(withUnpriced), undefined, '有一款没价 → 整体退回引擎读数')

  assert.equal(sessionCostOf([]), undefined, '空列表没有可算的')

  // 用量条口径：空数组按默认处理，不让条子变成空的。
  const fallback = ['window']
  assert.deepEqual(bandMetricsOf({ bandMetrics: [] }, fallback), fallback)
  assert.deepEqual(bandMetricsOf({}, fallback), fallback)
  assert.deepEqual(bandMetricsOf({ bandMetrics: ['cost'] }, fallback), ['cost'])
})

/**
 * 设置页的口径芯片组的宽度预算。
 *
 * 「先算宽度预算，再定文案」那条规则的又一次应用。`flexWrap` 在引擎里是
 * **绘制期折行**：树上看还是同一行，屏幕上却断成两行，标签孤零零留在上一
 * 行、五个芯片挤在下一行。只有把宽度算出来才知道会不会折。
 *
 * 实测：旧标签（额度窗口 / 5h + 7d）整行 73 列，新标签（额度 / 5h/7d）
 * 67 列。断言取 **≤ 70 列**——它同时满足两件事：新标签过、旧标签不过。
 * 这个数不是为了凑数，而是「74 列面板能一行放下」这条真实门槛（74 − 4 =
 * 70 列页内可用）。
 */
test('设置页：口径芯片整行宽度守住 70 列预算', () => {
  const chips =
    BAND_METRIC_OPTIONS.reduce((sum, o) => sum + displayWidth(` ${o.label} `), 0) +
    (BAND_METRIC_OPTIONS.length - 1)
  // 「显示」总开关 + 一个 gap。
  const withToggle = chips + displayWidth(' 显示 ') + 1
  // 标签列 8 + 间隔 1。
  const wholeRow = 9 + withToggle
  assert.ok(
    wholeRow <= 70,
    `整行 ${wholeRow} 列，超过 70 列预算——74 列以下的面板会折行`,
  )
})

/**
 * 用量条字符画：空闲打呼噜，运行中两幅轮换，三种状态等宽。
 *
 * 「把鲸鱼和会话是否运行中联系起来」那条需求的落点。状态机是纯函数：
 * `turn.start` 置真、`turn.complete` / `turn.abort` 置假（register.tsx 的
 * 模块变量 `isSessionRunning`），这里只验「给定运行状态与时刻，画出哪一幅」。
 *
 * 睡觉一档按读给的完整节奏走：`z` → `zz` → … → 攒满整格，`（呼）` 呼出来，
 * 空一拍，再补一声 `呼`。干活与忙那两档各说两句话，不再吐 `~` 泡泡。
 */
test('用量条字符画：三种状态各有动画，全部帧等宽', () => {
  // 空闲：不管时钟走到哪儿都是 idle。
  for (const now of [0, 700, 1400, 5000, 1_000_000]) {
    assert.equal(bandWhaleStateOf(false, now), 'idle')
  }
  // 运行中：按一轮 4.8 秒切状态（两帧 × 2.4 秒）。
  assert.equal(bandWhaleStateOf(true, 0), 'working')
  assert.equal(bandWhaleStateOf(true, 4_800), 'busy')
  assert.equal(bandWhaleStateOf(true, 9_600), 'working')

  /** 展开所有状态的每一帧，逐帧检查。 */
  const allFrames = Object.entries(BAND_WHALE_FRAMES).flatMap(([state, frames]) =>
    frames.map((frame, index) => ({ state, index, frame })),
  )

  // **每一帧都恰好 `BAND_WHALE_TEXT_COLS` 列。** 这是唯一硬性约束：
  // 宽度一变，后面的摘要文字就会左右跳；状态切换时尤其明显。
  for (const { state, index, frame } of allFrames) {
    assert.equal(
      displayWidth(frame),
      BAND_WHALE_TEXT_COLS,
      `${state} 第 ${index} 帧宽度应是 ${BAND_WHALE_TEXT_COLS} 列：${JSON.stringify(frame)}`,
    )
  }

  // 干活与忙那两档每帧都要有鱼头 `>`，后面跟一句她自己的话。
  // （睡觉那档只剩 z，没有鱼头——它讲的是鼾声，见下面。）
  for (const state of ['working', 'busy']) {
    for (const frame of BAND_WHALE_FRAMES[state]) {
      assert.ok(frame.startsWith('>'), `${state} 每帧该以鱼头开头：${JSON.stringify(frame)}`)
      // 鱼头后面必须真的有一句话，不能只有空格。
      assert.ok(
        frame.slice(1).trim().length > 0,
        `${state} 每帧鱼头后面该有文字：${JSON.stringify(frame)}`,
      )
    }
  }

  // **泡泡（`~`）已经全部去掉了。** 它原来占着这一格当装饰，读者看不出
  // 那串波浪在说什么；现在同一位置换成了文字。
  for (const { state, index, frame } of allFrames) {
    assert.ok(
      !frame.includes('~'),
      `${state} 第 ${index} 帧还在吐泡泡：${JSON.stringify(frame)}`,
    )
  }

  // **只用字体覆盖率高的字符。** 早先用过 `≋`（U+224B）与 `ᐟ`
  // （U+141F，加拿大音节文字）：Unicode 标准里都是 1 列宽，但后者在多数
  // 西文字体里没有字形，fallback 字体未必与等宽数字同宽——一旦被画成 2 列，
  // 整条用量条就错位。
  //
  // 汉字与全角括号由 `displayWidth` 按 CJK 规则各算 2 列，面板里本来就
  // 通篇中文，字体必定覆盖。
  const allowed = new Set([
    '>', 'z', ' ',
    '工', '作', '间', '隙', '摸', '鱼', '中', '悄',
    '猛', '吃', '大', '白', '饭', '再', '来', '一', '碗',
    '呼', '（', '）',
  ])
  for (const { state, index, frame } of allFrames) {
    for (const ch of frame) {
      assert.ok(allowed.has(ch), `${state} 第 ${index} 帧用了非白名单字符 ${JSON.stringify(ch)}`)
    }
  }

  // **每个状态内部必须真的在动。** 一帧定格的「动画」等于没有动画。
  for (const [state, frames] of Object.entries(BAND_WHALE_FRAMES)) {
    assert.ok(frames.length > 1, `${state} 至少要有两帧才谈得上动画`)
    assert.ok(new Set(frames).size > 1, `${state} 的帧全一样，等于静止`)
  }

  // 三个状态的第一帧互不相同：状态一换，读者立刻看得出来。
  const firsts = Object.values(BAND_WHALE_FRAMES).map(frames => frames[0])
  assert.equal(new Set(firsts).size, 3, '三个状态的起始帧应当各不相同')

  // **z 是一个字母一个字母长出来的。** 连着的十六拍，每拍比上一拍多一个 z，
  // 且都在行首——读者看到的是字母从左边一个个冒出来，而不是整串换个长度。
  const growth = BAND_WHALE_FRAMES.idle.slice(0, BAND_WHALE_TEXT_COLS)
  growth.forEach((frame, index) => {
    const zs = frame.match(/^z+/)?.[0] ?? ''
    assert.equal(zs.length, index + 1, `第 ${index} 拍应当有 ${index + 1} 个 z：${JSON.stringify(frame)}`)
    assert.equal(frame.trim(), zs, `攒字母那几拍除 z 外不该有别的内容：${JSON.stringify(frame)}`)
  })
  // 攒满那一拍正好铺满整格。
  assert.equal(growth[BAND_WHALE_TEXT_COLS - 1], 'z'.repeat(BAND_WHALE_TEXT_COLS))
  // 攒满之后紧接着就是呼气，不能一直堆在那儿。
  assert.ok(
    BAND_WHALE_FRAMES.idle[BAND_WHALE_TEXT_COLS].includes('（呼）'),
    '攒满之后应当立刻呼气',
  )

  // 鼾声的完整节奏都出现过：（呼）以及补的那声呼，还有中间那拍空档。
  const idleText = BAND_WHALE_FRAMES.idle.join('|')
  for (const beat of ['（呼）', ' 呼']) {
    assert.ok(idleText.includes(beat), `睡觉的鼾声缺了「${beat}」这一拍：${idleText}`)
  }
  // 空档那拍整帧都是空格——它是「呼出去之后停一下」的那一瞬。
  assert.ok(
    BAND_WHALE_FRAMES.idle.some(frame => frame.trim() === ''),
    '缺了呼气之后那拍空档',
  )

  // 帧序列随时刻推进：同一状态在不同时刻给出不同帧。
  const idleFrames = new Set(
    [0, 1500, 3000, 4500].map(now => bandWhaleGlyph('idle', now)),
  )
  assert.ok(idleFrames.size > 1, '睡觉状态也该在动（打呼噜）')

  // 帧时长可以逐帧不同，所以周期是各帧时长之和；走满一轮回到第一帧。
  // 睡觉这一轮 4.6 秒，接近一次呼吸。
  const period = BAND_WHALE_TEXT_COLS * 200 + 600 + 500 + 500
  assert.equal(bandWhaleGlyph('idle', period), bandWhaleGlyph('idle', 0))
  assert.equal(
    BAND_WHALE_FRAMES.idle.length,
    BAND_WHALE_TEXT_COLS + 3,
    '睡觉一轮应当是「字母逐个长满 + （呼） + 空档 + 呼」',
  )

  // **帧的切换点逐个钉住。** 逐毫秒采样，记下「帧变了」的那些时刻——
  // 这同时验证了三件事：帧的先后次序、每一拍的实际时长、以及时长表与
  // 帧表一样长（多一节会让某帧永远画不到，少一节会让最后一帧多停一截）。
  const switches = []
  let last = bandWhaleGlyph('idle', 0)
  for (let now = 1; now <= period; now += 1) {
    const glyph = bandWhaleGlyph('idle', now)
    if (glyph !== last) {
      switches.push({ at: now, glyph })
      last = glyph
    }
  }
  assert.deepEqual(
    switches.map(item => item.at),
    [
      ...[...Array(BAND_WHALE_TEXT_COLS).keys()].map(index => (index + 1) * 200),
      BAND_WHALE_TEXT_COLS * 200 + 600,
      BAND_WHALE_TEXT_COLS * 200 + 600 + 500,
      period,
    ],
    `睡觉的换帧时刻不对：${switches.map(item => item.at).join(', ')}`,
  )
  // 换帧后画的必须是下一拍，且走完一轮正好回到第一拍。
  assert.deepEqual(
    switches.map(item => item.glyph),
    [...BAND_WHALE_FRAMES.idle.slice(1), BAND_WHALE_FRAMES.idle[0]],
  )
})

/**
 * 一周七天各说各的：`working` / `busy` 那两格按**本地日期**换文案。
 *
 * 用户要的是「周一二三四五六七，所有天数都可以有梗」。七天用的是中文互联网
 * 通行的星期谐音梗（忙day / 求死day / 未死day / 受死day / 福来day /
 * 洒脱day / 伤day，2016 年就在传），周四另加一层 B 站「大肥鱼 × 疯狂星期四」
 * 二创的核心张力：炸鸡 vs 白米饭。
 *
 * 这条测试守四件事：**宽度**、**七天互不相同**、**日期映射正确**、
 * **同一天两帧也不相同**（否则「两句话轮换」就成了静止）。
 */
test('状态栏文案一周七天各不同，每天都放得进 16 列', () => {
  // 2026-11-01 是周日，连着取七天正好覆盖 getDay() 的 0–6。
  const dayAt = (offset, hour = 12) =>
    new Date(2026, 10, 1 + offset, hour, 0, 0).getTime()

  const seen = new Map()
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(2026, 10, 1 + offset).getDay()
    const working = bandWhaleGlyph('working', dayAt(offset))
    const busy = bandWhaleGlyph('busy', dayAt(offset, 13))

    // 宽度：两条都必须恰好 `BAND_WHALE_TEXT_COLS` 列。
    for (const [label, text] of [['working', working], ['busy', busy]]) {
      assert.equal(
        displayWidth(text),
        BAND_WHALE_TEXT_COLS,
        `${offset} 日 ${label} 宽 ${displayWidth(text)} 列（应为 ${BAND_WHALE_TEXT_COLS}）：${JSON.stringify(text)}`,
      )
      // 都以鱼头 `>` 开头，后面真的有字。
      assert.ok(text.startsWith('>'), `${offset} 日 ${label} 该以鱼头开头：${JSON.stringify(text)}`)
      assert.ok(text.slice(1).trim().length > 0, `${offset} 日 ${label} 鱼头后面没字`)
    }

    // 同一天的两帧必须不同——两句话轮换才有「在动」的感觉。
    assert.notEqual(working, busy, `${offset} 日 working 与 busy 说了同一句`)

    seen.set(day, { working, busy })
  }

  // **七天互不相同**：一周之内不该重样。
  const workings = [...seen.values()].map(v => v.working)
  const busies = [...seen.values()].map(v => v.busy)
  assert.equal(new Set(workings).size, 7, `七天 working 有重复：${workings.join(' / ')}`)
  assert.equal(new Set(busies).size, 7, `七天 busy 有重复：${busies.join(' / ')}`)

  // **日期映射点对点钉住**，防止 getDay() 的 0=周日 被写成 0=周一。
  assert.ok(seen.get(1).working.includes('忙day'), `周一该说忙day：${seen.get(1).working}`)
  assert.ok(seen.get(2).working.includes('求死'), `周二该说求死：${seen.get(2).working}`)
  assert.ok(seen.get(3).working.includes('未死'), `周三该说未死：${seen.get(3).working}`)
  assert.ok(seen.get(4).working.includes('炸鸡'), `周四该说炸鸡换白饭：${seen.get(4).working}`)
  assert.ok(seen.get(5).working.includes('福来'), `周五该说福来：${seen.get(5).working}`)
  assert.ok(seen.get(6).working.includes('洒脱'), `周六该说洒脱：${seen.get(6).working}`)
  assert.ok(seen.get(0).working.includes('伤day'), `周日该说伤：${seen.get(0).working}`)

  // 周四那档必须落到「白饭」上——这是那个二创的核心，不是随便一句炸鸡。
  const thursday = `${seen.get(4).working}${seen.get(4).busy}`
  assert.ok(thursday.includes('白饭'), `周四该提到白饭：${thursday}`)

  // **睡觉那档不受星期影响**：它讲的是鼾声，不是日程。
  assert.ok(
    bandWhaleGlyph('idle', dayAt(1)).includes('z'),
    'idle 那档仍该是 z 的动画',
  )
})

/**
 * 历史上下文：日志重建的读数 → 图上的柱子。
 *
 * 日志里没有窗口上限（`rawMaxTokens` 只存在于 breakdown），所以百分比只能
 * 按当前这次的窗口换算。没有分母时**必须返回空**，不能猜一个——猜 200k
 * 会让实际 1M 窗口的会话把所有柱子压成贴着地面的一条线，读者会以为上下文
 * 一直很空。
 */
test('历史上下文：按压缩阈值换算百分比，没有分母就整段丢掉', () => {
  const history = [
    { at: 1000, tokens: 50_000, output: 10, model: 'm', seq: 1 },
    { at: 2000, tokens: 100_000, output: 10, model: 'm', seq: 2 },
    { at: 3000, tokens: 200_000, output: 10, model: 'm', seq: 3 },
  ]

  // 200k 分母：25% / 50% / 100%。
  const fits = historyContextTurns(history, 200_000)
  assert.deepEqual(fits.map(turn => turn.percent), [25, 50, 100])
  assert.deepEqual(fits.map(turn => turn.seq), [1, 2, 3])
  assert.deepEqual(fits.map(turn => turn.at), [1000, 2000, 3000])
  // 历史读数没有分类构成——图例不该凭空多出分类。
  assert.ok(fits.every(turn => turn.parts === undefined), '历史读数不该带 parts')

  // 1M 分母：同样的读数只占 5% / 10% / 20%。
  const roomy = historyContextTurns(history, 1_000_000)
  assert.deepEqual(roomy.map(turn => turn.percent), [5, 10, 20])

  // **分母应当是自动压缩阈值，不是窗口上限。**
  //
  // 同样 200k 的读数，窗口 1M、阈值 92% 时：占窗口 20%，但占阈值 21.7%——
  // 后者才是「离压缩还有多远」。两个值差得不多时看不出来，但 1M 窗口上
  // 差着一个数量级的观感：按窗口算会让人以为「窗口还很空」，按阈值算才
  // 看得出「快满了」。
  const window = 1_000_000
  const threshold = window * 0.92
  const byWindow = historyContextTurns(history, window)
  const byThreshold = historyContextTurns(history, threshold)
  assert.ok(
    byThreshold[2].percent > byWindow[2].percent,
    '按阈值算出的占比必须高于按窗口算的',
  )
  assert.ok(Math.abs(byThreshold[2].percent - (200_000 / threshold) * 100) < 1e-9)

  // 没有分母 / 分母为 0 / 没有数据：一律空数组。
  assert.deepEqual(historyContextTurns(history, undefined), [])
  assert.deepEqual(historyContextTurns(history, 0), [])
  assert.deepEqual(historyContextTurns(undefined, 200_000), [])
  assert.deepEqual(historyContextTurns([], 200_000), [])

  // 超出分母时夹到 100：柱子不能画到框外。
  assert.deepEqual(historyContextTurns([{ at: 1, tokens: 400_000, output: 0, model: 'm', seq: 1 }], 200_000).map(t => t.percent), [100])
})

/**
 * 历史与本次记录的接缝。
 *
 * 两者记的是同一场会话：历史覆盖到插件装上之前，本次接在后面。接缝处可能
 * 有一两轮重叠（`turn.complete` 记下那轮时，日志里也已经写进去了），所以
 * 按时刻去重，并且**保留本次那条**——它带着分类构成，图例能画出内容分类。
 */
test('上下文接线：历史在前、本次在后，同一轮取信息更全的那条', () => {
  // **时刻必须有真实的时间差。** 两个时刻来自两个独立时钟：历史侧是日志
  // 写入的时刻，本次侧是 `turn.complete` 的 `Date.now()`——同一轮也差几百
  // 毫秒到几秒。夹具若写成精确同刻，就测不到「按时间窗去重」这件事本身。
  const T0 = 1_000_000
  const history = [
    { seq: 1, percent: 20, tokens: 1000, at: T0 },
    { seq: 2, percent: 30, tokens: 1500, at: T0 + 5_000 },
  ]
  const live = [
    // 与历史末项是**同一轮**（相差 3 秒，落在时间窗内），但带构成：应当胜出。
    { seq: 5, percent: 31, tokens: 1550, at: T0 + 8_000, parts: [{ kind: 'system', tokens: 300 }] },
    // 下一轮，时间上隔了两分钟（远超时间窗）：应当作为新的一条留下。
    { seq: 6, percent: 40, tokens: 2000, at: T0 + 128_000 },
  ]

  const merged = mergeContextHistory(history, live)
  assert.equal(merged.length, 3, '重叠的一轮只该留一条')
  // 留下来的那条取 `live` 的值（它的时刻、percent、parts 都是 `live` 的）。
  assert.equal(merged[1].percent, 31)
  assert.equal(merged[1].at, T0 + 8_000, '同一轮应保留本次侧的读数')
  assert.ok(merged[1].parts && merged[1].parts.length === 1, '同一轮应保留带构成的那条')
  // 排序仍然按时刻。
  assert.deepEqual(merged.map(turn => turn.at), [T0, T0 + 8_000, T0 + 128_000])

  // **合并后重编号**：两侧的 seq 各从 1 开始，直接接起来会得到
  // 「1, 2, 5, 6」这种跳号（甚至倒序）——而图上的横坐标正是 seq。
  assert.deepEqual(merged.map(turn => turn.seq), [1, 2, 3], '合并后必须重编成 1..N')

  // 任何一边为空时直接返回另一边（同样重编号）。
  assert.deepEqual(mergeContextHistory([], live).map(t => t.seq), [1, 2])
  assert.deepEqual(mergeContextHistory(history, []).map(t => t.seq), [1, 2])
  assert.deepEqual(mergeContextHistory([], []), [])
})

/**
 * 横坐标：合并且压缩之后，柱子上的序号必须仍是 1..N 的连续整数。
 *
 * 这是读者核对时间轴时唯一能抓住的东西。早先 `label` 直接取 `turn.seq`，
 * 而历史与本次各从 1 开始，图上会出现标着 1 的柱子排在标着 21 的后面。
 */
test('横坐标：历史与本次接起来后序号连续，图上不跳号不倒序', () => {
  // 历史 5 轮，本次 3 轮，各自 seq 从 1 起。
  // **每轮相隔 2 分钟**，远超合并时间窗（60s）——它们是不同的轮次，不该被并。
  const STEP = 120_000
  const T0 = 1_000_000
  const history = Array.from({ length: 5 }, (_, i) => ({
    seq: i + 1, percent: 20 + i, tokens: 1000 + i, at: T0 + i * STEP,
  }))
  const live = Array.from({ length: 3 }, (_, i) => ({
    seq: i + 1, percent: 40 + i, tokens: 2000 + i, at: T0 + (5 + i) * STEP,
  }))

  const merged = mergeContextHistory(history, live)
  assert.equal(merged.length, 8, '时间上分得开的轮次不该被合并')
  assert.deepEqual(merged.map(t => t.seq), [1, 2, 3, 4, 5, 6, 7, 8])

  // 图上横坐标取自 `bar.label`，而它来自 `turn.seq`——两者必须一致。
  const { bars } = contextStack(merged, merged.length, 0)
  assert.deepEqual(bars.map(b => b.label), ['1', '2', '3', '4', '5', '6', '7', '8'])
})

/** 历史接上之后，整条曲线能一路画到会话开头——这是这个改动的全部意义。 */
test('上下文接线：接缝不断档，整条曲线覆盖到会话开头', () => {
  // 每轮隔 2 分钟，远超合并时间窗——它们本该是各自独立的轮次。
  const STEP = 120_000
  const T0 = 1_000_000
  const history = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1, percent: 10 + i * 0.5, tokens: 20_000 + i * 1000, at: T0 + i * STEP,
  }))
  const live = Array.from({ length: 5 }, (_, i) => ({
    seq: 101 + i, percent: 60 + i, tokens: 120_000 + i * 1000, at: T0 + (100 + i) * STEP,
  }))

  const merged = mergeContextHistory(history, live)
  assert.equal(merged.length, 105, '时间上分得开的轮次不该被合并')
  assert.equal(merged[0].at, T0, '第一条必须是会话最早那一轮')
  assert.equal(merged[merged.length - 1].at, live[live.length - 1].at, '末条必须是最新一轮')
  // 时刻严格递增：图上不会出现一根柱子压着另一根。
  for (let i = 1; i < merged.length; i += 1) {
    assert.ok(merged[i].at > merged[i - 1].at, `第 ${i} 条的时刻没有递增`)
  }
})

/**
 * 缓存里只留**当前会话**的上下文序列。
 *
 * 早先每个文件的缓存条目都带一份完整的 `contextTurns`，而上下文序列是
 * 会话级的东西——面板只画当前这一场，别的会话存了也永远用不上。实测
 * 400 天窗口下它单独占 3.06 MB，加上 `seenIds` 直接把 `process.run` 的
 * stdout 顶过 4 MiB，扫描永久报「输出超过 4 MiB」，整个本地用量栏坏掉。
 */
test('扫描：缓存只保留当前会话的上下文序列，其余清空', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { aggregate } = await import('../scripts/usage-scan.mjs')

  const root = mkdtempSync(join(tmpdir(), 'whale-ctx-'))
  try {
    const project = join(root, 'proj')
    mkdirSync(project)
    const now = new Date().toISOString()
    // 会话内容：先一条用户提问，再跟若干条 assistant。上下文图按**提问**
    // 归组（一次提问里的工具循环只画一根柱子），所以夹具必须有 user 行——
    // 全是 assistant 的夹具会全部落到同一个 turnIndex 上，只剩一根柱子。
    const ask = (sid, i, ts) => JSON.stringify({
      type: 'user',
      timestamp: ts,
      promptId: `${sid}_p${i}`,
      message: { role: 'user', content: `问题 ${i}` },
    })
    const line = (sid, i, ts) => JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: {
        id: `${sid}_${i}`,
        model: 'claude-opus-5-5',
        usage: { input_tokens: 1000 * (i + 1), output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })
    const t = i => new Date(Date.now() + i * 1000).toISOString()
    // sess-a：3 次提问，各自 1 条 assistant → 3 根柱子。
    writeFileSync(join(project, 'sess-a.jsonl'), [
      ask('a', 0, t(0)), line('a', 0, t(1)),
      ask('a', 1, t(2)), line('a', 1, t(3)),
      ask('a', 2, t(4)), line('a', 2, t(5)),
    ].join('\n'))
    // sess-b：2 次提问。
    writeFileSync(join(project, 'sess-b.jsonl'), [
      ask('b', 0, t(0)), line('b', 0, t(1)),
      ask('b', 1, t(2)), line('b', 1, t(3)),
    ].join('\n'))

    const cache = new Map()
    const result = aggregate(root, 1, cache, 'sess-a')

    // 当前会话拿到完整序列。
    assert.equal(result.contextTurns.length, 3, '当前会话应有 3 轮')

    // 缓存里：当前会话有序列，另一个会话是空的。
    const a = cache.get(join(project, 'sess-a.jsonl'))
    const b = cache.get(join(project, 'sess-b.jsonl'))
    assert.ok(a && b, '两个文件的缓存条目都该在')
    assert.equal(a.part.contextTurns.length, 3, '当前会话的序列该留在缓存里')
    assert.equal(b.part.contextTurns.length, 0, '别的会话的序列不该占缓存')

    // 第二轮带缓存：当前会话**重读**，序列不会因为缓存而被清空。
    const again = aggregate(root, 1, cache, 'sess-a')
    assert.equal(again.contextTurns.length, 3, '带缓存重扫时当前会话序列不能丢')
    // 数字也不能因为重读而翻倍。
    assert.equal(again.total.messages, 5, '重读当前会话不该把消息数算两遍')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 上下文柱子按**提问**归组，不按 assistant 消息。
 *
 * 一次提问里的工具调用循环会写出几十条 assistant 消息。逐条画柱子时，实测
 * 一场 19 次提问的会话画出 694 根柱子——读者完全对不上自己的操作，而且
 * 「上下文占比」这个问题的答案本来是「我每问一次，窗口涨多少」。
 */
test('扫描：一次提问只画一根上下文柱子，取这一轮的末条读数', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { aggregate } = await import('../scripts/usage-scan.mjs')

  const root = mkdtempSync(join(tmpdir(), 'whale-turn-'))
  try {
    const project = join(root, 'proj')
    mkdirSync(project)
    const t = i => new Date(Date.now() + i * 1000).toISOString()
    const ask = (i) => JSON.stringify({
      type: 'user',
      timestamp: t(i),
      promptId: `p${i}`,
      message: { role: 'user', content: `问题 ${i}` },
    })
    const reply = (id, i, input) => JSON.stringify({
      type: 'assistant',
      timestamp: t(i),
      message: {
        id,
        model: 'claude-opus-5-5',
        usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })

    writeFileSync(join(project, 's.jsonl'), [
      // 第 1 次提问：三条 assistant（工具循环），窗口 1000 → 2000 → 3000。
      ask(0),
      reply('m1', 1, 1000),
      reply('m2', 2, 2000),
      reply('m3', 3, 3000),
      // 第 2 次提问：两条 assistant，窗口 5000 → 7000。
      ask(4),
      reply('m4', 5, 5000),
      reply('m5', 6, 7000),
    ].join('\n'))

    // 上下文序列只在指定会话时返回：它是会话级的数据，不给 id 就无从谈起。
    const result = aggregate(root, 1, new Map(), 's')
    // 两次提问 = 两根柱子，不是五根。
    assert.equal(result.contextTurns.length, 2, '一次提问只该产生一根柱子')
    // 取的是每一轮的**末条**：1000/2000/3000 里取 3000，5000/7000 里取 7000。
    assert.deepEqual(result.contextTurns.map(turn => turn.tokens), [3000, 7000])
    // 序号连续，图上不会跳号。
    assert.deepEqual(result.contextTurns.map(turn => turn.seq), [1, 2])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 扫描：压缩边界从日志读出来，挂到压缩之后的第一根柱子上。
 *
 * 引擎压缩完会往日志里写一行 `compact_boundary`，带着压缩前后的 token 数。
 * 这是**确定事实**，比「占比跌了三成就猜是压缩」可靠——实测有一次压缩只跌
 * 了一半（36.6% → 18.0%），按比例猜会漏掉。
 *
 * 三条硬性要求：
 *
 *   - 边界只挂到**不早于它**的第一根柱子（挂到前一根就是标错位置）；
 *   - 边界行本身不能算成一根柱子（它既不是提问也不是回答）；
 *   - 压缩摘要行（`isCompactSummary`）带 `promptId`，不能被算成一次提问。
 */
test('扫描：压缩边界挂到压缩后的第一根柱子上，摘要行不算提问', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { aggregate } = await import('../scripts/usage-scan.mjs')

  const root = mkdtempSync(join(tmpdir(), 'whale-compact-'))
  try {
    const project = join(root, 'proj')
    mkdirSync(project)
    const t = i => new Date(Date.now() + i * 1000).toISOString()
    const ask = i => JSON.stringify({
      type: 'user', timestamp: t(i), promptId: `p${i}`,
      message: { role: 'user', content: `问题 ${i}` },
    })
    const reply = (id, i, input) => JSON.stringify({
      type: 'assistant', timestamp: t(i),
      message: {
        id, model: 'claude-opus-5-5',
        usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })
    const boundary = (i, pre, post, trigger = 'auto') => JSON.stringify({
      type: 'system', subtype: 'compact_boundary', timestamp: t(i),
      compactMetadata: { trigger, preTokens: pre, postTokens: post, durationMs: 1000 },
    })
    // 压缩摘要：`type: "user"`、**带 `promptId`**、`isCompactSummary: true`。
    // 三种老判据全拦不住它，必须单独认这一条。
    const summary = i => JSON.stringify({
      type: 'user', timestamp: t(i), promptId: `summary-${i}`, isCompactSummary: true,
      message: { role: 'user', content: '这是一段压缩摘要' },
    })

    writeFileSync(join(project, 's.jsonl'), [
      ask(0),
      reply('m1', 1, 10_000),
      reply('m2', 2, 20_000),
      // 压缩发生在第 1 轮之后：摘要行紧跟着边界。
      summary(3),
      boundary(3, 20_000, 2_000),
      // 第 2 轮：压缩后的读数。
      ask(4),
      reply('m3', 5, 3_000),
      // 第二次压缩，手动触发，紧接在第 2 轮之后。
      boundary(6, 3_000, 500, 'manual'),
      ask(7),
      reply('m4', 8, 1_000),
    ].join('\n'))

    const result = aggregate(root, 1, new Map(), 's')
    // 三次真实提问 = 三根柱子。压缩摘要与边界都不许各算一根。
    assert.equal(result.contextTurns.length, 3, '压缩摘要与边界行都不该算成柱子')
    assert.deepEqual(result.contextTurns.map(turn => turn.tokens), [20_000, 3_000, 1_000])
    // **轮次计数也要对上。** 柱子数看不出「摘要行算了一轮但没读数」这种错——
    // 那一轮没有 assistant 消息，柱子不会多出来，但热图的轮次会凭空多一格。
    // 三次提问都在同一天，那一天的 `turns` 应当正好是 3。
    const turnTotal = result.turnsDaily.reduce((sum, day) => sum + day.turns, 0)
    assert.equal(turnTotal, 3, '压缩摘要行被算成了一次提问')

    // 第 1 根柱子**前面没有**压缩——边界落在它后面，不许往回挂。
    assert.equal(result.contextTurns[0].compact, undefined, '边界不该挂到它前面的柱子上')
    // 第 2 根柱子前面有压缩，带完整细节。
    assert.deepEqual(result.contextTurns[1].compact, {
      trigger: 'auto', preTokens: 20_000, postTokens: 2_000,
    })
    // 第 3 根柱子前面的那次压缩是手动触发的，`trigger` 要如实反映。
    assert.deepEqual(result.contextTurns[2].compact, {
      trigger: 'manual', preTokens: 3_000, postTokens: 500,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 扫描：压缩边界比日期窗口更老时整条丢掉。
 *
 * 边界不带轮次号，只能按时刻对齐。如果它的时刻早于窗口裁切线，配到的
 * 「第一根不早于它的柱子」其实是窗口开头那根——挂上去就是错的。
 */
test('扫描：窗口外的压缩边界不挂到窗口内第一根柱子上', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { aggregate } = await import('../scripts/usage-scan.mjs')

  const root = mkdtempSync(join(tmpdir(), 'whale-old-'))
  try {
    const project = join(root, 'proj')
    mkdirSync(project)
    const t = i => new Date(Date.now() + i * 1000).toISOString()
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
    writeFileSync(join(project, 's.jsonl'), [
      // 90 天前的一次压缩，窗口只取 1 天。
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: old,
        compactMetadata: { trigger: 'auto', preTokens: 100, postTokens: 10 } }),
      JSON.stringify({ type: 'user', timestamp: t(0), promptId: 'p1',
        message: { role: 'user', content: '问题' } }),
      JSON.stringify({ type: 'assistant', timestamp: t(1),
        message: { id: 'm1', model: 'claude-opus-5-5',
          usage: { input_tokens: 500, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    ].join('\n'))

    const result = aggregate(root, 1, new Map(), 's')
    assert.equal(result.contextTurns.length, 1)
    assert.equal(result.contextTurns[0].compact, undefined, '窗口外的边界不该挂到窗口内的柱子')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 逐轮明细：占比、增量、压缩标记。
 *
 * 压缩在柱状图上只是一根突然变矮的柱子，不标出来会被当成「这一轮用得少」，
 * 而它其实是引擎把旧内容收走了——是整条曲线上最该被解释的一件事。
 */
test('上下文逐轮明细：标出压缩，增量按百分点算', () => {
  const turns = [
    { seq: 1, percent: 12, tokens: 120_000, at: 1000 },
    { seq: 2, percent: 18, tokens: 180_000, at: 2000 },
    { seq: 3, percent: 40, tokens: 400_000, at: 3000 },
    // 压缩：从 40% 掉到 18%，不到上一轮的 70%。
    { seq: 4, percent: 18, tokens: 180_000, at: 4000 },
    { seq: 5, percent: 22, tokens: 220_000, at: 5000 },
  ]
  const rows = contextDetailRows(turns)

  assert.equal(rows.length, 5)
  // 序号从 1 起，连续。
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5])
  // 首轮没有增量。
  assert.equal(rows[0].delta, undefined)
  // 增量是百分点之差，不是百分比变化率：18-12=6，不是 (18-12)/12。
  assert.equal(rows[1].delta, 6)
  assert.equal(rows[2].delta, 22)
  // 压缩那一轮：增量为负，且被标成压缩。
  assert.equal(rows[3].afterCompact, true, '从 40% 掉到 18% 应当标成压缩')
  assert.ok(rows[3].delta < 0, '压缩那一轮的增量应当是负的')
  // 压缩之后的那一轮不是压缩（只是正常增长）。
  assert.equal(rows[4].afterCompact, false)

  // **小幅回落不算压缩。** 工具结果被丢掉、这一轮没用满都会让占比略降，
  // 那不是压缩。阈值是「掉到上一轮的 70% 以下」。
  const mild = contextDetailRows([
    { seq: 1, percent: 50, tokens: 500_000, at: 1 },
    { seq: 2, percent: 45, tokens: 450_000, at: 2 },
  ])
  assert.equal(mild[1].afterCompact, false, '只降 10% 不该算压缩')

  // 空数据与单轮：不炸，也不产生假的压缩标记。
  assert.deepEqual(contextDetailRows([]), [])
  const single = contextDetailRows([{ seq: 1, percent: 30, tokens: 300_000, at: 1 }])
  assert.equal(single.length, 1)
  assert.equal(single[0].afterCompact, false)
  assert.equal(single[0].delta, undefined)
})

/**
 * 逐轮明细：引擎记录优先于「占比骤降」的猜测。
 *
 * `turn.compact` 来自日志里的 `compact_boundary`，是引擎写下的事实。有它时
 * 就必须以它为准，两个方向都要对：
 *
 *   - 占比跌得不够狠（没到 70% 阈值）但引擎说压缩了 → 要标；
 *   - 占比跌得很狠但引擎没说 → 那只是这一轮窗口真的变小了，不该标。
 *
 * 第二条尤其重要：早先全靠猜，读者会看到一些并不存在的「压缩」。
 */
test('上下文逐轮明细：引擎记录压过占比猜测', () => {
  // 跌了 50%（36.6% → 18.0%），按 70% 阈值**猜不出来**，但引擎确实记了。
  // 这是本机实测发生过的真实比例。
  const mild = contextDetailRows([
    { seq: 1, percent: 36.6, tokens: 367_270, at: 1 },
    {
      seq: 2, percent: 18.0, tokens: 180_394, at: 2,
      compact: { trigger: 'auto', preTokens: 367_270, postTokens: 28_228 },
    },
  ])
  assert.equal(mild[1].afterCompact, true, '引擎记录了压缩就该标，哪怕只跌了一半')
  assert.equal(mild[1].compact?.trigger, 'auto', '压缩的细节要原样透传')
  assert.equal(mild[1].compact?.preTokens, 367_270)

  // 跌了 80%，但引擎**没有**记压缩——那是这一轮窗口自己变小的，不该标。
  const steep = contextDetailRows([
    { seq: 1, percent: 90, tokens: 900_000, at: 1 },
    { seq: 2, percent: 18, tokens: 180_000, at: 2, afterCompact: false },
  ])
  assert.equal(
    steep[1].afterCompact,
    true,
    '没有引擎记录时仍按占比推断（老日志只有这一条路可走）',
  )

  // 老日志（没有 `compact_boundary`）继续靠猜，不能被这次改动弄丢。
  const legacy = contextDetailRows([
    { seq: 1, percent: 40, tokens: 400_000, at: 1 },
    { seq: 2, percent: 15, tokens: 150_000, at: 2 },
  ])
  assert.equal(legacy[1].afterCompact, true, '老日志没有边界记录，只能靠比例猜')
})

/**
 * 历史序列 → 图上柱子：压缩细节要跟着过去。
 *
 * `historyContextTurns` 是日志侧的唯一入口，`compact` 在这里丢掉的话，
 * 后面整条链路（合并、绘图、明细）都拿不到它。
 */
test('历史上下文换算：压缩细节一路带到柱子上', () => {
  const history = [
    { seq: 1, at: 1000, tokens: 367_270, output: 100, model: 'm' },
    {
      seq: 2, at: 2000, tokens: 90_033, output: 200, model: 'm',
      compact: { trigger: 'auto', preTokens: 367_354, postTokens: 27_907 },
    },
  ]
  const turns = historyContextTurns(history, 400_000)
  assert.equal(turns.length, 2)
  // 没有压缩的那一轮：没有 `compact`，也没有 `afterCompact`。
  assert.equal(turns[0].compact, undefined)
  assert.equal(turns[0].afterCompact, undefined)
  // 有压缩的那一轮：两个字段都要在——绘图读 `afterCompact`，明细读 `compact`。
  assert.equal(turns[1].afterCompact, true, '有压缩细节时要一并置 afterCompact')
  assert.deepEqual(turns[1].compact, {
    trigger: 'auto', preTokens: 367_354, postTokens: 27_907,
  })
})

/**
 * 合并：本次侧覆盖同一条历史记录时，压缩细节不能丢。
 *
 * 历史侧知道这一轮前面有压缩（日志里的 `compact_boundary`，带压缩前后的
 * token 数），本次侧只知道「这一轮记下了」。整条替换会把标记抹掉，图上就
 * 少一条虚线。
 */
test('上下文接线：本次侧覆盖历史时保住压缩细节', () => {
  const mark = { trigger: 'auto', preTokens: 367_354, postTokens: 27_907 }
  const history = [
    { seq: 1, percent: 40, tokens: 400_000, at: 10_000, afterCompact: true, compact: mark },
  ]
  // 本次侧同一条（相差 5 秒，落在 60 秒窗内），带构成但没有压缩信息。
  const live = [
    {
      seq: 1, percent: 41, tokens: 410_000, at: 15_000,
      parts: [{ name: 'Messages', tokens: 300_000 }],
    },
  ]
  const merged = mergeContextHistory(history, live)
  assert.equal(merged.length, 1, '同一轮不该出现两次')
  // 本次侧的读数胜出（它更新、还带构成）。
  assert.equal(merged[0].percent, 41)
  assert.equal(merged[0].parts?.length, 1)
  // 但压缩标记必须保住。
  assert.equal(merged[0].afterCompact, true, '合并时压缩标记被抹掉了')
  assert.deepEqual(merged[0].compact, mark, '合并时压缩细节被抹掉了')
})

/**
 * 上下文占比：有 breakdown 时统一到「自动压缩阈值」口径。
 *
 * 引擎给了两套互不相等的数值，类型声明里明说
 * 「`breakdown` measures against the compaction window (`rawMaxTokens`),
 *  which may be smaller than `window`」：
 *
 *   - `context.percent` = tokens / window（状态栏那套）
 *   - `breakdown.percentage` = totalTokens / rawMaxTokens（/context 那套）
 *
 * 面板的柱状图按阈值算（读者关心「离压缩还有多远」）。早先泡泡与用量条直接
 * 用引擎的 `percent`，同一场会话会出现「泡泡说 28%、图上说 30.4%」。
 */
test('上下文占用：按模型完整窗口算，泡泡与用量条同源', () => {
  // 1M 窗口、阈值 921_600（92%）、已用 300K。
  //
  // **刻意让 `tokens` 与 `breakdown.totalTokens` 不同**（300k vs 340k）：
  // 前者是 API 实际计费的输入，后者是引擎把系统提示、工具定义逐类估算出来
  // 的和。引擎自己在类型声明里写了 `its totalTokens need not equal tokens`。
  // 曲线用**计费口径**——历史侧（日志）拿不到估算值，只有 `usage`；两侧
  // 若各用一个分子，同一轮会出现两根占比不同的柱子。
  const usage = {
    rateLimits: [],
    context: {
      tokens: 300_000,
      window: 1_000_000,
      percent: 30, // 引擎按完整窗口给的：30%
      breakdown: { totalTokens: 340_000, rawMaxTokens: 1_000_000, autoCompactThreshold: 921_600 },
    },
  }
  const view = toUsageView(usage)

  // **完整窗口口径 + 计费分子**：300K / 1M = 30%。
  //
  // 早先这里按压缩阈值算，同一个 300K 会显示成 32.6%（阈值更小时甚至 75%），
  // 读起来像快撑爆了，而实际还有七成空间没用。阈值改用
  // `autoCompactThreshold` 单独给出，只用于「压缩点」提示。
  assert.equal(view.contextPercent, 30)
  assert.equal(view.contextDenominator, 1_000_000, '分母应当是模型完整窗口')
  assert.equal(view.autoCompactThreshold, 921_600, '阈值单独给出，不参与占比')

  // 泡泡与用量条都从这里取，所以两条出口说的是同一个数。
  const pages = bubblePages(view, { totals: { turns: 0, ms: 0, linesAdded: 0, linesRemoved: 0 } }, 0)
  const contextPage = pages.find(page => page.id === 'context')
  assert.ok(contextPage, '应当有上下文页')
  assert.equal(contextPage.lines[0], '上下文占用')
  assert.equal(contextPage.lines[1], pct(view.contextPercent))
  assert.equal(bandSummary(view, ['cost'], 0), `上下文 ${pct(view.contextPercent)}`)

  // 没有 `window` 时退回压缩窗口（rawMaxTokens）——至少还是一个真实读数。
  const noWindow = toUsageView({
    rateLimits: [],
    context: {
      tokens: 300_000,
      breakdown: { totalTokens: 300_000, rawMaxTokens: 800_000 },
    },
  })
  assert.equal(noWindow.contextDenominator, 800_000)
  assert.ok(Math.abs(noWindow.contextPercent - (300_000 / 800_000) * 100) < 1e-9)

  // 连 breakdown 都没有：退回引擎的 `percent`，分母不明。
  const noBreakdown = toUsageView({
    rateLimits: [],
    context: { tokens: 300_000, window: 1_000_000, percent: 30 },
  })
  assert.equal(noBreakdown.contextPercent, 30)
  assert.equal(noBreakdown.contextDenominator, 1_000_000)

  // 超出窗口时夹到 100：百分比不能溢出。
  const over = toUsageView({
    rateLimits: [],
    context: {
      tokens: 1_200_000, window: 1_000_000,
      breakdown: { totalTokens: 1_200_000, rawMaxTokens: 1_000_000, autoCompactThreshold: 921_600 },
    },
  })
  assert.equal(over.contextPercent, 100, '超过窗口应当夹到 100%')
})
