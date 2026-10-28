import assert from 'node:assert/strict';
import { expect, spyOn } from 'bun:test';
import { waitForCi } from '../../implement/ci.ts';
import type { CiResult } from '../../implement/ci.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withInterrupts } from '../../shared/process.ts';

export const target = {
  cwd: '/tmp',
  issue: '99',
  repository: 'team/component',
  url: 'https://github.com/team/component/pull/1',
  commit: 'verified',
  baseBranch: 'main',
  dir: '/tmp',
  ciChecks: ['checks', 'verify'],
};
export const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, ms: 1 });
const check = (name: string, conclusion = 'SUCCESS') => ({ name, status: 'COMPLETED', conclusion });
export const required = [check('checks'), check('verify')];
export const frame = (checks: unknown[], head = 'verified') => ({
  url: target.url,
  body: 'Closes #99',
  headRefOid: head,
  baseRefName: 'main',
  state: 'OPEN',
  isDraft: true,
  statusCheckRollup: checks,
});
export const scenarios: {
  name: string;
  frames: unknown[];
  status?: string;
  observed?: string;
  expectedObservation?: Partial<NonNullable<CiResult['lastObservation']>>;
  expectedViews?: number;
  elapsed?: number[];
  starts?: number[];
  sleeps?: number[];
  unavailable?: boolean;
  retrievalTimeout?: boolean;
  invalidJson?: boolean;
  error?: RegExp;
  interrupt?: 'read' | 'sleep';
  finalFailure?: 'timeout' | 'throws';
  finalDraft?: boolean;
  reason?: string;
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
    name: 'waits beyond nine minutes for missing and running required checks',
    frames: [
      ...Array.from({ length: 55 }, () => frame([check('labels')])),
      ...Array.from({ length: 55 }, () =>
        frame([check('checks'), { name: 'verify', status: 'IN_PROGRESS' }]),
      ),
      frame(required),
    ],
    starts: Array.from({ length: 111 }, (_, index) => index * 5000),
    sleeps: Array.from({ length: 110 }, () => 5000),
    status: 'passed',
  },
  {
    name: 'head changes while waiting',
    frames: [frame([]), frame(required, 'different')],
    elapsed: [0, 2000],
    status: 'target_changed',
    observed: 'missing',
  },
  {
    name: 'another actor marks ready while CI is pending',
    frames: [frame([]), { ...frame(required), isDraft: false }],
    status: 'target_changed',
    observed: 'missing',
  },
  {
    name: 'ready transition after CI success prevents draft handoff',
    frames: [frame(required)],
    finalDraft: false,
    status: 'target_changed',
    observed: 'passed',
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
    expectedViews: 1,
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
    name: 'retrieval timeout preserves duplicate pending and missing registrations',
    frames: [frame([check('checks'), { name: 'checks', status: 'IN_PROGRESS' }]), frame(required)],
    retrievalTimeout: true,
    status: 'unavailable',
    observed: 'missing',
    reason: 'timedOut true',
    expectedObservation: {
      checks: [
        { name: 'checks', state: 'SUCCESS' },
        { name: 'checks', state: 'PENDING' },
      ],
      missing: ['verify'],
      running: [{ name: 'checks', state: 'PENDING' }],
      unmet: ['checks', 'verify'],
    },
  },
  {
    name: 'failure after prolonged waiting remains failure',
    frames: [frame([]), frame([check('checks'), check('verify', 'FAILURE')])],
    elapsed: [0, 540000],
    status: 'failed',
    observed: 'failed',
  },
  {
    name: 'API unavailable preserves last observation',
    frames: [frame([check('checks')]), frame(required)],
    elapsed: [0, 2000],
    unavailable: true,
    status: 'unavailable',
    observed: 'missing',
  },
  ...(
    [
      ['headRefOid', 'another-commit', 'head=another-commit'],
      ['baseRefName', 'other-base', 'base=other-base'],
      ['state', 'CLOSED', 'state=CLOSED'],
      ['state', 'MERGED', 'state=MERGED'],
      ['url', 'https://github.com/other/repo/pull/100', 'URL or Issue reference changed'],
      ['body', 'Closes #990', 'URL or Issue reference changed'],
    ] as const
  ).map(([field, value, reason]) => ({
    name: `initial target changed: ${field}=${value}`,
    frames: [{ ...frame(required), [field]: value }],
    status: 'target_changed',
    reason,
  })),
  ...[
    { ...frame(required), statusCheckRollup: null },
    frame([{ name: 'verify', status: 'COMPLETED', conclusion: null }]),
    { statusCheckRollup: required },
    ...['headRefOid', 'baseRefName', 'state', 'isDraft', 'url', 'body'].map((field) => ({
      ...frame(required),
      [field]: undefined,
    })),
    { ...frame(required), isDraft: 'true' },
  ].map((value, index) => ({
    name: `invalid response ${index}`,
    frames: [value],
    status: 'invalid_response',
  })),
  {
    name: 'invalid JSON is an invalid response',
    frames: [frame(required)],
    invalidJson: true,
    status: 'invalid_response',
  },
  ...(['timeout', 'throws'] as const).map((finalFailure) => ({
    name: `final target read ${finalFailure} overrides success`,
    frames: [frame(required)],
    finalFailure,
    status: 'unavailable',
    observed: 'passed',
    reason: finalFailure === 'timeout' ? 'timedOut true' : 'spawn failed',
  })),
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
  if (scenario.reason) {
    expect(result.reason).toContain(scenario.reason);
  }
  expect(result.nextAction).toContain(
    {
      passed: 'Assigned AI: compare the latest public body',
      failed: 'Inspect failing check logs',
      timed_out: 'confirm CI manually without resuming',
      unavailable: 'Check gh authentication',
      target_changed: 'Reconcile the current PR',
      invalid_response: 'raw PR/CI response',
      storage_failed: 'writable evidence storage',
    }[result.status],
  );
  if (scenario.expectedObservation) {
    expect(result.lastObservation).toMatchObject(scenario.expectedObservation);
  }
  if (scenario.status === 'failed') {
    expect(result.lastObservation?.failed.length).toBeGreaterThan(0);
  }
  if (scenario.status === 'passed') {
    expect(views).toBe(scenario.frames.length);
  }
  if (scenario.expectedViews !== undefined) {
    expect(views).toBe(scenario.expectedViews);
  }
}

function retrievalResponse(scenario: (typeof scenarios)[number], current: unknown, views: number) {
  if (scenario.retrievalTimeout && views > 1) {
    return { ...ok(JSON.stringify(frame(required))), timedOut: true };
  }
  if (scenario.unavailable && views > 1) {
    return { ...ok('API error'), code: 1, stderr: 'offline' };
  }
  return ok(scenario.invalidJson ? '{' : JSON.stringify(current));
}

function finalResponse(failure?: 'timeout' | 'throws', isDraft = true) {
  if (failure === 'throws') {
    throw Error('spawn failed');
  }
  return {
    ...ok(JSON.stringify({ ...frame(required), isDraft })),
    timedOut: failure === 'timeout',
  };
}

export async function runScenario(scenario: (typeof scenarios)[number]) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-test-'));
  let views = 0;
  let finalReads = 0;
  let now = 0;
  const starts: number[] = [];
  const sleeps: number[] = [];
  const timeouts: (number | null)[] = [];
  // Advance the runtime clock too, so a reintroduced total CI deadline is observable.
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const action = () =>
      waitForCi(
        { ...target, dir },
        async (argv, _cwd, _input, timeout) => {
          if (argv.at(-1) === 'headRefOid,baseRefName,state,isDraft') {
            finalReads++;
            expect(timeout).toBe(660000);
            return finalResponse(scenario.finalFailure, scenario.finalDraft);
          }
          expect(argv[2]).toBe('view');
          starts.push(performance.now());
          timeouts.push(timeout);
          assert(views < scenario.frames.length, 'Unexpected extra CI poll');
          const current = scenario.frames[views++];
          if (scenario.interrupt === 'read') {
            process.emit('SIGINT');
          }
          now += scenario.elapsed?.[views - 1] ?? 0;
          return retrievalResponse(scenario, current, views);
        },
        660000,
        async (ms) => {
          sleeps.push(ms);
          now += ms;
          if (scenario.interrupt === 'sleep') {
            process.emit('SIGINT');
          }
        },
      );
    if (scenario.error) {
      await assert.rejects(() => withInterrupts(action), scenario.error);
      expect(views).toBe(1);
    } else {
      const result = await withInterrupts(action);
      expect(String(result.status)).toBe(scenario.status ?? '');
      expect(result.timedOut).toBe(false);
      expect(result.logs).toHaveLength(views + finalReads);
      expect(result.logs[0]).toBe(join(dir, 'pr-publication'));
      if (finalReads) {
        expect(result.logs.at(-1)).toBe(join(dir, 'ci-final-target'));
      }
      expect(await readFile(join(dir, 'pr.json'), 'utf8')).toBe(
        scenario.invalidJson ? '{' : JSON.stringify(scenario.frames[0]),
      );
      checkObservation(scenario, result, views);
      if (scenario.status === 'target_changed' && scenario.observed === undefined) {
        expect(views).toBe(1);
        expect(finalReads).toBe(0);
        expect(result.lastObservation).toBeNull();
      }
    }
    expect(starts[0]).toBe(0);
    expect(timeouts).toEqual(starts.map(() => 660000));
    if (scenario.starts) {
      expect(starts).toEqual(scenario.starts);
    }
    if (scenario.sleeps) {
      expect(sleeps).toEqual(scenario.sleeps);
    }
  } finally {
    clock.mockRestore();
    await withInterrupts(async () => {});
    await rm(dir, { recursive: true, force: true });
  }
}

export function isAssuranceScenario(scenario: (typeof scenarios)[number]) {
  return Boolean(
    scenario.interrupt ||
    scenario.retrievalTimeout ||
    scenario.unavailable ||
    scenario.finalFailure,
  );
}
