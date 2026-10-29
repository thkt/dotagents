import assert from 'node:assert/strict';
import { lstat, readFile, readdir, readlink, realpath, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { reconcileExecutions } from './execution-history.ts';
import { hash, recordText } from './record-observation.ts';
import { verifyTestBaseline } from './test-author.ts';
import { observeInterruption } from './interrupted-records.ts';
import { command } from '../shared/process.ts';
import { isRecord, outside } from '../shared/values.ts';
import type { HostReturn, verifyHostReturn } from './host-records.ts';
import { assertConfig, assertState } from './input.ts';
import type { Config } from './input.ts';
import type { InitialTestOwner } from './interrupted-processes.ts';
import { formalDependencyLocks } from './dependency-locks.ts';
import { issueNumber } from '../shared/target.ts';

import type { TestInterruption } from './test-interruption-schema.ts';

async function tree(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    return [info.mode, await readlink(path)];
  }
  if (info.isFile()) {
    return [info.mode, hash(await readFile(path))];
  }
  assert(info.isDirectory(), `原記録の種別を照合できません: ${path}`);
  const entries = [];
  for (const name of (await readdir(path)).sort()) {
    // symlinkとworktreeの.git参照は内容だけを読み、run外の保存領域へ辿らない。
    entries.push([name, await tree(join(path, name))]);
  }
  return [info.mode, entries];
}

async function checked(argv: string[], cwd: string) {
  const result = await command(argv, cwd, '', 10000);
  assert(result.code === 0 && !result.timedOut, `照合コマンドに失敗しました: ${argv.join(' ')}`);
  return result.stdout.trim();
}

async function noLocks(
  path: string,
  inspected?: string,
  dependencyLocks: ReadonlySet<string> = new Set(),
) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const dependency = dependencyLocks.has(child) && (await lstat(child)).isFile();
    assert(
      dependency || (!entry.name.endsWith('.lock') && entry.name !== 'lock'),
      `lockが残っています: ${child}`,
    );
    if (entry.isDirectory() && child !== inspected) {
      await noLocks(child, inspected, dependencyLocks);
    }
  }
}

async function retained(input: Pick<TestInterruption, 'previousRun' | 'config'>) {
  const names = await readdir(input.previousRun);
  assert(
    !names.some((name) => name === 'lock' || name.endsWith('.lock')),
    '旧runにlockが残っています',
  );
  for (const workspace of ['test-baseline', 'test-1-workspace']) {
    await noLocks(join(input.previousRun, workspace, '.git'));
  }
  const git = await checked(['git', 'rev-parse', '--absolute-git-dir'], input.config.cwd);
  const common = await checked(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    input.config.cwd,
  );
  await noLocks(git);
  if (common !== git) {
    await noLocks(common, git);
  }
  const target = z.object({ remote: z.string() }).parse(JSON.parse(input.config.targetText));
  return {
    hash: hash(JSON.stringify(await tree(input.previousRun))),
    common: await realpath(common),
    remoteUrl: await checked(['git', 'remote', 'get-url', target.remote], input.config.cwd),
  };
}

export async function verifyTestInterruption(
  input: TestInterruption,
  runDirectory: string,
  directory = input.observations,
  owner?: InitialTestOwner,
) {
  await verifyObservedTestInterruption(
    input,
    runDirectory,
    directory,
    await retained(input),
    owner,
  );
}

async function verifyObservedTestInterruption(
  input: TestInterruption,
  runDirectory: string,
  directory: string,
  preserved: Awaited<ReturnType<typeof retained>>,
  owner?: InitialTestOwner,
) {
  const location = await realpath(directory);
  assert(
    outside(input.previousRun, location) && outside(input.config.cwd, location),
    '観測ログは旧run・旧checkoutの外に保存してください',
  );
  assert(
    (await checked(
      ['git', 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
      input.config.cwd,
    )) === `${input.head}\nrefs/heads/${input.branch}`,
    '旧checkoutのHEAD・branchが変更されました',
  );
  assert(preserved.remoteUrl === input.remoteUrl, '旧checkoutのremote設定が変更されました');
  assert(preserved.hash === input.retained, '旧runの原記録・応答・内容・モードが変更されました');
  const savedTarget = z
    .object({ cwd: z.string(), config: z.object({ repository: z.string() }) })
    .parse(JSON.parse(await recordText(join(input.previousRun, 'target.json'))));
  assert(
    savedTarget.cwd === input.host.cwd &&
      isAbsolute(input.host.cwd) &&
      (await realpath(input.host.cwd)) === input.host.cwd &&
      input.branch === `codex/development-${input.host.issue}` &&
      (await realpath(
        await checked(
          ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
          input.host.cwd,
        ),
      )) === preserved.common,
    '元ホストの対象root・Issue・Git領域が旧記録と一致しません',
  );
  await observeInterruption(
    {
      previousRun: input.previousRun,
      branch: input.branch,
      owner,
      host: {
        ...input.host,
        common: preserved.common,
        repository: savedTarget.config.repository,
      },
    },
    { ...input.config, check: [] },
    directory,
    runDirectory,
    '--test-interrupted-run',
  );
}

export function interruptedTestOrigin(config: {
  testInterruption?: TestInterruption;
  hostReturn?: HostReturn;
}) {
  return config.testInterruption ?? config.hostReturn?.testInterruption?.record;
}

export async function verifyHostTestInterruption(
  host: HostReturn,
  cwd: string,
  runDirectory: string,
  verified: Awaited<ReturnType<typeof verifyHostReturn>>,
  decisionRun?: string,
  decisionRuns: string[] = [],
) {
  const previousRuns = [...new Set([...verified.previousRuns, ...decisionRuns])];
  const origin = host.testInterruption;
  const previous = verified.history.find((entry) => entry.previousRun === host.previousRun);
  assert(previous, '直前のホスト停止記録がありません');
  const config: unknown = JSON.parse(savedHostRecord(previous, 'verification-config.json'));
  assertConfig(config);
  assert(config.cwd === cwd, 'ホスト停止checkoutが一致しません');
  // 既存の評価復帰は原予約を専用経路で照合する。公開済みPRにも不在を要求しない。
  if (!origin && (host.reviewReturn || config.revision)) {
    return;
  }
  for (const entry of verified.history) {
    assert(
      dirname(entry.previousRun) === dirname(runDirectory),
      '正式停止祖先と新runは兄弟である必要があります',
    );
  }
  await reconcileExecutions({ previousRun: host.previousRun, runDirectory }, cwd);
  for (const entry of verified.history) {
    await noLocks(
      entry.previousRun,
      cwd,
      await formalDependencyLocks(entry.previousRun, entry.records.keys()),
    );
  }
  if (!origin) {
    await observeFormalReturn(host, cwd, runDirectory, previous, config, previousRuns, decisionRun);
    return;
  }
  const baseline = await verifyTestBaseline(origin.record.baseline);
  const baselines = new Map([[origin.record.baseline, baseline.files]]);
  const originalTarget = JSON.parse(
    await recordText(join(origin.record.previousRun, 'target.json')),
  ) as unknown;
  assert(isRecord(originalTarget), '元の対象記録が不正です');
  for (const entry of verified.history) {
    await verifyFormalAncestor(entry, previous, config, origin.record, baselines, originalTarget);
  }
  const directory = await realpath(origin.observations);
  assert(
    outside(host.previousRun, directory) && outside(cwd, directory),
    '新しい中断観測はホスト停止run・checkoutの外に保存してください',
  );
  assert((await realpath(cwd)) === cwd, 'ホスト停止checkoutのcanonical rootが一致しません');
  const common = await realpath(
    await checked(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd),
  );
  const preserved = await retained(origin.record);
  if (common !== preserved.common) {
    await noLocks(common);
  }
  await verifyObservedTestInterruption(origin.record, runDirectory, directory, preserved, {
    entry: decisionRun ? '--human-decision-run' : '--host-run',
    previousRun: decisionRun ?? host.previousRun,
    cwd,
    common,
    previousRuns,
  });
}

type HostHistoryEntry = Awaited<ReturnType<typeof verifyHostReturn>>['history'][number];

async function observeFormalReturn(
  host: HostReturn,
  cwd: string,
  runDirectory: string,
  previous: HostHistoryEntry,
  config: Config,
  previousRuns: string[],
  decisionRun?: string,
) {
  assert((await realpath(cwd)) === cwd, 'ホスト停止checkoutのcanonical rootが一致しません');
  const git = await checked(['git', 'rev-parse', '--absolute-git-dir'], cwd);
  const common = await realpath(
    await checked(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd),
  );
  await noLocks(git);
  if (common !== git) {
    await noLocks(common, git);
  }
  const target = z.object({ repository: z.string() }).parse(JSON.parse(config.targetText ?? '{}'));
  const result = z
    .object({ issue: z.string(), branch: z.string() })
    .parse(JSON.parse(savedHostRecord(previous, 'result.json')));
  const directory = await prepareTestInterruptionObservation(runDirectory);
  await observeInterruption(
    {
      previousRun: host.previousRun,
      branch: result.branch,
      host: {
        cwd,
        common,
        repository: target.repository,
        issue: issueNumber(result.issue, target.repository),
      },
      owner: {
        entry: decisionRun ? '--human-decision-run' : '--host-run',
        previousRun: decisionRun ?? host.previousRun,
        cwd,
        common,
        previousRuns,
      },
    },
    config,
    directory,
    runDirectory,
    '--test-interrupted-run',
  );
}

function savedHostRecord(entry: HostHistoryEntry, name: string) {
  const content = entry.records.get(join(entry.previousRun, name));
  assert(content !== undefined, `祖先のホスト停止記録がありません: ${name}`);
  return content;
}

async function verifyFormalAncestor(
  entry: HostHistoryEntry,
  latest: HostHistoryEntry,
  config: Config,
  origin: TestInterruption,
  baselines: Map<string, Record<string, string>>,
  originalTarget: Record<string, unknown>,
) {
  const prior: unknown = JSON.parse(savedHostRecord(entry, 'verification-config.json'));
  assertConfig(prior);
  assert(
    prior.cwd === config.cwd &&
      prior.baseCommit === config.baseCommit &&
      prior.targetText === config.targetText &&
      JSON.stringify(prior.issue) === JSON.stringify(config.issue) &&
      JSON.stringify(prior.check) === JSON.stringify(config.check) &&
      JSON.stringify(prior.feedbackCheck) === JSON.stringify(config.feedbackCheck) &&
      JSON.stringify(prior.reports ?? []) === JSON.stringify(config.reports ?? []) &&
      !prior.reviewReturn &&
      !prior.revision &&
      JSON.stringify(interruptedTestOrigin(prior)) === JSON.stringify(origin),
    '初回テスト中断の祖先・固定設定がホスト停止記録と一致しません',
  );
  assert(prior.testBaseline, '祖先の固定baselineがありません');
  let fixed = baselines.get(prior.testBaseline);
  if (!fixed) {
    fixed = (await verifyTestBaseline(prior.testBaseline)).files;
    baselines.set(prior.testBaseline, fixed);
  }
  const baseline = baselines.get(origin.baseline);
  assert(baseline);
  const sorted = (files: Record<string, string>) =>
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  assert(
    JSON.stringify(sorted(fixed)) === JSON.stringify(sorted(baseline)),
    '祖先の修正前baselineが一致しません',
  );
  const target: unknown = JSON.parse(savedHostRecord(entry, 'target.json'));
  assert(
    isRecord(target) &&
      target.text === originalTarget.text &&
      target.actor === originalTarget.actor &&
      target.repositoryId === originalTarget.repositoryId,
    '祖先の対象・実効主体が一致しません',
  );
  const issue = savedHostRecord(entry, 'issue.json');
  assert(
    issue === savedHostRecord(latest, 'issue.json') &&
      issue === (await recordText(join(origin.previousRun, 'issue.json'))),
    '祖先の要求が一致しません',
  );
  const stop = z
    .object({
      head: z.string(),
      branch: z.string(),
      baseCommit: z.string(),
      source: z.string(),
      localOnly: z.boolean(),
    })
    .parse(JSON.parse(savedHostRecord(entry, 'host-stop.json')));
  const result: unknown = JSON.parse(savedHostRecord(entry, 'result.json'));
  assert(
    isRecord(result) &&
      result.terminal === true &&
      result.status === 'stopped' &&
      result.reasonCode === 'host_verification_required' &&
      result.publication === 'not_attempted' &&
      result.checkout === config.cwd &&
      result.startCommit === stop.head &&
      result.branch === stop.branch,
    '祖先は正式なホスト検証停止ではありません',
  );
  const repository = z.object({ config: z.object({ repository: z.string() }) }).parse(target)
    .config.repository;
  assert(
    result.repository === repository &&
      result.issue === `https://github.com/${repository}/issues/${origin.host.issue}` &&
      result.localOnly === stop.localOnly &&
      stop.localOnly,
    '祖先のrepo・Issue・ローカル限定権限が一致しません',
  );
  assert(
    stop.head === origin.head &&
      stop.branch === origin.branch &&
      stop.baseCommit === config.baseCommit,
    '祖先のHEAD・branch・差分基準が一致しません',
  );
  if (result.phase === 'verification') {
    const state: unknown = JSON.parse(savedHostRecord(entry, 'verification/state.json'));
    assertState(state);
    assert(
      state.result === 'host_verification_required' &&
        state.active === null &&
        state.source === stop.source &&
        state.configHash === hash(JSON.stringify(prior)) &&
        state.issueHash === hash(issue),
      '祖先の正式停止stateが一致しません',
    );
  }
}

export async function prepareTestInterruptionObservation(runDirectory: string) {
  const { randomUUID } = await import('node:crypto');
  const path = join(
    dirname(resolve(runDirectory)),
    `test-interruption-observation-${randomUUID()}`,
  );
  await mkdir(path, { mode: 0o700 });
  return path;
}
