/**
 * 模型价格数据：**唯一的一份**。
 *
 * 为什么单独抽出来：这张表要同时给两边用——`hooks/pricing.ts`（TypeScript
 * 模块，算会话花费）与 `scripts/usage-scan.mjs`（独立的 node 进程，算本地
 * 历史）。早先是两份手工副本，README 里写着「两处保持一致」，但**没有任何
 * 测试比对**。调价时只改一边，概览页与面板就会各用一套价目表——正是这个
 * 插件花大段注释解释、并专门实现 `isEnginePriced` 想避免的那种矛盾。
 *
 * 写成 `.mjs` 而不是 `.ts`：`usage-scan.mjs` 是 `node` 直接执行的，没有
 * 编译步骤，import 不了 TypeScript。`.mjs` 两边都能读——`tsc` 认它，
 * node 也认它。
 *
 * 价格随时可能调整，这里只做展示用的估算，不是账单。
 */

/**
 * Anthropic 第一方模型的价格，单位美元 / 每百万 token。
 *
 * 缓存按官方口径换算：写入 1.25 倍输入价，读取 0.1 倍输入价。
 * 按前缀匹配，长的排前面（`claude-opus-5-5` 先于 `claude-opus-5`）。
 */
export const ANTHROPIC_PRICES = [
  ['claude-fable-5-1', 10, 50],
  ['claude-mythos-5-1', 10, 50],
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-4-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  ['claude-haiku-3-5', 0.8, 4],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-opus', 15, 75],
  ['claude-3-haiku', 0.25, 1.25],
]

/**
 * 第三方模型的独立定价规则，顺序即匹配优先级。
 *
 * 这一族模型的缓存折扣比例与 Anthropic 完全不同（DeepSeek 2%、Qwen 45%、
 * Kimi 88%），所以不能套 1.25x / 0.1x 换算，必须逐家给数字。它们也都不
 * 单独收缓存写入费（`cacheWrite: 0`）。
 *
 * - **DeepSeek Flash**：官方非高峰价（高峰翻倍，所以算出来是下限）。型号写法
 *   在网关里不统一（`deepseek-flash` / `DeepSeek-V4.1-Flash-1017` /
 *   `deepseek-v4-flash`），用「含 deepseek 且含 flash」识别。
 * - **Qwen3.8 27B**、**Kimi K3**：OpenRouter 的基础价。本机日志里这两个名字
 *   就是走第三方网关调用的，用它的基础价最接近。
 */
export const THIRD_PARTY_PRICES = [
  [/deepseek.*flash|flash.*deepseek/i, { input: 0.15, output: 0.6, cacheWrite: 0, cacheRead: 0.003 }],
  [/qwen3\.8-27b|qwen-3\.8-27b/, { input: 0.04, output: 1.35, cacheWrite: 0, cacheRead: 0.018 }],
  [/kimi[-_ ]?k3\b|moonshot.*k3/, { input: 0.239, output: 11.936, cacheWrite: 0, cacheRead: 0.21 }],
]

/**
 * 查一款模型的价格；未收录（含 `<synthetic>`、`auto`）返回 `undefined`。
 *
 * 官方模型按前缀匹配，第三方按正则包含匹配（网关会加 `deepseek-ai/` 之类
 * 的命名空间，没有统一前缀）。大小写不敏感。
 */
export function priceOf(model) {
  const id = String(model).toLowerCase()
  for (const [prefix, input, output] of ANTHROPIC_PRICES) {
    if (id.startsWith(prefix)) {
      return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 }
    }
  }
  for (const [test, p] of THIRD_PARTY_PRICES) {
    if (test.test(id)) return p
  }
  return undefined
}
