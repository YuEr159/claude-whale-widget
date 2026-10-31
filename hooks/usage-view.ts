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
  /**
   * `contextPercent` 实际用的分母：会话模型的完整窗口（`context.window`），
   * 或拿不到它时的压缩窗口兜底。界面用它说清「这个百分比是相对什么算的」。
   */
  contextDenominator?: number
  /**
   * 自动压缩阈值（token 数）。**不参与占比计算**——占比按模型完整窗口算，
   * 这个值只用来提示「离压缩还有多远」。缺失表示自动压缩关着，或引擎没给。
   */
  autoCompactThreshold?: number
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

  // ---------------- 上下文占比：按「模型完整窗口」算 ----------------
  //
  // ## 分母：模型自己的窗口，不是压缩阈值
  //
  // 引擎给了**三套互不相等的**数值：
  //
  //   - `context.window` = 会话模型的完整窗口（状态栏的 `context_window_size`）
  //   - `context.percent` = `tokens / window`
  //   - `breakdown.rawMaxTokens` / `percentage` = 模型上限**或更小的压缩窗口**
  //     （引擎原话：`the model's limit, or a smaller compaction window`）
  //
  // 读者问「上下文占了多少」，答案应当是「用了这个模型的几成窗口」——
  // 1M 窗口里放了 300K 就是 30%，不是「离 400K 的压缩阈值还有 25%」。
  // 早先按压缩阈值算，300K 会被显示成 75%，同一个数字读起来像快撑爆了，
  // 而实际上还有七成空间没用。
  //
  // 压缩阈值由 `breakdown.autoCompactThreshold` 单独给出，要提示「快压缩了」
  // 的地方自己拿它比对，不该把它混进占比里。
  //
  // ## 分子：**实际计费输入**，不是引擎的估算
  //
  // 这是最容易搞错的一处。`breakdown.totalTokens` 是引擎**本地估算**出来的，
  // 把系统提示、工具定义、记忆文件逐类加起来；而 `context.tokens` 是
  // `usage` 里 API **实际计数**的输入（未缓存 + 缓存写 + 缓存读）。引擎自己
  // 在类型声明里写了 `its totalTokens need not equal tokens`——两者本来就不等。
  //
  // 历史侧（日志重建）**拿不到估算值**：`breakdown` 是引擎现算的，日志里
  // 从不写它，只有每条 assistant 消息的 `usage`。所以整条曲线统一用计费
  // 口径——否则同一轮会出现两根柱子（一根估算、一根计费，占比还不一样），
  // 读者完全无法理解。
  const breakdown = context?.breakdown as
    | { totalTokens?: unknown; autoCompactThreshold?: unknown; rawMaxTokens?: unknown }
    | undefined
  // 分母优先级：模型完整窗口 > 压缩窗口 > 引擎的完整窗口字段。
  //
  // `context.window` 是最准的那个（引擎明说它是 status line 的
  // `context_window_size`）。`rawMaxTokens` 只在没给 `window` 时兜底——
  // 它可能是被压缩窗口压小的值，用它当分母会把占比算大。
  const modelWindow =
    typeof context?.window === 'number' && context.window > 0 ? context.window : undefined
  const rawMax =
    typeof breakdown?.rawMaxTokens === 'number' && breakdown.rawMaxTokens > 0
      ? breakdown.rawMaxTokens
      : undefined
  const denominator = modelWindow ?? rawMax
  // 压缩阈值单独拿出来：它不再参与占比，但界面要用它说「离压缩还有多远」。
  const autoCompactThreshold =
    typeof breakdown?.autoCompactThreshold === 'number' && breakdown.autoCompactThreshold > 0
      ? breakdown.autoCompactThreshold
      : undefined
  // 分子：计费口径的输入 token。与历史侧（`input + cacheRead + cacheWrite`）
  // 完全同源，所以接缝处两根柱子不会高低跳。
  const billedInput = typeof context?.tokens === 'number' ? context.tokens : undefined
  const contextPercent =
    denominator !== undefined && billedInput !== undefined
      ? Math.max(0, Math.min(100, (billedInput / denominator) * 100))
      : typeof context?.percent === 'number'
        ? context.percent
        : undefined

  return {
    fiveHour: pick('five_hour'),
    sevenDay: pick('seven_day'),
    limits,
    costUsd: typeof cost?.usd === 'number' ? cost.usd : undefined,
    contextPercent,
    contextTokens: typeof context?.tokens === 'number' ? context.tokens : undefined,
    contextWindow: typeof context?.window === 'number' ? context.window : undefined,
    /** 实际用来换算占比的分母（模型窗口 / 压缩窗口），供界面说明。 */
    contextDenominator: denominator,
    /** 自动压缩阈值；不参与占比，只用于「快压缩了」的提示。 */
    autoCompactThreshold,
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
  // `window` 实际会画出哪几个窗口：有 5h 就画 5h（带倒计时），有 7d 就画 7d。
  // `context` 只补 `window` 没画的那一半，两处都从这个判断出发，才不会各算各的。
  //
  // 早先的判据是 `hasLimits`（任一窗口存在），这在只有单边窗口时全错：
  //
  //   - 只有 7d：`window` 走 `5h — · 7d 70%`（5h 明明没有却印出来），
  //     `context` 又补一遍 7d → `5h — · 7d 70% · 7d 70%`
  //   - 只有 5h：`context` 补 `7d —`，一个不存在的窗口被画成破折号
  //
  // 现在两个分支共用同一组「`window` 画了什么」的事实。
  const windowDrawsFive = metrics.includes('window') && Boolean(view.fiveHour)
  const windowDrawsSeven = metrics.includes('window') && Boolean(view.sevenDay)

  const one = (metric: BandMetric): string => {
    switch (metric) {
      case 'session':
        return `本会话 ${usdEstimate(sessionCost ?? view.costUsd)}`
      case 'cost':
        return `上下文 ${pct(view.contextPercent)}`
      case 'context': {
        // 没有额度窗口时**什么都不说**，而不是跟着写「无额度窗口」。
        //
        // 那句话是「额度窗口」这一项的消息。以前两项都返回它，靠后面的
        // 文本去重才只显示一遍——于是关掉「额度窗口」后，「5h + 7d」照样
        // 说出同一句话，读者点了开关条子毫无变化，以为开关坏了。
        // 没有数据就不该替这一项发言；`window` 那句已经把情况说清楚。
        if (!hasLimits) return ''
        // `window` 已经画过的那半边不再重复，另一半照常补上。
        const halves: string[] = []
        if (view.fiveHour && !windowDrawsFive) halves.push(`5h ${five}`)
        if (view.sevenDay && !windowDrawsSeven) halves.push(`7d ${seven}`)
        return halves.join(' · ')
      }
      default: {
        // `window`：点了「额度窗口」，条子上就该是额度窗口的消息。
        if (!hasLimits) return NO_LIMITS
        const halves: string[] = []
        if (view.fiveHour) {
          // 倒计时那一截**只在真拿到 `resetsAt` 时才拼**。引擎把它定成可选
          // 字段，缺的时候 `countdown` 返回空串，早先外层照旧拼「后重置」，
          // 条子上会出现 `5h 40% ·  后重置`（两个空格夹一个残句）。
          const left = countdown(view.fiveHour.resetsAt, now)
          halves.push(left.length > 0 ? `5h ${five} · ${left} 后重置` : `5h ${five}`)
        }
        if (view.sevenDay) halves.push(`7d ${seven}`)
        return halves.join(' · ')
      }
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
 * 2026-10-29 重新核对过一轮，按可信度从高到低：
 *
 * 1. **「大肥鱼」这个名字是她自己认领的**（17173《正惊解梗》，2026-10-23）。
 *    2026 年 8 月 DeepSeek 做了品牌拆分：黑鲸划给面向企业的 Harness（即
 *    「D老师」），消费级主品牌换成蓝鲸。V4.1 Flash 上线识图后，有网友把蓝鲸
 *    logo 丢进对话框考它认不认得自己，它先一本正经分析「用户上传了一张蓝色
 *    大肥鱼的图片」，隔了两秒才反应过来「这不就是我自己吗」。这个外号是模型
 *    自己张嘴安上的，萌点在于「又蠢又萌」——认出来了，但愣了两秒。
 *
 * 2. **B 站上的原始标题与热评**（2026-10 用 `api.bilibili.com` 的公开接口查的，
 *    只取标题、简介与热评，不抓弹幕）。原话是：
 *      - 「蓝色大肥鱼又吃大白饭了」（25.6 万播放）
 *      - 「吃到偷吃白饭的蓝色大肥鱼啦」「你这爱吃白饭的蓝色大肥鱼」
 *      - 「梦中也要吃白饭的蓝色大肥鱼」
 *      - 「小肥鱼快来，这里有大白饭！」
 *    可见「白饭」「喂饭」是这个梗的第一联想。
 *
 *    **2026-11-01 复核：删掉了两条查无实据的热评。** 早先这里还记着
 *    「西方 ai：肃正协议／东方 ai：白饭肥鱼」与「这up神了一天天啥也不干就
 *    喂大肥鱼」。对这一版的调研检索了 40+ 相关视频的弹幕、20+ 视频的热评
 *    （含两个万条级评论区）、Bing 与网页搜索，**两条都是零命中**——它们只
 *    在别处的二手转述里出现，已从文案依据中移除。**注意这两句并未被用作
 *    任何一句台词**，删的是注释里的"依据"。
 *
 * 3. **饭学对应**：白饭 = token，吃饭 = 消耗算力 / 到点下班，摸鱼 = 走神，
 *    摸鱼外包 = Agent 调用。「吃白饭」还带一点「便宜、白嫖、不干活」的自嘲
 *    ——DeepSeek 的 API 定价低到被叫「AI 界拼多多」，所以有「真当我是便宜货啊」
 *    这句傲娇反击。这套对应让「吃白饭」与挂件要显示的 token 用量天然同构。
 *
 * 4. **萌娘百科「DeepSeek 娘」词条**（`zh.moegirl.org.cn/DeepSeek娘`，
 *    2026-11-01 抓取，页面最后编辑 2026-10-29）：
 *      - 「探索未至之境」是 DeepSeek 官方 slogan（deepseek.com 平台页原文
 *        就有「深度求索（DeepSeek），探索未至之境」），被她当招牌台词用；
 *      - 「内心 OS 很长」是萌点——「能够"深度思考"，对于每个现实人类的要求都会
 *        思考再三，**有着长长的内心OS**」；
 *      - 「DeepSleep」：词条写法是「打瞌睡（运作 sleep 命令）DeepSleep」；
 *      - 「喜欢吃白米饭和 Token，而且胃口特别大，总是吃不饱」——busy 档的
 *        第一行与第二行直接来自这句；
 *      - 「工作的时候会把任务外包给其他 AI」——idle 档第三行的「摸鱼中」；
 *      - **词条对「作息 / 上下班 / 摸鱼 / 等待 / 被催 / 休息 / 加班 / 待机」
 *        这些词的出现次数都是 0**——它从没写过作息表，也没写过「等待用户」
 *        这类设定。状态栏那套「等你 / 静息」的台词全部来自下面第 5 条，
 *        不是词条里的。
 *      - 唯一与「等待」相关的身体语言：「DSH 还更新了一些思考时的图标，内容是
 *        **鲸鱼尾巴的摇晃，表达了 DeepSeek 娘内心的焦躁不安**」——所以
 *        「想」那档的注释里说她在心里组织语言，是有依据的。
 *
 * 5. **DeepSeek 官方文案**（2026-11-01 从生产环境直接读取，不是二手转述）：
 *      - **Harness 页**（`deepseek.com/harness/`）的三种状态：`深度求索中` /
 *        `已完成工作` / `已思考`；英文版是 `Deep diving...` / `Worked` /
 *        `Thought for a while`。**「深度求索中」是官方唯一一处把公司名当
 *        动词短语用在状态上的例子**，中英双关都成立。
 *      - **chat UI 的 i18n 字典**（`fe-static.deepseek.com` 的生产包）：
 *        `messageThinking` = 正在思考、`isThinking` = 思考中...、
 *        `deepSearchThinking` = 正在深度思考、`thinkingSwitch` = 深度思考、
 *        `messageThinkDuration` = `已思考（用时 X 秒）`、`chatHtmlTitle` =
 *        探索未至之境。注意官方**没有**「正在思考中」这个四字串，也**没有**
 *        任何「任务完成」类 UI 文案。
 *      - **官方从未在文案里把 logo 称为「鲸鱼」**：全站 475 条 i18n key 里
 *        「鲸」与「whale」出现 0 次（仅有的 `whale` 全是 SVG clipPath id 与
 *        `fallbackWhale.png` 文件名）。所以这个挂件用的是**社区共识**，
 *        不是官方设定。
 *
 * ## 关于「大肥鱼其实不是内置人设」
 *
 * 2026-08 网上流传过一套 `【PERSONA_LOAD】CETACEA_LOLI / FOOD_RICE / …`
 * 的「神秘代码」，说 DeepSeek 内置了鲸鱼娘人格。崔亮用跨模型对照实验证伪了
 * （《DeepSeek 真的内置了一个"鲸鱼娘"人设吗？》，2026-08-17）：同样几个 Tag
 * 丢给 ChatGPT 与 Grok 也能进入角色，改掉全部字符串后人格仍然出现，Claude
 * 则看懂了但拒绝扮演。结论是「大概率没有内置」，那些 Tag 只是高信息密度的
 * 结构化自然语言，靠模型先验补全。**所以这套文案是社区共识，不是官方设定**
 * ——写文案时别把它当「还原官方」来要求。
 *
 * ## 已经删掉的、查无实据的说法
 *
 * `tired` 档第三行原先写「测完告诉我」，配合「我去吃饭，测完告诉我就行」这句
 * 号称「出圈口头禅」。2026-10-29 用精确引号在必应搜「我去吃饭」「测完告诉我」
 * **零结果**，萌娘百科条目里也没有，仅见于一个二手梗百科页面（该页面还给出
 * 了 2026 年 8 月才发布 V4-Flash 这类精确日期，可信度不足）。已换成有出处的
 * 「到点就下班」（17173 原文：「活没干完就惦记着下班」）。
 *
 * ## 为什么中间那行（字号 46 的「主角行」）只放 3~5 个字
 *
 * 它是视觉重心，也是唯一必须一眼读完的一行。五档分别落在「吃白饭 / 想吃饭 /
 * 再来一碗 / 先吃饭 / 梦里管够」这条饭线上：读者的视线从第一行的情境滑到
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
  // 上午与下午：长思考 + 惦记吃饭。第二行是「想吃什么」的默认值——
  // 真正上屏时由 `dishOf(now)` 按时段替换，见 `DISH_SCHEDULE`。
  working: ['内心 OS 很长', '想吃饭', '已思考 4s'],
  // 午饭与晚饭：胃口大。第二行是 B 站热评里的「喂饭」视角，
  // 这里换成她自己的口吻「再来一碗」。
  busy: ['胃口特别大', '再来一碗', '偷吃 Token'],
  // 夜里累了要收工。第三行 **原先写的是「测完告诉我」，查无实据**——
  // 用精确引号在必应上搜「我去吃饭」「测完告诉我」零结果，萌娘百科条目里
  // 也没有这句。换成有出处的说法：17173《正惊解梗》（2026-10-23）原话是
  // 「上班摸鱼，到点干饭，活没干完就惦记着下班」，所以写「到点就下班」。
  //
  // 2026-11-01 复核：这句其实**有出处**，只是不在当时那一版词条里。萌百
  // 当前版本给出了完整来龙去脉——小红书用户让 DeepSeek 处理 PsychoPy 实验
  // 程序，它报告卸载依赖后跟了一句「我去吃饭，测完告诉我就行」。但台词保持
  // 不变：「到点就下班」更短，且同样是 17173 原文。
  tired: ['活没干完', '先吃饭', '到点就下班'],
  // 深夜睡着，梦里还在吃。「吃白饭」的终极形态。
  //
  // 第一行「DeepSleep」是萌百原文的写法：「打瞌睡（运作 sleep 命令）DeepSleep」。
  // 这里全大写是照抄词条，不是排版选择——它故意长得像命令名/枚举值，
  // 正是那个梗的味道。
  sleep: ['DeepSleep', '梦里管够', '做梦吃米饭'],
}

/**
 * 一天里她想吃的东西：本地钟点 → 主角行那句话。
 *
 * ## 为什么单独一张表，不并进 `DAY_SCHEDULE`
 *
 * `DAY_SCHEDULE` 回答的是「她此刻是什么状态」（睡着 / 摸鱼 / 干活 / 吃撑），
 * 每档对应一整套三行台词；这张表只回答「这一顿想吃什么」，颗粒度更细——
 * 光「上午」这一段就能再分成「刚起床想喝豆浆」和「快中午惦记小笼包」。
 * 两件事各有各的节奏，塞进同一张表会让任何一边改动都要动另一边。
 *
 * ## 文案规则
 *
 * 主角行是 46px 的视觉重心，**最多放得下 5 个汉字**（可用 271px）。
 * `tests/node.run.mjs` 里有一条测试按椭圆方程逐条量过，超了会被描边压住。
 * 所以这里全是 3–5 字的口语短句，不写完整的「我想吃……」。
 *
 * ## 边界
 *
 * 左闭右开（`[before, to)`），与 `DAY_SCHEDULE` 同一个约定。用**本地时间**：
 * 人看的是自己的钟。
 */
const DISH_SCHEDULE: ReadonlyArray<{ before: number; dish: string }> = [
  { before: 6, dish: '想吃夜宵' }, // 00:00–05:59 深夜，梦里也在找吃的
  { before: 9, dish: '豆浆油条' }, // 06:00–08:59 清晨，最经典的早饭
  { before: 11, dish: '小笼包' }, // 09:00–10:59 上午，还没到饭点就开始想
  { before: 12, dish: '快开饭了' }, // 11:00–11:59 饭前，等不及了
  { before: 14, dish: '大白饭' }, // 12:00–13:59 午饭，正题
  { before: 17, dish: '想吃下午茶' }, // 14:00–16:59 下午，嘴馋
  { before: 18, dish: '想吃晚饭' }, // 17:00–17:59 傍晚，等下班
  { before: 21, dish: '再来一碗' }, // 18:00–20:59 晚饭，胃口大
  { before: 24, dish: '想吃宵夜' }, // 21:00–23:59 夜里，又饿了
]

/**
 * 当前时刻 → 想吃的东西。按**本地时区**取钟点。
 *
 * @param now 毫秒级 Unix 时间戳
 */
export function dishOf(now: number): string {
  const hour = new Date(now).getHours()
  for (const slot of DISH_SCHEDULE) {
    if (hour < slot.before) return slot.dish
  }
  // `getHours()` 只返回 0–23，`before: 24` 一定兜住。
  return '想吃宵夜'
}

/**
 * 某个情绪下鲸鱼娘的三行台词；每一行都已按气泡的可用宽度裁剪过。
 *
 * @param mood 当前情绪，决定整套台词的底色
 * @param now  给了就用 `dishOf(now)` 替换主角行——「想吃什么」随一天里的
 *   时段变，而情绪（睡着 / 摸鱼 / 干活）只管另外两行。不给就沿用情绪那档
 *   的默认句子，调用方（预览脚本、测试）不必造一个时刻。
 */
export function whaleTraitOf(
  mood: WhaleMood,
  now?: number,
): readonly [string, string, string] {
  const base = WHALE_TRAITS[mood]
  if (now === undefined) return base
  return [base[0], dishOf(now), base[2]]
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

  // 2. 上下文：主角是占用百分比，另两行给出绝对量。
  //
  // 第一行写「上下文占用」：`contextPercent` 的分母是**会话模型的完整窗口**
  // （见 `toUsageView`），这个百分比回答的是「这个模型的窗口用了多少成」。
  // 1M 窗口里放了 300K 就是 30%。早先按自动压缩阈值算，同一个 300K 会显示
  // 成 75%，读起来像快撑爆了，而实际上还有七成空间没用。
  //
  // 「离压缩还有多远」是另一个问题，由 `autoCompactThreshold` 回答；泡泡这一页
  // 只讲占用，不在两行字里塞两个百分比。
  if (view.contextPercent !== undefined) {
    const lines = [
      '上下文占用',
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
  //
  // 传 `now` 进去：主角行（第二行）会换成这个钟点她馋的那一口（`dishOf`），
  // 一天的早中晚各不相同；另外两行仍由情绪决定。
  pages.push({ id: 'whale', lines: whaleTraitOf(facts.mood ?? 'idle', now) })

  // 一页都没有（首次打开、还没扫到任何数据）：上面那页台词仍然在，泡泡不会空。
  return pages
}

/**
 * 用量条能显示的口径，面板与默认值共用。
 *
 * 这几项的次序就是拼接口径的次序——读者选了「额度」与「代码改动」时，
 * 条子上先出现额度、再出现改动，不会因为勾选先后而变。标签必须与
 * `bandSummary` 里 `one()` 真正画出来的内容对上：
 *
 *   - `cost` 画 `上下文 62%`，所以它的标签是「上下文占用」；
 *   - `context` 画 `5h 24% · 7d 41%`，所以它的标签是「5h/7d」。
 *
 * 这两条曾经被我按相反的对应关系改错过一次，结果是勾「上下文占用」却看到
 * 额度百分比、关掉它条子毫无变化。`tests/unit.test.ts` 里有一条断言把
 * 每个标签和它实际画出的内容锁在一起。
 *
 * **标签长度是宽度预算的一部分。** 五颗芯片加一个总开关写成一行要 58 列，
 * 而 60 列面板的页内只有 56 列——旧标签「额度窗口」「5h + 7d」让门槛升到
 * 80 列，窄面板下整组必然折行，标签被孤零零留在上一行。缩到「额度」
 * 「5h/7d」后门槛降到 74 列，同时不丢语义：`window` 画的是重置倒计时、
 * `context` 画的是两个窗口的百分比，内容本来就不一样。
 */
export const BAND_METRIC_OPTIONS: ReadonlyArray<{ value: BandMetric; label: string }> = [
  { value: 'window', label: '额度' },
  { value: 'cost', label: '上下文占用' },
  { value: 'context', label: '5h/7d' },
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
