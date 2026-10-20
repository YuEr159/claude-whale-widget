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
  // 口径与开关在「设置」页签里，概览页上不该有它们。
  await ui.press({ key: 'whale-tab-settings' })
  expect(await ui.find({ key: 'whale-turn-cost' })).toBeDefined()
  // 口径是多选：每个口径一个 Button，不再是一个 Select。
  expect(await ui.find({ key: 'whale-metric-diff' })).toBeDefined()
  expect(await ui.find({ key: 'whale-band-toggle' })).toBeDefined()
  // 离开了设置页，它们就不在树里——不再挂在面板最下方与三页并列。
  await ui.press({ key: 'whale-tab-overview' })
  expect(await ui.find({ key: 'whale-turn-cost' })).toBeUndefined()

  await ui.unmount()
})

/**
 * 页签的可点区域必须覆盖整块可见的地方。
 *
 * 回归：页签曾是一个带圆角边框的 `Box` 包着一个 `Button`。引擎文档写明
 * `Button` 在桌面端画成原生按钮，命中区只包住它自己的内容，而 Box 的边框
 * 在按钮之外——于是「看着是个框，点上去只有文字有反应」。补内边距也没用，
 * 那只是让内容变宽，边框仍在命中区外。
 *
 * 现在的做法是让按钮自己就是那块方块：外面没有任何带边框的 Box。
 * 下面断言的就是这个结构——按钮的祖先里不许出现 `borderStyle`。
 *
 * （测试宿主不暴露几何信息，所以这里守的是结构前提，不是像素尺寸：
 * 只要按钮自己承担了视觉，它画多大就能点多大。）
 */
test('页签与口径按钮自己就是那块方块：外面没有带边框的 Box', async ($, on) => {
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

  /** 找 key 对应的节点，连同它的祖先链。 */
  const pathOf = (node: any, key: string, trail: any[] = []): any[] | undefined => {
    if (!node || typeof node !== 'object') return undefined
    const here = [...trail, node]
    if (node.props?.key === key) return here
    for (const kid of node.children ?? []) {
      const hit = pathOf(kid, key, here)
      if (hit) return hit
    }
    return undefined
  }

  const assertBare = async (key: string) => {
    const path = pathOf(await ui.drawn(), key)
    expect(path).toBeDefined()
    const button = path![path!.length - 1]
    // 是 Button，不是 Box。
    expect(button.type).toBe('Button')
    // 按钮**外面不套任何带边框的 Box**。唯一允许有边框的祖先是页签与其他页
    // 共用的那个大框（页签本来就是它的内容）；除此之外一律不许有边框——
    // 那正是过去那层「看着是框、点不动」的壳。
    const outers = path!.slice(0, -1).filter(node => node.props?.borderStyle !== undefined)
    expect(outers.length).toBeLessThanOrEqual(1)
    if (outers.length === 1) {
      expect(outers[0].props.borderStyle).toBe('round')
    }
    // 按钮自己有一块底色：未选中时也是一块方块，不是只剩文字。
    const text = (button.children ?? []).find((kid: any) => kid && typeof kid === 'object')
    expect(text?.props?.backgroundColor).toBeDefined()
  }

  for (const id of ['overview', 'models', 'context', 'settings']) {
    await assertBare(`whale-tab-${id}`)
  }

  // 口径按钮同一种结构，且在设置页里。
  await ui.press({ key: 'whale-tab-settings' })
  for (const metric of ['window', 'cost', 'context', 'session', 'diff']) {
    await assertBare(`whale-metric-${metric}`)
  }
  await assertBare('whale-turn-cost')
  await assertBare('whale-band-toggle')

  await ui.unmount()
})

test('选中的页签与未选中的都有底色，只是明暗不同', async ($, on) => {
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

  /** 取页签按钮里那层 Text 的 props。 */
  const textPropsOf = async (key: string): Promise<any> => {
    const found = await ui.find({ key })
    const button: any = found
    const kids = button?.children ?? []
    const text = kids.find((kid: any) => kid && typeof kid === 'object')
    return text?.props
  }

  const active = await textPropsOf('whale-tab-overview')
  await ui.press({ key: 'whale-tab-models' })
  const nowActive = await textPropsOf('whale-tab-models')
  const nowIdle = await textPropsOf('whale-tab-overview')

  // 三块都有底色（未选中的不是「没有框」），选中的那一块底色不同、且加粗。
  expect(active.backgroundColor).toBeDefined()
  expect(nowIdle.backgroundColor).toBeDefined()
  expect(nowActive.backgroundColor).toBe(active.backgroundColor)
  expect(nowActive.bold).toBe(true)
  expect(nowIdle.bold).toBe(false)
  expect(nowIdle.dimColor).toBe(true)

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
  // 终端面板该有的控件仍在——口径与开关现在在「设置」页签里。
  await ui.press({ key: 'whale-tab-settings' })
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
 * 默认口径（没勾「代码改动」）下，用量条不显示增删。
 *
 * 这是「效果反了」那条回归的另一半：旧代码在**未选中**时才画带色的增删
 * 后缀，选中时反倒拼进纯字符串、颜色全丢。现在只有一个方向——勾上才画，
 * 且始终带色。`+128 -34` 写不进 `totals`（宿主只允许插件的 hooks 模块写
 * `$.state`），所以这里断言的是「不该出现」的那一半。
 */
test('没勾「代码改动」时用量条不显示增删', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

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

  // 默认只有 window 一个口径：既没有增删色，也没有 diff 文案。
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('diffAdded')
  expect(tree).not.toContain('diffRemoved')
  expect(tree).not.toContain('本会话还没有代码改动')

  await ui.unmount()
})

/**
 * 「代码改动」选中后用量条才显示改动，且改动始终带 diffAdded / diffRemoved
 * 两种颜色。
 *
 * 回归：之前写反了——选中时改动被拼进纯字符串摘要、颜色全丢，未选中时反倒
 * 作为带色后缀出现，于是「选上反而更难读」。
 *
 * 没有改动时的那句文案是这条链路唯一可观测的产物：`totals` 在测试里写不进去
 * （宿主只允许插件的 hooks 模块写 `$.state`），所以有改动的那一半由
 * `bandDiffText` 的纯函数用例覆盖，这里验证它确实接上了渲染链路。
 */
test('切到「代码改动」口径后，用量条改说没有改动', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  on('session.usage', async () => ({ value: undefined } as never))

  // 先经面板把口径切过去：同一份 prefs 会被用量条读到。
  // 「代码改动」在设置页里，先翻过去。
  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 120, rows: 40 },
  })
  await pane.press({ key: 'whale-tab-settings' })
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
