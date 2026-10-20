/**
 * 小鲸鱼画面：用 SVG 重绘参考仓库里那只蓝色小鲸鱼的神韵（圆润身体、白肚皮、
 * 白色对话气泡），并按用量高低换表情。
 *
 * 为什么是矢量：桌面端绘制元素里没有位图 `Image`（那是终端 surface 的），
 * 只有 `Svg`。`Svg` 的 `isInteractive` 会放进无脚本沙箱，SMIL/CSS 悬停可用。
 */

/** 鲸鱼的状态：决定眼神、颜色与气泡里的提示。 */
export type WhaleMood = 'idle' | 'working' | 'busy' | 'tired' | 'sleep'

/** 用量百分比 → 情绪：越满越累，这是挂件的核心表达。 */
export function moodOf(percent: number | undefined, isWorking: boolean): WhaleMood {
  if (percent === undefined) return isWorking ? 'working' : 'idle'
  if (percent >= 95) return 'sleep'
  if (percent >= 80) return 'tired'
  if (percent >= 50) return 'busy'
  return isWorking ? 'working' : 'idle'
}

/** 没有图形元素时（终端 surface）用的文字鲸鱼：一眼能看出状态。 */
export function emblemOf(mood: WhaleMood): string {
  switch (mood) {
    case 'working':
      return '🐳'
    case 'busy':
      return '🐳'
    case 'tired':
      return '🐋'
    case 'sleep':
      return '💤'
    default:
      return '🐳'
  }
}

const BODY: Record<WhaleMood, { main: string; belly: string }> = {
  idle: { main: '#4A7BC8', belly: '#EAF2FF' },
  working: { main: '#3D6DB8', belly: '#E4EEFF' },
  busy: { main: '#C8923A', belly: '#FFF3DC' },
  tired: { main: '#B5653C', belly: '#FFE9DC' },
  sleep: { main: '#7A7F99', belly: '#EDEFF5' },
}

/** 眼睛：不同情绪下形状不同（睁眼 / 半闭 / 闭眼）。 */
function eye(cx: number, cy: number, mood: WhaleMood): string {
  if (mood === 'sleep') {
    return `<path d="M${cx - 9} ${cy} q9 7 18 0" fill="none" stroke="#203170" stroke-width="4.5" stroke-linecap="round"/>`
  }
  if (mood === 'tired') {
    return (
      `<path d="M${cx - 9} ${cy - 2} q9 -7 18 0" fill="none" stroke="#203170" stroke-width="4.5" stroke-linecap="round"/>` +
      `<circle cx="${cx}" cy="${cy + 3}" r="4.2" fill="#203170"/>`
    )
  }
  return (
    `<circle cx="${cx}" cy="${cy}" r="6.5" fill="#203170"/>` +
    `<circle cx="${cx + 2.4}" cy="${cy - 2.6}" r="2.1" fill="#FFFFFF"/>`
  )
}

/** 嘴巴：情绪越低越平。 */
function mouth(cx: number, cy: number, mood: WhaleMood): string {
  if (mood === 'sleep') {
    return `<path d="M${cx - 7} ${cy} q7 2 14 0" fill="none" stroke="#203170" stroke-width="3.4" stroke-linecap="round"/>`
  }
  if (mood === 'tired') {
    return `<path d="M${cx - 8} ${cy} q8 -1 16 0" fill="none" stroke="#203170" stroke-width="3.4" stroke-linecap="round"/>`
  }
  return `<path d="M${cx - 9} ${cy - 2} q9 9 18 0" fill="none" stroke="#203170" stroke-width="3.6" stroke-linecap="round"/>`
}

/**
 * 气泡：一个圆角大椭圆 + 尾巴 + 两颗小泡，沿用参考版的构图比例。
 * `text` 是气泡里最多三行的文字。
 */
function bubble(lines: readonly string[], mood: WhaleMood): string {
  const ink = '#203170'
  const isAlert = mood === 'tired' || mood === 'sleep'
  const fill = isAlert ? '#FFF6E8' : '#FFFFFF'

  const rows = lines
    .slice(0, 3)
    .map((line, index) => {
      const isAmount = index === 1
      const size = isAmount ? 46 : index === 0 ? 26 : 22
      const weight = isAmount ? 800 : 600
      const color = isAmount ? (isAlert ? '#B5653C' : '#2F4F8F') : index === 2 ? '#7C8CB0' : ink
      const y = 92 + index * 52 - (lines.length === 1 ? 0 : 0)
      const anchor = 'middle'
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return `<text x="236" y="${y}" text-anchor="${anchor}" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escaped}</text>`
    })
    .join('')

  return (
    `<g>` +
    // 尾巴：从气泡左下伸向鲸鱼
    `<path d="M150 196 q-26 26 -44 44" fill="none" stroke="${ink}" stroke-width="13" stroke-linecap="round"/>` +
    // 大椭圆主体
    `<ellipse cx="236" cy="112" rx="150" ry="92" fill="${fill}" stroke="${ink}" stroke-width="11"/>` +
    // 两颗小泡
    `<ellipse cx="150" cy="238" rx="17" ry="12" fill="${fill}" stroke="${ink}" stroke-width="7"/>` +
    `<ellipse cx="196" cy="270" rx="11" ry="8" fill="${fill}" stroke="${ink}" stroke-width="6"/>` +
    rows +
    `</g>`
  )
}

/**
 * 生成整幅 SVG：左边鲸鱼（带 SMIL 呼吸/摆尾），右边气泡。
 * 画布 620×320，放下后由外层控制尺寸。
 */
export function whaleSvg(
  mood: WhaleMood,
  lines: readonly string[],
  options: { isAnimating?: boolean } = {},
): string {
  const isAnimating = options.isAnimating ?? true
  const color = BODY[mood]
  const ink = '#203170'

  // 呼吸：整体轻微缩放；摆尾：尾鳍小角度摇摆。SMIL 在 SVG 里无需脚本。
  const breathe = isAnimating
    ? `<animateTransform attributeName="transform" type="translate" values="0 0; 0 -5; 0 0" dur="3.4s" repeatCount="indefinite" additive="sum"/>`
    : ''
  const tail = isAnimating
    ? `<animateTransform attributeName="transform" type="rotate" values="-6 92 236; 6 92 236; -6 92 236" dur="2.6s" repeatCount="indefinite"/>`
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 320" width="620" height="320" role="img">` +
    `<g transform="translate(-30 30)">` +
    bubble(lines, mood) +
    `</g>` +
    `<g transform="translate(20 40)">` +
    breathe +
    // 尾鳍
    `<g transform="translate(0 0)">${tail}` +
    `<path d="M104 224 q-46 -22 -62 6 q30 10 34 32 q20 -8 34 -18 Z" fill="${color.main}" stroke="${ink}" stroke-width="6" stroke-linejoin="round"/>` +
    `</g>` +
    // 身体
    `<path d="M112 236 q-14 -96 78 -122 q96 -28 146 30 q30 36 14 78 q-14 38 -66 44 q-96 12 -150 -14 q-18 -8 -22 -16 Z" fill="${color.main}" stroke="${ink}" stroke-width="7" stroke-linejoin="round"/>` +
    // 肚皮
    `<path d="M150 232 q46 26 128 8 q32 -6 44 -24 q-20 44 -78 50 q-76 8 -108 -20 q10 -10 14 -14 Z" fill="${color.belly}" stroke="none"/>` +
    // 胸鳍
    `<path d="M206 214 q-26 26 -2 40 q22 4 30 -22 Z" fill="${color.main}" stroke="${ink}" stroke-width="6" stroke-linejoin="round"/>` +
    // 喷水（工作时才有）
    (mood === 'working'
      ? `<path d="M262 104 q-12 -30 4 -44 M280 100 q6 -30 22 -38" fill="none" stroke="#8FB6EE" stroke-width="6" stroke-linecap="round" opacity="0.9"/>`
      : '') +
    eye(286, 172, mood) +
    mouth(304, 198, mood) +
    // 腮红
    (mood === 'busy' || mood === 'tired'
      ? `<ellipse cx="322" cy="192" rx="12" ry="7" fill="#F4A08A" opacity="0.55"/>`
      : '') +
    `</g>` +
    `</svg>`
  )
}
