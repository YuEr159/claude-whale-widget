import { test, expect, mock } from 'claude-code/testing'

import { register } from '../hooks/register.tsx'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

test('常驻条撑满整行，鲸鱼压在左侧——原生小章鱼的位置', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
    viewport: { columns: 120, rows: 40 },
  })

  const tree = await ui.drawn() as any
  // 外层 Box 必须撑满 bodyColumns，但不再整体靠右
  expect(tree.props.width).toBe(100)
  expect(tree.props.justifyContent).toBeUndefined()

  // 第一个子元素就是 Svg（鲸鱼），紧贴左侧
  const kids = tree.children ?? []
  expect(kids[0]?.type).toBe('Svg')

  // 其后是一个撑开空间的空 Box，把摘要推到右侧
  const spacer = kids.find((kid: any) => kid?.type === 'Box' && kid?.props?.flexGrow === 1)
  expect(spacer).toBeDefined()

  await ui.unmount()
})

test('终端版本鲸鱼 emoji 在最左，文字随后', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: PROPS,
    viewport: { columns: 100, rows: 40 },
  })

  const tree = await ui.drawn() as any
  expect(tree.props.justifyContent).toBeUndefined()
  const kids = tree.children ?? []
  expect(kids[0]?.type).toBe('Text')

  await ui.unmount()
})
