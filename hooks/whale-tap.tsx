/**
 * 鲸鱼的点击区：一整片透明的 `Client` 区域，铺在立绘之上。
 *
 * 为什么不用 `Button`：桌面端把 `Button` 画成原生按钮，它的命中区在纵向
 * 恒为一行文字的高度（实测）。children 写几行都不管用——按钮不会跟着变高。
 * `Client` 是引擎为「一整片区域响应指针」给的元素：区域按 `width`/`height`
 * 铺开，`surface.onPointer` 收到区域内的格坐标。
 *
 * 区域的行列数由 hooks 模块算好、经 props 传进来。**不读 `surface.columns`
 * / `surface.rows`**：文档说那是「布局后的区域尺寸」，但实测它报的是整个
 * 视口的高度，跟 `Client` 自己那块对不上。props 是显式给 `Client` 的那两个
 * 数，两者逐字一致。
 *
 * 这一层只做两件事：把点击（`up`）换算成「按下了鲸鱼」，以及画一片视觉上
 * 不存在的空白。盲文空白 U+2800 有实际宽度但看起来是空的；用普通空格会把
 * 底下的鲸鱼盖成一块白。
 *
 * 它不持有任何业务状态——`post` 把点击送回 hooks 模块，开合、按压形变、
 * 自动收起全在那边，和键盘那条路走同一段代码。
 */
import type { ClientModule } from 'claude-code'

type TapProps = {
  /** 区域的行数，由 hooks 模块算好传进来。 */
  rows: number
  /** 区域的列数，由 hooks 模块算好传进来。 */
  cols: number
}

const WhaleTap: ClientModule<TapProps, { isArmed: boolean }> = (props, surface) => {
  // 监听只挂一次：`state` 还是 `undefined` 就说明这是第一次调用，之后
  // 每次重绘都会带着 `{ isArmed: true }` 回来。
  if (surface.state === undefined) {
    surface.onPointer(event => {
      // 只认 `up`：`down` 与 `move` 在拖选、划过时也会来，那不是「点了一下」。
      // 左右键都要——鲸鱼上只有一个动作，右键没有别的含义。
      if (event.type !== 'up') return
      surface.post({ kind: 'tap' })
    })
    surface.setState({ isArmed: true })
  }

  const { Box, Text } = surface.elements

  // **只用 props 里的行列数，不读 `surface.columns` / `surface.rows`。**
  // 文档说那是「区域布局后的尺寸」，但测试宿主里它报的是整个视口（40 行），
  // 而不是 `Client` 自己那块（16 行）——两个来源对不上时，画出来的内容
  // 会和 `Client` 的 `height` 脱节。props 是我们显式传给 `Client` 的那两个
  // 数，和区域尺寸逐字一致，没有歧义。
  const cols = Math.max(1, props.cols)
  const rows = Math.max(1, props.rows)

  // **`flexDirection: 'column'` 不能省。** `Box` 的默认方向是 `row`：不加
  // 这一行，`rows` 个 `Text` 会排成一条横线，区域高度只有一行——点击区
  // 就变成鲸鱼顶端那一条。JSX 里写 `<Box flexDirection="column">` 时看得见，
  // 这里直接调构造函数，最容易漏。
  return Box({
    flexDirection: 'column',
    children: Array.from({ length: rows }, () =>
      Text({ children: '⠀'.repeat(cols) }),
    ),
  })
}

export default WhaleTap
