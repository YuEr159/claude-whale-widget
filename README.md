# Claude 用量小鲸鱼挂件

Claude Code 桌面端的小鲸鱼挂件：**prompt 上方常驻一条**，点开**侧边面板**看完整数据。
数据全部来自本机、全部只读，不需要 API key，不上传任何东西。

这是 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
的 Claude 版重做——原版挂在 DSH Web 界面右下角、显示 DeepSeek 余额；Claude 没有
「用 API key 查余额」的接口，所以这一版换成了 Claude 真正能读到的四类数据。

```
🐳 5h 23% · 2h13m 后重置                        [面板]
```

## 显示什么

| 数据 | 来源 | 说明 |
|---|---|---|
| **额度窗口 5h / 7d** | `$.session.usage()` | 订阅账号的 5 小时 / 7 天窗口百分比与重置倒计时 |
| **会话花费** | `$.session.usage().cost` | 本会话累计美元数（`/cost` 口径） |
| **每轮消耗** | `turn.complete` 事件 | 每轮结束后的真实 token，按官方价格估算并弹提示 |
| **上下文占用** | `$.session.usage().context` | 上下文窗口已用百分比与 token 数 |
| **本地历史用量** | `~/.claude/projects/*.jsonl` | 今日 / 最近 N 天的 token 与估算金额，跨会话汇总 |

小鲸鱼会随用量变表情：正常 → 忙碌 → 疲惫 → 睡着（额度接近上限）。工作中会喷水。

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

**3. 长期启用**

把目录写进环境变量 `CLAUDE_CODE_PLUGIN_DIRS`，或在插件市场配置里登记。

装好后：

- 输入 `/whale` 打开侧边面板；
- 输入 `/whale-band` 显示 / 隐藏上方常驻条；
- 面板里可以切换统计范围、开关轮次提示、显示 / 隐藏上方条。

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
| 没有订阅额度窗口（API key 计费、第三方网关） | 额度显示 `—`，常驻条自动退回「上下文 + 会话花费」 |
| 用的是第三方模型（DeepSeek、Qwen 等） | token 照常统计，金额显示「未收录模型」，不会拿官方价格硬套 |
| 本机没有 Node | 本地历史一栏报错，其余数据照常 |

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
hooks/hooks.json             入口声明
hooks/register.tsx           全部 hook：命令、渲染、轮次、定时扫描
hooks/usage-view.ts          纯计算：用量 → 界面文字
hooks/whale-art.ts           SVG 小鲸鱼与表情
hooks/pricing.ts             官方模型价格表
hooks/format.ts              金额 / 百分比 / 倒计时格式化
scripts/usage-scan.mjs       本地日志聚合（由 node 执行）
types/index.d.ts             `$.state` 的值契约
tests/                       测试
```

## 与 DeepSeek 原版的差异

| | DeepSeek 原版 | 本版 |
|---|---|---|
| 宿主 | DSH Web 界面 | Claude Code 桌面端 mod |
| 位置 | 右下角常驻、可拖拽 | prompt 上方常驻条 + 侧边面板 |
| 主数据 | 余额（官方接口） | 额度窗口 / 会话花费 / 上下文 / 本地历史 |
| 画面 | 位图 cut-out + 代码绘制的 SVG 气泡 | 纯 SVG 矢量重绘 |
| 取数 | 需要 API key 或平台登录态 | 本地 `$.session.usage()`，零凭据 |

原版有拖拽吸附、按压音效、自定义角色与台词。桌面端的绘制元素没有位图 `Image`，
也没有指针拖拽事件，这些在 Claude 版里用「常驻条 + 面板 + 表情」替代。

## 许可

MIT
