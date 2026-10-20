/**
 * 面板圆角框的底色与描边：跟着当前主题走。
 *
 * 引擎不直接告诉插件「现在是深色还是浅色」，但 `/config` 的 `theme` 行
 * 就是这份信息（`$.config.list()` 里 `key === "theme"`）。读不到时按深色
 * 处理——桌面端与终端默认都是深色，猜错的代价也只是衬底比别人淡一档，
 * 不会出现浅色主题下一整块发黑那种事故。
 *
 * 为什么不像热图那样用半透明：`Box` 的 `backgroundColor` 只吃实色，
 * 终端也没有 alpha 通道。所以这里只能按主题挑两支不同的实色。
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

/** 主题值是浅色的吗。`light`、`light-daltonized`、`light-ansi` 都算。 */
export function isLightTheme(themeValue: string | undefined): boolean {
  return (themeValue ?? '').toLowerCase().includes('light')
}

/**
 * 从 `/config` 的行里挑出主题，换算成框的两种颜色。
 *
 * 只读 `key` 与 `value`：调用方传什么都行，测试里也不必造一整行配置。
 * 找不到 `theme` 行（老版本引擎、被管理员锁掉的配置）时退回深色：
 * 那是更常见的环境，且错了也只是「淡一点」而不是「看不见字」。
 */
export function panelFillFor(
  rows: readonly { key: string; value: unknown }[] | undefined,
): PanelFill {
  const theme = rows?.find(row => row.key === 'theme')
  const value = typeof theme?.value === 'string' ? theme.value : undefined
  return isLightTheme(value) ? LIGHT_FILL : DARK_FILL
}

/** 这些底色在测试与文档里被引用，导出便于比对。 */
export const FILLS = { dark: DARK_FILL, light: LIGHT_FILL } as const
