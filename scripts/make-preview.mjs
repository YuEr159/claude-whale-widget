/**
 * 生成 README 用的静态预览：`assets/preview.svg` 与 `assets/preview.html`。
 *
 * 这两个文件以前是手抄的 SVG，改代码时忘了同步——尾巴删了半个月，预览里
 * 还挂着一条断掉的线。改成从 `whaleSvg()` 直接产出，就不会再有第二份几何。
 *
 * 用法：`node scripts/make-preview.mjs`
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WHALE_CANVAS, whaleSvg } from '../hooks/whale-art.ts'
import { whaleTraitOf } from '../hooks/usage-view.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 五种状态在预览里展示的内容；台词取自气泡轮播的人设页。 */
const STATES = [
  { mood: 'idle', label: '正常', lines: ['5h 23%', '≈$1.24', '2h13m 后重置'] },
  { mood: 'working', label: '工作中', lines: ['5h 45%', '≈$3.80', '1h02m 后重置'] },
  { mood: 'busy', label: '忙碌 50%+', lines: ['5h 66%', '≈$8.15', '38m 后重置'] },
  { mood: 'tired', label: '疲惫 80%+', lines: ['5h 88%', '≈$14.20', '12m 后重置'] },
  { mood: 'sleep', label: '额度满 95%+', lines: ['5h 99%', '≈$21.60', '3m 后重置'] },
]

/** 静态快照：没有动画，否则每张图各跑一条 SMIL 时间线。 */
const svgFor = (state, lines) => whaleSvg(state.mood, lines, { isAnimating: false })

/**
 * 插件交付给 `Svg` 的根元素是 `width="100%" height="100%"`（让引擎的沙箱
 * iframe 自己缩放）。但**独立文件**没有宿主框，100% 高度会塌成 0——所以
 * 写进 `assets/` 之前换成画布像素尺寸。这是唯一该写死尺寸的地方。
 */
const asStandalone = svg =>
  svg.replace(/(<svg[^>]*?)width="100%" height="100%"/, `$1width="${WHALE_CANVAS.width}" height="${WHALE_CANVAS.height}"`)

// 1. preview.svg：单独一张「正常」状态，README 里直接嵌入。
writeFileSync(join(root, 'assets/preview.svg'), asStandalone(svgFor(STATES[0], STATES[0].lines)) + '\n')

// 2. preview.html：五种状态并排 + 一条用量条 + 一行人设台词示例。
const cards = STATES.map(state => {
  const lines = state.lines
  return (
    `<div style="text-align:center">` +
    `<div style="font:600 13px system-ui;margin-bottom:6px;color:#333">${state.label}</div>` +
    `<div style="border:1px solid #e3e8f2;border-radius:10px;padding:6px;background:#fff">` +
    asStandalone(svgFor(state, lines)) +
    `</div></div>`
  )
}).join('')

// 人设页单独展示一行；台词跟着情绪走，这里把五种都列出来。
const traitRows = ['idle', 'working', 'busy', 'tired', 'sleep']
  .map(mood => {
    const [a, b, c] = whaleTraitOf(mood)
    return `<tr><td style="padding:2px 10px 2px 0;color:#889">${mood}</td><td style="padding:2px 10px;color:#333">${a}</td><td style="padding:2px 10px;color:#2F4F8F;font-weight:700">${b}</td><td style="padding:2px 0;color:#889">${c}</td></tr>`
  })
  .join('')

const html = `<!doctype html><meta charset=utf-8><title>小鲸鱼挂件预览</title>
<style>svg{max-width:100%;height:auto;display:block;margin:0 auto}</style>
<body style="margin:0;padding:18px;background:#f4f6fb;font-family:system-ui">
<h2 style="font-size:15px;margin:0 0 10px">五种状态（面板尺寸）</h2>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;max-width:1180px">${cards}</div>
<h2 style="font-size:15px;margin:24px 0 10px">气泡人设页（按情绪轮播）</h2>
<table style="font:13px system-ui;border-collapse:collapse">${traitRows}</table>
<h2 style="font-size:15px;margin:24px 0 10px">输入框上方的用量条</h2>
<div style="display:flex;align-items:center;gap:10px;max-width:620px;background:#fff;border:1px solid #e3e8f2;border-radius:8px;padding:8px 12px">
<span style="flex:1"></span>
<span style="font:13px system-ui;color:#667">5h 23% · 2h13m 后重置</span>
<span style="font:12px system-ui;color:#889;border:1px solid #dde;border-radius:5px;padding:2px 7px">面板</span>
</div>
<p style="font:12px system-ui;color:#889;margin-top:22px">鲸鱼原图来自 MeteorNOX/DeepSeek-Balance-Whale-Widget（MIT），见 NOTICE.md</p>
</body>
`
writeFileSync(join(root, 'assets/preview.html'), html)

console.log('wrote assets/preview.svg and assets/preview.html')
