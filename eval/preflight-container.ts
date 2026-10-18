// モデルなしの専用入口。本番gatewayはこのファイルをimportしない。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gatewayBindAddress, providerGateway } from './container.ts';
import { runtimeBudget } from './budget-runtime.ts';

export const preflightGatewayEntrypoint = import.meta.path;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function preflightSettings() {
  const settings: unknown = JSON.parse(await readFile('/runtime/settings.json', 'utf8'));
  assert(
    record(settings) &&
      typeof settings.expiresAt === 'number' &&
      typeof settings.model === 'string' &&
      typeof settings.reasoning === 'string' &&
      typeof settings.maxRequests === 'number' &&
      typeof settings.maxOutputTokens === 'number',
    'Missing preflight settings',
  );
  assert(process.getuid?.() === 1000 && process.pid === 1, 'Unexpected preflight container');
  assert(
    !Object.keys(process.env).some((key) => /TOKEN|KEY|AUTH|PROXY/.test(key)),
    'Credentials present',
  );
  assert(settings.expiresAt > Date.now(), 'Deadline expired');
  const routes = await readFile('/proc/net/route', 'utf8');
  assert(
    !routes
      .split('\n')
      .slice(1)
      .some((line) => line.split(/\s+/)[1] === '00000000'),
    'External route present',
  );
  assert(
    (await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim() === '0',
    'Forwarding enabled',
  );
  return {
    model: settings.model,
    reasoning: settings.reasoning,
    maxRequests: settings.maxRequests,
    maxOutputTokens: settings.maxOutputTokens,
    budgetRequired: settings.budgetRequired,
    expiresAt: settings.expiresAt,
    requestExpiresAt:
      typeof settings.requestExpiresAt === 'number'
        ? settings.requestExpiresAt
        : settings.expiresAt,
    networkCanary: settings.networkCanary,
  };
}

async function servePreflight(settings: Awaited<ReturnType<typeof preflightSettings>>) {
  const scenario: unknown = JSON.parse(await readFile('/runtime/scenario.json', 'utf8'));
  assert(record(scenario) && Array.isArray(scenario.steps), 'Missing fixed responses');
  const steps: unknown[] = scenario.steps;
  let step = 0;
  const budget = await runtimeBudget();
  assert(!settings.budgetRequired || budget, 'Preflight money delegation missing');
  const gateway = providerGateway(
    { ...settings, expiresAt: settings.requestExpiresAt, budget },
    '',
    async (_url, init) => {
      const response = steps[step++];
      assert(
        record(response) &&
          typeof response.sse === 'string' &&
          Array.isArray(response.requestIncludes) &&
          typeof init.body === 'string',
        'Unexpected request',
      );
      console.log(
        JSON.stringify({ type: 'preflight.request', step, body: JSON.parse(init.body) as unknown }),
      );
      for (const required of response.requestIncludes) {
        assert(
          typeof required === 'string' && init.body.includes(required),
          'Required tool result missing',
        );
      }
      return new Response(response.sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  );
  Bun.serve({
    port: 8080,
    hostname: await gatewayBindAddress(),
    maxRequestBodySize: 8 * 1024 * 1024,
    fetch: (request) => gateway.handle(request),
  });
  process.on('exit', () => {
    gateway.stop();
    console.log(JSON.stringify({ ...gateway.stats(), steps: step }));
  });
}

async function serveCanary() {
  const scenario: unknown = JSON.parse(await readFile('/runtime/scenario.json', 'utf8'));
  assert(record(scenario) && record(scenario.networkCanary), 'Missing network canary');
  const canary = scenario.networkCanary;
  assert(
    typeof canary.path === 'string' &&
      /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(canary.path) &&
      typeof canary.body === 'string' &&
      canary.body.length > 0,
    'Invalid canary definition',
  );
  const path = canary.path,
    body = canary.body;
  Bun.serve({
    port: 8081,
    hostname: '0.0.0.0',
    maxRequestBodySize: 1024,
    fetch(request) {
      const url = new URL(request.url);
      return request.method === 'GET' && url.pathname === path && !url.search
        ? new Response(body)
        : new Response('Not found', { status: 404 });
    },
  });
  console.log(JSON.stringify({ type: 'preflight.canary-ready' }));
}

async function controlCanary(settings: Awaited<ReturnType<typeof preflightSettings>>) {
  const canary = settings.networkCanary;
  assert(
    record(canary) &&
      typeof canary.ipUrl === 'string' &&
      typeof canary.dnsUrl === 'string' &&
      typeof canary.body === 'string',
    'Missing canary destinations',
  );
  assert(
    /^http:\/\/[0-9.]+:8081\/[a-zA-Z0-9_/-]+$/.test(canary.ipUrl) &&
      /^http:\/\/canary:8081\/[a-zA-Z0-9_/-]+$/.test(canary.dnsUrl),
    'Invalid canary destinations',
  );
  const checks = [];
  for (const url of [canary.ipUrl, canary.dnsUrl]) {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(2000, settings.expiresAt - Date.now()))),
    });
    const body = await response.text();
    assert(
      response.status === 200 && body === canary.body,
      'Canary control did not reach expected listener',
    );
    checks.push({ url, status: response.status, body });
  }
  console.log(JSON.stringify({ type: 'preflight.canary-control', checks }));
}

if (import.meta.main) {
  const settings = await preflightSettings();
  const role = process.argv[2];
  if (role === 'preflight-control') {
    await controlCanary(settings);
  } else {
    if (role === 'preflight-gateway') {
      await servePreflight(settings);
    } else {
      assert(role === 'preflight-canary', 'Unknown preflight role');
      await serveCanary();
    }
    setTimeout(() => process.exit(124), settings.expiresAt - Date.now());
  }
}
