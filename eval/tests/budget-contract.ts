import assert from 'node:assert/strict';

// 判定根拠は今回の合意済みIssue（updatedAt: 2026-10-17T20:26:30Z）。
// 公式仕様の照合先（2026-10-18）:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/guides/prompt-caching
// https://developers.openai.com/api/reference/typescript/resources/responses
// 以下は独立テストの接続契約であり、既存の製品APIや実測schemaではない。
// 実装が別の内部APIを選ぶ場合は、この接続だけを独立テスト工程へ戻す。
// USDの単位は10^-7。最小のcache読取り1 tokenを丸めず表せる。
export const conditions = {
  currency: 'USD',
  unit: 'usd-1e-7',
  budget: 6_000_000_000,
  stop: 5_000_000_000,
  notify: 4_000_000_000,
};
export const reservation = 47_300_000;

// ホスト提示の#403接続契約。期待する金額と適用範囲は合意済みIssueから定める。
export const budgetConfig = {
  ...conditions,
  profile: 'gpt-6.1-sol-standard-2026-10-18',
  profileHash: 'e8bf221b79b734deb14067747932e3256cc3ce92b8ac4a6490cce9afdf855193',
};

export function completed(id = 'resp_public_cost') {
  return {
    id,
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol',
    service_tier: 'default',
    output: [],
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1100,
    },
  };
}

export interface Snapshot {
  settled: number;
  unrecoverable: number;
  reserved: number;
  accounted: number;
  stopped: boolean;
  notified: boolean;
}
export interface Ledger {
  reserve(id: string): Promise<boolean>;
  sent(id: string): Promise<void>;
  settle(id: string, response: unknown): Promise<void>;
  releaseUnsent(id: string): Promise<void>;
  abandon(id: string, reason: string): Promise<void>;
  snapshot(): Snapshot;
}
export interface BudgetApi {
  calculateCost: (response: unknown) => number;
  createRunBudget: (options: {
    runId: string;
    conditions: typeof conditions;
    save: (snapshot: Snapshot) => Promise<void>;
    notify: (snapshot: Snapshot) => Promise<void>;
  }) => Ledger;
}

function isBudgetApi(value: unknown): value is BudgetApi {
  return (
    value !== null &&
    typeof value === 'object' &&
    'calculateCost' in value &&
    typeof value.calculateCost === 'function' &&
    'createRunBudget' in value &&
    typeof value.createRunBudget === 'function'
  );
}

export async function budgetApi(): Promise<BudgetApi> {
  // 新規機能の未実装をruntimeで明示し、skipや代替の料金実装で成功にしない。
  // 固定パスと使用するexportを明示し、未使用コード検査にも接続を伝える。
  const api: unknown = await import('../budget.ts').then(
    ({ calculateCost, createRunBudget }: { calculateCost: unknown; createRunBudget: unknown }) => ({
      calculateCost,
      createRunBudget,
    }),
  );
  assert(isBudgetApi(api), '金額検証用の接続APIがありません');
  return api;
}

export async function ledger(initialSettled = 0) {
  const api = await budgetApi();
  const saved: Snapshot[] = [];
  const notices: Snapshot[] = [];
  const budget = api.createRunBudget({
    runId: 'synthetic-cost-run',
    conditions,
    save: async (state) => {
      saved.push(structuredClone(state));
    },
    notify: async (state) => {
      notices.push(structuredClone(state));
    },
  });
  await seed(budget, initialSettled);
  return { budget, saved, notices };
}

// 合成usageを通常の予約・精算へ流して境界を作る。製品へ残高注入を要求しない。
export async function seed(budget: Ledger, amount: number) {
  let remaining = amount;
  let index = 0;
  while (remaining > 0) {
    const response = completed(`resp_seed_${index}`);
    let cost: number;
    if (remaining >= reservation) {
      response.usage.input_tokens = 922000;
      response.usage.input_tokens_details = { cached_tokens: 0, cache_write_tokens: 922000 };
      response.usage.output_tokens = 8000;
      cost = reservation;
    } else if (remaining >= 25) {
      const tokens = Math.min(272000, Math.floor(remaining / 25));
      response.usage.input_tokens = tokens;
      response.usage.input_tokens_details = { cached_tokens: 0, cache_write_tokens: tokens };
      response.usage.output_tokens = 0;
      cost = tokens * 25;
    } else {
      response.usage.input_tokens = remaining;
      response.usage.input_tokens_details = { cached_tokens: remaining, cache_write_tokens: 0 };
      response.usage.output_tokens = 0;
      cost = remaining;
    }
    response.usage.output_tokens_details.reasoning_tokens = 0;
    response.usage.total_tokens = response.usage.input_tokens + response.usage.output_tokens;
    const id = `seed-${index++}`;
    assert(await budget.reserve(id));
    await budget.sent(id);
    await budget.settle(id, response);
    remaining -= cost;
  }
  assert.equal(budget.snapshot().settled, amount);
}
