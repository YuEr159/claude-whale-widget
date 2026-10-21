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

/**
 * 鲸鱼的自动收起定时器，每次点击都要接管上一次的。
 *
 * 回归：以前每次点击都新起一个 4 秒定时器、从不取消前一个，而定时器到点时
 * 只看「此刻 `isBubbleOpen` 是不是真」，不看「这次展开是不是我负责的那一次」。
 * 于是「展开 → 收起 → 再展开」之后，第一次留下的定时器仍会按它自己的节奏
 * 到点，把第二次展开的气泡提前关掉——点得越快越容易撞上。
 *
 * 现在点击时先 `cancel()` 掉上一轮的两个定时器。这条测试用假时钟逐步推进，
 * 验证「第二次展开的存活时间」是完整的 4 秒。
 */
test('连点鲸鱼时，旧的自动收起定时器不会提前关掉新展开的气泡', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 100, rows: 40 },
  })

  /** 鲸鱼当前画的是展开还是收起的气泡。 */
  const bubbleOpen = async (): Promise<boolean> => {
    const svg = findLastSvg(await ui.drawn())
    // 展开时画三个椭圆（气泡 + 两个小泡），收起时一个都没有。
    const ellipses = ((svg?.props?.source ?? '').match(/<ellipse/g) || []).length
    return ellipses >= 3
  }

  // t=0 展开。
  await ui.press({ key: 'whale-tap' })
  await clock.advance(0)
  expect(await bubbleOpen()).toBe(true)

  // t=1s 收起。
  await clock.advance(1_000)
  await ui.press({ key: 'whale-tap' })
  await clock.advance(0)
  expect(await bubbleOpen()).toBe(false)

  // t=2s 再展开：这一次的 4 秒应当从此刻算起，到 t=6s 才收起。
  await clock.advance(1_000)
  await ui.press({ key: 'whale-tap' })
  await clock.advance(0)
  expect(await bubbleOpen()).toBe(true)

  // t=4s：正是第一次点击那个定时器本该到点的时刻。修好之后它已经被取消，
  // 气泡必须还开着。
  await clock.advance(2_000)
  expect(await bubbleOpen()).toBe(true)

  // t=6s：第二次展开满 4 秒，正常收起。
  await clock.advance(2_000)
  expect(await bubbleOpen()).toBe(false)

  await ui.unmount()
})

/**
 * 鲸鱼上不许出现任何文字——点击层不能带 `label`。
 *
 * 回归：这层按钮原本同时给了 `label`（跟着开合状态变「展开 / 收起小鲸鱼
 * 摘要」）和 children（一整块盲文空白，用来撑出点击区）。终端那份渲染器
 * 在按钮有 children 时不画 label；但**桌面端把 Button 画成原生按钮**，
 * 引擎文档的原话是 "A desktop draws its native button either way"——
 * `plain` 也拦不住。于是「展开小鲸鱼摘要」七个字直接压在鲸鱼身上。
 *
 * 这一层的唯一作用是提供点击区，视觉上必须是空的。控件以
 * `key="whale-tap"` 寻址，不靠 label。
 */
test('鲸鱼点击层不带 label：桌面端会把 label 画成按钮文字', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 100, rows: 40 },
  })

  /** 顺着树找 `whale-tap` 那个 Button，返回它**画出来的** props。 */
  const tapProps = async (): Promise<any> => {
    const find = (node: any): any => {
      if (!node || typeof node !== 'object') return undefined
      if (node.type === 'Button' && node.props?.key === 'whale-tap') return node.props
      for (const kid of node.children ?? []) {
        const hit = find(kid)
        if (hit) return hit
      }
      return undefined
    }
    return find(await ui.drawn())
  }

  // 关键：`ui.find` / `ui.drawn()` 都会把 children 的文字回填成 `label`
  // （引擎文档：「absent, it is the children's text」）。所以这里不断言
  // label 不存在，而是断言它**没有可见文字**：children 全是 U+2800 盲文
  // 空白，即便桌面端把它当按钮文字画出来，也是一片空白。
  //
  // 这正是不传 label 的目测效果，也守得住回归：一旦把「展开小鲸鱼摘要」
  // 写回 label，这串字就会留在 props 里，断言立刻变红。
  const onlyBlank = (text: string): boolean =>
    text.replace(/[\s⠀]/gu, '').length === 0

  const tap = await tapProps()
  expect(tap).toBeDefined()
  expect(onlyBlank(String(tap.label ?? ''))).toBe(true)

  // 开合切换不该改变这个控件，它始终只是一层透明的点击区。
  await ui.press({ key: 'whale-tap' })
  expect(onlyBlank(String((await tapProps()).label ?? ''))).toBe(true)

  await ui.unmount()
})

/**
 * 指针点鲸鱼要能开泡泡——而且要点在鲸鱼的**肚子**上，不是顶端那一行。
 *
 * 回归：以前点击区是一个 `Button`。桌面端把 `Button` 画成原生按钮，命中区
 * 在纵向恒为一行文字高（实测），children 写几行都撑不高它——点鲸鱼下半截
 * 没反应。现在盖的是一整片 `Client` 区域，`onPointer` 收到区域内的格坐标。
 */
test('指针点在鲸鱼中部也能开泡泡', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  const bubbleOpen = async (): Promise<boolean> => {
    const svg = findLastSvg(await ui.drawn())
    return String(svg?.props?.source ?? '').includes('<ellipse')
  }

  expect(await bubbleOpen()).toBe(false)

  // 点击区的尺寸交给父容器：`100% × 100%`，不再按像素反算格数。
  const area = await ui.find({ key: 'whale-tap-area' })
  expect(area).toBeDefined()
  expect((area?.props as any)?.height).toBe('100%')
  expect((area?.props as any)?.width).toBe('100%')

  // 布局好之后点正中间——正是旧实现够不着的地方。
  await (ui as any).resize({ columns: 43, rows: 10, in: 'whale-tap-area' })
  await ui.pointer({ type: 'down', x: 21, y: 5, button: 'left' })
  await ui.pointer({ type: 'up', x: 21, y: 5, button: 'left' })
  expect(await bubbleOpen()).toBe(true)

  // 再点一下同一处就收回去。
  await ui.pointer({ type: 'down', x: 21, y: 5, button: 'left' })
  await ui.pointer({ type: 'up', x: 21, y: 5, button: 'left' })
  expect(await bubbleOpen()).toBe(false)

  // **下沿**：最后一行同样要点得中。这是这次修的 bug——以前点击区的
  // 行数按像素估，估少了下沿就落空。
  await ui.pointer({ type: 'down', x: 21, y: 9, button: 'left' })
  await ui.pointer({ type: 'up', x: 21, y: 9, button: 'left' })
  expect(await bubbleOpen()).toBe(true)

  await ui.unmount()
})

/**
 * 点击区必须**脱流**盖在立绘上，否则会跑到鲸鱼旁边或上方。
 *
 * 回归：`Client` 曾是 `Svg` 的普通兄弟节点，留在流里就各占一块——实测
 * 看到的是「点击区在鲸鱼上方，而且只有一行」。测试宿主不做布局（文档原话
 * 「never a surface's paint」），所以这里守的是**结构契约**：从点击区往上
 * 找，最近的定位祖先必须是 `position="absolute"`，且它的原点是 (0,0)。
 *
 * 同时守 `Client` 自己那块的高度：`whale-tap.tsx` 里如果漏了
 * `flexDirection: 'column'`，区块内容会排成一行——区域就塌成一条。
 */
test('点击区绝对定位盖在鲸鱼上，且自己那块是二维的', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  const tree: any = await ui.drawn()

  /** 找到节点并返回它到根的路径（含自身）。 */
  const pathTo = (node: any, key: string): any[] | undefined => {
    if (!node || typeof node !== 'object') return undefined
    if (node.props?.key === key) return [node]
    for (const kid of node.children ?? []) {
      const sub = pathTo(kid, key)
      if (sub) return [node, ...sub]
    }
    return undefined
  }

  const areaPath = pathTo(tree, 'whale-tap-area')
  expect(areaPath).toBeDefined()

  // `Client` 自己必须是绝对定位、原点对齐——不能留在流里跟 `Svg` 并排。
  const client = areaPath![areaPath!.length - 1]
  expect(client.type).toBe('Client')

  // 往上找那个给它定位的 Box：最近的一个带 `position` 的祖先。
  const ancestors = areaPath!.slice(0, -1).reverse()
  const positioned = ancestors.find(n => n.props?.position !== undefined)
  expect(positioned).toBeDefined()
  expect(positioned!.props.position).toBe('absolute')
  expect(positioned!.props.top).toBe(0)
  expect(positioned!.props.left).toBe(0)

  // 尺寸交给父容器：`100%`，不是按像素估出来的格数。这是这次修的 bug——
  // 估出来的行数常常短于图片实际高度，下沿点不中。
  expect(client.props.height).toBe('100%')
  expect(client.props.width).toBe('100%')

  // 区域自己那块要按**布局后的**行列铺开（`surface.columns` / `rows`），
  // 且必须是 column——漏 `flexDirection: 'column'` 时这里会是一行。
  await (ui as any).resize({ columns: 43, rows: 10, in: 'whale-tap-area' })
  const inner: any = await (ui as any).drawn({ in: 'whale-tap-area' })
  expect(inner?.props?.flexDirection).toBe('column')
  const rows = (inner?.children ?? []) as any[]
  expect(rows.length).toBe(10)
  for (const row of rows) {
    expect([...(row?.children?.[0] ?? '')].length).toBe(43)
  }

  await ui.unmount()
})

/**
 * 鲸鱼的键盘/点击按钮在任何表面上都得在。
 *
 * 终端不画 SVG，鲸鱼退化成一个表情，开合在树上没有可读的痕迹；所以这里
 * 守的是**结构契约**：`whale-tap` 这个按钮仍在、仍是 `plain`、仍能按下。
 * 「按下之后做什么」由 `tapWhale` 一份实现负责，桌面端的指针测试覆盖了它。
 */
test('终端上仍保留鲸鱼的键盘/点击按钮', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  const button = await ui.find({ key: 'whale-tap' })
  expect(button).toBeDefined()
  expect((button?.props as any)?.plain).toBe(true)
  // 按下不抛错，说明 onPress 接上了真正的实现。
  await expect(ui.press({ key: 'whale-tap' })).resolves.toBeDefined()

  await ui.unmount()
})
