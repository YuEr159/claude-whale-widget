/**
 * Claude 版小鲸鱼挂件：一个侧边面板，没有常驻条。
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

import type { LocalUsage, ModelSpend, Prefs, ScanRecord, SessionTotals, TurnSpend } from '../types'
import { costOf } from './pricing.ts'
import { clip, pct, tokens, usd, countdown } from './format.ts'
import { bubbleLines, freshnessOf, toUsageView } from './usage-view.ts'
import {
  PANEL_DETAIL_OPTIONS,
  addModelSpend,
  contextHeadline,
  contextRowText,
  countPatchLines,
  detailOf,
  duration,
  kindOfName,
  limitRows,
  meterText,
  modelLine,
  sortModelSpends,
  toContextDetail,
  unpricedNote,
  windowSourceText,
  EMPTY_TOTALS,
} from './usage-detail.ts'
import { emblemOf, moodOf, whaleSvg } from './whale-art.ts'

const PLUGIN = 'whale-usage' as const
const PANE = 'whale'


const DEFAULT_PREFS: Prefs = {
  historyDays: 7,
  // 每轮都弹会打断阅读，默认关；想要的人可以在面板里打开。
  isTurnCostOn: false,
  // 本地日志聚合要读几十上百 MB，5 分钟一次足够。
  scanIntervalMs: 5 * 60_000,
  // 面板默认按原生 /usage、/context 的详细视图展示。
  panelDetail: 'detail',
}

const EMPTY_SCAN: ScanRecord = {
  isRunning: false,
  lastRunAt: null,
  lastError: null,
  data: null,
}

/** 定时器多久检查一次「该不该扫描」；真正的判断在间隔比较里。 */
const SCAN_TICK_MS = 15_000

/** 面板打开时，多久请求一次重绘，让倒计时与额度跟着走。 */
const PANEL_REFRESH_MS = 30_000

/** 用户点了「刷新」时置真，下一次定时检查会忽略间隔立即扫。 */
let isScanForced = false

/** 扫描进行中的互斥标记：避免定时检查与手动刷新同时启动两个 node 进程。 */
let isScanning = false

export const register: Register = (on, options) => {
  const defaultHistoryDays = Number(options.historyDays) || DEFAULT_PREFS.historyDays

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whale',
      description: '打开小鲸鱼挂件：额度窗口、会话花费、上下文占用与本地用量',
    })

    // 时间驱动的自动扫描：每 15 秒看一眼，距上次成功扫描超过 scanIntervalMs
    // 就重扫一次。不用「谁置个标志」的写法——那样开着面板不动就永不刷新。
    $.clock.every(SCAN_TICK_MS, async () => {
      if (isScanning) return
      const now = await $.clock.now()

      const scanHeld = await $.state.get({ plugin: 'whale-usage', key: 'scan' } as const)
      const record = scanHeld.value ?? EMPTY_SCAN
      const prefsHeld = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
      const prefsNow = prefsHeld.value ?? DEFAULT_PREFS

      // 间隔为 0 表示只在手动刷新时扫。
      const interval = prefsNow.scanIntervalMs
      if (interval <= 0) return
      if (!isScanForced && record.lastRunAt !== null && now - record.lastRunAt < interval) return
      isScanForced = false

      isScanning = true
      await $.state.set({ plugin: 'whale-usage', key: 'scan' } as const, {
        ...record,
        isRunning: true,
        lastError: null,
      })

      try {
        const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
        if (!home) throw new Error('找不到 HOME 或 USERPROFILE')

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

    // 面板打开时定期请求重绘：倒计时、额度百分比、数据新鲜度都是渲染时算的，
    // 不重绘就是一张冻结的截图。关闭的面板由引擎缓存，不会被重绘。
    $.clock.every(PANEL_REFRESH_MS, () => {
      $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('command.run', { command: 'whale' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: '小鲸鱼' })
    return {
      text: opened.isPlaced
        ? '小鲸鱼面板已打开。'
        : '小鲸鱼面板已打开，窗口加宽后会显示在侧边。',
    }
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
        durationMs: e.durationMs,
        at: Date.now(),
      }
      await $.state.set({ plugin: 'whale-usage', key: 'lastTurn' } as const, spend)

      // 会话累计：墙钟时长、轮次、按模型用量，供面板「总量」「按模型」两节。
      const heldTotals = await $.state.get({ plugin: 'whale-usage', key: 'totals' } as const)
      const totals: SessionTotals = heldTotals.value ?? EMPTY_TOTALS
      await $.state.set({ plugin: 'whale-usage', key: 'totals' } as const, {
        ...totals,
        wallMs: totals.wallMs + e.durationMs,
        turns: totals.turns + 1,
      })

      const heldByModel = await $.state.get({ plugin: 'whale-usage', key: 'byModel' } as const)
      const entry: ModelSpend = {
        model: usage.model,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        cost: cost ?? null,
        turns: 1,
      }
      await $.state.set(
        { plugin: 'whale-usage', key: 'byModel' } as const,
        addModelSpend(heldByModel.value ?? [], entry),
      )

      const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
      if ((heldPrefs.value ?? DEFAULT_PREFS).isTurnCostOn) {
        const label = cost === undefined ? '未收录模型' : usd(cost)
        const inputTotal = usage.input_tokens + usage.cache_read_input_tokens
        $.ui.toast(
          `上一轮 ${label} · ${tokens(inputTotal)} 输入 / ${tokens(usage.output_tokens)} 输出`,
        )
      }
    }

    // 一轮结束顺手刷新一次本地汇总，让「今日」跟上。
    isScanForced = true
    return next(e)
  })

  // 代码行数：只从 Edit / Write 的结构化结果里数增删行，不保留任何行内容。
  // 子代理的编辑计入它自己的循环，不汇总到主线程——与原生 /cost 的口径一致。
  //
  // `catch` 显式放行：本 hook 只观察、不改写结果，统计失败时不该拦住工具调用。
  on(
    'tool.call',
    { tool: 'Edit' },
    async ($, e, next) => {
      const result = await next(e)
      if (!e.agentId && 'result' in result && result.result) {
        const patch = (result.result as { structuredPatch?: Array<{ lines: string[] }> })
          .structuredPatch
        if (Array.isArray(patch)) {
          const counted = countPatchLines(patch)
          if (counted.added > 0 || counted.removed > 0) {
            const held = await $.state.get({ plugin: 'whale-usage', key: 'totals' } as const)
            const totals = held.value ?? EMPTY_TOTALS
            await $.state.set({ plugin: 'whale-usage', key: 'totals' } as const, {
              ...totals,
              linesAdded: totals.linesAdded + counted.added,
              linesRemoved: totals.linesRemoved + counted.removed,
            })
          }
        }
      }
      return result
    },
  ).catch(async ($, e, next) => next(e))

  on(
    'tool.call',
    { tool: 'Write' },
    async ($, e, next) => {
      const result = await next(e)
      if (!e.agentId && 'result' in result && result.result) {
        const patch = (result.result as { structuredPatch?: Array<{ lines: string[] }> })
          .structuredPatch
        if (Array.isArray(patch)) {
          const counted = countPatchLines(patch)
          if (counted.added > 0 || counted.removed > 0) {
            const held = await $.state.get({ plugin: 'whale-usage', key: 'totals' } as const)
            const totals = held.value ?? EMPTY_TOTALS
            await $.state.set({ plugin: 'whale-usage', key: 'totals' } as const, {
              ...totals,
              linesAdded: totals.linesAdded + counted.added,
              linesRemoved: totals.linesRemoved + counted.removed,
            })
          }
        }
      }
      return result
    },
  ).catch(async ($, e, next) => next(e))

  // ---------------- 侧边面板 ----------------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Pane 可能画在终端或桌面：终端没有 Svg，缺 Svg 时退化成文字版。
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const Select = 'Select' in table ? table.Select : undefined

    const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = heldPrefs.value ?? DEFAULT_PREFS
    const detail = detailOf(prefsNow)

    // 详细视图才请求上下文分项：`full` 会给每个工具、记忆文件发一次 token 计数
    // 请求（与 /context 同口径），`summary` 全本地估算、不发请求。面板用 summary
    // 就够看，也避免每次重绘都打一次 API。
    const usage = await $.session
      .usage(
        detail === 'detail'
          ? { breakdown: 'summary', columns: e.props.bodyColumns }
          : undefined,
      )
      .catch(() => undefined)
    const view = toUsageView(usage)
    const now = await $.clock.now()

    const heldScan = await $.state.get({ plugin: 'whale-usage', key: 'scan' } as const)
    const record = heldScan.value ?? EMPTY_SCAN
    const heldTurn = await $.state.get({ plugin: 'whale-usage', key: 'lastTurn' } as const)
    const turn = heldTurn.value ?? null
    const heldTotals = await $.state.get({ plugin: 'whale-usage', key: 'totals' } as const)
    const totals = heldTotals.value ?? EMPTY_TOTALS
    const heldByModel = await $.state.get({ plugin: 'whale-usage', key: 'byModel' } as const)
    const byModel = heldByModel.value ?? []

    const mood = moodOf(view.fiveHour?.percentUsed ?? view.sevenDay?.percentUsed, false)
    const lines = bubbleLines(view, now)
    const data = record.data
    const today = data?.today

    // 面板尺寸：鲸鱼固定在右下角，宽度按面板宽度缩放但不吃掉整行。
    // Svg 的 width/height 是 CSS 像素，bodyColumns 是字符列；等宽字体一列约 8px。
    const width = e.props.bodyColumns
    const isWide = width >= 60
    const pxWidth = width * 8
    const byColumns = Math.floor(isWide ? pxWidth * 0.45 : pxWidth * 0.8)
    const whaleWidth = Math.max(150, Math.min(byColumns, 300))
    const whaleHeight = Math.round(whaleWidth * 0.52)

    const whale = Svg ? (
      <Svg
        source={whaleSvg(mood, lines)}
        alt={`小鲸鱼：${lines.join('，')}`}
        width={whaleWidth}
        height={whaleHeight}
      />
    ) : (
      <Text>{emblemOf(mood)}</Text>
    )

    const isDetailed = detail === 'detail'
    const contextDetail = isDetailed ? toContextDetail(view.breakdown) : undefined
    const kinds = contextDetail ? kindOfName(contextDetail) : undefined
    const gridColor = (cell: { name: string; color: string }) => {
      // 引擎给的主题色优先；没给时按分项类型兜底。空串＝未填充格。
      if (cell.color) return cell.color
      const kind = kinds?.get(cell.name)
      if (kind === 'free') return 'inactive'
      if (kind === 'buffer') return 'subtle'
      return 'promptBorder'
    }

    // 额度窗口：有读数时压成一行，没有时一行说明。
    // 详细视图按原生 /usage 的写法逐条列：标题、百分比、重置倒计时、进度条。
    const windows =
      isDetailed && view.limits.length > 0 ? (
        <>
          {limitRows(view.limits).map((row, index) => (
            <Box key={`whale-limit-${row.title}-${index}`} flexDirection="row" gap={1}>
              <Text wrap="truncate-end">{row.title}</Text>
              <Text color={row.percentUsed >= 90 ? 'warning' : undefined}>
                {meterText(row.percentUsed)}
              </Text>
              <Text>{pct(row.percentUsed)}</Text>
              {row.resetsAt && <Text dimColor>{countdown(row.resetsAt, now)} 后重置</Text>}
            </Box>
          ))}
        </>
      ) : view.fiveHour || view.sevenDay ? (
        <Text>
          5h {pct(view.fiveHour?.percentUsed)}
          {view.fiveHour?.resetsAt ? ` (${countdown(view.fiveHour.resetsAt, now)})` : ''}
          {'  '}7d {pct(view.sevenDay?.percentUsed)}
          {view.sevenDay?.resetsAt ? ` (${countdown(view.sevenDay.resetsAt, now)})` : ''}
        </Text>
      ) : (
        <Text dimColor>无额度窗口（API key 或网关）</Text>
      )

    // 本会话：花费与上下文压成一行，上一轮单独一行。
    // 详细视图再补上原生 /usage 的会话总量：时长、代码增删、轮次数。
    const session = (
      <>
        <Text>
          花费 {usd(view.costUsd)} · 上下文 {pct(view.contextPercent)}
          {view.contextTokens !== undefined
            ? ` ${tokens(view.contextTokens)}/${tokens(view.contextWindow)}`
            : ''}
        </Text>
        {turn && (
          <Text dimColor>
            上一轮 {turn.cost === null ? '未收录模型' : usd(turn.cost)} · {clip(turn.model, 18)}
            {turn.durationMs > 0 ? ` · ${duration(turn.durationMs)}` : ''}
          </Text>
        )}
        {isDetailed && (
          <>
            <Text dimColor>
              会话时长 {duration(totals.wallMs)} · {totals.turns} 轮 · 代码{' '}
              <Text color="diffAdded">+{totals.linesAdded}</Text>{' '}
              <Text color="diffRemoved">-{totals.linesRemoved}</Text> 行
            </Text>
          </>
        )}
      </>
    )

    // 按模型：原生 /usage 的 Usage by model 一节，按花费降序。
    const modelSpends = sortModelSpends(byModel)
    const byModelSection =
      isDetailed && modelSpends.length > 0 ? (
        <>
          <Text bold dimColor>
            按模型
          </Text>
          {modelSpends.slice(0, 6).map((spend, index) => (
            <Text key={`whale-model-${spend.model}-${index}`} dimColor>
              {modelLine(spend)}
            </Text>
          ))}
          {unpricedNote(modelSpends) && <Text dimColor>{unpricedNote(modelSpends)}</Text>}
        </>
      ) : null

    // 上下文明细：原生 /context 的网格 + 逐项。只有拿到 breakdown 才画。
    const contextSection = contextDetail ? (
      <>
        <Text bold dimColor>
          上下文
        </Text>
        <Text>{contextHeadline(contextDetail)}</Text>
        {contextDetail.model && <Text dimColor>模型 {contextDetail.model}</Text>}
        <Text dimColor>{windowSourceText(contextDetail)}</Text>
        {contextDetail.grid.length > 0 && (
          <Box flexDirection="column">
            {contextDetail.grid.map((line, rowIndex) => (
              <Box key={`whale-grid-${rowIndex}`} flexDirection="row">
                {line.map((cell, cellIndex) => (
                  <Text
                    key={`whale-grid-${rowIndex}-${cellIndex}`}
                    color={cell.isFilled ? gridColor(cell) : 'inactive'}
                  >
                    {cell.isFilled ? '⛁' : '·'}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
        {contextDetail.rows.map((row, index) => (
          <Text
            key={`whale-row-${row.name}-${index}`}
            dimColor={row.kind !== 'used'}
            color={row.color || undefined}
          >
            {contextRowText(row)}
          </Text>
        ))}
        {contextDetail.memoryFiles.length > 0 && (
          <Text dimColor>
            记忆文件 {contextDetail.memoryFiles.length} 个 ·{' '}
            {tokens(contextDetail.memoryFiles.reduce((sum, file) => sum + file.tokens, 0))} tok
          </Text>
        )}
        {contextDetail.mcpTools.length > 0 && (
          <Text dimColor>
            MCP 工具 {contextDetail.mcpTools.length} 个 ·{' '}
            {tokens(contextDetail.mcpTools.reduce((sum, tool) => sum + tool.tokens, 0))} tok
          </Text>
        )}
        {contextDetail.agents.length > 0 && (
          <Text dimColor>
            自定义 agent {contextDetail.agents.length} 个 ·{' '}
            {tokens(contextDetail.agents.reduce((sum, agent) => sum + agent.tokens, 0))} tok
          </Text>
        )}
        {contextDetail.skills && (
          <Text dimColor>
            技能 {contextDetail.skills.included}/{contextDetail.skills.total} ·{' '}
            {tokens(contextDetail.skills.tokens)} tok
          </Text>
        )}
        {contextDetail.slashCommands && (
          <Text dimColor>
            斜杠命令 {contextDetail.slashCommands.included}/{contextDetail.slashCommands.total} ·{' '}
            {tokens(contextDetail.slashCommands.tokens)} tok
          </Text>
        )}
      </>
    ) : null

    // 本地历史：今日一行、区间一行、逐模型一行。
    // 数据新鲜度贴在标题旁：过期时标黄，避免把 10 分钟前的数字当实时。
    const freshness = freshnessOf(record.lastRunAt, now, prefsNow.scanIntervalMs)
    const history = (
      <>
        <Text dimColor={!freshness.isStale}>
          {record.isRunning ? '正在统计…' : `本地 ${freshness.text}`}
          {freshness.isStale ? '（可能过期，点刷新）' : ''}
        </Text>
        {record.lastError && <Text dimColor>统计失败：{clip(record.lastError, 60)}</Text>}
        {!record.isRunning && !record.lastError && !today && (
          <Text dimColor>还没有统计结果</Text>
        )}
        {today && (
          <Text>
            今日 {usd(today.cost)} ·{' '}
            {tokens(today.input + today.cacheRead + today.cacheWrite + today.output)} tok ·{' '}
            {today.messages} 条
          </Text>
        )}
        {today && data && (
          <Text dimColor>
            共 {usd(data.total.cost)} ·{' '}
            {tokens(
              data.total.input + data.total.cacheRead + data.total.cacheWrite + data.total.output,
            )}{' '}
            tok
          </Text>
        )}
        {data && data.byModel.length > 0 && (
          <Text dimColor>
            {data.byModel
              .slice(0, 3)
              .map(m => `${clip(m.model.replace('claude-', ''), 14)} ${usd(m.cost)}`)
              .join('  ')}
          </Text>
        )}
      </>
    )

    const controls = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Button
          key="whale-refresh"
          plain
          label="刷新"
          onPress={() => {
            isScanForced = true
          }}
        />
        {Select && (
          <Select
            key="whale-panel-detail"
            label="面板"
            options={PANEL_DETAIL_OPTIONS.map(option => ({
              value: option.value,
              label: option.label,
            }))}
            value={detail}
            onSelect={(value: string) => {
              const mode = PANEL_DETAIL_OPTIONS.find(o => o.value === value)?.value
              if (!mode) return
              void (async () => {
                const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                  ...(latest.value ?? DEFAULT_PREFS),
                  panelDetail: mode,
                })
              })()
            }}
          />
        )}
        {Select && (
          <Select
            key="whale-days"
            label="范围"
            options={[
              { value: '1', label: '今天' },
              { value: '3', label: '3 天' },
              { value: '7', label: '7 天' },
              { value: '14', label: '14 天' },
              { value: '30', label: '30 天' },
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
                isScanForced = true
              })()
            }}
          />
        )}
        <Button
          key="whale-turn-cost"
          plain
          label={prefsNow.isTurnCostOn ? '轮次提示 开' : '轮次提示 关'}
          onPress={() => {
            void (async () => {
              const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
              const nowPrefs = latest.value ?? DEFAULT_PREFS
              await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                ...nowPrefs,
                isTurnCostOn: !nowPrefs.isTurnCostOn,
              })
            })()
          }}
        />
      </Box>
    )

    // 鲸鱼固定在面板右下角：数据一栏在上，鲸鱼独占最后一行并靠右。
    // 详细视图把「按模型」「上下文明细」接在本地历史之后，控制行留在数据与鲸鱼之间。
    if (isWide) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="column">
            <Text bold>Claude 用量</Text>
            {windows}
            {session}
            {byModelSection}
            {contextSection}
            {history}
          </Box>
          {controls}
          <Box flexDirection="row" justifyContent="flex-end" width="100%">
            {whale}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>Claude 用量</Text>
        {windows}
        {session}
        {byModelSection}
        {contextSection}
        {history}
        {controls}
        <Box flexDirection="row" justifyContent="flex-end" width="100%">
          {whale}
        </Box>
      </Box>
    )
  })
}

export default register
