import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { command, withInterrupts, assertRunning } from '../process.ts';
import { evalCase, evalConfig, validatePlan } from './skill-eval-data.ts';
import type { EvalConfig } from './skill-eval-data.ts';
import { sandboxTrial } from './skill-eval-sandbox.ts';
import { isRecord } from '../values.ts';
import { writeComparison } from './skill-eval-report.ts';

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

async function blob(repo: string, commit: string, path: string) {
  const entry = await git(repo, ['ls-tree', commit, '--', path]);
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
  const runtimeSource = await readFile(resolve(import.meta.dir, 'skill-eval-container.ts'), 'utf8');
  const runtimeHash = createHash('sha256').update(runtimeSource).digest('hex');
  const cases = z
    .array(evalCase)
    .parse(
      JSON.parse(await blob(repo, config.corpusCommit, 'scripts/skill-eval/corpus/cases.json')),
    );
  const selected = [];
  for (const item of validatePlan(config, cases)) {
    const contextBody = item.context
      ? await blob(repo, config.corpusCommit, `scripts/skill-eval/corpus/${item.context}`)
      : null;
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
    for (const path of config.instructionFiles) {
      files[path] = await blob(repo, config[side], path);
      versions[path] = createHash('sha256').update(files[path]).digest('hex');
    }
    variants.push({ side, commit: config[side], files, versions });
  }
  const [before, after] = variants;
  assert(before && after, 'Both variants required');
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
  await writeFile(resolve(runtime, 'skill-eval-container.ts'), runtimeSource);
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
    }),
  );
  const result = await sandboxTrial(config, runtime, input, expiresAt);
  return { ...result, elapsedMs: performance.now() - started };
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
    const tasks = plan.variants.flatMap((variant) =>
      plan.selected.map((item) => ({ variant, item })),
    );
    for (const { variant, item } of tasks) {
      const trial = `${variant.side}-${item.id}`;
      const dir = resolve(directory, trial);
      await mkdir(dir);
      const pending = {
        trial,
        side: variant.side,
        case: item.id,
        expected: item.expected,
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
        const result = await executeCase(
          config,
          dir,
          variant.files,
          item.prompt,
          remaining,
          item.contextBody,
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
      'Usage: bun scripts/skill-eval/skill-eval.ts plan|run CONFIG | report RUN_DIRECTORY [JUDGMENTS_JSON]',
    );
    if (mode === 'report') {
      await writeComparison(resolve(file), extra ? resolve(extra) : undefined);
    } else {
      assert(mode === 'plan' || mode === 'run', 'Unknown evaluation mode');
      const config = evalConfig.parse(JSON.parse(await readFile(resolve(file), 'utf8')));
      if (mode === 'plan') {
        console.log(JSON.stringify(await preparePlan(process.cwd(), config), null, 2));
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
