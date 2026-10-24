/**
 * 官方 Claude 模型价格表（美元 / 每百万 token），用于把本地日志里的 token
 * 换算成估算金额。
 *
 * 口径来自 Anthropic 官方定价：input / output，缓存写入按 1.25 倍输入价，
 * 缓存读取按 0.1 倍输入价。价格随时可能调整，这里只做展示用的估算，不是账单。
 *
 * **价格数据本身在 `pricing-data.mjs` 里**，与 `scripts/usage-scan.mjs`
 * 共用同一份。早先两边各写一份手工副本，README 要求保持一致却没有测试
 * 比对——调价时漏改一边，概览页与面板就会各用一套价目表。
 */
import { priceOf as lookupPrice } from './pricing-data.mjs'

export type ModelPrice = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** 返回模型价格；未收录（含 `<synthetic>`、`auto`）返回 undefined。 */
export function priceOf(model: string): ModelPrice | undefined {
  return lookupPrice(model)
}

/**
 * 引擎（`/cost`）认识这款模型吗。
 *
 * 只认 Anthropic 第一方的 id（`claude-` 开头）。引擎的价目表里没有第三方
 * 模型；遇到不认识的名字时它不会留空，而是**按默认模型的价格**估——
 * 引擎源码里这个字段的原话是 "costUSD is a guess at the default model's
 * rate"，原生 `/cost` 因此会打一行
 * "costs may be inaccurate due to usage of unknown models"。
 *
 * 后果可以差到几十倍：同一批 token（本机实测 396 万输入 / 140 万输出 /
 * 5.38 亿缓存读），DeepSeek Flash 按官方价是 $3.05，引擎按默认模型估成
 * $258.98。面板上的「本会话花费」因此可能高于「用量概览」里跨 30 天的
 * 总额——两个数字口径不同，并排放着却不说明就成了自相矛盾。
 *
 * 注意它与 `priceOf` 是**两个不同的问题**：插件自己给 DeepSeek 收录了价格
 * （`priceOf` 有值），但引擎不认它。判「引擎金额可不可信」要看这个，
 * 不是看 `priceOf`。
 */
export function isEnginePriced(model: string): boolean {
  return model.toLowerCase().startsWith('claude-')
}

export type TokenCounts = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** 按一个模型的价格把 token 换算成美元；未收录的模型返回 undefined。 */
export function costOf(model: string, t: TokenCounts): number | undefined {
  const p = priceOf(model)
  if (!p) return undefined
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite * p.cacheWrite +
      t.cacheRead * p.cacheRead) /
    1_000_000
  )
}
