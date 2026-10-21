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
  /** 该模型是否在价格表里；false 时 cost 恒为 0，界面显示「未收录价格」。 */
  isPriced: boolean
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cost: number
  messages: number
}

/** 扫描结果里的概览卡片（对应原生用量页的 Sessions / Messages / 等）。 */
export type LocalOverview = {
  /** 有消息的会话数。 */
  sessions: number
  /** 有消息的天数。 */
  activeDays: number
  /** 消息最多的小时，0–23；没有消息时为 null。 */
  peakHour: number | null
  peakHourMessages: number
  /** 消息最多的模型；`auto` 等占位标识会被跳过。 */
  favoriteModel: string | null
  favoriteModelMessages: number
  totalMessages: number
  totalTokens: number
}

/** 一天的轮次与消息数，给热图矩阵用。 */
export type TurnDay = {
  /** `YYYY-MM-DD`，本地时区。 */
  day: string
  /** 用户真正输入的次数（不含工具结果回填）。 */
  turns: number
  /** assistant 消息条数（按 message.id 去重）；同一轮里可能有多条。 */
  messages?: number
}

/**
 * 一轮的上下文构成。
 *
 * 借鉴 dsh-context 的做法：上下文不是一个百分比，而是若干类内容拼起来的窗口。
 * 每轮留一份分类占用，面板才能画出「这根柱子为什么变高」，而不只是「变高了」。
 */
export type ContextTurn = {
  /** 本轮的轮次序号（会话内递增）。 */
  seq: number
  /** 本轮结束时上下文窗口的占用百分比，0–100。 */
  percent: number
  /** 本轮消耗的 token（输入 + 缓存读写 + 输出），用于堆叠的高度。 */
  tokens: number
  /** 记录时间，毫秒。 */
  at: number
  /**
   * 本轮窗口里各分类的占用，按引擎 breakdown 的 `used` 行原样保留；
   * 老记录没有这个字段，读的时候按「无构成」处理。
   */
  parts?: ContextPart[]
  /** 本轮窗口的总 token（即 breakdown 的 `rawMaxTokens`），给构成换算百分比用。 */
  windowTokens?: number
  /**
   * 这一轮之前发生过一次压缩。
   *
   * 压缩是两轮之间的动作，落到图上就是「这根柱子前面竖一条虚线」：压缩后
   * 上下文会骤降，读者看到柱子突然变矮时，得能知道那是压缩造成的，而不是
   * 自己少用了。
   */
  afterCompact?: boolean
}

/** 上下文中一类内容的占用。 */
export type ContextPart = {
  /** 引擎给的行名（`System prompt`、`Messages`、`Memory files`…）。 */
  name: string
  tokens: number
  /**
   * 这一类的稳定标识，供界面配色与聚合。
   *
   * 引擎只给行名和主题色，而主题色在深色/浅色主题下含义不同、还可能随版本变；
   * 这里用行名归一化出一个稳定键，跨轮同色的前提就是它。
   */
  kind: ContextPartKind
}

/** 上下文分类的稳定键；未识别的一律 `other`。 */
export type ContextPartKind =
  | 'system'
  | 'tools'
  | 'memory'
  | 'mcp'
  | 'agents'
  | 'messages'
  | 'other'

/** 某一天里一个模型的用量。 */
export type ModelDayCell = {
  model: string
  /** 输入 token：新输入 + 缓存读 + 缓存写。 */
  input: number
  /** 输出 token。 */
  output: number
  /** 按价格表估算的美元；未收录价格时为 0。 */
  cost: number
}

/** 某一天的逐模型用量；只含有用量的模型。 */
export type ModelDay = {
  /** `YYYY-MM-DD`，本地时区。 */
  day: string
  models: ModelDayCell[]
}

/** `scripts/usage-scan.mjs` 一次输出的全部内容。 */
export type LocalUsage = {
  files: number
  overview: LocalOverview
  /** 逐日轮次；只含有轮次的日子。 */
  turnsDaily: TurnDay[]
  /** 逐日逐模型用量，给模型页的堆叠柱状图用。 */
  modelDaily: ModelDay[]
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

/** 轮次热图的读数口径：当天轮次或当天消息数。 */
export type HeatMetric = 'turns' | 'messages'

/** 用量条能显示的数字类别；可多选，按 `BAND_METRIC_OPTIONS` 的次序拼接。 */
export type BandMetric = 'window' | 'session' | 'cost' | 'context' | 'diff'

/** 界面偏好，持久化到 `$.store`。 */
export type Prefs = {
  /** 输入框上方的用量条是否显示。 */
  isBandVisible: boolean
  /**
   * 用量条里显示哪几类数字。
   *
   * 多选、按固定次序拼接：读者选择「额度窗口 + 代码改动」时，条子上会同时
   * 出现两者。空数组按「什么都不显示」处理，但界面不允许全取消——至少保留
   * 一项，否则那条用量条就成了一条空行。
   */
  bandMetrics: BandMetric[]
  /** 本地历史扫描统计最近多少天。 */
  historyDays: number
  /** 是否在每轮结束后弹出本轮消耗提示（默认关，避免每轮打断）。 */
  isTurnCostOn: boolean  /** 本地数据多久重新扫描一次；0 表示只在手动刷新时扫。 */
  scanIntervalMs: number
  /** 面板看哪一页：用量概览 / 模型分布 / 本会话上下文占比 / 设置。 */
  panelPage: 'overview' | 'models' | 'context' | 'settings'
  /** 轮次热图的色深口径：当天轮次，还是当天消息数。 */
  heatMetric: HeatMetric
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
      /** 最近若干轮的上下文占比，供面板画堆叠柱状图。 */
      contextTurns: ContextTurn[]
    }
  }
}
