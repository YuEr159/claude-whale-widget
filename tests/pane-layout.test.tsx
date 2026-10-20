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

test('宽面板用两栏：鲸鱼在左、数据在右，且鲸鱼明显放大', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  const tree = await ui.drawn() as any
  // 顶层是纵向 Box，第一个子元素是横向 Box（两栏）
  expect(tree.type).toBe('Box')
  expect(tree.props.flexDirection).toBe('column')
  const row = tree.children[0]
  expect(row.type).toBe('Box')
  expect(row.props.flexDirection).toBe('row')

  // 左栏里有 Svg，且宽度比原来的 150 大
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  const w = Number(svg?.props.width)
  expect(w).toBeGreaterThan(150)

  await ui.unmount()
})

test('窄面板退回单列，鲸鱼仍按宽度缩放', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(40),
    viewport: { columns: 60, rows: 40 },
  })

  const tree = await ui.drawn() as any
  expect(tree.props.flexDirection).toBe('column')
  // 单列时第一层子元素不该是横向两栏
  const row = tree.children[0]
  expect(row.type).toBe('Text') // 标题在最上

  await ui.unmount()
})
