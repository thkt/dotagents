import assert from 'node:assert/strict';
import { lstat, readFile, readdir, readlink, mkdir, realpath } from 'node:fs/promises';
import { z } from 'zod';
import { issueNumber } from '../shared/target.ts';
import { dirname, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialTestReturnShape } from './host-records.ts';
import type { InitialTestReturn } from './host-records.ts';
import { hash } from './record-observation.ts';
import { observeInterruption, observeInterruptedProcess } from './interrupted-records.ts';
import { command } from '../shared/process.ts';
import { reconcileExecutions } from './execution-history.ts';
import { verifyGitLocks } from './git-locks.ts';

// Gitの管理領域と依存物を除き、旧checkout・未採用workspaceを含めて保全する。
async function retainedRecords(
  dir: string,
  managed: boolean,
  workspaces: ReadonlySet<string>,
): Promise<InitialTestReturn['records']> {
  const result: InitialTestReturn['records'] = {};
  const info = await lstat(dir);
  assert(info.isDirectory(), '旧runの保存先は通常ディレクトリが必要です');
  result[dir] = { mode: info.mode, content: '' };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    assert(
      !managed || (entry.name !== 'lock' && !entry.name.endsWith('.lock')),
      `旧runにlockが残っています: ${join(dir, entry.name)}`,
    );
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const path = join(dir, entry.name);
    const value = await lstat(path);
    if (value.isDirectory()) {
      const childManaged = managed && !workspaces.has(path);
      Object.assign(result, await retainedRecords(path, childManaged, workspaces));
    } else {
      assert(value.isFile() || value.isSymbolicLink(), '旧runのファイル種別を照合できません');
      result[path] = {
        mode: value.mode,
        content: value.isSymbolicLink() ? await readlink(path) : hash(await readFile(path)),
      };
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export async function initialTestRecords(dir: string) {
  const workspaces = new Set(
    ['checkout', 'test-baseline', 'test-1-workspace'].map((name) => join(dir, name)),
  );
  return retainedRecords(dir, true, workspaces);
}

export async function unusedTestReturn(previousRun: string, runDirectory: string) {
  for (const entry of await readdir(dirname(previousRun), { withFileTypes: true })) {
    const directory = join(dirname(previousRun), entry.name);
    if (!entry.isDirectory() || directory === runDirectory) {
      continue;
    }
    const content = await readFile(join(directory, 'initial-test-return.json'), 'utf8').catch(
      (error: unknown) => {
        assert(
          error instanceof Error && 'code' in error && error.code === 'ENOENT',
          '既存の復帰記録を照合できません',
        );
        return undefined;
      },
    );
    if (content !== undefined) {
      const returned = initialTestReturnShape.parse(JSON.parse(content));
      assert(
        returned.previousRun !== previousRun,
        'この旧runからの復帰記録が既にあります。再停止・別名起動で再試行できません',
      );
    }
  }
}

async function verifyOldHeads(input: InitialTestReturn) {
  for (const cwd of [
    input.cwd,
    join(input.previousRun, 'test-baseline'),
    join(input.previousRun, 'test-1-workspace'),
  ]) {
    await verifyGitLocks(cwd);
    const result = await command(['git', 'rev-parse', 'HEAD'], cwd, '', 10000);
    assert(
      result.code === 0 && !result.timedOut && result.stdout.trim() === input.head,
      '旧checkout・修正前入力のHEADが変わりました',
    );
  }
  const branch = await command(['git', 'branch', '--show-current'], input.cwd, '', 10000);
  assert(
    branch.code === 0 && !branch.timedOut && branch.stdout.trim() === input.branch,
    '旧checkoutのbranchが変わりました',
  );
}

export function initialTestOwner(
  input: {
    cwd: string;
    hostReturn?: { previousRun: string };
    humanDecisionOwner?: string;
    humanDecision?: { roots: string[] };
  },
  previousRuns?: string[],
) {
  const retainedRuns = [
    ...new Set([...(previousRuns ?? []), ...(input.humanDecision?.roots ?? [])]),
  ];
  if (input.humanDecisionOwner) {
    return {
      entry: '--human-decision-run' as const,
      previousRun: input.humanDecisionOwner,
      cwd: input.cwd,
      previousRuns: retainedRuns,
    };
  }
  return input.hostReturn
    ? {
        entry: '--host-run' as const,
        previousRun: input.hostReturn.previousRun,
        cwd: input.cwd,
        previousRuns: retainedRuns,
      }
    : undefined;
}

export async function verifyInitialTestReturn(
  input: InitialTestReturn,
  runDirectory: string,
  published = false,
  owner?: {
    entry?: '--host-run' | '--human-decision-run';
    previousRun: string;
    cwd: string;
    previousRuns?: string[];
  },
) {
  assert(
    JSON.stringify(await initialTestRecords(input.previousRun)) === JSON.stringify(input.records),
    '旧初回テストrunの内容・モード・記録一覧が変わりました',
  );
  await verifyOldHeads(input);
  await reconcileExecutions({ previousRun: input.previousRun, runDirectory }, input.cwd);
  const directory = join(dirname(runDirectory), `test-observation-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const savedTarget = z
    .object({ cwd: z.string(), config: z.object({ repository: z.string() }) })
    .parse(JSON.parse(await readFile(join(input.previousRun, 'target.json'), 'utf8')));
  const savedResult = z
    .object({ issue: z.string() })
    .parse(JSON.parse(await readFile(join(input.previousRun, 'result.json'), 'utf8')));
  assert(
    isAbsolute(savedTarget.cwd) && (await realpath(savedTarget.cwd)) === savedTarget.cwd,
    '旧ホストの対象rootがcanonicalではありません',
  );
  const initialTarget = {
    cwd: savedTarget.cwd,
    repository: savedTarget.config.repository,
    issue: issueNumber(savedResult.issue, savedTarget.config.repository),
    ...(owner ? { owner: { ...owner, entry: owner.entry ?? ('--host-run' as const) } } : {}),
  };
  const config = { cwd: input.cwd, review: input.actor, targetText: input.targetText };
  const target = { previousRun: input.previousRun, branch: input.branch };
  if (published) {
    await observeInterruptedProcess(
      target,
      config,
      directory,
      runDirectory,
      '--test-run',
      initialTarget,
    );
  } else {
    await observeInterruption(target, config, directory, runDirectory, '--test-run', initialTarget);
  }
}
