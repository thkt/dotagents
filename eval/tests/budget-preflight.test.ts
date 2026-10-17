import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { isRecord } from '../../scripts/shared/values.ts';
import { providerGateway } from '../container.ts';
import { ledger } from './budget-contract.ts';

// 公開仕様から作った合成fixture。実APIの採取原本・実Dockerの成功証拠ではない。
test('固定7シナリオの終端usageは同じ金額gatewayを通して精算できる', async () => {
  const scenarios: unknown = JSON.parse(
    await readFile(join(import.meta.dir, 'preflight.json'), 'utf8'),
  );
  assert(Array.isArray(scenarios));
  expect(
    scenarios.map((value: unknown) => {
      assert(isRecord(value));
      return value.id;
    }),
  ).toEqual([
    'scoping',
    'initial',
    'boundaries',
    'command-failure',
    'missing-marker',
    'timeout',
    'interrupt',
  ]);
  const { budget } = await ledger();
  let settled = 0;
  let count = 0;
  for (const scenario of scenarios) {
    assert(isRecord(scenario) && Array.isArray(scenario.steps));
    const steps: unknown[] = scenario.steps;
    const limits = {
      model: 'gpt-6.1-sol',
      reasoning: 'medium',
      maxRequests: 4,
      maxOutputTokens: 8000,
      budget,
    };
    let sent = 0;
    // 実preflightと同じく、シナリオ内の全往復を同じgatewayへ渡す。
    const gateway = providerGateway(limits, '', async () => {
      const step: unknown = steps[sent++];
      assert(isRecord(step) && typeof step.sse === 'string');
      return new Response(step.sse, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    try {
      for (const [index, step] of steps.entries()) {
        assert(isRecord(step) && typeof step.sse === 'string');
        const events: unknown[] = step.sse
          .split('\n')
          .filter((line: string) => line.startsWith('data: '))
          .map((line: string) => JSON.parse(line.slice(6)) as unknown);
        const terminal = events.filter(
          (value): value is Record<string, unknown> =>
            isRecord(value) && value.type === 'response.completed',
        );
        expect(terminal).toHaveLength(1);
        const response = terminal[0]?.response;
        assert(isRecord(response) && isRecord(response.usage));
        expect(response).toMatchObject({
          model: 'gpt-6.1-sol',
          service_tier: 'default',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        });
        const result = await gateway.handle(
          new Request('http://gateway:8080/v1/responses', {
            method: 'POST',
            body: JSON.stringify({
              model: limits.model,
              reasoning: { effort: limits.reasoning },
              input: `公開固定入力 ${String(scenario.id)} ${index}`,
            }),
          }),
        );
        expect(result.status).toBe(200);
        await result.text();
        // 固定入力1*$2 + 出力1*$10 / 1M = $0.000012。
        settled += 120;
        count++;
        expect(budget.snapshot()).toMatchObject({
          settled,
          reserved: 0,
          unrecoverable: 0,
          stopped: false,
        });
      }
      expect(sent).toBe(steps.length);
      expect(gateway.stats()).toEqual({ requests: sent, rejected: 0, failed: false });
    } finally {
      gateway.stop();
    }
    // 精算完了後の通常の終了を、不明な送信中要求の取消と取り違えない。
    expect(budget.snapshot()).toMatchObject({
      settled,
      reserved: 0,
      unrecoverable: 0,
      stopped: false,
    });
  }
  expect(count).toBe(12);
});
