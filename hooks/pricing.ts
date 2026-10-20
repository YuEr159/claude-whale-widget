/**
 * 官方 Claude 模型价格表（美元 / 每百万 token），用于把本地日志里的 token
 * 换算成估算金额。
 *
 * 口径来自 Anthropic 官方定价：input / output，缓存写入按 1.25 倍输入价，
 * 缓存读取按 0.1 倍输入价。价格随时可能调整，这里只做展示用的估算，不是账单。
 */
export type ModelPrice = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

function price(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cacheWrite: input * 1.25,
    cacheRead: input * 0.1,
  }
}

/**
 * 第三方模型的定价形状：缓存读价单独给，缓存写入不计费。
 *
 * 这一族模型的缓存折扣比例与 Anthropic 完全不同（DeepSeek 2%、Qwen 45%、
 * Kimi 88%），所以不能套 `price()` 的 1.25x / 0.1x 换算，必须逐家给数字。
 * 它们也都不单独收缓存写入费。
 *
 * @param input     输入价（美元 / 每百万 token）
 * @param output    输出价
 * @param cacheRead 缓存命中价
 */
function thirdPartyPrice(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: 0 }
}

/**
 * 按模型 id 匹配，长的排前面（claude-opus-5-5 先于 claude-opus-5）。
 *
 * 官方 Anthropic 模型用前缀匹配；DeepSeek 的型号名在网关里写法不统一
 * （`deepseek-flash`、`DeepSeek-Flash`、`deepseek-v4-flash`、`DeepSeek-V4.1-Flash-1017`
 * 都出现过），所以单独用「含 deepseek 且含 flash」的规则识别，大小写不敏感。
 */
const TABLE: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ['claude-fable-5-1', price(10, 50)],
  ['claude-mythos-5-1', price(10, 50)],
  ['claude-fable-5', price(10, 50)],
  ['claude-mythos-5', price(10, 50)],
  ['claude-opus-5-5', price(4, 20)],
  ['claude-opus-5', price(5, 25)],
  ['claude-opus-4-8', price(5, 25)],
  ['claude-opus-4-7', price(5, 25)],
  ['claude-opus-4-6', price(5, 25)],
  ['claude-opus-4-5', price(5, 25)],
  ['claude-opus-4-1', price(15, 75)],
  ['claude-opus-4', price(15, 75)],
  ['claude-sonnet-5-5', price(2, 10)],
  ['claude-sonnet-5', price(2, 10)],
  ['claude-sonnet-4-6', price(3, 15)],
  ['claude-sonnet-4-5', price(3, 15)],
  ['claude-sonnet-4', price(3, 15)],
  ['claude-haiku-5-5', price(0.1, 0.5)],
  ['claude-haiku-4-5', price(1, 5)],
  ['claude-haiku-3-5', price(0.8, 4)],
  ['claude-3-7-sonnet', price(3, 15)],
  ['claude-3-5-sonnet', price(3, 15)],
  ['claude-3-5-haiku', price(0.8, 4)],
  ['claude-3-opus', price(15, 75)],
  ['claude-3-haiku', price(0.25, 1.25)],
]

/** 带有独立定价规则的第三方模型；顺序即匹配优先级。 */
const THIRD_PARTY: ReadonlyArray<readonly [test: RegExp, price: ModelPrice]> = [
  // DeepSeek Flash（V4 Flash / V4.1 Flash）。官方价：输入 $0.15 / 输出 $0.60
  // 每百万 token（非高峰），缓存命中 $0.003。
  [/deepseek.*flash|flash.*deepseek/i, thirdPartyPrice(0.15, 0.6, 0.003)],
  // Qwen3.8 27B（OpenRouter 基础价）：输入 $0.04 / 输出 $1.35 / 缓存读 $0.018。
  // 注意缓存读是输入价的 45%，不是 Anthropic 的 10%，所以必须显式给。
  [/qwen3\.8-27b|qwen-3\.8-27b/, thirdPartyPrice(0.04, 1.35, 0.018)],
  // Kimi K3（OpenRouter 基础价）：输入 $0.239 / 输出 $11.936 / 缓存读 $0.21。
  // 缓存读是输入价的 88%——Kimi 的缓存只是省一点点，不是数量级的折扣。
  [/kimi[-_ ]?k3\b|moonshot.*k3/, thirdPartyPrice(0.239, 11.936, 0.21)],
]

/** 返回模型价格；未收录（含 `<synthetic>`、`auto`）返回 undefined。 */
export function priceOf(model: string): ModelPrice | undefined {
  const id = model.toLowerCase()
  for (const [prefix, p] of TABLE) {
    if (id.startsWith(prefix)) return p
  }
  // 第三方模型没有统一的前缀写法（网关会加 `deepseek-ai/` 之类的命名空间），
  // 所以用包含式规则，大小写不敏感。
  for (const [test, p] of THIRD_PARTY) {
    if (test.test(id)) return p
  }
  return undefined
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
