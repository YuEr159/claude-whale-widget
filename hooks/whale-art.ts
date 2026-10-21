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

/**
 * 「呼吸」的幅度：纵向缩放倍数在 `1 ± WHALE_BREATH_AMPLITUDE` 之间波动。
 *
 * 这是一个**动画**，不是静态造型。鲸鱼不再上下平移——位移会让它在面板里
 * 晃来晃去；改成纵向轻微胀缩：底边不动，上沿上下移动，像呼吸。
 *
 * ±5% 是**整幅**（气泡、小泡、鲸鱼、文字）一起缩放。上一版曾把文字单独
 * 拆出来不缩放，那是因为固定 1.35 的拉伸会把字形压扁；而 ±5% 的变化量
 * 小到看不出字被拉长，整幅一起缩放反而更自然——气泡胀的时候，字也跟着
 * 一起胀。
 */
export const WHALE_BREATH_AMPLITUDE = 0.05

/**
 * 「呼吸」动画，周期 `WHALE_FLOAT_PERIOD_MS`。
 *
 * 用 `keySplines` 而不是一串 `values`：SMIL 的 `values` 默认线性插值，
 * 折线看起来像机械伸缩；`0.5 0 0.5 1` 是标准的 ease-in-out，四段拼起来
 * 在一个周期内的观感与正弦几乎一致。
 *
 * `if (isAnimating)` 在调用处判断——静态图（导出、测试、预览）不画这条线，
 * 否则每张图各跑一条时间线。
 */
function breatheAnimation(): string {
  const low = (1 - WHALE_BREATH_AMPLITUDE).toFixed(4)
  const high = (1 + WHALE_BREATH_AMPLITUDE).toFixed(4)
  return (
    `<animateTransform attributeName="transform" type="scale" ` +
    `values="1 1; 1 ${high}; 1 1; 1 ${low}; 1 1" ` +
    `keyTimes="0; 0.25; 0.5; 0.75; 1" ` +
    `calcMode="spline" keySplines="0.5 0 0.5 1; 0.5 0 0.5 1; 0.5 0 0.5 1; 0.5 0 0.5 1" ` +
    `dur="${WHALE_FLOAT_PERIOD_MS}ms" repeatCount="indefinite" additive="sum"/>`
  )
}

/** 面板立绘的画布尺寸。呼吸只是动画，画布按未呼吸时的比例。 */
export const WHALE_CANVAS = { width: 620, height: 320 } as const

/** 画布的高宽比，外部计算 height 时直接乘它。 */
export const WHALE_ASPECT = WHALE_CANVAS.height / WHALE_CANVAS.width

/**
 * 立绘的高度下限（CSS 像素）。
 *
 * 宽度与高度由画布比例绑定，所以「最小高度」就是真正的下界：面板再窄，
 * 鲸鱼也至少有这么高，不会缩成一团看不清的色块。
 *
 * 数值沿革：96 → 120 → 180。泡泡里的字（尤其 46px 的主角行）在 620 宽的
 * 画布上缩放后，96px 高时主角只剩约 14px，小字只剩 6px——桌面上已经读不动。
 * 180px 高对应缩放 0.29（画布 620×320 缩到 180px 高）：主角约 13px、
 * 小字约 6px，是「再小就真的看不清」的下限。
 *
 * 代价是最小宽度 = 180 / (320/620) ≈ 349px；面板很窄时立绘会占掉几乎
 * 整行，这是有意为之——这个挂件的主角就是这条鲸鱼。
 */
export const WHALE_MIN_HEIGHT = 180

/**
 * 由最小高度反推出的最小宽度。
 *
 * 尺寸最终由 `whaleSizeFor()` 一次算定，这个常量只用于断言与文档：
 * 任何显示尺寸都必须同时满足 `height ≥ WHALE_MIN_HEIGHT`。
 */
export const WHALE_MIN_WIDTH = WHALE_MIN_HEIGHT / WHALE_ASPECT

/**
 * 立绘的最大显示宽度。
 *
 * 从 300 提到 380：停靠面板常见 100~140 列（约 800~1120px），300px 的立绘
 * 只占三分之一，泡泡里的字被压得太小。380px 在同样宽度下约占一半，仍给
 * 上方的内容留足空间；再宽就会喧宾夺主。
 */
export const WHALE_MAX_WIDTH = 380

/**
 * 呼吸动画的周期（毫秒）。**气泡翻页周期必须是它的整数倍**：
 * 每翻一页都会换掉整份 SVG `source`，SMIL 动画随之从头开始；若两个周期
 * 不成整数倍，翻页那一刻动画正好停在半途，画面会跳一下。
 */
export const WHALE_FLOAT_PERIOD_MS = 3_000

/**
 * 面板宽度（字符列）→ 立绘的显示尺寸，宽高严格按画布比例。
 *
 * 先按面板宽度算出理想宽度，再用它推高度。不变量：
 *   - 高度永远 ≥ `WHALE_MIN_HEIGHT`；
 *   - 高宽比永远等于 `WHALE_ASPECT`，根 SVG 才不会留白。
 *
 * 呼吸动画在 ±5% 以内胀缩，不改变这个静态尺寸——`Svg` 的盒子按静态
 * 尺寸占位，动画只画在里面。
 */
export function whaleSizeFor(columns: number): { width: number; height: number } {
  const pxPerColumn = 8
  const share = 0.55
  const byPanel = columns * pxPerColumn * share
  // 宽度下界由最小高度决定，上界是面板观感的极限。
  const width = Math.max(WHALE_MIN_WIDTH, Math.min(byPanel, WHALE_MAX_WIDTH))
  return { width, height: width * WHALE_ASPECT }
}

/** 鲸鱼的状态：决定气泡配色与提示语。 */
export type WhaleMood = 'idle' | 'working' | 'busy' | 'tired' | 'sleep'

/** 用量百分比 → 情绪：越满越累。 */
export function moodOf(percent: number | undefined, isWorking: boolean): WhaleMood {
  if (percent === undefined) return isWorking ? 'working' : 'idle'
  if (percent >= 95) return 'sleep'
  if (percent >= 80) return 'tired'
  if (percent >= 50) return 'busy'
  return isWorking ? 'working' : 'idle'
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
 * 额度吃紧时气泡底色转暖，是唯一的数据表达，不改变鲸鱼本身。
 */
const TONE: Record<WhaleMood, { bubble: string; stroke: string; ink: string; amount: string; hint: string }> = {
  idle: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  working: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  busy: { bubble: '#FFFAF0', stroke: '#7A5A20', ink: '#5C4318', amount: '#B07A28', hint: '#A08A60' },
  tired: { bubble: '#FFF3E8', stroke: '#8A4A2A', ink: '#6B3620', amount: '#B5653C', hint: '#A88470' },
  sleep: { bubble: '#F2F3F8', stroke: '#4A4F68', ink: '#3A3F58', amount: '#6B7088', hint: '#9AA0B8' },
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
 * **左侧**（鲸鱼占 x 378~620），否则会压到它脸上。
 *
 * 几何以椭圆中心 (228,112)、rx 146、ry 90 为准。三行文字的基线是
 * 88 / 134 / 172：整体比椭圆中线略高，第三行离下缘留出余量，不再贴着
 * 收窄的口子。
 */
/**
 * 气泡里三行文字的基线（三行齐全时）：96 / 142 / 180。
 *
 * 比椭圆中线（112）略偏上：第三行若贴到下缘，椭圆在那里已经收得很窄，
 * 字会被描边压住。2026-10 整体上移 8px（约 1/4 行）后，第三行可用宽度
 * 从 123px 放宽到 167px。
 */
const BUBBLE_TEXT_Y = [96, 142, 180] as const

function bubbleSvg(lines: readonly string[], mood: WhaleMood): string {
  const tone = TONE[mood]
  const shown = lines.slice(0, 3)

  const texts = shown
    .map((line, index) => {
      const isAmount = index === 1 && shown.length > 1
      const size = isAmount ? 46 : index === 0 ? 25 : 21
      const weight = isAmount ? 800 : 600
      const color = isAmount ? tone.amount : index === 2 ? tone.hint : tone.ink
      // 三行时用固定的一组基线；两行时整体下移居中；一行时只居中一行。
      const y =
        shown.length === 1
          ? 110
          : shown.length === 2
            ? 100 + index * 44
            : BUBBLE_TEXT_Y[index]!
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
    // 依次变小，指向鲸鱼。位置都留在鲸鱼**左侧**（鲸鱼占 x 378~620），
    // 否则会压到它脸上。
    `<ellipse cx="335" cy="226" rx="15" ry="10" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="7"/>` +
    `<ellipse cx="359" cy="265" rx="9" ry="6" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="6"/>` +
    texts +
    `</g>`
  )
}

/**
 * 生成整幅 SVG：左边气泡 + 右下原图鲸鱼。
 *
 * 鲸鱼以 512px 的内嵌 PNG 呈现，`preserveAspectRatio` 保持比例；画布
 * 620×320 与原版 1026×700 的构图比例接近。
 *
 * **鲸鱼的位置不随气泡变化**：无论气泡画不画、画几行，鲸鱼都钉在同一个
 * `translate(318 16)` 上。这样点开 / 收起泡泡时画面不会跳，鲸鱼也不会
 * 因为左边让出空间而挪位——它始终在右下角。
 *
 * @param mood 情绪，决定气泡配色
 * @param lines 气泡里最多三行文字（第一行标签、第二行金额、第三行提示）
 * @param options `isAnimating` 为真时整幅画面做纵向「呼吸」（SMIL，无需
 *   脚本）；`isBubbleOpen` 为假时整块气泡（含小泡）不画，只留鲸鱼。
 *   泡泡现在是常驻的，这个开关只为「画一张没有气泡的图」保留（导出、测试）。
 */
export function whaleSvg(
  mood: WhaleMood,
  lines: readonly string[],
  options: {
    isAnimating?: boolean
    isCompact?: boolean
    isBubbleOpen?: boolean
  } = {},
): string {
  const isAnimating = options.isAnimating ?? true
  const isBubbleOpen = options.isBubbleOpen ?? true
  // 常驻条很小（显示约 46×24 像素），用小图省内存；面板用大图保证清晰。
  const asset = options.isCompact ? WHALE_ASSETS.small : WHALE_ASSETS.large
  // 呼吸：整幅纵向 0.95~1.05 缩放，**没有平移**。SMIL 在无脚本沙箱里也能跑。
  //
  // 周期写成 `WHALE_FLOAT_PERIOD_MS`，因为**气泡翻页周期必须是它的整数倍**
  // ——每翻一页整份 `source` 被换掉，动画从头开始；不成整数倍时翻页那一刻
  // 动画停在半途，画面会跳一下。
  const breathe = isAnimating ? breatheAnimation() : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WHALE_CANVAS.width} ${WHALE_CANVAS.height}" width="${WHALE_CANVAS.width}" height="${WHALE_CANVAS.height}" role="img">` +
    // 呼吸作用在**整幅**内容上，并且**底边固定、上沿上下动**。
    //
    // 用三层嵌套而不是 `transform-origin`：缩放以原点为中心时，画面会
    // 上下两边同时涨缩、整体位置看起来在飘；而 `transform-origin` 是 CSS
    // 属性，SVG 光栅化器不保证实现。三层平移把原点搬到画布底边：
    //   外层 translate(0 H) → 中间 scale(1 s) → 内层 translate(0 -H)
    // 任一内容点 P 的最终位置是 s·(P − H) + H，P = H 时不动，正是底边。
    `<g transform="translate(0 ${WHALE_CANVAS.height})">` +
    // 中间这层不写静态 transform：SMIL 的 `additive` 默认为 replace，
    // 叠加顺序在不同渲染器里一致，不用赌 `sum` 的语义。
    `<g>` +
    breathe +
    `<g transform="translate(0 -${WHALE_CANVAS.height})">` +
    (isBubbleOpen ? bubbleSvg(lines, mood) : '') +
    // 鲸鱼：原图右下角贴边，尺寸 300×300。位置与气泡是否展开无关。
    `<g transform="translate(318 16)">` +
    `<image x="0" y="0" width="300" height="300" preserveAspectRatio="xMaxYMax meet" href="data:image/png;base64,${asset}"/>` +
    `</g>` +
    `</g>` +
    `</g>` +
    `</g>` +
    `</svg>`
  )
}
