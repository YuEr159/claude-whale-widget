/**
 * 小鲸鱼画面：把原版素材（MeteorNoX/DeepSeek-Balance-Whale-Widget 的
 * `DSniang1.png`，MIT）以 base64 内嵌进 SVG，保证像素级一致。
 *
 * 为什么内嵌而不是外链：桌面端的 `Svg` 元素只接受一个完整的 SVG 字符串，
 * 没有位图元素，也不能引用插件目录里的文件。data URI 是唯一能让原图像素
 * 级呈现的方式。
 *
 * 构图沿用原版：鲸鱼 cut-out 贴在右下角，白色对话气泡在左上，三行文字叠在
 * 气泡里。气泡是代码画的（原版也是），所以文字可随数据变化。
 */
import { WHALE_ASSETS } from './whale-asset.ts'

/** 面板立绘的画布尺寸；外部显示尺寸必须按这个比例算，否则会留白抖动。 */
export const WHALE_CANVAS = { width: 620, height: 320 } as const

/** 画布的高宽比，外部计算 height 时直接乘它。 */
export const WHALE_ASPECT = WHALE_CANVAS.height / WHALE_CANVAS.width

/**
 * 立绘的最大显示宽度，也是**默认尺寸**（设置页 100% 档）。
 *
 * 从 300 提到 380：停靠面板常见 100~140 列（约 800~1120px），300px 的立绘
 * 只占三分之一，泡泡里的字被压得太小。380px 在同样宽度下约占一半，仍给
 * 上方的内容留足空间；再宽就会喧宾夺主。
 */
export const WHALE_MAX_WIDTH = 380

/**
 * 面板宽度（字符列）→ 立绘的显示尺寸，宽高严格按画布比例。
 *
 * **默认固定尺寸，不随面板宽度变化。** 早先按面板宽度算（宽度取面板的
 * 55%），结果面板一横向压缩，鲸鱼跟着缩水——读者只是把窗口拉窄，画面里
 * 的主角却变了个大小。
 *
 * 只有一种情况会缩：**面板窄到放不下**。这时按可用宽度收缩，否则立绘会
 * 溢出到面板外被裁掉（引擎的 `overflow` 只有 visible / hidden，没有滚动）。
 * 边界在 48 列附近（380px ÷ 8px 每列），比它宽的停靠面板一律用原尺寸。
 *
 * 想主动改大小，用设置页的「立绘大小」档位——那是读者自己的选择，
 * 与「窗口被拉窄」是两回事。
 */
export function whaleSizeFor(columns: number): { width: number; height: number } {
  // 一列约 8px（等宽字体在桌面端的常见值）；留一格余量，免得立绘贴死边缘。
  const availablePx = Math.max(0, columns - 1) * 8
  const width = Math.min(WHALE_MAX_WIDTH, availablePx)
  return { width, height: width * WHALE_ASPECT }
}

/** 鲸鱼的状态：决定气泡配色与提示语。 */
export type WhaleMood = 'idle' | 'working' | 'busy' | 'tired' | 'sleep'

/**
 * 一天里的作息表：本地钟点 → 情绪。
 *
 * **情绪不再跟额度走。** 额度回答的是「这一窗口用掉了多少」，与角色此刻在
 * 做什么是两回事：深夜该睡就得睡，不能因为额度还空着就让她一直精神抖擞；
 * 反过来，上午刚开工时额度可能已经过半，她也不该因此立刻变成吃撑的样子。
 *
 * 改按钟点之后，挂件在一天里的样子跟着人一起变：深夜睡着 → 早晨还没开工、
 * 摸摸鱼 → 上午干活 → 午饭吃白饭 → 下午继续 → 晚饭再吃 → 夜里累了。
 * 两顿饭各给一段 `busy`，正对「吃白饭」这个梗。
 *
 * 各段的边界都取整点，且左闭右开（`[from, to)`），这样 `hour` 只需一次比较。
 * 用**本地时间**（`Date#getHours`）而不是 UTC：人看的是自己的钟。
 */
const DAY_SCHEDULE: ReadonlyArray<{ before: number; mood: WhaleMood }> = [
  { before: 6, mood: 'sleep' }, // 00:00–05:59 深夜
  { before: 9, mood: 'idle' }, // 06:00–08:59 早晨，还没开工
  { before: 12, mood: 'working' }, // 09:00–11:59 上午
  { before: 14, mood: 'busy' }, // 12:00–13:59 午饭
  { before: 18, mood: 'working' }, // 14:00–17:59 下午
  { before: 21, mood: 'busy' }, // 18:00–20:59 晚饭
  { before: 24, mood: 'tired' }, // 21:00–23:59 夜里，累了
]

/**
 * 当前时刻 → 情绪。
 *
 * @param now 毫秒级 Unix 时间戳（`$.clock.now()` 或 `Date.now()`）。
 *   按**本地时区**取钟点，所以同一份代码在不同时区会各自按当地作息走。
 */
export function moodOf(now: number): WhaleMood {
  const hour = new Date(now).getHours()
  for (const slot of DAY_SCHEDULE) {
    if (hour < slot.before) return slot.mood
  }
  // `getHours()` 只返回 0–23，`before: 24` 一定兜住；这里只是让类型收窄。
  return 'tired'
}

/** 没有图形元素时（终端 surface）用的文字鲸鱼。 */
export function emblemOf(mood: WhaleMood): string {
  switch (mood) {
    case 'tired':
      return '🐋'
    case 'sleep':
      return '💤'
    default:
      return '🐳'
  }
}

/**
 * 气泡与文字的颜色：沿用原图的配色（#203170 描边、#4858A8 主体蓝）。
 *
 * **所有情绪共用一套配色。** 曾经按情绪换底色：额度过半转暖、夜里再暖一点，
 * 深夜转灰蓝。那套配色让气泡在一天里不断变色，读者每换一个时段都要重新
 * 适应一次，而它表达的既不是数据也不是状态——额度已经在面板里用柱状图与
 * 百分比说清楚了。情绪现在只体现在**台词**上（见 `usage-view.ts` 的
 * `WHALE_TRAITS`），画面保持原图那一份干净的白底蓝字。
 *
 * 保留这个映射而不用一个常量，是为了让 `bubbleSvg` 的签名不必改：将来若
 * 又想给某一档换色，在这里改一行即可。
 */
const TONE: Record<WhaleMood, { bubble: string; stroke: string; ink: string; amount: string; hint: string }> = {
  idle: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  working: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  busy: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  tired: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  sleep: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 白色对话气泡：大椭圆 + 两颗小泡。
 *
 * **没有尾巴。** 曾经从椭圆左下甩出一条装饰线，它不对应任何数据，还容易
 * 让人以为气泡漏了气。气泡靠位置（在鲸鱼左边）就足以说明「这是谁在说话」。
 *
 * 两颗小泡从大泡右下沿同一条射线（方向约 (0.506, 0.862)）依次变小，指向
 * 鲸鱼——「越来越远、越来越小」才读得出是同一句话的余音。小泡都留在鲸鱼
 * **左侧**（鲸鱼不透明区域从 x≈339 起，见下方 `BUBBLE_SPILL_LIMIT`）。
 *
 * 几何以椭圆中心 (228,112)、rx 146、ry 90 为准。三行文字的基线是
 * 88 / 134 / 172：整体比椭圆中线略高，第三行离下缘留出余量，不再贴着
 * 收窄的口子。
 *
 * @param hero 主角行的下标。那一行用 46px 字号，其余两行用 25px / 21px。
 *   不传时按 1 处理（三行齐全时中间那行天生是视觉重心）。
 */
function bubbleSvg(
  lines: readonly string[],
  mood: WhaleMood,
  hero: 0 | 1 | 2 = 1,
): string {
  const tone = TONE[mood]
  const shown = lines.slice(0, 3)
  // 下标越界时退回中间位——数据页的 `hero` 是枚举，但调用方可能传了
  // 一个已经不存在第三行的页（两行页），夹一次比画错字号好。
  const heroIndex = Math.min(hero, Math.max(0, shown.length - 1))

  const texts = shown
    .map((line, index) => {
      const isAmount = index === heroIndex && shown.length > 1
      const size = isAmount ? 46 : index === 0 ? 25 : 21
      const weight = isAmount ? 800 : 600
      const color = isAmount ? tone.amount : index === 2 ? tone.hint : tone.ink
      // 三行时 88 / 134 / 172；两行时整体下移居中；一行时只居中一行。
      //
      // 2026-10 整体上移 8px（约 1/4 行）：原来的三行贴椭圆中线偏下，视觉上
      // 沉在气泡底部。第三行原本在 188、贴着椭圆下缘，可用宽度只剩 123px；
      // 上移后这一行位置到 172，可用宽度反而放宽到约 198px，小字不再挤在
      // 收窄的口子里。三行都上移，行距不变，读起来仍是一个整体。
      const y = shown.length === 1 ? 110 : shown.length === 2 ? 100 + index * 44 : [88, 134, 172][index]!
      return `<text x="228" y="${y}" text-anchor="middle" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(line)}</text>`
    })
    .join('')

  return (
    `<g>` +
    // 大椭圆。**没有尾巴**：曾经从椭圆左下甩出一条，但它是纯粹的装饰线，
    // 既不对应任何数据，还会让人以为气泡漏气了。气泡靠位置（在鲸鱼左边）
    // 就足以说明「这是谁在说话」。
    `<ellipse cx="228" cy="112" rx="146" ry="90" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="11"/>` +
    // 两颗小泡：从大泡右下沿同一条射线（方向约 (0.506, 0.862)，即朝右下）
    // 依次变小，指向鲸鱼。
    //
    // **左移过 12px。** 原位置 (335,226) / (359,265) 是按注释里那个
    // 「鲸鱼占 x 378~620」摆的，而那是个错误估计——逐像素解析内嵌 PNG
    // 的不透明区域后，鲸鱼实际从 **x≈339** 就开始有像素（显示框从 318
    // 起，图里左边约 18/256 是透明的）。按旧位置摆，第一颗小泡与鲸鱼
    // 重叠 61 平方像素、第二颗 4 平方像素，正好压在脸上。
    // 现在 (323,226) / (347,265)：第一颗右缘 341.5 < 339 附近的最左像素，
    // 第二颗右缘 359 落在鲸鱼中段（那一带鲸鱼左缘在 370 开外）。
    `<ellipse cx="321" cy="226" rx="15" ry="10" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="7"/>` +
    `<ellipse cx="347" cy="265" rx="9" ry="6" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="6"/>` +
    texts +
    `</g>`
  )
}

/** 浮动的周期（毫秒）与幅度（CSS 像素）。 */
export const WHALE_FLOAT_PERIOD_MS = 3_600
export const WHALE_FLOAT_AMPLITUDE = 4

/**
 * 巡游一步的时长（毫秒）——与泡泡换页共用同一个 6 秒节奏。
 *
 * 为什么一步是 6 秒而不是更快：桌面端 `$.ui.invalidate` 的上限是每秒十次，
 * 而重绘才是位移的唯一来源（`Svg` 不传 `isInteractive` 时 SMIL 不跑，
 * 传了又画不出内嵌位图——见 `register.tsx`）。6 秒一步换来的是**零新增
 * 定时器、零额外重绘**：鲸鱼每挪一步恰好和翻页落在同一帧里。
 * 「低频巡游」就是对这个物理限制的顺势利用——快不起来，那就慢得有节奏。
 */
export const SWIM_STEP_MS = 6_000

/** 一步游多少列（一列约 8px）。3 列 = 每步 24px，肉眼一定看得见。 */
export const SWIM_STEP_COLS = 3

/**
 * 巡游轨迹：一步 `SWIM_STEP_COLS` 列的三角波，右端出发、触左端折返。
 *
 * @param now 当前时刻（毫秒，epoch）
 * @param freeCols 鲸鱼可以挪动的列数 = 面板列数 − 立绘占的列数。
 *   不满一步（< 3 列）就不游——挪不动的地方硬摆，看着像抖动不像巡游。
 * @returns 立绘这一行要向左让出的列数（0 = 贴右端，即没有巡游时的样子）。
 *
 * 相位直接由墙钟取模，不记任何状态：面板开在哪一刻，就从轨迹的哪一刻接着
 * 走；关掉再开不会跳回起点。单程步数取 `floor(freeCols / 步长)`，左端点
 * 因此可能比最左余量少走不到一步——余量留在左边，两个折返点各只停留一步，
 * 相邻两步的位移恒等，没有「到头愣一下」的顿挫。
 *
 * 100 列面板余量约 48 列：单程 16 步 ≈ 1.6 分钟，一趟来回约 3.2 分钟；越宽游得越久。
 */
export function swimOffsetFor(now: number, freeCols: number): number {
  const steps = Math.floor(freeCols / SWIM_STEP_COLS)
  if (steps < 1) return 0
  const t = Math.floor(now / SWIM_STEP_MS) % (steps * 2)
  const step = t <= steps ? t : steps * 2 - t
  return step * SWIM_STEP_COLS
}

/**
 * 生成整幅 SVG：左边气泡 + 右下原图鲸鱼。
 *
 * 鲸鱼以 256px 的内嵌 PNG 呈现，`preserveAspectRatio` 保持比例；画布
 * 620×320 与原版 1026×700 的构图比例接近。
 *
 * **鲸鱼的位置不随气泡变化**：无论气泡画不画、画几行，鲸鱼都钉在同一个
 * `translate(318 16)` 上。这样点开 / 收起泡泡时画面不会跳，鲸鱼也不会
 * 因为左边让出空间而挪位——它始终在右下角。
 *
 * ## 浮动动画为什么带负 `begin`
 *
 * 宿主把 `Svg` 的 `source` 当作元素的**数据**：字符串一变，整份 SVG 文档
 * 重建，里面的 SMIL 时间轴随之归零。泡泡每 6 秒翻一页，`source` 就换一次，
 * 浮动于是每次都从「最上面那一帧」重新开始——看起来就是「卡一下再从头浮」。
 *
 * 修法是给动画一个**负的 `begin`**，把它拨到「已经播了多久」的位置：新文档
 * 一出现，SMIL 直接算到当前相位，而不是从头播。`begin="-2.7s"` 表示这条
 * 动画在文档时间 −2.7 秒时就已经开始。
 *
 * 因此 `whaleSvg` 需要知道**当前时刻**与**动画自己的零点**。零点必须由调用
 * 方固定住（模块加载时记一次），不能每帧重算——否则相位会跟着墙钟乱跳。
 *
 * @param mood 情绪，决定气泡配色
 * @param lines 气泡里最多三行文字
 * @param options `isAnimating` 为真时鲸鱼轻微上下浮动（SMIL，无需脚本）；
 *   `isBubbleOpen` 为假时整块气泡（含小泡）不画，只留鲸鱼。
 *   泡泡现在是常驻的，这个开关只为「画一张没有气泡的图」保留（导出、测试）。
 *   `now` 与 `epoch` 用来算负 `begin`：不传就按「刚好从头开始」处理。
 *   `hero` 是主角行的下标，那一行用 46px，其余用 25 / 21px。
 */
export function whaleSvg(
  mood: WhaleMood,
  lines: readonly string[],
  options: {
    isAnimating?: boolean
    isCompact?: boolean
    isBubbleOpen?: boolean
    /** 主角行的下标（0/1/2）。不传按 1 处理。 */
    hero?: 0 | 1 | 2
    /** 当前时刻（毫秒）。与 `epoch` 一起决定动画相位。 */
    now?: number
    /** 动画的零点（毫秒）。应当固定，不随重绘变化。 */
    epoch?: number
  } = {},
): string {
  const isAnimating = options.isAnimating ?? true
  const isBubbleOpen = options.isBubbleOpen ?? true
  // 常驻条很小（显示约 46×24 像素），用小图省内存；面板用大图保证清晰。
  const asset = options.isCompact ? WHALE_ASSETS.small : WHALE_ASSETS.large
  // 浮动：整体上下 ±4px。SMIL 在无脚本沙箱里也能跑。
  //
  // `begin` 取**负值**：把动画拨到「已经播了 phase 毫秒」的位置。宿主重绘
  // 换一份新文档时，SMIL 从 `begin` 起算，于是接着原来的相位播，不再归零。
  // 没有 `now`/`epoch` 时 phase 为 0，行为与以前一致（从头开始）。
  const elapsed = options.now !== undefined && options.epoch !== undefined
    ? Math.max(0, options.now - options.epoch)
    : 0
  const phase = elapsed % WHALE_FLOAT_PERIOD_MS
  const begin = phase > 0 ? ` begin="-${(phase / 1000).toFixed(3)}s"` : ''
  const float = isAnimating
    ? `<animateTransform attributeName="transform" type="translate" values="0 0; 0 -4; 0 0" dur="3.6s" repeatCount="indefinite" additive="sum"${begin}/>`
    : ''

  return (
    // ## 根元素：像素尺寸，不加百分比
    //
    // `Svg` 的 `width`/`height` props 决定显示框，`viewBox` 负责把 620×320
    // 缩放到那个框里。根元素自己也写像素尺寸，与 `viewBox` 一致——这样它
    // 作为独立文件打开时也有确定的固有尺寸。
    //
    // **不要改成 `width="100%" height="100%"`**：`height="100%"` 是相对父级
    // 解析的，在没有确定高度的容器里（比如 sandbox iframe 的 `body`，
    // 高度是 auto）百分比失去基准、塌成 0，整幅图都不画。实测面板里会变成
    // 一块纯白。
    //
    // 也不要依赖 `isInteractive` 那条沙箱路径来跑 SMIL：那条路径画不出内嵌
    // 的 `<image>` 位图，鲸鱼会整个消失（只剩矢量气泡）。详见 `register.tsx`
    // 里 `<Svg>` 那一处的说明。
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WHALE_CANVAS.width} ${WHALE_CANVAS.height}" width="${WHALE_CANVAS.width}" height="${WHALE_CANVAS.height}" preserveAspectRatio="xMidYMid meet" role="img">` +
    (isBubbleOpen ? bubbleSvg(lines, mood, options.hero ?? 1) : '') +
    // 鲸鱼：原图右下角贴边，尺寸 300×300。位置与气泡是否展开无关。
    `<g transform="translate(318 16)">` +
    float +
    `<image x="0" y="0" width="300" height="300" preserveAspectRatio="xMaxYMax meet" href="data:image/png;base64,${asset}"/>` +
    `</g>` +
    `</svg>`
  )
}
