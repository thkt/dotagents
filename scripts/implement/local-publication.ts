import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { lstat, readlink, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assertPreviousConfig, assertState } from './input.ts';
import type { Config, State } from './input.ts';
import { hash } from './record-observation.ts';
import { interruptionReturn, verifyHostReturn } from './host-records.ts';
import { reviewRecoveryRecords, verifyReviewReturn } from './review-recovery-records.ts';
import { verifyReviewedRuntime, verifyRuntimeActor } from './runtime-records.ts';
import { parseReview } from './review.ts';
import { sourceFiles, snapshot } from './correction.ts';
import { verifyTestArtifacts, verifyTestBaseline } from './test-author.ts';
import { issueText } from './issue.ts';
import { verifyCommandContract } from './review-recovery.ts';
import { hasExecutionLock, reconcileExecutions } from './execution-history.ts';
import { verifyGitLocks } from './git-locks.ts';
import { verifyInterruptedProcesses } from './interrupted-processes.ts';
import { isRecord, outside } from '../shared/values.ts';
import type { Reader, readTarget } from '../shared/target.ts';
import type { LocalPublication } from './local-publication-records.ts';

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function nativeReply(root: string, prefix: string, role: string) {
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${role}-codex-`)) {
      continue;
    }
    const actor = await json(join(root, entry.name, 'actor.json'));
    if (
      isRecord(actor) &&
      typeof actor.hostPrefix === 'string' &&
      resolve(root, actor.hostPrefix) === prefix
    ) {
      verifyRuntimeActor(actor, role, entry.name);
      matches.push(join(root, entry.name, 'final.json'));
    }
  }
  assert(matches.length === 1 && matches[0], '真正なnative actor原記録を対応付けられません');
  const stdout = await readFile(`${prefix}.stdout`, 'utf8');
  assert(
    stdout.trim() === (await readFile(matches[0], 'utf8')).trim(),
    'native actor原応答のhash・内容不一致',
  );
  return stdout;
}

function successfulEvent(state: State, role: 'check' | 'review', prefix: string) {
  const event = state.events.findLast((entry) => entry.role === role);
  assert(
    event?.code === 0 &&
      event.timedOut === false &&
      event.source === state.source &&
      event.prefix === prefix &&
      typeof event.ms === 'number' &&
      Number.isFinite(event.ms) &&
      event.ms >= 0,
    `旧${role}の実行結果と受入が一致しません`,
  );
  return event;
}

async function acceptedVerification(dir: string, config: Config, state: State) {
  assert(state.active === null, '旧verificationにactive予約があります');
  assert(
    state.result === 'ready_for_human_review' && state.reviewHistory.at(-1)?.status === 'accepted',
    '旧verificationの独立評価acceptedがありません',
  );
  assert(state.checks > 0 && state.review > 0, '旧check・独立評価が未完了です');
  const check = successfulEvent(state, 'check', join(dir, 'verification', `check-${state.checks}`));
  const prefix = join(dir, 'verification', `review-${state.review}`);
  successfulEvent(state, 'review', prefix);
  const raw = await json(`${prefix}.target.json`);
  assert(isRecord(raw), '旧独立評価の対象がありません');
  const { targetId, ...target } = raw;
  assert(
    targetId === hash(JSON.stringify(target)) &&
      targetId === state.reviewHistory.at(-1)?.targetId &&
      target.source === state.source &&
      hash(JSON.stringify(target.files)) === state.source &&
      target.configHash === state.configHash &&
      target.baseCommit === state.baseCommit &&
      isRecord(target.issue) &&
      target.issue.hash === state.issueHash &&
      typeof target.issue.content === 'string' &&
      hash(target.issue.content) === state.issueHash &&
      JSON.stringify(target.tests) === JSON.stringify(state.testRecords),
    '旧独立評価の対象hash不一致',
  );
  assert(isRecord(target.check), '旧check記録がありません');
  assert(
    target.check.prefix === check.prefix &&
      target.check.code === 0 &&
      target.check.timedOut === false &&
      target.check.ms === check.ms &&
      target.check.source === state.source &&
      JSON.stringify(target.check.command) === JSON.stringify(config.check) &&
      target.check.stdoutHash === hash(await readFile(`${check.prefix}.stdout`)) &&
      target.check.stderrHash === hash(await readFile(`${check.prefix}.stderr`)),
    '旧check原記録のhash不一致',
  );
  const reply = await nativeReply(dir, prefix, 'review');
  const accepted = parseReview(reply, String(targetId), state.review, state.reviewHistory.at(-2));
  assert.deepStrictEqual(
    accepted,
    state.reviewHistory.at(-1),
    '旧独立評価の原応答と受入が一致しません',
  );
  await verifyReviewedRuntime(state);
  for (const event of state.events) {
    if (event.code === 0 && !event.timedOut && ['repair', 'test'].includes(event.role)) {
      await nativeReply(dir, event.prefix, event.role);
    }
  }
  assert(config.testBaseline, '旧独立テストbaselineがありません');
  await verifyTestBaseline(config.testBaseline);
  await verifyTestArtifacts(config.cwd, state.testRecords ?? []);
  assert(
    config.baseCommit === state.baseCommit && state.configHash === hash(JSON.stringify(config)),
    '旧verification設定hashが一致しません',
  );
}

async function successfulImplementation(root: string) {
  await nativeReply(root, join(root, 'implementation'), 'repair');
  const execution = await json(join(root, 'implementation.json'));
  assert(
    isRecord(execution) &&
      execution.code === 0 &&
      execution.timedOut === false &&
      typeof execution.ms === 'number' &&
      Number.isFinite(execution.ms) &&
      execution.ms >= 0,
    '旧初回実装の実行結果を成功として照合できません',
  );
}

async function originHistory(dir: string, config: Config) {
  const roots = [dir];
  const references: string[] = [];
  if (config.hostReturn) {
    const verified = await verifyHostReturn(config.hostReturn, config.cwd);
    roots.push(...verified.previousRuns);
    references.push(...verified.references);
  }
  if (config.reviewReturn) {
    await verifyReviewReturn(
      config.reviewReturn,
      config.cwd,
      config.runDir,
      undefined,
      undefined,
      undefined,
      true,
    );
    roots.push(config.reviewReturn.previousRun);
    references.push(...config.reviewReturn.records.map((ref) => ref.path));
  }
  return { roots: [...new Set(roots)], references: [...new Set(references)] };
}

async function originRecords(roots: string[], references: string[]) {
  const found = new Map<string, { path: string; sha256: string; mode: number }>();
  for (const path of [...roots, ...references]) {
    if (found.has(path)) {
      continue;
    }
    const info = await lstat(path);
    if (info.isFile()) {
      found.set(path, { path, sha256: hash(await readFile(path)), mode: info.mode });
    } else {
      assert(info.isDirectory(), '旧実装の来歴に未対応の種別があります');
      for (const ref of await localRecords(path)) {
        if (!found.has(ref.path)) {
          found.set(ref.path, ref);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function acceptedOrigins(dir: string, config: Config) {
  const history = await originHistory(dir, config);
  const captureRoots = [
    ...new Set(
      history.roots.map((root) =>
        basename(root) === 'implementation.stdout' ? dirname(root) : root,
      ),
    ),
  ];
  const records = await originRecords(captureRoots, history.references);
  for (const root of history.roots) {
    if (basename(root) === 'implementation.stdout') {
      assert(
        records.some((ref) => ref.path === root),
        '旧実装の参照は通常ファイルである必要があります',
      );
    }
  }
  await originHistory(dir, config);
  const implemented = [
    ...new Set(
      history.roots.flatMap((root) => {
        const run = basename(root) === 'implementation.stdout' ? dirname(root) : root;
        return records.some((ref) => ref.path === join(run, 'implementation.stdout')) ? [run] : [];
      }),
    ),
  ];
  assert(implemented.length > 0, '真正な初回実装の原記録がありません');
  for (const root of implemented) {
    await successfulImplementation(root);
  }
  return { ...history, records, captureRoots };
}

async function configurationTracking(local: string, published: string, base: string, read: Reader) {
  const original = await read(['git', 'ls-tree', base, '--', '.dotagents.json'], local);
  const tracked = await read(['git', 'ls-files', '--stage', '--', '.dotagents.json'], local);
  const current = await read(['git', 'ls-tree', 'HEAD', '--', '.dotagents.json'], published);
  assert(
    Boolean(original) === Boolean(tracked) && Boolean(original) === Boolean(current),
    '対象configの追跡状態が不一致です',
  );
  if (original) {
    assert(original === current, '対象configのcommit blob・modeが不一致です');
  }
}

async function committedArtifacts(cwd: string, head: string, base: string, read: Reader) {
  await read(['git', 'cat-file', '-e', `${base}^{commit}`], cwd);
  const filesBefore = await sourceFiles(cwd);
  const source = hash(JSON.stringify(filesBefore));
  const tree = await read(['git', 'ls-tree', '-rz', '--full-tree', head], cwd);
  const entries = new Map(
    tree
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        assert(match?.[1] && match[2] && match[3], 'commit treeに未対応の成果物があります');
        return [match[3], { mode: parseInt(match[1], 8), blob: match[2] }] as const;
      }),
  );
  const files = filesBefore.filter(([name]) => name !== '.dotagents.json' || entries.has(name));
  assert(entries.size === files.length, 'commit treeと受入成果物の収録が一致しません');
  for (const [name, mode] of files) {
    const entry = entries.get(name);
    assert(entry, `受入成果物がcommit treeに収録されていません: ${name}`);
    const gitMode = (mode & 0o170000) === 0o120000 ? 0o120000 : mode & 0o111 ? 0o100755 : 0o100644;
    assert(entry.mode === gitMode, `commit treeのmode不一致: ${name}`);
    if (gitMode === 0o120000) {
      const link = Buffer.from(await readlink(join(cwd, name)));
      const blob = createHash(entry.blob.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${link.length}\0`)
        .update(link)
        .digest('hex');
      assert(blob === entry.blob, `commit treeのsymlink内容不一致: ${name}`);
    } else {
      const content = await read(['git', 'hash-object', '--no-filters', '--', name], cwd);
      assert(content === entry.blob, `commit treeの内容不一致: ${name}`);
    }
  }
  assert(
    !(await read(
      [
        'git',
        '-c',
        'core.filemode=true',
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        '.',
        ':(top,exclude).dotagents.json',
      ],
      cwd,
    )),
    '公開checkoutに未収録・変更された成果物があります',
  );
  assert(source === (await snapshot(cwd)), 'commit収録の照合中に成果物が変わりました');
  return source;
}

async function localRecords(dir: string) {
  return Promise.all(
    (await reviewRecoveryRecords(dir)).map(async (ref) => ({
      ...ref,
      mode: (await lstat(ref.path)).mode,
    })),
  );
}

export async function adoptLocalRun(input: {
  directory: string;
  url: string;
  runDirectory: string;
  cwd: string;
  issue: string;
  head: string;
  target: Awaited<ReturnType<typeof readTarget>>;
  read: Reader;
}) {
  const { cwd, read, target } = input;
  const dir = await realpath(input.directory);
  assert(outside(dir, resolve(input.runDirectory)), '採用先は旧runの外に必要です');
  assert(!(await hasExecutionLock(dir)), '旧runに管理lockがあります');
  const records = await localRecords(dir);
  const result = await json(join(dir, 'result.json'));
  const config = await json(join(dir, 'verification-config.json'));
  const state = await json(join(dir, 'verification/state.json'));
  const savedTarget = await json(join(dir, 'target.json'));
  assertPreviousConfig(config);
  try {
    assertState(state);
  } catch (error) {
    throw new Error('旧verificationの受入記録が不正です', { cause: error });
  }
  assert(isRecord(result) && isRecord(savedTarget), '旧ローカルrun記録が不正です');
  assert(result.terminal === true, '旧runが終端ではありません');
  assert(
    result.status === 'verified_local' &&
      result.localOnly === true &&
      result.publication === 'not_attempted' &&
      result.phase === 'verification',
    '旧runはローカル受入の未公開終端ではありません',
  );
  assert(
    result.evidence === dir &&
      config.runDir === join(dir, 'verification') &&
      result.checkout === config.cwd,
    '旧runの所有checkout・保存先不一致',
  );
  assert(
    result.repository === target.config.repository &&
      result.issue === `https://github.com/${target.config.repository}/issues/${input.issue}` &&
      savedTarget.text === target.text &&
      savedTarget.actor === target.actor &&
      savedTarget.repositoryId === target.repositoryId &&
      config.targetText === target.text,
    '旧対象設定・repository・Issue・actorの不一致',
  );
  verifyCommandContract(config, target);
  const original = await readFile(join(dir, 'issue.json'), 'utf8');
  assert(
    issueText(original) === original && state.issueHash === hash(original),
    '旧Issueの原記録hash不一致',
  );
  const localCheckout = await realpath(config.cwd);
  assert(
    localCheckout === config.cwd &&
      result.branch === (await read(['git', 'branch', '--show-current'], localCheckout)),
    '旧checkout・branch不一致',
  );
  await verifyGitLocks(localCheckout);
  await verifyGitLocks(cwd);
  for (const field of ['repairLimit', 'reviewLimit', 'modelTimeMs']) {
    assert(
      !Reflect.has(config, field) || Reflect.get(config, field) === null,
      '旧runの有限上限を採用入口で解除できません',
    );
  }
  assert(typeof result.startCommit === 'string', '旧差分基準がありません');
  await configurationTracking(config.cwd, cwd, result.startCommit, read);
  await acceptedVerification(dir, config, state);
  const origins = await acceptedOrigins(dir, config);
  const source = await snapshot(localCheckout);
  assert(source === state.source, '受入sourceと旧成果物の内容・全modeが不一致です');
  const branch = await read(['git', 'branch', '--show-current'], cwd);
  assert(branch.trim(), '公開checkoutのbranchを照合できません');
  assert(
    (await committedArtifacts(cwd, input.head, state.baseCommit, read)) === source,
    'commit treeの成果物sourceが不一致です',
  );
  const reconciled = interruptionReturn(config);
  await reconcileExecutions(
    { previousRun: dir, runDirectory: resolve(input.runDirectory) },
    localCheckout,
    reconciled?.interruption ? reconciled.previousRun : undefined,
  );
  const processes = await read(['ps', '-axo', 'pid=,ppid=,lstart=,command='], cwd);
  await verifyInterruptedProcesses(processes, {
    previousRun: dir,
    runDirectory: resolve(input.runDirectory),
    review: config.review,
    check: config.check,
    entry: '--adopt-local-run',
  });
  const currentOrigins = await originRecords(origins.captureRoots, origins.references);
  assert.deepStrictEqual(
    currentOrigins,
    origins.records,
    '採用照合中に祖先原記録の一覧・hash・modeが変わりました',
  );
  assert.deepStrictEqual(
    currentOrigins.filter((ref) => !outside(dir, ref.path)),
    records,
    '採用照合中に旧原記録のhash・modeが変わりました',
  );
  for (const ref of origins.records) {
    if (!records.some((original) => original.path === ref.path)) {
      records.push(ref);
    }
  }
  await verifyGitLocks(localCheckout);
  await verifyGitLocks(cwd);
  const localPublication: LocalPublication = {
    kind: 'adopted_local_publication',
    previousRun: dir,
    localCheckout,
    publishedCheckout: cwd,
    source,
    head: input.head,
    branch,
    url: input.url,
    authorization: true,
    records,
  };
  return {
    dir,
    result,
    config,
    state,
    url: input.url,
    head: input.head,
    branch,
    body: '採用対象の本文を読み取る',
    localPublication,
  };
}
