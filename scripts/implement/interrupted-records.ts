import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, State } from './input.ts';
import type { ReviewReturn } from './host-records.ts';
import { hash, hostEvidenceShape, readReference } from './host-records.ts';
import type { verifyHostReturn } from './host-records.ts';
import { RecordObservation } from './record-observation.ts';
import { reconcileExecutions } from './execution-history.ts';
import { command } from '../shared/process.ts';
import { outside } from '../shared/values.ts';
import { readPreparedTestRecord, testRecordPaths } from './test-author.ts';
import type { TestRecord, TestIntake } from './test-author.ts';
import { verifyInterruptedProcesses } from './interrupted-processes.ts';

export { cliArgument } from './interrupted-processes.ts';

type Interruption = NonNullable<ReviewReturn['interruption']>;

export async function modes(dir: string): Promise<Interruption['modes']> {
  const result: Interruption['modes'] = [{ path: dir, mode: (await lstat(dir)).mode }];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'checkout' || entry.name.endsWith('-workspace')) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await modes(path)));
    } else {
      assert(
        entry.isFile() || entry.isSymbolicLink(),
        `中断runの原記録は通常ファイルである必要があります: ${path}`,
      );
      result.push({ path, mode: (await lstat(path)).mode });
    }
  }
  return result;
}

export async function includeReferenceModes(initial: Interruption['modes'], paths: string[]) {
  const result = new Map(initial.map((entry) => [entry.path, entry]));
  for (const path of new Set(paths)) {
    if (!result.has(path)) {
      result.set(path, { path, mode: (await lstat(path)).mode });
    }
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function observe(argv: string[], cwd: string, directory: string) {
  const startedAt = new Date().toISOString();
  const path = join(directory, `${randomUUID()}.json`);
  const result = await command(argv, cwd, '', 10000, undefined, {
    ...process.env,
    LC_ALL: 'C',
  }).catch((error: unknown) => ({
    code: null,
    timedOut: false,
    stdout: '',
    stderr: String(error),
    ms: 0,
  }));
  const content = JSON.stringify({
    argv,
    cwd,
    locale: 'C',
    startedAt,
    finishedAt: new Date().toISOString(),
    ...result,
  });
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  assert(
    result.code === 0 && !result.timedOut,
    `外部観測の取得に失敗しました（process/remote/GitHub）: ${argv[0]} ${argv[1]}; 原出力: ${path}`,
  );
  return { ref: { path, sha256: hash(content) }, stdout: result.stdout };
}

export async function observeInterruptedProcess(
  input: Pick<ReviewReturn, 'previousRun' | 'branch'>,
  config: Config,
  directory: string,
  runDirectory: string,
  entry: '--interrupted-run' | '--check-timeout-run' = '--interrupted-run',
) {
  const ps = await observe(
    ['ps', '-ww', '-axo', 'pid=,ppid=,lstart=,command='],
    config.cwd,
    directory,
  );
  await verifyInterruptedProcesses(ps.stdout, {
    previousRun: input.previousRun,
    runDirectory,
    review: config.review,
    entry,
    ...(entry === '--check-timeout-run' ? { check: config.check } : {}),
  });
  return ps.ref;
}

export async function observeInterruption(
  input: Pick<ReviewReturn, 'previousRun' | 'branch'>,
  config: Config,
  directory: string,
  runDirectory: string,
  entry: '--interrupted-run' | '--check-timeout-run' = '--interrupted-run',
) {
  const process = await observeInterruptedProcess(input, config, directory, runDirectory, entry);
  const target: unknown = JSON.parse(config.targetText ?? '{}');
  assert(
    typeof target === 'object' &&
      target !== null &&
      'remote' in target &&
      typeof target.remote === 'string' &&
      'repository' in target &&
      typeof target.repository === 'string',
    '中断runの対象設定がありません',
  );
  const remote = await observe(
    ['git', 'ls-remote', '--heads', target.remote, `refs/heads/${input.branch}`],
    config.cwd,
    directory,
  );
  assert(
    remote.stdout.trim() === '',
    `対象branchのremote refが存在します。公開状態を照合してください: ${remote.ref.path}`,
  );
  const prs = await observe(
    [
      'gh',
      'api',
      `repos/${target.repository}/pulls`,
      '--method',
      'GET',
      '-f',
      'state=all',
      '-f',
      `head=${target.repository.split('/')[0]}:${input.branch}`,
      '-f',
      'per_page=100',
      '--paginate',
      '--slurp',
    ],
    config.cwd,
    directory,
  );
  const pages: unknown = JSON.parse(prs.stdout);
  assert(
    Array.isArray(pages) &&
      pages.every((page: unknown) => Array.isArray(page) && page.length === 0),
    `対象branchのPRが存在するかGitHubの公開状態を照合できません: ${prs.ref.path}`,
  );
  return [process, remote.ref, prs.ref];
}

async function additionalEvidence(
  file: string,
  dir: string,
  cwd: string,
  source: string,
  observation = new RecordObservation(),
) {
  const path = await realpath(file);
  assert(
    outside(cwd, path) && outside(dir, path),
    '追加証拠はcheckoutと旧runの外に保存してください',
  );
  observation.retain([path]);
  const { content, sha256 } = await observation.read(path, true);
  const evidence = hostEvidenceShape.parse(JSON.parse(content.toString('utf8')));
  observation.retain((evidence.testRecords ?? []).map((ref) => ref.path));
  assert(
    evidence.status === 'passed' && evidence.source === source,
    '追加証拠が現在sourceの成功に対応しません',
  );
  const seen = new Map<string, string>();
  for (const log of [...evidence.logs, ...(evidence.testRecords ?? [])]) {
    const expected = seen.get(log.path);
    if (expected) {
      assert(expected === log.sha256, '追加証拠の同一pathに異なる期待hashがあります');
      continue;
    }
    seen.set(log.path, log.sha256);
    const location = await realpath(log.path);
    assert(
      outside(cwd, location) && outside(dir, location),
      '追加証拠の原ログ・テスト記録はcheckoutと旧runの外に保存してください',
    );
    await readReference(log, observation);
  }
  return { reference: { path, sha256 }, references: [path, ...seen.keys()] };
}

export async function retainInterruptionTestModes(record: Interruption, tests: TestRecord[]) {
  return { ...record, modes: await includeReferenceModes(record.modes, testRecordPaths(tests)) };
}

export async function preparedInterruptionTests(
  record: Interruption,
  cwd: string,
  issue: string,
  intake: TestIntake,
) {
  if (!record.evidence) {
    return [];
  }
  const evidence = hostEvidenceShape.parse(
    JSON.parse(await readReference(record.evidence, intake.records)),
  );
  return Promise.all(
    (evidence.testRecords ?? []).map(async (ref) =>
      readPreparedTestRecord(await readReference(ref, intake.records), issue, cwd, intake),
    ),
  );
}

export async function prepareInterruption(input: {
  dir: string;
  config: Config;
  state: State;
  text: (name: string) => Promise<string>;
  history?: Awaited<ReturnType<typeof verifyHostReturn>>;
  runtimePaths: string[];
  intake: TestIntake;
  cwd: string;
  branch: string;
  runDirectory: string;
  currentSource: string;
  evidenceFile?: string;
}): Promise<Interruption> {
  const { config, state, dir } = input;
  assert(
    !config.reviewReturn && !config.revision,
    '中断復帰自身や公開済み修正の中断を自動再開できません',
  );
  assert(state.source, '中断前sourceの記録がありません');
  for (const name of ['repairLimit', 'reviewLimit', 'modelTimeMs']) {
    assert(
      !(name in config) || Reflect.get(config, name) === null,
      '中断分の不明量・予約を含む有限上限を判定できません',
    );
  }
  await reconcileExecutions({ previousRun: dir, runDirectory: input.runDirectory }, input.cwd, dir);
  const directory = join(dirname(input.runDirectory), `interrupted-observation-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const observations = await observeInterruption(
    { previousRun: dir, branch: input.branch },
    config,
    directory,
    input.runDirectory,
  );
  // 原state自体を保持し、予約・計上済み時間と今回分を分離する。不明量をゼロにしない。
  const prior = input.history;
  assert(Boolean(config.hostReturn) === Boolean(prior), '必要なホスト履歴の照合結果がありません');
  const current = input.currentSource;
  const evidence = input.evidenceFile
    ? await additionalEvidence(input.evidenceFile, dir, input.cwd, current, input.intake.records)
    : undefined;
  assert(
    !prior || evidence || prior.source === current,
    '旧ホスト証拠と現在sourceが異なります。現在sourceに対応する追加証拠が必要です',
  );
  return {
    version: 1,
    oldSource: state.source,
    state: await input.text('verification/state.json'),
    modes: await includeReferenceModes(await modes(dir), [
      ...input.runtimePaths,
      ...(prior?.references ?? []),
      ...(evidence?.references ?? []),
      ...observations.map((ref) => ref.path),
    ]),
    observations,
    ...(evidence ? { evidence: evidence.reference } : {}),
    unknown: '中断区間の時間・usageは未記録。累計は記録済み量の下限',
  };
}

export async function verifyInterruption(input: ReviewReturn, cwd: string, runDirectory: string) {
  const record = input.interruption;
  assert(record);
  assert(
    JSON.stringify(
      await includeReferenceModes(
        await modes(input.previousRun),
        record.modes.map((ref) => ref.path),
      ),
    ) === JSON.stringify(record.modes),
    '旧中断runのモード・記録一覧が変化しました',
  );
  for (const ref of record.observations) {
    await readReference(ref);
  }
  if (record.evidence) {
    assert(
      JSON.stringify(
        (await additionalEvidence(record.evidence.path, input.previousRun, cwd, input.source))
          .reference,
      ) === JSON.stringify(record.evidence),
      '追加証拠が変化しました',
    );
  }
  await reconcileExecutions(
    { previousRun: input.previousRun, runDirectory },
    cwd,
    input.previousRun,
  );
}
