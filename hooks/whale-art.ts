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
 * 立绘的高度下限（CSS 像素）。
 *
 * 宽度与高度由画布比例绑定，所以「最小高度」就是真正的下界：面板再窄，
 * 鲸鱼也至少有这么高，不会缩成一团看不清的色块。
 *
 * 从 96 提到 120，再提到 180（+50%）：泡泡里的字（尤其第二行 46px 的主角）
 * 在 620 宽的画布上缩放后，96px 高时主角只剩约 14px，小字只剩 6px——在桌面上
 * 已经读不动了。120px 是「能看清」的下限（主角约 17px、小字 8px），
 * 180px 则让主角约 26px、小字约 12px，小字号在普通面板上不必凑近看。
 *
 * 代价是最小宽度跟着到 120 / (320/620) ≈ 349px；面板很窄时立绘会占掉几乎
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
 * 面板宽度（字符列）→ 立绘的显示尺寸，宽高严格按画布比例。
 *
 * 先按面板宽度算出理想宽度，再把它夹进「最小高度」与「最大宽度」之间，
 * 最后**由宽度推出高度**。这样两个不变量同时成立：
 *   - 高度永远 ≥ `WHALE_MIN_HEIGHT`；
 *   - 高宽比永远等于画布比例，`preserveAspectRatio` 不会留白抖动。
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
function bubbleSvg(lines: readonly string[], mood: WhaleMood): string {
  const tone = TONE[mood]
  const shown = lines.slice(0, 3)

  const texts = shown
    .map((line, index) => {
      const isAmount = index === 1 && shown.length > 1
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
 * @param options `isAnimating` 为真时鲸鱼轻微上下浮动（SMIL，无需脚本）；
 *   `isBubbleOpen` 为假时整块气泡（含小泡）不画，只留鲸鱼。
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
  // 呼吸：整体上下浮动 ±4px。SMIL 在无脚本沙箱里也能跑。
  const float = isAnimating
    ? `<animateTransform attributeName="transform" type="translate" values="0 0; 0 -4; 0 0" dur="3.6s" repeatCount="indefinite" additive="sum"/>`
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WHALE_CANVAS.width} ${WHALE_CANVAS.height}" width="${WHALE_CANVAS.width}" height="${WHALE_CANVAS.height}" role="img">` +
    (isBubbleOpen ? bubbleSvg(lines, mood) : '') +
    // 鲸鱼：原图右下角贴边，尺寸 300×300。位置与气泡是否展开无关。
    `<g transform="translate(318 16)">` +
    float +
    `<image x="0" y="0" width="300" height="300" preserveAspectRatio="xMaxYMax meet" href="data:image/png;base64,${asset}"/>` +
    `</g>` +
    `</svg>`
  )
}
