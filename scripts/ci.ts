import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import type { command } from './correction.ts';
import { assertRunning } from './correction.ts';
import { isRecord } from './input.ts';

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
  if (
    checks.some(
      ({ name, state }) =>
        !['SUCCESS', 'SKIPPED', 'NEUTRAL', 'PENDING'].includes(state) ||
        (required.includes(name) && ['SKIPPED', 'NEUTRAL'].includes(state)),
    )
  ) {
    return 'failed';
  }
  return required.some((name) => !checks.some((check) => check.name === name)) ||
    checks.some((check) => check.state === 'PENDING')
    ? 'pending'
    : 'passed';
}

export async function waitForCi(
  target: {
    cwd: string;
    repository: string;
    url: string;
    commit: string;
    baseBranch: string;
    dir: string;
    ciChecks: string[];
  },
  execute: typeof command,
  budgetMs: number,
) {
  assert(target.ciChecks.length > 0, 'Expected CI checks required');
  const deadline = performance.now() + budgetMs;
  let attempt = 0;
  while (performance.now() < deadline) {
    assertRunning();
    const view = await execute(
      [
        'gh',
        'pr',
        'view',
        target.url,
        '--repo',
        target.repository,
        '--json',
        'headRefOid,baseRefName,state,statusCheckRollup',
      ],
      target.cwd,
      '',
      Math.max(1, deadline - performance.now()),
      join(target.dir, `ci-registration-${++attempt}`),
    );
    assertRunning();
    assert(view.code === 0 && !view.timedOut, 'Cannot confirm CI registration');
    const pr: unknown = JSON.parse(view.stdout);
    assert(
      isRecord(pr) &&
        pr.headRefOid === target.commit &&
        pr.baseRefName === target.baseBranch &&
        pr.state === 'OPEN',
      'PR target changed while waiting for CI registration',
    );
    assert(Array.isArray(pr.statusCheckRollup), 'Missing CI registration status');
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return undefined;
    }
    const status = checkStatus(pr.statusCheckRollup, target.ciChecks);
    if (status !== 'pending') {
      return { ...view, code: status === 'passed' ? 0 : 1 };
    }
    await setTimeout(Math.min(1000, remaining));
  }
  assertRunning();
  return undefined;
}
