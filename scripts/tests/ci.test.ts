import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { waitForCi } from '../ci.ts';
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
  frames: ReturnType<typeof frame>[];
  code?: number;
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
    code: 0,
  },
  {
    name: 'unrelated success never replaces missing required checks',
    frames: [frame([check('labels')])],
    budget: 20,
  },
  {
    name: 'head changes while waiting',
    frames: [frame([]), frame(required, 'different')],
    error: /PR target changed/,
  },
  {
    name: 'required skipped',
    frames: [frame([check('checks'), check('verify', 'SKIPPED')])],
    code: 1,
  },
  {
    name: 'required neutral',
    frames: [frame([check('checks'), check('verify', 'NEUTRAL')])],
    code: 1,
  },
  {
    name: 'same-name failure is not hidden by success',
    frames: [frame([...required, check('verify', 'FAILURE')])],
    code: 1,
  },
  {
    name: 'other check failure',
    frames: [frame([...required, check('labels', 'FAILURE')])],
    code: 1,
  },
  {
    name: 'waits for other pending checks',
    frames: [frame([...required, { context: 'external', state: 'PENDING' }]), frame(required)],
    code: 0,
  },
  {
    name: 'optional skipped check',
    frames: [frame([...required, check('optional', 'SKIPPED')])],
    code: 0,
  },
  {
    name: 'required status contexts',
    frames: [
      frame([
        { context: 'checks', state: 'SUCCESS' },
        { context: 'verify', state: 'SUCCESS' },
      ]),
    ],
    code: 0,
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
            return ok(JSON.stringify(current));
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
        expect(result?.code).toBe(scenario.code);
        if (scenario.code === 0) {
          expect(views).toBe(scenario.frames.length);
        }
      }
    } finally {
      await withInterrupts(async () => {});
    }
  });
}
