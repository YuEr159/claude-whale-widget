/**
 * 单元与渲染测试：`claude plugin test .` 会用引擎自己的宿主跑这些用例。
 *
 * 只测纯函数与「画出来的树」，不测任何 surface 的像素绘制。
 */
import { test, expect } from 'claude-code/testing'

import { costOf, priceOf } from '../hooks/pricing'
import { clip, countdown, pct, tokens, usd } from '../hooks/format'
import { BAND_METRIC_OPTIONS, bandSummary, freshnessOf, toUsageView } from '../hooks/usage-view'
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
} from '../hooks/usage-detail'
import { moodOf, whaleBandSvg, whaleSvg } from '../hooks/whale-art'

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

test('上方条口径选项覆盖全部四种取值', () => {
  expect(BAND_METRIC_OPTIONS.map(o => o.value).sort()).toEqual(
    ['context', 'cost', 'session', 'window'].sort(),
  )
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

test('上下文 breakdown 整形：分项、网格、条目', () => {
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
  expect(Math.abs((detail.rows[0]?.sharePercent ?? 0) - 40) < 1e-9).toBe(true)
  expect(detail.grid[0]?.[0]).toEqual({ name: 'Messages', color: 'promptBorder', isFilled: true })
  expect(detail.grid[0]?.[1]?.isFilled).toBe(false)
  expect(detail.memoryFiles[0]?.tokens).toBe(1200)
  expect(detail.mcpTools[0]?.server).toBe('linear')
  expect(detail.agents[0]?.type).toBe('Explore')
  expect(detail.skills?.included).toBe(4)
  expect(detail.slashCommands?.total).toBe(6)
  expect(contextHeadline(detail)).toContain('上下文 50%')
  expect(windowSourceText(detail)).toContain('模型自身上限')
  expect(contextRowText(detail.rows[0] as never)).toContain('(40%)')
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

test('常驻条用极简像素女仆：16×15 格、path 合并', () => {
  const svg = whaleBandSvg('idle')
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.endsWith('</svg>')).toBe(true)
  expect(svg).toContain('viewBox="0 0 64 60"')
  expect(svg).toContain('shape-rendering="crispEdges"')
  // 纯矢量：没有内嵌位图，尺寸远小于 Svg 的 source 上限
  expect(svg).not.toContain('<image')
  expect(svg).not.toContain('base64')
  expect(svg.length).toBeLessThan(2000)
  // 情绪只叠一层色，不新增彩色格子
  expect(whaleBandSvg('idle')).not.toContain('<rect width="64"')
  expect(whaleBandSvg('sleep')).toContain('<rect width="64" height="60"')
})
