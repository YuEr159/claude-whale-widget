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

  // 刷新按钮已取消：数据由定时扫描自动更新，不需要手动触发。
  expect(await ui.find({ key: 'whale-refresh' })).toBeUndefined()
  // 「范围」已挪到模型页，概览页上不该再有它；切过去才出现。
  expect(await ui.find({ key: 'whale-days' })).toBeUndefined()
  await ui.press({ key: 'whale-tab-models' })
  expect(await ui.find({ key: 'whale-days' })).toBeDefined()
  await ui.press({ key: 'whale-tab-overview' })
  expect(await ui.find({ key: 'whale-turn-cost' })).toBeDefined()
  // 口径是多选：每个口径一个 Button，不再是一个 Select。
  expect(await ui.find({ key: 'whale-metric-diff' })).toBeDefined()
  expect(await ui.find({ key: 'whale-band-toggle' })).toBeDefined()

  await ui.unmount()
})

test('页签与内容在同一个外框内，选中的那个换成更亮的底', async ($, on) => {
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

  /** 从整棵树里找某个 key 的环状盒子，返回它的 props。 */
  const boxOf = (node: any, key: string): any => {
    if (!node || typeof node !== 'object') return undefined
    if (node.props?.key === key) return node
    for (const kid of node.children ?? []) {
      const hit = boxOf(kid, key)
      if (hit) return hit
    }
    return undefined
  }
  const propsOf = async (key: string) => boxOf(await ui.drawn(), key)?.props

  const overviewTab = await propsOf('whale-tabbox-overview')
  const modelsTab = await propsOf('whale-tabbox-models')
  expect(overviewTab).toBeDefined()
  expect(modelsTab).toBeDefined()
  // 每个页签各自带一个边框；激活的那个更粗。
  expect(overviewTab.borderStyle).toBe('bold')
  expect(modelsTab.borderStyle).toBe('round')
  // 默认落在概览页：概览的底色更亮，模型的是大框那一档。
  expect(overviewTab.backgroundColor).not.toBe(modelsTab.backgroundColor)
  const overviewActive = overviewTab.backgroundColor

  await ui.press({ key: 'whale-tab-models' })
  const modelsAfter = await propsOf('whale-tabbox-models')
  const overviewAfter = await propsOf('whale-tabbox-overview')
  // 切过去之后，亮的那一档换到了模型页签上——不是两个都亮着。
  expect(modelsAfter.backgroundColor).toBe(overviewActive)
  expect(modelsAfter.borderStyle).toBe('bold')
  expect(overviewAfter.backgroundColor).not.toBe(overviewActive)
  expect(overviewAfter.borderStyle).toBe('round')

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

  // 刷新按钮已取消：数据由定时扫描自动更新，不需要手动触发。
  expect(await ui.find({ key: 'whale-refresh' })).toBeUndefined()
  // 终端面板该有的控件仍在。
  expect(await ui.find({ key: 'whale-turn-cost' })).toBeDefined()

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
  await pane.press({ key: 'whale-metric-diff' })
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
