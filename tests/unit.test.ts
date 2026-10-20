/**
 * 单元与渲染测试：`claude plugin test .` 会用引擎自己的宿主跑这些用例。
 *
 * 只测纯函数与「画出来的树」，不测任何 surface 的像素绘制。
 */
import { test, expect } from 'claude-code/testing'

import { costOf, priceOf } from '../hooks/pricing'
import { clip, countdown, pct, tokens, usd } from '../hooks/format'
import { BAND_METRIC_OPTIONS, bandDiffText, bandSummary, freshnessOf, toUsageView } from '../hooks/usage-view'
import {
  addModelSpend,
  countPatchLines,
  detailOf,
  duration,
  limitRows,
  meterText,
  sortModelSpends,
  toContextDetail,
  unpricedNote,
  windowSourceText,
} from '../hooks/usage-detail'
import { WHALE_MIN_HEIGHT, moodOf, whaleSizeFor, whaleSvg } from '../hooks/whale-art'
import {
  barText,
  calendarHeat,
  hourLabel,
  maskModel,
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
  turnPages,
} from '../hooks/usage-overview'
import { contextChartSvg, pageOf, turnChartSvg } from '../hooks/chart-art'
import { UNPRICED, provenanceNotesFor, usdEstimate } from '../hooks/provenance'

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

test('按花费降序，未收录价格的排最后', () => {
  const sorted = sortModelSpends([
    { model: 'unknown-x', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, turns: 9 },
    { model: 'claude-haiku', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 2 },
    { model: 'claude-opus', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2, turns: 1 },
  ])
  expect(sorted.map(item => item.model)).toEqual(['claude-opus', 'claude-haiku', 'unknown-x'])
})

test('未收录价格时给出说明，全收录则没有', () => {
  expect(unpricedNote([
    { model: 'deepseek-v4', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, turns: 1 },
  ])).toContain('deepseek-v4')
  expect(unpricedNote([
    { model: 'claude-opus', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1, turns: 1 },
  ])).toBeUndefined()
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

test('面板详细程度：缺字段按默认详细读', () => {
  expect(detailOf({})).toBe('detail')
  expect(detailOf({ panelDetail: 'simple' })).toBe('simple')
  expect(detailOf({ panelDetail: 'detail' })).toBe('detail')
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
  expect(bandSummary(view, 'window', now)).toContain('5h 40%')
  expect(bandSummary(view, 'session', now)).toBe('本会话 ≈$2.00')
  expect(bandSummary(view, 'cost', now)).toBe('上下文 12%')
  expect(bandSummary(view, 'context', now)).toBe('5h 40% · 7d 70%')
})

test('代码改动可以单独成段，其余口径不带它', () => {
  const view = toUsageView({
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
    cost: { usd: 2 },
    context: { window: 1_000_000, percent: 12 },
  })
  const now = Date.parse('2026-10-20T12:00:00Z')
  const diff = { added: 128, removed: 34 }

  // 选中「代码改动」：这一条就是改动本身。
  expect(bandSummary(view, 'diff', now, diff)).toBe('+128 -34')
  // 还没有改动时明说，不留空条。
  expect(bandSummary(view, 'diff', now, { added: 0, removed: 0 })).toBe('本会话还没有代码改动')
  // 其余口径的摘要不含改动——增删要分色，由渲染层追加，不拼进字符串。
  expect(bandSummary(view, 'window', now, diff)).not.toContain('+128')
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
  expect(bandSummary(view, 'window', 0)).toBe('上下文 33% · 本会话 ≈$0.50')
})

test('用量条口径选项覆盖全部取值', () => {
  expect(BAND_METRIC_OPTIONS.map(o => o.value).sort()).toEqual(
    ['context', 'cost', 'diff', 'session', 'window'].sort(),
  )
})

test('鲸鱼尺寸：连续公式，没有阈值跳变', () => {
  // 关键回归：旧公式在 59→60 列处会一次缩 84px
  let maxJump = 0
  for (let columns = 16; columns <= 140; columns += 1) {
    const jump = Math.abs(whaleSizeFor(columns + 1).width - whaleSizeFor(columns).width)
    if (jump > maxJump) maxJump = jump
  }
  expect(maxJump).toBeLessThanOrEqual(5)
  // 两端夹住，中间线性
  expect(whaleSizeFor(200).width).toBe(300)
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

test('模型名脱敏：保留头尾，中间星号', () => {
  expect(maskModel(null)).toBe('—')
  expect(maskModel('claude-opus-5-5')).toBe('opu*** -5-5')
  const masked = maskModel('deepseek-v4-flash')
  expect(masked.startsWith('dee')).toBe(true)
  expect(masked).toContain('*')
  expect(masked).not.toBe('deepseek-v4-flash')
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
  const { bars, peak } = contextStack(turns, 24, 10)
  expect(bars).toHaveLength(3)
  expect(peak).toBe(90)
  expect(bars[0]?.percent).toBe(20)
  // 每根柱子的分段比例之和应为 1（不含被裁掉的 0 段）
  for (const bar of bars) {
    const total = bar.segments.reduce((sum, s) => sum + s.ratio, 0)
    expect(Math.abs(total - 1) < 1e-9).toBe(true)
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

test('图表翻页：0 贴住最新一页，越翻越往历史走', () => {
  const items = Array.from({ length: 60 }, (_, index) => index)
  const newest = pageOf(items, 24, 0)
  expect(newest.slice).toEqual(items.slice(36, 60))
  expect(newest.pages).toBe(3)
  expect(newest.page).toBe(3)
  expect(newest.maxOffset).toBe(2)

  expect(pageOf(items, 24, 1).page).toBe(2)
  const oldest = pageOf(items, 24, 99)
  expect(oldest.slice).toEqual(items.slice(0, 12))
  expect(oldest.page).toBe(1)
})

test('轮次图按天分页：窗口天数固定，右端随页移动', () => {
  const days = [
    { day: '2026-09-21', turns: 3 },
    { day: '2026-10-20', turns: 9 },
  ]
  const newest = turnPages(days, 7, 0)
  expect(newest.endDay).toBe('2026-10-20')
  expect(newest.maxOffset).toBe(4)
  expect(turnPages(days, 7, 1).endDay).toBe('2026-10-13')
  expect(turnPages(days, 7, 99).page).toBe(1)

  const bars = turnBars(days, 7, newest.endDay)
  expect(bars).toHaveLength(7)
  expect(bars[6]?.day).toBe('2026-10-20')
})

test('两张图在空数据时也给出合法 SVG', () => {
  for (const svg of [contextChartSvg([], 320), turnChartSvg([], 320, 7)]) {
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
  const { bars } = contextStack([
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

  expect(bars[0]?.hasParts).toBe(true)
  expect(bars[1]?.hasParts).toBe(false)
  expect(bars[0]?.segments.map(s => s.kind)).toEqual(['messages', 'system', 'buffer', 'free'])
  expect(bars[1]?.segments.map(s => s.kind)).toEqual(['used', 'buffer', 'free'])

  const sum = bars[0]?.segments.reduce((acc, s) => acc + s.ratio, 0) ?? 0
  expect(Math.abs(sum - 1) < 1e-9).toBe(true)
  // 300k / 400k 的已用部分 = 50% × 0.75 = 37.5%
  expect(Math.abs((bars[0]?.segments[0]?.ratio ?? 0) - 0.375) < 1e-9).toBe(true)
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
  expect(stackLegendOf(bars).map(item => item.kind)).toEqual(['system', 'mcp', 'messages', 'buffer', 'free'])

  const legacy = contextStack([{ seq: 1, percent: 30, tokens: 1, at: 0 }], 24, 10)
  expect(stackLegendOf(legacy.bars).map(item => item.kind)).toEqual(['used', 'buffer', 'free'])
})

test('金额一律带估算标记，零与缺失值除外', () => {
  expect(usdEstimate(2)).toBe('≈$2.00')
  expect(usdEstimate(0)).toBe('$0')
  expect(usdEstimate(undefined)).toBe('—')
  expect(UNPRICED).toBe('未收录价格')
})

test('来源脚注只解释出现过的数字', () => {
  expect(provenanceNotesFor(false, false).map(n => n.topic)).toEqual(['带 ≈ 的金额'])
  expect(provenanceNotesFor(false, true).map(n => n.topic)).toEqual([
    '带 ≈ 的金额',
    '上下文柱子',
  ])
  expect(provenanceNotesFor(true, true).map(n => n.topic)).toEqual([
    '带 ≈ 的金额',
    '上下文柱子',
    '本地历史',
  ])
})
