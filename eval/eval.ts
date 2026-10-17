import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import { z } from 'zod';
import { command, withInterrupts, assertRunning } from '../scripts/shared/process.ts';
import { evalCase, evalConfig, validatePlan } from './data.ts';
import type { EvalConfig, EvalCase } from './data.ts';
import { prepareInitialActorInput, initialActorSources } from './initial-input.ts';
import { preflight, requireCompatibilityProof } from './preflight.ts';
import { sandboxTrial } from './sandbox.ts';
import { isRecord } from '../scripts/shared/values.ts';
import { writeComparison } from './report.ts';

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

function blob(repo: string, commit: string, path: string): Promise<string>;
function blob(
  repo: string,
  commit: string,
  path: string,
  allowAbsent: boolean,
): Promise<string | null>;
async function blob(repo: string, commit: string, path: string, allowAbsent = false) {
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

export async function preparePlan(repo: string, config: EvalConfig) {
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
    'eval.ts',
    'initial-input.ts',
    'container.ts',
    'sandbox.ts',
    'report.ts',
    'preflight.ts',
    'preflight-container.ts',
    'preflight-worker.ts',
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
  const cases = z
    .array(evalCase)
    .parse(JSON.parse(await blob(repo, config.corpusCommit, 'eval/corpus/cases.json')));
  const selected: (Omit<EvalCase, 'context'> & { contextBody: string | null })[] = [];
  for (const { context, ...item } of validatePlan(config, cases)) {
    const contextBody = context ? `${JSON.stringify(context, null, 2)}\n` : null;
    selected.push({ ...item, contextBody });
  }
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
    effectiveLaunch: {
      isolation: 'verified-eval-docker',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: 'disabled',
      multiAgent: false,
      ignoreUserConfig: true,
      ignoreRules: true,
      ephemeral: true,
      network: 'isolated-gateway-only',
      writable: ['/work', '/tmp'],
      cliVersion: config.cliVersion,
      image: config.image,
    },
    selected,
    variants,
    changedInstructions,
    runtimeSource,
    runtimeHash,
    runner,
    corpusHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
  };
}

async function outputDirectory(repo: string, path: string) {
  assert(isAbsolute(path), 'Absolute evidence directory required');
  const parent = await realpath(dirname(path));
  const dir = resolve(parent, path.split('/').at(-1) ?? '');
  const rel = relative(await realpath(repo), dir);
  assert(rel.startsWith('../'), 'Evidence must be outside the repository');
  assert(!dir.includes(','), 'Docker bind paths cannot contain commas');
  await mkdir(dir, { mode: 0o700 }); // Exclusive: never resume or overwrite a previous run.
  return dir;
}

async function stage(input: string, files: Record<string, string>) {
  await mkdir(input, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    const target = resolve(input, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

function cleanupError(safety: { containersRemoved: boolean; networkRemoved: boolean }) {
  return safety.containersRemoved && safety.networkRemoved
    ? null
    : 'Isolation cleanup unconfirmed; reconcile containers.json before any new evaluation';
}

async function executeCase(
  config: EvalConfig,
  dir: string,
  files: Record<string, string>,
  prompt: string,
  remaining: number,
  contextBody: string | null,
  runtimeSource: string,
  responseSchema?: Record<string, unknown>,
) {
  assertRunning();
  const started = performance.now();
  const expiresAt = Date.now() + Math.min(config.caseTimeMs, remaining);
  const runtime = resolve(dir, 'runtime');
  await mkdir(runtime);
  const input = resolve(dir, 'input');
  await stage(input, contextBody ? { ...files, 'evaluation-issue.json': contextBody } : files);
  if (contextBody) {
    prompt += '\n\nIssueの固定した公開本文: /work/repo/evaluation-issue.json';
  }
  await writeFile(resolve(runtime, 'container.ts'), runtimeSource);
  assert(expiresAt > Date.now(), 'Time budget exhausted during input preparation');
  await writeFile(
    resolve(runtime, 'settings.json'),
    JSON.stringify({
      model: config.model,
      reasoning: config.reasoning,
      maxRequests: config.maxModelRequestsPerCase,
      maxOutputTokens: config.maxOutputTokens,
      expiresAt,
      prompt,
      responseSchema,
      cliVersion: config.cliVersion,
      bunVersion: config.bunVersion,
      gitVersion: config.gitVersion,
    }),
  );
  const result = await sandboxTrial(config, runtime, input, expiresAt);
  return { ...result, elapsedMs: performance.now() - started };
}

async function executePlannedCase(
  config: EvalConfig,
  dir: string,
  variant: Awaited<ReturnType<typeof preparePlan>>['variants'][number],
  item: Awaited<ReturnType<typeof preparePlan>>['selected'][number],
  remaining: number,
  runtimeSource: string,
) {
  const actor = variant.actorInputs.find((input) => input.case === item.id);
  return executeCase(
    config,
    dir,
    actor ? { ...variant.files, ...actor.files } : variant.files,
    actor?.prompt ?? item.prompt,
    remaining,
    actor ? null : item.contextBody,
    runtimeSource,
    actor?.schema,
  );
}

function selectionExpectation(item: { actor?: string; expected: string }) {
  return item.actor ? 'boundary' : item.expected;
}

function requireCommittedRunner(plan: Awaited<ReturnType<typeof preparePlan>>) {
  assert(
    !plan.selected.some((item) => item.actor) || !plan.runner.uncommitted,
    'Behavior evaluation requires a committed runner before model launch',
  );
}

function orderedTasks(plan: Awaited<ReturnType<typeof preparePlan>>) {
  const tasks = plan.variants.flatMap((variant) =>
    plan.selected.map((item) => ({ variant, item })),
  );
  return (
    plan.config.trialOrder?.map((trial) => {
      const task = tasks.find(({ variant, item }) => trial === `${variant.side}-${item.id}`);
      assert(task, 'Invalid planned trial');
      return task;
    }) ?? tasks
  );
}

export async function runEvaluation(repo: string, config: EvalConfig) {
  const directory = await outputDirectory(repo, config.outputDirectory);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const records: unknown[] = [];
  let error: string | null = null;
  let evaluationStarted = started;
  let preparationMs = 0;
  try {
    const plan = await preparePlan(repo, config);
    await writeFile(resolve(directory, 'plan.json'), JSON.stringify(plan, null, 2));
    requireCommittedRunner(plan);
    await requireCompatibilityProof(plan);
    preparationMs = performance.now() - started;
    evaluationStarted = performance.now();
    // All case IDs, limits and disclosure are printed before any model can start.
    console.log(
      JSON.stringify({
        cases: config.cases,
        before: config.before,
        after: config.after,
        maxTrials: config.maxTrials,
        caseTimeMs: config.caseTimeMs,
        totalTimeMs: config.totalTimeMs,
        maxModelRequests: config.maxTrials * config.maxModelRequestsPerCase,
        disclosure: config.disclosure,
      }),
    );
    const tasks = orderedTasks(plan);
    for (const { variant, item } of tasks) {
      const trial = `${variant.side}-${item.id}`;
      const dir = resolve(directory, trial);
      await mkdir(dir);
      const pending = {
        trial,
        side: variant.side,
        case: item.id,
        expected: selectionExpectation(item),
        actor: item.actor,
        selection: 'unknown',
        outcome: 'indeterminate',
        execution: 'unevaluated',
        launched: false,
        reason: 'Not started',
        elapsedMs: null,
        usage: null,
      };
      records.push(pending);
      await writeFile(
        resolve(directory, 'evaluation.json'),
        JSON.stringify({ startedAt, config, records }, null, 2),
      );
      const remaining = config.totalTimeMs - (performance.now() - evaluationStarted);
      if (remaining <= 0 || error) {
        Object.assign(pending, { reason: error ?? 'Total time budget exhausted' });
        continue;
      }
      try {
        const result = await executePlannedCase(
          config,
          dir,
          variant,
          item,
          remaining,
          plan.runtimeSource,
        );
        Object.assign(pending, result);
        error = cleanupError(result.safety);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Interrupted or failed';
        Object.assign(pending, { reason: error });
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Plan rejected';
  }
  const result = {
    startedAt,
    endedAt: new Date().toISOString(),
    config,
    records,
    error,
    elapsedMs: performance.now() - started,
    retries: 0,
    preparationMs,
    conditionLimits: [
      'Isolated Linux container; not the historical macOS registration or #183 environment.',
      'No GitHub credentials or direct network; unavailable dependencies and external workflow outcomes remain indeterminate.',
      'Parent CLI usage, child totals and billing require separate reconciliation. No improvement rate inferred.',
    ],
  };
  await writeFile(resolve(directory, 'evaluation.json'), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) {
  try {
    const [mode, file, extra] = process.argv.slice(2);
    assert(
      file,
      'Usage: bun eval/eval.ts plan|preflight|run CONFIG | report RUN_DIRECTORY [JUDGMENTS_JSON]',
    );
    if (mode === 'report') {
      await writeComparison(resolve(file), extra ? resolve(extra) : undefined);
    } else {
      assert(mode === 'plan' || mode === 'preflight' || mode === 'run', 'Unknown evaluation mode');
      const config = evalConfig.parse(JSON.parse(await readFile(resolve(file), 'utf8')));
      if (mode === 'plan') {
        console.log(JSON.stringify(await preparePlan(process.cwd(), config), null, 2));
      } else if (mode === 'preflight') {
        const plan = await preparePlan(process.cwd(), config);
        const directory = await outputDirectory(process.cwd(), config.outputDirectory);
        try {
          const result = await preflight(config, plan, directory);
          if (result.error) {
            process.exitCode = 1;
          }
        } catch (cause) {
          await writeFile(
            resolve(directory, 'preflight.json'),
            JSON.stringify(
              {
                status: 'unavailable',
                error: cause instanceof Error ? cause.message : 'Preflight unavailable',
                records: [],
                runner: plan.runner,
                runtimeHash: plan.runtimeHash,
              },
              null,
              2,
            ),
          );
          throw cause;
        }
      } else {
        const result = await withInterrupts(() => runEvaluation(process.cwd(), config));
        if (
          result.error ||
          result.records.some((record) => !isRecord(record) || record.execution !== 'completed')
        ) {
          process.exitCode = 1;
        }
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Evaluation failed');
    process.exitCode = 1;
  }
}
