# Claude 用量小鲸鱼挂件

Claude Code 桌面端的小鲸鱼挂件：**输入框上方一条用量摘要 + 一个面板入口**，
点开**侧边面板**看完整数据。数据全部来自本机、全部只读，不需要 API key，不上传任何东西。

这是 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
的 Claude 版重做——原版挂在 DSH Web 界面右下角、显示 DeepSeek 余额；Claude 没有
「用 API key 查余额」的接口，所以这一版换成了 Claude 真正能读到的四类数据。

```
                                        5h 23% · 2h13m 后重置  +128 -34  [面板]
```

用量条靠右，只有摘要文字与「面板」按钮，**不带任何形象**，不占额外列宽。
小鲸鱼立绘只出现在面板右下角（原版素材内嵌，按用量变表情）。

末尾的 `+128 -34` 是本会话的代码改动行数：`+` 用主题的 `diffAdded` 色、`-` 用
`diffRemoved` 色，一眼分得清。**它随 Edit / Write 实时更新**——用量条在渲染时读了
`totals`，而宿主在 `$.state.set` 时会重绘读过该值的绘制点，所以不必等定时刷新。
还没有改动时这一段整个不画，不会留一个 `+0 -0`。面板的「用量条显示」里也可以
把它设成唯一口径。

## 显示什么

面板分「简洁」和「详细」两档，默认详细——详细视图把 Claude 原生 `/usage`
与 `/context` 两块面的字段都搬了过来。

| 数据 | 来源 | 说明 |
|---|---|---|
| **额度窗口 5h / 7d** | `$.session.usage()` | 订阅账号的 5 小时 / 7 天窗口百分比与重置倒计时 |
| **全部额度窗口** | `$.session.usage().rateLimits` | 详细视图按原生标题逐条列：Current session、Current week (all models)、Current week (Sonnet only)，网关窗口原样列出，每条配一条方块进度条 |
| **会话花费** | `$.session.usage().cost` | 本会话累计美元数（`/cost` 口径） |
| **会话时长 / 轮次 / 代码增删** | `turn.complete`、`tool.call` | 墙钟时长按轮累加；Edit / Write 只数 diff 的增删行，不保留行内容 |
| **按模型用量** | `turn.complete` | 每个模型的 token、估算金额、轮次，按花费降序 |
| **上下文占用** | `$.session.usage().context` | 上下文窗口已用百分比与 token 数 |
| **上下文窗口与加载项** | `$.session.usage({ breakdown })` | 窗口上限与来源（模型自身上限 / 设置 / 环境变量）、自动压缩阈值，以及记忆文件、MCP 工具、自定义 agent、技能与斜杠命令的数量。逐项 token 清单与 10×10 网格**不在面板里重复**——柱状图已按同一批类别着色 |
| **每轮消耗** | `turn.complete` 事件 | 每轮结束后的真实 token，按官方价格估算；默认不弹提示，可在面板打开 |
| **本地历史用量** | `~/.claude/projects/*.jsonl` | 今日 / 最近 N 天的 token 与估算金额，跨会话汇总 |
| **概览页** | 本地扫描的 `overview` | 会话数、消息数、总 token、活跃天数、峰值时段、常用模型六张卡，外加按天排列的轮次柱状图 |
| **模型页** | 本地扫描的 `byModel` | 逐模型的 token 条形图与消息数；第三方模型没有价格时标「未收录价格」，不会被藏起来 |
| **上下文占比柱状图** | `$.session.usage({ breakdown: 'summary' })` 逐轮记录 | 每轮一根堆叠柱，柱高固定为窗口 100%；柱内先按内容分类（系统提示 / 工具定义 / 记忆文件 / MCP 工具 / 自定义 agent / 对话消息）堆叠，再叠压缩缓冲与空闲。两种读法并列：柱内已用段有多高＝占比，已用段内哪一类最厚＝窗口被什么占着 |

两张图都支持往左翻页看更早的窗口（面板只有纵向滚动，没有横向滚动条，
所以用一对 ◀ / ▶ 按钮代替拖动）；只有一页时按钮不出现。图例按当前这一屏
实际出现过的分类生成，翻页时颜色与类别的对应不会变。

面板里的小鲸鱼会随用量变表情：正常 → 忙碌 → 疲惫 → 睡着（额度接近上限）。工作时会喷水。

### 详细视图与原生面板的差异

两项原生面板有、这里没有的，如实说明，不拿别的数字硬凑：

- **Total duration (API)**：引擎只提供每轮的墙钟时长（`turn.complete` 的 `durationMs`），
  没有单独的 API 耗时，所以这里显示的是墙钟时长。
- **子代理的消耗**：子代理的轮次在它自己的循环里结束，主线程不汇总；这里的
  「按模型」只统计主线程。

`/context` 的明细用 `summary` 粒度：全部本地估算，不发 token 计数请求，所以面板
每次重绘都不会打 API。需要 `full` 的精确计数时用原生 `/context`。

柱子的**高度**（窗口占用百分比）来自引擎的真实读数，而**柱内各分类的份额**是
`summary` 粒度的本地估算，两者不要当成同一精度看。

### 哪些数字是读数，哪些是估算

面板底部有一节「数据来源」，把这条界线写在界面上而不是只写在文档里：

| 类别 | 精度 | 说明 |
|---|---|---|
| 额度窗口百分比、上下文占用百分比、token 计数 | 引擎读数 | 宿主或日志直接给，不经过本插件换算 |
| **所有美元金额**（面板、用量条、提示气泡） | **估算**，前面带 `≈` | 按官方价格表乘出来，不是账单 |
| 柱内各分类的份额 | 估算 | `summary` 粒度的本地启发式，不发请求 |
| 本地历史 | 本机范围 | 只覆盖这台机器的日志 |

没有一笔金额来自账单，所以 `≈` 不是可关的装饰：关掉它，界面就会把估算冒充成
消费记录。想做账请以 Anthropic 控制台为准。

脚注只在**详细视图**出现，并且逐条按需：没有逐轮记录就不提柱子，没有本地
扫描结果就不提本地历史——不解释一个没出现的数字。

概览页的数字来自本地日志扫描，不是账号级别的统计：它只覆盖这台机器上的会话，
不含其他设备或 claude.ai 网页端。这和原生用量页的口径一致（原生页也标注了这一点）。

「轮次历史」用柱高表示每天的用户输入次数，读法参照 GitHub 的贡献图：横轴是连续
的日子，缺数据的天补 0 并保留一格底，保证时间轴不断档。与贡献图不同的是这里用
高度而不是色深，起伏更容易看出来。

### 关于第三方模型的金额

价格表只收录 Anthropic 第一方模型。DeepSeek、Qwen、GLM 等第三方模型的 token
照常统计、照常出现在模型页，但金额显示「未收录价格」——拿官方价去套别家的模型
会给出错误数字。要收录某个第三方模型，需要把它的官方定价加进 `hooks/pricing.ts`
与 `scripts/usage-scan.mjs` 的 `PRICES`（两处保持一致）。

## 安装

本插件是 Claude Code 的 **mod**（function hooks 插件），需要 Claude Code **2.1.275 或更新版本**。

三条路，任选其一：

**1. 本会话热重载（开发时最方便）**

把插件目录放进当前会话的 mods 目录，引擎会在本轮结束时加载，之后改文件自动重载：

```bash
cp -r . "$HOME/.claude/dev-mods/<会话 id>/whale-usage"
```

**2. 指定目录启动**

```bash
claude --plugin-dir "/path/to/whale-usage"
```

**3. 从插件市场一条命令安装（长期启用）**

本仓库自带 `.claude-plugin/marketplace.json`，直接装即可：

```
/plugin install whale-usage --marketplace YuEr159/claude-whale-widget
```

也可以把目录写进环境变量 `CLAUDE_CODE_PLUGIN_DIRS`。

装好后：

- 输入 `/whale` 打开侧边面板；
- 输入 `/whale-band` 显示 / 隐藏输入框上方的用量条；
- 面板里可以切换详细 / 简洁、用量条口径、统计范围，开关轮次提示与用量条。

## 怎么测

开发时用桌面端自带的引擎跑测试最准——它比 npm 版的 `claude` 新，规则也更严：

```bash
# Windows 上桌面端引擎的位置
ENGINE="$LOCALAPPDATA/Claude-3p/claude-code/<版本>/<哈希>/claude.exe"

"$ENGINE" plugin validate .   # 契约校验：名字、state 归属、调用了哪些接口
"$ENGINE" plugin test .       # 单元 + 渲染测试
npx --package typescript@5.6 tsc -p .   # 类型检查
node --test tests/node.run.mjs          # 不依赖 CLI 的等价测试
```

## 数据取不到时

| 情况 | 表现 |
|---|---|
| 没有订阅额度窗口（API key 计费、第三方网关） | 额度显示「无额度窗口」，用量条自动退回「上下文 + 会话花费」 |
| 用的是第三方模型（DeepSeek、Qwen 等） | token 照常统计，金额显示「未收录价格」，不会拿官方价格硬套 |
| 本机没有 Node | 本地历史一栏报错，其余数据照常 |

## 素材来源

面板里的小鲸鱼原图来自 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT），
按显示尺寸重采样后内嵌进 SVG。完整署名与许可见 [NOTICE.md](NOTICE.md)。

## 隐私

**这一版不读日志正文，不上传任何数据。** 详见 [PRIVACY.md](PRIVACY.md)。

简而言之：本地扫描只提取 `timestamp`、`message.id`、`message.model`、`message.usage`
四个字段，回传给界面的只有数字和官方模型名；路径、会话内容、prompt、工具输出一概不读。

## 开发

```bash
# 类型检查（需要 TypeScript 5.4+）
npx --package typescript@5.6 tsc -p .

# 纯函数与 SVG 测试（不依赖 CLI 版本）
node --test tests/node.run.mjs

# 引擎侧的契约校验
claude plugin validate .
```

目录结构：

```
.claude-plugin/plugin.json   manifest（userConfig 的默认值）
.claude-plugin/marketplace.json  插件市场清单，供 /plugin install
hooks/hooks.json             入口声明
hooks/register.tsx           全部 hook：命令、渲染、轮次、定时扫描
hooks/usage-view.ts          纯计算：用量 → 界面文字
hooks/usage-detail.ts        纯计算：/usage 与 /context 明细 → 面板行
hooks/usage-overview.ts      纯计算：概览卡片、日历热力图、模型排行
hooks/whale-art.ts           小鲸鱼画面（内嵌原图 + 代码绘制的气泡）
hooks/whale-asset.ts         原图的两档 base64 资产
hooks/pricing.ts             官方模型价格表
hooks/format.ts              金额 / 百分比 / 倒计时格式化
scripts/usage-scan.mjs       本地日志聚合（由 node 执行）
types/index.d.ts             `$.state` 的值契约
tests/                       测试
```

## 致谢与借鉴

面板的「上下文构成」读法借鉴了 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)
（Apache-2.0）的设计理念：上下文不是一个百分比，而是一个由若干类内容拼起来的窗口，
逐轮记录它的构成，才看得出窗口为什么变满。本仓库没有复制它的任何代码——宿主 API
完全不同（那边是 cordis 会话投影，这边是 `$.state` + `$.session.usage`），
只借了「逐请求留构成、按类堆叠着色」这一条思路。

## 与 DeepSeek 原版的差异

| | DeepSeek 原版 | 本版 |
|---|---|---|
| 宿主 | DSH Web 界面 | Claude Code 桌面端 mod |
| 位置 | 右下角常驻、可拖拽 | 输入框上方一条用量摘要（无形象）+ 侧边面板（鲸鱼在右下角） |
| 主数据 | 余额（官方接口） | 额度窗口 / 会话花费 / 上下文 / 本地历史 |
| 画面 | 位图 cut-out + 代码绘制的 SVG 气泡 | 仅面板内嵌原图 + 代码绘制的气泡 |
| 取数 | 需要 API key 或平台登录态 | 本地 `$.session.usage()`，零凭据 |

原版有拖拽吸附、按压音效、自定义角色与台词。桌面端的绘制元素没有位图 `Image`，
也没有指针拖拽事件，这些在 Claude 版里用「用量条 + 侧边面板 + 表情」替代。

## 许可

MIT
