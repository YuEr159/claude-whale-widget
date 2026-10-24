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

  // **选中的底色必须与未选中的不同。** 早先这里只断言「两次选中态相等」，
  // 测试名叫「明暗不同」却从没比较过选中与未选中——两个都取同一个错误值
  // 也能全绿。真正的判据在这一行。
  expect(nowActive.backgroundColor).not.toBe(nowIdle.backgroundColor)

  // 来回切换后，同一位置的选中态应当稳定（换的是「谁被选中」，不是配色本身）。
  expect(nowActive.backgroundColor).toBe(active.backgroundColor)

  expect(nowActive.bold).toBe(true)
  expect(nowIdle.bold).toBe(false)
  expect(nowIdle.dimColor).toBe(true)

  await ui.unmount()
})

/**
 * 圆角块的底、边、页签文字都必须以**主题键**出现在渲染树上。
 *
 * 回归：这些颜色曾是写死的十六进制对（深色一套、浅色一套），由插件按
 * `/config` 的 `theme` 值挑一套。但 `theme` 的默认值是 `auto`——插件只
 * 知道「跟随」，不知道跟到的是深还是浅，于是永远挑深色那套：浅色界面里
 * 整块深蓝黑，和用户反馈的一字不差。
 *
 * 改成主题键后，解析发生在绘制端（引擎按实际主题解析），`auto` 也跟得对。
 * 这条测试守的是「树里交出去的确实是键，不是实色」——只要有人改回十六进制，
 * 它立刻就会红。
 *
 * 主题行这里故意给 `auto`：那是最常见的设置，也是过去唯一出错的取值。
 */
test('圆角块与页签文字交给绘制端的都是主题键，不是写死的实色', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  // 注册一个位于引擎之上的 `config.list`：`next(e)` 才是引擎自己的读取。
  // 返回类型写成 `any`，因为这里刻意替换成**一份只有 theme 行的列表**——
  // 测试只关心插件读到 `auto` 时会怎么做。
  on('config.list', (async (_: unknown, e: any, next: any) => {
    const outer = await next(e)
    const rows = [{ key: 'theme', value: 'auto' }, ...(outer ?? [])]
    return rows
  }) as any)

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })

  const HEX = /^#|^rgb\(/i
  /** 顺着树收集所有带底色或边框的节点。 */
  const painted: Array<{ where: string; value: string; prop: string }> = []
  const walk = (node: any, path = '') => {
    if (!node || typeof node !== 'object') return
    const here = `${path}/${node.type ?? '?'}`
    const props = node.props ?? {}
    for (const prop of ['backgroundColor', 'borderColor', 'color']) {
      const value = props[prop]
      // `diffAdded` / `diffRemoved` 这类也是主题键，一并纳入检查。
      if (typeof value === 'string' && HEX.test(value)) {
        painted.push({ where: `${here}${props.key ? `[${props.key}]` : ''}`, value, prop })
      }
    }
    for (const kid of node.children ?? []) walk(kid, here)
  }
  walk(await ui.drawn())

  // 面板侧不该有任何写死的实色。鲸鱼的 SVG 里有十六进制，但那是 `Svg` 的
  // `source` 字符串，不是元素的颜色属性，不会被这条遍历看到。
  expect(painted).toEqual([])

  // 页签那层 Text 上确实带了主题键（`auto` 与浅色、深色拿到的都是这些键）。
  const tab = (await ui.find({ key: 'whale-tab-overview' })) as any
  const tabText = (tab?.children ?? []).find((kid: any) => kid && typeof kid === 'object')
  expect(tabText?.props?.backgroundColor).toBe('userMessageBackgroundHover')
  expect(tabText?.props?.color).toBe('text')

  await ui.unmount()
})

/**
 * 面板的根 Box 要撑满正文高度，鲸鱼才落得到底边。
 *
 * 回归：根 Box 只按内容排，窗口一高，鲸鱼就贴着最后一行内容悬在半空，
 * 底下留一大片空白——「固定在右下角」不成立。修法是给根 Box 一个
 * `minHeight`（正文可用行数）再加一个 `flexGrow` 的占位，把鲸鱼与脚注
 * 压到底边。
 *
 * 只在停靠（dock）时撑：内联面板的高度本来就由内容决定。
 */
test('停靠面板的根 Box 撑满正文高度，内联面板不撑', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/C/test' })
  mock.store(on, {})

  const mountWith = async (placement: 'dock' | 'inline', bodyRows: number) =>
    $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'Pane',
      requestId: 'whale',
      props: { ...PANE_PROPS, placement, scroll: { offset: 0, bodyRows } },
      viewport: { columns: 100, rows: 40 },
    })

  const docked = await mountWith('dock', 30)
  const dockTree = await docked.drawn() as any
  expect(dockTree.props.minHeight).toBe(30)
  // 占位要在，否则 minHeight 只会让底边空出一截，内容仍挤在上方。
  const spacer = (dockTree.children ?? []).find((kid: any) => kid?.props?.key === 'whale-spacer')
  expect(spacer).toBeDefined()
  expect(spacer?.props?.flexGrow).toBe(1)
  await docked.unmount()

  // 内联面板：高度由内容决定，不许凭空拉长。
  const inline = await mountWith('inline', 30)
  expect((await inline.drawn() as any).props.minHeight).toBeUndefined()
  await inline.unmount()
})

/**
 * 设置页里的每一项都是**开关**：亮＝这一项开着。
 *
 * 回归：`whale-band-toggle` 曾经写死 `isActive=false`，于是它永远不亮，
 * 读者没法从「亮不亮」判断用量条现在是显示还是收起；而它的标签又在
 * 「隐藏用量条 / 显示用量条」之间来回变，成了同一组里唯一一个动作按钮。
 */
test('设置页的开关都按真实状态亮灭，不写死', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })
  await ui.press({ key: 'whale-tab-settings' })

  /** 取某个 chip 里那层 Text 的 props。 */
  const textProps = async (key: string): Promise<any> => {
    const found: any = await ui.find({ key })
    const kids = found?.children ?? []
    return kids.find((kid: any) => kid && typeof kid === 'object')?.props
  }

  // 默认用量条是显示的：这个开关应当亮着。
  const bandOn = await textProps('whale-band-toggle')
  expect(bandOn.bold).toBe(true)
  expect(bandOn.dimColor).toBeFalsy()

  // 点一下收起来：它应当变成灭的，且文字仍然是「显示用量条」——
  // 标签说的是这个开关控制的东西，亮灭说的是它现在开没开。
  await ui.press({ key: 'whale-band-toggle' })
  const bandOff = await textProps('whale-band-toggle')
  expect(bandOff.bold).toBe(false)
  expect(bandOff.dimColor).toBe(true)

  // 再点回来。
  await ui.press({ key: 'whale-band-toggle' })
  expect((await textProps('whale-band-toggle')).bold).toBe(true)

  // 「轮次费用提示」默认关：灭着。
  const costOff = await textProps('whale-turn-cost')
  expect(costOff.bold).toBe(false)
  await ui.press({ key: 'whale-turn-cost' })
  expect((await textProps('whale-turn-cost')).bold).toBe(true)

  // 口径按钮同样按真实状态亮灭：默认只开「额度窗口」。
  expect((await textProps('whale-metric-window')).bold).toBe(true)
  expect((await textProps('whale-metric-diff')).bold).toBe(false)

  await ui.unmount()
})

/**
 * 每一处的「没存过就用什么」都必须指向 `DEFAULT_PREFS`。
 *
 * 回归：热图的回退值曾写成字面量 `'messages'`，而 `DEFAULT_PREFS.heatMetric`
 * 是 `'turns'`。正常情况下 `prefsNow` 已经合并过默认值，走不到那个 `??`；
 * 但一旦状态里存了个 `undefined`，界面就会跳到与「默认」相反的那一档——
 * 两处各写一个数，迟早会分叉。
 *
 * 这条测试是按热图实际呈现的口径断言的：默认应当按「轮次」着色。
 */
test('默认偏好只有一处来源：热图默认按轮次着色', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })

  // 「色深」控件当前值就是渲染用的那份口径。
  const select: any = await ui.find({ key: 'whale-heat-metric' })
  expect(select).toBeDefined()
  expect(select.props?.value).toBe('turns')

  await ui.unmount()
})

/**
 * 每一次点口径按钮都要回一句「开 / 关」。
 *
 * 口径按钮只改变自身的底色与明暗，条目位置一字不动——不开口的读者没法
 * 从画面判断那一下生效没有，只能反复点来试探。提示里带上项目名，才说得清
 * 是哪一项被切换了。
 */
test('点用量条口径给出开/关提示', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const toasts: string[] = []
  on('ui.toast', async ($2: any, e: any, next: any) => {
    toasts.push(e.text)
    return next(e)
  })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })
  await ui.press({ key: 'whale-tab-settings' })

  // 默认只开着「额度窗口」；再点它会被拒绝（至少留一项），那是另一条提示。
  await ui.press({ key: 'whale-metric-cost' })
  expect(toasts.some(text => text.includes('上下文占用') && text.includes('已开启'))).toBe(true)

  // 再点一次关掉它，提示要说「已关闭」而不是又说一遍「已开启」。
  await ui.press({ key: 'whale-metric-cost' })
  expect(toasts.some(text => text.includes('上下文占用') && text.includes('已关闭'))).toBe(true)

  // 每个口径都走同一条路：挑一个还没碰过的再验一次。
  await ui.press({ key: 'whale-metric-session' })
  expect(toasts.some(text => text.includes('本会话花费') && text.includes('已开启'))).toBe(true)

  await ui.unmount()
})

/**
 * 「轮次费用提示」也是开关，切换时要回一句提示。
 *
 * 与口径按钮同理：这个开关只改变方块自身的明暗，画面别处一字不动。
 * 不开口的读者点一下只看到方块变色，不知道那一下生效了没有，也不知道
 * 这个开关管的是什么（它只弹「上一轮」那一次提示，不改面板里的读数）。
 */
test('切换「轮次费用提示」给出开/关提示', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const toasts: string[] = []
  on('ui.toast', async ($2: any, e: any, next: any) => {
    toasts.push(e.text)
    return next(e)
  })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })
  await ui.press({ key: 'whale-tab-settings' })

  // 默认关；点一下开启，提示要说清楚它干什么。
  await ui.press({ key: 'whale-turn-cost' })
  expect(toasts.some(text => text.includes('轮次费用提示') && text.includes('已开启'))).toBe(true)
  expect(toasts.some(text => text.includes('每轮结束时弹一次'))).toBe(true)

  // 再点一次关掉，提示要说「已关闭」，且不再带开启那句解释。
  await ui.press({ key: 'whale-turn-cost' })
  expect(toasts.some(text => text.includes('轮次费用提示') && text.includes('已关闭'))).toBe(true)

  await ui.unmount()
})

/**
 * 最后一个口径不能被取消掉，但那次点击也不能静默消失。
 *
 * 回归：`if (next.length === 0) return` 什么都不做，读者点了一下、界面纹丝
 * 不动，也没有任何解释——看起来像按钮坏了。现在给一句 toast。
 */
test('取消最后一个口径时给出提示，而不是静默无视', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  // `ui.toast` 是一个可监听事件：挂个钩子把它记下来。
  const toasts: string[] = []
  on('ui.toast', async ($2: any, e: any, next: any) => {
    toasts.push(e.text)
    return next(e)
  })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })
  await ui.press({ key: 'whale-tab-settings' })

  const textProps = async (key: string): Promise<any> => {
    const found: any = await ui.find({ key })
    const kids = found?.children ?? []
    return kids.find((kid: any) => kid && typeof kid === 'object')?.props
  }

  // 默认只有「额度窗口」一个口径开着；再点它就是要取消到 0 项。
  expect((await textProps('whale-metric-window')).bold).toBe(true)
  await ui.press({ key: 'whale-metric-window' })
  // 它必须仍然亮着——点击被拒绝了。
  expect((await textProps('whale-metric-window')).bold).toBe(true)
  // 而且要说一声，不能静默。
  expect(toasts.some(text => text.includes('至少要留一项'))).toBe(true)

  await ui.unmount()
})

/**
 * 用量条：摘要 + 面板入口 + **左侧巡游的小鲸鱼**。
 *
 * 早先这里断言「不画任何形象」（`expect(find({type:'Svg'})).toBeUndefined()`），
 * 那是旧设计——条子当时只做摘要。现在用户要的是「在用量条界面空白处来回
 * 游」，左侧那片空白正是它的跑道。断言因此反过来：**桌面端必须有 Svg**，
 * 且它落在跑道里（`whale-band-swim`），不是挤在摘要边上。
 */
test('输入框上方用量条：摘要在右，小鲸鱼在左侧跑道里', async ($, on) => {
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

  expect(await ui.find({ key: 'whale-band' })).toBeDefined()
  expect(await ui.find({ key: 'whale-open' })).toBeDefined()

  // 鲸鱼真的画了，而且只画鲸鱼本体——不画气泡（一行高的条子放不下气泡文字）。
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  const source = String(svg?.props?.source ?? '')
  expect(source).not.toContain('<ellipse') // 气泡的大椭圆
  // 但鲸鱼位图在。
  expect(source).toContain('<image')
  // 尺寸：宽 44px、高严格按画布比例（否则 preserveAspectRatio 留白，条子被撑高）。
  expect(Number(svg?.props?.width)).toBe(44)
  expect(Math.abs(Number(svg?.props?.height) - 44 * (320 / 620))).toBeLessThan(0.5)

  // 跑道存在，鲸鱼在跑道里，不在外面。
  const swim = await ui.find({ key: 'whale-band-swim' })
  expect(swim).toBeDefined()
  expect(await ui.find({ key: 'whale-band-spacer' })).toBeDefined()

  await ui.unmount()
})

/**
 * 巡游：推进时钟，跑道里的鲸鱼 `marginLeft` 变大（向右挪）。
 *
 * **不断言「推 6 秒正好走 3 步」。** `mock.clock.advance` 只是把时钟拨到
 * 未来，**不会逐拍触发** `clock.every`——真实会话里那 6 秒内有 3 次定时
 * 重绘，测试里只有测试自己调的那几次 `redraw()`。断言「拨过去之后位置
 * 变大了、且越拨越大」就够：这守的是「位移由时钟驱动」这一点，而不是
 * 时钟推进的实现细节。
 */
test('用量条的鲸鱼会随时间向右挪动', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
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

  /** 跑道里包着鲸鱼的那个 Box 的 `marginLeft`。 */
  const offsetOf = async (): Promise<number> => {
    const swim = await ui.find({ key: 'whale-band-swim' }) as any
    const inner = swim?.children?.[0]
    return Number(inner?.props?.marginLeft ?? 0)
  }

  const start = await offsetOf()
  expect(start).toBe(0) // 整点相位 0：贴左端起步

  await clock.advance(6_000)
  await ui.redraw()
  const later = await offsetOf()
  expect(later).toBeGreaterThan(start)

  await clock.advance(6_000)
  await ui.redraw()
  expect(await offsetOf()).toBeGreaterThan(later)

  // 位移是 2 列的整数倍（`BAND_SWIM_STEP_COLS`），不是随便一个数。
  expect(later % 2).toBe(0)

  await ui.unmount()
})

test('终端上用量条没有 Svg，退化成字符鲸鱼', async ($, on) => {
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
  // 终端元素表里没有 Svg，鲸鱼退化成文字。
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toMatch(/🐳|🐋|✦|·|鲸/)

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

/**
 * 「本会话花费」优先用插件价目表，而不是引擎 `/cost`。
 *
 * 回归：面板与用量条这一格早先取引擎 `/cost` 的会话累计，而引擎只认自己
 * 的价目表；遇到第三方网关的模型名（`deepseek-v4-flash` 之类）就按
 * **默认模型的价格**估——引擎源码对这个字段的原话是 "costUSD is a guess
 * at the default model's rate"。实测同一个会话，DeepSeek Flash 按官方价
 * 约 $3，引擎估成 $258.98，而「用量概览」里跨 30 天的总额才十几美元。
 *
 * 现在逐模型累加插件价目表算出的 `cost`；只有某一款模型未收录价格时才
 * 退回引擎读数，并挂一句「按默认模型价估」。
 *
 * 这条测试走一遍真实的 `turn.complete`：本轮用一个**插件价目表里有价**的
 * 第三方模型，断言面板显示的是插件算出的数（约 $0.0002），而不是引擎
 * 报的 $231.5。
 */
test('本会话花费用插件价目表算，不用引擎 /cost 的估值', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  // 引擎侧：一个 DeepSeek 会话，`/cost` 报了两百多美元。
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.usage', async () => ({
    value: {
      rateLimits: [],
      cost: { usd: 231.5 },
      context: { window: 200_000, percent: 30 },
    },
  } as never))

  await $.turn.complete({
    answer: '',
    durationMs: 1_000,
    isAborted: false,
    turnId: 'turn-1',
    usage: {
      model: 'deepseek-v4-flash',
      input_tokens: 1_000,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    reason: 'answer',
  } as never)

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })

  const tree = JSON.stringify(await ui.drawn())
  // 插件价目表：DeepSeek Flash 输入 $0.15/M、输出 $0.60/M。
  // 1000 × 0.15/1e6 + 10 × 0.60/1e6 = $0.000156 → $0.0002。
  expect(tree).toContain('≈$0.0002')
  // 引擎那个离谱读数不该出现。
  expect(tree).not.toContain('231.5')
  // 有插件价就不需要那句免责说明。
  expect(tree).not.toContain('含引擎未收录的模型')

  await ui.unmount()
})

/**
 * 反过来：某一款模型**插件价目表也没收录**时，退回引擎读数并挂免责说明。
 *
 * 那种情况下插件算不出完整的花费，少算一笔比显示一个偏高的估值更糟。
 * 免责说明让读者知道这个数是引擎按默认模型估的，不是账单。
 */
test('插件价目表也没收录时，退回引擎读数并挂免责说明', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.usage', async () => ({
    value: { rateLimits: [], cost: { usd: 1.25 }, context: { window: 200_000, percent: 30 } },
  } as never))

  await $.turn.complete({
    answer: '',
    durationMs: 1_000,
    isAborted: false,
    turnId: 'turn-1',
    usage: {
      // 插件价目表里没有这一款。
      model: 'some-unknown-gateway-model',
      input_tokens: 1_000,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    reason: 'answer',
  } as never)

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })

  const tree = JSON.stringify(await ui.drawn())
  // 退回引擎读数，并说明它是估的。
  expect(tree).toContain('≈$1.25')
  expect(tree).toContain('含引擎未收录的模型')

  await ui.unmount()
})
