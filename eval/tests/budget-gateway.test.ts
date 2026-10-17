import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { providerGateway } from '../container.ts';
import { completed, conditions, ledger, reservation, type Ledger } from './budget-contract.ts';

const limits = {
  model: 'gpt-6.1-sol',
  reasoning: 'medium',
  maxRequests: 20,
  maxOutputTokens: 8000,
};
const withBudget = (budget: Ledger) => ({ ...limits, budget });
const request = (input = '公開入力', extra = {}) =>
  new Request('http://gateway:8080/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: limits.model, reasoning: { effort: 'medium' }, input, ...extra }),
  });
const event = (response: unknown) =>
  `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
const stream = (text: string) =>
  new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });

// 既存handle/sendの接続を維持し、ホスト所有の台帳だけをlimits.budgetへ渡す。
// 他試行の残額は要求本文や公開statsへ渡さない。内部接続の選択でありIssueの追加要求ではない。
test('予約・保存・通知が完了してから固定endpointへStandardを明示して送る', async () => {
  const { budget, saved, notices } = await ledger(conditions.notify - reservation);
  let calls = 0;
  const gateway = providerGateway(withBudget(budget), 'SYNTHETIC_KEY', async (url, init) => {
    calls++;
    expect(saved.at(-1)?.reserved).toBe(reservation);
    expect(notices).toHaveLength(1);
    expect(url).toBe('https://api.openai.com/v1/responses');
    assert(typeof init.body === 'string');
    const body: unknown = JSON.parse(init.body);
    expect(body).toMatchObject({ service_tier: 'default', store: false, max_output_tokens: 8000 });
    expect(init.redirect).toBe('error');
    expect(init.body).not.toMatch(/synthetic-cost-run|usd-1e-7|initialSettled|unrecoverable/);
    return stream(event(completed()));
  });
  try {
    const first = await gateway.handle(request());
    expect(first.status).toBe(200);
    await first.text();
    expect(calls).toBe(1);
    expect(budget.snapshot().reserved).toBe(0);
    expect(budget.snapshot().settled).toBe(conditions.notify - reservation + 27_700);
    const stats = await gateway.handle(new Request('http://gateway:8080/stats'));
    expect(await stats.json()).toEqual({ requests: 1, rejected: 0, failed: false });
  } finally {
    gateway.stop();
  }
});

test('金額不足では上流送信0、gateway交代・A/B切替えでも累計をリセットしない', async () => {
  const { budget } = await ledger(conditions.stop - reservation + 1);
  let calls = 0;
  for (const side of ['before', 'after']) {
    const gateway = providerGateway(withBudget(budget), 'SYNTHETIC_KEY', async () => {
      calls++;
      return stream(event(completed()));
    });
    try {
      expect((await gateway.handle(request(side))).status).toBe(403);
    } finally {
      gateway.stop();
    }
  }
  expect(calls).toBe(0);
  expect(budget.snapshot().stopped).toBe(true);
});

test('2つのgatewayの正常精算も同じrunの台帳へ累積する', async () => {
  const { budget } = await ledger();
  for (const side of ['before', 'after']) {
    const gateway = providerGateway(withBudget(budget), 'SYNTHETIC_KEY', async () =>
      stream(event(completed(`resp_${side}`))),
    );
    try {
      const response = await gateway.handle(request(side));
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      gateway.stop();
    }
  }
  expect(budget.snapshot()).toMatchObject({
    settled: 55_400,
    reserved: 0,
    unrecoverable: 0,
    accounted: 55_400,
  });
});

for (const tier of ['fast', 'ultrafast', 'priority', 'auto']) {
  test(`actorのtier ${tier}指定で高額経路へ進まない`, async () => {
    const { budget } = await ledger();
    let calls = 0;
    const gateway = providerGateway(withBudget(budget), 'SYNTHETIC_KEY', async (_url, init) => {
      calls++;
      assert(typeof init.body === 'string');
      const body: unknown = JSON.parse(init.body);
      expect(body).toMatchObject({ service_tier: 'default' });
      return stream(event(completed()));
    });
    try {
      // 拒否または固定値への正規化のどちらでも、上書きしたtierを送信しない。
      const response = await gateway.handle(request(tier, { service_tier: tier }));
      await response.text().catch(() => {});
      expect([200, 403]).toContain(response.status);
      if (response.status === 403) {
        expect(calls).toBe(0);
      }
    } finally {
      gateway.stop();
    }
  });
}

for (const mode of [
  'missing-usage',
  'wrong-tier',
  'duplicate',
  'conflicting',
  'wrong-response-id',
  'truncated',
  'http-500',
  'billing-429',
  'incomplete',
  'post-terminal-invalid',
  'transport-error',
  'broken-stream',
] as const) {
  test(`精算不能${mode}は予約を消さず、別gatewayの後続送信も止める`, async () => {
    const { budget } = await ledger();
    let calls = 0;
    const first = completed();
    const invalid: Record<string, unknown> = structuredClone(first);
    if (mode === 'missing-usage') {
      delete invalid.usage;
    }
    if (mode === 'wrong-tier') {
      invalid.service_tier = 'fast';
    }
    const created = `data: ${JSON.stringify({ type: 'response.created', response: { id: first.id, status: 'in_progress' } })}\n\n`;
    const textByMode: Record<string, string> = {
      duplicate: event(first) + event(first),
      conflicting:
        event(first) +
        event({ ...first, usage: { ...first.usage, output_tokens: 101, total_tokens: 1101 } }),
      'wrong-response-id': created + event({ ...first, id: 'resp_other' }),
      truncated: created,
      incomplete:
        created + 'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
      'post-terminal-invalid': event(first) + 'data: {\n\n',
    };
    const text = textByMode[mode] ?? event(invalid);
    const send = async () => {
      calls++;
      if (mode === 'transport-error') {
        throw Error('合成接続失敗');
      }
      if (mode === 'broken-stream') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Error('合成stream切断'));
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (mode === 'http-500' || mode === 'billing-429') {
        return new Response('合成provider失敗', { status: mode === 'http-500' ? 500 : 429 });
      }
      return stream(text);
    };
    const gateway = providerGateway(withBudget(budget), 'SYNTHETIC_KEY', send);
    try {
      const response = await gateway.handle(request());
      await response.text().catch(() => {});
      expect(calls).toBe(1);
      expect(budget.snapshot()).toMatchObject({
        accounted: reservation,
        unrecoverable: reservation,
        reserved: 0,
        stopped: true,
      });
      const next = providerGateway(withBudget(budget), 'SYNTHETIC_KEY', send);
      try {
        expect((await next.handle(request('次試行'))).status).toBe(403);
      } finally {
        next.stop();
      }
      expect(calls).toBe(1);
    } finally {
      gateway.stop();
    }
  });
}

test('終端イベント到達だけでは予約を解放せず、EOF後に一度精算する', async () => {
  const { budget } = await ledger();
  let finish: (() => void) | undefined;
  const bytes = new TextEncoder().encode(event(completed()));
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      // JSONやdata:行をまたぐchunk境界で分割する。
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.slice(i, i + 7));
      }
      let closed = false;
      finish = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
    },
  });
  const gateway = providerGateway(
    withBudget(budget),
    'SYNTHETIC_KEY',
    async () => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  try {
    const response = await gateway.handle(request());
    const reader = response.body?.getReader();
    assert(reader && finish);
    let received = 0;
    while (received < bytes.length) {
      const chunk: { done?: boolean; value?: Uint8Array } = await reader.read();
      assert(!chunk.done && chunk.value);
      received += chunk.value.length;
    }
    expect(budget.snapshot()).toMatchObject({ reserved: reservation, settled: 0 });
    finish();
    while (!(await reader.read()).done) {
      /* EOFまで観測する */
    }
    expect(budget.snapshot()).toMatchObject({ reserved: 0, settled: 27_700 });
  } finally {
    finish?.();
    gateway.stop();
  }
});

// 旧来の中継接続でも観測可能な、終端競合そのものの回帰対照。
for (const duplicate of [false, true]) {
  test(`SSE終端の一意性: ${duplicate ? '重複を拒否' : '正常対照'}`, async () => {
    let calls = 0;
    const gateway = providerGateway(limits, 'SYNTHETIC_KEY', async () => {
      calls++;
      return stream(event(completed()) + (duplicate ? event(completed()) : ''));
    });
    try {
      const response = await gateway.handle(request());
      expect(response.status).toBe(200);
      await response.text().catch(() => {});
      expect((await gateway.handle(request('次の往復'))).status).toBe(duplicate ? 403 : 200);
      expect(calls).toBe(duplicate ? 1 : 2);
    } finally {
      gateway.stop();
    }
  });
}

test('clientのstream取消は送信済み予約を返却不能にして次試行を止める', async () => {
  const { budget } = await ledger();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.created","response":{"id":"resp_pending","status":"in_progress"}}\n\n',
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const gateway = providerGateway(
    withBudget(budget),
    'SYNTHETIC_KEY',
    async () => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  try {
    const response = await gateway.handle(request());
    expect(response.status).toBe(200);
    assert(response.body);
    await response.body.cancel();
    expect(cancelled).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      unrecoverable: reservation,
      accounted: reservation,
      reserved: 0,
      stopped: true,
    });
    expect(await budget.reserve('after-cancel')).toBe(false);
  } finally {
    gateway.stop();
  }
});
