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
import { costOf, isEnginePriced } from './pricing.ts'
import { clip, pct, tokens, countdown } from './format.ts'
import { UNPRICED, usdEstimate } from './provenance.ts'
import { BAND_METRIC_OPTIONS, bandSummary, bubblePages, freshnessOf, toUsageView } from './usage-view.ts'
import {
  contextChartSvg,
  heatWindowDays,
  modelFill,
  modelStackSvg,
  turnHeatHeight,
  turnHeatSvg,
} from './chart-art.ts'
import {
  contextParts,
  contextView,
  historyContextTurns,
  mergeContextHistory,
  modelDetailRows,
  detailTableLayout,
  CHIP_COLUMN,
  LEGEND_SKELETON_KINDS,
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
  bandMetricsOf,
  countPatchLines,
  duration,
  limitRows,
  meterText,
  sessionCostOf,
  toContextDetail,
  EMPTY_TOTALS,
} from './usage-detail.ts'
import { BAND_TICK_MS, WHALE_ASPECT, bandWhaleGlyph, bandWhaleStateOf, BAND_WHALE_TEXT_COLS, emblemOf, moodOf, whaleSizeFor, whaleSvg } from './whale-art.ts'
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
  // 立绘默认 1 倍；设置页里可调。
  whaleScale: 1,
}

/**
 * 立绘缩放档位。
 *
 * 引擎没有滑块，所以「拖动条」是一排档位：点哪一档就跳到哪个比例，
 * 选中那档高亮。1.0 是默认（即 `WHALE_MAX_WIDTH`）。
 *
 * 上限给到 200%：面板宽到 100 列时，760px 的立绘仍放得下；放不下时
 * `whaleSizeFor` 会按可用宽度收住，不会溢出到面板外。
 */
const WHALE_SCALES = [0.25, 0.5, 1, 1.5, 2] as const

/** 缩放档位落在区间外时的夹取。 */
function clampScale(value: number): number {
  const lowest = WHALE_SCALES[0]!
  const highest = WHALE_SCALES[WHALE_SCALES.length - 1]!
  return Math.max(lowest, Math.min(highest, value))
}

const EMPTY_SCAN: ScanRecord = {
  isRunning: false,
  lastRunAt: null,
  lastError: null,
  data: null,
}

/** 定时器多久检查一次「该不该扫描」；真正的判断在间隔比较里。 */
const SCAN_TICK_MS = 15_000

/**
 * 鲸鱼泡泡轮播的换页间隔。
 *
 * 泡泡只是「扫一眼」的地方：换得太慢，读者永远只看得到第一页；换得太快，
 * 还没读完就翻走了。6 秒够读完三行短句，又不至于让一页霸占整个会话。
 */
const BUBBLE_PAGE_MS = 6_000

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

/**
 * 是否刚发生过一次压缩、还没落到某一轮的记录上。
 *
 * 压缩是两轮之间的动作，没有自己的柱子；下一次 `turn.complete` 记下这一轮
 * 时把这个标记转成 `afterCompact`，图上就能标出「上下文骤降是因为压缩」。
 * 只活在模块内存里：重载插件后不再标旧记录，但旧记录本来也已经画过了。
 */
let isCompactPending = false

/**
 * 引擎是否正在跑一轮对话（`turn.start` → `turn.complete` / `turn.abort`）。
 *
 * 用量条的小鲸鱼靠它决定是停着还是划水——「是不是在干活」这件事本身就是
 * 一条信息，比一个永远在动的装饰有用。
 *
 * 只活在模块内存里，不写 `$.state`：写状态会额外触发一次重绘，而这个值
 * 每次 `turn.start` / `turn.complete` 都会变，等于每轮多两次全量重绘。
 * 插件重载后它会回到 `false`——下一轮 `turn.start` 会重新置真，中间那一小段
 * 最坏情况是把「正在跑」显示成「空闲」，不影响任何数字。
 */
let isSessionRunning = false

/**
 * 圆角框的底色，第一次读 `/config` 后缓存。
 *
 * 主题在一次会话里基本不变，而面板重绘很频繁；`null` 表示「还没读过」。
 *
 * **换了主题由 `config.set` 事件把它清空**，下一次重绘自然重读——模块级变量
 * 不会因为关掉再打开面板就归零，早先那句「换主题要重开面板才生效」其实
 * 根本不成立，整场会话都会停在旧主题。
 */
let themeCache: ThemeColors | null = null

/**
 * 鲸鱼浮动动画的零点（毫秒），模块加载时定一次，之后不再变。
 *
 * **面板现在不用它了**（面板鲸鱼不浮动，见 `Pane` 里 `<Svg>` 处的说明）。
 * 保留是因为 `whaleSvg` 的负 `begin` 机制还在：将来若引擎支持在静态图片
 * 路径里画内嵌位图，或者面板改用别的绘制方式，这个零点就是接回去的地方。
 *
 * 为什么需要固定零点：宿主每次重绘都换一份新的 SVG 文档，SMIL 时间轴归零，
 * 浮动就从最上面那一帧重来。修法是给动画一个负的 `begin`，把它拨到当前
 * 相位。相位必须按**一个固定零点**算；每帧重算零点等于相位永远为 0。
 *
 * 取 `Date.now()` 而不是 `$.clock.now()`：这里在模块加载时执行，还没有 `$`。
 * 宿主时钟与墙钟在相位上只差一个常量，而这个常量本来就被零点吸收了。
 */
const WHALE_FLOAT_EPOCH = Date.now()

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
        //
        // 第四个参数是**当前会话的 id**：上下文窗口是会话级的东西，脚本据此
        // 只回传这一场对话的逐轮占用曲线。这个 id 就是 transcript 的文件名，
        // 与脚本自己从文件名取到的是同一个值。
        const sessionId = await $.session.id().catch(() => '')
        const result = await $.process.run(
          ['node', `${$.plugin.root}/scripts/usage-scan.mjs`, root, String(days), sessionId],
          { timeoutMs: 120_000, stdin: scanCache.length > 0 ? JSON.stringify(scanCache) : '' },
        )
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().slice(0, 300) || `退出码 ${result.exitCode}`)
        }
        // **stdout 超过 4 MiB 会被引擎截断。** 截断后的半截 JSON 解析必然
        // 失败，而每一轮都从同一份旧缓存重试，本地用量会永久停在报错上。
        // 这里明确认出来、丢掉缓存、下一轮从全量扫描重来。
        if (result.isStdoutTruncated) {
          scanCache = []
          throw new Error('扫描输出超过 4 MiB，已丢弃增量缓存，下一轮将全量重扫')
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

    // 定期请求重绘：倒计时、额度百分比、数据新鲜度都是渲染时算的，不重绘
    // 就是一张冻结的截图。关闭的面板由引擎缓存，不会被重绘。
    //
    // **一条 6 秒的时钟就够，不必再挂 30 秒那条。** 6 秒的周期整除 30 秒，
    // 「每 30 秒刷新一次倒计时」的需求已经被它完全覆盖；多挂一条只会让
    // 每 30 秒有两个 `invalidate` 落在同一时刻，引擎可能对着同一份 props
    // 连画两遍。而这个频率同时也是泡泡轮播的换页节奏——靠 30 秒那条翻页
    // 太慢，读者整个会话都停在第一页。
    //
    // 面板关着时重绘是空转（引擎会缓存），但 `every` 无法知道面板开没开；
    // 6 秒一次的空转代价远小于「打开面板半天不翻页」的观感损失。
    $.clock.every(BUBBLE_PAGE_MS, () => {
      $.ui.invalidate('ui.render')
    })

    // 用量条的字符画按帧刷新：睡觉攒字母每拍 0.2 秒，节拍比它慢就会跳帧，
    // 「一个字母一个字母蹦出来」会变成「一次蹦两三个」。干活 0.4 秒、忙
    // 0.3 秒也都落在这条节拍的采样精度里。
    //
    // 这条只驱动**一行高的小树**；`session.usage()` 在引擎侧是缓存值
    // （新数字由 `session.measure` 推），所以多出来的重绘很便宜。桌面端
    // `$.ui.invalidate` 上限每秒十次，200ms 一拍是五次，余量一半。
    $.clock.every(BAND_TICK_MS, () => {
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

  // 主题换了：把缓存清掉，下一次重绘自然重读 `/config`。
  //
  // 模块级变量不会因为关掉再打开面板就归零（只有插件重载才会），所以早先
  // 「换主题要重开面板才生效」那句其实不成立——整场会话都停在旧主题，
  // 浅色界面配深色图表，对比度问题被静默保留。
  on('config.set', async ($, e, next) => {
    if (e.key === 'theme') themeCache = null
    return next(e)
  })

  /**
   * 一轮开始：用量条的小鲸鱼从「停着」变成「划水」。
   *
   * 只记模块变量、不写 `$.state`（写状态会多一次全量重绘，而这件事每轮都
   * 发生两次）。`next(e)` 原样往下走——这个钩子只观察，不改变任何行为。
   *
   * **`turn.start` 的输入里没有 `agentId`**（只有 `text` 与 `turnId`），
   * 所以这里无法区分主会话与子代理；`turn.complete` 那边有 `agentId`，
   * 但那边只负责落回静止——最坏情况是子代理起轮时条子划一会儿水，
   * 无害。
   */
  on('turn.start', async (_$, e, next) => {
    isSessionRunning = true
    return next(e)
  })

  /**
   * 一轮被中断：同样要落回「停着」，否则鲸鱼会一直划水到下一轮开始。
   *
   * 用户按 Esc 停掉回答是常见操作，`turn.complete` 不会再来一次。
   * 输入同样只有 `turnId`。
   */
  on('turn.abort', async (_$, e, next) => {
    isSessionRunning = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // 主会话这一轮结束：鲸鱼落回静止。子代理的完成不影响主条子。
    if (!e.agentId) isSessionRunning = false
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
        // **用 `context.tokens`，不是自己从 `usage` 加一遍。**
        //
        // 两者理论上相等（都是这一轮最后一次响应里的输入计数），但
        // `context.tokens` 是引擎已经算好、并且 `toUsageView` 的 `percent`
        // 正是拿它当分子的那个值。这里若自己再加一遍，等于同一个数算两次——
        // 一旦引擎那边换了口径（比如把 cacheRead 折进未缓存），`percent`
        // 与 `tokens` 就会对不上，图上柱子高度与标注数字分家。
        //
        // 早先这里写的是 `usage.input_tokens + cache_read + cache_creation`，
        // 与引擎的 `context.tokens` 是同一个口径，但**两个来源**。统一取
        // 一处，接缝处不会差一截。
        const usedTokens = liveView.contextTokens ?? (
          usage.input_tokens +
          usage.cache_read_input_tokens +
          usage.cache_creation_input_tokens
        )
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
  // **Edit 与 Write 共用一个 handler。** matcher 的数组写法是「任一命中」
  // （引擎类型声明原话：`{ tool: ['Bash', 'Read'] }`）。早先注册了两遍逐字
  // 相同的 24 行，任何一次修改漏改一侧，两种工具的计数就会悄悄分叉。
  //
  // `catch` 显式放行：本 hook 只观察、不改写结果，统计失败时不该拦住工具调用。
  on(
    'tool.call',
    { tool: ['Edit', 'Write'] },
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
  // 摘要与面板入口靠右；左侧是一块 16 列的字符画。条子只有一行高，所以
  // 画不了气泡——气泡是三行 21–46px 的字，最小可读尺寸就顶到 150px。
  // 数字本来就在摘要里。
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
    // 「本会话花费」按**插件价目表**算，与面板同一个口径：引擎 `/cost` 只认
    // 第一方价目表，第三方模型会按默认模型估出几十倍。逐模型累加
    // `byModel[].cost`（写入时已按价格表算过）；只要有一款未收录就返回
    // `undefined`，让 `bandSummary` 退回引擎读数——至少不会少算一笔。
    //
    // 读 `byModel` 同时让条子成为该状态的订阅者：`turn.complete` 写它，
    // 条子随即重绘。
    const heldBandByModel = await $.state.get({ plugin: 'whale-usage', key: 'byModel' } as const)
    const bandByModel = heldBandByModel.value ?? []
    // 口径收在 `sessionCostOf` 一处：任何一款未收录价格就退回引擎读数。
    const bandSessionCost = sessionCostOf(bandByModel)
    // 老状态里没有这个字段、或是空数组时退回默认——与面板侧共用同一个函数，
    // 避免一处放开了空数组而另一处没有。
    //
    // **默认口径要跟着环境走。** 默认原本固定是 `window`（额度窗口），但第三方
    // 网关（DeepSeek、Qwen 之类）没有订阅额度，`fiveHour` / `sevenDay` 都是
    // 空的，条子上就只剩一句「无额度窗口」——读者看到的是一条什么都没说的
    // 条子，以为插件坏了。这时默认换成 `cost`（上下文占用）：那个数在任何
    // 环境下都有值，且是读者最想知道的那一个。
    //
    // 只改**默认**：读者自己点过口径，`prefsNow.bandMetrics` 就非空，此时
    // 一律照他选的来，不该因为环境变了就悄悄换掉。
    const metrics = bandMetricsOf(
      prefsNow,
      view.fiveHour || view.sevenDay ? DEFAULT_PREFS.bandMetrics : ['cost'],
    )
    const summary = bandSummary(view, metrics, now, bandSessionCost)

    const { Box, Text, Button } = $.ui.resolve(e)

    /**
     * 用量条的小鲸鱼：**单行字符画**，随会话是否在运行而变。
     *
     * 从位图 Svg 换成字符画的原因：这条子只有一行高，而位图立绘的最小可读
     * 尺寸就顶到 52px——要么被裁掉一半，要么把条子撑高两行。字符画按字符格
     * 布局，与同一行的摘要文字同一套度量，既不撑高也不会在换 DPI 时错位；
     * 顺带在终端上也能画（终端本来就没有 Svg）。
     *
     * 三种状态宽都是 `BAND_WHALE_TEXT_COLS` 列，所以状态切换时后面的摘要
     * 不会左右跳。空闲时她在睡觉，`z` 一个字母一个字母地蹦出来，攒满整格
     * 再「呼」一口气；跑对话时鱼头 `>` 后面跟着她嘀咕的话——干活时说摸鱼，
     * 忙时说吃白饭。
     */
    const bandState = bandWhaleStateOf(isSessionRunning, now)
    // **宽度固定成字形宽度 + 1 列右缝**，不跟着摘要长度算——
    // `summary` 随额度、倒计时、花费随时变长变短，按剩余宽度算的代码估错
    // 一个字符就会换行、把条子变成两行高。窄窗口里引擎按 flexShrink 收窄，
    // 收窄后字符画位置由 `overflow` 裁掉，不影响布局。
    const BAND_WHALE_COLS = BAND_WHALE_TEXT_COLS + 1

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
        {/* 小鲸鱼：单行字符画，宽度固定 16 列。外面不再套跑道 Box——那层
            是为巡游准备的可挪动空间，巡游取消后它只剩一个定宽外壳。
            字符画本身已经表达了「在不在干活」，不需要再靠位置变化。

            **不上色。** 曾经想给运行中的鲸鱼一支绿色，但 `diffAdded` 按
            设计规则只用于「增加的行数」——挪来当装饰会让读者在条子上看到
            同一个颜色表达两件事。状态差异由字形承担（见 `BAND_WHALE_FRAMES`）。 */}
        <Box key="whale-band-whale" width={BAND_WHALE_COLS}>
          <Text>{bandWhaleGlyph(bandState, now)}</Text>
        </Box>
        <Box key="whale-band-spacer" flexGrow={1} />
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
    // 按 surface 判断而不是探测元素表——理由同用量条那处：测试宿主的终端
    // 表里带着 `Svg`，探测会得出「能画图」，实际渲染为空。
    const Svg = e.surface === 'terminal' || !('Svg' in table) ? undefined : table.Svg
    const Select = 'Select' in table ? table.Select : undefined

    const heldPrefs = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
    const prefsNow = heldPrefs.value ?? DEFAULT_PREFS

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

    /**
     * 本会话按**插件价格表**算出的花费：逐模型把 `costOf()` 的结果加起来。
     *
     * 气泡「本会话」页用这个数，而不是 `view.costUsd`（引擎 `/cost`）——
     * 后者只认第一方价目表，第三方模型会按默认模型估出几十倍。只有所有
     * 模型都有价时才算得出；有一款未收录就返回 `undefined`，让气泡退回
     * 引擎读数（至少不会少算一笔）。
     */
    // 与用量条、气泡共用同一个口径函数。
    const sessionCostOfPrices = sessionCostOf(byModel)
    const heldContextTurns = await $.state.get({ plugin: 'whale-usage', key: 'contextTurns' } as const)
    const liveContextTurns = heldContextTurns.value ?? []
    // 用量条口径：与用量条那一侧共用 `bandMetricsOf`，两处不会再分叉。
    const metrics = bandMetricsOf(prefsNow, DEFAULT_PREFS.bandMetrics)
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

    // 情绪按一天里的钟点走，与额度无关——深夜该睡就睡，不因为额度还空着
    // 就让她精神抖擞。`now` 是毫秒时间戳，`moodOf` 内部按本地时区取钟点。
    const mood = moodOf(now)
    const data = record.data
    const today = data?.today

    // 泡泡轮播：每页三行说一件事，几秒换一页。页号由**时钟**算出，不存状态
    // ——写状态会额外触发一次重绘，而这里只需要「现在是第几页」。
    //
    // 换页由 `BUBBLE_PAGE_MS` 那条 `clock.every` 推动（见 `session.start`）。
    const bubblePagesNow = bubblePages(view, now, {
      totals,
      today: data?.today,
      total: data?.total,
      windowDays: data?.windowDays,
      mood,
      sessionCost: sessionCostOfPrices,
    })
    const bubblePage = bubblePagesNow[Math.floor(now / BUBBLE_PAGE_MS) % bubblePagesNow.length]!
    const lines = bubblePage.lines
    // 主角行由页面自己指定——额度页与上下文页的主角是百分比，不在第二行。
    const hero = bubblePage.hero ?? 1

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
    // 设置页里选的缩放档位乘在基准尺寸上。夹取一次：老状态里可能没有这个
    // 字段（`undefined`），也可能存了一个不在档位表里的值。
    const scale = clampScale(prefsNow.whaleScale ?? DEFAULT_PREFS.whaleScale)
    const whaleSize = whaleSizeFor(width)
    // **缩放后还要再夹一次。** `whaleSizeFor` 只把**基准**尺寸收在可用宽度
    // 以内（≤380px），乘上档位就不管了：80 列面板只有 632px 可用，
    // 200% 档是 760px，多出的 128px 会被引擎直接裁掉（`overflow` 只有
    // visible / hidden，没有滚动），鲸鱼只剩左半边。高度跟着宽度重算，
    // 保持画布比例——否则 `preserveAspectRatio` 会留白并上下居中。
    const availablePx = Math.max(0, width - 1) * 8
    const whaleWidth = Math.min(whaleSize.width * scale, availablePx)
    const whaleHeight = whaleWidth * WHALE_ASPECT

    const whale = Svg ? (
      <Svg
        // **面板鲸鱼不浮动。**
        //
        // 这里的 SVG 不传 `isInteractive`（原因见下），桌面端因此把它当
        // 静态图片画，SMIL 不跑——浮动只能靠 `whaleSvg` 每次重绘时把
        // `now - epoch` 写进 `begin` 的负偏移，由渲染器画出 `begin` 所指的
        // 那一帧。
        //
        // 问题是 `$.ui.invalidate('ui.render')` 重绘的是本插件能画的**所有**
        // 实例（引擎 `invalidate` 的 remarks 原文：*every instance of its
        // component*）。用量条为了「z 一个字母一个字母蹦出来」每 200ms 重绘
        // 一次，面板就被一起绑上：相位每 200ms 前进一段，`source` 每次都是
        // 新字符串，引擎重新解码重绘——3.6 秒、±4px 的浮动被切成 18 段，
        // 肉眼看到的是高频抖动，不是浮动。
        //
        // 所以直接关掉：`isAnimating: false` 让 `whaleSvg` 根本不写
        // `animateTransform`，`source` 只随台词与配色变（6 秒翻一页），
        // 200ms 那批重绘画出的字节完全相同，引擎判等后不会动它。
        source={whaleSvg(mood, lines, { isBubbleOpen: true, hero, isAnimating: false })}
        alt={`小鲸鱼：${lines.join('，')}`}
        width={whaleWidth}
        // 高度：显示尺寸 = 宽度 × 画布比例。盒子由这两个数决定。
        height={whaleHeight}
        // **不要传 `isInteractive`。** 它会让引擎把 SVG 放进 sandbox iframe
        // 渲染（SMIL 才跑），而那条路径**画不出内嵌的 `<image>` 位图**：
        // 面板里只剩下矢量画的气泡，鲸鱼整个消失，看起来像一块纯白。
        // 引擎的禁止标签清单里就有 `<image>` 与 `animate*`。
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

    // 本会话：三档层次，每行只有一个粗体。
    //
    // 早先压成一行「花费 $3.05 · 上下文 42% 84k/200k」——整行都是正文，读者
    // 最想先看的那个数和单位、口径挤在同一档里，没有落点。现在：**花费**与
    // **上下文占比**各占一行、各用一个 `bold`（读者每次打开先要的两个数），
    // token 明细退成 `dimColor` 注解，上一轮与总量再退一档。
    //
    // **「花费」这一格按插件价目表算**，与用量条、气泡同一个数。
    //
    // 早先它取引擎 `/cost` 的会话累计：引擎只认 Anthropic 第一方的价目表，
    // 遇到不认识的名字（第三方网关的那些）就按**默认模型的价格**估——见
    // `isEnginePriced` 的注释。后果很具体（本机实测）：同一个会话、同一批
    // token，DeepSeek Flash 按官方价是 $3.05，引擎按默认模型估成 $258.98，
    // 于是面板上的「本会话花费」反而高于概览里跨 30 天的总额。
    //
    // 现在优先用 `sessionCostOfPrices`；只有某一款模型未收录价格时才退回
    // 引擎读数，并在后面注明「按默认模型价估」——那种情况下这个数本来就不
    // 完整，读者需要知道。
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
          花费 <Text bold>{usdEstimate(sessionCostOfPrices ?? view.costUsd)}</Text>
          {sessionCostOfPrices === undefined && hasNonEngineModel ? '（含引擎未收录的模型，按默认模型价估）' : ''}
        </Text>
        <Text>
          上下文 <Text bold>{pct(view.contextPercent)}</Text>
          {view.contextTokens !== undefined
            ? <Text dimColor>{` ${tokens(view.contextTokens)}/${tokens(view.contextWindow)}`}</Text>
            : null}
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

    // 上下文占用的堆叠柱状图：每根柱子是一轮，柱内按内容分类堆叠。
    //
    // **纵轴是 token 绝对量，上限取自动压缩阈值。** 柱子高度就是这一轮的
    // `tokens`，轴顶是阈值（`400K` 这种刻度）——「现在多大」与「到多少会被压」
    // 在同一把尺子上，最高的柱子顶到轴顶就等于「马上要被压缩」。
    //
    // 早先纵轴是百分比、上限是阈值，柱子按 `percent`（阈值口径）画；那个
    // 口径下 300K 会显示成 75%，读者容易以为快撑爆了。现在百分比改按模型
    // 完整窗口算（300K/1M = 30%），柱高直接用 token，两处不再打架。
    //
    // 因此**不需要「压缩缓冲」那一段**：阈值就是轴顶，它上面没有空间可画。
    // `bufferPct = 0` 就是这个意思，不是漏了。
    const bufferPct = 0

    /**
     * 这一屏画的轮次：**会话日志重建的历史在前，插件启动后的记录在后。**
     *
     * 为什么要有历史：`contextTurns` 只从插件装上那一刻开始记，而一场会话
     * 常常在插件加载前就已经跑了很久——读者打开上下文页，看到的却是「刚开始
     * 的几轮」，而窗口其实早就快满了。日志里每条 assistant 消息都带 usage，
     * 从会话开头就能重建，补的正是这一段。
     *
     * ## 分母是**模型完整窗口**，不是压缩阈值
     *
     * 柱子回答的是「这个模型的窗口用了多少成」：1M 窗口里放了 300K 就是 30%。
     * 早先按自动压缩阈值算，同一个 300K 会画成 75%，整条曲线凭空显得紧张。
     * 「离压缩还有多远」由 `autoCompactThreshold` 单独回答，图注里写。
     *
     * 分母只能取**当前这次**的读数：日志里既没有窗口上限也没有阈值。同一场
     * 会话里模型不换、窗口不变，所以用当下这一份换算是成立的；换到别的会话
     * 就不成立——这也是只取当前会话（`$.session.id()`）的原因。
     */
    // 分母与 `view.contextPercent` 同源：`toUsageView` 已经把这套选择收在一处，
    // 这里直接取，别再算第二遍——两处各算一遍迟早会分叉（这正是先前
    // 「泡泡 28%、图上 30.4%」的成因）。
    const contextDenominator = view.contextDenominator
    const historyContext = historyContextTurns(record.data?.contextTurns, contextDenominator)
    const contextTurns = mergeContextHistory(historyContext, liveContextTurns)

    // 显示最近几轮、柱子、图例、图注全由 `contextView` 一处算出：宽度决定
    // 能放几根，图注与图例跟着同一份结果走。以前这里写死 60 轮、SVG 内部
    // 又按宽度裁一次，窄画布下就会出现「图注说 60 轮、图上 34 根」。
    //
    // **上限 900px 而不是 640px**：640 是模型页立图时期留下的数，对上下文
    // 柱状图来说偏窄——96 列以上的面板会空出 112～784px 一条死区（右侧整块
    // 什么都不画）。柱状图按 CSS 像素布局、面板按字符格，两套单位之间没有
    // 换算，所以「填满」只能靠这个上限把常见宽度兜住；140 列以上再封顶
    // 900px，因为那时柱子已经到 60 根上限（`CONTEXT_MAX_BARS`），再宽只是
    // 让每根柱子变胖，读不出更多轮。
    const chartWidth = Math.max(80, Math.min(width * 8 - 16, 900))
    const contextScreen = contextView(
      contextTurns,
      chartWidth,
      Math.max(0, bufferPct),
      theme.isLight,
      // 压缩点：柱子按模型完整窗口画，得点出阈值落在同一个尺度上的哪里。
      { threshold: view.autoCompactThreshold, window: contextDenominator },
    )

    const contextPage = (
      <Box flexDirection="column">
        {contextTurns.length === 0 ? (
          <Text dimColor>还没有逐轮数据</Text>
        ) : (
          // 图、构成、图注、图例装进一块圆角里：它们说的是同一件事（这一屏
          // 每轮的构成），分开铺在页面底色上会像是几块碰巧挨着的内容。底色比
          // 大框深一档，读起来是「嵌进去的一块」，而不是又浮起来一层。
          <Box
            key="whale-context-inset"
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.inset.borderColor}
            borderDimColor
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
                  contextScreen.yMaxTokens,
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
            {/* 这一页原先有一行「最近一轮 xx% · 系统提示 12.3K · 消息 245.1K…」，
                已删掉：桌面端的 session rail 已经实时显示各部分的占比，同样的
                数字在两处各说一遍只是噪音，而且这边只有**最近一轮**有构成，
                历史轮次没有——读者点开时会以为这一行是整页的图例。
                逐轮明细表已经把「最近一轮多少」说清楚了。
                图注从 `alt` 里搬出来。`alt` 是无障碍描述，引擎不会把它画在
                屏幕上；而「最近几轮、峰值多少」正是柱状图的读法说明，读者
                必须看得见。文字与 `alt` 是同源的一句话（都出自
                `contextView`），不会各说各的。
                终端那一路加 `yMax`：那边没有 Svg、也就没有纵轴刻度，上限只能
                写在文字里；桌面端的轴顶已经标了上界。 */}
            <Text dimColor>{Svg ? contextScreen.caption : contextScreen.terminalCaption}</Text>
            {/* 图例只列「分类」：骨架段已经在图注里说过了（「12 轮」「峰值
                56%」），再加上「已用（无构成）」「压缩缓冲」两格只是把同一
                件事说了两遍。分类才是柱内那些颜色真正需要解释的东西。 */}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {contextScreen.legend
                .filter(item => !LEGEND_SKELETON_KINDS.has(item.kind))
                .map(item => (
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

    // 页签：用量概览 / 模型分布 / 本会话上下文占用 / 设置。
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
      { id: 'context', label: '本会话上下文占用' },
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
                //
                // **边框压暗一档（`borderDimColor`）。** 卡片和外面那个大框
                // 原本是同一支色、同一档粗细，六张卡就变成六个跟容器平级的
                // 格子——读者分不清哪个是「页面」哪个是「格子里的一条」。
                // 压暗之后层级是：外层框（主）> 卡片框（次）> 卡内文字。
                <Box
                  key={`whale-card-${rowIndex}-${index}`}
                  flexDirection="column"
                  width={cardWidth}
                  borderStyle="round"
                  borderColor={fill.borderColor}
                  borderDimColor
                  backgroundColor={fill.backgroundColor}
                  paddingX={1}
                >
                  {/* 三档层级，从上到下依次退后：标题（注解）→ 数字（主体）
                      → 补充（注解）。卡里只有一个 `bold`，就是那个数。 */}
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
    // 明细表与图**同窗口、同源、同排序键**：两者都从 `modelDaily` 按
    // `historyDays` 取数。早先表读的是 `byModel`（扫描层固定 400 天的
    // 全量），读者把「范围」切到 30 天时柱子变了、表不动，两块又长在
    // 同一个标题下，等于给出了两套互相矛盾的数字。
    const modelDetails = modelDetailRows(
      data?.modelDaily ?? [],
      prefsNow.historyDays,
      data?.byModel ?? [],
    )
    const modelChartWidth = Math.max(80, Math.min(width * 8 - 16, 900))
    // 柱内段序与下方每行的色块共用这一份映射：颜色与模型的对应一旦错位，
    // 读者就会把 A 的花费读成 B 的。明细表的行序与图的段序同键排序，所以
    // 前 `MODEL_STACK_KEEP` 名一一对应；超出部分在表里是灰色 chip。
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
    const partitions = detailColumns.partitions.widths
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
              {/* **不要 `bold dimColor` 同时用。** 那是两档层级叠在一个元素上：
                  `bold` 说「这是主体」，`dimColor` 说「这是注解」，读者无从判断。
                  这一行是页内小标题，属于「正文」档——不加粗、不压暗，靠它下面
                  那张带底色的框把它与内容分开就够了。 */}
              <Text>逐模型用量</Text>
              {modelRange}
            </Box>
            {/* 图与图注装进一块圆角：它们说的是同一件事（这一段时间每个
                模型用了多少），分开铺在页面底色上会像是两块碰巧挨着的内容。
                标题与「范围」留在外面——那是这一页的名字与控件，不属于图本身。

                **没有图例行。** 图例曾在图下再列一遍「色块 + 模型名」，可
                正下方那张明细表的第一列（色块 + 名字）说的是同一件事，而且
                还多给了数字。前 `MODEL_STACK_KEEP` 名的顺序、颜色在两处完全
                一致（同一个 `stack.models`、同一个排序键），多出来的那一行
                只是把同一份映射说了第二遍——按规则 5「宁可少说一句」删掉。 */}
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={theme.inset.borderColor}
              borderDimColor
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
              <Text dimColor>{modelStackCaption(stack.bars, grain)}</Text>
            </Box>
            {/* 明细表单独一块圆角：它和图是两种读法（形状 vs 具体数字），
                分开才看得出是两张表，而不是一张图拖了一条尾巴。边框与图那块
                同样压暗一档——页内分组框都比外层大框低一级（见
                `DESIGN-PROMPT.md` 规则 6 与概览卡片的做法）。 */}
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={theme.inset.borderColor}
              borderDimColor
              backgroundColor={theme.inset.backgroundColor}
              paddingX={1}
              marginTop={1}
            >
              {/* 表头与数据行共用同一组列宽与同一个 `gap`，所以各列能对齐。
                  表头第一列要补出数据行那个色块的**位置与缝隙**：
                  数据行是 `■` + gap + 模型名，表头就用一格空白替色块，
                  后面照常隔一个 gap——两行的格子数必须相同，少一格右边
                  三列会整体错开。

                  **列宽交给 `Box` 的 `width`，不靠末尾补空格。** 以前每一格
                  是一个 `<Text>`，宽度全靠 `padCell` 补出来的行尾空格撑开。
                  那样只要绘制端把行尾空白裁掉（`trimEnd` 是终端渲染的常见
                  做法），列宽就塌回内容宽度：`qwen3.8-27b` 补 12 格、
                  `deepseek-v4-flash` 补 7 格，两行画出来一样宽，四列全歪。
                  现在每个单元格是一个定宽 `Box`，列宽由引擎的布局决定，
                  与文字长短、与行尾空格是否保留都无关。

                  **四列一律左对齐**：数字右对齐时，同一列里的 `8.0万` 与
                  `21.50亿` 位数不同，左边参差不齐，扫读时每一格都要重新找
                  起点；左对齐后四位数字的起始位置固定，纵向扫一眼就对得上。 */}
              <Box flexDirection="row" gap={tableGap}>
                {/* 色块列用与 `CHIP_COLUMN` 等宽的定宽 Box：`■` 的东亚宽度
                    属性是 Ambiguous——多数终端按 1 格算，CJK 环境按 2 格算。
                    不猜它几格：表头用同样的盒子占位，两行第一列一定对齐。 */}
                <Box width={CHIP_COLUMN} />
                <Box width={partitions[0]}><Text dimColor>模型</Text></Box>
                <Box width={partitions[1]}><Text dimColor>输入</Text></Box>
                <Box width={partitions[2]}><Text dimColor>输出</Text></Box>
                <Box width={partitions[3]}><Text dimColor>费用</Text></Box>
              </Box>
              {modelDetails.map((row, index) => (
                <Box key={`whale-mrow-${row.model}-${index}`} flexDirection="row" gap={tableGap}>
                  <Box width={CHIP_COLUMN}>
                    <Text color={modelColorOf(row.model)}>■</Text>
                  </Box>
                  <Box width={partitions[0]}>
                    <Text>{clip(row.model, nameWidth)}</Text>
                  </Box>
                  {/* 数字的内容宽度仍按最长读数定（截断由 `clip` 兜底），
                      但单元格盒子占**分区宽度**——见上面表头处的说明。 */}
                  <Box width={partitions[1]}>
                    <Text dimColor>{clip(inputTexts[index] ?? '—', inputWidth)}</Text>
                  </Box>
                  <Box width={partitions[2]}>
                    <Text dimColor>{clip(outputTexts[index] ?? '—', outputWidth)}</Text>
                  </Box>
                  <Box width={partitions[3]}>
                    <Text dimColor>{clip(costTexts[index] ?? '—', costWidth)}</Text>
                  </Box>
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

    // 设置页：三组设置。它们曾排在面板最下方，与上面的几页内容并列，读起来
    // 像一块没名字的区域；收进「设置」页签之后，每一块都归属于一个明确的页。
    //
    // 所有项一律是**开关**：亮＝这一项开着。不做「按一下切换标签」的动作按钮
    // ——同一个视觉组里混两种语义，读者没法从「亮不亮」判断当前状态。
    //
    // **「显示用量条」与五个口径同属一组。** 它们改的是同一件东西——输入框
    // 上方那条子：`isBandVisible` 决定它显不显示，`bandMetrics` 决定显示哪几项。
    // 早先「显示用量条」被放在「面板」组里，与「轮次费用提示」并列，而五个
    // 口径在「用量条显示」组里——同一个对象的两个开关被拆成两组，读者会以为
    // 它们是两回事。现在总开关排在五个口径前面，是一棵树的两层。
    const SETTINGS_LABEL_COL = 8
    /**
     * 一组设置 = 一个圆角框 + 一行「标签 + 芯片」。
     *
     * **框只加边框，不加左右 `paddingX`。** 「用量条」那行内容本身就要 67 列；
     * 74 列面板的页内可用是 70 列，边框吃掉 2 列后还剩 68——刚好放得下。加了
     * padding 再吃 2 列就只剩 66，那一行立刻折行。字符界面里边框的收益是
     * 「一眼看出这三组是三件事」，padding 的收益只是呼吸感，这里选前者。
     *
     * 底色与描边沿用 `theme.inset`（与模型页、上下文页的分组框同一档），
     * 层级是「页面外框（主）> 分组框（次，压暗一档）> 内容」。
     */
    const settingsRow = (key: string, label: string, chips: any) => (
      <Box
        key={key}
        flexDirection="row"
        gap={1}
        alignItems="center"
        flexWrap="wrap"
        borderStyle="round"
        borderColor={theme.inset.borderColor}
        borderDimColor
        backgroundColor={theme.inset.backgroundColor}
      >
        {/* 标签列定宽：三组标签宽度不同（用量条 6 / 面板 4 / 立绘 8），不统一
            的话每组芯片的起始位置都不一样，读起来像三张互不相干的表。
            `SETTINGS_LABEL_COL` 取最长那个（立绘大小 = 8）。 */}
        <Box width={SETTINGS_LABEL_COL}>
          <Text dimColor>{label}</Text>
        </Box>
        {chips}
      </Box>
    )
    const settingsPage = (
      <Box flexDirection="column" gap={1}>
        {settingsRow('whale-settings-band', '用量条', (
          <>
            {/* 总开关排在五个口径前面：先决定「要不要」，再决定「显示什么」。
                之前这里写死 `false`，于是它永远不亮、也读不出当前状态。 */}
            {chip('whale-band-toggle', '显示', prefsNow.isBandVisible ?? DEFAULT_PREFS.isBandVisible, () => {
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
            {/* 用量条口径是多选：每项一个方块，亮着的就是会出现在条子上的。
                至少保留一项——全取消会让用量条变成一条空行，看起来像坏了。
                点到最后一项时给一句提示，不要静默吞掉那次点击。 */}
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
                  // 这个按钮只改变底色与明暗，条目本身仍然在同一个位置——不开
                  // 口的读者没法从画面判断这一下到底生效没有。每次点击都回一句
                  // 开/关，配合「项目名」说清是哪一项。
                  $.ui.toast(`${option.label}：${isOn ? '已关闭' : '已开启'}`)
                })()
              })
            })}
          </>
        ))}
        {settingsRow('whale-settings-panel', '面板', (
          chip('whale-turn-cost', '轮次费用提示', prefsNow.isTurnCostOn ?? DEFAULT_PREFS.isTurnCostOn, () => {
            void (async () => {
              const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
              const nowPrefs = latest.value ?? DEFAULT_PREFS
              const isNext = !nowPrefs.isTurnCostOn
              // 与同一页的其它开关保持一致：点亮/熄灭时给出提示，否则读者
              // 只看到方块明暗变了一下，不知道刚才那一下生效了没有。
              // 顺带说明这个开关管的是什么——它只弹「上一轮」那一次提示，
              // 不改面板里的任何读数。
              await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                ...nowPrefs,
                isTurnCostOn: isNext,
              })
              $.ui.toast(
                isNext ? '轮次费用提示：已开启，每轮结束时弹一次' : '轮次费用提示：已关闭',
              )
            })()
          })
        ))}
        {settingsRow('whale-settings-whale', '立绘大小', (
          <>
            {/* 引擎没有滑块控件，所以这里是一排档位按钮。点哪一档，鲸鱼立刻
                变到那个比例——「拖动条」要的是「随手可调」，而不是字面意义
                上的拖拽。选中的那档与其它开关同一套明暗规则。 */}
            {WHALE_SCALES.map(scaleValue => {
              const isOn = Math.abs(scale - scaleValue) < 1e-6
              return chip(
                `whale-scale-${scaleValue}`,
                `${Math.round(scaleValue * 100)}%`,
                isOn,
                () => {
                  void (async () => {
                    const latest = await $.state.get({ plugin: 'whale-usage', key: 'prefs' } as const)
                    await $.state.set({ plugin: 'whale-usage', key: 'prefs' } as const, {
                      ...(latest.value ?? DEFAULT_PREFS),
                      whaleScale: scaleValue,
                    })
                    $.ui.toast(`立绘大小：${Math.round(scaleValue * 100)}%`)
                  })()
                },
              )
            })}
          </>
        ))}
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
        {/* 鲸鱼独占最后一行、**恒贴右端**。泡泡常驻，内容每 `BUBBLE_PAGE_MS`
            换一页；常驻是因为点击区没法精确对齐立绘——`Svg` 按 CSS 像素
            布局、`Box` 按字符格布局，两者之间引擎不给换算，只能猜行高；
            猜小了「点鲸鱼底部没反应」，猜大了又会盖住别的内容。不如直接
            把要看的数字画出来，读者连点都不用点。

            **不再巡游。** 曾经这里按 `swimOffsetFor` 做三角波，每 6 秒向内
            挪三列、到头折返。问题是面板每 30 秒自动重绘一次，读者看到的是
            「鲸鱼每次刷新都往中间走一点、位置回不去」——一个本该固定在右下角
            的立绘变成了会漂移的东西。巡游的收益只是「看起来活着」，而这个
            挂件本来就靠数据刷新证明自己活着；代价是位置不可预期。所以改回
            恒定 `justifyContent="flex-end"`。鲸鱼不翻转：素材朝左，镜像会让
            气泡的指向关系失效，碰撞测试也全部重算——已知取舍。 */}
        <Box flexDirection="row" justifyContent="flex-end" width={width}>
          <Box key="whale-swim">
            {whale}
          </Box>
        </Box>
      </Box>
    )
  })
}

export default register
