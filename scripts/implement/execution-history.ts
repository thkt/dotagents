import assert from 'node:assert/strict';
import { z } from 'zod';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertState } from './input.ts';
import type { Revision } from './input.ts';
import { isRecord } from '../shared/values.ts';
import { interruptionMessage } from '../shared/process.ts';

export async function reconcileExecutions(
  revision: Pick<Revision, 'previousRun' | 'runDirectory'>,
  cwd: string,
  reconciled?: string,
) {
  const parent = dirname(revision.previousRun);
  assert(
    dirname(revision.runDirectory) === parent,
    'Revision evidence must be a sibling of previous run so unfinished executions can be reconciled',
  );
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const dir = join(parent, entry.name);
    if (!entry.isDirectory() || dir === revision.runDirectory) {
      continue;
    }
    const record = await optionalFile(join(dir, 'result.json'));
    if (record === undefined) {
      continue;
    }
    const result: unknown = JSON.parse(record);
    if (!isRecord(result) || result.checkout !== cwd) {
      continue;
    }
    if (dir === reconciled) {
      assert(terminalInterruption(dir, result), '照合対象は終端のverification中断だけです');
      assert(!(await hasExecutionLock(dir)), '照合対象にlockが残っています');
    } else {
      await inactiveVerification(dir, result);
    }
    assert(
      result.reason && result.publication !== 'unconfirmed',
      `Unfinished or uncertain execution requires reconciliation: ${dir}; preserve records and check its process and GitHub state`,
    );
  }
}

async function optionalFile(path: string) {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
}

const interruptionTimes = z.object({ startedAt: z.iso.datetime(), finishedAt: z.iso.datetime() });

function terminalInterruption(dir: string, result: Record<string, unknown>) {
  const times = interruptionTimes.safeParse(result);
  if (!times.success) {
    return false;
  }
  const started = Date.parse(times.data.startedAt);
  const finished = Date.parse(times.data.finishedAt);
  return (
    result.terminal === true &&
    result.status === 'stopped' &&
    result.phase === 'verification' &&
    result.reason === interruptionMessage &&
    result.publication === 'not_attempted' &&
    result.evidence === dir &&
    result.details === join(dir, 'verification/state.json') &&
    Number.isFinite(started) &&
    Number.isFinite(finished) &&
    finished >= started
  );
}

async function inactiveVerification(dir: string, result: Record<string, unknown>) {
  const state = await optionalFile(join(dir, 'verification/state.json'));
  assert(
    state !== undefined || result.phase !== 'verification' || result.reason !== interruptionMessage,
    `Missing interrupted verification state requires reconciliation: ${dir}`,
  );
  if (state !== undefined) {
    const value: unknown = JSON.parse(state);
    assertState(value);
    assert(
      value.active === null && (value.result || terminalInterruption(dir, result)),
      `Unfinished verification requires reconciliation: ${dir}`,
    );
  }
  assert(!(await hasExecutionLock(dir)), `Active verification requires reconciliation: ${dir}`);
}

export async function hasExecutionLock(dir: string) {
  return access(join(dir, 'verification/lock')).then(
    () => true,
    (error: unknown) => {
      assert(isRecord(error) && error.code === 'ENOENT', `Cannot inspect execution lock: ${dir}`);
      return false;
    },
  );
}
