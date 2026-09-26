import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseSelection } from './usage-input.ts';
import { readRun } from './usage-records.ts';
import { hash, sumUsage } from './usage-events.ts';

export async function aggregateUsage(value: unknown, base: string) {
  const selection = parseSelection(value);
  const identities = new Set<string>();
  const records: Awaited<ReturnType<typeof readRun>>[] = [];
  for (const selected of selection.runs) {
    records.push(await readRun(selected, base, selection.conditions, identities));
  }
  // Recheck the whole selection after all reads, including changes to earlier runs.
  for (const record of records) {
    await record.unchanged();
  }
  const runs = records.map((record) => record.run);
  const taskSources = new Map<string, string>();
  const taskNames = new Map<string, string>();
  for (const run of runs) {
    const source = JSON.stringify([run.recorded.repository, run.recorded.issue, run.targetCommit]);
    assert(
      !taskSources.has(run.task) || taskSources.get(run.task) === source,
      'Task maps to different recorded requirements',
    );
    assert(
      !taskNames.has(source) || taskNames.get(source) === run.task,
      'Same recorded task assigned multiple task IDs',
    );
    taskSources.set(run.task, source);
    taskNames.set(source, run.task);
  }
  const satisfied = runs.filter((run) => run.evaluation.outcome === 'satisfied');
  const tasks = new Set(runs.map((run) => run.task));
  const satisfiedTasks = [...new Set(satisfied.map((run) => run.task))].sort();
  const observed = sumUsage(runs.flatMap((run) => (run.observed ? [run.observed] : [])));
  const stages = [...new Set(runs.flatMap((run) => run.stages.map((stage) => stage.phase)))]
    .sort()
    .map((phase) => {
      const members = runs.flatMap((run) => run.stages.filter((stage) => stage.phase === phase));
      return {
        phase,
        observed: sumUsage(members.flatMap((stage) => (stage.observed ? [stage.observed] : []))),
        commandMs: members.every((stage) => stage.commandMs !== null)
          ? members.reduce((sum, stage) => sum + (stage.commandMs ?? 0), 0)
          : null,
      };
    });
  return {
    format: 1,
    conditions: selection.conditions,
    measurement:
      'Explicitly selected current implement runs; observed Codex parent turn tokens. Cache is a subset of input. Child usage and external preparation/evaluation usage are not established.',
    counts: {
      attempts: runs.length,
      retries: runs.filter((run) => run.retryOf !== null).length,
      tasks: tasks.size,
      executionFailed: runs.filter((run) => run.executionFailed).length,
      executionUnknown: runs.filter((run) => run.executionUnknown).length,
      evaluationUnknown: runs.filter((run) => run.evaluation.outcome === 'unknown').length,
      unsatisfiedAttempts: runs.filter((run) => run.evaluation.outcome === 'unsatisfied').length,
      satisfiedAttempts: satisfied.length,
      satisfiedTasks: satisfiedTasks.length,
    },
    satisfactionRate: {
      numerator: satisfied.length,
      denominator: runs.length,
      value: satisfied.length / runs.length,
    },
    perSatisfiedTask: {
      numerator: { attemptIds: runs.map((run) => run.id), observed, total: null },
      denominator: { taskIds: satisfiedTasks, count: satisfiedTasks.length },
      value: null,
      reason: 'Incomplete usage scope; no definitive token usage per satisfied task',
    },
    observed,
    total: null,
    elapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0),
    timeScope:
      'Sum of whole-run elapsed durations; stage command sums exclude gaps. Concurrent runs are not a single wall-clock interval.',
    stages,
    runs,
  };
}

if (import.meta.main) {
  try {
    const [input, ...extra] = process.argv.slice(2);
    assert(input && extra.length === 0, 'Usage: bun scripts/implement/usage.ts SELECTION.json');
    const raw = await readFile(resolve(input), 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw Error('Invalid selection JSON');
    }
    const result = await aggregateUsage(value, dirname(resolve(input)));
    console.log(JSON.stringify({ ...result, selectionSha256: hash(raw) }, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'refused',
        reason: error instanceof Error ? error.message : 'Cannot aggregate usage',
      }),
    );
    process.exitCode = 1;
  }
}
