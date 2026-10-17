import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { evalCase, evalConfig, validatePlan } from '../data.ts';
import { instructionFiles } from './trusted-inputs.ts';
import { budgetConfig } from './budget-contract.ts';

const base = {
  repository: 'thkt/dotagents',
  issue: 'https://github.com/thkt/dotagents/issues/393',
  before: 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092',
  after: '6181233d17a29c711a84f20549f78507c5c3e5fb',
  corpusCommit: '0c7316253a9768844eb1c224961e00be52dcdcf2',
  workspaceCommit: '0c7316253a9768844eb1c224961e00be52dcdcf2',
  workspaceFiles: ['eval/fixtures/workspace/README.md'],
  instructionFiles,
  image: `public/eval@sha256:${'d'.repeat(64)}`,
  imageReview: '公開ツールだけを含む合成設定。実imageの採用証拠ではありません。',
  model: 'gpt-6.1-sol',
  reasoning: 'medium',
  cliVersion: 'codex-cli synthetic',
  bunVersion: '1.4.3',
  gitVersion: 'git synthetic',
  caseTimeMs: 600000,
  totalTimeMs: 9600000,
  maxModelRequestsPerCase: 20,
  maxOutputTokens: 8000,
  outputDirectory: '/tmp/synthetic-budget-plan',
  disclosure: {
    inputs: 'reviewed-public-committed-files-only',
    raw: 'local-only',
    summary: 'manual-issue-or-pr',
  },
};

async function corpus() {
  const value: unknown = JSON.parse(
    await readFile(join(import.meta.dir, '../corpus/cases.json'), 'utf8'),
  );
  return evalCase.array().parse(value);
}

test('旧5課題は金額条件なしの従来の計画を維持する', async () => {
  const all = await corpus();
  const cases = ['requirements', 'implementation', 'question', 'review', 'ambiguous'];
  const config = evalConfig.parse({ ...base, cases, maxTrials: 10 });
  expect(validatePlan(config, all).map((item) => item.id)).toEqual(cases);
});

test('#393の8課題は金額条件・profileが不足したまま開始できない', async () => {
  const all = await corpus();
  const cases = [
    'storage-fields',
    'completion-message',
    'retry-limit',
    'guide-link',
    'work-area',
    'cli-description',
    'history-record',
    'save-diagnostics',
  ];
  const trialOrder = cases.flatMap((id, index) =>
    (index % 2 === 0 ? ['before', 'after'] : ['after', 'before']).map((side) => `${side}-${id}`),
  );
  // 課題・A/B・時間・要求数は既存の有効な条件。欠けるのは今回必須の金額条件だけ。
  expect(() => {
    const config = evalConfig.parse({ ...base, cases, maxTrials: 16, trialOrder });
    validatePlan(config, all);
  }).toThrow();
});

// 台帳単体の拒否だけでは、設定入口で条件を読み捨てる不具合を検出できない。
// 値・単位・profileの接続形式は前回資産を維持し、許否はIssueから定める。
const selectionCases = ['requirements', 'implementation', 'question', 'review', 'ambiguous'];
const priced = { ...base, cases: selectionCases, maxTrials: 10, budget: budgetConfig };

test('明示した固定金額条件は設定入口で失わず保持する', async () => {
  const config = evalConfig.parse(priced);
  expect(config).toMatchObject({ budget: budgetConfig });
  expect(validatePlan(config, await corpus()).map((item) => item.id)).toEqual(selectionCases);
});

for (const [key, value] of [
  ['currency', 'JPY'],
  ['unit', 'cents'],
  ['budget', NaN],
  ['stop', Infinity],
  ['notify', 0.5],
  ['stop', budgetConfig.budget + 1],
  ['notify', budgetConfig.stop + 1],
  ['profile', 'unknown-standard'],
  ['profileHash', '0'.repeat(64)],
  ['profileHash', undefined],
] as const) {
  test(`設定入口で不正な金額条件${key}=${String(value)}を拒否する`, async () => {
    const all = await corpus();
    // 同じ入口の正常対照が先に必要。未知のbudgetキー拒否で負の対照を通さない。
    validatePlan(evalConfig.parse(priced), all);
    expect(() =>
      validatePlan(evalConfig.parse({ ...priced, budget: { ...budgetConfig, [key]: value } }), all),
    ).toThrow();
  });
}

for (const [key, value] of [
  ['model', 'unknown-model'],
  ['reasoning', 'high'],
  ['maxOutputTokens', 8001],
] as const) {
  test(`固定profileと異なる${key}へ同じ料金保証を流用しない`, async () => {
    const all = await corpus();
    validatePlan(evalConfig.parse(priced), all);
    expect(() => validatePlan(evalConfig.parse({ ...priced, [key]: value }), all)).toThrow();
  });
}
