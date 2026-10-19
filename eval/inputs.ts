import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { command } from '../scripts/shared/process.ts';
import type { EvalConfig, EvalCase } from './data.ts';
import { prepareInitialActorInput, initialActorSources } from './initial-input.ts';

type InputConfig = Pick<
  EvalConfig,
  | 'repository'
  | 'before'
  | 'after'
  | 'corpusCommit'
  | 'workspaceCommit'
  | 'workspaceFiles'
  | 'instructionFiles'
  | 'trialOrder'
  | 'model'
  | 'reasoning'
>;

async function git(repo: string, args: string[]) {
  const result = await command(['git', ...args], repo, '', 30000, undefined, {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  assert(
    result.code === 0 && !result.timedOut,
    `Cannot read committed evaluation input: ${args[0]}`,
  );
  return result.stdout;
}

export function blob(repo: string, commit: string, path: string): Promise<string>;
export function blob(
  repo: string,
  commit: string,
  path: string,
  allowAbsent: boolean,
): Promise<string | null>;
export async function blob(repo: string, commit: string, path: string, allowAbsent = false) {
  const entry = await git(repo, ['ls-tree', commit, '--', path]);
  if (allowAbsent && entry === '') {
    return null;
  }
  assert(
    /^100(644|755) blob [a-f0-9]{40}\t/.test(entry) && entry.trimEnd().endsWith(`\t${path}`),
    `Expected regular committed file: ${path}`,
  );
  const text = await git(repo, ['show', `${commit}:${path}`]);
  assert(
    !text.includes('\0') && !text.includes('\uFFFD'),
    `Evaluation input must be UTF-8 text: ${path}`,
  );
  return text;
}

function missingReferences(instructions: string[], files: Record<string, string>) {
  const missing: { source: string; target: string }[] = [];
  for (const source of instructions) {
    // 選択済み指示の通常のインラインリンクだけを確認し、参照先の自動取得はしない。
    const links = files[source]?.matchAll(/\[[^\]\n]*\]\(([^\s()]+)(?:\s+"[^"]*")?\)/g) ?? [];
    const targets = new Set<string>();
    for (const link of links) {
      const path = link[1]?.split(/[?#]/)[0];
      if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path)) {
        continue;
      }
      targets.add(posix.join(posix.dirname(source), path));
    }
    for (const target of targets) {
      if (!Object.hasOwn(files, target)) {
        missing.push({ source, target });
      }
    }
  }
  return missing;
}

function compareActorInputs(
  before: ReturnType<ReturnType<typeof prepareInitialActorInput>>[],
  after: ReturnType<ReturnType<typeof prepareInitialActorInput>>[],
) {
  for (const input of before) {
    const next = after.find((candidate) => candidate.case === input.case);
    assert(
      next &&
        input.prompt.replace(input.repairInstructions, '<repairInstructions>') ===
          next.prompt.replace(next.repairInstructions, '<repairInstructions>') &&
        JSON.stringify(input.schema) === JSON.stringify(next.schema),
      'Initial actor differs outside the compared repair instructions',
    );
  }
}

export async function prepareInputs(
  repo: string,
  config: InputConfig,
  selected: (Omit<EvalCase, 'context'> & { contextBody: string | null })[],
  destination = '/work/repo',
) {
  const remote = (await git(repo, ['remote', 'get-url', 'origin'])).trim();
  assert(
    /^(https:\/\/github\.com\/|git@github\.com:)thkt\/dotagents(?:\.git)?$/.test(remote),
    'Repository origin does not match the plan',
  );
  for (const commit of new Set([
    config.before,
    config.after,
    config.workspaceCommit,
    config.corpusCommit,
  ])) {
    assert(
      (await git(repo, ['cat-file', '-t', commit])).trim() === 'commit',
      'Pinned input must be a commit',
    );
  }
  const runnerRoot = resolve(import.meta.dir, '..');
  const runnerFiles = [
    'data.ts',
    'inputs.ts',
    'light.ts',
    'light-data.ts',
    'light-native.ts',
    'light-processes.ts',
    'light-preflight.ts',
    'eval.ts',
    'initial-input.ts',
    'container.ts',
    'sandbox.ts',
    'report.ts',
    'preflight.ts',
    'preflight-container.ts',
    'preflight-worker.ts',
    'budget.ts',
    'budget-runtime.ts',
    'budget-host.ts',
    '../scripts/shared/process.ts',
    '../scripts/shared/values.ts',
    '../scripts/shared/token-usage.ts',
    '../package.json',
    '../bun.lock',
  ];
  const runtimeSource = await readFile(resolve(import.meta.dir, 'container.ts'), 'utf8');
  const runtimeHash = createHash('sha256').update(runtimeSource).digest('hex');
  const runner = {
    commit: (await git(runnerRoot, ['rev-parse', 'HEAD'])).trim(),
    uncommitted:
      (
        await git(runnerRoot, [
          'status',
          '--porcelain',
          '--',
          'eval',
          'scripts/shared',
          'package.json',
          'bun.lock',
        ])
      ).length > 0,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        runnerFiles.map(
          async (path) =>
            [
              path,
              path === 'container.ts'
                ? runtimeHash
                : createHash('sha256')
                    .update(await readFile(resolve(import.meta.dir, path)))
                    .digest('hex'),
            ] as const,
        ),
      ),
    ),
  };
  const workspaceFiles: Record<string, string> = {};
  const workspaceVersions: Record<string, string> = {};
  for (const path of config.workspaceFiles) {
    workspaceFiles[path] = await blob(repo, config.workspaceCommit, path);
    workspaceVersions[path] = createHash('sha256').update(workspaceFiles[path]).digest('hex');
  }
  const variants = [];
  for (const side of ['before', 'after'] as const) {
    const files = { ...workspaceFiles };
    const versions = { ...workspaceVersions };
    const absentInstructions: { path: string; commit: string; reason: string }[] = [];
    for (const path of config.instructionFiles) {
      const text = await blob(
        repo,
        config[side],
        path,
        side === 'before' &&
          [
            'skills/references/premise-validation.md',
            'skills/references/caller-first-design.md',
            'skills/references/mechanization.md',
          ].includes(path),
      );
      if (text === null) {
        absentInstructions.push({
          path,
          commit: config[side],
          reason: 'ls-tree confirmed absent; no content substituted',
        });
        continue;
      }
      files[path] = text;
      versions[path] = createHash('sha256').update(files[path]).digest('hex');
    }
    const initialCases = selected.filter((item) => item.actor === 'initial-implementation');
    // 同じ条件の計画準備内だけで、検査済みの固定ソース本文とhashを共有する。
    const inputForCase = initialCases.length
      ? prepareInitialActorInput(
          config,
          files,
          await initialActorSources(config, (path) => blob(repo, config[side], path)),
          destination,
        )
      : null;
    const actorInputs = initialCases.map((item) => {
      assert(
        inputForCase && item.contextBody && item.check,
        'Initial actor requires agreed specification and check',
      );
      return inputForCase(item);
    });
    variants.push({
      side,
      commit: config[side],
      files,
      versions,
      absentInstructions,
      actorInputs,
      missingReferences: missingReferences(config.instructionFiles, files),
    });
  }
  const [before, after] = variants;
  assert(before && after, 'Both variants required');
  compareActorInputs(before.actorInputs, after.actorInputs);
  const changedInstructions = config.instructionFiles.filter(
    (path) => before.versions[path] !== after.versions[path],
  );
  assert(changedInstructions.length > 0, 'No relevant instruction changes; evaluation not started');
  return {
    config,
    selected,
    variants,
    changedInstructions,
    runtimeSource,
    runtimeHash,
    runner,
  };
}
