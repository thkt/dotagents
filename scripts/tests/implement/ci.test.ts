import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { waitForCi } from '../../implement/ci.ts';
import type { CiResult } from '../../implement/ci.ts';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, OutputStorageError, withInterrupts } from '../../shared/process.ts';

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
  isDraft: true,
  statusCheckRollup: checks,
});
const scenarios: {
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
  invalidJson?: boolean;
  error?: RegExp;
  interrupt?: 'read' | 'sleep';
  budget?: number;
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
    name: 'running at deadline retains duplicate pending and missing registrations',
    frames: [frame([check('checks'), { name: 'checks', status: 'IN_PROGRESS' }])],
    budget: 20,
    elapsed: [20],
    status: 'timed_out',
    observed: 'missing',
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

function finalResponse(failure?: 'timeout' | 'throws', isDraft = true) {
  if (failure === 'throws') {
    throw Error('spawn failed');
  }
  return {
    ...ok(JSON.stringify({ ...frame(required), isDraft })),
    timedOut: failure === 'timeout',
  };
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
            if (argv.at(-1) === 'headRefOid,baseRefName,state,isDraft') {
              finalReads++;
              expect(timeout).toBe(660000);
              return finalResponse(scenario.finalFailure, scenario.finalDraft);
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

for (const collision of ['directory', 'complete record']) {
  test(`CI response save failure preserves ${collision} and raw retrieval evidence`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-save-'));
    const path = join(dir, 'pr.json');
    const raw = JSON.stringify(frame(required));
    let reads = 0;
    try {
      if (collision === 'directory') {
        await mkdir(path);
      } else {
        await writeFile(path, 'previous complete record');
      }
      const result = await waitForCi(
        { ...target, dir },
        async (_argv, _cwd, _input, _timeout, log) => {
          reads++;
          await writeFile(`${log}.stdout`, raw);
          await writeFile(`${log}.stderr`, '');
          return ok(raw);
        },
        1000,
        1000,
      );
      expect(result.status).toBe('storage_failed');
      expect(result.reason).toContain(path);
      expect(result.reason).toContain('EEXIST');
      expect(result.lastObservation).toBeNull();
      expect(result.nextAction).toContain('host must restore writable evidence storage');
      expect(result.nextAction).toContain('Do not resume');
      expect(result.nextAction).not.toContain('gh authentication');
      expect(result.logs).toEqual([join(dir, 'pr-publication')]);
      expect(await readFile(`${result.logs[0]}.stdout`, 'utf8')).toBe(raw);
      expect(reads).toBe(1);
      if (collision === 'complete record') {
        expect(await readFile(path, 'utf8')).toBe('previous complete record');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const { phase, streams } of [
  { phase: 'initial', streams: ['stdout'] },
  { phase: 'initial', streams: ['stderr'] },
  { phase: 'final', streams: ['stderr'] },
  { phase: 'initial', streams: ['stdout', 'stderr'] },
]) {
  test(`CI ${phase} ${streams.join('/')} save failure preserves acquired evidence`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-output-'));
    const log = join(dir, phase === 'initial' ? 'pr-publication' : 'ci-final-target');
    const raw = JSON.stringify(frame(required));
    let reads = 0;
    try {
      for (const stream of streams) {
        await mkdir(`${log}.${stream}`);
      }
      if (streams.length === 2) {
        await writeFile(join(dir, 'pr.json'), 'previous complete record');
      }
      const result = await waitForCi(
        { ...target, dir },
        async (_argv, cwd, input, timeout, prefix) => {
          reads++;
          return command(
            [
              process.execPath,
              '-e',
              `process.stdout.write(${JSON.stringify(raw)}); process.stderr.write('retrieval diagnostic')`,
            ],
            cwd,
            input,
            timeout,
            prefix,
          );
        },
        1000,
        1000,
      );
      expect(result.status).toBe('storage_failed');
      for (const stream of streams) {
        expect(result.reason).toContain(`${log}.${stream}`);
      }
      expect(result.reason).toContain(JSON.stringify(raw));
      expect(result.reason).toContain('retrieval diagnostic');
      expect(result.reason).toContain('"code":0');
      expect(result.reason).toContain('"timedOut":false');
      expect(result.reason).toContain('EISDIR');
      expect(result.lastObservation?.status ?? null).toBe(phase === 'initial' ? null : 'passed');
      expect(result.nextAction).toContain('writable evidence storage');
      expect(result.logs.at(-1)).toBe(log);
      for (const stream of ['stdout', 'stderr'].filter((stream) => !streams.includes(stream))) {
        expect(await readFile(`${log}.${stream}`, 'utf8')).toBe(
          stream === 'stdout' ? raw : 'retrieval diagnostic',
        );
      }
      expect(await readFile(join(dir, 'pr.json'), 'utf8')).toBe(
        streams.length === 2 ? 'previous complete record' : raw,
      );
      if (streams.length === 2) {
        expect(result.reason).toContain(join(dir, 'pr.json'));
        expect(result.reason).toContain('EEXIST');
      }
      expect(reads).toBe(phase === 'initial' ? 1 : 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const finalStatus of ['unavailable', 'target_changed', 'storage_failed'] as const) {
  test(`CI poll storage failure survives final ${finalStatus}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-poll-storage-'));
    const pollLog = join(dir, 'ci-registration-1');
    const finalLog = join(dir, 'ci-final-target');
    const raw = JSON.stringify(frame(required));
    let reads = 0;
    let now = 0;
    try {
      const result = await waitForCi(
        { ...target, dir },
        async (_argv, _cwd, _input, _timeout, log) => {
          reads++;
          if (log === pollLog || (log === finalLog && finalStatus === 'storage_failed')) {
            throw new OutputStorageError(
              [{ path: `${log}.stdout`, cause: Error(`ENOSPC at ${log}`) }],
              { ...ok(raw), stderr: 'retrieval diagnostic' },
            );
          }
          if (log === finalLog) {
            return finalStatus === 'unavailable'
              ? { ...ok(''), code: 1, stderr: 'offline' }
              : ok(JSON.stringify(frame(required, 'different')));
          }
          return ok(JSON.stringify(frame([])));
        },
        1000,
        10000,
        {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      );
      expect(result.status).toBe('storage_failed');
      expect(result.reason).toContain(`${pollLog}.stdout`);
      expect(result.reason).toContain(`ENOSPC at ${pollLog}`);
      expect(result.reason).toContain(JSON.stringify(raw));
      expect(result.reason).toContain(`final target check (${finalStatus})`);
      expect(result.reason).toContain(
        finalStatus === 'unavailable'
          ? 'exit 1'
          : finalStatus === 'target_changed'
            ? 'head=different'
            : `ENOSPC at ${finalLog}`,
      );
      expect(result.nextAction).toContain('writable evidence storage');
      expect(result.nextAction).toContain('Do not resume');
      if (finalStatus === 'unavailable') {
        expect(result.nextAction).toContain('gh authentication');
      } else if (finalStatus === 'target_changed') {
        expect(result.nextAction).toContain('Reconcile the current PR');
      }
      expect(result.lastObservation?.status).toBe('missing');
      expect(result.logs).toEqual([join(dir, 'pr-publication'), pollLog, finalLog]);
      expect(await readFile(join(dir, 'pr.json'), 'utf8')).toBe(JSON.stringify(frame([])));
      expect(reads).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
