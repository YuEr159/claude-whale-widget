/**
 * 单元与渲染测试：`claude plugin test .` 会用引擎自己的宿主跑这些用例。
 *
 * 只测纯函数与「画出来的树」，不测任何 surface 的像素绘制。
 */
import { test, expect } from 'claude-code/testing'

import { costOf, priceOf } from '../hooks/pricing'
import { clip, countdown, displayWidth, padCell, pct, tokens, usd } from '../hooks/format'
import { BAND_METRIC_OPTIONS, bandDiffText, bandSummary, freshnessOf, toUsageView } from '../hooks/usage-view'
import {
  addModelSpend,
  countPatchLines,
  duration,
  limitRows,
  meterText,
  toContextDetail,
  windowSourceText,
} from '../hooks/usage-detail'
import { WHALE_MAX_WIDTH, WHALE_MIN_HEIGHT, moodOf, whaleSizeFor, whaleSvg } from '../hooks/whale-art'
import {
  barText,
  calendarHeat,
  canonicalModelName,
  hourLabel,
  maskModel,
  modelDetailRows,
  detailTableLayout,
  modelRows,
  overviewCards,
  heatLevel,
  isPlaceholderModel,
  contextPartKind,
  contextParts,
  contextStack,
  stackLegendOf,
  rasterizeStacks,
  rasterizeTurnBars,
  turnBars,
  turnBarsCaption,
} from '../hooks/usage-overview'
import { contextChartSvg, turnHeatSvg } from '../hooks/chart-art'
import { UNPRICED, usdEstimate } from '../hooks/provenance'
import { FILLS, isLightTheme, panelFillFor } from '../hooks/panel-fill'

test('价格表只认官方模型，且缓存按 1.25x / 0.1x 计', () => {
  const opus = priceOf('claude-opus-5-5')
  expect(opus).toBeDefined()
  expect(opus?.input).toBe(4)
  expect(Math.abs((opus?.cacheWrite ?? 0) - 5)).toBeLessThan(1e-9)
  expect(Math.abs((opus?.cacheRead ?? 0) - 0.4)).toBeLessThan(1e-9)

  // 完全没有接触过的模型、合成消息、通配都不该套用任何价格
  expect(priceOf('some-gateway-model')).toBeUndefined()
  expect(priceOf('<synthetic>')).toBeUndefined()
  expect(priceOf('auto')).toBeUndefined()
})

test('DeepSeek Flash 单独一套价格，且型号写法大小写模糊识别', () => {
  // 官方非高峰价：输入 $0.15 / 输出 $0.60；缓存命中 $0.003，不收缓存写入费。
  const flash = priceOf('deepseek-flash')
  expect(flash).toBeDefined()
  expect(flash?.input).toBe(0.15)
  expect(flash?.output).toBe(0.6)
  expect(flash?.cacheRead).toBe(0.003)
  expect(flash?.cacheWrite).toBe(0)

  for (const id of [
    'DeepSeek-Flash',
    'DEEPSEEK-FLASH',
    'deepseek-v4-flash',
    'DeepSeek-V4.1-Flash-1017',
    'deepseek-ai/DeepSeek-Flash',
  ]) {
    expect(priceOf(id)?.input).toBe(0.15)
  }
  // 不是 Flash 的 DeepSeek 型号仍按未收录处理。
  expect(priceOf('deepseek-v4-pro')).toBeUndefined()
})

test('Qwen 3.8 27B 与 Kimi K3 按 OpenRouter 基础价收录', () => {
  const qwen = priceOf('qwen3.8-27b')
  expect(qwen?.input).toBe(0.04)
  expect(qwen?.output).toBe(1.35)
  // 缓存读是输入价的 45%，不是 Anthropic 的 10%。
  expect(qwen?.cacheRead).toBe(0.018)
  expect(qwen?.cacheWrite).toBe(0)
  expect(priceOf('qwen/qwen3.8-27b')?.input).toBe(0.04)

  const kimi = priceOf('kimi-k3')
  expect(kimi?.input).toBe(0.239)
  expect(kimi?.output).toBe(11.936)
  expect(kimi?.cacheRead).toBe(0.21)
  expect(priceOf('moonshotai/kimi-k3')?.output).toBe(11.936)
  expect(priceOf('Kimi-K3')?.input).toBe(0.239)

  const cost = costOf('qwen3.8-27b', {
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite: 0,
    cacheRead: 1_000_000,
  })
  expect(Math.abs((cost ?? 0) - (0.04 + 1.35 + 0.018))).toBeLessThan(1e-9)
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
  // 10¹² 这一档写「万亿」，不写「兆」——后者在汉语里已是 10⁶ 的词头。
  expect(tokens(1.2e12)).toBe('1.20万亿')
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

test('泡泡收起时不画气泡，但鲸鱼的位置不变', () => {
  const open = whaleSvg('idle', ['5 小时窗口 23%', '≈$2.50', '2h13m 后重置'], { isBubbleOpen: true })
  const closed = whaleSvg('idle', ['5 小时窗口 23%', '≈$2.50', '2h13m 后重置'], { isBubbleOpen: false })

  // 气泡由椭圆与文字组成，收起时全部消失。
  expect(open).toContain('<ellipse')
  expect(open).toContain('5 小时窗口 23%')
  expect(closed).not.toContain('<ellipse')
  expect(closed).not.toContain('5 小时窗口 23%')

  // 鲸鱼本身与它的定位都必须原样保留：收起泡泡不该让鲸鱼挪位。
  expect(closed).toContain('<image')
  expect(closed).toContain('translate(318 16)')
  expect(open).toContain('translate(318 16)')

  // 省略 options 时按「展开」处理，保持对旧调用方的向后兼容。
  expect(whaleSvg('idle', ['a'])).toContain('<ellipse')
})

test('数据新鲜度：刚更新、分钟、小时、过期判定', () => {
  const now = 1_000_000
  // 从没扫过：不算过期，只是没数据
  const never = freshnessOf(null, now, 300_000)
  expect(never.text).toBe('尚未统计')
  expect(never.isStale).toBe(false)

  // 半分钟前：刚刚
  expect(freshnessOf(now - 30_000, now, 300_000).text).toBe('刚刚更新')

  // 5 分钟前
  const five = freshnessOf(now - 5 * 60_000, now, 300_000)
  expect(five.text).toBe('5 分钟前')
  expect(five.isStale).toBe(false)

  // 超过两个扫描周期才算过期
  expect(freshnessOf(now - 11 * 60_000, now, 300_000).isStale).toBe(true)

  // 小时级
  expect(freshnessOf(now - 90 * 60_000, now, 300_000).text).toBe('1 小时前')

  // 间隔为 0（只在手动刷新时扫）永远不判过期
  expect(freshnessOf(now - 99 * 60_000, now, 0).isStale).toBe(false)
})

test('额度窗口按原生 /usage 的标题与顺序排列', () => {
  const rows = limitRows([
    { kind: 'seven_day', percentUsed: 70, resetsAt: '2026-10-27T00:00:00Z' },
    { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-20T15:00:00Z' },
    { kind: 'seven_day_sonnet', percentUsed: 22 },
    { kind: 'spend_limit', percentUsed: 88 },
  ])
  expect(rows.map(r => r.title)).toEqual([
    'Current session',
    'Current week (all models)',
    'Current week (Sonnet only)',
    'spend_limit',
  ])
  expect(rows[0]?.percentUsed).toBe(40)
})

test('额度条按比例填充，越界夹到两端', () => {
  expect(meterText(0)).toBe('░░░░░░░░░░')
  expect(meterText(50)).toBe('█████░░░░░')
  expect(meterText(100)).toBe('██████████')
  expect(meterText(140)).toBe('██████████')
  expect(meterText(-5)).toBe('░░░░░░░░░░')
})

test('时长格式与原生面板一致', () => {
  expect(duration(0)).toBe('0s')
  expect(duration(45_000)).toBe('45s')
  expect(duration(125_000)).toBe('2m 5s')
  expect(duration(3_725_000)).toBe('1h 2m 5s')
})

test('diff 只数增删行，不数文件头', () => {
  const counted = countPatchLines([
    { lines: ['@@ -1,3 +1,4 @@', '--- a/x.ts', '+++ b/x.ts', ' keep', '-gone', '+new', '+more'] },
  ])
  expect(counted.added).toBe(2)
  expect(counted.removed).toBe(1)
  expect(countPatchLines([])).toEqual({ added: 0, removed: 0 })
})

test('按模型累加：同模型相加，未收录价格保持 null', () => {
  const first = addModelSpend([], {
    model: 'claude-opus-5-5', input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.5, turns: 1,
  })
  const second = addModelSpend(first, {
    model: 'claude-opus-5-5', input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0.25, turns: 1,
  })
  expect(second).toHaveLength(1)
  expect(second[0]?.input).toBe(300)
  expect(Math.abs((second[0]?.cost ?? 0) - 0.75) < 1e-9).toBe(true)
  expect(second[0]?.turns).toBe(2)

  const mixed = addModelSpend(second, {
    model: 'deepseek-v4', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: null, turns: 1,
  })
  const nulled = addModelSpend(mixed, {
    model: 'deepseek-v4', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: null, turns: 1,
  })
  const unpriced = nulled.find(item => item.model === 'deepseek-v4')
  expect(unpriced?.cost).toBe(null)
  expect(unpriced?.turns).toBe(2)
})

test('上下文 breakdown 整形：分项与加载项计数', () => {
  const detail = toContextDetail({
    categories: [
      { name: 'Messages', tokens: 40_000, kind: 'used', color: 'promptBorder' },
      { name: 'Free space', tokens: 50_000, kind: 'free', color: 'inactive' },
      { name: 'Autocompact buffer', tokens: 10_000, kind: 'buffer', color: 'subtle' },
    ],
    totalTokens: 50_000,
    rawMaxTokens: 100_000,
    percentage: 50,
    autocompactSource: 'auto',
    isAutoCompactEnabled: true,
    autoCompactThreshold: 90_000,
    model: 'Opus 5.5',
    gridRows: [[
      { categoryName: 'Messages', color: 'promptBorder', isFilled: true, tokens: 40_000, percentage: 40, squareFullness: 1 },
      { categoryName: 'Free space', color: 'inactive', isFilled: false, tokens: 50_000, percentage: 50, squareFullness: 0 },
    ]],
    memoryFiles: [{ path: '/x/CLAUDE.md', type: 'Project', tokens: 1200 }],
    mcpTools: [{ name: 'mcp__linear__issue', serverName: 'linear', tokens: 800 }],
    agents: [{ agentType: 'Explore', source: 'builtin', tokens: 300 }],
    skills: { totalSkills: 10, includedSkills: 4, tokens: 900, skillFrontmatter: [] },
    slashCommands: { totalCommands: 6, includedCommands: 6, tokens: 400 },
  })

  expect(detail).toBeDefined()
  if (!detail) return
  expect(detail.rows).toHaveLength(3)
  // 逐行清单不再上屏，但 rows 仍是柱内分类与压缩阈值的来源。
  expect(detail.rows[0]).toEqual({ name: 'Messages', tokens: 40_000, kind: 'used' })
  expect(detail.memoryFiles[0]?.tokens).toBe(1200)
  expect(detail.mcpTools[0]?.server).toBe('linear')
  expect(detail.agents[0]?.type).toBe('Explore')
  expect(detail.skills?.included).toBe(4)
  expect(detail.slashCommands?.total).toBe(6)
  expect(windowSourceText(detail)).toContain('模型自身上限')
})

test('形状不对的 breakdown 返回 undefined', () => {
  expect(toContextDetail(undefined)).toBeUndefined()
  expect(toContextDetail({})).toBeUndefined()
  expect(toContextDetail({ categories: [] })).toBeUndefined()
  expect(toContextDetail({ categories: [], rawMaxTokens: 100 })).toBeDefined()
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
  expect(bandSummary(view, ['window'], now)).toContain('5h 40%')
  expect(bandSummary(view, ['session'], now)).toBe('本会话 ≈$2.00')
  expect(bandSummary(view, ['cost'], now)).toBe('上下文 12%')
  expect(bandSummary(view, ['context'], now)).toBe('5h 40% · 7d 70%')
  // 多选：按 `BAND_METRIC_OPTIONS` 的固定次序拼接，与勾选先后无关。
  // window 已经写了 5h，context 只补 7d——同一条数字不印两遍。
  expect(bandSummary(view, ['context', 'window'], now)).toBe(
    '5h 40% · 2h00m 后重置 · 7d 70%',
  )
  expect(bandSummary(view, ['window', 'context', 'window'], now)).toBe(
    '5h 40% · 2h00m 后重置 · 7d 70%',
  )
})

test('代码改动的文字带增删号；摘要里不拼它，由渲染层分色追加', () => {
  const view = toUsageView({
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
    cost: { usd: 2 },
    context: { window: 1_000_000, percent: 12 },
  })
  const now = Date.parse('2026-10-20T12:00:00Z')
  const diff = { added: 128, removed: 34 }

  // 摘要本身不拼改动——增删要分两种颜色，拼进字符串就没法上色了。
  // 选中「代码改动」时它由渲染层用两个带色的 Text 追加（见 render 测试）。
  expect(bandSummary(view, ['diff'], now)).toBe('')
  expect(bandSummary(view, ['window'], now)).not.toContain('+128')
  // 改动本身的文字：两个方向、零值省略。
  expect(bandDiffText(diff)).toBe('+128 -34')
  expect(bandDiffText({ added: 0, removed: 0 })).toBe('')
})

test('只在一边有改动时省略零的那一边', () => {
  expect(bandDiffText({ added: 5, removed: 0 })).toBe('+5')
  expect(bandDiffText({ added: 0, removed: 3 })).toBe('-3')
})

test('没有额度窗口时用量条退回上下文 + 会话花费', () => {
  const view = toUsageView({
    rateLimits: [],
    cost: { usd: 0.5 },
    context: { window: 200_000, percent: 33 },
  })
  expect(bandSummary(view, ['window'], 0)).toBe('上下文 33% · 本会话 ≈$0.50')
})

test('用量条口径选项覆盖全部取值', () => {
  expect(BAND_METRIC_OPTIONS.map(o => o.value).sort()).toEqual(
    ['context', 'cost', 'diff', 'session', 'window'].sort(),
  )
})

/**
 * 每个标签必须和它实际画出来的内容对上。
 *
 * 回归：曾经把 `cost` 与 `context` 两个标签对调，结果勾「上下文占用」看到
 * 的是额度百分比、关掉它条子毫无变化——画面上完全像「这个开关坏了」。
 * 这条用例按**标签文字**去选口径，再断言画出来的东西，所以任何一次对调
 * 都会立刻失败，而不是靠人肉读代码发现。
 */
test('口径的标签与它画出来的内容一一对应', () => {
  const view = toUsageView({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-20T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 70 },
    ],
    cost: { usd: 2 },
    context: { window: 1_000_000, percent: 12 },
  })
  const now = Date.parse('2026-10-20T12:00:00Z')
  const valueOfLabel = (label: string) => {
    const option = BAND_METRIC_OPTIONS.find(o => o.label === label)
    expect(option).toBeDefined()
    return bandSummary(view, [option!.value], now)
  }

  // 「上下文占用」画的是上下文百分比。
  expect(valueOfLabel('上下文占用')).toBe('上下文 12%')
  // 「5h + 7d」画的是两个额度窗口的百分比。
  expect(valueOfLabel('5h + 7d')).toBe('5h 40% · 7d 70%')
  // 「本会话花费」画金额，「额度窗口」画 5h 与重置时间。
  expect(valueOfLabel('本会话花费')).toBe('本会话 ≈$2.00')
  expect(valueOfLabel('额度窗口')).toContain('5h 40%')
})

test('口径全选时同一条数字不印两遍：window 已写 5h，context 只补 7d', () => {
  const view = {
    fiveHour: { percentUsed: 24 },
    sevenDay: { percentUsed: 41 },
    limits: [],
    costUsd: 1.23,
    contextPercent: 62,
  }
  const all = BAND_METRIC_OPTIONS.map(o => o.value)
  const text = bandSummary(view as never, all, Date.now())
  // `5h 24%` 只该出现一次——之前 window 与 context 各写一遍。
  expect(text.match(/5h 24%/g)?.length).toBe(1)
  expect(text).toContain('7d 41%')
  expect(text).toContain('上下文 62%')
  // 只选 context 时两个都写。
  expect(bandSummary(view as never, ['context'], Date.now())).toBe('5h 24% · 7d 41%')
})

test('鲸鱼尺寸：连续公式，没有阈值跳变', () => {
  // 关键回归：旧公式在 59→60 列处会一次缩 84px
  let maxJump = 0
  for (let columns = 16; columns <= 140; columns += 1) {
    const jump = Math.abs(whaleSizeFor(columns + 1).width - whaleSizeFor(columns).width)
    if (jump > maxJump) maxJump = jump
  }
  expect(maxJump).toBeLessThanOrEqual(5)
  // 两端夹住，中间线性。上限跟常量走，不在测试里另写一个数。
  expect(whaleSizeFor(200).width).toBe(WHALE_MAX_WIDTH)
  expect(whaleSizeFor(60).width).toBeGreaterThan(200)
})

test('鲸鱼高度严格等于画布比例，且不低于最小高度', () => {
  for (const columns of [1, 10, 20, 40, 60, 80, 100, 200]) {
    const { width, height } = whaleSizeFor(columns)
    // 比例严格保持：引擎的 preserveAspectRatio 不会留白抖动
    expect(Math.abs(height / width - 320 / 620) < 1e-12).toBe(true)
    // 最小高度是真正的下界：面板再窄也不会缩到看不清
    expect(height).toBeGreaterThanOrEqual(WHALE_MIN_HEIGHT - 1e-9)
  }
})

test('小时标签与原生用量页一致', () => {
  expect(hourLabel(0)).toBe('12 AM')
  expect(hourLabel(9)).toBe('9 AM')
  expect(hourLabel(12)).toBe('12 PM')
  expect(hourLabel(17)).toBe('5 PM')
  expect(hourLabel(23)).toBe('11 PM')
  expect(hourLabel(null)).toBe('—')
})

test('模型名显示全名，只有过长才截断——不打码', () => {
  expect(maskModel(null)).toBe('—')
  // 本地数据没有要藏的东西：原名照出，读者要能一眼认出是哪个模型。
  expect(maskModel('claude-opus-5-5')).toBe('opus-5-5')
  expect(maskModel('deepseek-v4-flash')).toBe('deepseek-v4-flash')
  // 截断用省略号而不是星号：读者至少知道它被截了，不会以为是匿名数据。
  const long = maskModel('some-very-long-gateway-model-name')
  expect(long.endsWith('…')).toBe(true)
  expect(long).not.toContain('*')
})

test('热力图分档按最大值比例，不是绝对阈值', () => {
  expect(heatLevel(0, 100)).toBe(0)
  expect(heatLevel(10, 100)).toBe(1)
  expect(heatLevel(40, 100)).toBe(2)
  expect(heatLevel(60, 100)).toBe(3)
  expect(heatLevel(90, 100)).toBe(4)
  // 同样的比例，换一个量级结果不变
  expect(heatLevel(9_000_000, 10_000_000)).toBe(4)
})

test('日历热力图按周分列，每列 7 行', () => {
  const days = [
    { day: '2026-10-05', input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 1 },
    { day: '2026-10-06', input: 20, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 1 },
    { day: '2026-10-07', input: 30, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 1 },
  ]
  const calendar = calendarHeat(days as never)
  expect(calendar.columns.length).toBeGreaterThan(0)
  for (const column of calendar.columns) expect(column.length).toBe(7)
  expect(calendar.max).toBe(30)
})

test('模型排行按 token 排，不看金额', () => {
  const rows = modelRows([
    { model: 'third-party', isPriced: false, input: 1000, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 5 },
    { model: 'claude-opus', isPriced: true, input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 5, messages: 1 },
  ] as never)
  // 第三方模型没有价格，但 token 多，应排在前面
  expect(rows[0]?.model).toBe('third-party')
  expect(rows[0]?.cost).toBe(null)
  expect(rows[0]?.share).toBe(1)
})

test('概览卡片六张，缺数据时全为占位', () => {
  const cards = overviewCards(undefined, [], 30, 0)
  expect(cards.map(c => c.label)).toEqual(['会话', '消息', '总 token', '活跃天数', '峰值时段', '常用模型'])
  expect(cards.every(c => c.value === '—')).toBe(true)
})

test('模型页过滤引擎内部标识', () => {
  expect(isPlaceholderModel('auto')).toBe(true)
  expect(isPlaceholderModel('<synthetic>')).toBe(true)
  expect(isPlaceholderModel('imported-from-dsh')).toBe(true)
  expect(isPlaceholderModel('deepseek-v4-flash')).toBe(false)
  expect(isPlaceholderModel('claude-opus-5-5')).toBe(false)

  const rows = modelRows([
    { model: 'auto', isPriced: false, input: 900, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 90 },
    { model: 'deepseek-v4-flash', isPriced: false, input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 10 },
  ] as never)
  expect(rows.map(r => r.model)).toEqual(['deepseek-v4-flash'])
})

test('上下文堆叠柱：每轮一根，段内比例受夹取', () => {
  const turns = [
    { seq: 1, percent: 20, tokens: 1000, at: 0 },
    { seq: 2, percent: 55, tokens: 2000, at: 1 },
    { seq: 3, percent: 90, tokens: 3000, at: 2 },
  ]
  const { bars, peak, yMax } = contextStack(turns, 24, 10)
  expect(bars).toHaveLength(3)
  expect(peak).toBe(90)
  expect(bars[0]?.percent).toBe(20)
  // 纵轴自适应：峰值 90+10=100 → ×1.1 取整到 5 的倍数 → 夹到 100。
  expect(yMax).toBe(100)
  // 柱子高度是「已用 + 缓冲」占纵轴的比例，不再恒为 1。
  for (const bar of bars) {
    const total = bar.segments.reduce((sum, s) => sum + s.ratio, 0)
    expect(total).toBeLessThanOrEqual(1 + 1e-9)
    expect(total).toBeGreaterThan(0)
  }
  // 已用超过 100 时被夹住，缓冲段不溢出
  const over = contextStack([{ seq: 9, percent: 130, tokens: 1, at: 0 }], 5, 10)
  expect(over.bars[0]?.percent).toBe(100)
})

test('堆叠柱光栅化：行数正确，柱子自底向上填', () => {
  const turns = [{ seq: 1, percent: 50, tokens: 1, at: 0 }]
  const { bars } = contextStack(turns, 10, 0)
  const grid = rasterizeStacks(bars, 4)
  expect(grid).toHaveLength(4)
  // 50% 在 4 行里约占 2 行，且填在底部
  expect(grid[3]?.[0]?.[0]).not.toBeNull()
  expect(grid[0]?.[0]?.[0] === null || grid[0]?.[0]?.[0] === 'free').toBe(true)
})

test('轮次柱：按天补齐，缺的日子记 0', () => {
  const bars = turnBars(
    [
      { day: '2026-10-18', turns: 10 },
      { day: '2026-10-20', turns: 30 },
    ],
    4,
  )
  expect(bars).toHaveLength(4)
  expect(bars[bars.length - 1]?.day).toBe('2026-10-20')
  expect(bars[bars.length - 1]?.turns).toBe(30)
  expect(bars[bars.length - 1]?.ratio).toBe(1)
  // 10-19 没有记录，应补 0
  const gap = bars.find(b => b.day === '2026-10-19')
  expect(gap?.turns).toBe(0)
})

test('轮次柱光栅化：0 轮也画一格底，时间轴不断档', () => {
  const bars = turnBars(
    [
      { day: '2026-10-19', turns: 0 },
      { day: '2026-10-20', turns: 100 },
    ],
    2,
  )
  const grid = rasterizeTurnBars(bars, 4)
  expect(grid).toHaveLength(4)
  // 每天都有底格
  expect(grid[3]?.[0]).toBe('bar')
  expect(grid[3]?.[1]).toBe('bar')
  // 满值那根比 0 轮那根高
  const heightOf = (index: number) => grid.filter(row => row[index] === 'bar').length
  expect(heightOf(1)).toBeGreaterThan(heightOf(0))
})

test('模型名归并：同一款模型的几种写法合成一行', () => {
  for (const id of [
    'deepseek-flash',
    'DeepSeek-Flash',
    'deepseek-v4-flash',
    'deepseek-v4-1-flash',
    'deepseek-ai/DeepSeek-Flash',
  ]) {
    expect(canonicalModelName(id)).toBe('DeepSeek Flash')
  }
  expect(canonicalModelName('deepseek-v4-pro')).toBe('DeepSeek Pro')
  expect(canonicalModelName('GLM-5.3-Flash')).toBe('GLM Flash')
  expect(canonicalModelName('GLM-5.3')).not.toBe('GLM Flash')
  expect(canonicalModelName('kimi-k3')).toBe('Kimi')
  // 认不出的原样保留。
  expect(canonicalModelName('probe')).toBe('probe')
})

test('模型明细：归并后金额相加，全无价格才是 null', () => {
  const rows = modelDetailRows([
    { model: 'deepseek-flash', isPriced: true, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.15, messages: 10 },
    { model: 'DeepSeek-Flash', isPriced: true, input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: 0.6, messages: 5 },
    { model: 'qwen3.8-27b', isPriced: false, input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 },
    { model: 'auto', isPriced: false, input: 900, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 9 },
  ])

  expect(rows).toHaveLength(2)
  const flash = rows.find(row => row.model === 'DeepSeek Flash')
  expect(flash?.input).toBe(1_000_000)
  expect(flash?.output).toBe(1_000_000)
  expect(Math.abs((flash?.cost ?? 0) - 0.75)).toBeLessThan(1e-9)
  expect(rows.find(row => row.model === 'Qwen 27B')?.cost).toBeNull()
})

test('表格对齐：按显示宽度补空格，中文与英文混排也不歪', () => {
  expect(displayWidth('模型')).toBe(4)
  expect(displayWidth('DeepSeek Flash')).toBe(14)
  const cells = ['模型', 'DeepSeek Flash', 'Qwen 27B', 'GLM Flash']
  const widths = cells.map(text => displayWidth(padCell(text, 14)))
  expect(new Set(widths).size).toBe(1)
  expect(padCell('5', 4, 'right')).toBe('   5')
  expect(padCell('5', 4, 'left')).toBe('5   ')
  expect(displayWidth(clip('DeepSeek Flash', 6))).toBeLessThanOrEqual(6)
})

/**
 * 明细表的列宽由 `detailTableLayout` 一处算出，表头与数据行共用它。
 *
 * 这条测试**直接调真实算法**。上一版是照着渲染代码再抄一份列宽算法来比对，
 * 于是算法本身错了它照样绿——`fitWidth` 曾写成 `Math.min(...)`（取最短的
 * 那一项），输入列按 `8.0万`（5 格）定宽，而 `21.50亿`（7 格）比它长，
 * 被 `clip` 截成 `21.5…`。用户看到的就是「表格里的字挤在一起」。
 *
 * 现在守三件事：
 *   1. 每一列都放得下它**最长**的那一项（不许截断数字）；
 *   2. 列间有可见缝隙；
 *   3. 表头与数据行逐列对齐。
 */
test('模型明细表：列宽放得下最长的读数，且表头与数据行对齐', () => {
  // 造一组「短长混排」的数据：最短 4 格、最长 7 格。
  const rows = modelDetailRows([
    { model: 'DeepSeek Flash', isPriced: true, input: 2_150_000_000, output: 6_779_000, cacheRead: 0, cacheWrite: 0, cost: 18.39, messages: 9 },
    { model: 'claude-opus-5-5', isPriced: true, input: 1_400_000, output: 120_000, cacheRead: 0, cacheWrite: 0, cost: 8.5, messages: 3 },
    { model: 'qwen3.8-27b', isPriced: true, input: 80_000, output: 9_000, cacheRead: 0, cacheWrite: 0, cost: 0.31, messages: 1 },
  ])

  for (const panelWidth of [60, 100, 140]) {
    const layout = detailTableLayout(rows, panelWidth)
    const columns = [
      ['输入', layout.inputWidth, layout.input],
      ['输出', layout.outputWidth, layout.output],
      ['费用', layout.costWidth, layout.cost],
    ] as const

    // 1. 每一列的宽度都得放得下这一列最长的文字。放不下就会被 clip 截掉，
    //    数字截掉就是错的读数（`21.5…` 不是 `21.50亿`）。
    for (const [name, width, texts] of columns) {
      for (const text of texts) {
        expect(displayWidth(text)).toBeLessThanOrEqual(width)
      }
      expect(width).toBeGreaterThanOrEqual(displayWidth(name))
    }

    // 2. 列间缝隙至少 2 格：1 格时 `21.50亿` 与 `677.9万` 会贴成一片。
    expect(layout.gap).toBeGreaterThanOrEqual(2)

    // 3. 表头与数据行逐列对齐（格子数相同、宽度相同）。
    const head = [
      padCell('', 1),
      padCell(clip('模型', layout.nameWidth), layout.nameWidth),
      padCell(clip('输入', layout.inputWidth), layout.inputWidth, 'right'),
      padCell(clip('输出', layout.outputWidth), layout.outputWidth, 'right'),
      padCell(clip('费用', layout.costWidth), layout.costWidth, 'right'),
    ]
    const cellsOf = (index: number) => [
      '■',
      padCell(clip(rows[index]!.model, layout.nameWidth), layout.nameWidth),
      padCell(clip(layout.input[index]!, layout.inputWidth), layout.inputWidth, 'right'),
      padCell(clip(layout.output[index]!, layout.outputWidth), layout.outputWidth, 'right'),
      padCell(clip(layout.cost[index]!, layout.costWidth), layout.costWidth, 'right'),
    ]
    const starts = (cells: string[]): number[] => {
      const out: number[] = []
      let x = 0
      for (const cell of cells) {
        out.push(x)
        x += displayWidth(cell) + layout.gap
      }
      return out
    }
    for (const index of rows.keys()) {
      expect(starts(cellsOf(index))).toEqual(starts(head))
    }

    // 4. 整表不能超出面板宽度。
    const totalWidth = starts(head).at(-1)! + layout.costWidth
    expect(totalWidth).toBeLessThanOrEqual(panelWidth)
  }
})

test('图表翻页已取消：上下文柱状图按宽度自适应，没有翻页状态', () => {
  // 翻页的 `pageOf` 与 `contextOffset` 一并删掉了。这里守的是「不再有
  // 翻页入口」：显示轮数只由宽度决定，图注里的轮数跟着变化。
  // 宽度自适应的数值本身在 `tests/node.run.mjs` 里断言。
  expect(contextChartSvg([], 320).includes('NaN')).toBe(false)
})

test('轮次热图：窗口按天给定，缺的日子补 0', () => {
  const days = [
    { day: '2026-09-21', turns: 3, messages: 30 },
    { day: '2026-10-20', turns: 9, messages: 90 },
  ]
  const bars = turnBars(days, 7)
  expect(bars).toHaveLength(7)
  expect(bars[bars.length - 1]?.day).toBe('2026-10-20')
  expect(bars[bars.length - 1]?.turns).toBe(9)
  expect(bars[bars.length - 1]?.messages).toBe(90)
  // 更长的窗口：缺的日子补 0，时间轴不断档。
  const half = turnBars(days, 180)
  expect(half).toHaveLength(180)
  expect(half[half.length - 1]?.day).toBe('2026-10-20')
  expect(half.filter(bar => bar.turns === 0)).toHaveLength(178)
})

test('两张图在空数据时也给出合法 SVG', () => {
  for (const svg of [contextChartSvg([], 320), turnHeatSvg([], 320)]) {
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg.includes('NaN')).toBe(false)
  }
})

test('上下文分类：按行名归一，只取已用行', () => {
  expect(contextPartKind('System prompt')).toBe('system')
  expect(contextPartKind('System tools')).toBe('tools')
  expect(contextPartKind('Memory files')).toBe('memory')
  expect(contextPartKind('MCP tools')).toBe('mcp')
  expect(contextPartKind('Custom agents')).toBe('agents')
  expect(contextPartKind('Messages')).toBe('messages')
  expect(contextPartKind('Slash commands')).toBe('other')

  const parts = contextParts([
    { name: 'System prompt', tokens: 12_000, kind: 'used' },
    { name: 'Messages', tokens: 300_000, kind: 'used' },
    { name: 'Free space', tokens: 600_000, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 45_000, kind: 'buffer' },
    { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
  ])
  expect(parts.map(p => p.kind)).toEqual(['messages', 'system'])
})

test('有构成时按内容分类堆叠，缺构成的老记录退回单色', () => {
  const { bars, yMax } = contextStack([
    {
      seq: 1,
      percent: 50,
      tokens: 1000,
      at: 0,
      parts: [
        { name: 'Messages', kind: 'messages', tokens: 300_000 },
        { name: 'System prompt', kind: 'system', tokens: 100_000 },
      ],
    },
    { seq: 2, percent: 20, tokens: 500, at: 1 },
  ], 24, 10)

  // 峰值 50+10=60 → ×1.1=66 → 取整到 5 的倍数 = 70。
  expect(yMax).toBe(70)
  expect(bars[0]?.hasParts).toBe(true)
  expect(bars[1]?.hasParts).toBe(false)
  // 自适应纵轴下不画空闲段，它会把柱子重新补满、抵消自适应的意义。
  expect(bars[0]?.segments.map(s => s.kind)).toEqual(['messages', 'system', 'buffer'])
  expect(bars[1]?.segments.map(s => s.kind)).toEqual(['used', 'buffer'])

  // 300k / 400k 的已用部分 = 50% × 0.75 = 37.5%，再除以纵轴 70%。
  expect(Math.abs((bars[0]?.segments[0]?.ratio ?? 0) - 0.375 * (100 / 70)) < 1e-9).toBe(true)
})

test('图例只列出现过的分类，顺序固定', () => {
  const { bars } = contextStack([{
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
  // 自适应纵轴下不画空闲段，所以图例里也没有它。
  expect(stackLegendOf(bars).map(item => item.kind)).toEqual(['system', 'mcp', 'messages', 'buffer'])

  const legacy = contextStack([{ seq: 1, percent: 30, tokens: 1, at: 0 }], 24, 10)
  expect(stackLegendOf(legacy.bars).map(item => item.kind)).toEqual(['used', 'buffer'])
})

test('金额一律带估算标记，零与缺失值除外', () => {
  expect(usdEstimate(2)).toBe('≈$2.00')
  expect(usdEstimate(0)).toBe('$0')
  expect(usdEstimate(undefined)).toBe('—')
  expect(UNPRICED).toBe('未收录价格')
})

test('压缩标记只落在压缩后的第一轮', () => {
  const { bars } = contextStack(
    [
      { seq: 1, percent: 20, tokens: 1, at: 0 },
      { seq: 2, percent: 80, tokens: 1, at: 1, afterCompact: true },
      { seq: 3, percent: 30, tokens: 1, at: 2 },
    ],
    24,
    0,
  )
  expect(bars.map(bar => bar.isAfterCompact)).toEqual([false, true, false])
})

test('面板底色是三档同一份：深浅交给绘制端，图表才分档', () => {
  expect(isLightTheme('light')).toBe(true)
  expect(isLightTheme('light-daltonized')).toBe(true)
  expect(isLightTheme('dark')).toBe(false)
  expect(isLightTheme(undefined)).toBe(false)
  // 界面色是主题键，三档同一份；`auto` 与「读不到」都不再赌深色。
  expect(panelFillFor([{ key: 'theme', value: 'light' }]).backgroundColor).toBe(
    'userMessageBackground',
  )
  expect(panelFillFor([{ key: 'theme', value: 'auto' }]).backgroundColor).toBe(
    'userMessageBackground',
  )
  expect(panelFillFor(undefined).backgroundColor).toBe('userMessageBackground')
})
