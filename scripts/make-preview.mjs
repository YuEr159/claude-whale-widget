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
import { whaleSvg } from '../hooks/whale-art.ts'
import { whaleTraitOf } from '../hooks/usage-view.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 五种情绪在预览里展示的内容与标签。
 *
 * **标签按钟点写，不按额度。** 情绪早就改成随本地钟点走了（见
 * `whale-art.ts` 的 `DAY_SCHEDULE`），这里却还挂着「忙碌 50%+」「额度满
 * 95%+」——那是旧模型的触发条件。预览图是对外的门面，展示的必须是读者
 * 真会看到的那一套。
 *
 * `lines` 用**数据页**的样子（额度页），不是人设页：面板里大多数时候翻到的
 * 就是它。人设台词在下面单独列一张表。
 */
const STATES = [
  { mood: 'idle', label: '06:00–08:59 早晨', lines: ['5 小时 · 7 天 61%', '23%', '2h13m 后重置'] },
  { mood: 'working', label: '09:00–11:59 上午', lines: ['5 小时 · 7 天 61%', '45%', '1h02m 后重置'] },
  { mood: 'busy', label: '12:00–13:59 午饭', lines: ['5 小时 · 7 天 61%', '66%', '38m 后重置'] },
  { mood: 'tired', label: '21:00–23:59 夜里', lines: ['5 小时 · 7 天 61%', '88%', '12m 后重置'] },
  { mood: 'sleep', label: '00:00–05:59 深夜', lines: ['5 小时 · 7 天 61%', '99%', '3m 后重置'] },
]

/**
 * 静态快照：没有动画，否则每张图各跑一条 SMIL 时间线。
 * 根元素本身就是像素尺寸，独立文件打开也有确定的固有尺寸，不必改写。
 */
const svgFor = (state, lines) => whaleSvg(state.mood, lines, { isAnimating: false })

// 1. preview.svg：单独一张「正常」状态，README 里直接嵌入。
writeFileSync(join(root, 'assets/preview.svg'), svgFor(STATES[0], STATES[0].lines) + '\n')

// 2. preview.html：五种状态并排 + 一条用量条 + 一行人设台词示例。
const cards = STATES.map(state => {
  const lines = state.lines
  return (
    `<div style="text-align:center">` +
    `<div style="font:600 13px system-ui;margin-bottom:6px;color:#333">${state.label}</div>` +
    `<div style="border:1px solid #e3e8f2;border-radius:10px;padding:6px;background:#fff">` +
    svgFor(state, lines) +
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
