/**
 * `pricing-data.mjs` 的类型声明。
 *
 * 那个文件写成 `.mjs` 是因为 `scripts/usage-scan.mjs` 由 `node` 直接执行、
 * 没有编译步骤，import 不了 TypeScript。这里手写它的类型，让 `tsc` 能检查
 * 调用方。
 */

export type ModelPrice = {
  /** 输入价（美元 / 每百万 token）。 */
  input: number
  /** 输出价。 */
  output: number
  /** 缓存写入价；第三方模型为 0。 */
  cacheWrite: number
  /** 缓存读取价。 */
  cacheRead: number
}

/** `[模型前缀, 输入价, 输出价]`；缓存价按官方 1.25x / 0.1x 换算。 */
export const ANTHROPIC_PRICES: ReadonlyArray<
  readonly [prefix: string, input: number, output: number]
>

/** `[匹配规则, 价格]`；第三方模型的缓存价逐家给，不套 Anthropic 换算。 */
export const THIRD_PARTY_PRICES: ReadonlyArray<readonly [test: RegExp, price: ModelPrice]>

/** 查一款模型的价格；未收录返回 `undefined`。 */
export function priceOf(model: string): ModelPrice | undefined
