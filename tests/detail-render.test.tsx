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

  // 记忆文件 / MCP / agent / 技能计数
  expect(tree).toContain('记忆文件 ')
  expect(tree).toContain('MCP 工具 ')
  expect(tree).toContain('技能 ')

  await ui.unmount()
})

test('简洁面板不请求 breakdown，也不画明细', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  // 每次取用量时把偏好改成简洁；面板渲染随后读到的就是它。
  on('session.usage', async $ => {
    await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as never, {
      isBandVisible: true,
      bandMetric: 'window',
      historyDays: 7,
      isTurnCostOn: false,
      scanIntervalMs: 300_000,
      panelDetail: 'simple',
    } as never)
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

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('Autocompact buffer')
  expect(tree).toContain('5h')

  await ui.unmount()
})
