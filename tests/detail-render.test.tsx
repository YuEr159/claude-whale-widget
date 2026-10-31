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

test('面板画出原生 /usage 的额度窗口与金额', async ($, on) => {
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

  // 金额带估算标记：面板里没有一笔钱来自账单。
  expect(tree).toContain('≈$')
  // 面板底部那三行来源脚注已经撤掉了：它们反复解释同一批数字，读者每开
  // 一次面板都要划过去。金额的「≈」自己就说明了它是估算。
  expect(tree).not.toContain('带 ≈ 的金额')
  expect(tree).not.toContain('上下文明细')
  expect(tree).not.toContain('本地历史')

  // 上下文那一整段文字已经删掉了：窗口上限、压缩阈值、加载项数量都不再上屏，
  // 柱状图与热图自己说明问题。
  expect(tree).not.toContain('模型自身上限')
  expect(tree).not.toContain('自动压缩于')
  expect(tree).not.toContain('记忆文件 ')
  expect(tree).not.toContain('MCP 工具 ')
  expect(tree).not.toContain('Autocompact buffer')
  expect(tree).not.toContain('⛁')

  await ui.unmount()
})

test('面板只有一种形态：请求 breakdown、画出额度与估算金额', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  // 测试的 hook 不能写 `$.state`（宿主规则只允许插件的 hooks 模块写），
  // 也不能靠 hook `state.get` 预置——引擎会把那样的应答丢掉。
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

  const tree = JSON.stringify(await ui.drawn())
  // 面板恒为完整形态：请求 breakdown、画出额度、金额带估算标记。
  expect(calls.length).toBe(1)
  expect(JSON.stringify(calls[0])).toContain('breakdown')
  expect(tree).toContain('≈$')
  // 原生 /usage 的逐条窗口标题也一直列着。
  expect(tree).toContain('Current session')
  // 「面板详细程度」这个开关已经不存在了：不该再有那个选择器。
  expect(await ui.find({ key: 'whale-panel-detail' })).toBeUndefined()

  await ui.unmount()
})
