import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { isRecord } from '../../scripts/shared/values.ts';
import { budgetApi, completed, conditions, reservation } from './budget-contract.ts';

// #403「ホストとgatewayの責任分担」の照合。内部接続の形式だけを
// host_returnの公開接続契約から使い、期待金額はIssueの単価から算定する。
interface BudgetHost {
  state: {
    snapshot: Record<string, unknown>;
    delegation: string | null;
    held: number;
    error: string | null;
  };
  delegate(runtime: string, expiresAt: number): Promise<void>;
  recover(runtime: string): Promise<void>;
}

function isHostApi(value: unknown): value is {
  createBudgetRun(directory: string, limits: typeof conditions): Promise<BudgetHost>;
} {
  return isRecord(value) && typeof value.createBudgetRun === 'function';
}

async function fixture(action: (host: BudgetHost, root: string) => Promise<void>) {
  const path = '../budget-host.ts';
  const api: unknown = await import(path);
  assert(isHostApi(api));
  const root = await mkdtemp(join(tmpdir(), 'budget-host-contract-'));
  try {
    const host: BudgetHost = await api.createBudgetRun(root, conditions);
    await action(host, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function delegation(host: BudgetHost, root: string, name: string) {
  const directory = join(root, name);
  const runtime = join(directory, 'gateway-runtime');
  await mkdir(runtime, { recursive: true });
  await host.delegate(runtime, Date.now() + 60_000);
  const input: unknown = JSON.parse(await readFile(join(runtime, 'delegation.json'), 'utf8'));
  assert(isRecord(input) && isRecord(input.initial) && typeof input.id === 'string');
  return { directory, runtime, input, initial: input.initial };
}

async function settled(initial: Record<string, unknown>, id: string) {
  assert(typeof initial.settled === 'number' && Array.isArray(initial.requests));
  const response = completed(`resp_${id}`);
  const { createRunBudget } = await budgetApi();
  let recorded: unknown;
  // 要求記録の内部識別形式は製品の通常の予約・精算から作る。
  // 期待額やホストへ渡す累計の判定には、この生成結果を使わない。
  const source = createRunBudget({
    runId: 'synthetic-request-format',
    conditions,
    save: async (snapshot) => {
      recorded = structuredClone(snapshot);
    },
    notify: async () => {},
  });
  assert(await source.reserve(id));
  await source.sent(id);
  await source.settle(id, response);
  assert(isRecord(recorded) && Array.isArray(recorded.requests));
  const request: unknown = recorded.requests[0];
  assert(isRecord(request));
  // 通常500、読取り200、書込み300、出力100 => $0.00277。
  const total = initial.settled + 27_700;
  const snapshot: Record<string, unknown> & { requests: Record<string, unknown>[] } = {
    ...initial,
    settled: total,
    reserved: 0,
    unrecoverable: 0,
    accounted: total,
    requests: [
      ...initial.requests.map((value: unknown) => {
        assert(isRecord(value));
        return value;
      }),
      { ...request },
    ],
  };
  return snapshot;
}

async function close(
  trial: Awaited<ReturnType<typeof delegation>>,
  snapshot: Record<string, unknown>,
) {
  await writeFile(
    join(trial.directory, 'budget-closed.json'),
    JSON.stringify({ delegation: trial.input.id, sequence: 1, kind: 'closed', snapshot }),
  );
}

test('検査できた2試行の終了額だけを回収し、次gatewayへ累計を渡す', async () => {
  await fixture(async (host, root) => {
    for (const [index, name] of ['before', 'after'].entries()) {
      const trial = await delegation(host, root, name);
      expect(trial.initial.settled).toBe(index * 27_700);
      await close(trial, await settled(trial.initial, `request-${name}`));
      await host.recover(trial.runtime);
      expect(host.state).toMatchObject({ delegation: null, held: 0, error: null });
      expect(host.state.snapshot).toMatchObject({
        settled: (index + 1) * 27_700,
        accounted: (index + 1) * 27_700,
        reserved: 0,
        unrecoverable: 0,
        stopped: false,
      });
    }
    const saved: unknown = JSON.parse(await readFile(join(root, 'budget.json'), 'utf8'));
    expect(saved).toMatchObject({ conditions, snapshot: { settled: 55_400 }, held: 0 });
  });
});

test('同じ残額を未回収のgatewayと次gatewayへ重ねて委譲しない', async () => {
  await fixture(async (host, root) => {
    const first = await delegation(host, root, 'before');
    const held = host.state.held;
    expect(held).toBeGreaterThan(0);
    const second = join(root, 'after', 'gateway-runtime');
    await mkdir(second, { recursive: true });
    await assert.rejects(() => host.delegate(second, Date.now() + 60_000));
    expect(host.state.held).toBe(held);
    assert.equal(host.state.delegation, first.input.id);
    expect(await readFile(join(second, 'delegation.json')).catch(() => null)).toBeNull();
  });
});

test('正常な終了受渡しでも返却不能額と全体停止を保持し、次試行を許可しない', async () => {
  await fixture(async (host, root) => {
    const trial = await delegation(host, root, 'before');
    assert(typeof trial.initial.runId === 'string');
    const { createRunBudget } = await budgetApi();
    const budget = createRunBudget({
      runId: trial.initial.runId,
      conditions,
      save: async () => {},
      notify: async () => {},
    });
    assert(await budget.reserve('unknown-after-send'));
    await budget.sent('unknown-after-send');
    await budget.abandon('unknown-after-send', '合成の課金429');
    await close(trial, { ...trial.initial, ...budget.snapshot() });
    await host.recover(trial.runtime);
    expect(host.state.snapshot).toMatchObject({
      settled: 0,
      reserved: 0,
      unrecoverable: reservation,
      accounted: reservation,
      stopped: true,
    });
    const saved: unknown = JSON.parse(await readFile(join(root, 'budget.json'), 'utf8'));
    expect(saved).toMatchObject({
      snapshot: { unrecoverable: reservation, accounted: reservation, stopped: true },
    });
    const next = join(root, 'after', 'gateway-runtime');
    await mkdir(next, { recursive: true });
    await assert.rejects(() => host.delegate(next, Date.now() + 60_000));
    expect(await readFile(join(next, 'delegation.json')).catch(() => null)).toBeNull();
  });
});

function corruptSnapshot(snapshot: Awaited<ReturnType<typeof settled>>, fault: string) {
  const request = snapshot.requests.at(-1);
  assert(request);
  if (fault === 'run-id') {
    snapshot.runId = 'different-run';
  }
  if (fault === 'profile') {
    snapshot.profileHash = '0'.repeat(64);
  }
  if (fault === 'sum') {
    snapshot.accounted = 0;
  }
  if (fault === 'billing') {
    request.cost = 1;
    snapshot.settled = 27_701;
    snapshot.accounted = 27_701;
  }
  if (fault === 'open-request' || fault === 'reserved-request') {
    // 形・要求別金額・合計は正常にし、終了時に未完了予約がある条件だけを作る。
    request.state = fault === 'open-request' ? 'sent' : 'reserved';
    request.cost = reservation;
    request.response = null;
    request.billing = null;
    snapshot.settled = 27_700;
    snapshot.reserved = reservation;
    snapshot.accounted = 27_700 + reservation;
  }
  if (fault === 'lost-history') {
    snapshot.requests.shift();
    // 残った精算済み要求との整合を保ち、前gatewayの閉じた履歴だけを失わせる。
    snapshot.settled = 27_700;
    snapshot.accounted = 27_700;
  }
}

for (const fault of [
  'run-id',
  'profile',
  'sum',
  'billing',
  'reserved-request',
  'open-request',
  'lost-history',
]) {
  test(`終了snapshotの${fault}不整合では枠を回収せず次gatewayへ渡さない`, async () => {
    await fixture(async (host, root) => {
      // 前試行の正常額を残すことで、空の台帳へ戻す誤りも区別する。
      const first = await delegation(host, root, 'before');
      await close(first, await settled(first.initial, 'request-before'));
      await host.recover(first.runtime);
      expect(host.state.snapshot.settled).toBe(27_700);
      const second = await delegation(host, root, 'after');
      const snapshot = await settled(second.initial, 'request-after');
      corruptSnapshot(snapshot, fault);
      const held = host.state.held;
      expect(held).toBeGreaterThan(0);
      await close(second, snapshot);
      await host.recover(second.runtime).catch(() => {});
      expect(host.state.held).toBe(held);
      assert(typeof second.input.id === 'string');
      expect(host.state.delegation).toBe(second.input.id);
      expect(host.state.snapshot.settled).toBeGreaterThanOrEqual(27_700);
      expect(host.state.error !== null || host.state.snapshot.stopped === true).toBe(true);
      const next = join(root, 'forbidden', 'gateway-runtime');
      await mkdir(next, { recursive: true });
      const allowed = await host.delegate(next, Date.now() + 60_000).then(
        () => true,
        () => false,
      );
      expect(allowed).toBe(false);
    });
  });
}
