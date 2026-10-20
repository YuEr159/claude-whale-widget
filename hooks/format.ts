/** 展示用的格式化：数字、金额、百分比、重置倒计时。 */

/** 美元金额：按量级保留 2/3/4 位小数，至少两位（`$0.50` 而不是 `$0.5`）。 */
export function usd(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  // 至少两位；小数位不足四位而末尾是 0 的，去掉到两位为止。
  const trimTo = (text: string, floor: number) => {
    const dot = text.indexOf('.')
    if (dot < 0) return text
    let end = text.length
    while (end - dot - 1 > floor && text[end - 1] === '0') end -= 1
    return text.slice(0, end)
  }
  if (Math.abs(value) < 0.01) return `$${trimTo(value.toFixed(4), 2)}`
  if (Math.abs(value) < 1) return `$${trimTo(value.toFixed(3), 2)}`
  return `$${trimTo(value.toFixed(2), 2)}`
}

/** 人民币，用于本地估算的另一种展示（默认不用，保留给偏好）。 */
export function cny(value: number | undefined | null, rate = 7.1): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return `¥${(value * rate).toFixed(2)}`
}

/** 百分比：整数为主，小数只在需要时出现。 */
export function pct(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

/** token 数：万/亿 制，便于一眼读数。 */
export function tokens(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`
  return String(Math.round(value))
}

/**
 * 距离重置还有多久：`2h13m` / `45m` / `刚刚`。
 * 入参是 ISO 8601 字符串；解析不了就返回空串。
 */
export function countdown(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const ms = at - now
  if (ms <= 0) return '即将重置'
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${minutes}m`
}

/** 把一行文字压到 `max` 个显示宽度以内，超出用省略号。 */
export function clip(text: string, max: number): string {
  if (max <= 1) return ''
  if (displayWidth(text) <= max) return text
  // 按显示宽度截，不能按码点数：一个汉字占两格，按 length 截会留下半格。
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > max - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/** 单个字符占几列：CJK、全角标点与常见表情算两列，其余一列。 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // 组合附加符不占位
  if (code >= 0x0300 && code <= 0x036f) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  ) {
    return 2
  }
  return 1
}

/**
 * 一段文字在等宽终端里占几列。
 *
 * 表格对齐必须用它而不是 `String.length`：`DeepSeek Flash` 与 `GLM Flash`
 * 码点数不同、显示宽度也不同，用 `length` 补空格会让第二列歪掉。
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/**
 * 把一个单元格补到指定显示宽度。
 *
 * `align: 'right'` 是数字列用的——右对齐时个位对齐，大小一眼可比。
 */
export function padCell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, width - displayWidth(text))
  return align === 'right' ? `${' '.repeat(gap)}${text}` : `${text}${' '.repeat(gap)}`
}

/**
 * 代码改动行数：`+128 -34`。
 *
 * 两边都是 0 时返回空串——刚开的会话还没有任何 Edit / Write，
 * 画一个 `+0 -0` 只是噪音。只有一边有改动时另一边不显示，
 * `+5` 比 `+5 -0` 干净。
 */
export function diffLines(added: number, removed: number): string {
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`-${removed}`)
  return parts.join(' ')
}

/** `YYYY-MM-DD` → `MM-DD`。 */
export function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day
}
