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

test('常驻条撑满整行并把鲸鱼排在最右', async ($, on) => {
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
  // 外层 Box 必须撑满 bodyColumns 并靠右
  expect(tree.props.width).toBe(100)
  expect(tree.props.justifyContent).toBe('flex-end')

  // 最后一个子元素应是 Svg（鲸鱼），而不是文字或按钮
  const kids = tree.children ?? []
  const last = kids[kids.length - 1]
  expect(last?.type).toBe('Svg')

  await ui.unmount()
})

test('终端版本同样靠右，鲸鱼 emoji 在最后', async ($, on) => {
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
  expect(tree.props.justifyContent).toBe('flex-end')

  await ui.unmount()
})
