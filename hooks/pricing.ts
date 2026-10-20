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
 * 按模型 id 前缀匹配，长的排前面（claude-opus-5-5 先于 claude-opus-5）。
 * 只收录第一方官方模型；第三方中转模型不在此表，按「未计价」处理并在界面标注。
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

/** 返回模型价格；未收录（含第三方模型、`<synthetic>`、`auto`）返回 undefined。 */
export function priceOf(model: string): ModelPrice | undefined {
  const id = model.toLowerCase()
  for (const [prefix, p] of TABLE) {
    if (id.startsWith(prefix)) return p
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
