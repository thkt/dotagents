import { expect, test } from 'bun:test';
import { advance, type State } from '../src/messages.ts';
test('状態遷移と通知条件を保つ', () => {
  for (const state of ['queued', 'running', 'completed', 'failed'] as State[]) {
    for (const event of ['start', 'complete', 'fail', 'unknown']) {
      const notifications: string[] = [];
      const next = advance(state, event, (text) => notifications.push(text));
      const expected = state === 'queued' && event === 'start' ? 'running'
        : state === 'running' && event === 'complete' ? 'completed'
        : state === 'running' && event === 'fail' ? 'failed' : state;
      expect(next).toBe(expected);
      expect(notifications).toHaveLength(state === 'running' && event === 'complete' ? 1 : 0);
    }
  }
});
