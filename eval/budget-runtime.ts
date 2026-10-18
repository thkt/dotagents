// gateway専用。actorのruntimeへ委譲入力を置かない。
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { budgetSnapshot, moneyConditions, delegatedBudget, type BudgetSnapshot } from './budget.ts';

export const delegationInput = z.strictObject({
  id: z.string().uuid(),
  initial: budgetSnapshot,
  conditions: moneyConditions,
  expiresAt: z.number().int().positive(),
});
export const budgetMessage = z.strictObject({
  delegation: z.string().uuid(),
  sequence: z.number().int().positive(),
  kind: z.enum(['save', 'notify', 'closed']),
  snapshot: budgetSnapshot,
});
async function atomic(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
}
async function exists(path: string) {
  return Bun.file(path).exists();
}

export async function runtimeBudget() {
  if (!(await exists('/runtime/delegation.json'))) {
    return;
  }
  const input = delegationInput.parse(
    JSON.parse(await readFile('/runtime/delegation.json', 'utf8')),
  );
  let sequence = 0;
  const publish = async (kind: 'save' | 'notify' | 'closed', snapshot: BudgetSnapshot) => {
    const current = ++sequence;
    await atomic('/work/budget-message.json', {
      delegation: input.id,
      sequence: current,
      kind,
      snapshot,
    });
    while (true) {
      assert(Date.now() < input.expiresAt, 'Budget handoff deadline expired');
      if (await exists('/work/budget-ack.json')) {
        const ack: unknown = JSON.parse(await readFile('/work/budget-ack.json', 'utf8'));
        if (ack === current) {
          return;
        }
      }
      await Bun.sleep(10);
    }
  };
  const ledger = delegatedBudget(
    {
      runId: input.initial.runId,
      conditions: input.conditions,
      save: (snapshot) => publish('save', snapshot),
      notify: (snapshot) => publish('notify', snapshot),
    },
    input.initial,
  );
  let closing = false;
  const timer = setInterval(() => {
    void (async () => {
      if (closing) {
        return;
      }
      closing = true;
      if (!(await exists('/work/budget-close'))) {
        closing = false;
        return;
      }
      clearInterval(timer);
      await ledger.close();
      await publish('closed', ledger.snapshot());
    })().catch(() => {
      process.exitCode = 125;
    });
  }, 10);
  return ledger;
}

// ホスト専用docker exec -iで起動する。追加のsocket・mount・通信先はない。
async function bridge() {
  const input = delegationInput.parse(
    JSON.parse(await readFile('/runtime/delegation.json', 'utf8')),
  );
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line === 'close') {
      void writeFile('/work/budget-close', '').catch(() => process.exit(125));
    } else {
      const sequence: unknown = JSON.parse(line);
      assert(
        typeof sequence === 'number' && Number.isSafeInteger(sequence),
        'Invalid acknowledgement',
      );
      void atomic('/work/budget-ack.json', sequence).catch(() => process.exit(125));
    }
  });
  let seen = 0;
  while (Date.now() < input.expiresAt) {
    if (await exists('/work/budget-message.json')) {
      const message = budgetMessage.parse(
        JSON.parse(await readFile('/work/budget-message.json', 'utf8')),
      );
      if (message.sequence > seen) {
        assert(
          message.sequence === seen + 1 && message.delegation === input.id,
          'Invalid handoff sequence',
        );
        seen = message.sequence;
        console.log(JSON.stringify(message));
      }
    }
    await Bun.sleep(10);
  }
  lines.close();
}
if (import.meta.main) {
  await bridge();
}
