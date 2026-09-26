import { expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { aggregateUsage } from '../../implement/usage.ts';
import { readUsageEvents } from '../../implement/usage-events.ts';

const usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 };
const turn = [{ type: 'turn.started' }, { type: 'turn.completed', usage }];
const events = (thread: string, turns = turn) =>
  [{ type: 'thread.started', thread_id: thread }, ...turns]
    .map((event) => JSON.stringify(event))
    .join('\n') + '\n';
const commit = 'a'.repeat(40);
const conditions = {
  id: 'same-conditions',
  model: 'fixture-model',
  reasoningEffort: 'high',
  environment: 'Fixed CLI, harness, tools and task inputs in fixture',
  evaluationCriteria: 'Independent artifact checks against agreed requirements',
  evidence: 'fixture conditions',
};
const evaluation = (outcome: 'satisfied' | 'unsatisfied' | 'unknown') => ({
  outcome,
  evaluator: 'independent-evaluator',
  evidence: 'fixture artifact assertions; not runtime acceptance',
});

async function runFixture(base: string, id: string, failed = false) {
  const root = join(base, id);
  await mkdir(join(root, 'verification'), { recursive: true });
  const result = {
    status: failed ? 'stopped' : 'verified_local',
    phase: 'verification',
    operation: 'review',
    reason: failed ? 'model process failed' : 'local verification',
    nextAction: 'human review',
    repository: 'team/project',
    issue: 'https://github.com/team/project/issues/1',
    startCommit: commit,
    evidence: root,
    startedAt: '2026-09-26T00:00:00.000Z',
    finishedAt: '2026-09-26T00:00:10.000Z',
    terminal: true,
    remaining: ['human_review'],
  };
  const state = {
    reviewFormat: 4,
    issueFormat: 1,
    baseCommit: commit,
    reviewHistory: [],
    configHash: 'config',
    issueHash: 'issue',
    repair: 1,
    review: 1,
    checks: 1,
    modelMs: 50,
    active: null,
    events: [
      {
        role: 'check',
        prefix: join(root, 'verification/check-1'),
        code: 0,
        timedOut: false,
        ms: 30,
      },
      {
        role: 'repair',
        prefix: join(root, 'verification/repair-1'),
        code: failed ? 7 : 0,
        timedOut: false,
        ms: 20,
      },
      {
        role: 'review',
        prefix: join(root, 'verification/review-1'),
        code: 0,
        timedOut: false,
        ms: 30,
      },
    ],
  };
  await writeFile(join(root, 'result.json'), JSON.stringify(result));
  await writeFile(
    join(root, 'implementation.json'),
    JSON.stringify({ code: 0, timedOut: false, ms: 50 }),
  );
  await writeFile(join(root, 'verification/state.json'), JSON.stringify(state));
  for (const [directory, prefix, role] of [
    ['arbitrary-a', 'implementation', 'repair'],
    ['arbitrary-b', 'verification/repair-1', 'repair'],
    ['arbitrary-c', 'verification/review-1', 'review'],
  ] as const) {
    await mkdir(join(root, directory));
    await writeFile(
      join(root, directory, 'actor.json'),
      JSON.stringify({
        recordFormat: 1,
        invocationId: randomUUID(),
        role,
        hostPrefix: prefix,
        model: conditions.model,
        reasoningEffort: conditions.reasoningEffort,
        sandbox: role === 'repair' ? 'workspace-write' : 'read-only',
        ignoreUserConfig: true,
      }),
    );
    await writeFile(join(root, directory, 'events.jsonl'), events(`${id}-${directory}`));
  }
  return { root, result, state };
}
const selected = (
  id: string,
  retryOf: string | null,
  outcome: 'satisfied' | 'unsatisfied' | 'unknown',
) => ({
  id,
  directory: id,
  task: 'task-one',
  targetCommit: commit,
  retryOf,
  evaluation: evaluation(outcome),
});

async function withFixture(action: (base: string) => Promise<void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'usage-test-')));
  try {
    await action(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('current runs retain failed attempts/retries in numerator and count independently satisfied tasks once', async () => {
  await withFixture(async (base) => {
    await runFixture(base, 'failed', true);
    await runFixture(base, 'retry');
    await runFixture(base, 'repeat');
    const selection = {
      format: 1,
      conditions,
      runs: [
        selected('failed', null, 'unknown'),
        selected('retry', 'failed', 'satisfied'),
        selected('repeat', 'retry', 'satisfied'),
      ],
    };
    const report = await aggregateUsage(selection, base);
    expect(await aggregateUsage(selection, base)).toEqual(report);
    expect(report.counts).toEqual({
      attempts: 3,
      retries: 2,
      tasks: 1,
      executionFailed: 1,
      executionUnknown: 0,
      evaluationUnknown: 1,
      unsatisfiedAttempts: 0,
      satisfiedAttempts: 2,
      satisfiedTasks: 1,
    });
    expect(report.perSatisfiedTask.numerator.attemptIds).toEqual(['failed', 'retry', 'repeat']);
    expect(report.perSatisfiedTask.denominator).toEqual({ taskIds: ['task-one'], count: 1 });
    expect(report.observed).toEqual({
      input_tokens: 900,
      cached_input_tokens: 720,
      output_tokens: 90,
    });
    expect(report.stages.find((stage) => stage.phase === 'implementation')).toMatchObject({
      observed: { input_tokens: 300 },
      commandMs: 150,
    });
    expect(report.stages.find((stage) => stage.phase === 'repair')).toMatchObject({
      observed: { input_tokens: 300 },
      commandMs: 60,
    });
    expect(report.elapsedMs).toBe(30000);
    expect(report.total).toBeNull();
    expect(report.perSatisfiedTask.value).toBeNull();
    for (const run of report.runs) {
      for (const ref of run.references) {
        expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(ref.path.startsWith('/')).toBe(false);
      }
      expect(run.actors[0]?.turns[0]).toMatchObject({ line: 3, ordinal: 1, usage });
      expect(run.problems).toContain(
        'Child-model usage inclusion is unverified; whole-run totals and token ratios withheld',
      );
    }
  });
});

test('equal usage in separate turns is retained; missing, invalid and duplicate lifecycle events do not become zero', () => {
  expect(readUsageEvents(events('thread', [...turn, ...turn])).observed).toEqual({
    input_tokens: 200,
    cached_input_tokens: 160,
    output_tokens: 20,
  });
  const cases: [string, string][] = [
    ['', 'Missing thread identity'],
    [events('thread', [{ type: 'turn.started' }]), 'Unfinished turn'],
    [
      events('thread', [{ type: 'turn.started' }, { type: 'turn.completed' }]),
      'Missing or invalid turn usage',
    ],
    [
      events('thread', [
        { type: 'turn.started' },
        { type: 'turn.completed', usage: { ...usage, cached_input_tokens: 101 } },
      ]),
      'Missing or invalid turn usage',
    ],
    [
      events('thread', [...turn, { type: 'turn.completed', usage }]),
      'Duplicate or unmatched turn completion',
    ],
    [events('thread') + '{broken\n', 'Invalid JSON'],
    [
      events('thread', [{ type: 'turn.started' }, { type: 'turn.failed' }]),
      'Failed turn has no complete usage',
    ],
  ];
  for (const [raw, reason] of cases) {
    expect(readUsageEvents(raw).problems.join('\n')).toContain(reason);
  }
  expect(readUsageEvents('').observed).toBeNull();
  const replay = readUsageEvents(events('thread') + events('thread'));
  expect(replay.problems.join('\n')).toContain('Duplicate or invalid thread identity');
  expect(replay.observed).toEqual(usage);
});

test('CI failures and unconfirmed CI outcomes remain separate from independent evaluation', async () => {
  await withFixture(async (base) => {
    const { root, result } = await runFixture(base, 'local');
    const input = { format: 1, conditions, runs: [selected('local', null, 'unknown')] };
    for (const [phase, ci, failed, unknown] of [
      ['verification', undefined, 0, 0],
      ['ci', undefined, 0, 1],
      ['ci', 'passed', 0, 0],
      ['ci', 'failed', 1, 0],
      ['ci', 'timed_out', 0, 1],
      ['ci', 'unavailable', 0, 1],
      ['ci', 'invalid_response', 0, 1],
      ['ci', 'storage_failed', 0, 1],
      ['ci', 'target_changed', 0, 1],
    ] as const) {
      await writeFile(
        join(root, 'result.json'),
        JSON.stringify({
          ...result,
          status: phase === 'ci' ? 'stopped' : result.status,
          phase,
          ci,
        }),
      );
      const report = await aggregateUsage(input, base);
      expect({ phase, ci, ...report.counts }).toMatchObject({
        phase,
        ci,
        executionFailed: failed,
        executionUnknown: unknown,
        evaluationUnknown: 1,
        satisfiedTasks: 0,
      });
      expect(report.runs[0]?.recorded.ci).toBe(ci ?? null);
    }
  });
});

test('all selected records are rechecked after later runs have been read', async () => {
  await withFixture(async (base) => {
    const first = await runFixture(base, 'first');
    const second = await runFixture(base, 'second');
    const input = {
      format: 1,
      conditions,
      runs: [selected('first', null, 'unknown'), selected('second', 'first', 'unknown')],
    };
    expect((await aggregateUsage(input, base)).counts.attempts).toBe(2);
    const originalRead = fs.readFile;
    let changed = false;
    const read = spyOn(fs, 'readFile').mockImplementation(
      new Proxy(originalRead, {
        async apply(target, _receiver, args: Parameters<typeof fs.readFile>) {
          if (args[0] === join(second.root, 'result.json') && !changed) {
            await writeFile(
              join(first.root, 'result.json'),
              JSON.stringify({ ...first.result, reason: 'changed during later run read' }),
            );
            changed = true;
          }
          return target(...args);
        },
      }),
    );
    try {
      await assert.rejects(
        aggregateUsage(input, base),
        /Record changed during aggregation: result.json/,
      );
    } finally {
      read.mockRestore();
      expect(changed).toBe(true);
    }
  });
});

test('actor discovery shares one verification listing for direct and nested evidence', async () => {
  await withFixture(async (base) => {
    const { root } = await runFixture(base, 'local');
    for (const file of ['events.jsonl', 'actor.json']) {
      await rename(join(root, 'arbitrary-a', file), join(root, 'verification', file));
    }
    await rename(join(root, 'arbitrary-b'), join(root, 'verification/nested'));
    const read = spyOn(fs, 'readdir');
    try {
      const report = await aggregateUsage(
        { format: 1, conditions, runs: [selected('local', null, 'unknown')] },
        base,
      );
      expect(report.runs[0]?.actors.map((actor) => [actor.path, actor.phase])).toEqual([
        ['arbitrary-c/events.jsonl', 'review'],
        ['verification/events.jsonl', 'implementation'],
        ['verification/nested/events.jsonl', 'repair'],
      ]);
      expect(report.observed).toEqual({
        input_tokens: 300,
        cached_input_tokens: 240,
        output_tokens: 30,
      });
      expect(read.mock.calls.filter(([path]) => path === join(root, 'verification'))).toHaveLength(
        1,
      );
    } finally {
      read.mockRestore();
    }
  });
});

test('current incomplete records report unassigned usage and missing actor evidence', async () => {
  await withFixture(async (base) => {
    const { root } = await runFixture(base, 'local');
    const input = { format: 1, conditions, runs: [selected('local', null, 'unknown')] };
    await writeFile(
      join(root, 'implementation.json'),
      JSON.stringify({ code: null, timedOut: false, ms: 50 }),
    );
    await rm(join(root, 'arbitrary-a/actor.json'));
    await writeFile(
      join(root, 'arbitrary-b/events.jsonl'),
      events('failed-turn', [{ type: 'turn.started' }, { type: 'turn.failed' }]),
    );
    const report = await aggregateUsage(input, base);
    expect(report.counts.satisfiedTasks).toBe(0);
    expect(report.counts.executionFailed).toBe(1);
    expect(report.counts.executionUnknown).toBe(0);
    expect(report.runs[0]?.recorded.status).toBe('verified_local');
    expect(report.observed).toEqual({
      input_tokens: 200,
      cached_input_tokens: 160,
      output_tokens: 20,
    });
    expect(report.stages.find((stage) => stage.phase === 'unassigned')?.observed).toEqual(usage);
    expect(report.runs[0]?.problems.join('\n')).toContain('expected exactly one actor execution');
  });
});

test('input boundaries reject duplicate records, old formats, unmatched tasks and model settings', async () => {
  await withFixture(async (base) => {
    const { root, result, state } = await runFixture(base, 'local');
    const input = { format: 1, conditions, runs: [selected('local', null, 'unknown')] };
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify({ ...result, startedAt: undefined, terminal: undefined }),
    );
    await assert.rejects(aggregateUsage(input, base), /Invalid result\.json/);
    await writeFile(join(root, 'result.json'), JSON.stringify(result));
    await writeFile(
      join(root, 'verification/state.json'),
      JSON.stringify({ ...state, reviewFormat: 3 }),
    );
    await assert.rejects(aggregateUsage(input, base), /Invalid review format/);
    await writeFile(join(root, 'verification/state.json'), JSON.stringify(state));
    await assert.rejects(
      aggregateUsage(
        {
          ...input,
          runs: [...input.runs, { ...selected('alias', 'local', 'satisfied'), directory: 'local' }],
        },
        base,
      ),
      /Duplicate selected run directory/,
    );
    await assert.rejects(
      aggregateUsage({ ...input, runs: [selected('local', 'missing', 'unknown')] }, base),
      /Retry must reference/,
    );
    const mismatch = await aggregateUsage(
      {
        ...input,
        conditions: { ...conditions, model: 'different' },
      },
      base,
    );
    expect(mismatch.runs[0]?.problems.join('\n')).toContain('Recorded model/settings differ');
    await writeFile(
      join(root, 'arbitrary-b/events.jsonl'),
      await readFile(join(root, 'arbitrary-a/events.jsonl'), 'utf8'),
    );
    await assert.rejects(aggregateUsage(input, base), /Duplicate actor execution\/thread/);
  });
});

test('missing verification state counts as unknown only when verification was reached or configured', async () => {
  await withFixture(async (base) => {
    const { root, result } = await runFixture(base, 'local');
    const input = { format: 1, conditions, runs: [selected('local', null, 'unknown')] };
    await rm(join(root, 'verification/state.json'));
    await rm(join(root, 'arbitrary-b'), { recursive: true });
    await rm(join(root, 'arbitrary-c'), { recursive: true });
    for (const [phase, configured, unknown] of [
      ['implementation', false, 0],
      ['verification', false, 1],
      ['publication', false, 1],
      ['ci', false, 1],
      ['implementation', true, 1],
    ] as const) {
      await writeFile(
        join(root, 'result.json'),
        JSON.stringify({ ...result, status: 'stopped', phase }),
      );
      if (configured) {
        await writeFile(join(root, 'verification-config.json'), '{}');
      }
      const report = await aggregateUsage(input, base);
      expect(report.counts).toMatchObject({
        attempts: 1,
        executionFailed: 0,
        executionUnknown: unknown,
        evaluationUnknown: 1,
        satisfiedTasks: 0,
      });
      expect(report.runs[0]?.problems.includes('verification/state.json missing')).toBe(
        unknown === 1,
      );
      expect(report.runs[0]?.executionUnknown).toBe(unknown === 1);
      expect(report.observed).toEqual(usage);
    }
  });
});

test('CLI reads explicit selection without modifying records and refuses symlink evidence', async () => {
  await withFixture(async (base) => {
    const { root } = await runFixture(base, 'local');
    const input = { format: 1, conditions, runs: [selected('local', null, 'unknown')] };
    await writeFile(join(base, 'selection.json'), JSON.stringify(input));
    const before = await readFile(join(root, 'result.json'), 'utf8');
    const command = spawnSync(
      process.execPath,
      [resolve('scripts/implement/usage.ts'), join(base, 'selection.json')],
      { encoding: 'utf8' },
    );
    expect(command.status).toBe(0);
    expect(command.stdout).toContain('"selectionSha256"');
    expect(command.stdout).not.toContain(base);
    expect(await readFile(join(root, 'result.json'), 'utf8')).toBe(before);
    await rm(join(root, 'arbitrary-b/events.jsonl'));
    await symlink(join(root, 'arbitrary-a/events.jsonl'), join(root, 'arbitrary-b/events.jsonl'));
    await assert.rejects(aggregateUsage(input, base), /Cannot read regular record/);
  });
});
