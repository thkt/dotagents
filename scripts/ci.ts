import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { command } from './process.ts';
import { assertRunning } from './process.ts';
import { isRecord } from './values.ts';

type Target = {
  cwd: string;
  repository: string;
  url: string;
  commit: string;
  baseBranch: string;
  dir: string;
  ciChecks: string[];
};

function checkStatus(values: unknown[], required: string[]) {
  const checks = values.map((value) => {
    assert(isRecord(value), 'Invalid CI check');
    const name = value.name ?? value.context;
    const state =
      value.status === undefined
        ? value.state
        : value.status === 'COMPLETED'
          ? value.conclusion
          : 'PENDING';
    assert(typeof name === 'string' && typeof state === 'string', 'Invalid CI check status');
    return { name, state };
  });
  const failed = checks.filter(
    ({ name, state }) =>
      !['SUCCESS', 'SKIPPED', 'NEUTRAL', 'PENDING'].includes(state) ||
      (required.includes(name) && ['SKIPPED', 'NEUTRAL'].includes(state)),
  );
  const missing = required.filter((name) => !checks.some((check) => check.name === name));
  const running = checks.filter((check) => check.state === 'PENDING');
  const unmet = required.filter(
    (name) =>
      missing.includes(name) ||
      checks.some((check) => check.name === name && check.state !== 'SUCCESS'),
  );
  const status = failed.length
    ? 'failed'
    : missing.length
      ? 'missing'
      : running.length
        ? 'running'
        : 'passed';
  return { status, checks, missing, running, failed, unmet };
}

export type CiResult = {
  status: 'passed' | 'failed' | 'timed_out' | 'unavailable' | 'target_changed';
  timedOut: boolean;
  lastObservation: ReturnType<typeof checkStatus> | null;
  reason: string;
  nextAction: string;
  logs: string[];
};

const actions = {
  passed:
    'CI confirmed for the published commit; proceed to human review and any rendered media check.',
  failed:
    'Inspect failing check logs and fix the cause; required SKIPPED or NEUTRAL checks must run successfully.',
  timed_out:
    'Inspect missing registrations and running checks on this PR commit; confirm CI manually without resuming this run or extending its budget.',
  unavailable:
    'Check gh authentication, permissions, connectivity and the raw retrieval logs; CI is unconfirmed, not a code failure.',
  target_changed:
    'Reconcile the current PR URL, head, base, OPEN state and Issue reference with the published target before assessing CI; another target cannot confirm this commit.',
};

function finish(result: CiResult, status: CiResult['status'], reason: string): CiResult {
  return { ...result, status, reason, nextAction: actions[status] };
}

async function readTarget(
  target: Target,
  execute: typeof command,
  timeout: number,
  log: string,
  fields: string,
  publicationIssue?: string,
) {
  try {
    const view = await execute(
      ['gh', 'pr', 'view', target.url, '--repo', target.repository, '--json', fields],
      target.cwd,
      '',
      timeout,
      log,
    );
    assertRunning();
    if (publicationIssue !== undefined) {
      await writeFile(join(target.dir, 'pr.json'), view.stdout);
    }
    assert(
      view.code === 0 && !view.timedOut,
      `Cannot retrieve PR/CI (exit ${view.code}, timedOut ${view.timedOut}); inspect ${log}.stderr`,
    );
    const pr: unknown = JSON.parse(view.stdout);
    assert(
      isRecord(pr) &&
        typeof pr.headRefOid === 'string' &&
        typeof pr.baseRefName === 'string' &&
        typeof pr.state === 'string',
      'Invalid PR target response',
    );
    if (
      pr.headRefOid !== target.commit ||
      pr.baseRefName !== target.baseBranch ||
      pr.state !== 'OPEN'
    ) {
      return {
        status: 'target_changed' as const,
        reason: `PR target changed: head=${pr.headRefOid}, base=${pr.baseRefName}, state=${pr.state}; expected ${target.commit}, ${target.baseBranch}, OPEN`,
      };
    }
    if (publicationIssue !== undefined) {
      assert(
        typeof pr.url === 'string' && typeof pr.body === 'string',
        'Invalid PR publication response',
      );
      if (pr.url !== target.url || !pr.body.includes(`Closes #${publicationIssue}`)) {
        return {
          status: 'target_changed' as const,
          reason: `Published PR URL or Issue reference changed; expected ${target.url}, Closes #${publicationIssue}`,
        };
      }
    }
    return { status: 'observed' as const, pr };
  } catch (error) {
    assertRunning();
    return {
      status: 'unavailable' as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function confirmCiTarget(
  target: Target,
  result: CiResult,
  execute: typeof command,
  timeout: number,
) {
  const log = join(target.dir, 'ci-final-target');
  const latest = await readTarget(target, execute, timeout, log, 'headRefOid,baseRefName,state');
  const recorded = { ...result, logs: [...result.logs, log] };
  return latest.status === 'observed' ? recorded : finish(recorded, latest.status, latest.reason);
}

export async function waitForCi(
  target: Target & { issue: string },
  execute: typeof command,
  publicationTimeout: number,
  budgetMs: number,
  clock = { now: () => performance.now(), sleep: (ms: number) => setTimeout(ms) },
): Promise<CiResult> {
  assert(target.ciChecks.length > 0, 'Expected CI checks required');
  const log = join(target.dir, 'pr-publication');
  const result: CiResult = {
    status: 'timed_out',
    timedOut: false,
    lastObservation: null,
    reason: '',
    nextAction: actions.timed_out,
    logs: [log],
  };
  const initial = await readTarget(
    target,
    execute,
    publicationTimeout,
    log,
    'url,headRefOid,baseRefName,state,body,statusCheckRollup',
    target.issue,
  );
  if (initial.status !== 'observed') {
    return finish(result, initial.status, initial.reason);
  }
  const deadline = clock.now() + budgetMs;
  const observed = await pollCi(target, execute, deadline, clock, initial, result);
  return confirmCiTarget(target, observed, execute, publicationTimeout);
}

async function pollCi(
  target: Target,
  execute: typeof command,
  deadline: number,
  clock: { now: () => number; sleep: (ms: number) => Promise<unknown> },
  initial: Awaited<ReturnType<typeof readTarget>>,
  result: CiResult,
): Promise<CiResult> {
  let view = initial;
  while (true) {
    assertRunning();
    result.timedOut = clock.now() >= deadline;
    if (view.status !== 'observed') {
      return finish(result, view.status, view.reason);
    }
    const classified = classifyCi(view.pr, target.ciChecks, result, deadline, clock.now);
    if (classified) {
      return classified;
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      break;
    }
    await clock.sleep(Math.min(5000, remaining));
    assertRunning();
    if (clock.now() >= deadline) {
      break;
    }
    const log = join(target.dir, `ci-registration-${result.logs.length}`);
    result.logs.push(log);
    view = await readTarget(
      target,
      execute,
      Math.max(1, deadline - clock.now()),
      log,
      'headRefOid,baseRefName,state,statusCheckRollup',
    );
  }
  assertRunning();
  result.timedOut = true;
  return finish(
    result,
    'timed_out',
    `CI wait budget exhausted; last observed state: ${result.lastObservation?.status ?? 'unobserved'}.`,
  );
}

function classifyCi(
  pr: Record<string, unknown>,
  required: string[],
  result: CiResult,
  deadline: number,
  now: () => number,
): CiResult | null {
  try {
    assert(Array.isArray(pr.statusCheckRollup), 'Missing CI registration status');
    result.lastObservation = checkStatus(pr.statusCheckRollup, required);
  } catch (error) {
    return finish(result, 'unavailable', error instanceof Error ? error.message : String(error));
  }
  result.timedOut = now() >= deadline;
  // A failure observed at the deadline must not become a waiting result.
  if (result.lastObservation.status === 'failed') {
    return finish(
      result,
      'failed',
      'Registered checks failed or required checks did not conclude SUCCESS.',
    );
  }
  if (!result.timedOut && result.lastObservation.status === 'passed') {
    return finish(
      result,
      'passed',
      'All required checks succeeded and no registered check is failing or pending.',
    );
  }
  return null;
}
