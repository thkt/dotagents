import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { withInterrupts, assertRunning } from '../scripts/shared/process.ts';
import { evalCase, evalConfig, validatePlan } from './data.ts';
import type { EvalConfig } from './data.ts';
import { blob, prepareInputs } from './inputs.ts';
import { preflight, requireCompatibilityProof } from './preflight.ts';
import { sandboxTrial } from './sandbox.ts';
import { isRecord } from '../scripts/shared/values.ts';
import { writeComparison } from './report.ts';
import { createBudgetRun, stageBudgetSources } from './budget-host.ts';
import { priceProfile, profileHash } from './budget.ts';

function moneyPlan(config: EvalConfig) {
  return config.budget ? { profile: priceProfile, profileHash, conditions: config.budget } : null;
}
function moneyStop(budget?: Awaited<ReturnType<typeof createBudgetRun>>) {
  return (
    budget?.state.error ?? (budget?.state.snapshot.stopped ? budget.state.snapshot.reason : null)
  );
}

export async function preparePlan(repo: string, config: EvalConfig) {
  const cases = z
    .array(evalCase)
    .parse(JSON.parse(await blob(repo, config.corpusCommit, 'eval/corpus/cases.json')));
  const selected = validatePlan(config, cases).map(({ context, ...item }) => ({
    ...item,
    contextBody: context ? `${JSON.stringify(context, null, 2)}\n` : null,
  }));
  const inputs = await prepareInputs(repo, config, selected);
  return {
    ...inputs,
    config,
    money: moneyPlan(config),
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
  budget?: Awaited<ReturnType<typeof createBudgetRun>>,
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
      budgetRequired: Boolean(config.budget),
      maxOutputTokens: config.maxOutputTokens,
      expiresAt,
      prompt,
      responseSchema,
      cliVersion: config.cliVersion,
      bunVersion: config.bunVersion,
      gitVersion: config.gitVersion,
    }),
  );
  await stageBudgetSources(runtime);
  await budget?.delegate(runtime, expiresAt);
  const result = await sandboxTrial(config, runtime, input, expiresAt);
  await budget?.recover(runtime);
  return { ...result, elapsedMs: performance.now() - started };
}

async function executePlannedCase(
  config: EvalConfig,
  dir: string,
  variant: Awaited<ReturnType<typeof preparePlan>>['variants'][number],
  item: Awaited<ReturnType<typeof preparePlan>>['selected'][number],
  remaining: number,
  runtimeSource: string,
  budget?: Awaited<ReturnType<typeof createBudgetRun>>,
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
    budget,
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
    const budget = config.budget ? await createBudgetRun(directory, config.budget) : undefined;
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
          budget,
        );
        Object.assign(pending, result);
        error = cleanupError(result.safety) ?? moneyStop(budget);
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
