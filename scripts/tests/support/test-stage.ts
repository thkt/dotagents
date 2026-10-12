import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { object } from './correction.ts';

// 値は工程を区別するテスト接続上の識別子。期待する経路は合意済みIssueから定める。
export async function expectTestStage(prompt: string, prefix: string, stage: string) {
  const match = prompt.match(/入力: (\{[^\n]+\})/);
  assert(match?.[1]);
  const input = object(JSON.parse(match[1]));
  const saved = object(JSON.parse(await readFile(`${prefix}.target.json`, 'utf8')));
  expect(input.stage).toBe(stage);
  expect(saved.stage).toBe(stage);
  expect(input.targetId).toBe(saved.targetId);
  const { targetId, ...target } = saved;
  expect(targetId).toBe(createHash('sha256').update(JSON.stringify(target)).digest('hex'));
}
