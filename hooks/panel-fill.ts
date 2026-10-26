/**
 * 面板跟着主题走的一组界面色。
 *
 * 引擎不直接告诉插件「现在是深色还是浅色」，但 `/config` 的 `theme` 行
 * （`$.config.list()` 里 `key === "theme"`）给出了用户选的那一档。它有
 * 三种形态，界面必须分别对待：
 *
 *   - `light` / `light-daltonized` / `light-ansi`：确定是浅色；
 *   - `dark` / `dark-daltonized` / `dark-ansi`：确定是深色；
 *   - **`auto`**：只说明「跟随系统或宿主外观」，究竟是深是浅，插件无从得知
 *     ——引擎在不同入口各自解析（终端看 OSC 11 或宿主上报的 `systemTheme`，
 *     桌面端看 `nativeTheme`），这份解析结果没有暴露给 `$`。
 *
 * `auto` 是默认值，也是绝大多数人的设置，所以不能当作「深色」硬编码——那正是
 * 「浅色模式下圆角块仍是深蓝黑」的根因。于是分两层处理：
 *
 *   1. **界面色（框的底、边、文字）一律写主题键**。引擎在绘制时才解析，
 *      跟哪种主题、是 auto 还是显式，都归它管，插件不必知道答案。
 *   2. **图表色是 SVG 里的十六进制**，引擎解析不了。`auto` 下只能用一套
 *      在深、浅两种底上都过 WCAG 图形元素口径（3.0）的中等明度色——
 *      见 `AUTO_CHART`。宁可两边都只到刚过线，也不赌一边、在另一边糊成一片。
 *
 * 显式给了深浅时仍各用一套（对比度余量更大）；`auto` 用中间那套。
 */

/** 一处圆角框的两种颜色。 */
export type PanelFill = {
  /** 框内底色。 */
  backgroundColor: string
  /** 边框色。 */
  borderColor: string
}

/**
 * 大框的底色与边框：**主题键**，不是十六进制。
 *
 * 引擎按当前主题解析。选上的键在深色里是 55,55,55、浅色里是 240,240,240，
 * 边框 `promptBorder` 是 136 / 138——对比度在两边都过 3.0。
 */
const SURFACE_FILL: PanelFill = {
  backgroundColor: 'userMessageBackground',
  borderColor: 'promptBorder',
}

/**
 * 页签「激活」时的底色：比所在大框再亮一档。
 *
 * 深色往亮走、浅色往白走——两者都是「更靠近前景」，也就是读者直觉里的
 * 「被选中、浮起来」。`userMessageBackgroundHover` 正好是这两个方向上的
 * 下一档（70 / 252），语义也贴切：悬停时的强调。
 */
const TAB_ACTIVE_FILL: PanelFill = {
  backgroundColor: 'userMessageBackgroundHover',
  borderColor: 'promptBorder',
}

/**
 * 页签被选中时**文字**的颜色。
 *
 * 直接取 `text`：它在激活底上是正文级的对比（深色 9.44、浅色 20.47），
 * 而且跟着主题走——这正是浅色界面里最要紧的一条，写死的浅色文字到了
 * 浅底上就看不见了。之前那对 `#dee4ff` / `#2b3657` 只在**已知**深浅时才是
 * 对的；`auto` 下它和框一样，会赌错一边。
 */
const TAB_ACTIVE_TEXT = 'text'

/**
 * 页内小块的底色：比所在大框**深**一档。
 *
 * 方向与页签的激活态相反，原因也相反：页签是「被选中所以往前浮」，而
 * 图表块是「嵌在页面里的一块内容」，往后退一格才读得出层次。两块都往亮走
 * 的话，页面会像一堆同样亮度的方块铺在一起，反而看不出分组。
 * 同样用主题键：深色 38,38,38 / 浅色 235,235,235。
 */
const INSET_FILL: PanelFill = {
  backgroundColor: 'composerSidebarBackground',
  borderColor: 'promptBorder',
}

/** 主题值是浅色的吗。`light`、`light-daltonized`、`light-ansi` 都算。 */
export function isLightTheme(themeValue: string | undefined): boolean {
  return (themeValue ?? '').toLowerCase().includes('light')
}

/**
 * 主题值是深色的吗。注意 `auto` **不是**深色——它是「不知道」，
 * 两者在图表配色上走不同的分支（见文件头）。
 */
export function isDarkTheme(themeValue: string | undefined): boolean {
  return (themeValue ?? '').toLowerCase().includes('dark')
}

/**
 * 图表的配色：`dark`、`light`，以及 `auto`（深浅未知）时用的中性一套。
 *
 * 键与 `chart-art.ts` 的 `COLORS` 一一对应。分类色沿用同一套色相
 * （青还是青、紫还是紫），只压明度——读者换主题后看到的是同一张图的
 * 同一种读法，不必重新认颜色。
 */
export type ChartPalette = {
  /**
   * 这套调色板对应哪种主题。
   *
   * `null` 表示深浅未知（`auto` 且读不到系统外观时）：此时色值取
   * 中等明度，深底浅底都过 3.0。
   */
  isLight: boolean | null
  /** 主色：核心蓝。 */
  used: string
  /** 压缩缓冲、空闲段：同一支蓝，靠透明度压下去。 */
  usedOpacity: number
  bufferOpacity: number
  freeOpacity: number
  /** 轴线与刻度。 */
  axis: string
  label: string
  /**
   * 压缩标记的强调色：暖色，与整套冷色形成对照。
   *
   * **现在没有绘制点用它。** 上下文图的压缩虚线改成了灰色（`axis`）——
   * 橙色在冷色柱子里太跳，读起来像又一个内容分类，而虚线只是个「这里发生过
   * 一件事」的标记，该退到背景里。字段留着是因为 `ChartPalette` 是公开类型，
   * 将来别处要用（比如在图注里给「N 次压缩」上色）直接取即可。
   */
  compact: string
  /** 图表的空柱兜底色。 */
  barEmpty: string
  barEmptyOpacity: number
  /** 六个内容分类的矢量色 + 兜底灰。 */
  parts: Readonly<Record<string, string>>
}

/**
 * 深色主题的图表色。
 *
 * 分类色明度偏高（亮蓝、亮紫、青绿），是为了在深底上跳出背景；
 * 每一支在 `#1a1a1a` 上都过 3.0——实测最低 3.49（messages），
 * 早先的 `agents`（`#1E6F8C`）只有 2.67，这次换掉了。
 */
const DARK_CHART: ChartPalette = {
  isLight: false,
  used: '#4D6BFE',
  usedOpacity: 1,
  // 半透明在这边够用：深色底上「更透明」= 更暗 = 更靠近背景，方向是对的。
  bufferOpacity: 0.45,
  freeOpacity: 0.12,
  axis: '#8b90a3',
  label: '#9aa0b4',
  compact: '#E0913C',
  barEmpty: '#8b90a3',
  barEmptyOpacity: 0.18,
  parts: {
    messages: '#4D6BFE',
    system: '#A78BFA',
    tools: '#22C3D6',
    memory: '#2DD4BF',
    mcp: '#F472B6',
    agents: '#FB923C',
    other: '#7C8394',
  },
}

/**
 * 浅色主题的图表色。
 *
 * 同一批色相，明度压低到在白底上读得出。逐支实测（白底对比度）：
 * messages 6.13、system 5.19、tools 5.35、memory 5.32、mcp 5.70、
 * agents 5.10、other 4.66。最低 4.66，全部过 4.5。
 *
 * 透明度这边反而要**调高**：浅底上「已用」是深蓝、缓冲是同色更浅的一档，
 * 靠的是让底色透上来把它冲淡，所以 60% 比深色主题那份更实一点才对。
 */
const LIGHT_CHART: ChartPalette = {
  isLight: true,
  used: '#3B54D6',
  usedOpacity: 1,
  bufferOpacity: 0.6,
  freeOpacity: 0.18,
  axis: '#8b90a3',
  label: '#5f6675',
  compact: '#B35A0E',
  barEmpty: '#8b90a3',
  barEmptyOpacity: 0.28,
  parts: {
    messages: '#3B54D6',
    system: '#7C3AED',
    tools: '#0E7490',
    memory: '#0F766E',
    mcp: '#BE185D',
    agents: '#C2410C',
    other: '#6E7486',
  },
}

/**
 * `auto`（深浅未知）时的图表色。
 *
 * 取舍：每一支都取**中等明度**，在深色内嵌底（38,38,38）与浅色内嵌底
 * （235,235,235）上同时过 3.0——实测最低 3.14（memory 在浅底）、
 * 最高 3.55。没有一支能像专用色板那样拿到 5 以上的余量，这是「不知道
 * 画在哪边」的必然代价；但也不会像原来那样在浅底上跌到 2.13。
 *
 * 这一档的分类色**必须与 `usage-overview.ts` 的 `CONTEXT_PART_LABELS`
 * 逐项相同**：那边画终端字符图，这边画 SVG。
 *
 * 透明度取两套的中间值：太淡在深底上看不见，太浓在浅底上糊成一团。
 */
const AUTO_CHART: ChartPalette = {
  isLight: null,
  used: '#4A6CD4',
  usedOpacity: 1,
  bufferOpacity: 0.52,
  freeOpacity: 0.15,
  axis: '#7C8394',
  label: '#7C8394',
  compact: '#C2650F',
  barEmpty: '#7C8394',
  barEmptyOpacity: 0.23,
  parts: {
    messages: '#4A6CD4',
    system: '#8B5CF6',
    tools: '#0E8595',
    memory: '#0D9488',
    mcp: '#DB2777',
    agents: '#DC5A0E',
    other: '#7A8494',
  },
}

/** 三套图表色，测试与文档里引用。 */
export const CHART_PALETTES = { dark: DARK_CHART, light: LIGHT_CHART, auto: AUTO_CHART } as const

/** 一组界面色：底、边、深浅标记、图表色。 */
export type ThemeColors = PanelFill & {
  /**
   * 图表按哪一档取色：`true` 浅色、`false` 深色、`null` 未知。
   *
   * 注意界面色不看它——那些是主题键，由引擎解析。它只影响 SVG 与终端
   * 字符图里那批十六进制色。
   */
  isLight: boolean | null
  /** 图表要用的那套颜色。 */
  chart: ChartPalette
  /** 页签被选中时的底色与边框：比所在大框再亮一档。 */
  tabActive: PanelFill
  /** 页签被选中时的**文字**色：正文口径（≥4.5），走主题键。 */
  tabActiveText: string
  /** 页内小块（图表、表格）的底色与边框：比所在大框深一档。 */
  inset: PanelFill
}

/**
 * 三档界面色。
 *
 * 界面色**本身不分深浅**——框的底、边、文字全是主题键，由引擎在绘制时
 * 解析，所以三档里它们是同一份引用。分档只为了图表：SVG 里的十六进制
 * 引擎解析不了，只能由插件先选一套。
 */
function themeOf(chart: ChartPalette): ThemeColors {
  return {
    ...SURFACE_FILL,
    isLight: chart.isLight,
    chart,
    tabActive: TAB_ACTIVE_FILL,
    tabActiveText: TAB_ACTIVE_TEXT,
    inset: INSET_FILL,
  }
}

const DARK: ThemeColors = themeOf(DARK_CHART)
const LIGHT: ThemeColors = themeOf(LIGHT_CHART)
/** 深浅未知（`auto`）：界面色照旧走主题键，图表用中性那一套。 */
const AUTO: ThemeColors = themeOf(AUTO_CHART)

/**
 * 从 `/config` 的行里挑出主题，给出这一屏要用的整套颜色。
 *
 * 只读 `key` 与 `value`：调用方传什么都行，测试里也不必造一整行配置。
 *
 * `auto` 与「读不到」都归到 `AUTO`——两者都是「不知道」。这里以前归到
 * 深色，等于赌一边；而 `auto` 恰恰是最常见的设置，赌错就是浅色界面里
 * 整块深色，或者浅底上的亮紫亮青糊成一片。
 */
export function themeColorsFor(
  rows: readonly { key: string; value: unknown }[] | undefined,
): ThemeColors {
  const theme = rows?.find(row => row.key === 'theme')
  const value = typeof theme?.value === 'string' ? theme.value : undefined
  if (isLightTheme(value)) return LIGHT
  if (isDarkTheme(value)) return DARK
  return AUTO
}

/**
 * 兼容旧签名：只要底与边。
 *
 * 保留它是因为测试与文档已经按这个名字写；新代码请直接用 `themeColorsFor`，
 * 它一次给出整套颜色，免得同一个主题被查两遍。
 */
export function panelFillFor(
  rows: readonly { key: string; value: unknown }[] | undefined,
): PanelFill {
  const { backgroundColor, borderColor } = themeColorsFor(rows)
  return { backgroundColor, borderColor }
}

/** 三档的大框底色与边框，测试里引用。 */
export const FILLS = { dark: SURFACE_FILL, light: SURFACE_FILL, auto: SURFACE_FILL } as const

/** 页签激活态的底色，测试里引用。 */
export const TAB_ACTIVE_FILLS = {
  dark: TAB_ACTIVE_FILL,
  light: TAB_ACTIVE_FILL,
  auto: TAB_ACTIVE_FILL,
} as const
