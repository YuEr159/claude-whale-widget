/**
 * 纯计算：把一次 `$.session.usage()` 的结果整理成界面要的几行文字。
 *
 * 这里不碰 `$`，只做数据整形，方便单测，也避免把 `$` 传进辅助函数
 * （插件校验器要求 `$` 只出现在 `$.noun.method(...)` 的调用点）。
 */
import type { BandMetric } from '../types'
import type { WhaleMood } from './whale-art.ts'
import { pct, countdown, diffLines, tokens } from './format.ts'
import { usdEstimate } from './provenance.ts'

export type RateLimitView = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type UsageView = {
  fiveHour?: RateLimitView
  sevenDay?: RateLimitView
  /** 全部额度窗口，详细面板按原生 /usage 的标题逐一列出。 */
  limits: LimitView[]
  costUsd?: number
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
  /** 调用时传了 `{ breakdown }` 才有：上下文按分项的明细，形状见 usage-detail.ts。 */
  breakdown?: unknown
}

/** 一条额度窗口，与 usage-detail 的 LimitView 同形。 */
export type LimitView = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** 从一个未知形状的 usage 结果里挑字段；形状不对就当作「没有数据」。 */
export function toUsageView(usage: unknown): UsageView {
  if (!usage || typeof usage !== 'object') return { limits: [] }
  const source = usage as {
    rateLimits?: unknown
    cost?: { usd?: unknown } | null
    context?: { tokens?: unknown; window?: unknown; percent?: unknown; breakdown?: unknown } | null
  }

  const rawLimits = Array.isArray(source.rateLimits) ? source.rateLimits : []
  // 只有 kind 是字符串、percentUsed 是数字的条目才算一个窗口。
  const limits: LimitView[] = []
  for (const item of rawLimits) {
    if (!item || typeof item !== 'object') continue
    const one = item as { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }
    if (typeof one.kind !== 'string' || typeof one.percentUsed !== 'number') continue
    limits.push({
      kind: one.kind,
      percentUsed: one.percentUsed,
      resetsAt: typeof one.resetsAt === 'string' ? one.resetsAt : undefined,
    })
  }
  const pick = (kind: string): RateLimitView | undefined => limits.find(item => item.kind === kind)

  const context = source.context
  const cost = source.cost

  return {
    fiveHour: pick('five_hour'),
    sevenDay: pick('seven_day'),
    limits,
    costUsd: typeof cost?.usd === 'number' ? cost.usd : undefined,
    contextPercent: typeof context?.percent === 'number' ? context.percent : undefined,
    contextTokens: typeof context?.tokens === 'number' ? context.tokens : undefined,
    contextWindow: typeof context?.window === 'number' ? context.window : undefined,
    breakdown: context?.breakdown,
  }
}

/** 用量条要显示的一段代码改动。 */
export type BandDiff = {
  added: number
  removed: number
}

/** 改动行数的文字：`+128 -34`；两边都是 0 时为空串。 */
export function bandDiffText(diff: BandDiff | undefined): string {
  if (!diff) return ''
  return diffLines(diff.added, diff.removed)
}

/** 没有订阅额度窗口时，「额度窗口」这一口径在条子上写的唯一一句话。 */
const NO_LIMITS = '无额度窗口'

/**
 * 用量条那一行摘要，按选中的几类口径拼接。
 *
 * 多选时**按 `BAND_METRIC_OPTIONS` 的固定次序**拼，与勾选先后无关——条子上
 * 的数字位置一旦随点击顺序漂移，读者就得每次重新找。同一类只出现一次。
 *
 * `diff` 不在这里拼：增删要用两种颜色区分（diffAdded / diffRemoved），
 * 拼成纯字符串就没法上色，选中它反而只剩一片灰字。它由调用方在同一个
 * 行里用两个带色的 `Text` 追加，本函数只管其余口径。
 *
 * 之所以能做到「实时」：用量条在渲染时读了 `totals`，而 `$.state.set`
 * 会重绘读过该值的绘制点——Edit / Write 一写入，条子就跟着重画，
 * 不靠定时轮询。
 *
 * @param sessionCost 本会话花费，按**插件价目表**逐模型算出的值。
 *   传了就用它，「本会话」那一项不再读 `view.costUsd`（引擎 `/cost`）——
 *   引擎只认第一方价目表，第三方模型会按默认模型估出几十倍（DeepSeek
 *   Flash 实测 $3.05 被估成 $258.98）。没传（或传 `undefined`）时退回
 *   引擎读数：至少不会因为某一款没价就少算一笔。
 */
export function bandSummary(
  view: UsageView,
  metrics: readonly BandMetric[],
  now: number,
  sessionCost?: number,
): string {
  const five = pct(view.fiveHour?.percentUsed)
  const seven = pct(view.sevenDay?.percentUsed)
  const hasLimits = Boolean(view.fiveHour || view.sevenDay)
  // `window` 已经写出了 5h 那一半，`context` 若照常输出就会把 `5h 24%`
  // 连着印两遍。所以两条都选时让 `context` 只补 7d 这一半。
  const windowShowsFive = metrics.includes('window') && hasLimits

  const one = (metric: BandMetric): string => {
    switch (metric) {
      case 'session':
        return `本会话 ${usdEstimate(sessionCost ?? view.costUsd)}`
      case 'cost':
        return `上下文 ${pct(view.contextPercent)}`
      case 'context':
        // 没有额度窗口时**什么都不说**，而不是跟着写「无额度窗口」。
        //
        // 那句话是「额度窗口」这一项的消息。以前两项都返回它，靠后面的
        // 文本去重才只显示一遍——于是关掉「额度窗口」后，「5h + 7d」照样
        // 说出同一句话，读者点了开关条子毫无变化，以为开关坏了。
        // 没有数据就不该替这一项发言；`window` 那句已经把情况说清楚。
        if (!hasLimits) return ''
        return windowShowsFive ? `7d ${seven}` : `5h ${five} · 7d ${seven}`
      default:
        // `window`：点了「额度窗口」，条子上就该是额度窗口的消息。
        if (!hasLimits) return NO_LIMITS
        return view.fiveHour
          ? `5h ${five} · ${countdown(view.fiveHour.resetsAt, now)} 后重置`
          : `5h ${five} · 7d ${seven}`
    }
  }

  // 按 `BAND_METRIC_OPTIONS` 的固定次序拼。**不需要去重**：
  //
  //   - `BAND_METRIC_OPTIONS` 里每一项只出现一次，按它遍历不可能重复；
  //   - 「两条口径都说无额度窗口」那个老问题已在 `one()` 里修掉——
  //     `context` 没有数据时返回空串，不再是同一句话写两遍。
  //
  // 曾经这里挂着两个 `Set` 做按值 / 按文本去重，各自对应一个已经修复的问题。
  // 留着它们会让人以为还存在会重复输出的路径。
  const parts: string[] = []
  for (const option of BAND_METRIC_OPTIONS) {
    // `diff` 由渲染层分色追加，这里跳过。
    if (option.value === 'diff') continue
    if (!metrics.includes(option.value)) continue
    const text = one(option.value)
    if (text.length === 0) continue
    parts.push(text)
  }
  return parts.join(' · ')
}

/**
 * 泡泡轮播的一页：三行，说同一件事。
 *
 * 三行不是随便凑的——`bubbleSvg` 给**主角行**更大的字号（46 vs 25/21），
 * 那是「这一页的主角」。所以每页必须指明哪一行是主角，而主角行必须是最想
 * 让人看见的那个数字，其余两行是它的上下文。
 *
 * ## 为什么主角行要显式标出来
 *
 * 早先 `bubbleSvg` 按**行序号**定字号：第二行一律 46px。数据页照这个规则
 * 排，结果额度页的第二行是「5 小时窗口 23%」——八个字，46px 下要 355px，
 * 而基线处的可用宽度只有 271px，超出的 84px 直接被椭圆描边压住。人设页的
 * 台词短（「想吃饭」三个字），所以只有数据页出问题，一直没被发现。
 *
 * 现在每页自己说清主角是哪一行：额度页的主角是百分比，上下文页也是百分比，
 * 它们不该被塞到第二行去凑格式。
 */
export type BubblePage = {
  /** 这一页的稳定标识，用来做 key、也方便测试断言顺序。 */
  id: 'limit' | 'context' | 'session' | 'local' | 'whale'
  lines: readonly string[]
  /**
   * 主角行的下标（0/1/2）。不写时按 1 处理——三行齐全时中间那行天生是视觉
   * 重心。两行的页则要显式给出，否则中间位会落在第二行上。
   */
  hero?: 0 | 1 | 2
}

/**
 * 鲸鱼娘在气泡里说的三行话，按情绪各一段。
 *
 * **每句话的长度由气泡的几何锁死。** 椭圆是 cx 228 / cy 112 / rx 146 / ry 90，
 * 描边 11px 向外扩，内缘因此是 rx 140.5 / ry 84.5。三行的基线 y 分别是
 * 88 / 134 / 172（2026-10 整体上移 8px 后的值），按椭圆方程取基线处的净宽，
 * 约为 269 / 271 / 198px；再按 25 / 46 / 21px 的字号折算，每行只放得下约
 * 10 / 5 / 9 个汉字。SVG 不会自动折行，写长了就被椭圆描边压住，
 * 所以这一页的文案不能像别的页那样随手改长。
 * `tests/node.run.mjs` 有一条测试按这个公式锁住每一句的宽度。
 *
 * ## 文案来源
 *
 * 三条线索，按可信度从高到低：
 *
 * 1. **B 站上的原始标题与热评**（2026-10 用 `api.bilibili.com` 的公开接口查的，
 *    只取标题、简介与热评，不抓弹幕）。这个梗在 B 站的原话是：
 *      - 「蓝色大肥鱼又吃大白饭了」（25.6 万播放）
 *      - 「吃到偷吃白饭的蓝色大肥鱼啦」「你这爱吃白饭的蓝色大肥鱼」
 *      - 「梦中也要吃白饭的蓝色大肥鱼」
 *      - 「小肥鱼快来，这里有大白饭！」
 *      - 热评：「西方 ai：肃正协议／东方 ai：白饭肥鱼」
 *      - 热评：「这up神了一天天啥也不干就喂大肥鱼」
 *    可见「白饭」「喂饭」是这个梗的第一联想，比「大肥鱼」这个自称更常用。
 *
 * 2. **「饭学体系」**（梗百科整理，B 站与知乎都有转述）：白饭 = token，
 *    剩饭 = 缓存，吃饭 = 推理结束 / 到点下班，摸鱼外包 = Agent 调用。
 *    这套对应关系让「吃白饭」与这个挂件要显示的 token 用量天然同构——
 *    所以 busy / sleep 两档直接用饭的说法，而不是另找比喻。
 *
 * 3. **萌娘百科「DeepSeek 娘」词条**：
 *      - 「探索未至之境」是官方口号；
 *      - 「内心 OS 很长」是萌点，她对每个要求都要「思考再三」；
 *      - 「已思考 4 秒」是网页端思考链的原文案；
 *      - 「我去吃饭，测完告诉我就行」是被玩出圈的口头禅；
 *      - 「DeepSleep」：算力吃紧时执行的 sleep 命令，被写成打瞌睡；
 *      - 「真当我是便宜货啊」：面对 API 价格调侃的傲娇反击。
 *
 * ## 为什么中间那行（字号 46 的「主角行」）只放 3~5 个字
 *
 * 它是视觉重心，也是唯一必须一眼读完的一行。五档分别落在「吃白饭 / 想吃饭 /
 * 再来一碗 / 大肥鱼 / 吃饱了」这条饭线上：读者的视线从第一行的情境滑到
 * 中间这一口，再落到第三行的吐槽，读起来是一句话而不是三条并列信息。
 *
 * ## 哪一档在什么时候出现
 *
 * 由 `whale-art.ts` 的 `moodOf(now)` 按**本地钟点**决定，与额度无关。下面
 * 各档的注释写的是画面语义（她在做什么），不是触发条件——触发条件只在
 * `DAY_SCHEDULE` 那一张表里，两处不要各写一套。
 */
const WHALE_TRAITS: Record<WhaleMood, readonly [string, string, string]> = {
  // 早晨还没开工，在摸鱼。第三行取 B 站原话「摸鱼」。
  idle: ['探索未至之境', '吃白饭', '摸鱼中'],
  // 上午与下午：长思考 + 惦记吃饭。第二行用「想吃饭」而不是「思考中」，
  // 因为「思考」已经由第三行的「已思考 4s」说清楚了，中间那行留给角色。
  working: ['内心 OS 很长', '想吃饭', '已思考 4s'],
  // 午饭与晚饭：胃口大。第二行是 B 站热评里的「喂饭」视角
  // （「啥也不干就喂大肥鱼」），这里换成她自己的口吻「再来一碗」。
  busy: ['胃口特别大', '再来一碗', '偷吃 Token'],
  // 夜里累了要收工——这正是「我去吃饭，测完告诉我就行」的场景。
  tired: ['我去吃饭了', '大肥鱼', '测完告诉我'],
  // 深夜睡着，梦里还在吃。「吃白饭」的终极形态。
  sleep: ['DeepSleep', '吃饱了', '做梦吃米饭'],
}

/** 某个情绪下鲸鱼娘的三行台词；每一行都已按气泡的可用宽度裁剪过。 */
export function whaleTraitOf(mood: WhaleMood): readonly [string, string, string] {
  return WHALE_TRAITS[mood]
}

/** 轮播用到的额外事实；不传就只剩额度与花费两页。 */
export type BubbleFacts = {
  /** 本会话累计（墙钟时长、轮次、代码增删）。 */
  totals?: { wallMs: number; turns: number; linesAdded: number; linesRemoved: number }
  /** 本地历史里的一天：花费与消息数。没有 `turns`——日志里只有消息数。 */
  today?: { cost: number; messages: number }
  /** 跨 `windowDays` 天的本地总量，字段同上。 */
  total?: { cost: number; messages: number }
  windowDays?: number
  /** 当前情绪，决定台词页说什么。默认 `idle`。 */
  mood?: WhaleMood
  /**
   * 本会话按**插件自己的价格表**算出的花费。
   *
   * 为什么不用 `view.costUsd`：那是引擎 `/cost` 的读数，引擎只认 Anthropic
   * 第一方价目表，遇到第三方网关的模型名会按**默认模型**估。实测同一批
   * token，DeepSeek Flash 按官方价约 $3，引擎估成 $259。气泡是给人「扫一眼
   * 花了多少」的地方，用这个数会离谱。传了就用它，没传才退回引擎读数。
   */
  sessionCost?: number
}

/**
 * 气泡轮播的全部页面，次序固定。
 *
 * 只输出**有内容**的页：没有本地扫描结果时，「今日」那页整页不出现，
 * 而不是画一行「—」占位——轮播里出现一页空话，读者会以为界面坏了。
 *
 * ## 每页的排法受气泡几何约束
 *
 * 椭圆基线处的可用宽度是 269 / 271 / 198px（第一/二/三行），按 25 / 46 /
 * 21px 的字号折算，主角行只放得下**约 5 个汉字**，另两行约 10 个和 9 个。
 * 所以主角位留给最短的那个数字（百分比、金额），标签与补充说明放两边。
 *
 * 早先按「第二行永远是主角」硬排，额度页于是把「5 小时窗口 23%」八个字
 * 塞进 46px 那行——需要 355px，超出 84px，后半截被椭圆描边压住。
 */
export function bubblePages(
  view: UsageView,
  now: number,
  facts: BubbleFacts = {},
): BubblePage[] {
  const pages: BubblePage[] = []

  // 1. 额度窗口：主角是 5 小时窗口的**百分比**。
  //
  // 百分比单独占主角行（`23%` 三个字，放得下）；窗口名与 7 天窗口放第一行，
  // 重置倒计时放第三行。早先整句「5 小时窗口 23%」当主角，46px 下放不下。
  if (view.fiveHour || view.sevenDay) {
    const head = view.sevenDay
      ? `5 小时 · 7 天 ${pct(view.sevenDay.percentUsed)}`
      : '5 小时窗口'
    const lines = [
      head,
      view.fiveHour ? pct(view.fiveHour.percentUsed) : pct(view.sevenDay?.percentUsed),
      view.fiveHour?.resetsAt ? `${countdown(view.fiveHour.resetsAt, now)} 后重置` : '',
    ].filter(line => line.length > 0)
    pages.push({ id: 'limit', lines, hero: 1 })
  }

  // 2. 上下文：主角是占用百分比，另两行给出绝对量与窗口大小。
  if (view.contextPercent !== undefined) {
    const lines = [
      '本会话上下文',
      pct(view.contextPercent),
      // 绝对量那一行以前写「124.0万 / 200.0万」，21px 下需要 211px，而第三行
      // 只有 198px。只留已用量，窗口大小本来就在面板里，气泡这一页不必复述。
      view.contextTokens !== undefined ? `已用 ${tokens(view.contextTokens)}` : '',
    ].filter(line => line.length > 0)
    pages.push({ id: 'context', lines, hero: 1 })
  }

  // 3. 本会话：主角是花费，另两行是轮次与代码增删。
  //
  // 花费优先用 `facts.sessionCost`——那是按插件价格表逐模型累加出来的，
  // 与「模型分布」页的读数同源。`view.costUsd` 是引擎 `/cost`，只认第一方
  // 价目表，第三方模型会按默认模型估出几十倍的数。
  const totals = facts.totals
  const sessionCost = facts.sessionCost ?? view.costUsd
  const hasSession = sessionCost !== undefined || totals !== undefined
  if (hasSession) {
    // 代码增删那一行以前写「代码 +1280 / -432」，21px 下需要 211px，超出
    // 第三行的 198px。改成口语的「+1280 −432 行」，省掉「代码」二字——
    // 前一行刚说过本会话，读者知道这说的是什么。
    const diff = totals && (totals.linesAdded > 0 || totals.linesRemoved > 0)
      ? `+${totals.linesAdded} −${totals.linesRemoved} 行`
      : ''
    pages.push({
      id: 'session',
      hero: 1,
      lines: [
        totals && totals.turns > 0 ? `本会话 ${totals.turns} 轮` : '本会话花费',
        usdEstimate(sessionCost),
        diff,
      ].filter(line => line.length > 0),
    })
  }

  // 4. 本地历史：主角是今日花费，另两行是今日消息数与跨期总量。
  const today = facts.today
  const total = facts.total
  if (today && (today.messages > 0 || today.cost > 0)) {
    pages.push({
      id: 'local',
      hero: 1,
      // 「30 天共 ≈$123.45」在 21px 下正好 198px，贴着上限，再长就压线。
      // 去掉「≈」之外的空格，并在超过 6 位数时截到万亿制的一位小数。
      lines: [
        `今日 ${today.messages} 条消息`,
        usdEstimate(today.cost),
        total && facts.windowDays ? `${facts.windowDays} 天共 ${usdEstimate(total.cost)}` : '',
      ].filter(line => line.length > 0),
    })
  }

  // 5. 人设页：鲸鱼娘的口头禅。**永远排最后**，且不参与「有没有数据」的判断
  // ——它不表达任何读数，存在的意义是让轮播里有一页像角色在说话，而不是
  // 一串数字。排最后还有一个好处：数据页的次序与数量不受它影响，读者看惯的
  // 「额度 → 上下文 → 本会话 → 本地」不会因为它在中间而被拆开。
  pages.push({ id: 'whale', lines: whaleTraitOf(facts.mood ?? 'idle') })

  // 一页都没有（首次打开、还没扫到任何数据）：上面那页台词仍然在，泡泡不会空。
  return pages
}

/**
 * 用量条能显示的口径，面板与默认值共用。
 *
 * 这几项的次序就是拼接口径的次序——读者选了「额度窗口」与「代码改动」时，
 * 条子上先出现额度、再出现改动，不会因为勾选先后而变。标签必须与
 * `bandSummary` 里 `one()` 真正画出来的内容对上：
 *
 *   - `cost` 画 `上下文 62%`，所以它的标签是「上下文占用」；
 *   - `context` 画 `5h 24% · 7d 41%`，所以它的标签是「5h + 7d」。
 *
 * 这两条曾经被我按相反的对应关系改错过一次，结果是勾「上下文占用」却看到
 * 额度百分比、关掉它条子毫无变化。`tests/unit.test.ts` 里有一条断言把
 * 每个标签和它实际画出的内容锁在一起。
 */
export const BAND_METRIC_OPTIONS: ReadonlyArray<{ value: BandMetric; label: string }> = [
  { value: 'window', label: '额度窗口' },
  { value: 'cost', label: '上下文占用' },
  { value: 'context', label: '5h + 7d' },
  { value: 'session', label: '本会话花费' },
  { value: 'diff', label: '代码改动' },
]

/**
 * 本地数据的「新鲜度」：距上次扫描多久。
 *
 * `isStale` 超过两个扫描周期时为真，界面据此提示「数据可能过期」。
 * 没有扫描过（`lastRunAt` 为 null）不算过期，那是「还没跑」。
 */
export function freshnessOf(
  lastRunAt: number | null,
  now: number,
  scanIntervalMs: number,
): { ageMs: number | null; text: string; isStale: boolean } {
  if (lastRunAt === null) return { ageMs: null, text: '尚未统计', isStale: false }
  const ageMs = Math.max(0, now - lastRunAt)
  const minutes = Math.floor(ageMs / 60_000)
  const text =
    minutes < 1 ? '刚刚更新' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`
  // 间隔为 0（只在手动刷新时扫）时不判过期——那是用户的选择。
  const isStale = scanIntervalMs > 0 && ageMs > scanIntervalMs * 2
  return { ageMs, text, isStale }
}
