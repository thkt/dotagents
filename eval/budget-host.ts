import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { budgetMessage, delegationInput } from './budget-runtime.ts';
import {
  createRunBudget,
  costOf,
  maximumReservation,
  type BudgetSnapshot,
  type MoneyConditions,
} from './budget.ts';

export async function stageBudgetSources(runtime: string) {
  const path = 'budget-runtime.ts';
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, path)], target: 'bun' });
  assert(build.success && build.outputs[0], 'Budget runtime build failed');
  await writeFile(resolve(runtime, path), await build.outputs[0].text());
}
export async function createBudgetRun(directory: string, input: MoneyConditions) {
  const { currency, unit, budget, stop, notify } = input;
  const conditions = { currency, unit, budget, stop, notify };
  const initial = createRunBudget({
    runId: randomUUID(),
    conditions,
    save: async () => {},
    notify: async () => {},
  }).snapshot();
  const state = {
    snapshot: initial,
    delegation: null as string | null,
    held: 0,
    error: null as string | null,
  };
  const save = () =>
    writeFile(resolve(directory, 'budget.json'), JSON.stringify({ conditions, ...state }, null, 2));
  await save();
  return {
    state,
    async delegate(runtime: string, expiresAt: number) {
      assert(!state.delegation && !state.snapshot.stopped && !state.error, 'Budget unavailable');
      const id = randomUUID();
      state.delegation = id;
      state.held = conditions.stop - state.snapshot.accounted;
      await save();
      await writeFile(
        resolve(runtime, 'delegation.json'),
        JSON.stringify({ id, conditions, initial: state.snapshot, expiresAt: expiresAt + 5000 }),
      );
    },
    async recover(runtime: string) {
      try {
        const result = budgetMessage.parse(
          JSON.parse(await readFile(resolve(runtime, '../budget-closed.json'), 'utf8')),
        );
        assert(
          result.kind === 'closed' &&
            result.delegation === state.delegation &&
            result.snapshot.reserved === 0,
          'Unconfirmed delegation close',
        );
        validateSnapshot(result.snapshot, state.snapshot, conditions);
        const recovered = { ...state, snapshot: result.snapshot, held: 0, delegation: null };
        await writeFile(
          resolve(directory, 'budget.json'),
          JSON.stringify({ conditions, ...recovered }, null, 2),
        );
        Object.assign(state, recovered);
      } catch (error) {
        state.error = error instanceof Error ? error.message : 'Budget recovery failed';
        await save();
        throw error;
      }
    },
  };
}
function validateSnapshot(
  next: BudgetSnapshot,
  previous: BudgetSnapshot,
  conditions: MoneyConditions,
) {
  assert(
    next.runId === previous.runId && next.profileHash === previous.profileHash,
    'Budget identity mismatch',
  );
  assert(
    next.settled >= previous.settled && next.unrecoverable >= previous.unrecoverable,
    'Budget decreased',
  );
  assert(!previous.stopped || next.stopped, 'Budget stop cleared');
  assert(!previous.notified || next.notified, 'Budget notification cleared');
  assert(next.accounted < conditions.stop || next.stopped, 'Money stop missing');
  assert(next.accounted < conditions.notify || next.notified, 'Money notice missing');
  for (const request of next.requests.filter((r) => r.state === 'settled')) {
    assert(request.billing, 'Settlement billing missing');
    assert(costOf(request.billing) === request.cost, 'Settlement usage disagrees');
  }
  const sum = (state: string[]) =>
    next.requests.filter((r) => state.includes(r.state)).reduce((n, r) => n + r.cost, 0);
  assert(
    new Set(next.requests.map((r) => r.id)).size === next.requests.length,
    'Duplicate budget request',
  );
  assert(
    next.settled === sum(['settled']) &&
      next.unrecoverable === sum(['unrecoverable']) &&
      next.reserved === sum(['reserved', 'sent']),
    'Budget requests disagree',
  );
  assert(
    next.requests.every(
      (r) =>
        !['reserved', 'sent', 'unrecoverable'].includes(r.state) || r.cost === maximumReservation,
    ),
    'Invalid reservation',
  );
  assert(
    next.accounted === next.settled + next.unrecoverable + next.reserved &&
      next.accounted <= conditions.stop,
    'Budget bound violated',
  );
  for (const request of previous.requests) {
    const current = next.requests.find((r) => r.id === request.id);
    assert(current, 'Budget request disappeared');
    if (['settled', 'released', 'unrecoverable'].includes(request.state)) {
      assert.deepStrictEqual(current, request, 'Closed request changed');
    } else {
      assert(request.state !== 'sent' || current.state !== 'released', 'Sent reservation released');
      assert(request.state !== 'sent' || current.state !== 'reserved', 'Sent request reset');
    }
  }
}

// 読み取り専用の別runtimeを既存のgateway mountへ渡す。
export async function gatewayRuntime(runtime: string) {
  if (!(await Bun.file(resolve(runtime, 'delegation.json')).exists())) {
    return runtime;
  }
  const target = resolve(runtime, '../gateway-runtime');
  await mkdir(target);
  await cp(runtime, target, { recursive: true });
  const settings = z
    .object({ expiresAt: z.number() })
    .passthrough()
    .parse(JSON.parse(await readFile(resolve(target, 'settings.json'), 'utf8')));
  await writeFile(
    resolve(target, 'settings.json'),
    JSON.stringify({
      ...settings,
      requestExpiresAt: settings.expiresAt,
      expiresAt: settings.expiresAt + 5000,
    }),
  );
  // actor/probeから参照できる入力を除去する。
  const { unlink } = await import('node:fs/promises');
  await unlink(resolve(runtime, 'delegation.json'));
  return target;
}

export async function observeBudget(
  gateway: string,
  runtime: string,
  dir: string,
  expiresAt: number,
) {
  if (!(await Bun.file(resolve(runtime, 'delegation.json')).exists())) {
    return;
  }
  const input = delegationInput.parse(
    JSON.parse(await readFile(resolve(runtime, 'delegation.json'), 'utf8')),
  );
  let previous = input.initial;
  let sequence = 0;
  let failure: unknown;
  let closed = false;
  let notified = input.initial.notified;
  const child = spawn(
    'docker',
    ['exec', '-i', gateway, '/usr/local/bin/bun', '/runtime/budget-runtime.ts'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, expiresAt - Date.now()));
  child.stdin.on('error', (error) => {
    failure = error;
  });
  child.on('error', (error) => {
    failure = error;
  });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on('data', (data: Buffer) => {
    const part = data.subarray(0, Math.max(0, 65536 - stderrBytes));
    stderr.push(part);
    stderrBytes += part.length;
  });
  const reader = createInterface({ input: child.stdout });
  const messages = (async () => {
    for await (const line of reader) {
      const message = await checkedMessage(line, input, sequence + 1, previous, dir);
      sequence++;
      previous = message.snapshot;
      await writeFile(resolve(dir, `budget-${sequence}.json`), JSON.stringify(message));
      if (message.kind === 'notify') {
        assert(
          !notified &&
            message.snapshot.notified &&
            message.snapshot.accounted >= input.conditions.notify,
          'Unexpected money notice',
        );
        await writeFile(resolve(dir, 'budget-notice.json'), JSON.stringify(message));
        await new Promise<void>((done, reject) =>
          process.stdout.write(
            `${JSON.stringify({ type: 'eval.budget-notice', ...message })}\n`,
            (error) => (error ? reject(error) : done()),
          ),
        );
      }
      if (message.kind === 'notify') {
        notified = true;
      }
      if (message.kind === 'closed') {
        assert(message.snapshot.notified === notified, 'Money notice not delivered');
        assert(previous.reserved === 0, 'Open budget requests');
        await writeFile(resolve(dir, 'budget-closed.json'), JSON.stringify(message));
        closed = true;
      }
      child.stdin.write(`${message.sequence}\n`);
    }
  })().catch((error: unknown) => {
    failure = error;
    child.kill('SIGKILL');
  });
  return {
    async close(deadline: number) {
      child.stdin.write('close\n');
      while (!closed && !failure && performance.now() < deadline) {
        await Bun.sleep(10);
      }
      assert(closed && !failure, 'Budget close unavailable');
    },
    async stop(deadline: number) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reader.close();
      await withinObservation(messages, deadline);
      await withinObservation(
        writeFile(resolve(dir, 'budget-observer.stderr'), Buffer.concat(stderr)),
        deadline,
      );
    },
  };
}

async function checkedMessage(
  line: string,
  input: z.infer<typeof delegationInput>,
  sequence: number,
  previous: BudgetSnapshot,
  directory: string,
) {
  try {
    const message = budgetMessage.parse(JSON.parse(line));
    assert(
      message.delegation === input.id && message.sequence === sequence,
      'Budget message mismatch',
    );
    validateSnapshot(message.snapshot, previous, input.conditions);
    return message;
  } catch (error) {
    // 不正snapshotも、確認できたusage・金額の証拠としてホストだけへ残す。
    await writeFile(resolve(directory, 'budget-rejected-message.json'), line);
    throw error;
  }
}

async function withinObservation<T>(operation: Promise<T>, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('Budget observation deadline expired')),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
