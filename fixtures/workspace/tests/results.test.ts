import { expect, test } from 'bun:test';
import { saveResult } from '../src/results.ts';
const values = [
    [{ kind: 'result', status: 'success' }, '成功結果には成果物参照が必要です。'],
    [{ kind: 'result', status: 'failure' }, '失敗結果には理由が必要です。'],
    [{ kind: 'result', status: 'other' }, '結果の状態が不正です。'],
] as const;
for (const [value, message] of values) {
  test(`合意済みの不足理由を診断する: ${value.status}`, () => {
    const saved: unknown[] = [];
    expect(saveResult(value, (item) => saved.push(item))).toBe(message);
    expect(saved).toEqual([]);
  });
}
