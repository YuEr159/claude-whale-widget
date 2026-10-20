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
  /** 输入框上方的用量条是否显示。 */
  isBandVisible: boolean
  /** 用量条里显示哪一类数字。 */
  bandMetric: 'window' | 'session' | 'cost' | 'context'
  /** 本地历史扫描统计最近多少天。 */
  historyDays: number
  /** 是否在每轮结束后弹出本轮消耗提示（默认关，避免每轮打断）。 */
  isTurnCostOn: boolean
  /** 本地数据多久重新扫描一次；0 表示只在手动刷新时扫。 */
  scanIntervalMs: number
  /** 面板显示详细视图还是只保留概览。 */
  panelDetail: 'simple' | 'detail'
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
  /** 本轮墙钟时长，毫秒。 */
  durationMs: number
  at: number
}

/** 会话累计，供面板「总量」一节用；全部是数字。 */
export type SessionTotals = {
  /** 主线程各轮墙钟时长之和，毫秒。 */
  wallMs: number
  /** 主线程的轮次数。 */
  turns: number
  /** Edit / Write 带来的新增行数。 */
  linesAdded: number
  /** Edit / Write 带来的删除行数。 */
  linesRemoved: number
}

/** 一个模型的累计用量，供面板「按模型」一节用。 */
export type ModelSpend = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 按官方价格估算的美元；模型未收录时为 null。 */
  cost: number | null
  turns: number
}

declare module 'claude-code' {
  interface PluginState {
    'whale-usage': {
      prefs: Prefs
      scan: ScanRecord
      lastTurn: TurnSpend | null
      totals: SessionTotals
      byModel: ModelSpend[]
    }
  }
}
