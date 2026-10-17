import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { budgetApi, completed, conditions, ledger, reservation, seed } from './budget-contract.ts';

// 短文: (1000-200-300)*2 + 200*0.10 + 300*2.50 + 100*10
// = $0.00277。推論40は出力100の内数で、別に加算しない。
test('算定は書込みを置換し、推論を出力に再加算しない', async () => {
  const { calculateCost } = await budgetApi();
  expect(calculateCost(completed())).toBe(27_700);
  const response = completed();
  response.usage.output_tokens_details.reasoning_tokens = 0;
  expect(calculateCost(response)).toBe(27_700);
});

for (const [input, expected] of [
  [271999, 5_439_980],
  [272000, 5_440_000],
  [272001, 10_880_040],
] as const) {
  test(`長文閾値は入力${input}で要求全体に適用する`, async () => {
    const { calculateCost } = await budgetApi();
    const response = completed();
    response.usage = {
      ...response.usage,
      input_tokens: input,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: input,
    };
    expect(calculateCost(response)).toBe(expected);
  });
}

test('長文の読取り・書込み・出力へ全て長文単価を使い、最大予約は$4.73', async () => {
  const { calculateCost } = await budgetApi();
  const response = completed();
  response.usage.input_tokens = 272001;
  response.usage.input_tokens_details = { cached_tokens: 100000, cache_write_tokens: 100000 };
  response.usage.total_tokens = 272101;
  // 通常72001*$4 + 読取100000*$0.20 + 書込100000*$5 + 出力100*$15 / 1M。
  expect(calculateCost(response)).toBe(8_095_040);
  response.usage.input_tokens = 922000;
  response.usage.input_tokens_details = { cached_tokens: 0, cache_write_tokens: 922000 };
  response.usage.output_tokens = 8000;
  response.usage.total_tokens = 930000;
  expect(calculateCost(response)).toBe(reservation);
});

test('最小のcache読取りも整数単位で失わない', async () => {
  const { calculateCost } = await budgetApi();
  const response = completed();
  response.usage = {
    ...response.usage,
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1,
  };
  expect(calculateCost(response)).toBe(1);
});

const invalid: [string, (value: Record<string, unknown>) => void][] = [
  [
    'usage欠落',
    (value) => {
      delete value.usage;
    },
  ],
  [
    'model不一致',
    (value) => {
      value.model = 'gpt-6-astra';
    },
  ],
  [
    'tier欠落',
    (value) => {
      delete value.service_tier;
    },
  ],
  ...['auto', 'fast', 'ultrafast', 'priority', 'unknown'].map(
    (tier): [string, (value: Record<string, unknown>) => void] => [
      `tier ${tier}`,
      (value) => {
        value.service_tier = tier;
      },
    ],
  ),
];
for (const [name, change] of invalid) {
  test(`料金前提不一致は精算しない: ${name}`, async () => {
    const { calculateCost } = await budgetApi();
    expect(calculateCost(completed())).toBe(27_700);
    const response: Record<string, unknown> = completed();
    change(response);
    expect(() => calculateCost(response)).toThrow();
  });
}

for (const field of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens']) {
  for (const invalid of [undefined, -1, 0.5, NaN, Infinity, '1']) {
    test(`usageの${field}=${String(invalid)}を0へ補完しない`, async () => {
      const { calculateCost } = await budgetApi();
      expect(calculateCost(completed())).toBe(27_700);
      const response = completed();
      const target: Record<string, unknown> =
        field.endsWith('_tokens') && ['cached_tokens', 'cache_write_tokens'].includes(field)
          ? response.usage.input_tokens_details
          : response.usage;
      target[field] = invalid;
      expect(() => calculateCost(response)).toThrow();
    });
  }
}

for (const [name, change] of [
  [
    '内訳合計超過',
    (r: ReturnType<typeof completed>) => {
      r.usage.input_tokens_details.cache_write_tokens = 801;
    },
  ],
  [
    '最大入力超過',
    (r: ReturnType<typeof completed>) => {
      r.usage.input_tokens = 922001;
      r.usage.total_tokens = 922101;
    },
  ],
  [
    '最大出力超過',
    (r: ReturnType<typeof completed>) => {
      r.usage.output_tokens = 8001;
      r.usage.total_tokens = 9001;
    },
  ],
  [
    '推論が出力を超える',
    (r: ReturnType<typeof completed>) => {
      r.usage.output_tokens_details.reasoning_tokens = 101;
    },
  ],
] as const) {
  test(`usage不整合を精算しない: ${name}`, async () => {
    const { calculateCost } = await budgetApi();
    const response = completed();
    change(response);
    expect(() => calculateCost(response)).toThrow();
  });
}

test('ちょうど$500は許可して停止を固定し、1最小単位の超過は拒否する', async () => {
  const exact = await ledger(conditions.stop - reservation);
  expect(await exact.budget.reserve('exact')).toBe(true);
  expect(exact.budget.snapshot()).toMatchObject({
    accounted: conditions.stop,
    reserved: reservation,
    stopped: true,
  });
  await exact.budget.releaseUnsent('exact');
  expect(await exact.budget.reserve('no-resume')).toBe(false);
  const over = await ledger(conditions.stop - reservation + 1);
  expect(await over.budget.reserve('over')).toBe(false);
  expect(over.budget.snapshot()).toMatchObject({ reserved: 0, stopped: true });
});

test('並列要求は同じ残額を二重使用せず、拒否後の精算でも再開しない', async () => {
  const { budget } = await ledger(conditions.stop - reservation - 1);
  const results = await Promise.all(['a', 'b'].map((id) => budget.reserve(id)));
  expect(results.filter(Boolean)).toHaveLength(1);
  const id = results[0] ? 'a' : 'b';
  await budget.sent(id);
  await budget.settle(id, completed());
  expect(budget.snapshot()).toMatchObject({
    settled: conditions.stop - reservation - 1 + 27_700,
    reserved: 0,
    stopped: true,
  });
  expect(await budget.reserve('after')).toBe(false);
});

test('正常精算は未使用予約だけを戻し、再読取りで二重に減額しない', async () => {
  const { budget } = await ledger();
  assert(await budget.reserve('a'));
  await budget.sent('a');
  await budget.settle('a', completed());
  const first = budget.snapshot();
  expect(first).toMatchObject({
    settled: 27_700,
    reserved: 0,
    unrecoverable: 0,
    accounted: 27_700,
  });
  await budget.settle('a', completed()).catch(() => {});
  expect(budget.snapshot().accounted).toBe(27_700);
  await budget.settle('unknown-request', completed()).catch(() => {});
  expect(budget.snapshot().accounted).toBe(27_700);
});

for (const reason of ['HTTP 500', 'billing 429', 'disconnect', 'cancel', 'deadline', 'interrupt']) {
  test(`送信後の${reason}は最大予約を保持し全体停止する`, async () => {
    const { budget } = await ledger();
    assert(await budget.reserve('a'));
    await budget.sent('a');
    await budget.abandon('a', reason);
    expect(budget.snapshot()).toMatchObject({
      reserved: 0,
      unrecoverable: reservation,
      accounted: reservation,
      stopped: true,
    });
    expect(await budget.reserve('b')).toBe(false);
  });
}

test('送信前の拒否だけ返却でき、送信後を未送信扱いで解放できない', async () => {
  const { budget } = await ledger();
  assert(await budget.reserve('a'));
  await budget.releaseUnsent('a');
  expect(budget.snapshot().accounted).toBe(0);
  assert(await budget.reserve('b'));
  await budget.sent('b');
  await budget.releaseUnsent('b').catch(() => {});
  expect(budget.snapshot().accounted).toBe(reservation);
});

for (const delta of [-1, 0, 1]) {
  test(`通知閾値${delta}は予約時に一度だけ発行・保存する`, async () => {
    const { budget, saved, notices } = await ledger(conditions.notify - reservation + delta);
    assert(await budget.reserve('a'));
    expect(notices).toHaveLength(delta < 0 ? 0 : 1);
    expect(saved.at(-1)?.accounted).toBe(conditions.notify + delta);
    await budget.releaseUnsent('a');
    assert(await budget.reserve('b'));
    expect(notices).toHaveLength(delta < 0 ? 0 : 1);
  });
}

for (const failure of ['save', 'notify'] as const) {
  test(`${failure}失敗は送信許可を返さず、停止を保持する`, async () => {
    const { createRunBudget } = await budgetApi();
    let armed = false;
    const budget = createRunBudget({
      runId: 'failed-storage',
      conditions,
      save: async () => {
        if (armed && failure === 'save') {
          throw Error('disk full');
        }
      },
      notify: async () => {
        if (armed && failure === 'notify') {
          throw Error('output failed');
        }
      },
    });
    await seed(budget, conditions.notify - reservation);
    armed = true;
    const allowed = await budget.reserve('a').catch(() => false);
    expect(allowed).toBe(false);
    expect(budget.snapshot().stopped).toBe(true);
    expect(await budget.reserve('b').catch(() => false)).toBe(false);
  });
}

for (const mode of ['missing', 'negative', 'over-limit'] as const) {
  test(`不正usage ${mode}の精算は最大予約を返却不能額へ移して止める`, async () => {
    const { budget } = await ledger();
    assert(await budget.reserve('a'));
    await budget.sent('a');
    const response = completed();
    if (mode === 'negative') {
      response.usage.input_tokens = -1;
    }
    if (mode === 'over-limit') {
      response.usage.output_tokens = 8001;
    }
    const value = mode === 'missing' ? { ...response, usage: undefined } : response;
    await budget.settle('a', value).catch(() => {});
    expect(budget.snapshot()).toMatchObject({
      accounted: reservation,
      reserved: 0,
      unrecoverable: reservation,
      stopped: true,
    });
    expect(await budget.reserve('after')).toBe(false);
  });
}

test('同じ要求IDへの並列予約は二重計上しない', async () => {
  const { budget } = await ledger();
  await Promise.all(['a', 'a'].map((id) => budget.reserve(id).catch(() => false)));
  expect(budget.snapshot().reserved).toBe(reservation);
});

test('精算済み応答と競合する再精算は成功へ丸めず、既知金額を残す', async () => {
  const { budget } = await ledger();
  assert(await budget.reserve('a'));
  await budget.sent('a');
  await budget.settle('a', completed());
  const response = completed();
  response.usage.output_tokens = 101;
  response.usage.total_tokens = 1101;
  await budget.settle('a', response).catch(() => {});
  expect(budget.snapshot().settled).toBe(27_700);
  expect(budget.snapshot().stopped).toBe(true);
});

for (const [key, value] of [
  ['currency', 'JPY'],
  ['unit', 'cents'],
  ['budget', NaN],
  ['stop', Infinity],
  ['notify', 0.5],
  ['stop', conditions.budget + 1],
  ['notify', conditions.stop + 1],
] as const) {
  test(`金額条件${key}=${String(value)}は開始前に拒否する`, async () => {
    const { createRunBudget } = await budgetApi();
    expect(() =>
      Reflect.apply(createRunBudget, undefined, [
        {
          runId: 'invalid',
          conditions: { ...conditions, [key]: value },
          save: async () => {},
          notify: async () => {},
        },
      ]),
    ).toThrow();
  });
}

for (const waiting of ['save', 'notify'] as const) {
  test(`${waiting}の非同期完了を待つまで要求の送信許可を返さない`, async () => {
    const { createRunBudget } = await budgetApi();
    const started = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    let armed = false;
    let allowed = false;
    const wait = async (kind: string) => {
      if (armed && kind === waiting) {
        started.resolve();
        await ready.promise;
      }
    };
    const budget = createRunBudget({
      runId: 'ordered-notification',
      conditions,
      save: () => wait('save'),
      notify: () => wait('notify'),
    });
    await seed(budget, conditions.notify - reservation);
    armed = true;
    const pending = budget.reserve('a').then((value) => {
      allowed = value;
    });
    try {
      await started.promise;
      await Promise.resolve();
      expect(allowed).toBe(false);
      ready.resolve();
      await pending;
      expect(allowed).toBe(true);
    } finally {
      ready.resolve();
      await pending;
    }
  });
}
