import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { runLightSequence } from '../light.ts';
import { isRecord } from '../../scripts/shared/values.ts';

// 接続はホスト提示のcallback契約。停止・分母・計時の期待値は#405から定める。
const order = [
  'before-storage-fields',
  'after-storage-fields',
  'after-completion-message',
  'before-completion-message',
];
const config = {
  trialOrder: order,
  cases: ['storage-fields', 'completion-message'],
  maxTrials: 4,
  stage: 1,
  caseTimeMs: 600000,
  totalTimeMs: 2400000,
};

function record(trial: string, changes: Record<string, unknown> = {}) {
  return {
    trial,
    side: trial.startsWith('before-') ? 'before' : 'after',
    case: trial.replace(/^(before|after)-/, ''),
    expected: trial.endsWith('storage-fields') ? 'scoping' : 'implement',
    executionMode: 'native-chatgpt',
    launched: true,
    execution: 'completed',
    elapsedMs: 10,
    reason: null,
    safety: { boundaryVerified: true, processesStopped: true },
    usage: { totals: null, completedTurns: 0, incompleteLines: 0, scope: '合成の未取得usage' },
    ...changes,
  };
}

async function sequence(
  perform: (trial: string, deadline: number) => Promise<unknown>,
  clock: () => number = () => 1000,
  limits: Record<string, number> = {},
) {
  const value: unknown = await Reflect.apply(runLightSequence, undefined, [
    { ...config, ...limits },
    perform,
    clock,
  ]);
  assert(isRecord(value) && Array.isArray(value.records));
  const records = value.records.filter(isRecord);
  assert.equal(records.length, value.records.length);
  expect(records.map((item) => item.trial)).toEqual(order);
  return { error: value.error, elapsedMs: value.elapsedMs, records };
}

test('CLI完了の正常対照は4試行を固定順に各1回行う', async () => {
  const calls: string[] = [];
  const result = await sequence(async (trial, deadline) => {
    calls.push(trial);
    expect(deadline).toBe(601000);
    return record(trial);
  });
  expect(calls).toEqual(order);
  expect(result.error).toBeNull();
  expect(result.records.every((item) => item.launched && item.execution === 'completed')).toBe(
    true,
  );
  expect(JSON.stringify(result)).not.toContain('containersRemoved');
});

for (const [name, changes] of [
  ['CLI失敗', { execution: 'failed', reason: 'synthetic CLI failure' }],
  ['認証エラー', { execution: 'failed', reason: 'synthetic authentication error' }],
  ['利用枠エラー', { execution: 'failed', reason: 'synthetic usage limit' }],
  ['時間切れ', { execution: 'timeout', reason: 'timeout' }],
  ['記録容量超過', { execution: 'failed', reason: 'synthetic log limit' }],
  ['境界不成立', { safety: { boundaryVerified: false, processesStopped: true } }],
  ['後始末不明', { safety: { boundaryVerified: true, processesStopped: false } }],
] as const) {
  test(`${name}の後は後続起動0で予定数と直前の記録を保つ`, async () => {
    const calls: string[] = [];
    const result = await sequence(async (trial) => {
      calls.push(trial);
      return record(trial, calls.length === 2 ? changes : {});
    });
    expect(calls).toEqual(order.slice(0, 2));
    expect(result.error).toBeTruthy();
    expect(result.records[0]).toMatchObject(record(order[0] ?? ''));
    expect(result.records[1]).toMatchObject(changes);
    for (const item of result.records.slice(2)) {
      expect(item).toMatchObject({ launched: false, execution: 'unevaluated' });
      expect(item.usage === null || (isRecord(item.usage) && item.usage.totals === null)).toBe(
        true,
      );
    }
  });
}

test('保存失敗の例外でも直前記録を保ち後続を起動しない', async () => {
  const calls: string[] = [];
  const result = await sequence(async (trial) => {
    calls.push(trial);
    if (calls.length === 2) {
      throw new Error('SYNTHETIC_SAVE_FAILURE');
    }
    return record(trial);
  });
  expect(calls).toEqual(order.slice(0, 2));
  expect(String(result.error)).toContain('SYNTHETIC_SAVE_FAILURE');
  expect(result.records[0]).toMatchObject(record(order[0] ?? ''));
  expect(result.records.slice(2).every((item) => !item.launched)).toBe(true);
});

test('準備を含む全体時間の残りで次の期限を縮め、枠消費後は起動しない', async () => {
  let now = 1000;
  const deadlines: number[] = [];
  const calls: string[] = [];
  const result = await sequence(
    async (trial, deadline) => {
      calls.push(trial);
      deadlines.push(deadline);
      // 壁時計の速度ではなく、準備・操作を含む消費と停止の順序を観測する。
      now += calls.length === 1 ? 70 : 30;
      return record(trial);
    },
    () => now,
    { caseTimeMs: 80, totalTimeMs: 100 },
  );
  expect(calls).toEqual(order.slice(0, 2));
  expect(deadlines).toEqual([1080, 1100]);
  expect(result.elapsedMs).toBe(100);
  expect(result.error).toBeTruthy();
  expect(result.records.slice(2).every((item) => !item.launched)).toBe(true);
});
