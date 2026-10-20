import { test, expect, mock } from 'claude-code/testing'

import { register } from '../hooks/register.tsx'

const props = (cols: number) => ({
  title: '小鲸鱼',
  isFocused: false,
  bodyColumns: cols,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
})

/** 一份接近真实形状的 usage，含 summary 级 breakdown。 */
const usage = {
  startedAt: Date.parse('2026-10-20T10:00:00Z'),
  context: {
    tokens: 421_000,
    window: 1_000_000,
    percent: 42,
    breakdown: {
      categories: [
        { name: 'Messages', tokens: 380_000, kind: 'used', color: 'promptBorder' },
        { name: 'System prompt', tokens: 41_000, kind: 'used', color: 'promptBorder' },
        { name: 'Free space', tokens: 539_000, kind: 'free', color: 'inactive' },
        { name: 'Autocompact buffer', tokens: 40_000, kind: 'buffer', color: 'subtle' },
      ],
      totalTokens: 421_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 42,
      autocompactSource: 'auto',
      isAutoCompactEnabled: true,
      autoCompactThreshold: 920_000,
      model: 'Opus 5.5',
      gridRows: [
        [
          { categoryName: 'Messages', color: 'promptBorder', isFilled: true, tokens: 380_000, percentage: 38, squareFullness: 1 },
          { categoryName: 'Free space', color: 'inactive', isFilled: false, tokens: 539_000, percentage: 54, squareFullness: 0 },
        ],
      ],
      memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 1_200 }],
      mcpTools: [{ name: 'mcp__linear__issue', serverName: 'linear', tokens: 800 }],
      agents: [{ agentType: 'Explore', source: 'builtin', tokens: 300 }],
      skills: { totalSkills: 10, includedSkills: 4, tokens: 900, skillFrontmatter: [] },
      apiUsage: null,
    },
  },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-20T14:13:00Z' },
    { kind: 'seven_day', percentUsed: 61, resetsAt: '2026-10-27T00:00:00Z' },
    { kind: 'seven_day_sonnet', percentUsed: 12 },
  ],
  cost: { usd: 2.5 },
}

test('详细面板画出原生 /usage 与 /context 的各节', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  // 测试环境没有 session.usage 的实现，这里补一个。
  on('session.usage', async () => ({ value: usage } as never))

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 60 },
  })

  const tree = JSON.stringify(await ui.drawn())

  // 原生 /usage 的窗口标题
  expect(tree).toContain('Current session')
  expect(tree).toContain('Current week (all models)')
  expect(tree).toContain('Current week (Sonnet only)')

  // /context 的百分比、窗口来源、分项
  expect(tree).toContain('上下文 42%')
  expect(tree).toContain('Model自身上限'.replace('Model', '模型'))
  expect(tree).toContain('Messages')
  expect(tree).toContain('Autocompact buffer')

  // 金额带估算标记：面板里没有一笔钱来自账单。
  expect(tree).toContain('≈$')
  // 数据来源脚注：详细视图才出现，且只解释这一屏真正有的数字
  //（这里没有本地扫描结果，所以不提「本地历史」）。
  expect(tree).toContain('带 ≈ 的金额')
  expect(tree).toContain('上下文明细')
  expect(tree).not.toContain('本地历史')

  // 记忆文件 / MCP / agent / 技能计数
  expect(tree).toContain('记忆文件 ')
  expect(tree).toContain('MCP 工具 ')
  expect(tree).toContain('技能 ')

  await ui.unmount()
})

test('切到简洁后面板不再请求 breakdown，也不再画明细', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/Yuxiao/test' })
  mock.store(on, {})
  // 测试的 hook 不能写 `$.state`（宿主规则只允许插件的 hooks 模块写），
  // 也不能靠 hook `state.get` 预置——引擎会把那样的应答丢掉。
  // 可靠的做法是走面板自己的控件：选中「简洁」，由插件自己写偏好、自己重绘。
  const calls: unknown[] = []
  on('session.usage', async (_: unknown, e: any) => {
    calls.push(e)
    return { value: usage } as never
  })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  // 初始是详细：请求了 breakdown，也画了 /context 明细与来源脚注。
  const before = JSON.stringify(await ui.drawn())
  expect(calls.length).toBe(1)
  expect(JSON.stringify(calls[0])).toContain('breakdown')
  expect(before).toContain('Autocompact buffer')
  expect(before).toContain('带 ≈ 的金额')

  // 切到简洁：下一次取用量不再带 breakdown，明细与脚注都不再出现。
  await ui.select({ key: 'whale-panel-detail', value: 'simple' })
  const after = JSON.stringify(await ui.drawn())
  expect(calls.length).toBeGreaterThan(1)
  expect(JSON.stringify(calls[calls.length - 1])).not.toContain('breakdown')
  expect(after).not.toContain('Autocompact buffer')
  expect(after).not.toContain('带 ≈ 的金额')
  // 金额的估算标记是数据属性，不随视图简繁改变。
  expect(after).toContain('≈$')
  // 额度窗口仍在，但简洁模式退回一行摘要，不再逐条列原生标题。
  expect(after).toContain('5h')
  expect(after).not.toContain('Current session')

  await ui.unmount()
})
