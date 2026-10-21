/**
 * 鲸鱼的点击区：一整片透明的 `Client` 区域，铺在立绘之上。
 *
 * 为什么不用 `Button`：桌面端把 `Button` 画成原生按钮，它的命中区在纵向
 * 恒为一行文字的高度（实测）。children 写几行都不管用——按钮不会跟着变高。
 * `Client` 是引擎为「一整片区域响应指针」给的元素：区域由父容器给定尺寸，
 * `surface.onPointer` 收到区域内的格坐标。
 *
 * **尺寸不要从 props 传进来。** 区域有多大由布局决定，模块在 `surface.columns`
 * / `surface.rows` 里读得到（「as last laid out」）。以前按像素估出一组行列数
 * 再传进来，估小了点击区就只盖住图片上半截，下沿点不中。
 *
 * 这一层只做两件事：把点击（`up`）换算成「按下了鲸鱼」，以及画一片视觉上
 * 不存在的空白。盲文空白 U+2800 有实际宽度但看起来是空的；用普通空格会把
 * 底下的鲸鱼盖成一块白。
 *
 * 它不持有任何业务状态——`post` 把点击送回 hooks 模块，开合、按压形变、
 * 自动收起全在那边，和键盘那条路走同一段代码。
 */
import type { ClientModule } from 'claude-code'

const WhaleTap: ClientModule<Record<string, never>, { isArmed: boolean }> = (_props, surface) => {
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

  // 第一次布局前 `columns`/`rows` 都是 0。给 1×1 兜底：什么都不画的话，
  // 区域可能被判成 0×0 而收不到指针。
  const cols = Math.max(1, surface.columns)
  const rows = Math.max(1, surface.rows)

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
