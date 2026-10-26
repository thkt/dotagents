import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import type { Config, State } from './input.ts';
import type { ReviewReturn } from './host-records.ts';
import {
  observeInNewDirectory,
  observeInterruption,
  observeInterruptedProcess,
  sealRun,
  verifySealedRun,
} from './interrupted-records.ts';
import { reconcileExecutions } from './execution-history.ts';

export async function prepareCheckTimeout(input: {
  dir: string;
  config: Config;
  state: State;
  result: Record<string, unknown>;
  text: (name: string) => Promise<string>;
  branch: string;
  runDirectory: string;
  references: string[];
}) {
  const { dir, config, state, result } = input;
  assert(
    result.reasonCode === 'check_unavailable' &&
      state.result === 'check_unavailable' &&
      state.checks === 1 &&
      state.review === 0 &&
      state.repair === 0 &&
      state.reviewHistory.length === 0 &&
      state.active === null &&
      !config.revision &&
      (!config.reviewReturn || Boolean(config.reviewReturn.checkTimeout)),
    '復帰対象は未評価・未修正の初回check時間切れだけです',
  );
  const checks = state.events.filter((event) => event.role === 'check');
  const check = checks[0];
  assert(
    checks.length === 1 &&
      check?.timedOut === true &&
      check.code === null &&
      check.prefix === join(dir, 'verification/check-1') &&
      check.source === state.source &&
      !state.events.some((event) => ['review', 'repair'].includes(event.role)),
    '初回check時間切れの実行記録が一致しません',
  );
  await input.text('verification/check-1.stdout');
  await input.text('verification/check-1.stderr');
  await reconcileExecutions({ previousRun: dir, runDirectory: input.runDirectory }, config.cwd);
  const observations = await observeInNewDirectory(
    'check-timeout',
    { previousRun: dir, branch: input.branch },
    config,
    input.runDirectory,
    '--check-timeout-run',
  );
  return {
    version: 1 as const,
    state: await input.text('verification/state.json'),
    modes: await sealRun(dir, input.references, observations),
    observations,
  };
}

export async function verifyCheckTimeout(
  input: ReviewReturn,
  config: Config,
  runDirectory: string,
  published: boolean,
  entryObservation?: ReviewReturn['checkTimeout'],
) {
  const record = input.checkTimeout;
  assert(record);
  await verifySealedRun(input.previousRun, record, '旧時間切れrunのモード・記録一覧が変わりました');
  if (entryObservation) {
    // 同一受付で直前に得た観測だけを共有し、工程境界の再観測は省略しない。
    assert(!published && entryObservation === record, '受付内の観測対象が一致しません');
    return;
  }
  await reconcileExecutions({ previousRun: input.previousRun, runDirectory }, config.cwd);
  const directory = dirname(record.observations[0]?.path ?? '');
  if (published) {
    await observeInterruptedProcess(input, config, directory, runDirectory, '--check-timeout-run');
  } else {
    await observeInterruption(input, config, directory, runDirectory, '--check-timeout-run');
  }
}
