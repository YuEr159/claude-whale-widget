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
  // **固定 380px，不随面板宽度变化。** 早先这里只断言 `>= 150`——尺寸算错到
  // 160 也能过。默认档位 100%，面板 100 列足够宽，就该是基准值本身。
  expect(Number(svg?.props?.width)).toBe(380)
  // 高度严格按画布比例，否则 `preserveAspectRatio` 会留白并上下居中。
  expect(Math.abs(Number(svg?.props?.height) - 380 * (320 / 620))).toBeLessThan(0.01)

  await ui.unmount()
})

/**
 * 设置页的「立绘大小」档位真的改变鲸鱼尺寸。
 *
 * 引擎没有滑块控件，档位按钮就是这里的「拖动条」。这条测试守的是
 * 「点了档位，画出来的 Svg 宽度确实跟着变」——只改状态、不改渲染，
 * 读者点上去会觉得按钮坏了。
 */
test('设置页的立绘档位会改变鲸鱼尺寸', async ($, on) => {
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

  const whaleWidth = async (): Promise<number> => {
    const svg = findLastSvg(await ui.drawn())
    return Number(svg?.props?.width ?? 0)
  }

  const base = await whaleWidth()
  expect(base).toBeGreaterThan(0)

  // 切到设置页，把比例调到最小档，鲸鱼必须变小。
  await ui.press({ key: 'whale-tab-settings' })
  await ui.press({ key: 'whale-scale-0.25' })
  await ui.redraw()
  const small = await whaleWidth()
  expect(small).toBeLessThan(base)
  expect(Math.abs(small - base * 0.25)).toBeLessThan(1)

  // 调到最大档，必须比默认大。
  await ui.press({ key: 'whale-scale-2' })
  await ui.redraw()
  const large = await whaleWidth()
  expect(large).toBeGreaterThan(base)
  expect(Math.abs(large - base * 2)).toBeLessThan(1)

  await ui.unmount()
})

/**
 * 200% 档在**窄面板**上必须收住，不能溢出被裁掉。
 *
 * `whaleSizeFor` 只把基准尺寸收在可用宽度以内（≤380px），乘上档位之后就
 * 不管了。80 列面板只有约 632px 可用，200% 是 760px——多出的 128px 会被
 * 引擎直接裁掉（`overflow` 只有 visible / hidden，没有滚动），鲸鱼只剩
 * 左半边。这条测试守「缩放之后再夹一次」。
 */
test('窄面板上的 200% 立绘不会溢出可用宽度', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const columns = 60
  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(columns),
    viewport: { columns: 120, rows: 40 },
  })

  await ui.press({ key: 'whale-tab-settings' })
  await ui.press({ key: 'whale-scale-2' })
  await ui.redraw()

  const svg = findLastSvg(await ui.drawn())
  const w = Number(svg?.props?.width ?? 0)
  // 一列约 8px，留一格余量——与 `whaleSizeFor` 的可用宽度算法一致。
  const available = (columns - 1) * 8
  expect(w).toBeGreaterThan(0)
  expect(w).toBeLessThanOrEqual(available + 0.5)
  // 高度必须严格按画布比例，否则 `preserveAspectRatio` 会留白抖动。
  expect(Math.abs(Number(svg?.props?.height) - w * (320 / 620))).toBeLessThan(0.5)

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

/**
 * 泡泡**常驻**：打开面板就该看到气泡，不需要点。
 *
 * 这替代了原来「点鲸鱼才展开」的交互——点击区在引擎里没法精确对齐立绘
 * （`Svg` 按 CSS 像素布局、`Box` 按字符格布局，两者之间没有换算），
 * 与其留一个「点鲸鱼底部没反应」的死角，不如把数字直接画出来。
 */
test('泡泡常驻：一打开就有气泡，不需要点', async ($, on) => {
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

  const svg = findLastSvg(await ui.drawn())
  const source = String(svg?.props?.source ?? '')
  expect(source).toContain('<ellipse')
  expect(source).toContain('<image')

  await ui.unmount()
})

/**
 * 面板鲸鱼**不浮动**：相邻两次重绘的 SVG 源必须逐字节相同。
 *
 * ## 这条守的是什么
 *
 * 用量条为了「z 一个字母一个字母蹦出来」，每 200ms 调一次
 * `$.ui.invalidate('ui.render')`。而引擎的 `invalidate` 会重绘**本插件能画的
 * 所有实例**（类型声明原文：*every instance of its component*）——面板被一起
 * 绑上。
 *
 * 面板里的 `<Svg>` 不传 `isInteractive`（传了会走沙箱 iframe，画不出内嵌
 * 位图），桌面端因此按静态图片画，SMIL 不跑。浮动只能靠每次重绘把
 * `now - epoch` 写进 `begin` 的负偏移——于是相位每 200ms 前进一段，`source`
 * 每次都是新字符串，引擎重新解码重绘。3.6 秒、±4px 的浮动被切成 18 段，
 * 肉眼看到的是高频抖动。
 *
 * 修法是面板直接传 `isAnimating: false`：`animateTransform` 根本不写进文档，
 * 只随台词与配色变。这条测试把「不写动画」和「源稳定」两件事都钉住。
 */
test('面板鲸鱼不浮动：不写 animateTransform，重绘之间源不变', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  // 停掉轮播的数据源，让两次重绘之间唯一可能变的就是相位——正是要测的那个。
  on('session.usage', (async () => ({ value: undefined })) as never)

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  const sourceAt = async (): Promise<string> =>
    String(findLastSvg(await ui.drawn())?.props?.source ?? '')

  // 200ms 一拍，正是用量条那条时钟的节拍。
  const frames: string[] = []
  for (let step = 0; step < 5; step += 1) {
    await clock.set(Date.parse('2026-10-20T12:00:00Z') + step * 200)
    await ui.redraw()
    frames.push(await sourceAt())
  }

  // **不要有动画标签。** 有它就意味着这一帧是按 `begin` 定格的，会在重绘时跳。
  for (const frame of frames) {
    expect(frame).not.toContain('animateTransform')
    expect(frame).not.toContain('begin=')
  }
  // **五帧逐字节相同**：引擎判等后不会重新解码重绘。
  expect(new Set(frames).size).toBe(1)
  expect(frames[0]!.length).toBeGreaterThan(0)

  await ui.unmount()
})

/**
 * 泡泡内容会轮播：不同时刻画出的文字不同。
 *
 * 页号由时钟算（`floor(now / BUBBLE_PAGE_MS) % pages.length`），所以推进
 * 假时钟就能翻页——不需要任何点击或状态写入。
 */
test('泡泡内容按时钟轮播，几页之间会换', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  // 测试环境没有 session.usage 的实现。给足额度与上下文，轮播才有几页可翻
  // ——数据全空时只有「本会话花费」一页，翻不动（那是对的，不是 bug）。
  on(
    'session.usage',
    (async () => ({
      value: {
        rateLimits: [
          { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-20T14:13:00Z' },
          { kind: 'seven_day', percentUsed: 61 },
        ],
        cost: { usd: 2.5 },
        context: { tokens: 84_000, window: 200_000, percent: 42 },
      },
    })) as never,
  )

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 120, rows: 40 },
  })

  /**
   * 鲸鱼 SVG 里画出来的**第一行**文字——这一页的标题。
   *
   * 不能拿整段文字当判据：额度页的第三行是倒计时（`2h13m 后重置`），
   * 时钟一走它就变，「绕回同一页」永远比对不上。标题才是稳定的页标识。
   */
  const bubbleTitle = async (): Promise<string> => {
    const source = String(findLastSvg(await ui.drawn())?.props?.source ?? '')
    const hit = source.match(/>([^<>]+)<\/text>/)
    return hit ? hit[1]! : ''
  }

  const first = await bubbleTitle()
  expect(first.length).toBeGreaterThan(0)

  // 推进两个换页间隔再重绘一次。
  //
  // **`advance` 只动测试侧的时钟，不会自己触发绘制**——`drawn()` 读的是
  // 上一次绘制的结果。真实会话里是 `$.clock.every(BUBBLE_PAGE_MS, …)` 去
  // `$.ui.invalidate` 推动重绘；测试里 `mock.clock` 不跑那条链，所以要显式
  // `redraw()`。这里断的是「同一个面板在不同时刻画出的内容不同」，不是
  // 「定时器有没有触发」。
  await clock.advance(12_000)
  await ui.redraw()
  const later = await bubbleTitle()
  expect(later.length).toBeGreaterThan(0)
  expect(later).not.toBe(first)

  // 绕回同一页：页数有限（最多四页），转一圈必然回到第一页。
  let cameBack = false
  for (let i = 0; i < 6; i++) {
    await clock.advance(6_000)
    await ui.redraw()
    if ((await bubbleTitle()) === first) {
      cameBack = true
      break
    }
  }
  expect(cameBack).toBe(true)

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
 * 情绪按**一天里的钟点**走：同一份数据、不同的时刻，画出的台词与配色不同。
 *
 * 这是「情绪不再和额度相关」的端到端验证。只断 `moodOf` 的返回值不够——
 * 那条纯函数测试全绿、渲染层却仍拿额度算情绪，用户看到的还是老样子。
 *
 * 做法：让 `session.usage` 返回空，气泡只剩人设页（它永远在），于是
 * 第一行文字就是这一档的台词，不会被别的页混进来。
 */
test('同一天的不同钟点画出不同的人设台词', async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2026, 9, 22, 0, 0, 0).getTime() })
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

  /**
   * 把时钟拨到本地时间 `hour` 点，逐页扫一遍气泡，取人设页的第一行。
   *
   * 人设页永远排在最后，但前面还有几页取决于当场的数据：`session.usage`
   * 返回空时「额度」「上下文」两页不出现，而「本会话花费」因为 `totals`
   * 总有零值仍然在。所以不能假设人设页是第一个，得按换页间隔走一圈。
   */
  const traitAt = async (hour: number): Promise<string> => {
    const start = new Date(2026, 9, 22, hour, 0, 0).getTime()
    await clock.set(start)
    let line = ''
    for (let page = 0; page < 8; page++) {
      await clock.set(start + page * 6000)
      await ui.redraw()
      const source = String(findLastSvg(await ui.drawn())?.props?.source ?? '')
      const title = source.match(/>([^<>]+)<\/text>/)?.[1] ?? ''
      // 人设页的五档第一行是固定的这几句；命中即返回。
      if (['探索未至之境', '内心 OS 很长', '胃口特别大', '活没干完', 'DeepSleep'].includes(title)) {
        line = title
        break
      }
    }
    return line
  }

  // 深夜、上午、午饭、夜里——四档各取一句。
  const deepNight = await traitAt(3)
  const morning = await traitAt(10)
  const lunch = await traitAt(12)
  const evening = await traitAt(22)

  expect(deepNight).toBe('DeepSleep')
  expect(morning).toBe('内心 OS 很长')
  expect(lunch).toBe('胃口特别大')
  expect(evening).toBe('活没干完')

  // 四句互不相同：这不是一个常数。
  expect(new Set([deepNight, morning, lunch, evening]).size).toBe(4)

  await ui.unmount()
})

/**
 * 各档面板宽度下，鲸鱼都画得出来、比例正确、数据区不是空的。
 *
 * 桌面端 3.x 把右侧栏重新排过，停靠宽度随窗口变化。鲸鱼宽度是固定的
 * 380px，不随面板变；早期测试只覆盖了 100 列和 60 列两档，中间这一段
 * 「宽到能放下、又不算极窄」的区间没有覆盖——而它正是新版侧栏最常落到的
 * 范围。这里把 110 / 140 / 180 三档钉住，任何一档画不出内容、比例算错
 * 或鲸鱼超宽都会变红。
 */
for (const cols of [110, 140, 180]) {
  test(`停靠面板 ${cols} 列：鲸鱼 380px、比例正确、数据区非空`, async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
    mock.env(on, { HOME: 'C:/Users/test' })

    const ui = await $.ui.mount({
      plugin: 'whale-usage',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'whale',
      props: props(cols),
      viewport: { columns: cols + 80, rows: 50 },
    })

    const tree = await ui.drawn() as any
    const svgs = findSvgs(tree)
    const whale = svgs[svgs.length - 1]
    expect(Number(whale?.props?.width)).toBe(380)
    expect(Math.abs(Number(whale?.props?.height) - 380 * (320 / 620))).toBeLessThan(0.5)

    // 数据区真的画了字，不是一张只有鲸鱼的空白页。
    expect(JSON.stringify(tree).length).toBeGreaterThan(2000)

    await ui.unmount()
  })
}

/**
 * 内联面板不撑满高度，鲸鱼按可用宽度收窄。
 *
 * `minHeight` 只对停靠面板给（内联面板的高度由内容决定），这条守的是
 * 「判断条件别写反」——写反了内联面板会多出一条空白，鲸鱼被推到看不见的地方。
 */
test('内联面板不撑高，鲸鱼按可用宽度收窄', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: { ...props(40), placement: 'inline' as const },
    viewport: { columns: 60, rows: 50 },
  })

  const tree = await ui.drawn() as any
  expect(tree.props.minHeight).toBeUndefined()

  const svgs = findSvgs(tree)
  const width = Number(svgs[svgs.length - 1]?.props?.width ?? 0)
  expect(width).toBeGreaterThan(0)
  expect(width).toBeLessThanOrEqual((40 - 1) * 8 + 0.5)

  await ui.unmount()
})

/** 收集树里所有 Svg，鲸鱼是最后一个。 */
function findSvgs(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'Svg') out.push(node)
  for (const kid of node.children ?? []) findSvgs(kid, out)
  return out
}

/**
 * 面板里的鲸鱼**恒贴右端**，不随刷新漂移。
 *
 * 曾经这里做低频巡游：`marginRight` 按三角波每 6 秒向内挪三列。问题是面板
 * 每 30 秒自动重绘一次，读者看到的是「鲸鱼每次刷新都往中间走一点、回不去」
 * ——一个本该固定在右下角的立绘变成了会漂的东西。巡游的收益只是「看起来
 * 活着」，而挂件本来就靠数据刷新证明自己活着；代价是位置不可预期。
 *
 * 这条守的是「不管时钟走到哪儿，`marginRight` 都不存在」——没有 margin，
 * 鲸鱼就只能贴着 `justifyContent: flex-end` 的右端。
 */
test('面板鲸鱼恒贴右端：推进时钟也不改位置', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  const rightEdge = async () => {
    const tree = await ui.drawn() as any
    const kids = tree.children ?? []
    const last = kids[kids.length - 1]
    // 靠右对齐靠的是 justifyContent，不是 margin。
    expect(last?.props?.justifyContent).toBe('flex-end')
    const inner = last?.children?.[0]
    expect(inner?.props?.marginRight).toBeUndefined()
    expect(inner?.props?.marginLeft).toBeUndefined()
  }

  await rightEdge()
  await clock.advance(6_000)
  await ui.redraw()
  await rightEdge()
  await clock.advance(6_000)
  await ui.redraw()
  await rightEdge()
  await clock.advance(60_000)
  await ui.redraw()
  await rightEdge()

  await ui.unmount()
})

/**
 * 窄面板同样是鲸鱼贴右端。
 *
 * 巡游取消后这条不再测「余量不足不游」，而是测「窄面板下也没有任何边距」——
 * 立绘被夹取到可用宽度以内，靠 `justifyContent: flex-end` 贴右。
 */
test('窄面板（40 列）鲸鱼同样贴右端，无边距', async ($, on) => {
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
  const kids = tree.children ?? []
  const last = kids[kids.length - 1]
  expect(last?.props?.justifyContent).toBe('flex-end')
  const inner = last?.children?.[0]
  expect(inner?.props?.marginRight).toBeUndefined()

  await ui.unmount()
})

/**
 * 终端面板不画 Svg，退化成一个字符。
 *
 * 这条守的是一个真实缺陷：终端元素表在**测试宿主**里带着 `Svg`，靠
 * `'Svg' in table` 探测会走进 Svg 分支、渲染成空——真人终端上整幅图消失。
 * 判断必须按 `e.surface`，不按元素表。
 */
test('终端面板不画 Svg，退化成字符', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'whale',
    props: props(100),
    viewport: { columns: 100, rows: 40 },
  })

  const tree = await ui.drawn() as any
  const svgs = findSvgs(tree)
  expect(svgs.length).toBe(0)
  // 鲸鱼槽仍在（只是退化成字符），不是整块空掉。
  expect(JSON.stringify(tree)).toMatch(/🐳|🐋|💤/)

  await ui.unmount()
})

/**
 * 视觉纪律的三条**可机器校验**的规则（见 `DESIGN-PROMPT.md`）。
 *
 * 审美本身没法自动验，但「层级用得对不对」大部分可以：遍历整棵树，
 * 检查每个 Text 的样式组合。这三条正是这个项目已经犯过的错误。
 */
function collectTexts(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'Text') out.push(node)
  for (const kid of node.children ?? []) collectTexts(kid, out)
  return out
}

test('视觉纪律：每个 Text 只用一档层级，不同时 bold 又 dimColor', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  // 四个页签都过一遍——模型页那个「逐模型用量」标题就是这么错的。
  for (const tab of ['overview', 'context', 'models', 'settings']) {
    await ui.press({ key: `whale-tab-${tab}` })
    const offenders: string[] = []
    for (const text of collectTexts(await ui.drawn())) {
      const p = text.props ?? {}
      if (p.bold && p.dimColor) {
        offenders.push(JSON.stringify(text.children ?? '').slice(0, 40))
      }
    }
    expect(offenders).toEqual([])
  }

  await ui.unmount()
})

test('视觉纪律：界面文字不出现纯装饰色', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  // 允许的颜色只有两类：
  //   1. 主题键（`text` / `inactive` / `claude` …）——它们由绘制端按用户的
  //      主题解析，深浅两套都正确，本来就不是写死的装饰色；
  //   2. 状态色：`warning`（越过阈值）、`diffAdded` / `diffRemoved`（增减）。
  // 写死十六进制的装饰色才是要禁的——那会在换主题时出错。
  const THEME_KEYS = new Set(['text', 'inactive', 'claude', 'warning', 'diffAdded', 'diffRemoved', 'success', 'error', 'suggestion', 'permission', 'secondary'])
  const page = await ui.drawn()
  const bad: string[] = []
  for (const text of collectTexts(page)) {
    const color = text.props?.color
    if (typeof color === 'string' && !THEME_KEYS.has(color)) {
      bad.push(`${color}:${JSON.stringify(text.children ?? '').slice(0, 30)}`)
    }
  }
  expect(bad).toEqual([])

  await ui.unmount()
})

/**
 * 六张卡的框必须**比外层大框暗一档**。
 *
 * 早先卡片框和外面那个大框是同一支色、同一档粗细，六张卡就成了六个跟
 * 容器平级的格子——读者分不清哪个是「这一页」哪个是「格子里的一条」。
 * 压暗一档之后层级是：外层框（主）> 卡片框（次）> 卡内文字。
 *
 * 这条守的是「卡片框真的带了 borderDimColor」，而不是「卡片存在」——
 * 后者早有别的用例管。
 */
test('概览卡片框比外层大框暗一档', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  /** 收集所有带圆角框的 Box。 */
  function collectBordered(node: any, out: any[] = []): any[] {
    if (!node || typeof node !== 'object') return out
    if (node.type === 'Box' && node.props?.borderStyle) out.push(node)
    for (const kid of node.children ?? []) collectBordered(kid, out)
    return out
  }

  const boxes = collectBordered(await ui.drawn())
  const dimmed = boxes.filter(b => b.props.borderDimColor)
  // 至少有一批卡片框是压暗的（六张卡），且不是全部——外层大框要保持原亮度。
  expect(dimmed.length).toBeGreaterThanOrEqual(6)
  expect(dimmed.length).toBeLessThan(boxes.length)

  await ui.unmount()
})

/**
 * 页内分组框都压暗一档（模型页的图框、表框，上下文页的图框）。
 *
 * 概览卡片早已压暗（上一条用例），但这三处漏了——它们和外层大框同色同
 * 粗细，读者看不出「这是页内的一块」。规则 6 的层级应当是：外层框（主）
 * > 页内分组框（次）> 内容。
 *
 * 用例从 `$.state.scan` 注入一份扫描数据：没有数据时模型页只画一句
 * 「还没有统计数据」，框根本不存在，断言会空过。
 */
const SCAN_FIXTURE = {
  isRunning: false,
  lastRunAt: Date.parse('2026-10-20T12:00:00Z'),
  error: undefined,
  data: {
    files: 1,
    overview: {
      sessions: 1, activeDays: 1, peakHour: 12, peakHourMessages: 3,
      favoriteModel: 'DeepSeek Flash', favoriteModelMessages: 3,
      totalMessages: 3, totalTokens: 2_100_000,
    },
    turnsDaily: [],
    modelDaily: [
      { day: '2026-10-20', models: [{ model: 'DeepSeek Flash', input: 1_000_000, output: 100_000, cost: 0.8 }] },
    ],
    windowDays: 30,
    today: { day: '2026-10-20', tokens: 1_100_000, messages: 3, sessions: 1, cost: 1 },
    total: { tokens: 1_100_000, messages: 3, sessions: 1, cost: 1 },
    daily: [],
    byModel: [
      { model: 'DeepSeek Flash', isPriced: true, input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, cost: 0.8, messages: 3 },
    ],
    skippedDuplicates: 0,
  },
}

test('模型页与上下文页的分组框都比外层大框暗一档', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  on('state.get', { plugin: 'whale-usage', key: 'scan' }, async (_$, e, next) => {
    void next
    return { value: { value: SCAN_FIXTURE, version: 1 } }
  })
  // 上下文页的图框只有「有逐轮数据」时才画；空列表时整页只有一句提示，
  // 框根本不存在，下面的断言会空过。
  on('state.get', { plugin: 'whale-usage', key: 'contextTurns' }, async (_$, e, next) => {
    void next
    return {
      value: {
        value: [{ seq: 1, percent: 42, tokens: 84_000, at: Date.parse('2026-10-20T11:00:00Z') }],
        version: 1,
      },
    }
  })
  // 上下文页的图框只有真画了图才存在，所以引擎读数也要给。
  // `on(...)` 必须在 `$.ui.mount` 之前——挂载之后注册的钩子不会被底下看到。
  on('session.usage', (async () => ({
    value: {
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [],
      cost: { usd: 1 },
    },
  })) as never)

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  function collectBordered(node: any, out: any[] = []): any[] {
    if (!node || typeof node !== 'object') return out
    if (node.type === 'Box' && node.props?.borderStyle) out.push(node)
    for (const kid of node.children ?? []) collectBordered(kid, out)
    return out
  }

  await ui.press({ key: 'whale-tab-models' })
  // 第一个带框的是页面外层大框（`userMessageBackground` 底），它要保持原
  // 亮度——层级是「外层框（主）> 页内分组框（次）」。只断言页内的那些。
  const dimmable = (list: any[]) => list.filter(b => b.props.backgroundColor !== 'userMessageBackground')
  const modelsBoxes = collectBordered(await ui.drawn())
  // 图框 + 表框都在，且都压暗了。
  expect(dimmable(modelsBoxes).length).toBeGreaterThanOrEqual(2)
  for (const box of dimmable(modelsBoxes)) expect(box.props.borderDimColor).toBe(true)

  // 上下文页的图框同理。
  await ui.press({ key: 'whale-tab-context' })
  const contextBoxes = dimmable(collectBordered(await ui.drawn()))
  expect(contextBoxes.length).toBeGreaterThanOrEqual(1)
  for (const box of contextBoxes) expect(box.props.borderDimColor).toBe(true)

  await ui.unmount()
})

/**
 * 模型页不再有图例行。
 *
 * 图例曾把「色块 + 模型名」列一遍，而正下方的明细表第一列说的是同一件事
 * （还多给了数字）。前 6 名的顺序与颜色在两处完全一致（同一个
 * `stack.models`、同一个排序键），所以那一行只是把同一份映射说了第二遍，
 * 按规则 5 删掉。这条守的是「别又加回来」。
 */
test('模型页没有图例行，颜色映射交给明细表的色块列', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  on('state.get', { plugin: 'whale-usage', key: 'scan' }, async (_$, e, next) => {
    void next
    return { value: { value: SCAN_FIXTURE, version: 1 } }
  })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  await ui.press({ key: 'whale-tab-models' })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('whale-mlegend')
  // 明细表的色块列还在——删的是图例，不是颜色映射本身。
  expect(tree).toContain('whale-mrow')

  await ui.unmount()
})

/**
 * 上下文页在**屏幕上**必须有读数。
 *
 * 这是这一页最大的问题：柱状图只有形状，轮数、峰值、压缩次数全写在 Svg 的
 * `<title>` 里——那是无障碍描述，引擎不会画在屏幕上。读者打开这一页看到的是
 * 一张图 + 一行图例，**一个数字都没有**。而「现在窗口被什么占着」恰恰是这一页
 * 唯一能回答、也最该回答的问题。
 *
 * 这条守三件事：
 *   1. 「最近一轮 xx%」与构成明细是可见的 `Text`（不是 Svg 里的 title）；
 *   2. 图注（最近 N 轮 · 峰值 xx%）可见；
 *   3. 图例里没有骨架段（已用 / 压缩缓冲 / 空闲）——它们已经在图注里说过。
 */
test('上下文页在屏幕上给出读数：最近一轮占比、构成明细、图注', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  on('state.get', { plugin: 'whale-usage', key: 'contextTurns' }, async (_$, e, next) => {
    void next
    return {
      value: {
        value: [
          { seq: 1, percent: 20, tokens: 40_000, at: 1, windowTokens: 200_000 },
          {
            seq: 2, percent: 42, tokens: 84_000, at: 2, windowTokens: 200_000,
            parts: [
              { name: 'Messages', kind: 'messages', tokens: 47_000 },
              { name: 'System prompt', kind: 'system', tokens: 12_000 },
            ],
          },
        ],
        version: 1,
      },
    }
  })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  await ui.press({ key: 'whale-tab-context' })
  const tree = await ui.drawn()

  /** 屏幕上真正会画出来的文字（不含 Svg 的 source / alt）。 */
  const visible: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Text') {
      for (const kid of node.children ?? []) {
        if (typeof kid === 'string') visible.push(kid)
        else walk(kid)
      }
      return
    }
    for (const kid of node.children ?? []) walk(kid)
  }
  walk(tree)
  const text = visible.join('')

  // 1. 这一页只留**图 + 图注 + 图例**，不再有逐轮明细表，也没有
  //    「最近一轮 xx% · 构成明细」那一行。
  //
  //    两次删减的理由不同：那一行只有最近一轮有构成、历史轮次没有，读者会
  //    误以为它是整页的图例；而明细表则是把「每轮涨了多少」这种可以扫一眼
  //    柱状图看出来的事，又用文字说了一遍——图上已经有纵轴刻度与横轴轮次，
  //    再列一张表是同一件事的第二次陈述。
  expect(text).not.toContain('最近一轮')
  // 明细表的列头（「窗口」单用会撞上页面顶部的「无额度窗口」）。
  expect(text).not.toContain('变化')

  // 2. 图注可见。轮数与峰值都要说出来——这是柱状图唯一的读数来源。
  expect(text).toContain('最近 2 轮')
  expect(text).toContain('峰值 42%')

  // 3. 图例里不该有骨架段。
  for (const skeleton of ['已用（无构成）', '压缩缓冲', '空闲']) {
    expect(text).not.toContain(skeleton)
  }
  // 分类图例仍然在：柱子里的颜色靠它解释。
  expect(text).toContain('系统提示')
  expect(text).toContain('对话消息')

  // 4. **这一页不再逐轮列数字。**
  //    图上纵轴已有刻度、横轴已有轮次，再列一张表就是把同一件事说第二遍。
  //    守门方式：明细表里每一行都以 `20%` / `42%` 这种**不带上下文**的读数
  //    开头；而图注里的读数是 `峰值 42%`、`最近 2 轮` 这种带标签的形态。
  //    所以只要「20%」出现（它只在明细表里，图注不提第二低的那轮）就说明
  //    表回来了。
  expect(text).not.toContain('20%')

  await ui.unmount()
})

/**
 * 老记录（没有 parts，也就没有分类构成）时，这一页仍然要正常渲染。
 *
 * 这一页现在只有图 + 图注 + 图例，没有明细表可以依赖；缺构成的老记录不该
 * 因此少一根柱子、或者让图例凭空多出分类。
 */
test('上下文页：老记录没有构成数据也能正常出图', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})
  on('state.get', { plugin: 'whale-usage', key: 'contextTurns' }, async (_$, e, next) => {
    void next
    return { value: { value: [{ seq: 1, percent: 20, tokens: 40_000, at: 1 }], version: 1 } }
  })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  await ui.press({ key: 'whale-tab-context' })
  const tree = await ui.drawn()
  const json = JSON.stringify(tree)

  // 已删掉的那一行不该回来。
  expect(json).not.toContain('最近一轮')
  // 图注仍在——它是这一屏的形状说明，与有没有 breakdown 无关。
  expect(json).toContain('最近 1 轮')
  // 没有构成就别画分类图例：列一堆解释不了任何东西的色块只是噪音。
  expect(json).not.toContain('对话消息')
  expect(json).not.toContain('系统提示')

  await ui.unmount()
})

/**
 * 「显示用量条」与五个口径必须在**同一组**里。
 *
 * 它们改的是同一件东西——输入框上方那条子：`isBandVisible` 决定它显不显示，
 * `bandMetrics` 决定显示哪几项。早先「显示用量条」被放在「面板」组里，与
 * 「轮次费用提示」并列，五个口径却在「用量条显示」组里——同一个对象的两个
 * 开关被拆成两组，读者会以为它们是两回事（而且组名里的「用量条」出现了两次，
 * 指的却是同一个东西）。
 *
 * 这条按**结构**断言：`whale-band-toggle` 与 `whale-metric-*` 必须共享同一个
 * 最近的 row-Box 祖先。
 */
test('设置页：显示开关与五个口径同属一组', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })
  await ui.press({ key: 'whale-tab-settings' })
  const tree = await ui.drawn() as any

  /** 找到某个 key 的按钮，返回它最近的 row-Box 祖先。 */
  function rowAncestorOf(node: any, key: string, row: any = null): any {
    if (!node || typeof node !== 'object') return undefined
    const isRow = node.type === 'Box' && node.props?.flexDirection === 'row'
    if (node.type === 'Button' && node.props?.key === key) return row
    for (const kid of node.children ?? []) {
      const found = rowAncestorOf(kid, key, isRow ? node : row)
      if (found !== undefined) return found
    }
    return undefined
  }

  const toggleRow = rowAncestorOf(tree, 'whale-band-toggle')
  expect(toggleRow).toBeDefined()
  for (const metric of ['window', 'cost', 'context', 'session', 'diff']) {
    const metricRow = rowAncestorOf(tree, `whale-metric-${metric}`)
    expect(metricRow).toBe(toggleRow)
  }

  // 「轮次费用提示」不在这一组里——它是另一件事（弹不弹提示），不是用量条。
  const costRow = rowAncestorOf(tree, 'whale-turn-cost')
  expect(costRow).not.toBe(toggleRow)

  await ui.unmount()
})

/**
 * 三组设置的标签列等宽，芯片起始位置对齐。
 *
 * 三组标签文字长度不同（用量条 6 / 面板 4 / 立绘大小 8）。不统一宽度时，
 * 每组芯片的起始位置都不一样，读起来像三张互不相干的表。
 */
test('设置页：三组标签列等宽，芯片起点对齐', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })
  await ui.press({ key: 'whale-tab-settings' })
  const tree = await ui.drawn() as any

  /** 收集三个设置组的行，返回每行第一个子 Box（标签列）的宽度。 */
  function settingsRows(node: any, out: any[] = []): any[] {
    if (!node || typeof node !== 'object') return out
    if (node.type === 'Box' && node.props?.flexDirection === 'row') {
      const kids = node.children ?? []
      if (kids.some((k: any) => k?.type === 'Box' && typeof k?.props?.width === 'number')) {
        out.push(node)
      }
    }
    for (const kid of node.children ?? []) settingsRows(kid, out)
    return out
  }

  const rows = settingsRows(tree)
  expect(rows.length).toBe(3)
  const widths = rows.map(row => (row.children ?? [])[0]?.props?.width)
  expect(new Set(widths).size).toBe(1)
  expect(widths[0]).toBeGreaterThanOrEqual(8)

  await ui.unmount()
})

/**
 * 设置页的每一组都装在自己的圆角框里。
 *
 * 三组设置（用量条 / 面板 / 立绘大小）说的是三件互不相干的事，只靠 `gap`
 * 分隔时读起来像一整片文字。加框之后每一组的边界是画出来的，读者一眼看得出
 * 「这是三件事」。
 *
 * 框的样式必须与页面其它分组框一致（`theme.inset` 底色 + `borderDimColor`），
 * 层级是「页面外框（主）> 分组框（次，压暗一档）> 内容」——这是全项目统一的
 * 两层结构，设置页不该自成一套。
 */
test('设置页：三组各有一个压暗的圆角分组框', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })
  mock.store(on, {})

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })
  await ui.press({ key: 'whale-tab-settings' })
  const tree = await ui.drawn() as any

  /** 分组框 = 带边框、且直接孩子里有定宽标签 Box 的 row Box。 */
  const groups: any[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Box' && n.props?.borderStyle) {
      const kids = (n.children ?? []).filter((k: any) => k && typeof k === 'object')
      if (kids.some((k: any) => k.type === 'Box' && k.props?.width === 8)) groups.push(n)
    }
    for (const k of n.children ?? []) walk(k)
  }
  walk(tree)

  expect(groups.length).toBe(3)
  for (const group of groups) {
    expect(group.props.borderStyle).toBe('round')
    expect(group.props.borderDimColor).toBe(true)
    expect(group.props.paddingX).toBeUndefined()
  }

  await ui.unmount()
})
