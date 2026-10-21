# 第三方素材署名

## 小鲸鱼原图

`hooks/whale-asset.ts` 内嵌的鲸鱼图片来自 **DeepSeek-Balance-Whale-Widget**：

- 仓库：https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
- 文件：`assets/DSniang1.png`（610×610 RGBA PNG）
- 作者：MeteorNOX 及其贡献者
- 许可：MIT

本项目按 MIT 协议使用该素材，未作美术改动。为了满足 Claude Code 桌面端
`Svg` 元素的 `source` 131072 字符上限，仅按显示尺寸做了两种分辨率的重采样
（160×160 与 256×256），未做色彩量化，颜色与原图一致。

原作者的完整许可声明：

```
MIT License

Copyright (c) MeteorNOX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 气泡

白色对话气泡（大椭圆 + 两颗小泡）的构图比例参考同一仓库的
`whale-widget-prompt.md`（MIT），由本项目用 SVG 重新绘制，文字内容为
Claude 用量数据。原稿里从椭圆左下甩出的装饰线没有保留——它不对应任何数据，
还容易让人以为气泡漏了气。
