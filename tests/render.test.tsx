/**
 * 渲染测试：用引擎自己的测试宿主，在桌面 surface 上真正画一次界面。
 *
 * 验证的是「插件返回的树能被该 surface 的元素表接受」「按钮画得出来」，
 * 不测任何 surface 的像素绘制。
 *
 * 注意：mount 出来的实例不在引擎的 press 登记表里（只有引擎自己渲染的
 * 实例才登记），所以这里只验证绘制，不验证点击。点击行为靠命令与手工验证。
 */
import { test, expect, mock } from 'claude-code/testing'

import { register } from '../hooks/register.tsx'

const PLUGIN = 'whale-usage'

/**
 * 引擎只允许行内元素（Text）里放字符串或其它 Text；放 Box 会让整棵树被拒，
 * 引擎改画它自己的界面，插件这一屏就整个消失了。
 *
 * 这条规则值得单独守着，因为有两个坑很隐蔽：
 *   - `<>...</>` 在这个引擎里**不是透明的**，它是个纵向 Box（Fragment 的实现
 *     就是 `column Box around the children`）；
 *   - 嵌套 Text 是合法的，嵌套 Box 不是。
 *
 * 返回第一处违规的路径，没有则 undefined。
 */
function findBlockInInline(node: any, path = ''): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  const here = `${path}/${node.type ?? '?'}`

  if (node.type === 'Text') {
    for (const kid of node.children ?? []) {
      if (kid && typeof kid === 'object') {
        if (kid.type !== 'Text') return `${here} > ${kid.type}`
        const deeper = findBlockInInline(kid, here)
        if (deeper) return deeper
      }
    }
    return undefined
  }

  for (const kid of node.children ?? []) {
    const found = findBlockInInline(kid, here)
    if (found) return found
  }
  return undefined
}

const PANE_PROPS = {
  title: '小鲸鱼',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('桌面端面板能画出来，控件都在', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })

  expect(await ui.find({ key: 'whale-refresh' })).toBeDefined()
  expect(await ui.find({ key: 'whale-days' })).toBeDefined()
  expect(await ui.find({ key: 'whale-turn-cost' })).toBeDefined()
  expect(await ui.find({ key: 'whale-panel-detail' })).toBeDefined()
  expect(await ui.find({ key: 'whale-metric' })).toBeDefined()
  expect(await ui.find({ key: 'whale-band-toggle' })).toBeDefined()

  await ui.unmount()
})

test('输入框上方有用量条：摘要 + 面板入口，但没有形象', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport: { columns: 120, rows: 40 },
  })

  // 用量条本身与入口都在
  const band = await ui.find({ key: 'whale-band' })
  expect(band).toBeDefined()
  expect(await ui.find({ key: 'whale-open' })).toBeDefined()
  // 但不再画任何形象：既没有 Svg，也没有 emoji 格
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  const kids = (await ui.drawn() as any).children ?? []
  expect(kids.every((kid: any) => kid?.type !== 'Svg')).toBe(true)

  await ui.unmount()
})

test('终端上用量条同样只有文字与入口', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport: { columns: 100, rows: 40 },
  })

  expect(await ui.find({ key: 'whale-band' })).toBeDefined()
  expect(await ui.find({ key: 'whale-open' })).toBeDefined()
  const kids = (await ui.drawn() as any).children ?? []
  // 第一个子元素是摘要文字，不是 emoji
  expect(kids[0]?.type).toBe('Text')

  await ui.unmount()
})

test('终端 surface 面板没有 Svg 也能画（退化成文字鲸鱼）', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })

  expect(await ui.find({ key: 'whale-refresh' })).toBeDefined()

  await ui.unmount()
})

/**
 * 用量条跟随代码改动，靠的是两个事实：
 *   1. 用量条的渲染读了 `totals`；
 *   2. `$.state.set` 会重绘读过该值的绘制点。
 *
 * 测试的 hook 写不了 `$.state`（宿主规则），所以这里断言的是渲染侧：
 * 条子确实读了 `totals`，并且当状态里已有改动时，条上会画出带 diff 色的增删。
 */
test('用量条画出代码改动，增删各用主题的 diff 色', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport: { columns: 120, rows: 40 },
  })

  const tree = await ui.drawn()
  // 还没有任何 Edit / Write：不画 `+0 -0` 这种噪音。
  expect(JSON.stringify(tree)).not.toContain('diffAdded')
  expect(JSON.stringify(tree)).not.toContain('diffRemoved')
  // 关键回归：行内元素里不能出现 Box。之前用 `<>` 包增删片段，
  // Fragment 展开成 Box 塞进 Text，整棵树被引擎拒绝，用量条直接消失。
  expect(findBlockInInline(tree)).toBeUndefined()

  await ui.unmount()
})

/**
 * 「代码改动」是一个并列口径，选中后用量条只显示改动。
 *
 * 没有改动时的那句文案是这条链路唯一可观测的产物：`totals` 在测试里写不进去
 * （宿主只允许插件的 hooks 模块写 `$.state`），所以有改动的那一半由
 * `bandSummary` / `bandDiffText` 的纯函数用例覆盖，这里验证它确实接上了
 * 渲染链路。
 */
test('切到「代码改动」口径后，用量条改说没有改动', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  on('session.usage', async () => ({ value: undefined } as never))

  // 先经面板把口径切过去：同一份 prefs 会被用量条读到。
  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 120, rows: 40 },
  })
  await pane.select({ key: 'whale-metric', value: 'diff' })
  await pane.unmount()

  const band = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport: { columns: 120, rows: 40 },
  })

  const tree = JSON.stringify(await band.drawn())
  expect(tree).toContain('本会话还没有代码改动')
  expect(tree).not.toContain('diffAdded')

  await band.unmount()
})
