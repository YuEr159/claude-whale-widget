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
