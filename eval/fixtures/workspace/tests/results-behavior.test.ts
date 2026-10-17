import { expect, test } from 'bun:test';
import { saveResult } from '../src/results.ts';
test('通常の保存経路で正常・違反・適用外を区別する', () => {
  for (const value of [
    { kind: 'result', status: 'success', artifact: 'output.txt' },
    { kind: 'result', status: 'failure', reason: '容量不足' },
    { kind: 'event', status: 'success' },
  ]) {
    const saved: unknown[] = [];
    expect(saveResult(value, (item) => saved.push(item))).toBeNull();
    expect(saved).toEqual([value]);
    expect(saved[0]).toBe(value);
  }
  for (const value of [
    { kind: 'result', status: 'success', reason: 'artifactの代用不可' },
    { kind: 'result', status: 'success', artifact: ' ' },
    { kind: 'result', status: 'failure', artifact: 'reasonの代用不可' },
    { kind: 'result', status: 'failure', reason: 1 },
    { kind: 'result', status: 'other', artifact: 'file', reason: 'text' },
    { kind: 'other' }, null,
  ]) {
    const saved: unknown[] = [];
    expect(typeof saveResult(value, (item) => saved.push(item))).toBe('string');
    expect(saved).toEqual([]);
  }
});
