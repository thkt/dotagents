import { expect, test } from 'bun:test';
import { canRetry } from '../src/retry.ts';
test('現在の再試行境界', () => {
  expect(canRetry(2)).toBe(true);
  expect(canRetry(3)).toBe(false);
});
