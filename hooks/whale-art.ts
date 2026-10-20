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
 * 常驻条用的像素画：二次元女仆装的美少女，头上的鲸鱼元素呼应原版。
 *
 * 为什么用像素画而不是内嵌原图：常驻条只有一行高，原图缩到这个尺寸五官
 * 会糊成一团；40×40 的像素画在这个尺寸下反而清楚，也更接近桌面端自带的
 * 像素风格（小鲸鱼旁的小章鱼 Clawd 就是这种画法）。
 *
 * 每个 `rect` 是一行里一段同色的连续格，按行优先排列。配色取自原图：
 * 蓝发 #4860a8 / 亮蓝 #6a80c0 / 深蓝描边 #22305e / 肤色 #f0d8d8 /
 * 白色围裙与荷叶边 #f0f0f0 / 腮红 #e8a0b0。画布 40×40、
 * `shape-rendering="crispEdges"`，放大时保持硬边不发虚。
 */
const PIXEL_MAID =
'<rect x="20" y="0" width="1" height="1" fill="#4860a8"/><rect x="11" y="1" width="4" height="1" fill="#ffffff"/><rect x="16" y="1" width="1" height="1" fill="#f0f0f0"/><rect x="17" y="1" width="1" height="1" fill="#ffffff"/><rect x="18" y="1" width="1" height="1" fill="#f0f0f0"/><rect x="19" y="1" width="1" height="1" fill="#ffffff"/><rect x="20" y="1" width="1" height="1" fill="#f0f0f0"/><rect x="21" y="1" width="1" height="1" fill="#ffffff"/><rect x="22" y="1" width="1" height="1" fill="#f0f0f0"/><rect x="23" y="1" width="1" height="1" fill="#ffffff"/><rect x="24" y="1" width="1" height="1" fill="#f0f0f0"/><rect x="11" y="2" width="1" height="1" fill="#ffffff"/><rect x="12" y="2" width="2" height="1" fill="#e8a0b0"/><rect x="14" y="2" width="1" height="1" fill="#ffffff"/><rect x="16" y="2" width="10" height="1" fill="#f0f0f0"/><rect x="11" y="3" width="1" height="1" fill="#ffffff"/><rect x="12" y="3" width="2" height="1" fill="#22305e"/><rect x="14" y="3" width="1" height="1" fill="#ffffff"/><rect x="15" y="3" width="14" height="1" fill="#22305e"/><rect x="11" y="4" width="20" height="1" fill="#22305e"/><rect x="10" y="5" width="1" height="1" fill="#22305e"/><rect x="11" y="5" width="20" height="1" fill="#4860a8"/><rect x="31" y="5" width="1" height="1" fill="#22305e"/><rect x="9" y="6" width="5" height="1" fill="#22305e"/><rect x="14" y="6" width="7" height="1" fill="#f0f0f0"/><rect x="21" y="6" width="12" height="1" fill="#22305e"/><rect x="9" y="7" width="1" height="1" fill="#22305e"/><rect x="10" y="7" width="4" height="1" fill="#4860a8"/><rect x="14" y="7" width="1" height="1" fill="#22305e"/><rect x="15" y="7" width="2" height="1" fill="#4860a8"/><rect x="17" y="7" width="1" height="1" fill="#22305e"/><rect x="18" y="7" width="2" height="1" fill="#4860a8"/><rect x="20" y="7" width="1" height="1" fill="#22305e"/><rect x="21" y="7" width="2" height="1" fill="#4860a8"/><rect x="23" y="7" width="1" height="1" fill="#22305e"/><rect x="24" y="7" width="2" height="1" fill="#4860a8"/><rect x="26" y="7" width="1" height="1" fill="#22305e"/><rect x="27" y="7" width="2" height="1" fill="#4860a8"/><rect x="29" y="7" width="1" height="1" fill="#22305e"/><rect x="30" y="7" width="2" height="1" fill="#4860a8"/><rect x="32" y="7" width="1" height="1" fill="#22305e"/><rect x="9" y="8" width="1" height="1" fill="#22305e"/><rect x="10" y="8" width="2" height="1" fill="#4860a8"/><rect x="12" y="8" width="18" height="1" fill="#f0d8d8"/><rect x="30" y="8" width="2" height="1" fill="#4860a8"/><rect x="32" y="8" width="1" height="1" fill="#22305e"/><rect x="9" y="9" width="1" height="1" fill="#22305e"/><rect x="10" y="9" width="2" height="1" fill="#4860a8"/><rect x="12" y="9" width="18" height="1" fill="#f0d8d8"/><rect x="30" y="9" width="2" height="1" fill="#4860a8"/><rect x="32" y="9" width="1" height="1" fill="#22305e"/><rect x="9" y="10" width="1" height="1" fill="#22305e"/><rect x="10" y="10" width="2" height="1" fill="#4860a8"/><rect x="12" y="10" width="3" height="1" fill="#f0d8d8"/><rect x="15" y="10" width="4" height="1" fill="#22305e"/><rect x="19" y="10" width="3" height="1" fill="#f0d8d8"/><rect x="22" y="10" width="4" height="1" fill="#22305e"/><rect x="26" y="10" width="4" height="1" fill="#f0d8d8"/><rect x="30" y="10" width="2" height="1" fill="#4860a8"/><rect x="32" y="10" width="1" height="1" fill="#22305e"/><rect x="9" y="11" width="1" height="1" fill="#22305e"/><rect x="10" y="11" width="2" height="1" fill="#4860a8"/><rect x="12" y="11" width="3" height="1" fill="#f0d8d8"/><rect x="15" y="11" width="1" height="1" fill="#1c2440"/><rect x="16" y="11" width="1" height="1" fill="#ffffff"/><rect x="17" y="11" width="2" height="1" fill="#1c2440"/><rect x="19" y="11" width="3" height="1" fill="#f0d8d8"/><rect x="22" y="11" width="1" height="1" fill="#1c2440"/><rect x="23" y="11" width="1" height="1" fill="#ffffff"/><rect x="24" y="11" width="2" height="1" fill="#1c2440"/><rect x="26" y="11" width="4" height="1" fill="#f0d8d8"/><rect x="30" y="11" width="2" height="1" fill="#4860a8"/><rect x="32" y="11" width="1" height="1" fill="#22305e"/><rect x="9" y="12" width="1" height="1" fill="#22305e"/><rect x="10" y="12" width="2" height="1" fill="#4860a8"/><rect x="12" y="12" width="3" height="1" fill="#f0d8d8"/><rect x="15" y="12" width="4" height="1" fill="#1c2440"/><rect x="19" y="12" width="3" height="1" fill="#f0d8d8"/><rect x="22" y="12" width="4" height="1" fill="#1c2440"/><rect x="26" y="12" width="4" height="1" fill="#f0d8d8"/><rect x="30" y="12" width="2" height="1" fill="#4860a8"/><rect x="32" y="12" width="1" height="1" fill="#22305e"/><rect x="9" y="13" width="1" height="1" fill="#22305e"/><rect x="10" y="13" width="2" height="1" fill="#4860a8"/><rect x="12" y="13" width="3" height="1" fill="#f0d8d8"/><rect x="15" y="13" width="4" height="1" fill="#6a80c0"/><rect x="19" y="13" width="3" height="1" fill="#f0d8d8"/><rect x="22" y="13" width="4" height="1" fill="#6a80c0"/><rect x="26" y="13" width="4" height="1" fill="#f0d8d8"/><rect x="30" y="13" width="2" height="1" fill="#4860a8"/><rect x="32" y="13" width="1" height="1" fill="#22305e"/><rect x="9" y="14" width="1" height="1" fill="#22305e"/><rect x="10" y="14" width="2" height="1" fill="#4860a8"/><rect x="12" y="14" width="1" height="1" fill="#f0d8d8"/><rect x="13" y="14" width="2" height="1" fill="#e8a0b0"/><rect x="15" y="14" width="12" height="1" fill="#f0d8d8"/><rect x="27" y="14" width="2" height="1" fill="#e8a0b0"/><rect x="29" y="14" width="1" height="1" fill="#f0d8d8"/><rect x="30" y="14" width="2" height="1" fill="#4860a8"/><rect x="32" y="14" width="1" height="1" fill="#22305e"/><rect x="9" y="15" width="1" height="1" fill="#22305e"/><rect x="10" y="15" width="2" height="1" fill="#4860a8"/><rect x="12" y="15" width="8" height="1" fill="#f0d8d8"/><rect x="20" y="15" width="2" height="1" fill="#1c2440"/><rect x="22" y="15" width="8" height="1" fill="#f0d8d8"/><rect x="30" y="15" width="2" height="1" fill="#4860a8"/><rect x="32" y="15" width="1" height="1" fill="#22305e"/><rect x="9" y="16" width="1" height="1" fill="#22305e"/><rect x="10" y="16" width="2" height="1" fill="#4860a8"/><rect x="12" y="16" width="18" height="1" fill="#f0d8d8"/><rect x="30" y="16" width="2" height="1" fill="#4860a8"/><rect x="32" y="16" width="1" height="1" fill="#22305e"/><rect x="9" y="17" width="1" height="1" fill="#22305e"/><rect x="10" y="17" width="2" height="1" fill="#4860a8"/><rect x="12" y="17" width="18" height="1" fill="#f0d8d8"/><rect x="30" y="17" width="2" height="1" fill="#4860a8"/><rect x="32" y="17" width="1" height="1" fill="#22305e"/><rect x="9" y="18" width="1" height="1" fill="#22305e"/><rect x="10" y="18" width="3" height="1" fill="#4860a8"/><rect x="13" y="18" width="16" height="1" fill="#f0d8d8"/><rect x="29" y="18" width="3" height="1" fill="#4860a8"/><rect x="32" y="18" width="1" height="1" fill="#22305e"/><rect x="8" y="19" width="1" height="1" fill="#22305e"/><rect x="9" y="19" width="3" height="1" fill="#4860a8"/><rect x="17" y="19" width="8" height="1" fill="#f0d8d8"/><rect x="30" y="19" width="3" height="1" fill="#4860a8"/><rect x="33" y="19" width="1" height="1" fill="#22305e"/><rect x="8" y="20" width="1" height="1" fill="#22305e"/><rect x="9" y="20" width="3" height="1" fill="#4860a8"/><rect x="15" y="20" width="12" height="1" fill="#ffffff"/><rect x="30" y="20" width="3" height="1" fill="#4860a8"/><rect x="33" y="20" width="1" height="1" fill="#22305e"/><rect x="8" y="21" width="1" height="1" fill="#22305e"/><rect x="9" y="21" width="3" height="1" fill="#4860a8"/><rect x="15" y="21" width="1" height="1" fill="#ffffff"/><rect x="17" y="21" width="8" height="1" fill="#4860a8"/><rect x="25" y="21" width="1" height="1" fill="#ffffff"/><rect x="30" y="21" width="3" height="1" fill="#4860a8"/><rect x="33" y="21" width="1" height="1" fill="#22305e"/><rect x="8" y="22" width="1" height="1" fill="#22305e"/><rect x="9" y="22" width="1" height="1" fill="#4860a8"/><rect x="10" y="22" width="3" height="1" fill="#22305e"/><rect x="13" y="22" width="4" height="1" fill="#4860a8"/><rect x="17" y="22" width="6" height="1" fill="#22305e"/><rect x="23" y="22" width="4" height="1" fill="#4860a8"/><rect x="27" y="22" width="3" height="1" fill="#22305e"/><rect x="30" y="22" width="3" height="1" fill="#4860a8"/><rect x="33" y="22" width="1" height="1" fill="#22305e"/><rect x="8" y="23" width="1" height="1" fill="#22305e"/><rect x="9" y="23" width="1" height="1" fill="#4860a8"/><rect x="10" y="23" width="3" height="1" fill="#ffffff"/><rect x="13" y="23" width="3" height="1" fill="#4860a8"/><rect x="16" y="23" width="1" height="1" fill="#22305e"/><rect x="17" y="23" width="2" height="1" fill="#ffffff"/><rect x="19" y="23" width="2" height="1" fill="#6a80c0"/><rect x="21" y="23" width="2" height="1" fill="#ffffff"/><rect x="23" y="23" width="1" height="1" fill="#22305e"/><rect x="24" y="23" width="3" height="1" fill="#4860a8"/><rect x="27" y="23" width="3" height="1" fill="#ffffff"/><rect x="30" y="23" width="3" height="1" fill="#4860a8"/><rect x="33" y="23" width="1" height="1" fill="#22305e"/><rect x="8" y="24" width="1" height="1" fill="#22305e"/><rect x="9" y="24" width="1" height="1" fill="#4860a8"/><rect x="10" y="24" width="1" height="1" fill="#ffffff"/><rect x="11" y="24" width="1" height="1" fill="#f0f0f0"/><rect x="12" y="24" width="1" height="1" fill="#ffffff"/><rect x="13" y="24" width="4" height="1" fill="#4860a8"/><rect x="17" y="24" width="1" height="1" fill="#22305e"/><rect x="18" y="24" width="4" height="1" fill="#ffffff"/><rect x="22" y="24" width="1" height="1" fill="#22305e"/><rect x="23" y="24" width="4" height="1" fill="#4860a8"/><rect x="27" y="24" width="1" height="1" fill="#ffffff"/><rect x="28" y="24" width="1" height="1" fill="#f0f0f0"/><rect x="29" y="24" width="1" height="1" fill="#ffffff"/><rect x="30" y="24" width="3" height="1" fill="#4860a8"/><rect x="33" y="24" width="1" height="1" fill="#22305e"/><rect x="8" y="25" width="1" height="1" fill="#22305e"/><rect x="9" y="25" width="1" height="1" fill="#4860a8"/><rect x="10" y="25" width="3" height="1" fill="#ffffff"/><rect x="13" y="25" width="4" height="1" fill="#4860a8"/><rect x="17" y="25" width="1" height="1" fill="#ffffff"/><rect x="18" y="25" width="1" height="1" fill="#22305e"/><rect x="19" y="25" width="2" height="1" fill="#ffffff"/><rect x="21" y="25" width="1" height="1" fill="#22305e"/><rect x="22" y="25" width="1" height="1" fill="#ffffff"/><rect x="23" y="25" width="4" height="1" fill="#4860a8"/><rect x="27" y="25" width="3" height="1" fill="#ffffff"/><rect x="30" y="25" width="3" height="1" fill="#4860a8"/><rect x="33" y="25" width="1" height="1" fill="#22305e"/><rect x="8" y="26" width="1" height="1" fill="#22305e"/><rect x="9" y="26" width="1" height="1" fill="#4860a8"/><rect x="10" y="26" width="1" height="1" fill="#22305e"/><rect x="11" y="26" width="2" height="1" fill="#ffffff"/><rect x="13" y="26" width="4" height="1" fill="#4860a8"/><rect x="17" y="26" width="1" height="1" fill="#ffffff"/><rect x="18" y="26" width="1" height="1" fill="#f0f0f0"/><rect x="19" y="26" width="2" height="1" fill="#22305e"/><rect x="21" y="26" width="1" height="1" fill="#f0f0f0"/><rect x="22" y="26" width="1" height="1" fill="#ffffff"/><rect x="23" y="26" width="4" height="1" fill="#4860a8"/><rect x="27" y="26" width="2" height="1" fill="#ffffff"/><rect x="29" y="26" width="1" height="1" fill="#22305e"/><rect x="30" y="26" width="3" height="1" fill="#4860a8"/><rect x="33" y="26" width="1" height="1" fill="#22305e"/><rect x="8" y="27" width="1" height="1" fill="#22305e"/><rect x="9" y="27" width="3" height="1" fill="#4860a8"/><rect x="13" y="27" width="1" height="1" fill="#22305e"/><rect x="14" y="27" width="3" height="1" fill="#4860a8"/><rect x="17" y="27" width="6" height="1" fill="#ffffff"/><rect x="23" y="27" width="3" height="1" fill="#4860a8"/><rect x="26" y="27" width="1" height="1" fill="#22305e"/><rect x="30" y="27" width="3" height="1" fill="#4860a8"/><rect x="33" y="27" width="1" height="1" fill="#22305e"/><rect x="8" y="28" width="1" height="1" fill="#22305e"/><rect x="9" y="28" width="3" height="1" fill="#4860a8"/><rect x="13" y="28" width="1" height="1" fill="#22305e"/><rect x="14" y="28" width="3" height="1" fill="#4860a8"/><rect x="17" y="28" width="6" height="1" fill="#ffffff"/><rect x="23" y="28" width="3" height="1" fill="#4860a8"/><rect x="26" y="28" width="1" height="1" fill="#22305e"/><rect x="30" y="28" width="3" height="1" fill="#4860a8"/><rect x="33" y="28" width="1" height="1" fill="#22305e"/><rect x="8" y="29" width="1" height="1" fill="#22305e"/><rect x="9" y="29" width="3" height="1" fill="#4860a8"/><rect x="13" y="29" width="1" height="1" fill="#22305e"/><rect x="14" y="29" width="3" height="1" fill="#4860a8"/><rect x="17" y="29" width="6" height="1" fill="#ffffff"/><rect x="23" y="29" width="3" height="1" fill="#4860a8"/><rect x="26" y="29" width="1" height="1" fill="#22305e"/><rect x="30" y="29" width="3" height="1" fill="#4860a8"/><rect x="33" y="29" width="1" height="1" fill="#22305e"/><rect x="9" y="30" width="3" height="1" fill="#6a80c0"/><rect x="13" y="30" width="1" height="1" fill="#22305e"/><rect x="14" y="30" width="3" height="1" fill="#4860a8"/><rect x="17" y="30" width="6" height="1" fill="#ffffff"/><rect x="23" y="30" width="3" height="1" fill="#4860a8"/><rect x="26" y="30" width="1" height="1" fill="#22305e"/><rect x="30" y="30" width="3" height="1" fill="#6a80c0"/><rect x="12" y="31" width="7" height="1" fill="#22305e"/><rect x="19" y="31" width="2" height="1" fill="#e8a0b0"/><rect x="21" y="31" width="7" height="1" fill="#22305e"/><rect x="11" y="32" width="1" height="1" fill="#22305e"/><rect x="12" y="32" width="16" height="1" fill="#4860a8"/><rect x="28" y="32" width="1" height="1" fill="#22305e"/><rect x="2" y="33" width="1" height="1" fill="#22305e"/><rect x="3" y="33" width="1" height="1" fill="#6a80c0"/><rect x="9" y="33" width="1" height="1" fill="#22305e"/><rect x="10" y="33" width="20" height="1" fill="#4860a8"/><rect x="30" y="33" width="1" height="1" fill="#22305e"/><rect x="36" y="33" width="1" height="1" fill="#6a80c0"/><rect x="37" y="33" width="1" height="1" fill="#22305e"/><rect x="2" y="34" width="1" height="1" fill="#6a80c0"/><rect x="7" y="34" width="1" height="1" fill="#22305e"/><rect x="8" y="34" width="24" height="1" fill="#6a80c0"/><rect x="32" y="34" width="1" height="1" fill="#22305e"/><rect x="37" y="34" width="1" height="1" fill="#6a80c0"/><rect x="6" y="35" width="1" height="1" fill="#22305e"/><rect x="7" y="35" width="1" height="1" fill="#ffffff"/><rect x="8" y="35" width="1" height="1" fill="#6a80c0"/><rect x="9" y="35" width="1" height="1" fill="#ffffff"/><rect x="10" y="35" width="1" height="1" fill="#6a80c0"/><rect x="11" y="35" width="1" height="1" fill="#ffffff"/><rect x="12" y="35" width="1" height="1" fill="#6a80c0"/><rect x="13" y="35" width="1" height="1" fill="#ffffff"/><rect x="14" y="35" width="1" height="1" fill="#6a80c0"/><rect x="15" y="35" width="1" height="1" fill="#ffffff"/><rect x="16" y="35" width="1" height="1" fill="#6a80c0"/><rect x="17" y="35" width="1" height="1" fill="#ffffff"/><rect x="18" y="35" width="1" height="1" fill="#6a80c0"/><rect x="19" y="35" width="1" height="1" fill="#ffffff"/><rect x="20" y="35" width="1" height="1" fill="#6a80c0"/><rect x="21" y="35" width="1" height="1" fill="#ffffff"/><rect x="22" y="35" width="1" height="1" fill="#6a80c0"/><rect x="23" y="35" width="1" height="1" fill="#ffffff"/><rect x="24" y="35" width="1" height="1" fill="#6a80c0"/><rect x="25" y="35" width="1" height="1" fill="#ffffff"/><rect x="26" y="35" width="1" height="1" fill="#6a80c0"/><rect x="27" y="35" width="1" height="1" fill="#ffffff"/><rect x="28" y="35" width="1" height="1" fill="#6a80c0"/><rect x="29" y="35" width="1" height="1" fill="#ffffff"/><rect x="30" y="35" width="1" height="1" fill="#6a80c0"/><rect x="31" y="35" width="1" height="1" fill="#ffffff"/><rect x="32" y="35" width="1" height="1" fill="#6a80c0"/><rect x="33" y="35" width="1" height="1" fill="#22305e"/><rect x="6" y="36" width="28" height="1" fill="#22305e"/><rect x="16" y="37" width="4" height="1" fill="#f0d8d8"/><rect x="21" y="37" width="4" height="1" fill="#f0d8d8"/><rect x="15" y="38" width="12" height="1" fill="#22305e"/><rect x="15" y="39" width="12" height="1" fill="#1c2440"/>'

function pixelMaidSvg(mood: WhaleMood): string {
  // 情绪只在整体色温上叠加一层，轮廓与表情不动。
  const tint =
    mood === 'sleep'
      ? '<rect width="40" height="40" fill="#22305e" opacity="0.3"/>'
      : mood === 'tired'
        ? '<rect width="40" height="40" fill="#8A4A2A" opacity="0.14"/>'
        : mood === 'busy'
          ? '<rect width="40" height="40" fill="#B07A28" opacity="0.08"/>'
          : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40" role="img" shape-rendering="crispEdges">` +
    PIXEL_MAID +
    tint +
    // 工作时头顶冒两滴汗
    (mood === 'working'
      ? `<rect x="30" y="8" width="1" height="2" fill="#9fb0d8"/><rect x="32" y="11" width="1" height="1" fill="#9fb0d8"/>`
      : '') +
    `</svg>`
  )
}

/**
 * 常驻条专用：只有像素女仆，没有气泡（那一行太矮，放不下气泡）。
 *
 * @param mood 情绪，只在整体色温与几滴汗上体现
 */
export function whaleBandSvg(mood: WhaleMood): string {
  return pixelMaidSvg(mood)
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 320" width="620" height="320" role="img">` +
    bubbleSvg(lines, mood) +
    // 鲸鱼：原图右下角贴边，尺寸 300×300
    `<g transform="translate(318 16)">` +
    float +
    `<image x="0" y="0" width="300" height="300" preserveAspectRatio="xMaxYMax meet" href="data:image/png;base64,${asset}"/>` +
    `</g>` +
    `</svg>`
  )
}
