/**
 * 鲸鱼的点击区：一整片透明的 `Client` 区域，铺在立绘之上。
 *
 * 为什么不用 `Button`：桌面端把 `Button` 画成原生按钮，它的命中区在纵向
 * 恒为一行文字的高度（实测）。children 写几行都不管用——按钮不会跟着变高。
 * `Client` 是引擎为「一整片区域响应指针」给的元素：它的区域按 `width` /
 * `height` 铺开，`surface.onPointer` 收到区域内的格坐标。
 *
 * 这一层只做两件事：把点击（`up`）换算成「按下了鲸鱼」，以及画出一片
 * 视觉上不存在的空白。盲文空白 U+2800 有实际宽度但看起来是空的；用普通
 * 空格会把底下的鲸鱼盖成一块白。
 *
 * 它不持有任何业务状态——`post` 把点击送回 hooks 模块，开合、按压形变、
 * 自动收起全在那边，和键盘那条路走同一段代码。
 */
import type { ClientModule } from 'claude-code'

type TapProps = {
  /** 区域的行数，等于父 Box 的 `height`。 */
  rows: number
  /** 区域的列数，等于父 Box 的 `width`。 */
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
  return Box({
    children: Array.from({ length: props.rows }, () =>
      Text({ children: '⠀'.repeat(props.cols) }),
    ),
  })
}

export default WhaleTap
