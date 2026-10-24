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
      if (['探索未至之境', '内心 OS 很长', '胃口特别大', '我去吃饭了', 'DeepSleep'].includes(title)) {
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
  expect(evening).toBe('我去吃饭了')

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

/** 找到包鲸鱼的那个巡游 Box（最后一行里的第一个孩子）。 */
function findSwimBox(tree: any): any {
  const kids = tree.children ?? []
  const row = kids[kids.length - 1]
  return row?.children?.find?.((kid: any) => kid?.type === 'Box')
}

/**
 * 低频巡游在树里的落点：鲸鱼那一行包一个 `Box`，`marginRight` 按三角波走。
 *
 * 起点（整点 12:00:00.000）相位恰为 0——`floor(now / 6000)` 落在换页边界上，
 * 所以第一条断言是「贴右端，与没有巡游时完全一致」：巡游不该改变静止状态
 * 下的画面，老测试钉的 `justifyContent: flex-end` 也还成立。
 */
test('巡游：起点贴右端，推进时钟逐步左移，余量不足时不游', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    // 140 列：余量 = 140 − ceil(380/8) = 92 列，单程 30 步，足够走两步。
    props: props(140),
    viewport: { columns: 160, rows: 50 },
  })

  expect(findSwimBox(await ui.drawn())?.props?.marginRight).toBe(0)

  await clock.advance(6_000)
  await ui.redraw()
  expect(findSwimBox(await ui.drawn())?.props?.marginRight).toBe(3)

  await clock.advance(6_000)
  await ui.redraw()
  expect(findSwimBox(await ui.drawn())?.props?.marginRight).toBe(6)

  await ui.unmount()
})

test('窄面板（40 列）余量不足一步，鲸鱼恒贴右端', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'whale-usage',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'whale',
    // 40 列：立绘占 48 列 > 面板，夹取后没有余量。
    props: props(40),
    viewport: { columns: 60, rows: 40 },
  })

  const swim = findSwimBox(await ui.drawn())
  expect(swim?.props?.marginRight).toBe(0)

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
