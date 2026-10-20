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
  // 常驻条已移除，控件与元素都不应再出现
  expect(await ui.find({ key: 'whale-band-toggle' })).toBeUndefined()
  expect(await ui.find({ key: 'whale-metric' })).toBeUndefined()

  await ui.unmount()
})

test('不再有常驻条：本插件不注册 AbovePrompt 的渲染', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  mock.env(on, { HOME: 'C:/Users/Yuxiao/test' })

  // 没有插件响应 ui.render 时，宿主会直接拒绝挂载——这正是「常驻条已移除」
  // 的证据：注册表里不再有能画 AbovePrompt 的 hook。
  let message = ''
  try {
    await $.ui.mount({
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
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).toContain('no implementation for ui.render')
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
