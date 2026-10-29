import { interruptedTestOrigin } from './test-interruption.ts';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareCheckTimeout } from './check-timeout-recovery.ts';
import type { TestRecord } from './test-author.ts';
import { testRecordPaths } from './test-author.ts';
import type { ReviewReturn } from './host-records.ts';
import type { Config, State } from './input.ts';
import { assertConfig, assertPreviousConfig, assertState, testRecordsShape } from './input.ts';
import { hash, verifyHostReturn } from './host-records.ts';
import { reviewRecoveryRecords, verifyReviewReturn } from './review-recovery-records.ts';
import { RecordObservation } from './record-observation.ts';
import { snapshot } from './correction.ts';
import { verifyTestArtifacts } from './test-author.ts';
import { isRecord, outside } from '../shared/values.ts';
import {
  prepareInterruption,
  preparedInterruptionTests,
  retainInterruptionTestModes,
} from './interrupted-records.ts';
import { verifyReviewedRuntime } from './runtime-records.ts';
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
    return history;
  }
  return undefined;
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
  interrupted?: boolean;
  checkTimeout?: boolean;
  evidenceFile?: string;
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
  assert(input.runDirectory, '停止からの復帰には新しい--run-dirが必要です');
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
  if (input.interrupted) {
    assertPreviousConfig(config);
  } else {
    assertConfig(config);
  }
  assert(!interruptedTestOrigin(config), '初回テスト中断復帰から別の停止復帰を連鎖できません');
  assertState(state);
  assert(isRecord(result) && isRecord(target), '旧runの対象記録が不正です');
  verifyEligibility(result, state, input.interrupted, dir, input.checkTimeout);
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
  verifyCommandContract(config, input.target);
  if (!input.checkTimeout) {
    await verifyReviewTarget(config, state, dir, text, input.original, input.interrupted);
  }
  const originalTests = testRecordsShape.parse(JSON.parse(await text('test-records.json')));
  assert(
    JSON.stringify(originalTests) === JSON.stringify(state.testRecords),
    '旧独立テストの記録が一致しません',
  );
  const manifest: Record<string, string> = {};
  const currentSource = await snapshot(input.cwd, manifest);
  const intake = { manifest, records: observation };
  assert(
    state.source && (input.interrupted || state.source === currentSource),
    '停止時の成果物が変わりました',
  );
  const runtimePaths = await verifyReviewedRuntime(state, observation);
  const history = await verifyInitialHistory(config, input.cwd, observation);
  assert(config.testBaseline, '旧独立テストの修正前入力がありません');
  verifyAuthority(result, input.localOnly);
  const interruption = input.interrupted
    ? await prepareInterruption({
        dir,
        config,
        state,
        text,
        history,
        runtimePaths,
        intake,
        cwd: input.cwd,
        branch: input.branch,
        runDirectory: resolve(input.runDirectory),
        currentSource,
        evidenceFile: input.evidenceFile,
      })
    : undefined;
  const tests = [
    ...originalTests,
    ...(interruption
      ? await preparedInterruptionTests(interruption, input.cwd, input.original, intake)
      : []),
  ];
  // 旧入力・原応答の照合は残し、独立工程で確認した更新分だけを後勝ちで採用する。
  await verifyTestArtifacts(input.cwd, tests, manifest, observation);
  const reviewReturn = {
    previousRun: dir,
    records: saved,
    source: input.interrupted ? currentSource : state.source,
    head: input.head,
    branch: input.branch,
  };
  const checkTimeout = input.checkTimeout
    ? await prepareCheckTimeout({
        dir,
        config,
        state,
        result,
        text,
        branch: input.branch,
        runDirectory: resolve(input.runDirectory),
        references: [...runtimePaths, ...(history?.references ?? []), ...testRecordPaths(tests)],
      })
    : undefined;
  const returned = await stoppedReturn(reviewReturn, interruption, checkTimeout, tests);
  await verifyReviewReturn(
    returned,
    input.cwd,
    join(resolve(input.runDirectory), 'verification'),
    undefined,
    new Set<string>(),
    new RecordObservation(),
    false,
    checkTimeout,
  );
  return {
    dir,
    config,
    tests,
    hostHistory: history?.history.map(({ previousRun, evidence }) => ({ previousRun, evidence })),
    reviewReturn: returned,
    branch: input.branch,
    baseCommit: state.baseCommit,
  };
}

function verifyEligibility(
  result: Record<string, unknown>,
  state: State,
  interrupted: boolean | undefined,
  dir: string,
  checkTimeout?: boolean,
) {
  if (checkTimeout) {
    assert(
      result.terminal === true &&
        result.status === 'stopped' &&
        result.phase === 'verification' &&
        result.publication === 'not_attempted' &&
        !result.url &&
        !result.commit,
      '未公開の終端verification停止だけを指定してください',
    );
    return;
  }
  assert(
    result.terminal === true &&
      result.status === 'stopped' &&
      result.phase === 'verification' &&
      (interrupted ? state.result === 'interrupted' : result.reasonCode === 'invalid_review') &&
      result.publication === 'not_attempted' &&
      !result.url &&
      !result.commit &&
      (interrupted || state.result === 'invalid_review') &&
      state.review === 1 &&
      state.repair === 0 &&
      state.reviewHistory.length === 0 &&
      (interrupted
        ? state.active?.role === 'review' &&
          state.active.prefix === join(dir, 'verification/review-1')
        : state.active === null) &&
      !state.events.some((event) => event.role === 'repair'),
    '復帰対象は未公開・終端・履歴なし・追加修正なしの初回invalid_reviewまたは明示した中断だけです',
  );
}

function verifyFirstExecution(state: State, interrupted: boolean | undefined, dir: string) {
  const event = state.events.filter((entry) => entry.role === 'review');
  assert(
    state.checks > 0 &&
      (interrupted
        ? event.length === 0
        : event.length === 1 &&
          event[0]?.prefix === join(dir, 'verification/review-1') &&
          event[0].code === 0 &&
          !event[0].timedOut),
    '初回評価の実行記録が一致しません',
  );
}

export function verifyCommandContract(
  config: Config,
  target: Awaited<ReturnType<typeof readTarget>>,
) {
  assert(
    JSON.stringify(config.check) === JSON.stringify(targetCommand(target.config.check)) &&
      JSON.stringify(config.feedbackCheck) ===
        JSON.stringify(
          target.config.feedbackCheck ? targetCommand(target.config.feedbackCheck) : undefined,
        ) &&
      (config.checkTimeMs === null ||
        config.checkTimeMs === 540000 ||
        config.checkTimeMs === 900000) &&
      JSON.stringify(config.setup) === JSON.stringify(target.config.setup.map(targetCommand)) &&
      JSON.stringify(config.capture) ===
        JSON.stringify(
          target.config.capture ? targetCommand(target.config.capture.command) : undefined,
        ) &&
      config.captureDestination === target.config.capture?.destination &&
      config.captureRequired === target.config.capture?.required,
    '対象のcheck契約が一致しません',
  );
}

function verifyAuthority(result: Record<string, unknown>, currentLocalOnly: boolean) {
  assert(
    result.localOnly === undefined || typeof result.localOnly === 'boolean',
    '旧公開権限の記録が不正です',
  );
  const localOnly = typeof result.localOnly === 'boolean' ? result.localOnly : true; // 旧記録で権限が判別できなければ公開しない範囲に限定する。
  assert(!localOnly || currentLocalOnly, '復帰で公開権限を拡大できません');
}

async function verifyReviewTarget(
  config: Config,
  state: State,
  dir: string,
  text: (name: string) => Promise<string>,
  original: string,
  interrupted?: boolean,
) {
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
      review.issue.content === original &&
      JSON.stringify(review.tests) === JSON.stringify(state.testRecords),
    '旧評価対象と停止記録が一致しません',
  );
  const { targetId, ...payload } = review;
  assert(
    targetId === hash(JSON.stringify(payload)) &&
      hash(JSON.stringify(review.files)) === state.source,
    '旧評価対象の識別値が一致しません',
  );
  verifyFirstExecution(state, interrupted, dir);
  await verifyStoppedCheck(review.check, config, state, dir, text);
  await text('verification/review-1.stdout');
  await text('verification/review-1.stderr');
  await text('verification/review-1.additions.json');
  await text('verification/review-1.prompt');
  await text('verification/review-1.diff');
}

async function stoppedReturn(
  base: ReviewReturn,
  interruption: ReviewReturn['interruption'],
  checkTimeout: ReviewReturn['checkTimeout'],
  tests: TestRecord[],
): Promise<ReviewReturn> {
  if (checkTimeout) {
    return { ...base, checkTimeout };
  }
  return interruption
    ? { ...base, interruption: await retainInterruptionTestModes(interruption, tests) }
    : base;
}
