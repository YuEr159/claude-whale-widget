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
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** `YYYY-MM-DD` → `MM-DD`。 */
export function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day
}
