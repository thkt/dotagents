import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { writeLightComparison } from '../report.ts';
import { instructionFiles } from './trusted-inputs.ts';

const order = [
  'before-storage-fields',
  'after-storage-fields',
  'after-completion-message',
  'before-completion-message',
];
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const trace =
  '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":5,"output_tokens":3}}\n';
const config = {
  repository: 'thkt/dotagents',
  issue: 'https://github.com/thkt/dotagents/issues/409',
  authentication: 'chatgpt',
  stage: 1,
  before: 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092',
  after: '6181233d17a29c711a84f20549f78507c5c3e5fb',
  corpusCommit: '0c7316253a9768844eb1c224961e00be52dcdcf2',
  workspaceCommit: '0c7316253a9768844eb1c224961e00be52dcdcf2',
  workspaceFiles: ['eval/fixtures/workspace/README.md'],
  instructionFiles,
  cases: ['storage-fields', 'completion-message'],
  trialOrder: order,
  maxTrials: 4,
  model: 'gpt-6.1-sol',
  reasoning: 'medium',
  cliVersion: 'synthetic-cli',
  bunVersion: '1.4.3',
  gitVersion: 'synthetic-git',
  permissionProfile: 'eval-light',
  caseTimeMs: 600000,
  totalTimeMs: 2400000,
  disclosure: {
    inputs: 'reviewed-public-committed-files-only',
    raw: 'local-only',
    summary: 'manual-issue-or-pr',
  },
};

async function fixture(
  action: (
    root: string,
    evaluation: ReturnType<typeof saved>,
    assessment: ReturnType<typeof judgment>,
    file: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'light-report-evidence-'));
  try {
    for (const trial of order) {
      await mkdir(join(root, trial));
      await writeFile(join(root, trial, 'actor.stdout'), trace);
    }
    const evaluation = saved(root);
    const raw = JSON.stringify(evaluation);
    await writeFile(join(root, 'evaluation.json'), raw);
    const assessment = judgment(raw);
    const file = join(root, 'judgment.json');
    await writeFile(file, JSON.stringify(assessment));
    await action(root, evaluation, assessment, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function saved(root: string) {
  return {
    config: { ...config, outputDirectory: root },
    executionMode: 'native-chatgpt',
    retries: 0,
    elapsedMs: 40,
    error: null,
    records: order.map((trial) => ({
      trial,
      side: trial.startsWith('before-') ? 'before' : 'after',
      case: trial.replace(/^(before|after)-/, ''),
      expected: trial.endsWith('storage-fields') ? 'scoping' : 'implement',
      executionMode: 'native-chatgpt',
      execution: 'completed',
      launched: true,
      elapsedMs: 10,
      safety: { boundaryVerified: true, processesStopped: true },
    })),
  };
}
function judgment(raw: string) {
  const evidence = [{ file: 'actor.stdout', sha256: hash(trace), lines: [1, 1] }];
  return {
    evaluationSha256: hash(raw),
    conclusion: 'indeterminate',
    reason: '合成の証拠接続。効果は未確認。',
    nextDecision: '記録を人が照合する。',
    conditionDifferences: [],
    trials: order.map((trial) => ({
      trial,
      selection: trial.endsWith('storage-fields') ? 'scoping' : 'implement',
      bodyReads: evidence,
      applications: evidence,
      completeTrace: [] as typeof evidence,
      outcome: 'fulfilled',
      evidence,
      reason: '固定した合成要求と証拠の照合。',
    })),
  };
}

test('軽量reportの正常対照は全予定行を裁定し原記録・既存summaryを上書きしない', async () => {
  await fixture(async (root, evaluation, _assessment, file) => {
    await writeLightComparison(root, file);
    const summary = join(root, `comparison-${hash(JSON.stringify(_assessment)).slice(0, 12)}.md`);
    const report = await readFile(summary, 'utf8');
    for (const trial of order) {
      expect(report).toContain(trial);
    }
    expect(report).toContain('要求充足2/2');
    await assert.rejects(() => writeLightComparison(root, file), /EEXIST/);
    expect(await readFile(summary, 'utf8')).toBe(report);
    expect(await readFile(join(root, 'evaluation.json'), 'utf8')).toBe(JSON.stringify(evaluation));
  });
});
for (const [name, mutate, reason] of [
  ['hash不一致', { sha256: '0'.repeat(64) }, /Evidence changed/],
  ['範囲外の行', { lines: [1, 999] }, /Evidence lines missing/],
] as const) {
  test(`軽量reportは${name}の証拠を裁定に使わない`, async () => {
    await fixture(async (root, _evaluation, assessment, file) => {
      await writeFile(
        file,
        JSON.stringify({
          ...assessment,
          trials: assessment.trials.map((trial) => ({
            ...trial,
            evidence: trial.evidence.map((ref) => ({ ...ref, ...mutate })),
          })),
        }),
      );
      await assert.rejects(() => writeLightComparison(root, file), reason);
    });
  });
}
test('一度裁定した証拠でも変更後は古い成功を流用しない', async () => {
  await fixture(async (root, _evaluation, _assessment, file) => {
    await writeLightComparison(root, file);
    await writeFile(join(root, order[0] ?? '', 'actor.stdout'), trace + 'changed');
    await assert.rejects(() => writeLightComparison(root, file), /Evidence changed/);
  });
});
for (const field of ['bodyReads', 'applications', 'completeTrace', 'evidence'] as const) {
  test(`軽量reportは${field}の末尾改行後の架空行を拒否する`, async () => {
    await fixture(async (root, evaluation, assessment, file) => {
      const first = assessment.trials[0];
      assert(first);
      first[field] = [{ file: 'actor.stdout', sha256: hash(trace), lines: [2, 2] }];
      await writeFile(file, JSON.stringify(assessment));
      await assert.rejects(() => writeLightComparison(root, file), /Evidence lines missing/);
      const summary = join(root, `comparison-${hash(JSON.stringify(assessment)).slice(0, 12)}.md`);
      await assert.rejects(() => readFile(summary), { code: 'ENOENT' });
      expect(await readFile(join(root, first.trial, 'actor.stdout'), 'utf8')).toBe(trace);
      expect(await readFile(join(root, 'evaluation.json'), 'utf8')).toBe(
        JSON.stringify(evaluation),
      );
    });
  });
}
for (const [name, body, lines, accepted] of [
  ['終端改行のない最終行', 'first', [1, 1], true],
  ['終端改行のある最終行', 'first\nsecond\n', [2, 2], true],
  ['実在する空の最終行', 'first\n\n', [2, 2], true],
  ['終端改行のない本文の範囲外', 'first', [2, 2], false],
  ['複数行の終端改行後の架空行', 'first\nsecond\n', [3, 3], false],
  ['最終行から架空行にまたがる範囲', 'first\n', [1, 2], false],
  ['空ファイルの架空行', '', [1, 1], false],
] as const) {
  test(`軽量reportの証拠行境界: ${name}`, async () => {
    await fixture(async (root, _evaluation, assessment, file) => {
      const first = assessment.trials[0];
      assert(first);
      await writeFile(join(root, first.trial, 'evidence.txt'), body);
      first.evidence = [{ file: 'evidence.txt', sha256: hash(body), lines: [...lines] }];
      await writeFile(file, JSON.stringify(assessment));
      if (accepted) {
        await writeLightComparison(root, file);
        const summary = join(
          root,
          `comparison-${hash(JSON.stringify(assessment)).slice(0, 12)}.md`,
        );
        expect(await readFile(summary, 'utf8')).toContain(
          `${first.trial}/evidence.txt:${lines.join('-')} SHA-256 ${hash(body)}`,
        );
      } else {
        await assert.rejects(() => writeLightComparison(root, file), /Evidence lines missing/);
      }
    });
  });
}
for (const broken of [
  'missing-row',
  'wrong-side',
  'wrong-case',
  'missing-jsonl',
  'invalid-usage',
]) {
  test(`軽量reportは${broken}を成功や予定分母の縮小へ変えない`, async () => {
    await fixture(async (root, evaluation, assessment, file) => {
      if (broken === 'missing-row') {
        evaluation.records.pop();
      }
      const first = evaluation.records[0];
      assert(first);
      if (broken === 'wrong-side') {
        first.side = 'after';
      }
      if (broken === 'wrong-case') {
        first.case = 'completion-message';
      }
      if (broken === 'missing-jsonl' || broken === 'invalid-usage') {
        const invalid =
          broken === 'missing-jsonl'
            ? 'not-json\n'
            : '{"type":"turn.completed","usage":{"input_tokens":-1,"cached_input_tokens":0,"output_tokens":0}}\n';
        await writeFile(join(root, first.trial, 'actor.stdout'), invalid);
        const trial = assessment.trials[0];
        assert(trial);
        const refs = [{ file: 'actor.stdout', sha256: hash(invalid), lines: [1, 1] }];
        trial.bodyReads = refs;
        trial.applications = refs;
        trial.evidence = refs;
      }
      const raw = JSON.stringify(evaluation);
      await writeFile(join(root, 'evaluation.json'), raw);
      await writeFile(file, JSON.stringify({ ...assessment, evaluationSha256: hash(raw) }));
      await assert.rejects(
        () => writeLightComparison(root, file),
        broken.startsWith('wrong') || broken === 'missing-row' ? /予定試行/ : /JSONL/,
      );
    });
  });
}
