import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { recordText } from './record-observation.ts';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertConfig, testRecordsShape } from './input.ts';
import type { Config } from './input.ts';
import { hash, verifyHostReturn } from './host-records.ts';
import { snapshot } from './correction.ts';
import { verifyTestArtifacts, verifyTestBaseline } from './test-author.ts';
import { verifyCommandContract } from './review-recovery.ts';
import { isRecord, outside } from '../shared/values.ts';
import type { readTarget } from '../shared/target.ts';
import { readSupplement } from './supplement.ts';
import { preserveDecisionRecords } from './human-decision-records.ts';
import { verifyHumanDecision } from './human-decision-verify.ts';
import type { HumanDecision } from './human-decision-schema.ts';
import { verifyStoppedTestActor } from './stopped-test-actor.ts';
import { verifyInitialTestReturn } from './initial-test-records.ts';

async function latestDecisionStop(dir: string, cwd: string, runDirectory: string) {
  for (const name of await readdir(dirname(dir))) {
    const sibling = join(dirname(dir), name);
    if (sibling === dir || sibling === runDirectory) {
      continue;
    }
    const content = await readFile(join(sibling, 'verification-config.json'), 'utf8').catch(
      (error: unknown) => {
        assert(
          isRecord(error) && ['ENOENT', 'ENOTDIR'].includes(String(error.code)),
          '兄弟runを照合できません',
        );
        return undefined;
      },
    );
    if (!content) {
      continue;
    }
    const config: unknown = JSON.parse(content);
    if (isRecord(config) && config.cwd === cwd) {
      for (const entry of [config.humanDecision, config.hostReturn, config.reviewReturn]) {
        assert(
          !isRecord(entry) || entry.previousRun !== dir,
          '直近の停止を指定してください。旧祖先を選び直して復帰できません',
        );
      }
    }
  }
}

async function stoppedTest(dir: string, config: Config, original: string) {
  const prefix = join(dir, 'test-1');
  const raw: unknown = JSON.parse(await recordText(`${prefix}.target.json`));
  assert(isRecord(raw), '保存テスト入力が不正です');
  const input = z
    .object({
      targetId: z.string(),
      stage: z.literal('host_return'),
      issue: z.string(),
      baseCommit: z.string(),
      files: z.record(z.string(), z.string()),
      baseline: z.record(z.string(), z.string()),
      check: z.array(z.string()),
      setup: z.array(z.array(z.string())),
      reports: z.array(z.unknown()),
      evidence: z.array(z.unknown()),
      revisionRequest: z.string().nullable(),
      diagnostics: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .parse(raw);
  const { targetId, ...payload } = raw;
  assert(targetId === hash(JSON.stringify(payload)), '保存テスト入力の識別値が不一致です');
  assert(
    input.issue === original &&
      input.baseCommit === config.baseCommit &&
      JSON.stringify(input.check) === JSON.stringify(config.check) &&
      JSON.stringify(input.setup) === JSON.stringify(config.setup ?? []) &&
      JSON.stringify(input.reports) === JSON.stringify(config.reports ?? []),
    '保存テスト入力と要求・設定が一致しません',
  );
  const reply = z
    .strictObject({
      targetId: z.string(),
      status: z.literal('needs_human'),
      files: z.array(z.string()).length(0),
      findings: z.string().regex(/\S/),
    })
    .parse(JSON.parse(await recordText(`${prefix}.stdout`)));
  assert(reply.targetId === targetId, '原応答の対象IDが入力と一致しません');
  const pending = z
    .object({
      targetId: z.string(),
      status: z.literal('needs_human'),
      findings: z.string(),
      pendingFiles: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(await recordText(`${prefix}.json`)));
  assert(
    pending.targetId === targetId &&
      pending.findings === reply.findings &&
      Object.keys(pending.pendingFiles).length === 0,
    '判断待ちのfiles・未採用成果物が空ではありません',
  );
  z.object({ code: z.literal(0), timedOut: z.literal(false), ms: z.number().nonnegative() }).parse(
    JSON.parse(await recordText(`${prefix}.execution.json`)),
  );
  const prompt = await recordText(`${prefix}.prompt`);
  assert(
    prompt.includes(`"targetId":"${targetId}"`) && prompt.includes(original),
    '原指示と保存テスト入力が一致しません',
  );
  assert.deepStrictEqual(
    raw.supplement,
    config.supplement?.agreement,
    '補足合意の保存入力が不一致です',
  );
  await verifyStoppedTestActor(
    dir,
    config,
    {
      ...input,
      reports: config.reports,
      revisionRequest: input.revisionRequest ?? undefined,
      supplement: config.supplement,
    },
    input.targetId,
    prompt,
  );
  await recordText(`${prefix}.stderr`);
  const manifest: Record<string, string> = {};
  await snapshot(`${prefix}-workspace`, manifest);
  const sorted = (value: Record<string, string>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  assert(sorted(input.files) === sorted(manifest), '判断待ちworkspaceの成果物が変更されています');
  assert(config.testBaseline, '元の固定baselineがありません');
  assert(
    sorted((await verifyTestBaseline(config.testBaseline)).files) === sorted(input.baseline),
    '元の固定baselineと保存入力が一致しません',
  );
  return input;
}

export async function previousHumanDecision(input: {
  directory?: string;
  supplementFile?: string;
  runDirectory?: string;
  cwd: string;
  issue: string;
  original: string;
  head: string;
  branch: string;
  target: Awaited<ReturnType<typeof readTarget>>;
  localOnly: boolean;
}) {
  if (!input.directory) {
    return undefined;
  }
  assert(
    input.supplementFile && input.runDirectory,
    '判断待ち復帰には補足合意と新しい保存先が必要です',
  );
  const dir = await realpath(input.directory);
  const runDirectory = resolve(input.runDirectory);
  assert(
    dirname(dir) === dirname(runDirectory) && outside(dir, runDirectory),
    '判断待ち復帰は同じ親の新しい兄弟runに限ります',
  );
  await latestDecisionStop(dir, input.cwd, runDirectory);
  const selectedRecords = await preserveDecisionRecords([dir], input.cwd);
  const original = await recordText(join(dir, 'issue.json'));
  assert(original === input.original, '合意済みIssueの版が変わりました');
  const supplement = await readSupplement(
    input.supplementFile,
    `https://github.com/${input.target.config.repository}/issues/${input.issue}`,
    original,
  );
  assert(
    outside(input.cwd, supplement.path) && outside(dir, supplement.path),
    '補足合意はcheckoutと旧runの外に固定してください',
  );
  const result: unknown = JSON.parse(await recordText(join(dir, 'result.json')));
  assertDecisionStop(result);
  const savedInput: unknown = JSON.parse(await recordText(join(dir, 'test-1.target.json')));
  assert(
    isRecord(savedInput) && savedInput.stage === 'host_return',
    '復帰対象の段階はhost_returnだけです',
  );
  const config = await decisionConfig(dir, input, result, supplement);
  const stopped = await stoppedTest(dir, config, original).catch((error: unknown) => {
    throw new Error(`保存テスト入力・原応答・実行記録の照合に失敗しました: ${String(error)}`, {
      cause: error,
    });
  });
  await verifyPreviousDecision(config, input.cwd, runDirectory, dir);
  const history = config.hostReturn
    ? await verifyHostReturn(config.hostReturn, input.cwd)
    : undefined;
  assert(config.baseCommit && config.testBaseline, '元の差分基準・baselineがありません');
  const manifest: Record<string, string> = {};
  const source = await snapshot(input.cwd, manifest);
  if (history) {
    await verifyDecisionAncestors(history, config, original, input.target);
    const artifacts: unknown = JSON.parse(
      await recordText(join(dir, 'host-current-artifacts.json')),
    );
    assert(
      isRecord(artifacts) && artifacts.source === source && history.source === source,
      '判断待ち後に成果物checkoutが変更されました',
    );
  } else {
    await verifyInitialDecision(config, input, runDirectory, dir, original, stopped, manifest);
  }
  const tests = testRecordsShape.parse(
    JSON.parse(await recordText(join(dir, 'test-records.json'))),
  );
  await verifyTestArtifacts(input.cwd, tests);
  const roots = [
    ...new Set([
      dir,
      ...(config.humanDecision?.roots ?? []),
      ...(history?.history.map((entry) => entry.previousRun) ?? []),
      ...(history?.references ?? []),
      ...(config.initialTestReturn ? [config.initialTestReturn.previousRun] : []),
    ]),
  ];
  assert(
    roots.every((root) => outside(root, supplement.path)),
    '補足合意を保全対象の祖先run内へ追加できません',
  );
  const records = await intakeDecisionRecords(dir, roots, input.cwd);
  assert.deepStrictEqual(
    records.filter((record) => record.path === dir || record.path.startsWith(`${dir}${sep}`)),
    selectedRecords,
    '判断待ちの原記録が受付中に変更されました',
  );
  const humanDecision: HumanDecision = {
    previousRun: dir,
    roots,
    records,
    source,
    head: input.head,
    branch: input.branch,
    supplement,
  };
  await verifyHumanDecision(humanDecision, input.cwd, runDirectory);
  return {
    dir,
    config,
    branch: input.branch,
    baseCommit: config.baseCommit,
    hostReturn: config.hostReturn,
    humanDecision,
    supplement,
  };
}

async function decisionConfig(
  dir: string,
  input: Parameters<typeof previousHumanDecision>[0],
  result: Record<string, unknown>,
  supplement: Awaited<ReturnType<typeof readSupplement>>,
) {
  const config: unknown = JSON.parse(await recordText(join(dir, 'verification-config.json')));
  assertConfig(config);
  assert(
    (config.hostReturn || config.initialTestReturn) &&
      !config.reviewReturn &&
      !config.revision &&
      !config.testInterruption,
    'host_return以外の段階・工程は判断待ち復帰に使えません',
  );
  assert(
    config.cwd === input.cwd &&
      config.runDir === join(dir, 'verification') &&
      result.checkout === input.cwd &&
      result.evidence === dir &&
      result.startCommit === input.head &&
      result.branch === input.branch &&
      result.repository === input.target.config.repository &&
      result.issue === supplement.agreement.issue &&
      result.details === join(dir, 'test-1.target.json'),
    '旧runの対象・HEAD・branch・段階が一致しません',
  );
  assert(
    typeof result.localOnly === 'boolean' && (!result.localOnly || input.localOnly),
    '復帰で旧runの公開権限を拡大できません',
  );
  const target: unknown = JSON.parse(await recordText(join(dir, 'target.json')));
  assert(
    isRecord(target) &&
      target.text === input.target.text &&
      JSON.stringify(target.config) === JSON.stringify(input.target.config) &&
      target.actor === input.target.actor &&
      target.repositoryId === input.target.repositoryId &&
      config.targetText === input.target.text,
    '旧runのrepo・設定原文・実効主体が一致しません',
  );
  verifyCommandContract(config, input.target);
  assert(
    config.test?.at(-2) === 'test' && config.test.at(-1) === dir,
    '独立テストの担当とrun・workspaceの対応が一致しません',
  );
  return config;
}

function assertDecisionStop(result: unknown): asserts result is Record<string, unknown> {
  assert(
    isRecord(result) &&
      result.terminal === true &&
      result.status === 'stopped' &&
      result.reasonCode === 'human_decision_required' &&
      result.operation === 'independent test authoring' &&
      result.phase === 'implementation' &&
      result.publication === 'not_attempted' &&
      !result.url &&
      !result.commit,
    '復帰対象は未公開のhost_return独立テストの終端判断待ちだけです',
  );
}

async function verifyInitialDecision(
  config: Config,
  input: { branch: string; target: Awaited<ReturnType<typeof readTarget>>; cwd: string },
  runDirectory: string,
  dir: string,
  original: string,
  stopped: Awaited<ReturnType<typeof stoppedTest>>,
  manifest: Record<string, string>,
) {
  const origin = config.initialTestReturn;
  assert(origin, '初回テスト復帰の原記録がありません');
  assert(
    origin.head === config.baseCommit &&
      origin.branch === input.branch &&
      origin.targetText === input.target.text,
    '初回テスト復帰の開始版・branch・設定が一致しません',
  );
  await verifyInitialTestReturn(origin, runDirectory, false, {
    entry: '--human-decision-run',
    previousRun: dir,
    cwd: input.cwd,
  });
  const targetPath = join(origin.previousRun, 'target.json');
  verifyAncestorTarget(
    new Map([[targetPath, await recordText(targetPath)]]),
    origin.previousRun,
    input.target,
  );
  const initial: unknown = JSON.parse(
    await recordText(join(origin.previousRun, 'test-1.target.json')),
  );
  assert(
    isRecord(initial) && initial.issue === original && initial.baseCommit === config.baseCommit,
    '初回テスト復帰の要求・差分基準が一致しません',
  );
  assert.deepStrictEqual(stopped.baseline, initial.baseline, '元の固定baselineが変更されました');
  assert.deepStrictEqual(stopped.reports, initial.reports, '元の報告参照が変更されました');
  const sorted = (files: Record<string, string>) =>
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  assert.deepStrictEqual(
    sorted(manifest),
    sorted(stopped.files),
    '判断待ち後に成果物checkoutが変更されました',
  );
}

async function verifyDecisionAncestors(
  history: Awaited<ReturnType<typeof verifyHostReturn>>,
  current: Config,
  original: string,
  target: Awaited<ReturnType<typeof readTarget>>,
) {
  for (const entry of history.history) {
    const content = entry.records.get(join(entry.previousRun, 'verification-config.json'));
    assert(content, '祖先の設定原文が欠落しています');
    const prior: unknown = JSON.parse(content);
    assertConfig(prior);
    assert(
      prior.cwd === current.cwd &&
        prior.baseCommit === current.baseCommit &&
        prior.targetText === current.targetText &&
        JSON.stringify(prior.reports ?? []) === JSON.stringify(current.reports ?? []) &&
        entry.records.get(join(entry.previousRun, 'issue.json')) === original,
      '祖先の要求・repo・設定・差分基準・報告が一致しません',
    );
    verifyCommandContract(prior, target);
    verifyAncestorTarget(entry.records, entry.previousRun, target);
    assert(prior.testBaseline, '祖先の固定baselineが欠落しています');
    await verifyTestBaseline(prior.testBaseline);
  }
}

async function intakeDecisionRecords(dir: string, roots: string[], cwd: string) {
  const records = await preserveDecisionRecords(roots, cwd);
  // 新版の停止は保存時の原記録・全modeへも照合する。旧版のmodeを補作しない。
  const seal = await recordText(join(dir, 'human-decision-stop.json')).catch((error: unknown) => {
    assert(isRecord(error) && error.code === 'ENOENT', '停止時の保全記録を取得できません');
    return undefined;
  });
  if (seal) {
    const saved: unknown = JSON.parse(seal);
    assert(
      isRecord(saved) &&
        JSON.stringify(saved.records) ===
          JSON.stringify(await preserveDecisionRecords([dir], cwd, true)),
      '停止時の原記録・modeが変更されました',
    );
  }
  return records;
}

async function verifyPreviousDecision(
  config: Config,
  cwd: string,
  runDirectory: string,
  dir: string,
) {
  if (config.humanDecision) {
    assert(config.humanDecision.previousRun !== dir, '判断待ちの復帰履歴が循環しています');
    await verifyHumanDecision(config.humanDecision, cwd, runDirectory);
  }
}

function verifyAncestorTarget(
  records: Map<string, string>,
  run: string,
  target: Awaited<ReturnType<typeof readTarget>>,
) {
  const content = records.get(join(run, 'target.json'));
  assert(content, '祖先の対象記録が欠落しています');
  const saved: unknown = JSON.parse(content);
  assert(
    isRecord(saved) &&
      saved.actor === target.actor &&
      saved.repositoryId === target.repositoryId &&
      saved.text === target.text &&
      JSON.stringify(saved.config) === JSON.stringify(target.config),
    '祖先の対象repo・実効主体・設定が一致しません',
  );
}
