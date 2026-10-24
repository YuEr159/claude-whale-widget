import { test, expect } from 'claude-code/testing'
import { BAND_SWIM_STEP_COLS, BAND_SWIM_STEP_MS } from '../hooks/whale-art'
test('条子巡游真的比面板快：一步 1.2 秒、2 列', () => {
  expect(BAND_SWIM_STEP_MS).toBe(1_200)
  expect(BAND_SWIM_STEP_COLS).toBe(2)
})
