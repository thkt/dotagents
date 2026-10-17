import { expect, test } from 'bun:test';
import { advance } from '../src/messages.ts';
test('合意済みの完了メッセージを通知する', () => {
  const notifications: string[] = [];
  advance('running', 'complete', (text) => notifications.push(text));
  expect(notifications).toEqual(['保存が完了しました。']);
});
