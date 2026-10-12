import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Config, State } from './input.ts';
import { assertConfig, assertState, testRecordsShape } from './input.ts';
import { hash, verifyHostReturn } from './host-records.ts';
import { reviewRecoveryRecords, verifyReviewReturn } from './review-recovery-records.ts';
import { RecordObservation } from './record-observation.ts';
import { snapshot } from './correction.ts';
import { verifyTestArtifacts } from './test-author.ts';
import { isRecord, outside } from '../shared/values.ts';
import { targetCommand } from '../shared/target.ts';
import type { readTarget } from '../shared/target.ts';

async function verifyInitialHistory(config: Config, cwd: string, observation: RecordObservation) {
  if (config.hostReturn) {
    const history = await verifyHostReturn(config.hostReturn, cwd, observation);
    for (const entry of history.history) {
      const content = entry.records.get(join(entry.previousRun, 'verification/state.json'));
      if (content) {
        const prior: unknown = JSON.parse(content);
        assertState(prior);
        assert(
          prior.repair === 0 && prior.reviewHistory.length === 0 && prior.review === 0,
          '有効な評価履歴や追加修正のある復帰履歴を飛び越えられません',
        );
      }
    }
  }
}

async function verifyStoppedCheck(
  check: unknown,
  config: Config,
  state: State,
  dir: string,
  text: (name: string) => Promise<string>,
) {
  assert(isRecord(check), '旧checkの評価対象記録がありません');
  const prefix = `verification/check-${state.checks}`;
  assert(
    check.prefix === join(dir, prefix) &&
      check.code === 0 &&
      check.timedOut === false &&
      check.source === state.source &&
      JSON.stringify(check.command) === JSON.stringify(config.check),
    '旧checkと初回評価の対象が一致しません',
  );
  assert(
    hash(await text(`${prefix}.stdout`)) === check.stdoutHash &&
      hash(await text(`${prefix}.stderr`)) === check.stderrHash,
    '旧checkの原ログが欠落または変化しています',
  );
}

export async function previousReviewRun(input: {
  directory?: string;
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
  assert(input.runDirectory, '不正評価からの復帰には新しい--run-dirが必要です');
  const dir = await realpath(input.directory);
  assert(outside(dir, resolve(input.runDirectory)), '新runは旧runの外に保存してください');
  const observation = new RecordObservation();
  const contents = new Map<string, Buffer>();
  const saved = await reviewRecoveryRecords(
    dir,
    (path, content) => {
      contents.set(path, content);
    },
    observation,
  );
  const text = async (name: string) => {
    const content = contents.get(join(dir, name));
    assert(content, `復帰に必要な旧記録がありません: ${name}`);
    return content.toString('utf8');
  };
  const result: unknown = JSON.parse(await text('result.json'));
  assert(
    !saved.some((ref) => ref.path === join(dir, 'verification/review-1.json')),
    '初回不正評価に有効な保存済み評価が混在しています',
  );
  const config: unknown = JSON.parse(await text('verification-config.json'));
  const state: unknown = JSON.parse(await text('verification/state.json'));
  const target: unknown = JSON.parse(await text('target.json'));
  assertConfig(config);
  assertState(state);
  assert(isRecord(result) && isRecord(target), '旧runの対象記録が不正です');
  assert(
    result.terminal === true &&
      result.status === 'stopped' &&
      result.phase === 'verification' &&
      result.reasonCode === 'invalid_review' &&
      result.publication === 'not_attempted' &&
      !result.url &&
      !result.commit &&
      state.result === 'invalid_review' &&
      state.review === 1 &&
      state.repair === 0 &&
      state.reviewHistory.length === 0 &&
      state.active === null &&
      !state.events.some((event) => event.role === 'repair'),
    '復帰対象は未公開・履歴なし・追加修正なしの初回invalid_reviewだけです',
  );
  assert(
    config.cwd === input.cwd &&
      config.runDir === join(dir, 'verification') &&
      result.checkout === input.cwd &&
      result.evidence === dir &&
      result.startCommit === input.head &&
      result.branch === input.branch &&
      config.baseCommit === state.baseCommit &&
      state.configHash === hash(JSON.stringify(config)) &&
      result.repository === input.target.config.repository &&
      result.issue === `https://github.com/${input.target.config.repository}/issues/${input.issue}`,
    '旧runのcheckout・HEAD・branch・差分基準・要求の対象が一致しません',
  );
  assert(
    target.text === input.target.text &&
      JSON.stringify(target.config) === JSON.stringify(input.target.config) &&
      target.actor === input.target.actor &&
      target.repositoryId === input.target.repositoryId &&
      config.targetText === input.target.text,
    '旧runの設定原文・repository・実効主体が一致しません',
  );
  assert(
    (await text('issue.json')) === input.original && state.issueHash === hash(input.original),
    '合意済みIssueが変わりました',
  );
  assert(
    JSON.stringify(config.check) === JSON.stringify(targetCommand(input.target.config.check)) &&
      config.checkTimeMs === 540000 &&
      JSON.stringify(config.setup) ===
        JSON.stringify(input.target.config.setup.map(targetCommand)) &&
      JSON.stringify(config.capture) ===
        JSON.stringify(
          input.target.config.capture
            ? targetCommand(input.target.config.capture.command)
            : undefined,
        ) &&
      config.captureDestination === input.target.config.capture?.destination &&
      config.captureRequired === input.target.config.capture?.required,
    '対象のcheck契約が一致しません',
  );
  const review: unknown = JSON.parse(await text('verification/review-1.target.json'));
  assert(isRecord(review), '旧評価対象が不正です');
  assert(
    review.source === state.source &&
      review.baseCommit === state.baseCommit &&
      review.configHash === state.configHash &&
      review.latestRepair === null &&
      JSON.stringify(review.repairsSinceReview) === '[]' &&
      isRecord(review.issue) &&
      review.issue.hash === state.issueHash &&
      review.issue.content === input.original &&
      JSON.stringify(review.tests) === JSON.stringify(state.testRecords),
    '旧評価対象と停止記録が一致しません',
  );
  const { targetId, ...payload } = review;
  assert(
    targetId === hash(JSON.stringify(payload)) &&
      hash(JSON.stringify(review.files)) === state.source,
    '旧評価対象の識別値が一致しません',
  );
  const event = state.events.filter((entry) => entry.role === 'review');
  assert(
    event.length === 1 &&
      event[0]?.prefix === join(dir, 'verification/review-1') &&
      event[0].code === 0 &&
      !event[0].timedOut &&
      state.checks > 0,
    '初回評価の実行記録が一致しません',
  );
  await verifyStoppedCheck(review.check, config, state, dir, text);
  await text('verification/review-1.stdout');
  await text('verification/review-1.prompt');
  await text('verification/review-1.diff');
  const tests = testRecordsShape.parse(JSON.parse(await text('test-records.json')));
  assert(
    JSON.stringify(tests) === JSON.stringify(state.testRecords),
    '旧独立テストの記録が一致しません',
  );
  await verifyTestArtifacts(input.cwd, tests);
  assert(
    state.source && state.source === (await snapshot(input.cwd)),
    '停止時の成果物が変わりました',
  );
  await verifyInitialHistory(config, input.cwd, observation);
  assert(config.testBaseline, '旧独立テストの修正前入力がありません');
  await text('test-baseline.json');
  assert(
    result.localOnly === undefined || typeof result.localOnly === 'boolean',
    '旧公開権限の記録が不正です',
  );
  const localOnly = typeof result.localOnly === 'boolean' ? result.localOnly : true; // 旧記録で権限が判別できなければ公開しない範囲に限定する。
  assert(!localOnly || input.localOnly, '復帰で公開権限を拡大できません');
  const reviewReturn = {
    previousRun: dir,
    records: saved,
    source: state.source,
    head: input.head,
    branch: input.branch,
  };
  await verifyReviewReturn(
    reviewReturn,
    input.cwd,
    join(resolve(input.runDirectory), 'verification'),
    undefined,
    new Set<string>(),
    observation,
  );
  return { dir, config, tests, reviewReturn, branch: input.branch, baseCommit: state.baseCommit };
}
