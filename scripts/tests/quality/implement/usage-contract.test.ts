import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReviewerUsage } from '../../../implement/review-probe.ts';
import { readUsageEvents } from '../../../implement/usage-events.ts';

const valid = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 };
const eventStream = (values: unknown[]) =>
  [
    { type: 'thread.started', thread_id: 'usage-contract' },
    ...values.flatMap((usage) => [{ type: 'turn.started' }, { type: 'turn.completed', usage }]),
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');

async function reviewerUsage(raw: string) {
  const root = await mkdtemp(join(tmpdir(), 'usage-contract-'));
  try {
    const dir = join(root, 'review-codex-contract');
    await mkdir(dir);
    await writeFile(join(dir, 'events.jsonl'), raw);
    return await readReviewerUsage(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const usage of [
  valid,
  { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
  { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 },
  { input_tokens: 10, cached_input_tokens: 10, output_tokens: 3 },
  {
    input_tokens: Number.MAX_SAFE_INTEGER,
    cached_input_tokens: Number.MAX_SAFE_INTEGER,
    output_tokens: Number.MAX_SAFE_INTEGER,
  },
]) {
  test(`通常集計とレビュー試行は有効な使用量を保持する: ${JSON.stringify(usage)}`, async () => {
    const raw = eventStream([usage]);
    const observed = readUsageEvents(raw);
    expect(observed.problems).toEqual([]);
    expect(observed.observed).toEqual(usage);
    expect(observed.turns).toHaveLength(1);
    expect(await reviewerUsage(raw)).toMatchObject({ totals: usage, completedTurns: 1 });
  });
}

for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    test(`両取得経路は非負の安全な整数以外の使用量を拒否する: ${key}=${value}`, async () => {
      const raw = eventStream([{ ...valid, [key]: value }]);
      const observed = readUsageEvents(raw);
      expect(observed.observed).toBeNull();
      expect(observed.problems.join('\n')).toContain('Missing or invalid turn usage');
      await assert.rejects(reviewerUsage(raw), /Incomplete model usage/);
    });
  }
}

for (const prior of [[], [{ input_tokens: 100, cached_input_tokens: 0, output_tokens: 0 }]]) {
  test(`キャッシュ入力の内数制約は各turnに適用する: 先行turn=${prior.length}`, async () => {
    const raw = eventStream([...prior, { ...valid, cached_input_tokens: 11 }]);
    const observed = readUsageEvents(raw);
    expect(observed.problems.join('\n')).toContain('Missing or invalid turn usage');
    expect(observed.turns).toHaveLength(prior.length);
    expect(observed.observed).toEqual(prior[0] ?? null);
    await assert.rejects(reviewerUsage(raw), /Incomplete model usage/);
  });
}
