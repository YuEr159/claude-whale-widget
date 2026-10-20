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

/** 在树里找第一个 Svg（鲸鱼可能被定位用的 Box 包着，不止一层）。 */
function findSvg(node: any): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'Svg') return node
  for (const kid of node.children ?? []) {
    const found = findSvg(kid)
    if (found) return found
  }
  return undefined
}

/**
 * 找最后一个 Svg。
 *
 * 面板里有好几张图（上下文柱状图、轮次历史），鲸鱼是最后画的那个。
 * 用「第一个」会拿到前面某张图，测出来的就不是鲸鱼了。
 */
function findLastSvg(node: any): any {
  if (!node || typeof node !== 'object') return undefined
  let found: any
  for (const kid of node.children ?? []) {
    const deeper = findLastSvg(kid)
    if (deeper) found = deeper
  }
  return found ?? (node.type === 'Svg' ? node : undefined)
}

test('面板里鲸鱼固定在右下角，且在控制行之后', async ($, on) => {
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
  expect(tree.type).toBe('Box')
  expect(tree.props.flexDirection).toBe('column')

  // 最后一行是靠右的横向 Box，鲸鱼在它里面
  const kids = tree.children ?? []
  const last = kids[kids.length - 1]
  expect(last?.type).toBe('Box')
  expect(last?.props?.flexDirection).toBe('row')
  expect(last?.props?.justifyContent).toBe('flex-end')

  const svg = findSvg(last)
  expect(svg).toBeDefined()
  const w = Number(svg?.props?.width)
  expect(w).toBeGreaterThanOrEqual(150)

  await ui.unmount()
})

test('窄面板同样是鲸鱼在最后一行靠右', async ($, on) => {
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

  const kids = tree.children ?? []
  const last = kids[kids.length - 1]
  expect(last?.props?.justifyContent).toBe('flex-end')
  expect(findSvg(last)).toBeDefined()

  await ui.unmount()
})

test('泡泡默认收起：SVG 里没有气泡椭圆，只有鲸鱼', async ($, on) => {
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

  const svg = findLastSvg(await ui.drawn())
  const source = String(svg?.props?.source ?? '')
  // 气泡是 <ellipse>，鲸鱼是 <image>；收起时只该有后者。
  expect(source).not.toContain('<ellipse')
  expect(source).toContain('<image')
  // 展开的入口要在场，否则点不开。
  expect(await ui.find({ key: 'whale-tap' })).toBeDefined()

  await ui.unmount()
})

test('点一下鲸鱼，泡泡出现；再点一下，收回去', async ($, on) => {
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

  const sourceNow = async () => String(findLastSvg(await ui.drawn())?.props?.source ?? '')
  expect(await sourceNow()).not.toContain('<ellipse')

  await ui.press({ key: 'whale-tap' })
  expect(await sourceNow()).toContain('<ellipse')

  await ui.press({ key: 'whale-tap' })
  expect(await sourceNow()).not.toContain('<ellipse')

  await ui.unmount()
})

test('泡泡点开后过几秒自己消失', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  const hasBubble = async () =>
    String(findLastSvg(await ui.drawn())?.props?.source ?? '').includes('<ellipse')

  expect(await hasBubble()).toBe(false)
  await ui.press({ key: 'whale-tap' })
  expect(await hasBubble()).toBe(true)

  // 推进到自动收起的时间点之后：泡泡应当自己消失，不必再点一次。
  await clock.advance(5_000)
  expect(await hasBubble()).toBe(false)

  await ui.unmount()
})

/**
 * 上下文图没有翻页按钮——显示最近多少轮由画布宽度自己算。
 *
 * 这条测试守两件事：没有逐轮数据时不画图，以及翻页按钮彻底不存在
 * （它们曾被画成 `whale-left-contextOffset` / `whale-right-contextOffset`）。
 * 宽度自适应的数值断言在 `tests/node.run.mjs` 里。
 */
test('没有逐轮数据时上下文页只说明情况，不画翻页按钮', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  on('session.usage', async () => ({ value: undefined } as never))

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  // 翻到上下文页才画这块内容。
  await ui.press({ key: 'whale-tab-context' })
  expect(await ui.find({ key: 'whale-left-contextOffset' })).toBeUndefined()
  expect(await ui.find({ key: 'whale-right-contextOffset' })).toBeUndefined()
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('还没有逐轮数据')

  await ui.unmount()
})
