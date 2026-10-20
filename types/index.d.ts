/**
 * 本插件在会话状态里保存的值（`$.state`），声明在 `PluginState` 上，
 * `claude plugin validate` 会核对模块里用到的每个键都在这里有定义。
 */

/** 本地日志聚合的逐日汇总（只含数字，不含任何路径或文本）。 */
export type LocalDay = {
  /** `YYYY-MM-DD`，本地时区。 */
  day: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** 按官方模型价格估算的美元；未收录的模型不计入。 */
  cost: number
  messages: number
}

/** 本地日志聚合的逐模型汇总。 */
export type LocalModel = {
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cost: number
  messages: number
}

/** `scripts/usage-scan.mjs` 一次输出的全部内容。 */
export type LocalUsage = {
  files: number
  windowDays: number
  today: LocalDay
  total: Omit<LocalDay, 'day'>
  daily: LocalDay[]
  byModel: LocalModel[]
  skippedDuplicates: number
}

/** 本地扫描的运行时记录：结果、错误、最近一次扫描时间。 */
export type ScanRecord = {
  isRunning: boolean
  lastRunAt: number | null
  lastError: string | null
  data: LocalUsage | null
}

/** 界面偏好，持久化到 `$.store`。 */
export type Prefs = {
  /** 下方常驻条是否显示。 */
  isBandVisible: boolean
  /** 常驻条里显示哪一类数字。 */
  bandMetric: 'window' | 'session' | 'cost' | 'context'
  /** 本地历史扫描统计最近多少天。 */
  historyDays: number
  /** 是否在每轮结束后弹出本轮消耗提示。 */
  isTurnCostOn: boolean
}

/** 一轮对话的消耗（turn.complete 时记下，供提示用）。 */
export type TurnSpend = {
  /** 递增序号，前端据此判断是不是新的一轮。 */
  seq: number
  turnId: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 按官方价格估算的美元；模型未收录时为 null。 */
  cost: number | null
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'claude-whale': {
      prefs: Prefs
      scan: ScanRecord
      lastTurn: TurnSpend | null
    }
  }
}
