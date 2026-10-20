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
