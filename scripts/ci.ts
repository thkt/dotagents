import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import type { command } from './correction.ts';
import { assertRunning } from './correction.ts';
import { isRecord } from './input.ts';

export async function waitForCi(
  target: {
    cwd: string;
    repository: string;
    url: string;
    commit: string;
    baseBranch: string;
    dir: string;
  },
  execute: typeof command,
  budgetMs: number,
) {
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
    if (pr.statusCheckRollup.length > 0) {
      return execute(
        [
          'gh',
          'pr',
          'checks',
          target.url,
          '--repo',
          target.repository,
          '--watch',
          '--interval',
          '10',
        ],
        target.cwd,
        '',
        remaining,
        join(target.dir, 'ci'),
      );
    }
    await setTimeout(Math.min(1000, remaining));
  }
  assertRunning();
  return undefined;
}
