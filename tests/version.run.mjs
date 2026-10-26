/**
 * 版本号递增：末位进位与非法形状的拒绝。
 *
 * 这不是个"随便写写"的工具函数——它每次提交都会跑，一旦进位算错，仓库里
 * 的版本号就会停在原地或跳到一个奇怪的值，而 `plugin update` 又恰好靠它
 * 判断要不要重新拷贝文件。算错的后果是「改了代码但插件没更新」，且很难
 * 从现象倒推回原因。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bumpPatch } from '../scripts/bump-version.mjs'

test('版本递增：末位 +1，到 100 进位', () => {
  const cases = [
    ['1.0.0', '1.0.1'],
    ['1.0.1', '1.0.2'],
    ['1.0.98', '1.0.99'],
    // 99 是最后一个两位补丁号，再加一进到次位。
    ['1.0.99', '1.1.0'],
    ['1.1.99', '1.2.0'],
    ['2.3.4', '2.3.5'],
    // 次位到 100 也进位到主位。
    ['1.99.99', '2.0.0'],
    ['9.99.99', '10.0.0'],
  ]
  for (const [input, want] of cases) {
    assert.equal(bumpPatch(input), want, `${input} 应当递增到 ${want}`)
  }
})

test('版本递增：形状不对时抛错，绝不猜一个出来', () => {
  // 猜错的版本号比报错更糟：`plugin update` 会拿它去比较，得出的结论
  // 可能是"没有更新"，而人完全看不出哪里出了问题。
  for (const bad of ['1.0', 'v1.0.0', '1.0.0-beta', '1', '', '   ', null, undefined, '1.0.0.0', 'a.b.c']) {
    assert.throws(() => bumpPatch(bad), /版本号形状不对/, `${JSON.stringify(bad)} 应当被拒绝`)
  }
})

test('版本递增：前后空白不算错误，照常递增', () => {
  // `plugin.json` 可能被手工编辑过、末尾带了空格；这不影响语义。
  assert.equal(bumpPatch(' 1.2.3 '), '1.2.4')
  assert.equal(bumpPatch('1.2.3\n'), '1.2.4')
})

test('版本递增：每次只动一个位置', () => {
  // 从 `1.0.0` 走 99 步到 `1.0.99`，第 100 步才进位到 `1.1.0`——
  // 进位只发生在该发生的时候，不会每几次就漏跳一格。
  let version = '1.0.0'
  const seen = new Set([version])
  for (let i = 0; i < 99; i += 1) {
    version = bumpPatch(version)
    seen.add(version)
  }
  assert.equal(version, '1.0.99', `99 步应当停在 1.0.99，实际 ${version}`)
  assert.equal(bumpPatch(version), '1.1.0', '第 100 步进位到次日')
  // 途中不该重复：重复意味着某一步原地踏步，版本号就失去「每次提交都变」的意义。
  assert.equal(seen.size, 100, '99 步 + 起点共 100 个互不相同的版本号')
})
