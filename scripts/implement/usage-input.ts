import assert from 'node:assert/strict';
import { z } from 'zod';

const text = z.string().trim().min(1);
const id = text.regex(/^[a-zA-Z0-9_.-]+$/);
const commit = text.regex(/^[a-f0-9]{40}$/);
const evaluation = z.strictObject({
  outcome: z.enum(['satisfied', 'unsatisfied', 'unknown']),
  evaluator: text,
  evidence: text,
});
const runShape = z.strictObject({
  id,
  directory: text,
  task: id,
  targetCommit: commit,
  retryOf: id.nullable(),
  evaluation,
});
const comparisonShape = z.strictObject({
  format: z.literal(1),
  conditions: z.strictObject({
    id,
    model: text,
    reasoningEffort: text,
    environment: text,
    evaluationCriteria: text,
    evidence: text,
  }),
  runs: z.array(runShape).min(1),
});
export type Selection = z.infer<typeof comparisonShape>;
export type SelectedRun = z.infer<typeof runShape>;

export function parseSelection(value: unknown) {
  const parsed = comparisonShape.safeParse(value);
  assert(parsed.success, 'Invalid usage selection; consult scripts/README.md');
  const selection = parsed.data;
  const seen = new Map<string, SelectedRun>();
  const tasks = new Map<string, string>();
  for (const run of selection.runs) {
    assert(!seen.has(run.id), 'Duplicate attempt ID');
    const prior = run.retryOf === null ? undefined : seen.get(run.retryOf);
    assert(
      run.retryOf === null || prior?.task === run.task,
      'Retry must reference an earlier selected attempt of the same task',
    );
    assert(!tasks.has(run.task) || run.retryOf !== null, 'Repeated task must identify its retry');
    assert(
      !tasks.has(run.task) || tasks.get(run.task) === run.targetCommit,
      'Task target commit differs within comparison',
    );
    seen.set(run.id, run);
    tasks.set(run.task, run.targetCommit);
  }
  return selection;
}
