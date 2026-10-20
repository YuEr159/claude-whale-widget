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

import type {
  ContextTurn,
  LocalUsage,
  ModelSpend,
  Prefs,
  ScanRecord,
  SessionTotals,
  TurnSpend,
} from '../types'
import { costOf } from './pricing.ts'
import { clip, displayWidth, padCell, pct, tokens, countdown, usd } from './format.ts'
import { UNPRICED, usdEstimate } from './provenance.ts'
import { BAND_METRIC_OPTIONS, bandSummary, bubbleLines, freshnessOf, toUsageView } from './usage-view.ts'
import { contextChartSvg, heatWindowDays, modelFill, modelStackSvg, pageOf, turnHeatHeight, turnHeatSvg } from './chart-art.ts'
import {
  barText,
  contextParts,
  contextStack,
  maskModel,
  modelDetailRows,
  modelRows,
  MODEL_STACK_KEEP,
  modelGrainFor,
  modelGrainLabel,
  modelStackBars,
  modelStackCaption,
  overviewCards,
  overviewFooter,
  rasterizeStacks,
  rasterizeTurnBars,
  stackCaption,
  stackColor,
  stackLegendOf,
  turnBars,
  turnBarsCaption,
} from './usage-overview.ts'
import type { StatCard } from './usage-overview.ts'
import {
  addModelSpend,
  countPatchLines,
  duration,
  limitRows,
  meterText,
  modelLine,
  sortModelSpends,
  toContextDetail,
  unpricedNote,
  EMPTY_TOTALS,
} from './usage-detail.ts'
import { emblemOf, moodOf, whaleSizeFor, whaleSvg } from './whale-art.ts'
import { themeColorsFor } from './panel-fill.ts'
import type { ThemeColors } from './panel-fill.ts'

const PLUGIN = 'whale-usage' as const
const PANE = 'whale'


const DEFAULT_PREFS: Prefs = {
  isBandVisible: true,
  bandMetrics: ['window'],
  historyDays: 30,
  // 每轮都弹会打断阅读，默认关；想要的人可以在面板里打开。
  isTurnCostOn: false,
  // 本地日志聚合要读几十上百 MB，5 分钟一次足够。
  scanIntervalMs: 5 * 60_000,
  // 默认落在概览页。
  panelPage: 'overview',
  // 热图默认看轮次（用户真正发起请求的次数），可切到消息数。
  heatMetric: 'turns',
  // 上下文图默认贴住最新一轮，往左翻时才用偏移量。
  contextOffset: 0,
  // 泡泡默认收起：鲸鱼只留右下角一小块，点一下才展开摘要。
  isBubbleOpen: false,
  // 按压变形只在点击后的一瞬为真。
  isWhalePressed: false,
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

/** 逐轮上下文占比最多保留多少轮。 */
const CONTEXT_TURNS_KEPT = 60

/**
 * 扫描窗口：热图的可见天数由面板宽度决定，宽面板能放下更多周，所以扫描要
 * 一次覆盖住最宽的情况，之后随宽度增减只改显示范围、不再重扫。
 *
 * 900px 宽（约 110 列）能放下约 54 列 × 7 = 378 天，取 400 天留余量。
 * 实测 400 天约 300 个日志文件、4 秒，5 分钟一次可以接受。
 */
const TURN_WINDOW_DAYS = 400

/** 点开鲸鱼摘要后，多少毫秒自动收起。 */
const BUBBLE_AUTO_HIDE_MS = 4_000

/**
 * 是否刚发生过一次压缩、还没落到某一轮的记录上。
 *
 * 压缩是两轮之间的动作，没有自己的柱子；下一次 `turn.complete` 记下这一轮
 * 时把这个标记转成 `afterCompact`，图上就能标出「上下文骤降是因为压缩」。
 * 只活在模块内存里：重载插件后不再标旧记录，但旧记录本来也已经画过了。
 */
let isCompactPending = false

/**
 * 圆角框的底色，第一次读 `/config` 后缓存。
 *
 * 主题在一次会话里基本不变，而面板重绘很频繁；`null` 表示「还没读过」。
 * 换主题要重开面板才生效——这点误差换来的是每次重绘都不必再发一次 IPC。
 */
let themeCache: ThemeColors | null = null

/** 按下鲸鱼后，形变保持多久才弹回。太短看不见，太长会像卡住。 */
const PRESS_RELEASE_MS = 140

/** 扫描进行中的互斥标记：避免定时检查与手动刷新同时启动两个 node 进程。 */
let isScanning = false

/**
 * 上一次扫描留下的增量缓存（文件指纹 → 该文件的数字增量）。
 *
 * 只活在这个模块的内存里：进程结束就没了，不写任何文件。模块热重载会清空它，
 * 代价只是下一次扫描退回全量——正确性不受影响。
 */
let scanCache: unknown[] = []

export const register: Register = (on, options) => {
  const defaultHistoryDays = Number(options.historyDays) || DEFAULT_PREFS.historyDays

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whale',
      description: '打开小鲸鱼挂件：额度窗口、会话花费、上下文占用与本地用量',
    })
    await $.command.register({
      name: 'whale-band',
      description: '显示或隐藏 prompt 上方的用量条',
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

        // 扫描窗口：热图能显示多少天取决于面板宽度，取最宽的情况一次扫够。
        // 实测 400 天约 300 个日志文件、3.5 秒（冷），有增量缓存后约 20 毫秒。
        const days = Math.max(TURN_WINDOW_DAYS, prefsNow.historyDays > 0 ? prefsNow.historyDays : defaultHistoryDays)
        const root = `${home.replace(/\\/g, '/')}/.claude/projects`

        // 增量缓存：上一次扫描的「文件指纹 → 该文件的数字增量」经 stdin 递给
        // 脚本，脚本把更新后的缓存放在输出里回传。日志是只追加的，一次扫描里
        // 绝大多数文件都不会再变，所以第二次起只需重读刚写过的几个文件。
        // 缓存只活在这个模块的内存里，不落盘（见 PRIVACY.md）。
        const result = await $.process.run(
          ['node', `${$.plugin.root}/scripts/usage-scan.mjs`, root, String(days)],
          { timeoutMs: 120_000, stdin: scanCache.length > 0 ? JSON.stringify(scanCache) : '' },
        )
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().slice(0, 300) || `退出码 ${result.exitCode}`)
        }
        const parsed = JSON.parse(result.stdout.trim()) as
          | (LocalUsage & { cache?: unknown[] })
          | { error?: string }
        if ('error' in parsed && parsed.error) throw new Error(parsed.error)
        const { cache: nextCache, ...data } = parsed as LocalUsage & { cache?: unknown[] }
        if (Array.isArray(nextCache)) scanCache = nextCache

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

  on('command.run', { command: 'whale-band' }, async $ => {
    const held = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = held.value ?? DEFAULT_PREFS
    const isNextVisible = !prefsNow.isBandVisible
    await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, { ...prefsNow, isBandVisible: isNextVisible })
    return { text: isNextVisible ? '用量条已显示。' : '用量条已隐藏。' }
  })

  // 压缩标记：压缩发生在两轮之间，本身没有对应的柱子。这里只记一个
  // 待消费的标记，下一次 `turn.complete` 把它写进那一轮的记录，
  // 图上就能在压缩后的第一根柱子旁竖一条虚线。
  //
  // `next(e)` 原样往下走：标记的语义是「下一次看到新轮次时，它前面有过压缩」，
  // 哪怕压缩因故被拒，下一轮照样是「压缩尝试之后」的读数。
  // 校验器把这里判成 gating hook（返回值决定压缩是否继续），所以必须挂
  // `.catch`——统计标记出任何岔子都不该拦住压缩本身。
  on('session.compact', async ($, e, next) => {
    // 子代理/分支的压缩不进主会话的图。
    if (!e.agentId) isCompactPending = true
    return next(e)
  }).catch(async ($, e, next) => next(e))

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

      // 逐轮上下文占比：面板据此画堆叠柱状图。
      // 只保留最近 60 轮——再长的历史在面板里也画不下，而状态是会话级的，
      // 没必要无限增长。
      //
      // 同时取一次 breakdown（`summary` 全本地估算、不发 token 计数请求），
      // 把「窗口被什么占着」一并记下。这是借 dsh-context 的核心读法：
      // 上下文是一个由若干类内容拼起来的窗口，不是一个人均数。
      const heldContext = await $.state.get({ plugin: 'whale-usage', key: 'contextTurns' } as const)
      const contextTurns: ContextTurn[] = heldContext.value ?? []
      const live = await $.session
        .usage({ breakdown: 'summary', columns: 40 })
        .catch(() => undefined)
      const liveView = toUsageView(live)
      const percent = liveView.contextPercent
      if (percent !== undefined) {
        const usedTokens =
          usage.input_tokens +
          usage.cache_read_input_tokens +
          usage.cache_creation_input_tokens +
          usage.output_tokens
        // 只有当轮的构成：`live` 是这一轮结束时的窗口快照。
        // 走面板同一个解析函数，形状不对就当作没有构成，不另写一套判空。
        const liveDetail = toContextDetail(liveView.breakdown)
        const parts = liveDetail ? contextParts(liveDetail.rows) : []
        const entry: ContextTurn = {
          seq: spend.seq,
          percent,
          tokens: usedTokens,
          at: spend.at,
          ...(parts.length > 0 ? { parts } : {}),
          ...(liveView.contextWindow ? { windowTokens: liveView.contextWindow } : {}),
          ...(isCompactPending ? { afterCompact: true } : {}),
        }
        // 标记只属于下一轮：消费掉，免得后面每一轮都顶一条虚线。
        isCompactPending = false
        const history = [...contextTurns, entry].slice(-CONTEXT_TURNS_KEPT)
        await $.state.set({ plugin: 'whale-usage', key: 'contextTurns' } as const, history)
      }

      const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
      if ((heldPrefs.value ?? DEFAULT_PREFS).isTurnCostOn) {
        const label = cost === undefined ? UNPRICED : usdEstimate(cost)
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

  // ---------------- 输入框上方的用量条 ----------------
  // 只放摘要与面板入口，不放任何形象：不占额外列宽，也不与输入区的
  // 原生元素争位置。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = heldPrefs.value ?? DEFAULT_PREFS
    if (!prefsNow.isBandVisible || e.props.hasSurvey) return next(e)

    const view = toUsageView(await $.session.usage().catch(() => undefined))
    const now = await $.clock.now()
    // 读 `totals` 有两个作用：拿到代码改动行数，并让这条用量条成为该状态的
    // 订阅者——Edit / Write 的 `state.set` 会重绘读过它的绘制点，条子随即更新。
    // 这就是「随代码改动实时变化」的全部机制，不需要额外的定时器。
    const heldTotals = await $.state.get({ plugin: 'whale-usage', key: 'totals' } as const)
    const totals = heldTotals.value ?? EMPTY_TOTALS
    const diff = { added: totals.linesAdded, removed: totals.linesRemoved }
    const metrics = prefsNow.bandMetrics ?? DEFAULT_PREFS.bandMetrics
    const summary = bandSummary(view, metrics, now, diff)

    const { Box, Text, Button } = $.ui.resolve(e)
    // 注意：这里不能在 Text 里用 `<>` 或嵌套 Text。
    // 引擎的 `Fragment` 实现是「一个纵向 Box」，塞进 Text 就是
    // `Box inside an inline element`，整棵树被拒、引擎改画它自己的，
    // 用量条会直接消失。增删要分色，就在同一行里并排几个 Text。
    // 选中「代码改动」时改动已经在 summary 里，这里不再重复追加。
    const showsDiff = metrics.includes('diff')
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
        {/* 没选「代码改动」时把增删作为后缀。为零的一边不画
            （`+5` 比 `+5 -0` 干净）。 */}
        {!showsDiff && totals.linesAdded > 0 && (
          <Text color="diffAdded">{`+${totals.linesAdded}`}</Text>
        )}
        {!showsDiff && totals.linesRemoved > 0 && (
          <Text color="diffRemoved">{`-${totals.linesRemoved}`}</Text>
        )}
        <Button
          key="whale-open"
          plain
          label="面板"
          onPress={() => void $.ui.open({ id: PANE, title: '小鲸鱼' })}
        />
      </Box>
    )
  })

  // ---------------- 侧边面板 ----------------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Pane 可能画在终端或桌面：终端没有 Svg，缺 Svg 时退化成文字版。
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const Select = 'Select' in table ? table.Select : undefined

    const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = heldPrefs.value ?? DEFAULT_PREFS
    // 默认收起：读不到该字段的老状态按「收起」处理。
    const isBubbleOpen = prefsNow.isBubbleOpen === true
    const isWhalePressed = prefsNow.isWhalePressed === true

    // 请求上下文分项：`full` 会给每个工具、记忆文件发一次 token 计数
    // 请求（与 /context 同口径），`summary` 全本地估算、不发请求。面板用 summary
    // 就够看，也避免每次重绘都打一次 API。
    const usage = await $.session
      .usage({ breakdown: 'summary', columns: e.props.bodyColumns })
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
    const heldContextTurns = await $.state.get({ plugin: 'whale-usage', key: 'contextTurns' } as const)
    const contextTurns = heldContextTurns.value ?? []
    // 用量条口径：老状态里没有这个字段时退回默认，空数组按默认处理——
    // 一条空白用量条比显示得多更糟。
    const metrics =
      Array.isArray(prefsNow.bandMetrics) && prefsNow.bandMetrics.length > 0
        ? prefsNow.bandMetrics
        : DEFAULT_PREFS.bandMetrics
    // 圆角框的底色跟着主题走。主题在一次会话里基本不变，而面板打开时会
    // 每 30 秒重绘一次——每次都问一遍 `/config` 只是白花一次 IPC，所以
    // 第一次读到后就记在模块里。`$` 不能传进辅助函数（校验器的约束），
    // 读写缓存只能是这段内联代码。
    if (themeCache === null) {
      themeCache = themeColorsFor(await $.config.list().catch(() => undefined))
    }
    const theme = themeCache
    // 三块圆角框的底与边；图表另取 `theme.chart`。
    const fill = theme
    const chart = theme.chart

    const mood = moodOf(view.fiveHour?.percentUsed ?? view.sevenDay?.percentUsed, false)
    const lines = bubbleLines(view, now)
    const data = record.data
    const today = data?.today

    // 面板尺寸：鲸鱼固定在右下角。
    // Svg 的 width/height 是 CSS 像素，bodyColumns 是字符列；等宽字体一列约 8px。
    //
    // 三条约束，缺一条都会让鲸鱼在拖动面板宽度时抖动：
    //   1. 不用「宽面板 / 窄面板」两套系数——那会在阈值处突变（60 列时曾一次缩 84px）；
    //      改成一条连续的公式，窄时占比大、宽时占比小，中间平滑过渡。
    //   2. 高度必须严格等于 width × 画布高宽比（320/620）。比例不一致时
    //      `preserveAspectRatio` 会留白并上下居中，且留白量随宽度抖动。
    //   3. 右下角对齐用显式列宽，不用 `100%`——后者依赖父容器的解析宽度。
    const width = e.props.bodyColumns
    const whaleSize = whaleSizeFor(width)
    const whaleWidth = whaleSize.width
    const whaleHeight = whaleSize.height
    // 点击覆盖层要盖住整只鲸鱼。Button 只有一行高，所以按行数铺；
    // 一行约 8px（与 whaleWidthFor 里的 pxPerColumn 同口径）。
    const whaleTapRows = Math.max(1, Math.ceil(whaleHeight / 8))
    const whaleTapCols = Math.max(1, Math.ceil(whaleWidth / 8))

    const whale = Svg ? (
      <Svg
        source={whaleSvg(mood, lines, {
          isBubbleOpen: isBubbleOpen,
          isPressed: isWhalePressed,
        })}
        alt={
          isBubbleOpen
            ? `小鲸鱼：${lines.join('，')}`
            : '小鲸鱼（点一下展开摘要）'
        }
        width={whaleWidth}
        height={whaleHeight}
      />
    ) : (
      <Text>{emblemOf(mood)}</Text>
    )

    // 面板只有一种形态：全部信息都画出来。曾经有「简洁 / 详细」两档，
    // 但简洁那一档只是把同样几行压成摘要，少掉的正是最该看的明细，
    // 没有存在的必要——想看少一点的人可以把面板关掉。
    const contextDetail = toContextDetail(view.breakdown)

    // 额度窗口：按原生 /usage 的写法逐条列——标题、百分比、重置倒计时、进度条。
    const windows =
      view.limits.length > 0 ? (
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
      ) : (
        <Text dimColor>无额度窗口（API key 或网关）</Text>
      )

    // 本会话：花费与上下文压成一行，上一轮单独一行，再补上原生 /usage 的会话总量：
    // 时长、代码增删、轮次数。
    const session = (
      <>
        <Text>
          花费 {usdEstimate(view.costUsd)} · 上下文 {pct(view.contextPercent)}
          {view.contextTokens !== undefined
            ? ` ${tokens(view.contextTokens)}/${tokens(view.contextWindow)}`
            : ''}
        </Text>
        {turn && (
          <Text dimColor>
            上一轮 {turn.cost === null ? UNPRICED : usdEstimate(turn.cost)} · {clip(turn.model, 18)}
            {turn.durationMs > 0 ? ` · ${duration(turn.durationMs)}` : ''}
          </Text>
        )}
        <Text dimColor>
          会话时长 {duration(totals.wallMs)} · {totals.turns} 轮 · 代码{' '}
          <Text color="diffAdded">+{totals.linesAdded}</Text>{' '}
          <Text color="diffRemoved">-{totals.linesRemoved}</Text> 行
        </Text>
      </>
    )

    // 按模型：原生 /usage 的 Usage by model 一节，按花费降序。
    // 标题不再上屏——每行都自带模型名，顶上再加一个「按模型」只是重复；
    // 模型页已经有逐模型的完整表格，这里只留最花钱的几行。
    const modelSpends = sortModelSpends(byModel)
    const byModelSection =
      modelSpends.length > 0 ? (
        <>
          {modelSpends.slice(0, 6).map((spend, index) => (
            <Text key={`whale-model-${spend.model}-${index}`} dimColor>
              {modelLine(spend)}
            </Text>
          ))}
          {unpricedNote(modelSpends) && <Text dimColor>{unpricedNote(modelSpends)}</Text>}
        </>
      ) : null

    // 上下文占比的堆叠柱状图：每根柱子是一轮，柱内按「已用 / 压缩缓冲 / 空闲」
    // 分段堆叠。高度按窗口的 100% 算，所以柱子之间的高低差直接就是占比走势。
    const bufferPct =
      contextDetail && contextDetail.rawMaxTokens > 0 && contextDetail.autoCompactThreshold
        ? ((contextDetail.rawMaxTokens - contextDetail.autoCompactThreshold) /
            contextDetail.rawMaxTokens) *
          100
        : 0
    // 面板只有纵向滚动，横向拉不动；所以每张图配一对翻页按钮，
    // 一页一个窗口，默认贴住最新一端。
    const contextPage = pageOf(contextTurns, 24, prefsNow.contextOffset ?? 0)
    const stacks = contextStack(contextPage.slice, contextPage.slice.length, Math.max(0, bufferPct))
    const stackLegend = stackLegendOf(stacks.bars, theme.isLight)
    const chartWidth = Math.max(80, Math.min(width * 8 - 16, 640))

    // 翻页按钮：offset 越大越往历史，所以 ◀ 加、▶ 减，写回时夹在合法范围内。
    // 只有一页时整对按钮都不画——点了不会动，留着只会让人以为还有更多。
    const turnPage = (
      key: 'contextOffset',
      maxOffset: number,
      page: number,
      pages: number,
      handler: (delta: number) => void,
    ) =>
      maxOffset <= 0 ? null : (
        <>
          <Button key={`whale-left-${key}`} plain label="◀" onPress={() => handler(1)} />
          <Button key={`whale-right-${key}`} plain label="▶" onPress={() => handler(-1)} />
          <Text dimColor>
            {page}/{pages}
          </Text>
        </>
      )

    const writeOffset = (key: 'contextOffset', delta: number, maxOffset: number) => {
      void (async () => {
        const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
        const nowPrefs = latest.value ?? DEFAULT_PREFS
        const current = nowPrefs[key] ?? 0
        const clamped = Math.max(0, Math.min(current + delta, maxOffset))
        await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
          ...nowPrefs,
          [key]: clamped,
        })
      })()
    }

    const contextChart =
      contextPage.slice.length === 0 ? null : (
        // 与概览、模型两页同一个外框语言：圆角 + 同一支底色，三块并排在一起
        // 读起来才是同一层面的三个视图，而不是三张来源不同的卡片。
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={fill.borderColor}
          backgroundColor={fill.backgroundColor}
          paddingX={1}
        >
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text bold dimColor>
              上下文占比
            </Text>
            {turnPage(
              'contextOffset',
              contextPage.maxOffset,
              contextPage.page,
              contextPage.pages,
              delta => writeOffset('contextOffset', delta, contextPage.maxOffset),
            )}
          </Box>
          {Svg ? (
            <Svg
              source={contextChartSvg(
                contextPage.slice,
                chartWidth,
                contextPage.slice.length,
                Math.max(0, bufferPct),
                chart,
              )}
              alt={stackCaption(stacks.bars.length, stacks.peak, stacks.yMax)}
              width={chartWidth}
              height={112}
            />
          ) : (
            <>
              {rasterizeStacks(stacks.bars, width >= 60 ? 8 : 6).map((line, rowIndex) => (
                <Box key={`whale-stack-${rowIndex}`} flexDirection="row">
                  {line.map((bar, barIndex) => (
                    <Text
                      key={`whale-stack-${rowIndex}-${barIndex}`}
                      color={stackColor(bar[0] ?? null, theme.isLight)}
                    >
                      {bar[0] === 'buffer' ? '▒' : bar[0] === 'free' ? '·' : bar[0] ? '█' : ' '}
                    </Text>
                  ))}
                </Box>
              ))}
            </>
          )}
          {/* 图例跟着数据走：只列这一屏里真正出现过的分类，缺构成的柱子仍按「已用」标。 */}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {stackLegend.map(item => (
              <Box key={`whale-legend-${item.kind}`} flexDirection="row" gap={1}>
                <Text color={item.color}>■</Text>
                <Text dimColor>{item.label}</Text>
              </Box>
            ))}
          </Box>
          <Text dimColor>{stackCaption(stacks.bars.length, stacks.peak, stacks.yMax)}</Text>
        </Box>
      )

    // 上下文的窗口上限、压缩阈值、记忆文件 / MCP / agent 数量都不再上屏：
    // 柱状图已经表达了「窗口被什么占着」，其余几项是读数之外的配置细节，
    // 读者打开面板时并不需要。整个「上下文」文字小节因此整段去掉。

    // 本地历史：今日一行、区间一行、逐模型一行。
    // 数据新鲜度贴在标题旁：过期时标黄，避免把 10 分钟前的数字当实时。
    const page = prefsNow.panelPage ?? DEFAULT_PREFS.panelPage
    const freshness = freshnessOf(record.lastRunAt, now, prefsNow.scanIntervalMs)
    // 本地数据的状态与新鲜度：数字本身在概览页，这里只留「数据可不可信」的提示。
    const historyHead = (
      <>
        <Text dimColor={!freshness.isStale}>
          {record.isRunning ? '正在统计…' : `本地 ${freshness.text}`}
          {freshness.isStale ? '（可能过期，下一轮自动重扫）' : ''}
        </Text>
        {record.lastError && <Text dimColor>统计失败：{clip(record.lastError, 60)}</Text>}
        {!record.isRunning && !record.lastError && !today && (
          <Text dimColor>还没有统计结果</Text>
        )}
      </>
    )

    // 页签：概览 / 模型，对应原生用量页的两个标签。
    const pageTabs = (
      <Box flexDirection="row" gap={1} marginTop={1}>
        {(
          [
            { id: 'overview', label: '概览' },
            { id: 'models', label: '模型' },
          ] as const
        ).map(tab => (
          <Button
            key={`whale-tab-${tab.id}`}
            plain
            label={page === tab.id ? `[${tab.label}]` : tab.label}
            onPress={() => {
              void (async () => {
                const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                  ...(latest.value ?? DEFAULT_PREFS),
                  panelPage: tab.id,
                })
              })()
            }}
          />
        ))}
      </Box>
    )

    // ---------------- 概览：六张卡 + 热图，同一个编组 ----------------
    //
    // 「概览 / 模型」两页共用这份本地扫描结果。
    const overview = data?.overview

    // 六张卡不是自由换行，而是按窗口宽度选一种**固定列数**的排法：
    // 6 列 / 3 列 / 2 列 / 1 列，对应 1×6、2×3、3×2、6×1。选谁只看一行能放下
    // 几张——卡片有最小可读宽度，放不下就换下一种排法，而不是硬挤成参差的换行。
    // 每种排法里卡片的宽度用 flexGrow 均分，所以整组永远铺满面板宽度。
    const cardValues = overviewCards(
      overview,
      data?.daily ?? [],
      prefsNow.historyDays,
      data?.total.cost ?? 0,
    )
    // 一行最多放几张：面板窄到放不下两张时就竖排。
    const cardsPerRow = width >= 96 ? 6 : width >= 48 ? 3 : width >= 26 ? 2 : 1
    const cardRows: StatCard[][] = []
    for (let index = 0; index < cardValues.length; index += cardsPerRow) {
      cardRows.push(cardValues.slice(index, index + cardsPerRow))
    }
    // 卡片宽度写死成一个整数：外层圆角框左右各有 1 列内边距、1 列边框，
    // 中间用 gap 隔开。余数不再分给某一张——那正是边缘参差的来源。
    // 面板极窄时夹一个下限，宁可让这一行溢出也不要压成 0 列。
    const cardGaps = Math.max(0, cardsPerRow - 1)
    const cardWidth = Math.max(
      8,
      Math.floor((width - 2 - 2 - cardGaps) / Math.max(1, cardsPerRow)),
    )

    // 热图：方块大小固定，列数随宽度增加，窗口天数跟着列数走。
    // 上限取扫描覆盖的天数——宽度再大也只有那么多天的数据，硬画出来只是
    // 一整段空格，还会让图注宣称一个并不存在的范围。
    const turnChartWidth = Math.max(80, Math.min(width * 8 - 16, 900))
    const heatWindow = Math.min(heatWindowDays(turnChartWidth), TURN_WINDOW_DAYS)
    const heatMetric = prefsNow.heatMetric ?? 'messages'
    const turnHistory = turnBars(data?.turnsDaily ?? [], heatWindow)
    const heatHeight = turnHeatHeight()
    const turnGrid = rasterizeTurnBars(turnHistory, 6)

    const overviewPage = (
      <>
        {/* 整组只有一个外框：六张卡与热图是同一个视觉单元，不是两件事。 */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={fill.borderColor}
          backgroundColor={fill.backgroundColor}
          paddingX={1}
        >
          {cardRows.map((row, rowIndex) => (
            <Box key={`whale-cardrow-${rowIndex}`} flexDirection="row" gap={1} width="100%">
              {row.map((card, index) => (
                // 每张卡都带同一个圆角框与同一支底色，卡片之间的留白靠外层 gap。
                // 宽度不给 flexGrow：那会让「值」长短不同的卡片算出的宽度有零头，
                // 六张卡右边缘就参差不齐。改成按列数算出同一个整数宽度，
                // 最后一张吃掉余数——边缘对齐，框也一样宽。
                <Box
                  key={`whale-card-${rowIndex}-${index}`}
                  flexDirection="column"
                  width={cardWidth}
                  borderStyle="round"
                  borderColor={fill.borderColor}
                  backgroundColor={fill.backgroundColor}
                  paddingX={1}
                >
                  <Text dimColor>{card.label}</Text>
                  <Text bold>{card.value}</Text>
                  {card.hint && <Text dimColor>{card.hint}</Text>}
                </Box>
              ))}
            </Box>
          ))}
          {turnHistory.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {Svg ? (
                <Svg
                  source={turnHeatSvg(turnHistory, turnChartWidth, heatMetric, chart)}
                  alt={turnBarsCaption(turnHistory)}
                  width={turnChartWidth}
                  height={heatHeight}
                />
              ) : (
                <>
                  {turnGrid.map((line, rowIndex) => (
                    <Box key={`whale-turn-${rowIndex}`} flexDirection="row">
                      {line.map((cell, index) => (
                        <Text
                          key={`whale-turn-${rowIndex}-${index}`}
                          color={cell === 'bar' ? 'claude' : 'inactive'}
                          dimColor={cell !== 'bar'}
                        >
                          {cell === 'bar' ? '█' : '▁'}
                        </Text>
                      ))}
                    </Box>
                  ))}
                  <Box flexDirection="row" justifyContent="flex-end">
                    <Text dimColor>{turnBarsCaption(turnHistory)}</Text>
                  </Box>
                </>
              )}
            </Box>
          )}
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center" marginTop={1} flexWrap="wrap">
          {Select && (
            <Select
              key="whale-heat-metric"
              label="色深"
              options={[
                { value: 'messages', label: '消息数' },
                { value: 'turns', label: '轮次' },
              ]}
              value={heatMetric}
              onSelect={(value: string) => {
                const metric = value === 'turns' ? 'turns' : 'messages'
                void (async () => {
                  const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                  await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                    ...(latest.value ?? DEFAULT_PREFS),
                    heatMetric: metric,
                  })
                })()
              }}
            />
          )}
          <Text dimColor>{overviewFooter(overview, data?.total.cost ?? 0)}</Text>
        </Box>
      </>
    )

    // ---------------- 模型页：逐日堆叠柱 + 每行一个模型 ----------------
    // 粒度由范围推出来，不单独给控件：两者绑死才不会被配成「30 天按月」
    // 这种看着有 30 根、其实只有 2 根的错配。
    const grain = modelGrainFor(prefsNow.historyDays)
    const stack = modelStackBars(data?.modelDaily ?? [], prefsNow.historyDays, MODEL_STACK_KEEP, grain)
    const modelDetails = modelDetailRows(data?.byModel ?? [])
    const modelChartWidth = Math.max(80, Math.min(width * 8 - 16, 900))
    // 柱内段序、图例、下方每行的色块共用这一份映射：颜色与模型的对应
    // 一旦错位，读者就会把 A 的花费读成 B 的。
    const modelColorOf = (name: string): string => {
      if (name === '其他') return chart.parts.other ?? '#7C8394'
      const index = stack.models.indexOf(name)
      return index < 0 ? '#7C8394' : modelFill(index, theme.isLight)
    }

    // 明细表按列对齐：模型名、输入、输出、金额各占固定宽度，数字右对齐。
    // 用 `displayWidth` 而不是 `length` 补空格——中文与英文混排时码点数不等于
    // 显示列数，按 length 补会让后面几列整体歪掉。
    const nameWidth = Math.min(
      16,
      Math.max(6, ...modelDetails.map(row => displayWidth(row.model))),
    )
    const inputTexts = modelDetails.map(row => tokens(row.input))
    const outputTexts = modelDetails.map(row => tokens(row.output))
    const costTexts = modelDetails.map(row =>
      row.cost === null ? '—' : usd(row.cost),
    )
    const inputWidth = Math.max(4, ...inputTexts.map(displayWidth))
    const outputWidth = Math.max(4, ...outputTexts.map(displayWidth))
    const costWidth = Math.max(4, ...costTexts.map(displayWidth))
    // 金额列只放数字：`未收录价格` 这种长文案会把整列撑开，把数字挤到一边。
    // 没有价格的模型记一个短横线，再在图注里说明它是什么意思。
    const hasUnpriced = modelDetails.some(row => row.cost === null)

    // 「范围」放在模型页：它改变的是逐日统计的窗口，与概览卡片无关——
    // 概览的六张卡一直看扫描到的全部数据，柱子与明细才跟着这个范围走。
    //
    // 只有四档，因为粒度和范围是绑定的：30 / 60 天按天、180 天按周、
    // 365 天按月。给一个 7 天之类的短范围反而没意义——柱子只有 7 根，
    // 而按天已经是能取到的最细粒度，再短也只是柱子变宽。
    const modelRange = Select ? (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Select
          key="whale-days"
          label="范围"
          options={[
            { value: '30', label: '30 天' },
            { value: '60', label: '60 天' },
            { value: '180', label: '180 天' },
            { value: '365', label: '365 天' },
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
              // 窗口拉长后本地扫描的数据不够：立刻重扫，别等下一个周期。
              isScanForced = true
            })()
          }}
        />
        <Text dimColor>{modelGrainLabel(grain)}</Text>
      </Box>
    ) : null

    const modelsPage = (
      <>
        {stack.bars.length === 0 ? (
          <Text dimColor>还没有统计数据</Text>
        ) : (
          <Box flexDirection="column" borderStyle="round" borderColor={fill.borderColor}
            backgroundColor={fill.backgroundColor} paddingX={1}>
            <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
              <Text bold dimColor>
                逐模型用量
              </Text>
              {modelRange}
            </Box>
            {Svg ? (
              <Svg
                source={modelStackSvg(stack.bars, modelChartWidth, stack.yMax, stack.models, chart)}
                alt={modelStackCaption(stack.bars, grain)}
                width={modelChartWidth}
                height={96}
              />
            ) : (
              <Text dimColor>{modelStackCaption(stack.bars, grain)}</Text>
            )}
            <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
              {stack.models.map(model => (
                <Box key={`whale-mlegend-${model}`} flexDirection="row" gap={1}>
                  <Text color={modelColorOf(model)}>■</Text>
                  <Text dimColor>{clip(model, 18)}</Text>
                </Box>
              ))}
            </Box>
            <Text dimColor>{modelStackCaption(stack.bars, grain)}</Text>
            <Box flexDirection="column" marginTop={1}>
              {/* 表头与数据行共用同一组列宽，所以各列能对齐。 */}
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{padCell('模型', nameWidth + 2)}</Text>
                <Text dimColor>{padCell('输入', inputWidth, 'right')}</Text>
                <Text dimColor>{padCell('输出', outputWidth, 'right')}</Text>
                <Text dimColor>{padCell('费用', costWidth, 'right')}</Text>
              </Box>
              {modelDetails.map((row, index) => (
                <Box key={`whale-mrow-${row.model}-${index}`} flexDirection="row" gap={1}>
                  <Text color={modelColorOf(row.model)}>■</Text>
                  <Text>{padCell(clip(row.model, nameWidth), nameWidth)}</Text>
                  <Text dimColor>{padCell(inputTexts[index] ?? '—', inputWidth, 'right')}</Text>
                  <Text dimColor>{padCell(outputTexts[index] ?? '—', outputWidth, 'right')}</Text>
                  <Text dimColor>{padCell(costTexts[index] ?? '—', costWidth, 'right')}</Text>
                </Box>
              ))}
            </Box>
            {hasUnpriced && (
              <Text dimColor>— 表示没有公开价格，不估算金额</Text>
            )}
            <Text dimColor>{overviewFooter(overview, data?.total.cost ?? 0)}</Text>
          </Box>
        )}
      </>
    )
    const controls = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        {/* 用量条口径是多选：`Select` 只支持单选，所以每个口径一个 Button，
            选中画成主按钮，未选中压暗。至少保留一项——全取消会让用量条
            变成一条空行，看起来像坏了。 */}
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text dimColor>用量条显示</Text>
          {BAND_METRIC_OPTIONS.map(option => {
            const isOn = metrics.includes(option.value)
            return (
              <Button
                key={`whale-metric-${option.value}`}
                plain
                variant={isOn ? 'primary' : undefined}
                dimColor={!isOn}
                label={option.label}
                onPress={() => {
                  const next = isOn
                    ? metrics.filter(item => item !== option.value)
                    : [...metrics, option.value]
                  if (next.length === 0) return
                  void (async () => {
                    const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                    await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                      ...(latest.value ?? DEFAULT_PREFS),
                      bandMetrics: BAND_METRIC_OPTIONS.map(o => o.value).filter(v => next.includes(v)),
                    })
                  })()
                }}
              />
            )
          })}
        </Box>
        <Button
          key="whale-turn-cost"
          plain
          label={prefsNow.isTurnCostOn ? '轮次费用提示 开' : '轮次费用提示 关'}
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
        <Button
          key="whale-band-toggle"
          plain
          label={prefsNow.isBandVisible ? '隐藏用量条' : '显示用量条'}
          onPress={() => {
            void (async () => {
              const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
              const nowPrefs = latest.value ?? DEFAULT_PREFS
              const isNextVisible = !nowPrefs.isBandVisible
              await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                ...nowPrefs,
                isBandVisible: isNextVisible,
              })
              // 收起后整个入口都没了，得告诉人怎么再叫出来，否则只能重开会话。
              if (!isNextVisible) $.ui.toast('/whale 可以呼出当前面板哦！')
            })()
          }}
        />
      </Box>
    )

    // 鲸鱼固定在面板右下角：数据在上，鲸鱼独占最后一行并靠右。
    // 对齐用显式列宽（bodyColumns）而不是 `100%`：后者要等父容器先解析出宽度，
    // 面板被压缩时会跟着内容浮动。
    return (
      <Box flexDirection="column">
        <Text bold>Claude 用量</Text>
        {windows}
        {session}
        {contextChart}
        {byModelSection}
        {pageTabs}
        {page === 'models' ? modelsPage : overviewPage}
        {controls}
        {/* 数据新鲜度贴在最底下：它是「上面那些数字有多可信」的脚注，
            放在开场反而挡在真正要看的数字前面。 */}
        {historyHead}
        {/* 鲸鱼独占最后一行、靠右。整只鲸鱼可点：`Svg` 自己没有 onPress，
            所以盖一层 Button。用一个 Button 而不是按行铺一排——桌面端把
            「label 全是空格」的按钮压成零宽，铺多少行都点不中；这里改用
            带真实字符（``）的行做 children，按钮就有了一块实打实的尺寸，
            每行都只是这块尺寸的一部分，整块一起响应一次点击。 */}
        <Box flexDirection="row" justifyContent="flex-end" width={width}>
          <Box position="relative">
            {whale}
            {/* 点击面积显式给死：绝对定位的 Box 只按内容撑开，而按钮的内容是
                一串不可见字符——不同表面（终端按列、桌面按像素）对它的宽度
                估算不一致，靠内容撑就可能撑不满鲸鱼。这里按鲸鱼的像素尺寸
                反算格数，把宽高直接写在 Box 上。 */}
            <Box
              position="absolute"
              top={0}
              left={0}
              width={whaleTapCols}
              height={whaleTapRows}
            >
              <Button
                key="whale-tap"
                plain
                label="展开小鲸鱼摘要"
                onPress={() => {
                  void (async () => {
                    const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                    const nowPrefs = latest.value ?? DEFAULT_PREFS
                    // 一次写入同时决定「按压形变」与「泡泡开合」：
                    // 分两次写会让鲸鱼先压下再单独弹回，中间多一帧闪动。
                    // 展开时再点一下＝立刻收起。
                    const isOpen = nowPrefs.isBubbleOpen !== true
                    await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                      ...nowPrefs,
                      isBubbleOpen: isOpen,
                      isWhalePressed: true,
                    })
                    // 弹回：沙箱里没有脚本，按压形变只能靠「改状态 → 重画一次」。
                    $.clock.after(PRESS_RELEASE_MS, () => {
                      void (async () => {
                        const back = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                        if ((back.value ?? DEFAULT_PREFS).isWhalePressed !== true) return
                        await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                          ...(back.value ?? DEFAULT_PREFS),
                          isWhalePressed: false,
                        })
                      })()
                    })
                    if (!isOpen) return
                    // 几秒后自动收起。到点时重新读一次状态，只在「仍然展开」
                    // 时才动它——期间用户可能已手动收起或再次展开。
                    $.clock.after(BUBBLE_AUTO_HIDE_MS, () => {
                      void (async () => {
                        const later = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                        const laterPrefs = later.value ?? DEFAULT_PREFS
                        if (laterPrefs.isBubbleOpen !== true) return
                        await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                          ...laterPrefs,
                          isBubbleOpen: false,
                        })
                      })()
                    })
                  })()
                }}
              >
                {Array.from({ length: whaleTapRows }, (_, row) => (
                  <Text key={`whale-tap-row-${row}`} dimColor>
                    {' '.repeat(whaleTapCols)}
                  </Text>
                ))}
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
}

export default register
