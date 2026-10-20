/**
 * 面板的「现在是深色还是浅色」，以及跟着主题走的一组界面色。
 *
 * 引擎不直接告诉插件当前主题，但 `/config` 的 `theme` 行就是这份信息
 * （`$.config.list()` 里 `key === "theme"`）。读不到时按深色处理——桌面端与
 * 终端默认都是深色。
 *
 * 为什么需要它：SVG 图表里的颜色是**写死的十六进制**，不像 `Box` 的
 * `backgroundColor` 那样能写主题键让引擎去解析。而两套主题需要的是两组
 * 不同的色值，不是同一支色的两个透明度：
 *
 *   - 亮蓝 `#4D6BFE` 在深色底上对比度 4.02，在白底上也是 4.33 —— 它自己
 *     两边都立得住，可以做主色；
 *   - 但 `#22C3D6`（青，工具定义）在深底上是 8.16，在白底上只剩 2.13；
 *     `#A78BFA`（紫）深底 6.40、白底 2.72。这类「为深色挑的亮色」在白底上
 *     会糊成一片。
 *   - 反过来，靠 `fill-opacity` 压透明也救不了：透明只会让它更靠近背景，
 *     对比度更低。
 *
 * 所以分类色、轴线、刻度、压缩标记各备两套，按主题取。每一对都实测过
 * 对比度：图形元素 ≥ 3.0，文字 ≥ 4.5（见 `tests/unit.test.ts` 的断言，
 * 改了色值就会立刻测出来）。
 */

/** 一处圆角框的两种颜色。 */
export type PanelFill = {
  /** 框内底色。 */
  backgroundColor: string
  /** 边框色。 */
  borderColor: string
}

/**
 * 深色主题：底色比面板底明显亮一档，边框再亮一点——要的是「托起来一层」，
 * 而不是和背景糊成一片。三处圆角框共用这一组，读者扫视时不会觉得
 * 「概览」和「模型」是两种不同的东西。
 */
const DARK_FILL: PanelFill = { backgroundColor: '#262b3d', borderColor: '#4a5378' }

/** 浅色主题：同一种蓝调，反向取明度。 */
const LIGHT_FILL: PanelFill = { backgroundColor: '#e3e7f7', borderColor: '#b4bcd8' }

/**
 * 页签「激活」时的底色：比所在大框再亮一档。
 *
 * 深色主题的方向是**往亮走**、浅色主题是**往白走**——两者都是「更靠近前景」，
 * 也就是读者直觉里的「被选中、浮起来」。
 *
 * 只靠底色不够：浅色主题下 #e3e7f7 往白走最多只能到 #ffffff，两者对比度
 * 只有 1.23，几乎看不出来——这是色彩空间的限制，换哪个值都突破不了。所以
 * 边框也一起换，而且换到对比更强的一档（深色 2.72、浅色 2.38）。**底色说
 * 「哪一块更亮」，边框说「哪一块被选中」**，两个通道加起来才在两套主题下
 * 都读得出来。
 */
const DARK_TAB_ACTIVE = { backgroundColor: '#3a4260', borderColor: '#8e9ac9' }
const LIGHT_TAB_ACTIVE = { backgroundColor: '#ffffff', borderColor: '#6675a8' }

/** 主题值是浅色的吗。`light`、`light-daltonized`、`light-ansi` 都算。 */
export function isLightTheme(themeValue: string | undefined): boolean {
  return (themeValue ?? '').toLowerCase().includes('light')
}

/**
 * 图表的主题色对：`dark` 与 `light` 各一套。
 *
 * 键与 `chart-art.ts` 的 `COLORS` 一一对应。分类色沿用同一套色相
 * （青还是青、紫还是紫），只压明度——读者在两种主题下看到的是同一张图的
 * 同一种读法，不会因为换主题就要重新认颜色。
 */
export type ChartPalette = {
  /** 这套调色板是给浅色主题的吗——模型色阶要据此选另一份色值表。 */
  isLight: boolean
  /** 主色：核心蓝，两种主题共用。 */
  used: string
  /** 压缩缓冲、空闲段：同一支蓝，靠透明度压下去。 */
  usedOpacity: number
  bufferOpacity: number
  freeOpacity: number
  /** 轴线与刻度。 */
  axis: string
  label: string
  /** 压缩标记：暖色，与整套冷色形成对照。 */
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
 * 每一支在 `#1a1a1a` 上都过 3.0。
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
    memory: '#7AA2F7',
    mcp: '#C084FC',
    agents: '#1E6F8C',
    other: '#7C8394',
  },
}

/**
 * 浅色主题的图表色。
 *
 * 同一批色相，明度压低到在白底上读得出。逐支实测（白底对比度）：
 * messages 6.13、system 5.33、tools 4.92、memory 5.40、mcp 5.38、
 * agents 5.66、other 4.66。
 *
 * 透明度这边反而要**调高**：浅底上「已用」是深蓝、缓冲是同色更浅的一档，
 * 靠的是让底色透上来把它冲淡，所以 45% 比深色主题那份更实一点才对。
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
    system: '#7C4DDB',
    tools: '#0E7C8A',
    memory: '#3468C0',
    mcp: '#9333EA',
    agents: '#1E6F8C',
    other: '#6E7486',
  },
}

/** 两套图表色，测试与文档里引用。 */
export const CHART_PALETTES = { dark: DARK_CHART, light: LIGHT_CHART } as const

/**
 * 页内小块的底色：比所在大框**深**一档。
 *
 * 方向与页签的激活态相反，原因也相反：页签是「被选中所以往前浮」，而
 * 图表块是「嵌在页面里的一块内容」，往后退一格才读得出层次。两块都往亮走
 * 的话，页面会像一堆同样亮度的方块铺在一起，反而看不出分组。
 */
const DARK_INSET = { backgroundColor: '#1f2434', borderColor: '#3d4566' }
const LIGHT_INSET = { backgroundColor: '#eef1fb', borderColor: '#c5cbe2' }

/** 一组界面色：底、边、深浅标记、图表色。 */
export type ThemeColors = PanelFill & {
  /** 当前是不是浅色主题。图表以外的地方也用得上。 */
  isLight: boolean
  /** 图表要用的那套颜色。 */
  chart: ChartPalette
  /** 页签被选中时的底色与边框：比所在大框再亮一档。 */
  tabActive: PanelFill
  /** 页内小块（图表、表格）的底色与边框：比所在大框深一档。 */
  inset: PanelFill
}

/** 深色一组。 */
const DARK: ThemeColors = {
  ...DARK_FILL,
  isLight: false,
  chart: DARK_CHART,
  tabActive: DARK_TAB_ACTIVE,
  inset: DARK_INSET,
}
/** 浅色一组。 */
const LIGHT: ThemeColors = {
  ...LIGHT_FILL,
  isLight: true,
  chart: LIGHT_CHART,
  tabActive: LIGHT_TAB_ACTIVE,
  inset: LIGHT_INSET,
}

/**
 * 从 `/config` 的行里挑出主题，给出这一屏要用的整套颜色。
 *
 * 只读 `key` 与 `value`：调用方传什么都行，测试里也不必造一整行配置。
 * 找不到 `theme` 行（老版本引擎、被管理员锁掉的配置）时退回深色：
 * 那是更常见的环境，且错了也只是「淡一点」而不是「看不见字」。
 */
export function themeColorsFor(
  rows: readonly { key: string; value: unknown }[] | undefined,
): ThemeColors {
  const theme = rows?.find(row => row.key === 'theme')
  const value = typeof theme?.value === 'string' ? theme.value : undefined
  return isLightTheme(value) ? LIGHT : DARK
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

/** 这些底色在测试与文档里被引用，导出便于比对。 */
export const FILLS = { dark: DARK_FILL, light: LIGHT_FILL } as const

/** 页签激活态的两种底色，测试里引用。 */
export const TAB_ACTIVE_FILLS = { dark: DARK_TAB_ACTIVE, light: LIGHT_TAB_ACTIVE } as const