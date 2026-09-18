import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { waitForCi } from '../ci.ts';
import type { CiResult } from '../ci.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withInterrupts } from '../process.ts';

const target = {
  cwd: '/tmp',
  issue: '99',
  repository: 'team/component',
  url: 'https://github.com/team/component/pull/1',
  commit: 'verified',
  baseBranch: 'main',
  dir: '/tmp',
  ciChecks: ['checks', 'verify'],
};
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, ms: 1 });
const check = (name: string, conclusion = 'SUCCESS') => ({ name, status: 'COMPLETED', conclusion });
const required = [check('checks'), check('verify')];
const frame = (checks: unknown[], head = 'verified') => ({
  url: target.url,
  body: 'Closes #99',
  headRefOid: head,
  baseRefName: 'main',
  state: 'OPEN',
  statusCheckRollup: checks,
});
const scenarios: {
  name: string;
  frames: unknown[];
  status?: string;
  observed?: string;
  elapsed?: number[];
  starts?: number[];
  sleeps?: number[];
  unavailable?: boolean;
  invalidJson?: boolean;
  error?: RegExp;
  interrupt?: 'read' | 'sleep';
  budget?: number;
}[] = [
  {
    name: 'waits for required registration and execution',
    frames: [
      frame([check('labels')]),
      frame([check('checks'), { name: 'verify', status: 'IN_PROGRESS' }]),
      frame([...required, check('verify')]),
    ],
    elapsed: [100, 100, 100],
    starts: [0, 5100, 10200],
    sleeps: [5000, 5000],
    status: 'passed',
  },
  {
    name: 'publication retrieval does not spend the CI waiting budget',
    frames: [frame([]), frame(required)],
    elapsed: [650000, 100],
    budget: 7000,
    starts: [0, 655000],
    sleeps: [5000],
    status: 'passed',
  },
  {
    name: 'unrelated success never replaces missing required checks',
    frames: [frame([check('labels')])],
    budget: 12000,
    starts: [0, 5000, 10000],
    sleeps: [5000, 5000, 2000],
    status: 'timed_out',
    observed: 'missing',
  },
  {
    name: 'head changes while waiting',
    frames: [frame([]), frame(required, 'different')],
    budget: 7000,
    elapsed: [0, 2000],
    status: 'target_changed',
    observed: 'missing',
  },
  {
    name: 'required skipped',
    frames: [frame([check('checks'), check('verify', 'SKIPPED')])],
    status: 'failed',
  },
  {
    name: 'required neutral',
    frames: [frame([check('checks'), check('verify', 'NEUTRAL')])],
    status: 'failed',
  },
  {
    name: 'same-name failure is not hidden by success',
    frames: [frame([...required, check('verify', 'FAILURE')]), frame(required)],
    status: 'failed',
  },
  {
    name: 'other check failure',
    frames: [frame([...required, check('labels', 'FAILURE')])],
    status: 'failed',
  },
  {
    name: 'waits for other pending checks',
    frames: [frame([...required, { context: 'external', state: 'PENDING' }]), frame(required)],
    status: 'passed',
  },
  {
    name: 'optional skipped check',
    frames: [frame([...required, check('optional', 'SKIPPED')])],
    status: 'passed',
  },
  {
    name: 'required status contexts',
    frames: [
      frame([
        { context: 'checks', state: 'SUCCESS' },
        { context: 'verify', state: 'SUCCESS' },
      ]),
    ],
    status: 'passed',
  },
  {
    name: 'running at deadline retains duplicate pending and missing registrations',
    frames: [frame([check('checks'), { name: 'checks', status: 'IN_PROGRESS' }])],
    budget: 20,
    elapsed: [20],
    status: 'timed_out',
    observed: 'missing',
  },
  {
    name: 'registered checks still running at deadline',
    frames: [frame([check('checks'), { name: 'verify', status: 'IN_PROGRESS' }])],
    budget: 20,
    status: 'timed_out',
    observed: 'running',
  },
  {
    name: 'failure returned at deadline remains failure',
    frames: [frame([]), frame([check('checks'), check('verify', 'FAILURE')])],
    budget: 7000,
    elapsed: [0, 2000],
    status: 'failed',
    observed: 'failed',
  },
  {
    name: 'success just before deadline',
    frames: [frame([]), frame(required)],
    budget: 7000,
    elapsed: [0, 1999],
    status: 'passed',
    observed: 'passed',
  },
  {
    name: 'success at deadline does not extend wait budget',
    frames: [frame([]), frame(required)],
    budget: 7000,
    elapsed: [0, 2000],
    status: 'timed_out',
    observed: 'passed',
  },
  {
    name: 'API unavailable preserves last observation',
    frames: [frame([check('checks')]), frame(required)],
    budget: 7000,
    elapsed: [0, 2000],
    unavailable: true,
    status: 'unavailable',
    observed: 'missing',
  },
  ...[
    { ...frame(required), baseRefName: 'other' },
    { ...frame(required), state: 'CLOSED' },
    { ...frame(required), state: 'MERGED' },
  ].map((value) => ({
    name: `changed target ${value.baseRefName}/${value.state}`,
    frames: [value],
    status: 'target_changed',
  })),
  ...[
    { ...frame(required), statusCheckRollup: null },
    frame([{ name: 'verify', status: 'COMPLETED', conclusion: null }]),
    { statusCheckRollup: required },
  ].map((value, index) => ({
    name: `invalid response ${index}`,
    frames: [value],
    status: 'unavailable',
  })),
  {
    name: 'invalid JSON is unavailable',
    frames: [frame(required)],
    invalidJson: true,
    status: 'unavailable',
  },
  ...(['read', 'sleep'] as const).map((interrupt) => ({
    name: `interrupted during ${interrupt}`,
    frames: [frame([])],
    interrupt,
    error: /Interrupted execution/,
  })),
];
function checkObservation(scenario: (typeof scenarios)[number], result: CiResult, views: number) {
  if (scenario.observed) {
    expect(result.lastObservation?.status).toBe(scenario.observed);
  }
  expect(result.reason.length).toBeGreaterThan(0);
  expect(result.nextAction).toContain(
    {
      passed: 'proceed to human review',
      failed: 'Inspect failing check logs',
      timed_out: 'confirm CI manually without resuming',
      unavailable: 'Check gh authentication',
      target_changed: 'Reconcile the current PR',
    }[result.status],
  );
  if (scenario.name.startsWith('running at deadline')) {
    expect(result.lastObservation).toMatchObject({
      checks: [
        { name: 'checks', state: 'SUCCESS' },
        { name: 'checks', state: 'PENDING' },
      ],
      missing: ['verify'],
      running: [{ name: 'checks', state: 'PENDING' }],
      unmet: ['checks', 'verify'],
    });
  }
  if (scenario.status === 'failed') {
    expect(result.lastObservation?.failed.length).toBeGreaterThan(0);
  }
  if (scenario.status === 'passed') {
    expect(views).toBe(scenario.frames.length);
  }
  if (scenario.name === 'same-name failure is not hidden by success') {
    expect(views).toBe(1);
  }
}

for (const scenario of scenarios) {
  test(`CI execution: ${scenario.name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-test-'));
    let views = 0;
    let finalReads = 0;
    const budget = scenario.budget ?? 15000;
    let now = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const timeouts: (number | null)[] = [];
    try {
      const action = () =>
        waitForCi(
          { ...target, dir },
          async (argv, _cwd, _input, timeout) => {
            if (argv.at(-1) === 'headRefOid,baseRefName,state') {
              finalReads++;
              expect(timeout).toBe(660000);
              return ok(JSON.stringify(frame(required)));
            }
            expect(argv[2]).toBe('view');
            starts.push(now);
            timeouts.push(timeout);
            const current = scenario.frames[Math.min(views++, scenario.frames.length - 1)];
            if (scenario.interrupt === 'read') {
              process.emit('SIGINT');
            }
            now += scenario.elapsed?.[views - 1] ?? 0;
            if (scenario.unavailable && views > 1) {
              return { ...ok('API error'), code: 1, stderr: 'offline' };
            }
            return ok(scenario.invalidJson ? '{' : JSON.stringify(current));
          },
          660000,
          budget,
          {
            now: () => now,
            sleep: async (ms) => {
              sleeps.push(ms);
              now += ms;
              if (scenario.interrupt === 'sleep') {
                process.emit('SIGINT');
              }
            },
          },
        );
      if (scenario.error) {
        await assert.rejects(() => withInterrupts(action), scenario.error);
        expect(views).toBe(1);
      } else {
        const result = await withInterrupts(action);
        expect(String(result.status)).toBe(scenario.status ?? '');
        expect(result.timedOut).toBe(now >= budget + (scenario.elapsed?.[0] ?? 0));
        expect(result.logs).toHaveLength(views + finalReads);
        expect(result.logs[0]).toBe(join(dir, 'pr-publication'));
        expect(await readFile(join(dir, 'pr.json'), 'utf8')).toBe(
          scenario.invalidJson ? '{' : JSON.stringify(scenario.frames[0]),
        );
        checkObservation(scenario, result, views);
      }
      expect(starts[0]).toBe(0);
      expect(timeouts).toEqual([
        660000,
        ...starts.slice(1).map((start) => budget + (scenario.elapsed?.[0] ?? 0) - start),
      ]);
      if (scenario.starts) {
        expect(starts).toEqual(scenario.starts);
      }
      if (scenario.sleeps) {
        expect(sleeps).toEqual(scenario.sleeps);
      }
    } finally {
      await withInterrupts(async () => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// Final-read transport failures must override success without erasing its observation.
for (const failure of ['timeout', 'throws'] as const) {
  test(`final CI target read: ${failure}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-final-test-'));
    try {
      const result = await waitForCi(
        { ...target, dir },
        async (argv) => {
          if (argv.at(-1) !== 'headRefOid,baseRefName,state') {
            return ok(JSON.stringify(frame(required)));
          }
          if (failure === 'throws') {
            throw Error('spawn failed');
          }
          return { ...ok(JSON.stringify(frame(required))), timedOut: true };
        },
        660000,
        1000,
      );
      expect(result.status).toBe('unavailable');
      expect(result.reason).toContain(failure === 'timeout' ? 'timedOut true' : 'spawn failed');
      expect(result.lastObservation?.status).toBe('passed');
      expect(result.logs).toEqual([join(dir, 'pr-publication'), join(dir, 'ci-final-target')]);
      expect(result.nextAction).toContain('Check gh');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
