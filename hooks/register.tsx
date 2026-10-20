/**
 * Claude 版小鲸鱼挂件：prompt 上方常驻条 + 侧边完整面板。
 *
 * 数据全部来自本机、全部只读：
 *   1. `$.session.usage()`：5 小时 / 7 天额度窗口、本会话花费、上下文占用；
 *   2. `turn.complete` 的本轮真实 token；
 *   3. `scripts/usage-scan.mjs` 聚合 `~/.claude/projects` 得到的今日/近期用量。
 *
 * 隐私：本模块不读日志正文，只把「日志根目录」交给本地 node 进程；回传的
 * 也只有数字和官方模型名。详见 PRIVACY.md。
 *
 * 写法约束（`claude plugin validate` 会检查）：`$` 只能以 `$.noun.method(...)`
 * 的形式出现在调用点，不能作为参数传给本文件里声明的函数。所以状态读写与
 * 扫描逻辑都内联在各 hook 里，纯计算放到 `usage-view.ts`。
 */
import type { Register } from 'claude-code'

import type { LocalUsage, Prefs, ScanRecord, TurnSpend } from '../types'
import { costOf } from './pricing.ts'
import { clip, pct, tokens, usd, countdown } from './format.ts'
import { bandSummary, bubbleLines, toUsageView } from './usage-view.ts'
import { emblemOf, moodOf, whaleSvg } from './whale-art.ts'

const PLUGIN = 'whale-usage' as const
const PANE = 'whale'


const DEFAULT_PREFS: Prefs = {
  isBandVisible: true,
  bandMetric: 'window',
  historyDays: 7,
  isTurnCostOn: true,
}

const EMPTY_SCAN: ScanRecord = {
  isRunning: false,
  lastRunAt: null,
  lastError: null,
  data: null,
}

/** 两次本地聚合之间至少隔这么久，避免频繁读盘。 */
const SCAN_MIN_GAP_MS = 60_000

/**
 * 扫描需求由各处 hook 置真，真正的 `$.process.run` 只出现在下面的定时器里。
 * 模块级变量在热重载后重置，这是可接受的：重载本来就要重新扫一次。
 */
let wantsScan = true
let lastScanAt = 0
let isScanning = false

export const register: Register = (on, options) => {
  const defaultHistoryDays = Number(options.historyDays) || DEFAULT_PREFS.historyDays

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whale',
      description: '打开小鲸鱼挂件：额度窗口、会话花费、上下文占用与本地用量',
    })
    await $.command.register({
      name: 'whale-band',
      description: '显示或隐藏 prompt 上方的小鲸鱼条',
    })

    // 每 15 秒有一次机会做本地聚合；真正的门槛在下面几行（需求 + 节流 + 未在跑）。
    $.clock.every(15_000, async () => {
      if (!wantsScan || isScanning) return
      const now = await $.clock.now()
      if (now - lastScanAt < SCAN_MIN_GAP_MS) return

      wantsScan = false
      isScanning = true
      lastScanAt = now
      const held = await $.state.get({ plugin: 'whale-usage', key: 'scan' } as const)
      await $.state.set({ plugin: 'whale-usage', key: 'scan' } as const, { ...(held.value ?? EMPTY_SCAN), isRunning: true, lastError: null })

      try {
        const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
        if (!home) throw new Error('找不到 HOME 或 USERPROFILE')

        const prefsHeld = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
        const prefsNow = prefsHeld.value ?? DEFAULT_PREFS
        const days = prefsNow.historyDays > 0 ? prefsNow.historyDays : defaultHistoryDays
        const root = `${home.replace(/\\/g, '/')}/.claude/projects`

        const result = await $.process.run(
          ['node', `${$.plugin.root}/scripts/usage-scan.mjs`, root, String(days)],
          { timeoutMs: 120_000 },
        )
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().slice(0, 300) || `退出码 ${result.exitCode}`)
        }
        const data = JSON.parse(result.stdout.trim()) as LocalUsage | { error?: string }
        if ('error' in data && data.error) throw new Error(data.error)

        const after = await $.state.get({ plugin: 'whale-usage', key: 'scan' } as const)
        await $.state.set({ plugin: 'whale-usage', key: 'scan' } as const, {
          ...(after.value ?? EMPTY_SCAN),
          isRunning: false,
          lastRunAt: now,
          lastError: null,
          data: data as LocalUsage,
        })
      } catch (error) {
        const after = await $.state.get({ plugin: 'whale-usage', key: 'scan' } as const)
        await $.state.set({ plugin: 'whale-usage', key: 'scan' } as const, {
          ...(after.value ?? EMPTY_SCAN),
          isRunning: false,
          lastRunAt: now,
          lastError: error instanceof Error ? error.message : String(error),
        })
      } finally {
        isScanning = false
      }
    })

    // 启动后稍等再扫，别和启动抢资源。
    $.clock.after(1500, () => {
      wantsScan = true
    })

    return next(e)
  })

  on('command.run', { command: 'whale' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: '小鲸鱼' })
    wantsScan = true
    return {
      text: opened.isPlaced
        ? '小鲸鱼面板已打开。'
        : '小鲸鱼面板已打开，窗口加宽后会显示在侧边。',
    }
  })

  on('command.run', { command: 'whale-band' }, async $ => {
    const held = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = held.value ?? DEFAULT_PREFS
    const isNextVisible = !prefsNow.isBandVisible
    await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, { ...prefsNow, isBandVisible: isNextVisible })
    return { text: isNextVisible ? '小鲸鱼条已显示。' : '小鲸鱼条已隐藏。' }
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage
    if (usage && !e.agentId) {
      const cost = costOf(usage.model, {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        cacheRead: usage.cache_read_input_tokens,
      })
      const heldTurn = await $.state.get({ plugin: 'whale-usage', key: 'lastTurn' } as const)
      const spend: TurnSpend = {
        seq: (heldTurn.value?.seq ?? 0) + 1,
        turnId: e.turnId,
        model: usage.model,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        cost: cost ?? null,
        at: Date.now(),
      }
      await $.state.set({ plugin: 'whale-usage', key: 'lastTurn' } as const, spend)

      const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
      if ((heldPrefs.value ?? DEFAULT_PREFS).isTurnCostOn) {
        const label = cost === undefined ? '未收录模型' : usd(cost)
        const inputTotal = usage.input_tokens + usage.cache_read_input_tokens
        $.ui.toast(
          `上一轮 ${label} · ${tokens(inputTotal)} 输入 / ${tokens(usage.output_tokens)} 输出`,
        )
      }
    }

    wantsScan = true
    return next(e)
  })

  // ---------------- 常驻条 ----------------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = heldPrefs.value ?? DEFAULT_PREFS
    if (!prefsNow.isBandVisible || e.props.hasSurvey) return next(e)

    const view = toUsageView(await $.session.usage().catch(() => undefined))
    const mood = moodOf(view.fiveHour?.percentUsed ?? view.sevenDay?.percentUsed, e.props.isWorking)
    const now = await $.clock.now()
    const summary = bandSummary(view, prefsNow.bandMetric, now)

    // AbovePrompt 在终端和桌面都会绘制，但只有桌面有 Svg（终端没有位图/SVG 元素）。
    // 收窄 e.surface 后，元素表才是该 surface 的确切类型。
    if (e.surface !== 'desktop') {
      const { Box, Text, Button } = $.ui.resolve(e)
      // 终端没有图形元素：文字靠右，鲸鱼用 emoji 占位
      return (
        <Box
          key="whale-band"
          flexDirection="row"
          alignItems="center"
          justifyContent="flex-end"
          gap={1}
        >
          <Text dimColor>{summary}</Text>
          <Button
            key="whale-open"
            plain
            label="面板"
            onPress={() => void $.ui.open({ id: PANE, title: '小鲸鱼' })}
          />
          <Text>{emblemOf(mood)}</Text>
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)

    // 鲸鱼排在最右：整行撑满 bodyColumns 后靠右对齐，鲸鱼就是这一行最靠右
    // 的元素，紧贴输入框上方区域的右下角。
    return (
      <Box
        key="whale-band"
        flexDirection="row"
        alignItems="center"
        justifyContent="flex-end"
        width={e.props.bodyColumns}
        gap={1}
      >
        <Text dimColor>{summary}</Text>
        <Button
          key="whale-open"
          plain
          label="面板"
          onPress={() => void $.ui.open({ id: PANE, title: '小鲸鱼' })}
        />
        <Svg
          source={whaleSvg(mood, [summary], { isAnimating: false, isCompact: true })}
          alt={`小鲸鱼：${summary}`}
          width={46}
          height={24}
        />
      </Box>
    )
  })

  // ---------------- 侧边面板 ----------------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Pane 可能画在终端或桌面：终端没有 Svg（只有 Raster/Image），所以用 `in`
    // 收窄元素表，缺 Svg 时退化成文字版。
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const Select = 'Select' in table ? table.Select : undefined
    const view = toUsageView(await $.session.usage().catch(() => undefined))
    const now = await $.clock.now()

    const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = heldPrefs.value ?? DEFAULT_PREFS
    const heldScan = await $.state.get({ plugin: 'whale-usage', key: 'scan' } as const)
    const record = heldScan.value ?? EMPTY_SCAN
    const heldTurn = await $.state.get({ plugin: 'whale-usage', key: 'lastTurn' } as const)
    const turn = heldTurn.value ?? null

    const mood = moodOf(view.fiveHour?.percentUsed ?? view.sevenDay?.percentUsed, false)
    const lines = bubbleLines(view, now)
    const data = record.data
    const today = data?.today

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Svg ? (
            <Svg
              source={whaleSvg(mood, lines)}
              alt={`小鲸鱼：${lines.join('，')}`}
              width={150}
              height={78}
            />
          ) : (
            <Text>{emblemOf(mood)}</Text>
          )}
          <Box flexDirection="column">
            <Text bold>Claude 用量小鲸鱼</Text>
            <Text dimColor>{mood === 'sleep' ? '额度快满了，休息一下' : '数据只来自本机'}</Text>
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text bold>额度窗口</Text>
          <Text>
            5 小时 {pct(view.fiveHour?.percentUsed)}
            {view.fiveHour?.resetsAt ? ` · ${countdown(view.fiveHour.resetsAt, now)} 后重置` : ''}
          </Text>
          <Text>
            7 天 {pct(view.sevenDay?.percentUsed)}
            {view.sevenDay?.resetsAt ? ` · ${countdown(view.sevenDay.resetsAt, now)} 后重置` : ''}
          </Text>
          {!view.fiveHour && !view.sevenDay && (
            <Text dimColor>当前账号没有可读的额度窗口（API key 计费或第三方网关）。</Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>本会话</Text>
          <Text>花费 {usd(view.costUsd)}</Text>
          <Text>
            上下文 {pct(view.contextPercent)}
            {view.contextTokens !== undefined
              ? ` · ${tokens(view.contextTokens)} / ${tokens(view.contextWindow)}`
              : ''}
          </Text>
          {turn && (
            <Text dimColor>
              上一轮 {turn.cost === null ? '未收录模型' : usd(turn.cost)} · {turn.model}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>本地历史（最近 {data?.windowDays ?? prefsNow.historyDays} 天）</Text>
          {record.isRunning && <Text dimColor>正在统计…</Text>}
          {record.lastError && <Text dimColor>统计失败：{clip(record.lastError, 80)}</Text>}
          {!record.isRunning && !record.lastError && !today && (
            <Text dimColor>还没有统计结果，稍候会自动刷新。</Text>
          )}
          {today && (
            <>
              <Text>
                今日 {usd(today.cost)} ·{' '}
                {tokens(today.input + today.cacheRead + today.cacheWrite + today.output)} token
              </Text>
              <Text dimColor>今日消息 {today.messages} 条</Text>
              {data && (
                <Text>
                  区间合计 {usd(data.total.cost)} ·{' '}
                  {tokens(
                    data.total.input +
                      data.total.cacheRead +
                      data.total.cacheWrite +
                      data.total.output,
                  )}{' '}
                  token
                </Text>
              )}
            </>
          )}
          {data && data.byModel.length > 0 && (
            <Box flexDirection="column">
              {data.byModel.slice(0, 4).map(model => (
                <Text key={model.model} dimColor>
                  {clip(model.model, 28)} {usd(model.cost)}
                </Text>
              ))}
            </Box>
          )}
          <Text dimColor>未收录的第三方模型不参与计价，只统计 token。</Text>
        </Box>

        <Box flexDirection="row" gap={1} alignItems="center">
          <Button
            key="whale-refresh"
            plain
            label="立即刷新"
            onPress={() => {
              lastScanAt = 0
              wantsScan = true
            }}
          />
          {Select && (
            <Select
              key="whale-days"
              label="统计范围"
              options={[
                { value: '1', label: '今天' },
                { value: '3', label: '最近 3 天' },
                { value: '7', label: '最近 7 天' },
                { value: '14', label: '最近 14 天' },
                { value: '30', label: '最近 30 天' },
              ]}
              value={String(prefsNow.historyDays)}
              onSelect={(value: string) => {
                const days = Number(value) || DEFAULT_PREFS.historyDays
                void (async () => {
                  const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                  await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                    ...(latest.value ?? DEFAULT_PREFS),
                    historyDays: days,
                  })
                  lastScanAt = 0
                  wantsScan = true
                })()
              }}
            />
          )}
          <Button
            key="whale-turn-cost"
            plain
            label={prefsNow.isTurnCostOn ? '轮次提示：开' : '轮次提示：关'}
            onPress={() => {
              void (async () => {
                const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                const nowPrefs = latest.value ?? DEFAULT_PREFS
                await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, { ...nowPrefs, isTurnCostOn: !nowPrefs.isTurnCostOn })
              })()
            }}
          />
          <Button
            key="whale-band-toggle"
            plain
            label={prefsNow.isBandVisible ? '隐藏上方条' : '显示上方条'}
            onPress={() => {
              void (async () => {
                const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                const nowPrefs = latest.value ?? DEFAULT_PREFS
                await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, { ...nowPrefs, isBandVisible: !nowPrefs.isBandVisible })
              })()
            }}
          />
        </Box>
      </Box>
    )
  })
}

export default register
