/**
 * 数据来源标注：这个数字是读数，还是算出来的？
 *
 * 面板里的数字有三种可信度，混在一起看很容易误判：
 *
 *   1. **引擎读数** —— `$.session.usage()` 的额度百分比、上下文占用，
 *      以及日志里的 token 计数。这些是宿主或日志直接给的，不经过我们换算。
 *   2. **本地估算** —— 所有美元金额（按官方价格表乘出来）、上下文的分类构成
 *      （`summary` 粒度的启发式）。它们和账单不是一回事。
 *   3. **未收录** —— 第三方模型没有价格，token 照算，金额不给。
 *
 * 这里把这套分类集中定义一次，界面各处只取用，避免每个调用点各写一套说法
 * （改价格表口径时也只改这里）。参考 dsh-context 的做法：估算值与服务商
 * 报告的实际值并列展示，读者自己判断精度。
 */
import { usd } from './format.ts'

/**
 * 带来源标记的金额。
 *
 * 面板里**所有**美元数字都走这里：没有一笔来自账单，全是按官方价格表乘出来的。
 * 所以标记不是可选项——不标就等于把估算冒充成消费记录。`≈` 只在金额前加一次，
 * `$0` 与缺失值不加（那里没有「精度」可言）。
 */
export function usdEstimate(value: number | undefined | null): string {
  const money = usd(value)
  if (money === '—' || money === '$0') return money
  return `≈${money}`
}

/** 未收录价格的模型该怎么显示；与 `usdEstimate` 并列使用。 */
export const UNPRICED = '未收录价格'

/** 面板底部「数据来源」一节的几行说明。 */
export const PROVENANCE_NOTES: ReadonlyArray<{
  /** 这一行讲的是哪一类数字；同时用作 React key。 */
  topic: string
  /** 一句话说清来源与精度。 */
  text: string
}> = [
  {
    topic: '带 ≈ 的金额',
    text: '按官方价格表估算，不是账单；第三方模型不套官方价',
  },
  {
    topic: '上下文柱子',
    text: '柱高是引擎读数；柱内分类是本地估算（summary 粒度，不发请求）',
  },
  {
    topic: '上下文明细',
    text: '各行的 token 与占比是本地估算，与原生 /context 同口径',
  },
  {
    topic: '本地历史',
    text: '只覆盖这台机器的日志，不含其他设备或 claude.ai 网页端',
  },
]

/**
 * 这一屏该显示哪几条来源说明。
 *
 * 每条只在对应的数字真的出现时才解释——解释一个没出现的数字只会制造噪音。
 * 柱状图与上下文明细是两个独立的数据源，分别判断。
 *
 * @param hasLocal    本地扫描是否已有结果（概览页有数字可看）
 * @param hasTurns    是否有逐轮上下文记录（画得出柱状图）
 * @param hasBreakdown 是否画得出 /context 明细
 */
export function provenanceNotesFor(
  hasLocal: boolean,
  hasTurns: boolean,
  hasBreakdown: boolean,
): ReadonlyArray<{ topic: string; text: string }> {
  return PROVENANCE_NOTES.filter(note => {
    if (note.topic === '本地历史') return hasLocal
    if (note.topic === '上下文柱子') return hasTurns
    if (note.topic === '上下文明细') return hasBreakdown
    return true
  })
}
