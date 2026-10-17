import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isRecord } from '../scripts/shared/values.ts';

// 単価はUSD 10^-7単位/token。実行中の取得・未知profileの推定はしない。
export const priceProfile = {
  version: 'gpt-6.1-sol-standard-2026-10-18',
  adopted: '2026-10-18',
  sources: [
    'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
    'https://developers.openai.com/api/docs/pricing',
    'https://developers.openai.com/api/docs/guides/prompt-caching',
    'https://developers.openai.com/api/reference/python/resources/responses/methods/create',
  ],
  model: 'gpt-6.1-sol',
  reasoning: 'medium',
  tier: 'default',
  regional: false,
  currency: 'USD',
  unit: 'usd-1e-7',
  maxInput: 922000,
  maxOutput: 8000,
  longThreshold: 272000,
  short: { input: 20, read: 1, write: 25, output: 100 },
  long: { input: 40, read: 2, write: 50, output: 150 },
} as const;
export const profileHash = createHash('sha256').update(JSON.stringify(priceProfile)).digest('hex');
export const maximumReservation = 47_300_000;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const moneyConditions = z
  .strictObject({
    currency: z.literal('USD'),
    unit: z.literal('usd-1e-7'),
    budget: integer.positive(),
    stop: integer.positive(),
    notify: integer.positive(),
  })
  .refine((v) => v.notify < v.stop && v.stop < v.budget, 'Invalid money thresholds');
export const budgetConfig = z
  .strictObject({
    ...moneyConditions.shape,
    profile: z.literal(priceProfile.version),
    profileHash: z.literal(profileHash),
  })
  .refine(
    (v) => v.notify === 4_000_000_000 && v.stop === 5_000_000_000 && v.budget === 6_000_000_000,
    'The agreed money thresholds are fixed',
  );
export type MoneyConditions = z.infer<typeof moneyConditions>;
const observedUsageSchema = z.object({
  id: z.string().min(1),
  status: z.literal('completed'),
  model: z.literal(priceProfile.model),
  service_tier: z.literal('default'),
  usage: z.strictObject({
    input_tokens: integer,
    input_tokens_details: z.strictObject({ cached_tokens: integer, cache_write_tokens: integer }),
    output_tokens: integer,
    output_tokens_details: z.strictObject({ reasoning_tokens: integer }),
    total_tokens: integer,
  }),
});
const usageSchema = observedUsageSchema.refine(
  ({ usage }) =>
    usage.input_tokens <= priceProfile.maxInput && usage.output_tokens <= priceProfile.maxOutput,
  'Provider token caps exceeded',
);
export function costOf(response: z.infer<typeof observedUsageSchema>) {
  const { usage: u } = response;
  const { cached_tokens: read, cache_write_tokens: write } = u.input_tokens_details;
  assert(read + write <= u.input_tokens, 'Invalid cache breakdown');
  assert(u.output_tokens_details.reasoning_tokens <= u.output_tokens, 'Invalid reasoning count');
  assert(u.total_tokens === u.input_tokens + u.output_tokens, 'Invalid total usage');
  const rates =
    u.input_tokens > priceProfile.longThreshold ? priceProfile.long : priceProfile.short;
  const cost =
    (u.input_tokens - read - write) * rates.input +
    read * rates.read +
    write * rates.write +
    u.output_tokens * rates.output;
  assert(Number.isSafeInteger(cost), 'Unsafe provider cost');
  return cost;
}
export function calculateCost(value: unknown) {
  return costOf(usageSchema.parse(value));
}
function providerObservation(value: unknown) {
  const response = isRecord(value) ? value : {};
  const billing = Object.fromEntries(
    ['id', 'status', 'model', 'service_tier', 'usage'].map((key) => [key, response[key] ?? null]),
  );
  let confirmedCost: number | null = null;
  try {
    confirmedCost = costOf(observedUsageSchema.parse(value));
  } catch {
    // 未知tier・不正usageの金額は推定で埋めない。
  }
  return { billing, confirmedCost };
}
function responseIdentity(response: z.infer<typeof usageSchema>, value: unknown) {
  return `${response.id}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
const requestState = z.strictObject({
  id: z.string().min(1),
  state: z.enum(['reserved', 'sent', 'settled', 'released', 'unrecoverable']),
  cost: integer,
  response: z.string().nullable(),
  billing: usageSchema.nullable(),
  observation: z
    .strictObject({ billing: z.unknown(), confirmedCost: integer.nullable() })
    .optional(),
});
export const budgetSnapshot = z.strictObject({
  runId: z.string().min(1),
  profileHash: z.literal(profileHash),
  settled: integer,
  unrecoverable: integer,
  reserved: integer,
  accounted: integer,
  stopped: z.boolean(),
  notified: z.boolean(),
  reason: z.string().nullable(),
  requests: z.array(requestState),
});
export type BudgetSnapshot = z.infer<typeof budgetSnapshot>;
export interface BudgetLedger {
  reserve(id: string): Promise<boolean>;
  sent(id: string): Promise<void>;
  settle(id: string, response: unknown): Promise<void>;
  releaseUnsent(id: string): Promise<void>;
  abandon(id: string, reason: string): Promise<void>;
  snapshot(): BudgetSnapshot;
  close(): Promise<void>;
}
function responseReused(state: BudgetSnapshot, id: string, responseId: string) {
  return state.requests.some(
    (other) => other.id !== id && other.response?.startsWith(`${responseId}:`),
  );
}
interface Options {
  runId: string;
  conditions: MoneyConditions;
  save: (state: BudgetSnapshot) => Promise<void>;
  notify: (state: BudgetSnapshot) => Promise<void>;
}
// initialは同一run内の排他的委譲にだけ使う。保存済みrunを復元するCLIは持たない。
export function delegatedBudget(options: Options, initial?: BudgetSnapshot): BudgetLedger {
  const conditions = moneyConditions.parse(options.conditions);
  const state: BudgetSnapshot = initial
    ? budgetSnapshot.parse(structuredClone(initial))
    : {
        runId: options.runId,
        profileHash,
        settled: 0,
        unrecoverable: 0,
        reserved: 0,
        accounted: 0,
        stopped: false,
        notified: false,
        reason: null,
        requests: [],
      };
  assert(state.runId === options.runId && state.reserved === 0, 'Invalid delegation');
  let queue = Promise.resolve();
  let closed = false;
  const recordedFailures = new Set<string>();
  const stop = (reason: string) => {
    state.stopped = true;
    state.reason ??= reason;
  };
  const snapshot = () => structuredClone(state);
  const persist = async () => {
    state.accounted = state.settled + state.unrecoverable + state.reserved;
    if (state.accounted >= conditions.stop) {
      stop('Money stop threshold reached');
    }
    const notice = !state.notified && state.accounted >= conditions.notify;
    if (notice) {
      state.notified = true;
    }
    try {
      await options.save(snapshot());
      if (notice) {
        await options.notify(snapshot());
      }
    } catch (error) {
      stop('Budget persistence or notification failed');
      throw error;
    }
  };
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const find = (id: string) => {
    const r = state.requests.find((r) => r.id === id);
    assert(r, 'Unknown request ID');
    return r;
  };
  const abandon = (id: string, reason: string) => {
    const r = find(id);
    if (r.state === 'sent' || r.state === 'reserved') {
      state.reserved -= maximumReservation;
      state.unrecoverable += maximumReservation;
      r.state = 'unrecoverable';
      r.cost = maximumReservation;
    }
    stop(reason);
  };
  const retainFailure = async (id: string, reason: string) => {
    if (recordedFailures.has(id)) {
      return;
    }
    abandon(id, reason);
    await persist();
    // 保存と通知の確認が成功した要求だけ、同じ失敗の再保存を省く。
    recordedFailures.add(id);
  };
  const replay = async (r: z.infer<typeof requestState>, value: unknown) => {
    if (r.state !== 'settled') {
      return false;
    }
    try {
      assert(
        r.response === responseIdentity(usageSchema.parse(value), value),
        'Conflicting settlement',
      );
    } catch {
      stop('Conflicting settlement');
      await persist();
    }
    return true;
  };
  return {
    snapshot,
    reserve: (id) =>
      exclusive(async () => {
        if (closed || state.stopped) {
          return false;
        }
        assert(id && !state.requests.some((r) => r.id === id), 'Duplicate request ID');
        if (state.accounted + maximumReservation > conditions.stop) {
          stop('Insufficient money reservation');
          await persist();
          return false;
        }
        state.requests.push({
          id,
          state: 'reserved',
          cost: maximumReservation,
          response: null,
          billing: null,
        });
        state.reserved += maximumReservation;
        await persist();
        return true;
      }),
    sent: (id) =>
      exclusive(async () => {
        const r = find(id);
        assert(!closed && r.state === 'reserved', 'Request not reserved');
        r.state = 'sent';
        await persist();
      }),
    releaseUnsent: (id) =>
      exclusive(async () => {
        const r = find(id);
        assert(r.state === 'reserved', 'Cannot release a sent request');
        r.state = 'released';
        r.cost = 0;
        state.reserved -= maximumReservation;
        await persist();
      }),
    abandon: (id, reason) => exclusive(() => retainFailure(id, reason)),
    settle: (id, value) =>
      exclusive(async () => {
        const r = find(id);
        if (await replay(r, value)) {
          return;
        }
        assert(r.state === 'sent', 'Request was not sent');
        let cost: number;
        let response: z.infer<typeof usageSchema>;
        try {
          response = usageSchema.parse(value);
          cost = costOf(response);
        } catch (error) {
          r.observation = providerObservation(value);
          await retainFailure(id, 'Invalid provider usage or price assumptions');
          throw error;
        }
        const identity = responseIdentity(response, value);
        if (responseReused(state, id, response.id)) {
          await retainFailure(id, 'Provider response reused for another request');
          throw Error('Duplicate provider response ID');
        }
        state.reserved -= maximumReservation;
        state.settled += cost;
        r.state = 'settled';
        r.cost = cost;
        r.response = identity;
        r.billing = response;
        if (cost > maximumReservation) {
          stop('Observed cost exceeds reservation');
        }
        await persist();
      }),
    close: () =>
      exclusive(async () => {
        closed = true;
        for (const r of state.requests) {
          if (r.state === 'sent' || r.state === 'reserved') {
            abandon(r.id, 'Request unfinished at delegation close');
          }
        }
        await persist();
      }),
  };
}
export function createRunBudget(options: Options) {
  return delegatedBudget(options);
}
