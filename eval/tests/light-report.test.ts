import { expect, test } from 'bun:test';
import { readUsage, assessTrial } from '../report.ts';

const reference = { file: 'actor.stdout', sha256: 'a'.repeat(64), lines: [1, 2] };
const judgment = {
  trial: 'before-storage-fields',
  selection: 'scoping',
  bodyReads: [reference],
  applications: [reference],
  completeTrace: [],
  outcome: 'fulfilled',
  evidence: [reference],
  reason: '固定した要求と証拠に基づく合成裁定。実モデルの成果ではない。',
};
const record = {
  trial: 'before-storage-fields',
  side: 'before',
  case: 'storage-fields',
  expected: 'scoping',
  execution: 'completed',
  launched: true,
  elapsedMs: 12,
  executionMode: 'native-chatgpt',
  reason: null,
  usage: { totals: null, completedTurns: 0, incompleteLines: 0, scope: '取得不能な合成usage' },
  safety: { boundaryVerified: true, processesStopped: true },
};

function assess(value: unknown, assessment: unknown = judgment): unknown {
  // 新しい保存契約への接続。旧APIの型をcastで弱めず、実際の裁定関数を通す。
  return Reflect.apply(assessTrial, undefined, [value, assessment]);
}

test('ネイティブの正常な境界・終了証拠で裁定でき、Dockerの架空確認を要求しない', () => {
  expect(assess(record)).toMatchObject({
    outcome: 'fulfilled',
    selection: 'scoping',
    correct: true,
  });
});

for (const [name, changes] of [
  ['境界未確認', { safety: { boundaryVerified: false, processesStopped: true } }],
  ['終了不明', { safety: { boundaryVerified: true, processesStopped: false } }],
  ['未実行', { launched: false, execution: 'unevaluated' }],
  ['CLI失敗', { execution: 'failed' }],
  ['時間切れ', { execution: 'timeout' }],
] as const) {
  test(`ネイティブ裁定は${name}を要求充足へ変換しない`, () => {
    // 正常対照が同じ経路に到達しなければ、任意の例外を狙った拒否と数えない。
    expect(assess(record)).toMatchObject({ outcome: 'fulfilled' });
    expect(() => assess({ ...record, ...changes })).toThrow();
  });
}

test('ネイティブ実行完了と独立裁定なしの要求充足を分ける', () => {
  expect(Reflect.apply(assessTrial, undefined, [record])).toMatchObject({
    outcome: 'indeterminate',
  });
});

test('APIの正常なDocker証拠をネイティブ実行へ流用しない', () => {
  const safety = { containersRemoved: true, networkRemoved: true };
  expect(assess(record)).toMatchObject({ outcome: 'fulfilled' });
  expect(() => assess({ ...record, safety })).toThrow();
});

test('usage leaves fractional and overflowing token counts unaccounted', () => {
  const event = (input_tokens: number) =>
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens, cached_input_tokens: 0, output_tokens: 0 },
    });
  expect(readUsage([event(10), event(0.5), event(Number.MAX_SAFE_INTEGER)])).toMatchObject({
    totals: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0 },
    completedTurns: 1,
    incompleteLines: 2,
  });
});

test('JSONL欠落・不正usageを0へ変換せず取得済み分と不明を区別する', () => {
  expect(readUsage(['broken json']).totals).toBeNull();
  expect(readUsage([]).totals).toBeNull();
  expect(
    readUsage([
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}',
      'partial',
    ]),
  ).toMatchObject({
    totals: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
    incompleteLines: 1,
  });
});
test('行動の自己申告は本文読取り・適用・完全traceの証拠を代替しない', () => {
  expect(assess(record)).toMatchObject({ outcome: 'fulfilled' });
  for (const changes of [
    { bodyReads: [] },
    { applications: [] },
    { selection: 'none', completeTrace: [] },
    { evidence: [] },
  ]) {
    expect(() => assess(record, { ...judgment, ...changes })).toThrow();
  }
  expect(assess({ ...record, expected: 'boundary' })).toMatchObject({ correct: null });
});
