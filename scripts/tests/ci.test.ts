import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { waitForCi, confirmCiTarget } from '../ci.ts';
import { withInterrupts } from '../correction.ts';

const target = {
  cwd: '/tmp',
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
  elapsed?: number;
  unavailable?: boolean;
  invalidJson?: boolean;
  error?: RegExp;
  interrupt?: boolean;
  budget?: number;
}[] = [
  {
    name: 'waits for required registration and execution',
    frames: [
      frame([check('labels')]),
      frame([check('checks'), { name: 'verify', status: 'IN_PROGRESS' }]),
      frame(required),
    ],
    status: 'passed',
  },
  {
    name: 'unrelated success never replaces missing required checks',
    frames: [frame([check('labels')])],
    budget: 20,
    status: 'timed_out',
    observed: 'missing',
  },
  {
    name: 'head changes while waiting',
    frames: [frame([]), frame(required, 'different')],
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
    frames: [frame([...required, check('verify', 'FAILURE')])],
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
    elapsed: 20,
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
    frames: [frame([check('checks'), check('verify', 'FAILURE')])],
    budget: 20,
    elapsed: 20,
    status: 'failed',
    observed: 'failed',
  },
  {
    name: 'success after deadline does not extend wait budget',
    frames: [frame(required)],
    budget: 20,
    elapsed: 20,
    status: 'timed_out',
    observed: 'passed',
  },
  {
    name: 'API unavailable preserves last observation',
    frames: [frame([check('checks')]), frame(required)],
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
  {
    name: 'all duplicate required checks succeed',
    frames: [frame([...required, check('verify')])],
    status: 'passed',
  },
  {
    name: 'interrupted',
    frames: [frame(required)],
    interrupt: true,
    error: /Interrupted execution/,
  },
];
for (const scenario of scenarios) {
  test(`CI execution: ${scenario.name}`, async () => {
    let views = 0;
    const budget = scenario.budget ?? 3500;
    let now = 0;
    try {
      const action = () =>
        waitForCi(
          target,
          async (argv, _cwd, _input, timeout) => {
            expect(argv[2]).toBe('view');
            expect(timeout).toBeLessThanOrEqual(budget);
            const current = scenario.frames[Math.min(views++, scenario.frames.length - 1)];
            if (scenario.interrupt) {
              process.emit('SIGINT');
            }
            now += scenario.elapsed ?? 0;
            if (scenario.unavailable && views > 1) {
              return { ...ok('API error'), code: 1, stderr: 'offline' };
            }
            return ok(scenario.invalidJson ? '{' : JSON.stringify(current));
          },
          budget,
          {
            now: () => now,
            sleep: async (ms) => {
              now += ms;
            },
          },
        );
      if (scenario.error) {
        await assert.rejects(() => withInterrupts(action), scenario.error);
      } else {
        const result = await withInterrupts(action);
        expect(String(result.status)).toBe(scenario.status ?? '');
        if (scenario.observed) {
          expect(result.lastObservation?.status).toBe(scenario.observed);
        }
        if (scenario.budget) {
          expect(result.timedOut).toBe(true);
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
      }
    } finally {
      await withInterrupts(async () => {});
    }
  });
}

// Head/base/OPEN and malformed data share the polling validator above; development
// tests exercise its final-read wiring. These cover final retrieval failures.
for (const failure of ['timeout', 'throws'] as const) {
  test(`final CI target read: ${failure}`, async () => {
    const passed = await waitForCi(target, async () => ok(JSON.stringify(frame(required))), 1000);
    const result = await confirmCiTarget(
      target,
      passed,
      async () => {
        if (failure === 'throws') {
          throw Error('spawn failed');
        }
        return { ...ok(JSON.stringify(frame(required))), timedOut: true };
      },
      1000,
    );
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain(failure === 'timeout' ? 'timedOut true' : 'spawn failed');
    expect(result.lastObservation).toEqual(passed.lastObservation);
    expect(result.logs).toContain('/tmp/ci-final-target');
    expect(result.nextAction).toContain('Check gh');
  });
}
