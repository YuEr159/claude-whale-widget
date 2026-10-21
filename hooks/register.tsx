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
 * 写法约束：`$` 在 hook 里以 `$.noun.method(...)` 的形式出现。`$` 可以传给
 * 本文件里声明的函数（校验器会把这些调用记成 `via <函数名>`，照样检查），
 * 但只在确实省掉重复时这么做——现在唯一的例子是 `tapWhale`，它给指针与
 * 键盘两条入口共用。纯计算一律放到 `usage-view.ts`。
 */
import type { EngineInterface, Register } from 'claude-code'

import type {
  ContextTurn,
  LocalUsage,
  ModelSpend,
  Prefs,
  ScanRecord,
  SessionTotals,
  TurnSpend,
} from '../types'
import { costOf, isEnginePriced } from './pricing.ts'
import { clip, displayWidth, padCell, pct, tokens, countdown, usd } from './format.ts'
import { UNPRICED, usdEstimate } from './provenance.ts'
import { BAND_METRIC_OPTIONS, bandSummary, bubbleLines, freshnessOf, toUsageView } from './usage-view.ts'
import {
  contextChartSvg,
  contextVisibleCount,
  heatWindowDays,
  modelFill,
  modelStackSvg,
  turnHeatHeight,
  turnHeatSvg,
} from './chart-art.ts'
import {
  barText,
  contextParts,
  contextView,
  maskModel,
  modelDetailRows,
  detailTableLayout,
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
  stackColor,
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
  toContextDetail,
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
  // 默认落在用量概览页。
  panelPage: 'overview',
  // 热图默认看轮次（用户真正发起请求的次数），可切到消息数。
  heatMetric: 'turns',
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
 * 正在计时的那两个鲸鱼定时器；`null` 表示没有在跑。
 *
 * **每次点击都要先 `cancel()` 掉上一轮的**，否则会互相打架：定时器到点时
 * 只看「此刻 isBubbleOpen 是不是真」，不看「这次展开是不是我负责的那一次」。
 * 于是在「展开 → 收起 → 再展开」之后，第一次留下的那个定时器仍会在它自己的
 * 4 秒到点，把第二次展开的气泡提前关掉——点得越快越容易撞上。
 *
 * 存模块级而不是 `$.state`：它们是执行期的一次性句柄，不是要持久化的偏好，
 * 写进状态只会让界面为一次内部计时多重绘一遍。
 */
let bubbleHideTimer: { cancel: () => void } | null = null
let pressReleaseTimer: { cancel: () => void } | null = null

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

/**
 * 点了一下鲸鱼：按压形变、泡泡开合、两个定时器的交接。
 *
 * 抽成函数是因为它有**两条**入口：`Client` 的指针事件（`ui.message`）与
 * 键盘可达的按钮（`Button.onPress`）。两条路必须做完全相同的事——分成
 * 两份实现，迟早有一条忘了取消旧定时器，或者只在一处记得按压形变。
 */
async function tapWhale($: EngineInterface): Promise<void> {
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
  // 这一轮点击接管两个定时器：先把上一轮留下的取消掉。
  // 不取消的话，上一次展开留下的自动收起仍会按它自己的
  // 节奏到点，把这一次刚展开的气泡提前关掉。
  pressReleaseTimer?.cancel()
  bubbleHideTimer?.cancel()
  pressReleaseTimer = null
  bubbleHideTimer = null
  // 弹回：沙箱里没有脚本，按压形变只能靠「改状态 → 重画一次」。
  pressReleaseTimer = $.clock.after(PRESS_RELEASE_MS, () => {
    pressReleaseTimer = null
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
  // 时才动它——期间用户可能已手动收起。
  bubbleHideTimer = $.clock.after(BUBBLE_AUTO_HIDE_MS, () => {
    bubbleHideTimer = null
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
}

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

  // 鲸鱼点击区的指针事件：`Client` 的 surface module 把「按了一下」post 回来。
  // 开合、按压形变、自动收起都在 `tapWhale` 里，和键盘那条路同一份实现。
  // 只认自己那个 key，别的 `Client` 的 post 不该被当点击。
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'whale-tap-area') return next(e)
    // `data` 来自代码，是不可信输入；只认形状对上、内容为 `tap` 的那条。
    const data = e.data as { kind?: unknown } | null
    if (!data || typeof data !== 'object' || data.kind !== 'tap') return next(e)
    await tapWhale($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {    const usage = e.usage
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
    // 空数组按默认处理：一条空白用量条比显示得多更糟。面板侧同一份判断
    // 写在 `metrics` 那段，两处口径必须一致。
    const metrics =
      Array.isArray(prefsNow.bandMetrics) && prefsNow.bandMetrics.length > 0
        ? prefsNow.bandMetrics
        : DEFAULT_PREFS.bandMetrics
    const summary = bandSummary(view, metrics, now)

    const { Box, Text, Button } = $.ui.resolve(e)
    // 注意：这里不能在 Text 里用 `<>` 或嵌套 Text。
    // 引擎的 `Fragment` 实现是「一个纵向 Box」，塞进 Text 就是
    // `Box inside an inline element`，整棵树被拒、引擎改画它自己的，
    // 用量条会直接消失。增删要分色，就在同一行里并排几个 Text。
    //
    // 「代码改动」选上之后**才有**增删，且始终带 diffAdded / diffRemoved
    // 两种颜色。之前写反了：选中时它被拼进摘要、颜色全丢，未选中时反倒
    // 作为后缀带着颜色出现——选上反而更难读，这就是「效果反了」。
    const showsDiff = metrics.includes('diff')
    const hasDiff = totals.linesAdded > 0 || totals.linesRemoved > 0
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
        {/* 选上「代码改动」但还没改过：明说，不留空。 */}
        {showsDiff && !hasDiff && <Text dimColor>本会话还没有代码改动</Text>}
        {/* 选上才画，且两个方向各用一支色。为零的一边不画
            （`+5` 比 `+5 -0` 干净）。 */}
        {showsDiff && totals.linesAdded > 0 && (
          <Text color="diffAdded">{`+${totals.linesAdded}`}</Text>
        )}
        {showsDiff && totals.linesRemoved > 0 && (
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
    const Client = 'Client' in table ? table.Client : undefined

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
    // 点击区：把整只鲸鱼（含气泡，气泡画在同一张 SVG 里、占画布上方大半）
    // 铺满。
    //
    // 单位对不上：`Box` 的 `width`/`height` 是字符格，`Svg` 的是 CSS 像素，
    // 引擎不告诉插件一格是多少像素。只能按等宽字体的经验值反算，两轴取的
    // 值刻意不同：
    //
    //   - **横向按最窄的常见字宽（7px）**。字宽 7.2~8.4px 都常见，按 8 算
    //     会在 300px 宽的鲸鱼右缘留下十几像素点不中的竖边；宁可多出几格
    //     溢进左边的空白（看不见），也不能少。
    //   - **纵向按 16px**。行高常见 17~19px，这个数只会多出几十像素；而鲸鱼
    //     就在面板最底部，向下溢出的部分是面板底边，压不到别的内容。
    //
    // 绝对定位不占流，多出来的部分被站点裁掉，不会撑高面板。
    const TAP_CELL_PX = 7
    const TAP_ROW_PX = 16
    const whaleTapRows = Math.max(1, Math.ceil(whaleHeight / TAP_ROW_PX))
    const whaleTapCols = Math.max(1, Math.ceil(whaleWidth / TAP_CELL_PX))

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
    //
    // **「花费」这一格要能说明它可不可信。** 它取的是引擎 `/cost` 的会话
    // 累计；引擎只认 Anthropic 第一方的价目表，遇到不认识的名字（第三方
    // 网关的那些）就按**默认模型的价格**估——见 `isEnginePriced` 的注释。
    //
    // 后果很具体（本机实测）：同一个会话、同一批 token，DeepSeek Flash 按
    // 官方价是 $3.05，引擎按默认模型估成 $258.98——于是面板上的「本会话
    // 花费」反而高于「用量概览」里跨 30 天的总额。两个数字都对，只是口径
    // 不同；并排放着却不说明，就成了自相矛盾。
    //
    // 判据是「本会话用过引擎不认识的模型」。**不能**用 `byModel[].cost ===
    // null`：DeepSeek 在**插件**的价目表里有价（那是概览用的），引擎那边
    // 仍然不认识，两件事不一样。
    const hasNonEngineModel = byModel.some(entry => !isEnginePriced(entry.model))
    // 用显式的 `<Box flexDirection="column">` 而不是 `<>…</>`：`Fragment`
    // 的类型声明是 `children?: RenderNode[]`，容不下条件里的 `null` / `false`
    // 与单个元素，引擎自己的 `ElementConstructor` 才收宽类型 `RenderChildren`。
    // 两者在引擎里是同一件事——`Fragment` 文档原话是「a column Box around
    // the children」——所以换成显式 Box 运行时等价，只是类型能过。
    const session = (
      <Box flexDirection="column">
        <Text>
          花费 {usdEstimate(view.costUsd)}
          {hasNonEngineModel ? '（含引擎未收录的模型，按默认模型价估）' : ''} · 上下文{' '}
          {pct(view.contextPercent)}
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
      </Box>
    )

    // 上下文占比的堆叠柱状图：每根柱子是一轮，柱内按「已用 / 压缩缓冲 / 空闲」
    // 分段堆叠。高度按窗口的 100% 算，所以柱子之间的高低差直接就是占比走势。
    const bufferPct =
      contextDetail && contextDetail.rawMaxTokens > 0 && contextDetail.autoCompactThreshold
        ? ((contextDetail.rawMaxTokens - contextDetail.autoCompactThreshold) /
            contextDetail.rawMaxTokens) *
          100
        : 0
    // 显示最近几轮、柱子、图例、图注全由 `contextView` 一处算出：宽度决定
    // 能放几根，图注与图例跟着同一份结果走。以前这里写死 60 轮、SVG 内部
    // 又按宽度裁一次，窄画布下就会出现「图注说 60 轮、图上 34 根」。
    const chartWidth = Math.max(80, Math.min(width * 8 - 16, 640))
    const contextScreen = contextView(contextTurns, chartWidth, Math.max(0, bufferPct), theme.isLight)

    const contextPage = (
      <Box flexDirection="column">
        {contextTurns.length === 0 ? (
          <Text dimColor>还没有逐轮数据</Text>
        ) : (
          // 图与图例一起装进一块圆角里：它们说的是同一件事（这一屏每轮的
          // 构成），分开铺在页面底色上会像是两块碰巧挨着的内容。底色比
          // 大框深一档，读起来是「嵌进去的一块」，而不是又浮起来一层。
          <Box
            key="whale-context-inset"
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.inset.borderColor}
            backgroundColor={theme.inset.backgroundColor}
            paddingX={1}
          >
            {Svg ? (
              <Svg
                source={contextChartSvg(
                  contextScreen.turns,
                  chartWidth,
                  contextScreen.turns.length,
                  Math.max(0, bufferPct),
                  chart,
                )}
                alt={contextScreen.caption}
                width={chartWidth}
                height={112}
              />
            ) : (
              <>
                {rasterizeStacks(contextScreen.bars, width >= 60 ? 8 : 6).map((line, rowIndex) => (
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
              {contextScreen.legend.map(item => (
                <Box key={`whale-legend-${item.kind}`} flexDirection="row" gap={1}>
                  <Text color={item.color}>■</Text>
                  <Text dimColor>{item.label}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
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
      <Box flexDirection="column">
        <Text dimColor={!freshness.isStale}>
          {record.isRunning ? '正在统计…' : `本地 ${freshness.text}`}
          {freshness.isStale ? '（可能过期，下一轮自动重扫）' : ''}
        </Text>
        {record.lastError && <Text dimColor>统计失败：{clip(record.lastError, 60)}</Text>}
        {!record.isRunning && !record.lastError && !today && (
          <Text dimColor>还没有统计结果</Text>
        )}
      </Box>
    )

    // 页签：用量概览 / 模型分布 / 本会话上下文占比 / 设置。
    //
    // **不要在外面套带边框的 Box**。引擎文档写明 `Button` 在桌面端画成
    // 原生按钮，命中区只包住它自己的内容；Box 的边框在按钮之外，那一圈
    // 永远点不到——这正是「看着是个框、点上去只有文字有反应」的原因。
    // 只补内边距没用：内容变宽了，边框仍然在命中区外。
    //
    // 所以按钮自己就是那块可见的方块：底色说「选中了没有」，整块都能点。
    // 字符界面里圆角边框与整块可点不可兼得，这里选后者。
    const tabIds = [
      { id: 'overview', label: '用量概览' },
      { id: 'models', label: '模型分布' },
      { id: 'context', label: '本会话上下文占比' },
      { id: 'settings', label: '设置' },
    ] as const
    const pageTabs = (
      <Box flexDirection="row" gap={1} marginBottom={1} flexWrap="wrap">
        {tabIds.map(tab => {
          const isActive = page === tab.id
          return (
            <Button
              key={`whale-tab-${tab.id}`}
              plain
              label={tab.label}
              onPress={() => {
                void (async () => {
                  const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                  await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                    ...(latest.value ?? DEFAULT_PREFS),
                    panelPage: tab.id,
                  })
                })()
              }}
            >
              {/* 左右各一格 NBSP 留白（普通空格会被裁掉），落在按钮命中区里。
                  未选中的也有底色——它仍然是一块方块，只是暗下去，而不是
                  「框不见了、只剩文字」。 */}
              <Text
                backgroundColor={
                  isActive ? theme.tabActive.backgroundColor : fill.backgroundColor
                }
                color={isActive ? theme.tabActiveText : undefined}
                dimColor={!isActive}
                bold={isActive}
              >
                {' ' + tab.label + ' '}
              </Text>
            </Button>
          )
        })}
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
    // 卡片宽度写死成一个整数，按列数均分。要扣掉的是**这一行真正可用的宽度**：
    //   面板宽度 width
    //   − 4   外层大框：左右各 1 列边框 + 1 列内边距
    //   − 卡片之间的 gap 总数
    // 余数不再分给某一张——那正是边缘参差的来源。
    // 面板极窄时夹一个下限，宁可让这一行溢出也不要压成 0 列。
    const cardGaps = Math.max(0, cardsPerRow - 1)
    const cardWidth = Math.max(
      8,
      Math.floor((width - 4 - cardGaps) / Math.max(1, cardsPerRow)),
    )

    // 热图：方块大小固定，列数随宽度增加，窗口天数跟着列数走。
    // 上限取扫描覆盖的天数——宽度再大也只有那么多天的数据，硬画出来只是
    // 一整段空格，还会让图注宣称一个并不存在的范围。
    const turnChartWidth = Math.max(80, Math.min(width * 8 - 16, 900))
    const heatWindow = Math.min(heatWindowDays(turnChartWidth), TURN_WINDOW_DAYS)
    // 回退值必须与 `DEFAULT_PREFS.heatMetric` 一致：两处写不同的档，状态里
    // 一旦存了个 `undefined`，界面就会跳到与「默认」相反的那一档。
    const heatMetric = prefsNow.heatMetric ?? DEFAULT_PREFS.heatMetric
    const turnHistory = turnBars(data?.turnsDaily ?? [], heatWindow)
    const heatHeight = turnHeatHeight()
    const turnGrid = rasterizeTurnBars(turnHistory, 6)

    const overviewPage = (
      <>
        {/* 外框由下面的 pageFrame 统一给（页签与两页内容共用一个框），
            这里只排内容：六张卡 + 热图是同一个视觉单元。 */}
        <Box flexDirection="column" gap={1}>
          {cardRows.map((row, rowIndex) => (
            <Box key={`whale-cardrow-${rowIndex}`} flexDirection="row" gap={1} width="100%">
              {row.map((card, index) => (
                // 每张卡都带同一个圆角框与同一支底色。横向靠这一行的 gap、
                // 纵向靠外层那个 gap={1}——两处都用 1 列/行，上下与左右
                // 的缝才一样宽。只在横向上留缝的话，换行之后两行卡片会
                // 贴在一起，看起来像一整块被切开。
                // 宽度不给 flexGrow：那会让「值」长短不同的卡片算出的宽度有零头，
                // 六张卡右边缘就参差不齐。改成按列数算出同一个整数宽度。
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
            // marginTop 由外层 gap={1} 给，这里不再重复加，否则热图与
            // 最后一行卡片之间会是 2 行、而卡片之间只有 1 行。
            <Box flexDirection="column">
              {Svg ? (
                <Svg
                  source={turnHeatSvg(turnHistory, turnChartWidth, heatMetric, chart)}
                  alt={turnBarsCaption(turnHistory)}
                  width={turnChartWidth}
                  height={heatHeight}
                />
              ) : (
                <Box flexDirection="column">
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
                </Box>
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
    // 粒度由范围推出来，不单独给控件：两者绑死才不会被配成「30 天按周」
    // 这种看着有 30 根、其实只有 5 根的错配。
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
    // 列宽与每一格的文字都由 `detailTableLayout` 一处算出——它有一套必须
    // 整体成立的约束（数字列放得下最长的读数、列间要有缝隙、只有模型名
    // 可以截断），放在渲染里既测不了、错了也很难看出来。
    const detailColumns = detailTableLayout(modelDetails, width)
    const { nameWidth, inputWidth, outputWidth, costWidth, gap: tableGap } = detailColumns
    const inputTexts = detailColumns.input
    const outputTexts = detailColumns.output
    const costTexts = detailColumns.cost

    // 「范围」放在模型页：它改变的是逐日统计的窗口，与概览卡片无关——
    // 概览的六张卡一直看扫描到的全部数据，柱子与明细才跟着这个范围走。
    //
    // 只有四档，因为粒度和范围是绑定的：30 / 60 天按天、180 / 365 天按周。
    // 365 天仍用按周：52 根柱子每根约 16px，比 60 天按天那档还宽，而按月
    // 只剩 12 根，「这个月哪一周花得多」就看不出来了。给一个 7 天之类的短
    // 范围反而没意义——柱子只有 7 根，而按天已经是能取到的最细粒度。
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
      <Box flexDirection="column">
        {stack.bars.length === 0 ? (
          <Text dimColor>还没有统计数据</Text>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
              <Text bold dimColor>
                逐模型用量
              </Text>
              {modelRange}
            </Box>
            {/* 图、图例、图注一起装进一块圆角：它们说的是同一件事（这一段
                时间每个模型用了多少），分开铺在页面底色上会像是三块碰巧挨着
                的内容。标题与「范围」留在外面——那是这一页的名字与控件，
                不属于图本身。 */}
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={theme.inset.borderColor}
              backgroundColor={theme.inset.backgroundColor}
              paddingX={1}
              marginTop={1}
            >
              {Svg ? (
                <Svg
                  source={modelStackSvg(stack.bars, modelChartWidth, stack.yMax, stack.models, chart, grain)}
                  alt={modelStackCaption(stack.bars, grain)}
                  width={modelChartWidth}
                  height={110}
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
            </Box>
            {/* 明细表单独一块圆角：它和图是两种读法（形状 vs 具体数字），
                分开才看得出是两张表，而不是一张图拖了一条尾巴。 */}
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={theme.inset.borderColor}
              backgroundColor={theme.inset.backgroundColor}
              paddingX={1}
              marginTop={1}
            >
              {/* 表头与数据行共用同一组列宽与同一个 `gap`，所以各列能对齐。
                  表头第一列要补出数据行那个色块的**位置与缝隙**：
                  数据行是 `■` + gap + 模型名，表头就用一格空白替色块，
                  后面照常隔一个 gap——两行的格子数必须相同，少一格右边
                  三列会整体错开。 */}
              <Box flexDirection="row" gap={tableGap}>
                <Text dimColor>{padCell('', 1)}</Text>
                <Text dimColor>{padCell(clip('模型', nameWidth), nameWidth)}</Text>
                <Text dimColor>{padCell(clip('输入', inputWidth), inputWidth, 'right')}</Text>
                <Text dimColor>{padCell(clip('输出', outputWidth), outputWidth, 'right')}</Text>
                <Text dimColor>{padCell(clip('费用', costWidth), costWidth, 'right')}</Text>
              </Box>
              {modelDetails.map((row, index) => (
                <Box key={`whale-mrow-${row.model}-${index}`} flexDirection="row" gap={tableGap}>
                  <Text color={modelColorOf(row.model)}>■</Text>
                  <Text>{padCell(clip(row.model, nameWidth), nameWidth)}</Text>
                  {/* 数字也用 clip：列宽封顶 9 格，`1.20万亿` 这种极端值
                      仍可能占满 8 格，留一格缓冲；再长的就截断，不让它
                      把后面的列推歪。 */}
                  <Text dimColor>
                    {padCell(clip(inputTexts[index] ?? '—', inputWidth), inputWidth, 'right')}
                  </Text>
                  <Text dimColor>
                    {padCell(clip(outputTexts[index] ?? '—', outputWidth), outputWidth, 'right')}
                  </Text>
                  <Text dimColor>
                    {padCell(clip(costTexts[index] ?? '—', costWidth), costWidth, 'right')}
                  </Text>
                </Box>
              ))}
            </Box>
            <Text dimColor>{overviewFooter(overview, data?.total.cost ?? 0)}</Text>
          </Box>
        )}
      </Box>
    )
    // 小框按钮：与页签同一套做法——按钮自己就是那块可见的方块，外面不套
    // 带边框的 Box。Box 的边框落在按钮命中区之外，点上去只有文字有反应。
    //
    // 选中与未选中都保留底色，区别在明暗：未选中也仍是一块方块，只是暗下去。
    // 之前未选中时只剩文字、框（哪怕画着）点不动，看起来像「只是把颜色剥夺了」。
    const chip = (
      key: string,
      label: string,
      isActive: boolean,
      onPress: () => void,
    ) => (
      <Button key={key} plain label={label} onPress={onPress}>
        <Text
          backgroundColor={isActive ? theme.tabActive.backgroundColor : fill.backgroundColor}
          color={isActive ? theme.tabActiveText : undefined}
          dimColor={!isActive}
          bold={isActive}
        >
          {' ' + label + ' '}
        </Text>
      </Button>
    )

    // 设置页：四组设置。它们曾排在面板最下方，与上面的几页内容并列，读起来
    // 像一块没名字的区域；收进「设置」页签之后，每一块都归属于一个明确的页。
    //
    // 所有项一律是**开关**：亮＝这一项开着。不做「按一下切换标签」的动作按钮
    // ——同一个视觉组里混两种语义，读者没法从「亮不亮」判断当前状态。
    const settingsPage = (
      <Box flexDirection="column" gap={1}>
        {/* 用量条口径是多选：每项一个方块，亮着的就是会出现在条子上的。
            至少保留一项——全取消会让用量条变成一条空行，看起来像坏了。
            点到最后一项时给一句提示，不要静默吞掉那次点击。 */}
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text dimColor>用量条显示</Text>
          {BAND_METRIC_OPTIONS.map(option => {
            const isOn = metrics.includes(option.value)
            return chip(`whale-metric-${option.value}`, option.label, isOn, () => {
              const next = isOn
                ? metrics.filter(item => item !== option.value)
                : [...metrics, option.value]
              if (next.length === 0) {
                $.ui.toast('用量条至少要留一项，否则会变成一条空行。')
                return
              }
              void (async () => {
                const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                  ...(latest.value ?? DEFAULT_PREFS),
                  bandMetrics: BAND_METRIC_OPTIONS.map(o => o.value).filter(v => next.includes(v)),
                })
              })()
            })
          })}
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text dimColor>面板</Text>
          {chip('whale-turn-cost', '轮次费用提示', prefsNow.isTurnCostOn ?? DEFAULT_PREFS.isTurnCostOn, () => {
            void (async () => {
              const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
              const nowPrefs = latest.value ?? DEFAULT_PREFS
              await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                ...nowPrefs,
                isTurnCostOn: !nowPrefs.isTurnCostOn,
              })
            })()
          })}
          {/* 这也是开关：亮＝用量条正在显示。点它把用量条收起来或叫回来。
              之前这里写死 `false`，于是它永远不亮、也读不出当前状态。 */}
          {chip('whale-band-toggle', '显示用量条', prefsNow.isBandVisible ?? DEFAULT_PREFS.isBandVisible, () => {
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
          })}
        </Box>
      </Box>
    )

    // 鲸鱼固定在面板右下角：数据在上，鲸鱼独占最后一行并靠右。
    // 对齐用显式列宽（bodyColumns）而不是 `100%`：后者要等父容器先解析出宽度，
    // 面板被压缩时会跟着内容浮动。
    //
    // **根 Box 要撑满整屏高度**（`minHeight` = 正文可用行数）。不撑的话，
    // 整棵树只有内容那么高，鲸鱼就贴着最后一行内容、悬在面板半空——窗口
    // 拉得越高，底下那片空白越大，而「右下角」这个说法也就不成立了。
    // 内容超过一屏时 `minHeight` 不起作用，面板自己滚动，鲸鱼仍在最后一行。
    //
    // 只对停靠（dock）的面板这么做：内联面板的高度本来就由内容决定
    // （文档原文 "Inline the frame fits the tree"），撑满会凭空拉出一长条空白。
    const bodyRows = e.props.scroll?.bodyRows
    const minHeight =
      e.props.placement === 'dock' && typeof bodyRows === 'number' && bodyRows > 0
        ? bodyRows
        : undefined
    return (
      <Box flexDirection="column" minHeight={minHeight}>
        <Text bold>Claude 用量</Text>
        {windows}
        {session}
        {/* 四个页签与各自内容共用一个外框：页签是这个框的「标签栏」，
            内容是当前页的读数。它们属于同一个视觉单元，分开画成两个框会
            让人以为页签是面板级导航、内容又是另一块卡片。 */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={fill.borderColor}
          backgroundColor={fill.backgroundColor}
          paddingX={1}
          marginTop={1}
        >
          {pageTabs}
          {page === 'settings'
            ? settingsPage
            : page === 'context'
              ? contextPage
              : page === 'models'
                ? modelsPage
                : overviewPage}
        </Box>
        {/* 撑开剩下的高度，把下面两行压到面板底边。
            `flexGrow` 只在父 Box 有确定高度时才有可分配的余量，所以根 Box
            的 `minHeight` 是它的前提——两者缺一，鲸鱼都会跟着内容往上跑。 */}
        {minHeight !== undefined && <Box key="whale-spacer" flexGrow={1} />}
        {/* 数据新鲜度贴在最底下：它是「上面那些数字有多可信」的脚注，
            放在开场反而挡在真正要看的数字前面。 */}
        {historyHead}
        {/* 鲸鱼独占最后一行、靠右。整只鲸鱼可点：`Svg` 自己没有 onPress，
            所以盖一层 Button。

            三件事必须同时成立，少一件就点不中：
            1. **有内容撑出尺寸**。绝对定位的 Box 只按内容撑开，空 Box 是 0×0。
               用 U+2800（盲文空白）而不是普通空格：它有实际宽度，但看起来
               是空的，不会在鲸鱼上盖出一片可见的方块。
            2. **尺寸显式给死**。不同表面对「一格多宽」的估算不一致，光靠内容
               撑可能撑不满；Box 上再写一遍 width/height 兜底。
            3. **label 不参与绘制**。有 children 时 label 只作控件名（无障碍
               读出来用），不会被画到鲸鱼上——之前写的是「展开小鲸鱼摘要」，
               终端会把这七个字直接印在鲸鱼身上。 */}
        <Box flexDirection="row" justifyContent="flex-end" width={width}>
          <Box position="relative">
            {whale}
            {/* 指针点击区：整片盖住鲸鱼。
                `Button` 在桌面端只让出一行文字的高度（实测），多行 children
                撑不高它——它是个原生按钮，尺寸由绘制端定。`Client` 是引擎为
                「一整片区域响应指针」给的元素：区域按 `width`/`height` 铺开，
                `onPointer` 收到区域内的格坐标。

                终端没有 `Client`，那边靠下面的 `Button` 接点击。 */}
            {Client ? (
              <Client
                key="whale-tap-area"
                module="./whale-tap.tsx"
                props={{ rows: whaleTapRows, cols: whaleTapCols }}
                width={whaleTapCols}
                height={whaleTapRows}
              />
            ) : null}
            {/* 键盘入口：一行高的透明按钮。指针命中由上面的 `Client` 负责，
                这一层只保证「Tab 能到达、Enter 能按下」。 */}
            <Box position="absolute" top={0} left={0} width={whaleTapCols} height={1}>
              <Button
                key="whale-tap"
                plain
                // **不要传 `label`。** 引擎文档说「有 children 时 label 只作
                // 控件名、不参与绘制」，终端那份实现确实如此；但桌面端把
                // Button 画成原生按钮、把 label 当按钮文字画了出来——于是
                // 「展开小鲸鱼摘要」七个字直接压在鲸鱼身上。
                //
                // children 是盲文空白：有实际宽度但看起来是空的，不会在
                // 鲸鱼上盖出一片可见的方块。
                onPress={() => void tapWhale($)}
              >
                <Text>{'⠀'.repeat(whaleTapCols)}</Text>
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
}

export default register
