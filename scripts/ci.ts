import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { command } from './process.ts';
import { assertRunning, OutputStorageError } from './process.ts';
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
  status:
    | 'passed'
    | 'failed'
    | 'timed_out'
    | 'unavailable'
    | 'invalid_response'
    | 'storage_failed'
    | 'target_changed';
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
    'Assigned AI: Check gh authentication, permissions, connectivity and the raw retrieval logs within existing authorization; ask the host to address environment changes and obtain permission where required. CI is unconfirmed, not a code failure.',
  invalid_response:
    'Assigned AI: inspect the raw PR/CI response and its schema against the requested fields; validate the response contract before reassessing this commit.',
  storage_failed:
    'Assigned AI: inspect the failed evidence path and raw retrieval logs; the host must restore writable evidence storage within existing authorization. Obtain permission for environment changes outside that authorization before reassessment.',
  target_changed:
    'Reconcile the current PR URL, head, base, OPEN state and Issue reference with the published target before assessing CI; another target cannot confirm this commit.',
};

type CiProgress = Pick<CiResult, 'timedOut' | 'lastObservation' | 'logs'>;

function finish(result: CiProgress, status: CiResult['status'], reason: string): CiResult {
  const constraints =
    status === 'passed'
      ? ''
      : ' Reconfirm target, evidence, authorization and verification after assistance. Do not resume this run, change locks, active reservations or limits, or retry publication automatically; the current entry point cannot resume a stopped run.';
  return { ...result, status, reason, nextAction: actions[status] + constraints };
}

async function readTarget(
  target: Target,
  execute: typeof command,
  timeout: number,
  log: string,
  fields: string,
  publicationIssue?: string,
) {
  let view: Awaited<ReturnType<typeof command>>;
  const storageFailures: string[] = [];
  try {
    view = await execute(
      ['gh', 'pr', 'view', target.url, '--repo', target.repository, '--json', fields],
      target.cwd,
      '',
      timeout,
      log,
    );
    assertRunning();
  } catch (error) {
    assertRunning();
    if (!(error instanceof OutputStorageError)) {
      return {
        status: 'unavailable' as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    view = error.result;
    storageFailures.push(error.message);
  }
  if (publicationIssue !== undefined) {
    const path = join(target.dir, 'pr.json');
    try {
      await writeFile(path, view.stdout, { flag: 'wx' });
    } catch (error) {
      storageFailures.push(
        `Cannot save PR response at ${path}: ${error instanceof Error ? error.message : String(error)}; retrieval exit ${view.code}, timedOut ${view.timedOut}; raw response: ${log}.stdout and ${log}.stderr`,
      );
    }
  }
  if (storageFailures.length) {
    return { status: 'storage_failed' as const, reason: storageFailures.join('; ') };
  }
  if (view.code !== 0 || view.timedOut) {
    return {
      status: 'unavailable' as const,
      reason: `Cannot retrieve PR/CI (exit ${view.code}, timedOut ${view.timedOut}); inspect ${log}.stderr`,
    };
  }
  return parseTarget(view.stdout, target, publicationIssue);
}

function parseTarget(stdout: string, target: Target, publicationIssue?: string) {
  try {
    const pr: unknown = JSON.parse(stdout);
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
      if (
        pr.url !== target.url ||
        !new RegExp(`Closes #${publicationIssue}(?![0-9])`).test(pr.body)
      ) {
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
      status: 'invalid_response' as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
  const result: CiProgress = {
    timedOut: false,
    lastObservation: null,
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
  const observed = await pollCi();
  const finalLog = join(target.dir, 'ci-final-target');
  const latest = await readTarget(
    target,
    execute,
    publicationTimeout,
    finalLog,
    'headRefOid,baseRefName,state',
  );
  observed.logs.push(finalLog);
  if (latest.status === 'observed') {
    return observed;
  }
  if (observed.status === 'storage_failed') {
    return {
      ...observed,
      reason: `${observed.reason}; final target check (${latest.status}): ${latest.reason}`,
      nextAction: `${observed.nextAction} Final target check: ${actions[latest.status]}`,
    };
  }
  return finish(observed, latest.status, latest.reason);

  async function pollCi(): Promise<CiResult> {
    let view = initial;
    while (true) {
      assertRunning();
      result.timedOut = clock.now() >= deadline;
      if (view.status !== 'observed') {
        return finish(result, view.status, view.reason);
      }
      const classified = classifyCi(view.pr);
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

  function classifyCi(pr: Record<string, unknown>): CiResult | null {
    try {
      assert(Array.isArray(pr.statusCheckRollup), 'Missing CI registration status');
      result.lastObservation = checkStatus(pr.statusCheckRollup, target.ciChecks);
    } catch (error) {
      return finish(
        result,
        'invalid_response',
        error instanceof Error ? error.message : String(error),
      );
    }
    result.timedOut = clock.now() >= deadline;
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
}
