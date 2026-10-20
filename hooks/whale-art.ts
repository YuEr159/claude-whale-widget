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
 * 面板宽度（字符列）→ 立绘显示宽度（CSS 像素）。
 *
 * 一条连续的公式，没有「宽/窄两套系数」的阈值切换：
 * 立绘占面板宽度的 55%，再夹在 [MIN, MAX] 之间。因为夹取的两端都是常数，
 * 宽度变化时结果要么完全不动（夹住时），要么按 0.55 × 8px 线性变化，
 * 不会出现跳变。
 */
export function whaleWidthFor(columns: number): number {
  const pxPerColumn = 8
  const share = 0.55
  return Math.max(WHALE_MIN_WIDTH, Math.min(columns * pxPerColumn * share, WHALE_MAX_WIDTH))
}

/** 立绘的最小显示宽度：再小就只剩一团色块。 */
export const WHALE_MIN_WIDTH = 150

/** 立绘的最大显示宽度：超过它面板会显得头重脚轻。 */
export const WHALE_MAX_WIDTH = 300

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
 * 白色对话气泡：大椭圆 + 尾巴 + 两颗小泡，比例取自原版（1026×700 画布上
 * 大椭圆中心 (454,247)、rx 373、ry 232、描边 18）。这里等比缩到 620×320。
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
      // 三行时 96 / 148 / 190；两行时整体下移居中；一行时只居中一行
      const y = shown.length === 1 ? 118 : shown.length === 2 ? 108 + index * 44 : 96 + index * 46
      return `<text x="228" y="${y}" text-anchor="middle" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(line)}</text>`
    })
    .join('')

  return (
    `<g>` +
    // 尾巴：从气泡左下伸向鲸鱼
    `<path d="M132 200 q-22 22 -38 38" fill="none" stroke="${tone.stroke}" stroke-width="12" stroke-linecap="round"/>` +
    // 大椭圆
    `<ellipse cx="228" cy="112" rx="146" ry="90" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="11"/>` +
    // 两颗小泡
    `<ellipse cx="126" cy="240" rx="16" ry="11" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="7"/>` +
    `<ellipse cx="172" cy="272" rx="10" ry="7" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="6"/>` +
    texts +
    `</g>`
  )
}

/**
 * 生成整幅 SVG：左上气泡 + 右下原图鲸鱼。
 *
 * 鲸鱼以 512px 的内嵌 PNG 呈现，`preserveAspectRatio` 保持比例；画布
 * 620×320 与原版 1026×700 的构图比例接近。
 *
 * @param mood 情绪，决定气泡配色
 * @param lines 气泡里最多三行文字（第一行标签、第二行金额、第三行提示）
 * @param options `isAnimating` 为真时鲸鱼轻微上下浮动（SMIL，无需脚本）
 */
export function whaleSvg(
  mood: WhaleMood,
  lines: readonly string[],
  options: { isAnimating?: boolean; isCompact?: boolean } = {},
): string {
  const isAnimating = options.isAnimating ?? true
  // 常驻条很小（显示约 46×24 像素），用小图省内存；面板用大图保证清晰。
  const asset = options.isCompact ? WHALE_ASSETS.small : WHALE_ASSETS.large
  // 呼吸：整体上下浮动 ±4px。SMIL 在无脚本沙箱里也能跑。
  const float = isAnimating
    ? `<animateTransform attributeName="transform" type="translate" values="0 0; 0 -4; 0 0" dur="3.6s" repeatCount="indefinite" additive="sum"/>`
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WHALE_CANVAS.width} ${WHALE_CANVAS.height}" width="${WHALE_CANVAS.width}" height="${WHALE_CANVAS.height}" role="img">` +
    bubbleSvg(lines, mood) +
    // 鲸鱼：原图右下角贴边，尺寸 300×300
    `<g transform="translate(318 16)">` +
    float +
    `<image x="0" y="0" width="300" height="300" preserveAspectRatio="xMaxYMax meet" href="data:image/png;base64,${asset}"/>` +
    `</g>` +
    `</svg>`
  )
}
