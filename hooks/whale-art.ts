/**
 * 小鲸鱼画面：把原版素材（MeteorNoX/DeepSeek-Balance-Whale-Widget 的
 * `DSniang1.png`，MIT）以 base64 内嵌进 SVG，保证像素级一致。
 *
 * 为什么内嵌而不是外链：桌面端的 `Svg` 元素只接受一个完整的 SVG 字符串，
 * 没有位图元素，也不能引用插件目录里的文件。data URI 是唯一能让原图像素
 * 级呈现的方式。
 *
 * 构图沿用原版：鲸鱼 cut-out 贴在右下角，白色对话气泡在左上，三行文字叠在
 * 气泡里。气泡是代码画的（原版也是），所以文字可随数据变化。
 */
import { WHALE_ASSETS } from './whale-asset.ts'

/** 面板立绘的画布尺寸；外部显示尺寸必须按这个比例算，否则会留白抖动。 */
export const WHALE_CANVAS = { width: 620, height: 320 } as const

/** 画布的高宽比，外部计算 height 时直接乘它。 */
export const WHALE_ASPECT = WHALE_CANVAS.height / WHALE_CANVAS.width

/**
 * 鲸鱼位图在画布里的位置与边长。
 *
 * 单独提出来是为了**绘制**：`whaleSvg` 里 image 的 `x`/`y` 与画布总宽
 * 都由它推出来，写死两份迟早对不上。
 */
const WHALE_GROUP_X = 318
const WHALE_GROUP_Y = 16
const WHALE_IMAGE_W = 300

/**
 * 立绘的最大显示宽度，也是**默认尺寸**（设置页 100% 档）。
 *
 * 从 300 提到 380：停靠面板常见 100~140 列（约 800~1120px），300px 的立绘
 * 只占三分之一，泡泡里的字被压得太小。380px 在同样宽度下约占一半，仍给
 * 上方的内容留足空间；再宽就会喧宾夺主。
 */
export const WHALE_MAX_WIDTH = 380

/**
 * 面板宽度（字符列）→ 立绘的显示尺寸，宽高严格按画布比例。
 *
 * **默认固定尺寸，不随面板宽度变化。** 早先按面板宽度算（宽度取面板的
 * 55%），结果面板一横向压缩，鲸鱼跟着缩水——读者只是把窗口拉窄，画面里
 * 的主角却变了个大小。
 *
 * 只有一种情况会缩：**面板窄到放不下**。这时按可用宽度收缩，否则立绘会
 * 溢出到面板外被裁掉（引擎的 `overflow` 只有 visible / hidden，没有滚动）。
 * 边界在 48 列附近（380px ÷ 8px 每列），比它宽的停靠面板一律用原尺寸。
 *
 * 想主动改大小，用设置页的「立绘大小」档位——那是读者自己的选择，
 * 与「窗口被拉窄」是两回事。
 */
export function whaleSizeFor(columns: number): { width: number; height: number } {
  // 一列约 8px（等宽字体在桌面端的常见值）；留一格余量，免得立绘贴死边缘。
  const availablePx = Math.max(0, columns - 1) * 8
  const width = Math.min(WHALE_MAX_WIDTH, availablePx)
  return { width, height: width * WHALE_ASPECT }
}

/** 鲸鱼的状态：决定气泡配色与提示语。 */
export type WhaleMood = 'idle' | 'working' | 'busy' | 'tired' | 'sleep'

/**
 * 一天里的作息表：本地钟点 → 情绪。
 *
 * **情绪不再跟额度走。** 额度回答的是「这一窗口用掉了多少」，与角色此刻在
 * 做什么是两回事：深夜该睡就得睡，不能因为额度还空着就让她一直精神抖擞；
 * 反过来，上午刚开工时额度可能已经过半，她也不该因此立刻变成吃撑的样子。
 *
 * 改按钟点之后，挂件在一天里的样子跟着人一起变：深夜睡着 → 早晨还没开工、
 * 摸摸鱼 → 上午干活 → 午饭吃白饭 → 下午继续 → 晚饭再吃 → 夜里累了。
 * 两顿饭各给一段 `busy`，正对「吃白饭」这个梗。
 *
 * 各段的边界都取整点，且左闭右开（`[from, to)`），这样 `hour` 只需一次比较。
 * 用**本地时间**（`Date#getHours`）而不是 UTC：人看的是自己的钟。
 */
const DAY_SCHEDULE: ReadonlyArray<{ before: number; mood: WhaleMood }> = [
  { before: 6, mood: 'sleep' }, // 00:00–05:59 深夜
  { before: 9, mood: 'idle' }, // 06:00–08:59 早晨，还没开工
  { before: 12, mood: 'working' }, // 09:00–11:59 上午
  { before: 14, mood: 'busy' }, // 12:00–13:59 午饭
  { before: 18, mood: 'working' }, // 14:00–17:59 下午
  { before: 21, mood: 'busy' }, // 18:00–20:59 晚饭
  { before: 24, mood: 'tired' }, // 21:00–23:59 夜里，累了
]

/**
 * 当前时刻 → 情绪。
 *
 * @param now 毫秒级 Unix 时间戳（`$.clock.now()` 或 `Date.now()`）。
 *   按**本地时区**取钟点，所以同一份代码在不同时区会各自按当地作息走。
 */
export function moodOf(now: number): WhaleMood {
  const hour = new Date(now).getHours()
  for (const slot of DAY_SCHEDULE) {
    if (hour < slot.before) return slot.mood
  }
  // `getHours()` 只返回 0–23，`before: 24` 一定兜住；这里只是让类型收窄。
  return 'tired'
}

/**
 * 一天里的几个时段，**只用来挑状态栏的台词**，不参与情绪判定。
 *
 * 与 `DAY_SCHEDULE` 是两件事：那张表回答「她此刻是什么情绪」（睡着 / 摸鱼 /
 * 吃撑），这张表回答「现在几点」（深夜 / 清晨 / …）。同一个 `morning` 既可能
 * 是 `idle`（还没开工）也可能是 `working`（正在跑），而 `idle` 在深夜与清晨
 * 说的话不该一样。
 *
 * 六档而不是更细：状态栏是扫一眼的地方，台词按时段换得太密反而看不出规律。
 * 六个段落各覆盖几个小时，读者能感觉到「早上和晚上说的话不一样」。
 */
export type DayPart = 'deepnight' | 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night'

/** 时段边界，左闭右开，与 `DAY_SCHEDULE` 同一个约定，用本地钟点。 */
const DAYPART_BOUNDS: ReadonlyArray<{ before: number; part: DayPart }> = [
  { before: 6, part: 'deepnight' }, // 00:00–05:59 深夜，该睡了
  { before: 9, part: 'dawn' }, // 06:00–08:59 清晨，刚醒
  { before: 12, part: 'morning' }, // 09:00–11:59 上午，开工
  { before: 18, part: 'afternoon' }, // 12:00–17:59 白天，最长的一段
  { before: 22, part: 'evening' }, // 18:00–21:59 傍晚，收工
  { before: 24, part: 'night' }, // 22:00–23:59 夜里，困了
]

/**
 * 当前时刻属于哪个时段。
 *
 * @param now 毫秒级 Unix 时间戳，按**本地时区**取钟点
 */
export function dayPartOf(now: number): DayPart {
  const hour = new Date(now).getHours()
  for (const slot of DAYPART_BOUNDS) {
    if (hour < slot.before) return slot.part
  }
  return 'night'
}

/** 没有图形元素时（终端 surface）用的文字鲸鱼。 */
export function emblemOf(mood: WhaleMood): string {
  switch (mood) {
    case 'tired':
      return '🐋'
    case 'sleep':
      return '💤'
    default:
      return '🐳'
  }
}

/**
 * 用量条上的鲸鱼：**单行字符画**，随会话是否在运行而变。
 *
 * 为什么不用 Svg 位图：那条子只有一行高（约 20px），而位图立绘的最小可读
 * 尺寸就顶到 52px——塞进去要么被裁掉一半，要么把条子撑高。字符画按字符格
 * 布局，与条子上的摘要文字同一套度量，不会撑高，也不会在 DPI 变化时错位。
 *
 * 每一档各有一套帧，宽都是 `BAND_WHALE_TEXT_COLS` 列，所以状态切换时
 * 后面的摘要文字不会左右跳。状态不是「动的装饰」，而是**会话此刻处在哪个
 * 阶段**——读者扫一眼就知道她在等你、在想、在跑、在压缩，还是已经睡了：
 *
 *   - `idle`       静息：没有轮次，且上一轮答完已超过 `WAITING_HOLD_MS`。
 *                  `z` 一个字母一个字母地蹦出来，攒满整格呼一口气，末尾
 *                  补两句按钟点的闲话（见 `IDLE_LINES`）
 *   - `waiting`    等你：刚答完、你还没开口的那几分钟，按钟点说一句
 *                  （见 `WAITING_LINES`）
 *   - `thinking`   想：轮次刚起、模型还没出字的头两秒
 *   - `working`    干活：正常跑着。第一帧报今天星期几，后两帧是摸鱼的老台词
 *   - `busy`       忙：同一轮里的另一半，吃白饭那一套
 *   - `compacting` 压缩：引擎正在把对话折起来（`session.compact`）
 *
 * 「等」与「静息」的分界靠**时间**：刚答完的那几分钟她还看着你，超过
 * `WAITING_HOLD_MS` 就自己去发呆。「想」与「干活」的分界同样靠时间——
 * 引擎没有「首个 token 到达」的事件（`turn.step` 是流式钩子，为一行字符画
 * 挂上去不值得），`THINKING_HOLD_MS` 是从 `turn.start` 起的一个近似窗口：
 * 宁可早一点说「在干活」，也不要一直卡在「正在想」。
 *
 * **不再画鲸鱼轮廓，也不再吐泡泡。** 早先每帧都带一个 `~)~` 当作鲸鱼，
 * 干活与忙则是 `>` 后面拖一串 `~` 当水花。那条子只有一行高：`~)~` 画出来
 * 是个静止的括号脸，既不像鲸鱼，又把鼾声挤到左边半格；`~` 水花则只是
 * 装饰，读者看不出它在表达什么。现在每一档把水花换成了**她自己说的话**
 * ——一行高的一格里，文字比波浪更能说明"她在干嘛"。
 */
export type BandWhaleState =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'working'
  | 'busy'
  | 'compacting'

/**
 * 用量条字符画的帧。**每一帧都恰好 `BAND_WHALE_TEXT_COLS` 列**——状态切换、
 * 帧切换时后面的摘要文字才不会左右跳（有测试钉住这一点）。
 *
 * ## 三个状态各讲一件事
 *
 * 状态差异不靠颜色（`diffAdded` 按设计规则只用于「增加的行数」，拿来当装饰
 * 会让同一个颜色表达两件事）：
 *
 * - **睡觉 `idle`**：只有鼾声，`z` **一个字母一个字母地蹦出来**——`z` →
 *   `zz` → … → 攒满整格，`（呼）` 呼出来，空一拍，再补一声 `呼`。攒字母
 *   那十六帧各 0.2 秒，看得见它是逐个长出来的；整轮 4.8 秒，接近一次呼吸。
 * - **干活 `working` / 忙 `busy`**：`>` 是鱼头，后面是她嘀咕的一句。
 *   每一档三帧：**帧 0 说今天星期几**（文案来自 `WEEKDAY_FRAMES`），
 *   **帧 1、2 说手头在干什么**（就是下面这两组「摸鱼」「白饭」的句子）。
 *
 * 后两档各三帧、每帧 2.4 秒，「星期几」与两句「在干嘛」轮着说——一句话得
 * 停够时间才读得完。
 *
 * ## 为什么干活与忙不再吐泡泡
 *
 * 早先这两档是 `>` 后面拖一串 `~` 当水花（`~` 一多就像在吐泡泡），靠长短
 * 表现忙闲。问题是一行高的格里，`~` 只是装饰：读者看不出那一串在说什么，
 * 而这一格占着条子上宝贵的位置。换成她自己的话之后，同样的位置既能表示
 * 「在跑」，也顺带把这个梗说出来了。
 *
 * ## 为什么睡觉那档不画鲸鱼
 *
 * 早先每一帧都带一个 `~)~` 当鲸鱼，睡觉时它一列都不动，整条里只有鼾声
 * 在变——那个静止的括号脸既不像鲸鱼，又把本来就短的鼾声挤到左边半格。
 * 去掉之后字母能把整格铺满，「一个一个蹦出来」这件事才看得清。
 *
 * ## 字符选择
 *
 * 半角字符只用 `>`、`z` 与空格，加上两句话里的汉字。**再没有 `~` 了**——
 * 它原来的用处是「泡泡」，现在泡泡换成了文字。
 *
 * 早先用过 `≋`（U+224B）与 `ᐟ`（U+141F，加拿大音节文字）：Unicode 标准里
 * 两者都是 1 列宽，但后者在多数西文字体里没有字形，会触发 fallback，而
 * fallback 字体未必与等宽数字同宽——一旦它被画成 2 列，整条用量条就会错位。
 * 现在的字符集在任何等宽字体里都是稳定 1 列。
 *
 * 汉字与全角括号按 CJK 规则各占 2 列，由 `displayWidth` 正确计数；面板里
 * 本来就通篇中文，字体必定覆盖。
 */
export const BAND_WHALE_FRAMES: Readonly<Record<BandWhaleState, readonly string[]>> = {
  // 睡觉：z 一个字母一个字母长出来，攒满整条，呼一口气，停一下，再呼一声。
  idle: [
    'z               ',
    'zz              ',
    'zzz             ',
    'zzzz            ',
    'zzzzz           ',
    'zzzzzz          ',
    'zzzzzzz         ',
    'zzzzzzzz        ',
    'zzzzzzzzz       ',
    'zzzzzzzzzz      ',
    'zzzzzzzzzzz     ',
    'zzzzzzzzzzzz    ',
    'zzzzzzzzzzzzz   ',
    'zzzzzzzzzzzzzz  ',
    'zzzzzzzzzzzzzzz ',
    'zzzzzzzzzzzzzzzz',
    '     （呼）     ',
    '                ',
    '      呼        ',
  ],
  // 干活：鱼头 `>` 后面是她嘀咕的话。这两句**不随日期变**，是周期里的
  // 第 2、3 帧；第一帧是「今天星期几」，由 `weekdayFrame` 现算——
  // 它按天变，进不了常量表。完整帧序见 `bandWhaleFramesOf`。
  working: [
    '> 工作间隙摸鱼中',
    '> 悄悄摸鱼中    ',
  ],
  // 忙：还是吃白饭那一套。
  busy: [
    '> 猛吃大白饭中  ',
    '> 再来一碗      ',
  ],
  // 想：轮次刚起、模型还没出字的头两秒。
  //
  // 这两句都有出处：
  //   - 「内心 OS 很长」来自萌娘百科原文「能够"深度思考"，对于每个现实人类的
  //     要求都会思考再三，有着长长的内心OS」
  //   - 「已深度思考」是 DeepSeek 官方 chat UI 的原话（`messageThinkDuration`：
  //     `"已思考（用时 X 秒）"`），B 站热评里被改成「已深度思考（用时 半年）」
  //     用来玩梗。取前四个字，正好和「内心 OS 很长」一样长。
  thinking: [
    '> 内心 OS 很长  ',
    '> 已深度思考    ',
  ],
  // 等你：答完了，你还没开口。按钟点说一句，见 `WAITING_LINES`。
  waiting: [
    '> 等你敲键盘    ',
    '> 我在听        ',
  ],
  // 压缩：引擎把对话折起来的那一刻，两三秒就过去了。
  //
  // 「记住要紧的」说的是压缩本身在做什么（保留摘要、丢掉细节），不是卖萌。
  // 早先这里是「打包进行李箱」，画面感好但与压缩没有语义对应；换成这句之后
  // 读者能把它和面板里那条「压缩」虚线对上。
  compacting: [
    '> 记住要紧的    ',
    '> 把对话折起来  ',
  ],
}

/**
 * 一周七天各自的两句话。**索引 0 是周日**（与 `Date.getDay()` 一致）。
 *
 * ## 为什么是「一天一组」
 *
 * 状态栏那一格是扫一眼的地方：同一句话在星期三出现、星期五又原样出现，
 * 读者不会觉得它在说话，只会觉得它没在变。按天换之后，一周之内不重复。
 *
 * 星期句只占每档三帧里的第一帧（2.4 秒），后两帧仍是「摸鱼」「白饭」那套
 * 老台词——**那几句不丢**：它们说的是「手头在干什么」，星期句说的是「今天
 * 哪天」，两件事都要讲，轮着说。
 *
 * ## 为什么用「星期X」而不是谐音梗
 *
 * 早先试过打工人谐音梗那一套（忙day / 求死day / 未死day / 福来day /
 * 洒脱day / 伤day）。**用户明确否掉了**：英文夹在中文里，读起来要先在
 * 脑子里转一道弯，而状态栏是扫一眼的东西，不该需要解码。现在一律写
 * 「星期一」这样的中文表述，格式统一成 `> 星期X，三字话`。
 *
 * ## 保留的那一层：周四说炸鸡
 *
 * 「星期四，想吃鸡 / 要白饭」来自 B 站 2026-10 的「大肥鱼 × 疯狂星期四」
 * 二创（《关于疯狂星期四，而大肥鱼被迫去打工这件事—动画MV［炸鸡快走开，
 * 我要白米饭！］》《大肥鱼觉得疯狂星期四，不如大白饭》）。核心张力是
 * **炸鸡 vs 白米饭**——她被迫去打炸鸡的工，心里只想着白饭。这里只留了
 * 「想吃鸡」这半句，不写「疯狂星期四」四个字：日期本身已经说明了场合，
 * 挂件不该像营销号那样喊口号。
 *
 * ## 每条都必须恰好 16 列
 *
 * `BAND_WHALE_TEXT_COLS` 是硬约束（有测试逐帧验算）。`> 星期X，` 固定占
 * 10 列，后面接三个汉字正好 6 列，合起来 16——所以这一版十四条**全部**
 * 填满，不用补空格。`displayWidth` 按 CJK 规则把汉字算 2 列。
 *
 * ## 语气
 *
 * 与状态栏原有那两句一致：**她自己在嘀咕**，不是对读者喊话。
 */
const WEEKDAY_FRAMES: readonly (readonly [string, string])[] = [
  // 0 周日：假期还剩最后一点，想着明天。
  ['> 星期日，还想过', '> 星期日，有点烦'],
  // 1 周一：一周最重的一天。
  ['> 星期一，想躺平', '> 星期一，不想动'],
  // 2 周二：刚认清这周才刚开始。
  ['> 星期二，想吃点', '> 星期二，好累啊'],
  // 3 周三：一周的分水岭，还能撑。
  ['> 星期三，正游着', '> 星期三，还在撑'],
  // 4 周四：疯狂星期四。炸鸡 vs 白饭是这个二创的核心。
  ['> 星期四，想吃鸡', '> 星期四，要白饭'],
  // 5 周五：明天就休息。
  ['> 星期五，要加餐', '> 星期五，加碗饭'],
  // 6 周六：唯一能睡饱的一天。
  ['> 星期六，睡到饱', '> 星期六，躺平啦'],
]

/**
 * 「等你」那档按钟点说的话。**索引是 `DayPart`。**
 *
 * 这一档说的是「我答完了，在听你说」，不是「我很闲」——语气要像一个人
 * 说完话之后等着，而不是机器报「READY」。所以每句都是短促的、带一点
 * 催促或撒娇的口吻，且都在 16 列的框里。
 *
 * ## 写作约束
 *
 * 每句必须是 `> ` 开头、总宽恰好 `BAND_WHALE_TEXT_COLS`（16）列。汉字算 2 列，
 * 所以「`> `」占 2 列 + 最多 7 个汉字 14 列。**七个汉字就是上限**，标点也算
 * 一个汉字宽（全角）。
 *
 * ## 时段差异为什么重要
 *
 * 同一个「我在听」，早上说和深夜说不是一回事：早上是「早，说吧」，深夜是
 * 「你半夜才找我」。读者在小屏幕上看到这一句，能立刻确认「她还在，而且
 * 现在是几点」——这比一个不变的「等待输入」有用得多。
 */
const WAITING_LINES: Readonly<Record<DayPart, readonly [string, string]>> = {
  // 深夜：她其实该睡了，但还撑着听你说。
  // 「你只在半夜十二点后找我」出自 B 站原创歌曲《已深度想你》的歌词
  // （UP 主失心，BV1JaJo6jEqH，63.7 万播放），原句比这里长，取前七个字。
  deepnight: ['> 你半夜才找我  ', '> 我陪你熬着    '],
  // 清晨：刚醒，还没完全进入状态。
  dawn: ['> 早，说吧      ', '> 刚醒，听着呢  '],
  // 上午：一天里精神最好的一段。
  // 「怪服务器别怪鱼」出自 B 站评论原话「实在慢的话，怪服务器，别怪鱼🐳」
  morning: ['> 等着呢        ', '> 慢就怪服务器  '],
  // 白天：最长的一段，语气最平。
  // 「在呢，别催」出自 B 站评论「在呢，别催，鱼也要喘口气」（BV1JaJo6jEqH），
  // 那是用户催她时她的回应——放在"答完了在等你"这一档正合适。
  afternoon: ['> 在呢，别催    ', '> 等你敲键盘    '],
  // 傍晚：快收工了，有一点松。
  evening: ['> 收工前说吧    ', '> 还听着呢      '],
  // 夜里：眼皮在打架。
  night: ['> 还没睡呀      ', '> 我快睡着了    '],
}

/**
 * 静息那档按钟点补的一句闲话：**夹在呼吸动画的一拍里**，说完接着打鼾。
 *
 * ## 为什么单独一张表，不并进 `WAITING_LINES`
 *
 * `waiting` 说的是「我在听你说」，`idle` 说的是「我睡着了 / 自己待着」。
 * 两者都是静止状态，但语气完全不同：一个朝向读者，一个朝向自己。并进
 * 一张表就会被写成同一种腔调。
 *
 * ## 为什么只在夜里与傍晚说
 *
 * 静息档的主体是 `z` 的呼吸动画——那是挂件最常被看到的样子，不该被话
 * 占满。只在两轮呼吸之间插一句，且只挑**她真的该有点反应**的时段：
 * 深夜还在亮着的屏幕、傍晚该收工的时候；白天则换成一声鲸叫（见下）。
 *
 * ## 白天那档为什么是「哦鲸鲸」
 *
 * 白天不睡也不等你，屏幕上最安静的那段——这里放一声**鲸叫**。
 *
 * 「哦鲸鲸」的考据（2026-11-01 调研，详见 README）：
 *
 *   - 萌娘百科把它列进「DeepSeek 娘」的别名栏，**但加了删除线、套了
 *     「只为博君一笑，不必照单全收」的玩笑模板**；
 *   - B 站从 2026-08 起有 1000+ 条结果拿它当标题或 ID，最早的公开记录是
 *     贴吧 2026-08-23「发梗图给她，她会一直哦鲸鲸」——是**互动现象**，
 *     不是设定里的口头禅；
 *   - 它同时是日语 おちんちん 的空耳，pixiv 标签与 GitHub 同名仓库都指向
 *     那一层，社区里也有一派明确表示「以为是可爱才这么叫」。
 *
 * **所以它在这里只当拟声用**：一声鲸叫，不写成口癖、不在别的档重复出现。
 * 读者读出哪一层都不影响这一格要说的「她待着呢」。这一条是用户明确选定的
 * 方案——他接受风险，并要求在 README 里注明它没有一手出处。
 */
const IDLE_LINES: Readonly<Partial<Record<DayPart, readonly [string, string]>>> = {
  // 深夜：屏幕还亮着，她半梦半醒地嘟囔。
  // 「要休眠了」呼应萌娘百科的「打瞌睡（运作 sleep 命令）DeepSleep」——
  // 她把休眠当成真的睡觉，所以用"休眠"而不是"关机"。
  deepnight: ['> 还亮着灯呢    ', '> 我要休眠了    '],
  // 清晨：还没开工，也还没睡。
  dawn: ['> 哦鲸鲸        ', '> 哦鲸鲸……      '],
  // 上午：白天最前面的一段。
  morning: ['> 哦鲸鲸        ', '> 哦鲸鲸……      '],
  // 白天：一天里最长、最安静的那段。
  afternoon: ['> 哦鲸鲸        ', '> 哦鲸鲸……      '],
  // 夜里：眼皮在打架。
  night: ['> 困了          ', '> 明天还来吗    '],
  // 傍晚：一天快结束。第二句用「DeepSleep」——萌百原文的写法，
  // 六个字母 6 列，加上「梦里吃白饭」正好凑成她睡前最后一句。
  evening: ['> 先睡一会      ', '> 梦里吃白饭    '],
}

/**
 * 某个时刻的星期句：先看星期几，再按 `working` / `busy` 取其一。
 *
 * 它是每档三帧里的**第一帧**，后两帧是 `BAND_WHALE_FRAMES` 里固定的老台词。
 *
 * @param state 当前状态（`idle` 时不走这里，睡觉那档是 `z` 的动画）
 * @param now   当前时刻，用**本地时区**取星期几与帧相位
 */
export function weekdayFrame(state: BandWhaleState, now: number): string {
  const pair = WEEKDAY_FRAMES[new Date(now).getDay()] ?? WEEKDAY_FRAMES[1]!
  return state === 'busy' ? pair[1] : pair[0]
}

/**
 * 某个状态下完整的帧序。
 *
 * 三档动态内容各有一处来源：
 *
 *   - `working` / `busy`：**帧 0 是星期句**（`WEEKDAY_FRAMES`，按天变），
 *     帧 1、2 是固定老台词（摸鱼 / 白饭）
 *   - `waiting`：两句都按时段换（`WAITING_LINES`）——早上说「早，说吧」，
 *     深夜说「你半夜才找我」，同一个状态在不同钟点不是一回事
 *   - `thinking` / `compacting`：短命状态（一两秒），只说固定那两句，
 *     来不及换时段
 *   - `idle`：主体的逐字母呼吸动画走 `BAND_WHALE_FRAMES` 原表，**每两轮
 *     呼吸之间**插一句时段闲话（`IDLE_LINES`，只挑深夜 / 夜里 / 傍晚）。
 *     插话不改变呼吸的帧长，只是换掉某一轮的内容——见 `bandWhaleGlyph`。
 *
 * **只有 `working` / `busy` 才加星期句**：那两档讲的是「一天里的工作」，
 * 星期几是它的上下文。其余几档讲的是「这一瞬间在做什么」（在等你、在想、
 * 在压缩），塞一句星期几进去会把它真正要说的话挤掉。
 */
export function bandWhaleFramesOf(
  state: BandWhaleState,
  now: number,
): readonly string[] {
  if (state === 'waiting') return WAITING_LINES[dayPartOf(now)]
  const fixed = BAND_WHALE_FRAMES[state]
  if (state !== 'working' && state !== 'busy') return fixed
  return [weekdayFrame(state, now), ...fixed]
}

/**
 * 状态栏那一格的固定宽度（列）。
 *
 * 从 10 列加宽到 16 列：干活与忙这两档不再吐 `~` 泡泡，改成她随口的一句话。
 * 16 列正好放得下「> 星期一，想躺平」这类句子（2 列鱼头 + `星期X，` 8 列 +
 * 三个汉字 6 列 = 16），一周七天的十四句全都填满，见 `WEEKDAY_FRAMES`。
 * 睡觉那档的 `z` 也跟着能攒到十六个，一路铺满整格。
 *
 * 代价是条子上少 6 列给摘要。摘要本来就靠 `flexGrow` 撑开，窄窗口下先收窄
 * 的是它；这一格宽度固定、不会被压变形，也不会因为摘要变长变短而左右跳。
 * 摘要最长的一档（`5h 100% · 23h59m 后重置`）是 23 列，加上这一格 16 列、
 * 「面板」按钮占 4 列（` 面板 ` = 2 个西文空格 + 2 个汉字）与两个间隔，
 * 总共 45 列——60 列面板的页内还放得下。
 */
export const BAND_WHALE_TEXT_COLS = 16

/**
 * 用量条字符画的重绘节拍：200ms。
 *
 * 必须跟得上**最快的那一帧**：睡觉攒字母每拍 0.2 秒，节拍比它慢就会跳帧，
 * 「一个字母一个字母蹦出来」变成「一次蹦两三个」。干活与忙那两档每帧 2.4 秒，
 * 这条节拍对它们只是多绘几次同一句话——便宜，但换来了睡觉那档的均匀。
 *
 * 代价是每秒 5 次 `$.ui.invalidate`。桌面端上限每秒十次，余量一半；重绘的
 * 是**一行高的小树**，且 `session.usage()` 在引擎侧有缓存（`session.measure`
 * 才推新值），不会每次都打一次 IPC。早先巡游时代那条 1.2 秒的拍子只需
 * 推进一个相位，所以能慢；现在动画本身就在讲「一个个长出来」，只能按帧
 * 刷新。
 */
export const BAND_TICK_MS = 200

/**
 * 每个状态的每一帧停多久（毫秒）。
 *
 * 早先是「每个状态一个常数」，因为那时每帧长度相同、动作是匀速的。睡觉的
 * 呼噜不行：攒字母要慢到看得见「一个一个蹦出来」，呼气要快（`（呼）` 是一下子
 * 出来的），呼气之后还要停一拍再补第二声。匀速播出来像机器在打鼾，不像睡着
 * 的东西。所以改成逐帧给时长。
 *
 * 数组长度必须与 `bandWhaleFramesOf(state, now)` 返回的帧数一致：`idle` 是
 * 原表，`working` / `busy` 是「星期句 + 两句老台词」共三帧，`waiting` 是
 * 时段表里的那一对。测试逐帧采样钉住这一点。
 */
const BAND_FRAME_MS: Readonly<Record<BandWhaleState, readonly number[]>> = {
  // 一轮 4.8 秒：十六个字母各 0.2 秒（看得见逐个长出来），呼 0.6，停 0.5，
  // 再呼 0.5。字母那十六拍若也放慢，整轮会拉到六七秒，读起来像卡住了。
  idle: [
    200, 200, 200, 200, 200, 200, 200, 200,
    200, 200, 200, 200, 200, 200, 200, 200,
    600, 500, 500,
  ],
  // 干活与忙：星期句 + 两句老台词，各停一拍，慢一点才读得完。
  working: [2400, 2400, 2400],
  busy: [2400, 2400, 2400],
  // 想：只活两秒（`THINKING_HOLD_MS`），两帧各停一秒，正好各说一遍。
  thinking: [1000, 1000],
  // 等你：两句话慢一点说。这一档要挂三分钟，4.8 秒一句才不至于像在催命。
  waiting: [4800, 4800],
  // 压缩：两三秒的事，每帧停一拍刚好。
  compacting: [1600, 1600],
}

/**
 * 「刚答完」算「在等你」多久（毫秒）。
 *
 * 引擎没有「用户开始打字」的事件，只有 `turn.complete`。答完之后那一小段
 * 她还看着屏幕的时候，说「等你敲键盘」比立刻缩回去睡觉更贴切；再久一点，
 * 人就真的走开了，该让位给静息的鼾声。三分钟是个折中：去泡杯茶回来
 * 还看得见她在等，离开一小时就不会一直是那句「我在听」。
 */
export const WAITING_HOLD_MS = 3 * 60_000

/**
 * 轮次刚起的头多久算「正在想」（毫秒）。
 *
 * 引擎没有「首个 token 到达」的稳定事件（要拿它得挂 `turn.step` 流式钩子，
 * 为一行字符画挂一条流式管道不值得）。这里用一个**近似窗口**：`turn.start`
 * 之后这段时间里她还在组织语言，之后按「正在跑」算。宁可早一点说「在干活」，
 * 也不要一直卡在「正在想」——读者看到的字比后台的真实阶段更重要。
 *
 * 取两秒：模型的第一个 token 通常在 1～3 秒内到，两秒是这段分布的中位数附近。
 */
export const THINKING_HOLD_MS = 2_000

/**
 * 压缩标记保留多久（毫秒）。
 *
 * `session.compact` 是一次同步调用，钩子在它开始时就被通知，但它没有
 * 「完成」的回调。所以压缩状态靠一个**时间窗**表达：从收到通知起这段时间
 * 里显示 `compacting`，之后自动落回上一档。压缩本身通常一两秒完成，
 * 这里给三秒，留一点尾巴。
 */
export const COMPACTING_HOLD_MS = 3_000

/**
 * 会话此刻处在哪个阶段（毫秒级时间戳驱动）。
 *
 * @param since 最近一次生命周期的分界点（`null` = 从未有过）
 *   - `turn.start` 的时刻：正在跑一轮
 *   - `turn.complete` / `turn.abort` 的时刻：刚结束（可能在「等你」）
 * @param isRunning 引擎是否正在跑一轮
 * @param now       当前时刻，用来在「等你」窗口内判边界、在 `working` /
 *                  `busy` 之间轮换
 */
export function bandWhaleStateOf(
  isRunning: boolean,
  now: number,
  boundaryAt?: number | null,
  isCompacting?: boolean,
): BandWhaleState {
  // 压缩优先：它发生在两轮之间，可能与轮次无关，但读者最该看到这档。
  if (isCompacting) return 'compacting'

  if (isRunning) {
    // 刚起头那两秒算「正在想」——她还没开始说话，只是在心里组织。
    const sinceStart = boundaryAt != null ? now - boundaryAt : now
    if (sinceStart < THINKING_HOLD_MS) return 'thinking'
    // 运行中轮流说两类话：干活时嘀咕摸鱼，忙时念叨吃白饭。
    //
    // **从 `turn.start` 起算，不从绝对时间起算。** 用绝对时间（`now % 周期`）
    // 的话，每轮开头落进哪一档是随机的——有时刚起头就在「猛吃大白饭」，
    // 读者看不出「这一轮刚开始」。改成相对轮次起点后，每一轮都是
    // 「想两秒 → 干活七秒 → 忙七秒 → 干活…」，开头永远是那句星期句。
    //
    // **切换周期必须等于一轮的长度**（三帧 × 2.4 秒 = 7.2 秒），这样状态一换
    // 正好落回帧 0（星期句），帧序与状态永远对齐，不会出现「切到 busy 却从
    // 帧 1 接着播」。周期从帧时长表**推导**，不写字面量——早先这里是硬编码的
    // `7_200`，改帧长时两处必须同时改，漏一处就会悄悄错位。
    const turnPeriod = BAND_FRAME_MS.working.reduce((sum, ms) => sum + ms, 0)
    return Math.floor(sinceStart / turnPeriod) % 2 === 0 ? 'working' : 'busy'
  }

  // 没在跑：刚答完的几分钟里她在等你，之后自己去发呆。
  if (boundaryAt != null && now - boundaryAt < WAITING_HOLD_MS) return 'waiting'
  return 'idle'
}

/**
 * 当前该画哪一帧。
 *
 * 帧序列按 `now` 取模，不记任何状态：面板开在哪一刻，就从序列的哪一刻
 * 接着走；关掉再开不会跳回第一帧。时间本身就是唯一的状态，不记任何
 * 「上次画到哪」的变量。
 *
 * 帧时长可以各不相等（睡觉的呼噜要吸得慢、呼得快），所以先把每帧的时长
 * 累加成一轮的总长，再按 `now % 总长` 落进哪一段来定帧号。全部帧等长时，
 * 这与「`now / step` 再取模」等价。
 *
 * @param state 当前状态
 * @param now   当前时刻（毫秒）
 * @returns 该状态下的第几帧（从 0 起）
 */
export function bandWhaleFrameOf(
  state: BandWhaleState,
  now: number,
  since?: number | null,
): number {
  const durations = BAND_FRAME_MS[state]
  const period = durations.reduce((sum, ms) => sum + ms, 0)
  // 轮次内的状态（想 / 干活 / 忙）从 `since`（`turn.start` 的时刻）起算，
  // 与 `bandWhaleStateOf` 的状态相位同一个基准——否则状态切回 `working` 时，
  // 帧相位可能停在帧 1 上，第一帧该说的星期句就被跳过了。
  //
  // `idle` 的呼吸动画不受轮次影响，始终按绝对时间走。
  const inTurn = state === 'thinking' || state === 'working' || state === 'busy'
  const base = inTurn && since != null ? since : 0
  const elapsed = now - base
  // **负数说明时钟回拨了**（`since` 落在未来），不是「一小时前的某一帧」。
  // 早先这里用 `((x % p) + p) % p` 把负数绕回正区间，结果 `working` 会落到
  // 帧 1——刚切回「干活」就直接说「摸鱼」，把该说的星期句跳过去了，而状态机
  // 那边算出来的是新一轮（`sinceStart < 0 < 7_200`）。两边不同步。
  // 夹到 0 之后，状态与帧相位都从这一轮的起点重新开始。
  const elapsedSafe = elapsed > 0 ? elapsed : 0
  let rest = elapsedSafe % period
  for (let index = 0; index < durations.length; index += 1) {
    rest -= durations[index]!
    if (rest < 0) return index
  }
  return durations.length - 1
}

/**
 * 用量条字符画的文字：当前状态 + 当前时刻对应的一帧。
 *
 * `working` / `busy` 走 `bandWhaleFramesOf`：**帧 0 是当天的星期句，帧 1、2
 * 是固定的老台词**（摸鱼 / 白饭）。其余几档（在等你、在想、在压缩）都是两句
 * 固定的话。
 *
 * ## 静息档的闲话插在哪
 *
 * `idle` 的主线是 4.8 秒一轮的呼吸动画（见 `BAND_FRAME_MS.idle`）。如果
 * 有闲话可说（`IDLE_LINES`），就**每三轮呼吸里的最后一轮、最后那一拍**
 * 换成一句闲话——呼吸照常进行，只是偶尔开口。
 *
 * 试过两个更密的版本，都被否掉了：
 *
 *   - 「偶数轮整轮说话」：屏幕上每 9.2 秒才见一次字，而说话那一整轮看不到
 *     任何呼吸动作，读者会以为卡住了；
 *   - 「每轮最后一拍说话」：每 4.8 秒就一句，静息档变成一直念叨，
 *     反而比纯呼吸更吵。
 *
 * 现在 14.4 秒说一次（三帧呼吸 4.8 秒 × 3）：呼吸是主体，话是点缀。
 *
 * @param since 轮次起点（`turn.start` 的时刻）；`thinking` / `working` / `busy`
 *   都从这一刻起算帧相位，与 `bandWhaleStateOf` 的状态相位对齐。
 */
export function bandWhaleGlyph(
  state: BandWhaleState,
  now: number,
  since?: number | null,
): string {
  if (state === 'idle') {
    const lines = IDLE_LINES[dayPartOf(now)]
    if (lines) {
      const frame = bandWhaleFrameOf(state, now, since)
      const total = BAND_FRAME_MS.idle.length
      const breathPeriod = BAND_FRAME_MS.idle.reduce((s, ms) => s + ms, 0)
      const round = Math.floor(now / breathPeriod)
      // 每三轮里的最后一轮，且只在最后一拍（那声 `呼` 的位置）说话。
      const isSpeakingRound = ((round % 3) + 3) % 3 === 2
      if (isSpeakingRound && frame === total - 1) {
        // 两句轮着说，否则同样的字会一直重复。
        const pairIndex = ((Math.floor(round / 3) % 2) + 2) % 2
        return lines[pairIndex] ?? lines[0]!
      }
    }
  }
  const frames = bandWhaleFramesOf(state, now)
  return frames[bandWhaleFrameOf(state, now, since)] ?? frames[0]!
}

/**
 * 气泡与文字的颜色：沿用原图的配色（#203170 描边、#4858A8 主体蓝）。
 *
 * **所有情绪共用一套配色。** 曾经按情绪换底色：额度过半转暖、夜里再暖一点，
 * 深夜转灰蓝。那套配色让气泡在一天里不断变色，读者每换一个时段都要重新
 * 适应一次，而它表达的既不是数据也不是状态——额度已经在面板里用柱状图与
 * 百分比说清楚了。情绪现在只体现在**台词**上（见 `usage-view.ts` 的
 * `WHALE_TRAITS`），画面保持原图那一份干净的白底蓝字。
 *
 * 保留这个映射而不用一个常量，是为了让 `bubbleSvg` 的签名不必改：将来若
 * 又想给某一档换色，在这里改一行即可。
 */
const TONE: Record<WhaleMood, { bubble: string; stroke: string; ink: string; amount: string; hint: string }> = {
  idle: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  working: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  busy: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  tired: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
  sleep: { bubble: '#FFFFFF', stroke: '#203170', ink: '#203170', amount: '#2F4F8F', hint: '#7C8CB0' },
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 白色对话气泡：大椭圆 + 两颗小泡。
 *
 * **没有尾巴。** 曾经从椭圆左下甩出一条装饰线，它不对应任何数据，还容易
 * 让人以为气泡漏了气。气泡靠位置（在鲸鱼左边）就足以说明「这是谁在说话」。
 *
 * 两颗小泡从大泡右下沿同一条射线（方向约 (0.506, 0.862)）依次变小，指向
 * 鲸鱼——「越来越远、越来越小」才读得出是同一句话的余音。小泡都留在鲸鱼
 * **左侧**（鲸鱼不透明区域从 x≈339 起，见下方 `BUBBLE_SPILL_LIMIT`）。
 *
 * 几何以椭圆中心 (228,112)、rx 146、ry 90 为准。三行文字的基线是
 * 88 / 134 / 172：整体比椭圆中线略高，第三行离下缘留出余量，不再贴着
 * 收窄的口子。
 *
 * @param hero 主角行的下标。那一行用 46px 字号，其余两行用 25px / 21px。
 *   不传时按 1 处理（三行齐全时中间那行天生是视觉重心）。
 */
function bubbleSvg(
  lines: readonly string[],
  mood: WhaleMood,
  hero: 0 | 1 | 2 = 1,
): string {
  const tone = TONE[mood]
  const shown = lines.slice(0, 3)
  // 下标越界时退回中间位——数据页的 `hero` 是枚举，但调用方可能传了
  // 一个已经不存在第三行的页（两行页），夹一次比画错字号好。
  const heroIndex = Math.min(hero, Math.max(0, shown.length - 1))

  const texts = shown
    .map((line, index) => {
      const isAmount = index === heroIndex && shown.length > 1
      const size = isAmount ? 46 : index === 0 ? 25 : 21
      const weight = isAmount ? 800 : 600
      const color = isAmount ? tone.amount : index === 2 ? tone.hint : tone.ink
      // 三行时 88 / 134 / 172；两行时整体下移居中；一行时只居中一行。
      //
      // 2026-10 整体上移 8px（约 1/4 行）：原来的三行贴椭圆中线偏下，视觉上
      // 沉在气泡底部。第三行原本在 188、贴着椭圆下缘，可用宽度只剩 123px；
      // 上移后这一行位置到 172，可用宽度反而放宽到约 198px，小字不再挤在
      // 收窄的口子里。三行都上移，行距不变，读起来仍是一个整体。
      const y = shown.length === 1 ? 110 : shown.length === 2 ? 100 + index * 44 : [88, 134, 172][index]!
      return `<text x="228" y="${y}" text-anchor="middle" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(line)}</text>`
    })
    .join('')

  return (
    `<g>` +
    // 大椭圆。**没有尾巴**：曾经从椭圆左下甩出一条，但它是纯粹的装饰线，
    // 既不对应任何数据，还会让人以为气泡漏气了。气泡靠位置（在鲸鱼左边）
    // 就足以说明「这是谁在说话」。
    `<ellipse cx="228" cy="112" rx="146" ry="90" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="11"/>` +
    // 两颗小泡：从大泡右下沿同一条射线（方向约 (0.506, 0.862)，即朝右下）
    // 依次变小，指向鲸鱼。
    //
    // **左移过 12px。** 原位置 (335,226) / (359,265) 是按注释里那个
    // 「鲸鱼占 x 378~620」摆的，而那是个错误估计——逐像素解析内嵌 PNG
    // 的不透明区域后，鲸鱼实际从 **x≈339** 就开始有像素（显示框从 318
    // 起，图里左边约 18/256 是透明的）。按旧位置摆，第一颗小泡与鲸鱼
    // 重叠 61 平方像素、第二颗 4 平方像素，正好压在脸上。
    // 现在 (323,226) / (347,265)：第一颗右缘 341.5 < 339 附近的最左像素，
    // 第二颗右缘 359 落在鲸鱼中段（那一带鲸鱼左缘在 370 开外）。
    `<ellipse cx="321" cy="226" rx="15" ry="10" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="7"/>` +
    `<ellipse cx="347" cy="265" rx="9" ry="6" fill="${tone.bubble}" stroke="${tone.stroke}" stroke-width="6"/>` +
    texts +
    `</g>`
  )
}

/**
 * 浮动的周期（毫秒）。
 *
 * 只被 `whaleSvg` 的负 `begin` 相位计算用——面板鲸鱼现在不浮动，但那条
 * 机制还在（见 `whaleSvg` 里 `isAnimating` 的说明）。
 */
export const WHALE_FLOAT_PERIOD_MS = 3_600

/**
 * 生成整幅 SVG：左边气泡 + 右下原图鲸鱼。
 *
 * 鲸鱼以 256px 的内嵌 PNG 呈现，`preserveAspectRatio` 保持比例；画布
 * 620×320 与原版 1026×700 的构图比例接近。
 *
 * **鲸鱼的位置不随气泡变化**：无论气泡画不画、画几行，鲸鱼都钉在同一个
 * `translate(318 16)` 上。这样点开 / 收起泡泡时画面不会跳，鲸鱼也不会
 * 因为左边让出空间而挪位——它始终在右下角。
 *
 * ## 浮动动画为什么带负 `begin`
 *
 * 宿主把 `Svg` 的 `source` 当作元素的**数据**：字符串一变，整份 SVG 文档
 * 重建，里面的 SMIL 时间轴随之归零。泡泡每 6 秒翻一页，`source` 就换一次，
 * 浮动于是每次都从「最上面那一帧」重新开始——看起来就是「卡一下再从头浮」。
 *
 * 修法是给动画一个**负的 `begin`**，把它拨到「已经播了多久」的位置：新文档
 * 一出现，SMIL 直接算到当前相位，而不是从头播。`begin="-2.7s"` 表示这条
 * 动画在文档时间 −2.7 秒时就已经开始。
 *
 * 因此 `whaleSvg` 需要知道**当前时刻**与**动画自己的零点**。零点必须由调用
 * 方固定住（模块加载时记一次），不能每帧重算——否则相位会跟着墙钟乱跳。
 *
 * @param mood 情绪，决定气泡配色
 * @param lines 气泡里最多三行文字
 * @param options `isAnimating` 为真时鲸鱼轻微上下浮动（SMIL，无需脚本）；
 *   `isBubbleOpen` 为假时整块气泡（含小泡）不画，只留鲸鱼。
 *   泡泡现在是常驻的，这个开关只为「画一张没有气泡的图」保留（导出、测试）。
 *   `now` 与 `epoch` 用来算负 `begin`：不传就按「刚好从头开始」处理。
 *   `hero` 是主角行的下标，那一行用 46px，其余用 25 / 21px。
 */
export function whaleSvg(
  mood: WhaleMood,
  lines: readonly string[],
  options: {
    isAnimating?: boolean
    isCompact?: boolean
    isBubbleOpen?: boolean
    /** 主角行的下标（0/1/2）。不传按 1 处理。 */
    hero?: 0 | 1 | 2
    /** 当前时刻（毫秒）。与 `epoch` 一起决定动画相位。 */
    now?: number
    /** 动画的零点（毫秒）。应当固定，不随重绘变化。 */
    epoch?: number
  } = {},
): string {
  const isAnimating = options.isAnimating ?? true
  const isBubbleOpen = options.isBubbleOpen ?? true
  // 常驻条很小（显示约 46×24 像素），用小图省内存；面板用大图保证清晰。
  const asset = options.isCompact ? WHALE_ASSETS.small : WHALE_ASSETS.large
  // 浮动：整体上下 ±4px。SMIL 在无脚本沙箱里也能跑。
  //
  // `begin` 取**负值**：把动画拨到「已经播了 phase 毫秒」的位置。宿主重绘
  // 换一份新文档时，SMIL 从 `begin` 起算，于是接着原来的相位播，不再归零。
  // 没有 `now`/`epoch` 时 phase 为 0，行为与以前一致（从头开始）。
  const elapsed = options.now !== undefined && options.epoch !== undefined
    ? Math.max(0, options.now - options.epoch)
    : 0
  const phase = elapsed % WHALE_FLOAT_PERIOD_MS
  const begin = phase > 0 ? ` begin="-${(phase / 1000).toFixed(3)}s"` : ''
  const float = isAnimating
    ? `<animateTransform attributeName="transform" type="translate" values="0 0; 0 -4; 0 0" dur="3.6s" repeatCount="indefinite" additive="sum"${begin}/>`
    : ''

  return (
    // ## 根元素：像素尺寸，不加百分比
    //
    // `Svg` 的 `width`/`height` props 决定显示框，`viewBox` 负责把 620×320
    // 缩放到那个框里。根元素自己也写像素尺寸，与 `viewBox` 一致——这样它
    // 作为独立文件打开时也有确定的固有尺寸。
    //
    // **不要改成 `width="100%" height="100%"`**：`height="100%"` 是相对父级
    // 解析的，在没有确定高度的容器里（比如 sandbox iframe 的 `body`，
    // 高度是 auto）百分比失去基准、塌成 0，整幅图都不画。实测面板里会变成
    // 一块纯白。
    //
    // 也不要依赖 `isInteractive` 那条沙箱路径来跑 SMIL：那条路径画不出内嵌
    // 的 `<image>` 位图，鲸鱼会整个消失（只剩矢量气泡）。详见 `register.tsx`
    // 里 `<Svg>` 那一处的说明。
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WHALE_CANVAS.width} ${WHALE_CANVAS.height}" width="${WHALE_CANVAS.width}" height="${WHALE_CANVAS.height}" preserveAspectRatio="xMidYMid meet" role="img">` +
    (isBubbleOpen ? bubbleSvg(lines, mood, options.hero ?? 1) : '') +
    // 鲸鱼：原图右下角贴边，尺寸 300×300。位置与气泡是否展开无关。
    `<g transform="translate(${WHALE_GROUP_X} ${WHALE_GROUP_Y})">` +
    float +
    `<image x="0" y="0" width="${WHALE_IMAGE_W}" height="${WHALE_IMAGE_W}" preserveAspectRatio="xMaxYMax meet" href="data:image/png;base64,${asset}"/>` +
    `</g>` +
    `</svg>`
  )
}
