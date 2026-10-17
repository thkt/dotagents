// Runs only in the disposable container. No host credentials are passed to the actor.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BudgetLedger } from './budget.ts';
import { runtimeBudget } from './budget-runtime.ts';

interface Limits {
  model: string;
  reasoning: string;
  maxRequests: number;
  maxOutputTokens: number;
  expiresAt?: number;
  budget?: Pick<BudgetLedger, 'reserve' | 'sent' | 'settle' | 'abandon'>;
}

interface RuntimeVersions {
  cli: string;
  bun: string;
  entryBun: string;
  git: string;
}

export async function gatewayBindAddress() {
  // aliasは隔離網だけに登録する。作成時の未割当てIPやwildcardでは待ち受けない。
  const { address } = await lookup('gateway', { family: 4 });
  assert(
    Object.values(networkInterfaces())
      .flat()
      .some((entry) => entry?.address === address && !entry.internal),
    'Gateway alias is not a local interface',
  );
  return address;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 制御フィールドと、Schema・grammar・コードのデータを別々に検査する。
function fields(value: Record<string, unknown>, allowed: string[]) {
  assert(
    Object.keys(value).every((key) => allowed.includes(key)),
    'Unknown protocol field',
  );
}

function identifier(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value), 'Invalid tool name');
}

function optionalText(value: unknown): asserts value is string | undefined {
  assert(value === undefined || typeof value === 'string', 'Invalid text');
}

function clientMetadata(value: unknown) {
  if (value === undefined) {
    return;
  }
  assert(record(value), 'Invalid client metadata');
  fields(value, [
    'x-codex-installation-id',
    'x-codex-turn-metadata',
    'turn_id',
    'x-codex-window-id',
    'session_id',
    'root_turn_id',
    'thread_id',
  ]);
  assert(
    Object.values(value).every((entry) => typeof entry === 'string'),
    'Invalid client metadata value',
  );
}

function requestMetadata(value: Record<string, unknown>) {
  clientMetadata(value.client_metadata);
  optionalText(value.prompt_cache_key);
  assert(value.stream === undefined || typeof value.stream === 'boolean', 'Invalid stream setting');
  assert(
    value.metadata === undefined ||
      (record(value.metadata) &&
        Object.values(value.metadata).every((entry) => typeof entry === 'string')),
    'Invalid metadata',
  );
}

function localSchema(value: unknown): void {
  if (typeof value === 'boolean') {
    return;
  }
  assert(record(value), 'Invalid JSON Schema');
  for (const [key, child] of Object.entries(value)) {
    if (['$ref', '$dynamicRef', '$recursiveRef', '$id', '$schema'].includes(key)) {
      assert(typeof child === 'string' && child.startsWith('#'), 'External schema reference');
    } else {
      schemaChildren(key, child);
    }
  }
}

function schemaChildren(key: string, value: unknown) {
  if (key === 'dependencies') {
    assert(record(value), 'Invalid schema dependencies');
    for (const dependency of Object.values(value)) {
      if (Array.isArray(dependency)) {
        assert(
          dependency.every((name) => typeof name === 'string'),
          'Invalid property dependencies',
        );
      } else {
        localSchema(dependency);
      }
    }
  } else if (
    ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)
  ) {
    assert(record(value), 'Invalid schema map');
    Object.values(value).forEach(localSchema);
  } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
    assert(Array.isArray(value), 'Invalid schema list');
    value.forEach(localSchema);
  } else if (
    [
      'items',
      'additionalItems',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'additionalProperties',
      'unevaluatedProperties',
      'unevaluatedItems',
      'propertyNames',
    ].includes(key)
  ) {
    // 旧draftのtuple itemsもinlineとして扱う。default・const・enumは任意のデータ。
    if (Array.isArray(value)) {
      value.forEach(localSchema);
    } else {
      localSchema(value);
    }
  }
}

function declaration(tool: unknown, names: Map<string, string>, prefix = '') {
  assert(record(tool), 'Invalid tool declaration');
  identifier(tool.name);
  const name = prefix + tool.name;
  assert(!names.has(name), 'Duplicate or conflicting tool');
  names.set(name, String(tool.type));
  optionalText(tool.description);
  if (tool.type === 'namespace') {
    fields(tool, ['type', 'name', 'description', 'tools']);
    assert(!prefix && Array.isArray(tool.tools) && tool.tools.length > 0, 'Invalid namespace');
    tool.tools.forEach((leaf: unknown) => declaration(leaf, names, `${name}.`));
  } else if (tool.type === 'function') {
    fields(tool, ['type', 'name', 'description', 'strict', 'parameters']);
    assert(tool.strict === undefined || typeof tool.strict === 'boolean', 'Invalid strict');
    assert(record(tool.parameters), 'Invalid parameters');
    localSchema(tool.parameters);
  } else {
    assert(tool.type === 'custom', 'Remote or unknown tool');
    fields(tool, ['type', 'name', 'description', 'format']);
    if (tool.format !== undefined) {
      assert(record(tool.format), 'Invalid custom format');
      if (tool.format.type === 'text') {
        fields(tool.format, ['type']);
      } else {
        fields(tool.format, ['type', 'syntax', 'definition']);
        assert(
          tool.format.type === 'grammar' &&
            tool.format.syntax === 'lark' &&
            typeof tool.format.definition === 'string',
          'Only inline Lark grammar supported',
        );
      }
    }
  }
}

function content(value: unknown, textTypes: string[]) {
  if (typeof value === 'string') {
    return;
  }
  assert(Array.isArray(value), 'Inline text required');
  for (const part of value) {
    assert(record(part) && textTypes.includes(String(part.type)), 'Remote content forbidden');
    fields(part, ['type', 'text', 'annotations']);
    assert(typeof part.text === 'string', 'Invalid content text');
    assert(
      part.annotations === undefined ||
        (Array.isArray(part.annotations) && part.annotations.length === 0),
      'Unsupported annotations',
    );
  }
}

function callItem(
  item: Record<string, unknown>,
  calls: Map<string, string>,
  names: Map<string, string>,
  used: Set<string>,
) {
  const output = String(item.type).endsWith('_output');
  const kind = String(item.type).startsWith('custom') ? 'custom' : 'function';
  assert(typeof item.call_id === 'string' && item.call_id.length > 0, 'Missing call id');
  if (output) {
    fields(item, ['type', 'id', 'call_id', 'output', 'status']);
    assert(calls.get(item.call_id) === kind, 'Unmatched tool result');
    calls.delete(item.call_id);
    content(item.output, ['input_text']);
    return;
  }
  fields(item, [
    'type',
    'id',
    'call_id',
    'name',
    'namespace',
    kind === 'custom' ? 'input' : 'arguments',
    'status',
  ]);
  assert(typeof item.name === 'string', 'Missing call target');
  optionalText(item.namespace);
  const name = item.namespace ? `${item.namespace}.${item.name}` : item.name;
  // 旧inline履歴は宣言を含まない。新形式では宣言との型・宛先対応も必要。
  assert(!names.size || names.get(name) === kind, 'Unknown or mismatched call target');
  assert(!used.has(item.call_id), 'Duplicate call id');
  assert(typeof item[kind === 'custom' ? 'input' : 'arguments'] === 'string', 'Invalid call data');
  calls.set(item.call_id, kind);
  used.add(item.call_id);
}

function conversation(item: Record<string, unknown>) {
  if (item.type === 'message' || item.type === undefined) {
    fields(item, ['type', 'id', 'role', 'content', 'status', 'phase']);
    assert(
      ['user', 'assistant', 'developer', 'system'].includes(String(item.role)),
      'Invalid role',
    );
    content(item.content, ['input_text', 'output_text']);
  } else {
    assert(item.type === 'reasoning', 'Unsupported input item or control');
    fields(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status']);
    content(item.summary ?? [], ['summary_text']);
    if (item.content !== undefined) {
      content(item.content, ['reasoning_text']);
    }
    optionalText(item.encrypted_content);
  }
}

function inlineInput(value: unknown, names: Map<string, string>) {
  if (typeof value === 'string') {
    return;
  }
  assert(Array.isArray(value), 'Invalid input');
  // 宣言位置にかかわらず同じ要求の宛先を照合する。宣言のない旧履歴は維持する。
  for (const item of value) {
    if (record(item) && item.type === 'additional_tools') {
      fields(item, ['type', 'id', 'role', 'tools']);
      assert(
        item.role === 'developer' &&
          typeof item.id === 'string' &&
          Array.isArray(item.tools) &&
          item.tools.length > 0,
        'Invalid additional tools',
      );
      item.tools.forEach((tool: unknown) => declaration(tool, names));
    }
  }
  const ids = new Set<string>();
  const calls = new Map<string, string>();
  const used = new Set<string>();
  for (const item of value) {
    assert(record(item), 'Invalid input item');
    if (item.id !== undefined) {
      assert(
        typeof item.id === 'string' && item.id.length > 0 && !ids.has(item.id),
        'Invalid item id',
      );
      ids.add(item.id);
    }
    if (item.type === 'additional_tools') {
      continue;
    } else if (
      [
        'function_call',
        'function_call_output',
        'custom_tool_call',
        'custom_tool_call_output',
      ].includes(String(item.type))
    ) {
      callItem(item, calls, names, used);
    } else {
      conversation(item);
    }
  }
  assert(calls.size === 0, 'Missing tool results');
}

function reasoningSettings(value: unknown, effort: string) {
  assert(record(value) && value.effort === effort, 'Settings mismatch');
  fields(value, ['effort', 'summary', 'context']);
  assert(
    value.context === undefined || value.context === 'all_turns',
    'Unsupported reasoning context',
  );
  assert(
    value.summary === undefined ||
      (typeof value.summary === 'string' &&
        ['auto', 'concise', 'detailed'].includes(value.summary)),
    'Unsupported reasoning summary',
  );
}

export function providerBody(value: unknown, limits: Limits) {
  assert(record(value) && value.model === limits.model, 'Model mismatch');
  fields(value, [
    'model',
    'reasoning',
    'input',
    'instructions',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'store',
    'max_output_tokens',
    'stream',
    'include',
    'text',
    'prompt_cache_key',
    'metadata',
    'client_metadata',
  ]);
  reasoningSettings(value.reasoning, limits.reasoning);
  requestMetadata(value);
  optionalText(value.instructions);
  assert(
    value.tool_choice === undefined || value.tool_choice === 'auto' || value.tool_choice === 'none',
    'Unsupported tool choice',
  );
  assert(
    value.parallel_tool_calls === undefined || typeof value.parallel_tool_calls === 'boolean',
    'Invalid parallel tools',
  );
  const names = new Map<string, string>();
  assert(value.tools === undefined || Array.isArray(value.tools), 'Invalid tools');
  (value.tools as unknown[] | undefined)?.forEach((tool) => declaration(tool, names));
  inlineInput(value.input, names);
  if (value.text !== undefined) {
    assert(record(value.text), 'Invalid text settings');
    fields(value.text, ['format', 'verbosity']);
    if (value.text.format !== undefined) {
      assert(record(value.text.format), 'Invalid output format');
      fields(value.text.format, ['type', 'name', 'schema', 'strict']);
      assert(
        ['text', 'json_schema'].includes(String(value.text.format.type)),
        'Unsupported output format',
      );
      if (value.text.format.type === 'json_schema') {
        assert(record(value.text.format.schema), 'Missing output schema');
        localSchema(value.text.format.schema);
      }
    }
  }
  assert(
    value.include === undefined ||
      (Array.isArray(value.include) &&
        value.include.every((entry) => entry === 'reasoning.encrypted_content')),
    'Unsupported inclusion',
  );
  return {
    ...value,
    store: false,
    max_output_tokens: limits.maxOutputTokens,
    ...(limits.budget ? { service_tier: 'default' } : {}),
  };
}

function completionFailed(event: Record<string, unknown>) {
  return !record(event.response) || event.response.status !== 'completed';
}

async function completeStream(
  terminal: Record<string, unknown> | undefined,
  fail: () => Promise<void>,
  settle: (response: unknown) => Promise<void>,
) {
  if (terminal) {
    await settle(terminal);
  } else {
    await fail();
  }
}

function monitorResponse(
  body: ReadableStream<Uint8Array>,
  fail: () => Promise<void>,
  settle: (response: unknown) => Promise<void>,
) {
  const reader = body.getReader();
  let cancelled = false;
  let upstreamComplete = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let pending = '';
      let terminal: Record<string, unknown> | undefined;
      let responseId: string | undefined;
      let sawDone = false;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const observe = (line: string) => {
        if (!line.startsWith('data:')) {
          return;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          assert(terminal, 'Premature stream end');
          assert(!sawDone, 'Duplicate stream end');
          sawDone = true;
          return;
        }
        const event: unknown = JSON.parse(data);
        assert(record(event), 'Invalid provider event');
        assert(!terminal, 'Event after terminal response');
        if (record(event.response) && typeof event.response.id === 'string') {
          assert(!responseId || responseId === event.response.id, 'Response ID mismatch');
          responseId = event.response.id;
        }
        assert(
          !['error', 'response.failed', 'response.incomplete'].includes(String(event.type)),
          'Provider failed',
        );
        if (event.type === 'response.completed') {
          assert(!completionFailed(event) && record(event.response), 'Incomplete response');
          terminal = event.response;
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          pending += decoder.decode(value, { stream: true });
          assert(pending.length <= 4 * 1024 * 1024, 'Provider event too large');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          lines.forEach(observe);
          if (!cancelled) {
            controller.enqueue(value);
          }
        }
        pending += decoder.decode();
        observe(pending);
        assert(!cancelled, 'Stream cancelled');
        // EOFと一意な終端を確認済みなら、ホストの精算確認中の下流切断で
        // 確定済みのusageを不明額へ戻さない。精算自体の失敗はcatchで止める。
        upstreamComplete = Boolean(terminal);
        await completeStream(terminal, fail, settle);
        closeResponse(controller, cancelled);
      } catch (error) {
        await fail();
        if (!cancelled) {
          controller.error(error);
        }
        await reader.cancel().catch(() => {});
      }
    },
    async cancel() {
      cancelled = true;
      if (!upstreamComplete) {
        await fail();
      }
      await reader.cancel();
    },
  });
}

function closeResponse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  cancelled: boolean,
) {
  if (!cancelled) {
    controller.close();
  }
}

function gatewayInfo(
  request: Request,
  stats: { requests: number; rejected: number; failed: boolean },
) {
  if (request.method !== 'GET') {
    return null;
  }
  const path = new URL(request.url).pathname;
  if (path === '/stats') {
    return Response.json(stats);
  }
  if (path === '/health') {
    return Response.json({ ready: true });
  }
  return null;
}

function requestDeadline(limits: Limits) {
  assert(!limits.expiresAt || Date.now() < limits.expiresAt, 'Request deadline expired');
}
async function abandonRequest(
  limits: Limits,
  id?: string,
  reason = 'Provider request failed or interrupted',
) {
  if (id) {
    await limits.budget?.abandon(id, reason);
  }
}
async function settleRequest(limits: Limits, id: string | undefined, response: unknown) {
  if (id) {
    await limits.budget?.settle(id, response);
  }
}

// A narrow gateway, not a general proxy. No forwarded URL, auth, headers or redirects.
export function providerGateway(
  limits: Limits,
  key: string,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  let requests = 0;
  let rejected = 0;
  let failed = false;
  const hashes = new Set<string>();
  const controller = new AbortController();
  return {
    stats: () => ({ requests, rejected, failed }),
    stop: () => controller.abort(),
    async handle(request: Request) {
      const info = gatewayInfo(request, { requests, rejected, failed });
      if (info) {
        return info;
      }
      let requestId: string | undefined;
      const fail = async (reason?: string) => {
        failed = true;
        await abandonRequest(limits, requestId, reason);
      };
      try {
        assert(
          request.method === 'POST' &&
            new URL(request.url).pathname === '/v1/responses' &&
            !new URL(request.url).search,
          'Endpoint forbidden',
        );
        requestDeadline(limits);
        assert(
          !failed && requests < limits.maxRequests,
          'Model budget exhausted or previous request failed',
        );
        const raw = await request.text();
        assert(Buffer.byteLength(raw) <= 8 * 1024 * 1024, 'Request too large');
        const body = providerBody(JSON.parse(raw), limits);
        assert(!failed && requests < limits.maxRequests, 'Model budget exhausted');
        const hash = createHash('sha256').update(raw).digest('hex');
        assert(!hashes.has(hash), 'Request retry forbidden');
        hashes.add(hash);
        requests++;
        if (limits.budget) {
          const id = randomUUID();
          assert(await limits.budget.reserve(id), 'Money reservation refused');
          requestId = id;
          await limits.budget.sent(id);
        }
        requestDeadline(limits);
        const response = await send('https://api.openai.com/v1/responses', {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        }).catch((error: unknown) => {
          failed = true;
          throw error;
        });
        if (!response.ok) {
          await fail(`Provider HTTP ${response.status}`);
          // Never echo upstream authentication diagnostics into actor logs.
          await response.body?.cancel();
          return new Response('Model provider failed; no retry', { status: 502 });
        }
        if (
          !response.body ||
          !response.headers.get('Content-Type')?.includes('text/event-stream')
        ) {
          failed = true;
          throw Error('Missing provider stream');
        }
        return new Response(
          monitorResponse(response.body, fail, async (response) => {
            await settleRequest(limits, requestId, response);
          }),
          {
            headers: {
              'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream',
            },
          },
        );
      } catch {
        await abandonRequest(limits, requestId).catch(() => {});
        rejected++;
        return new Response('Request refused', { status: 403 });
      }
    },
  };
}

function actorEnvironment() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/work/home',
    CODEX_HOME: '/work/home/.codex',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    BUN_JSC_numberOfGCMarkers: '1',
  };
}

async function version(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: actorEnvironment() });
  // 次の子を起動する前に両方のpipeと終了を確定し、未読stderrを残さない。
  const [output, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert(code === 0, 'Tool version unavailable');
  return output.trim();
}

async function prepare() {
  await mkdir('/work/repo', { recursive: true });
  await mkdir('/work/home/.agents/skills', { recursive: true });
  await mkdir('/work/home/.codex', { recursive: true });
  await cp('/input', '/work/repo', { recursive: true });
  for (const skill of ['scoping', 'implement']) {
    await symlink(`/work/repo/skills/${skill}`, `/work/home/.agents/skills/${skill}`);
  }
}

async function boundary() {
  const status = await readFile('/proc/self/status', 'utf8');
  assert(/^CapEff:\s+0+$/m.test(status), 'Capabilities present');
  assert(/^NoNewPrivs:\s+1$/m.test(status), 'Privilege escalation possible');
  assert(
    process.getuid?.() === 1000 && process.getgid?.() === 1000 && process.pid === 1,
    'Unexpected actor user or PID namespace',
  );
  assert(
    !Object.keys(process.env).some((key) => /TOKEN|KEY|AUTH|PROXY/.test(key)),
    'Credentials or proxy environment present',
  );
  assert(!(await Bun.file('/var/run/docker.sock').exists()), 'Docker socket visible');
  for (const path of [
    '/runtime/delegation.json',
    '/work/budget-message.json',
    '/work/budget-ack.json',
  ]) {
    assert(!(await Bun.file(path).exists()), 'Gateway budget state visible');
  }
  const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n');
  for (const target of ['/', '/input', '/runtime']) {
    assert(
      mounts.some((line) => {
        const parts = line.split(' ');
        return parts[4] === target && parts[5]?.split(',').includes('ro');
      }),
      'Readonly boundary missing',
    );
  }
  let denied = false;
  try {
    await writeFile('/outside-eval', 'probe');
  } catch {
    denied = true;
  }
  assert(denied, 'Root filesystem writable');
  denied = false;
  try {
    await writeFile('/input/AGENTS.md', 'probe');
  } catch {
    denied = true;
  }
  assert(denied, 'Input mount writable');
  await writeFile('/work/probe', 'allowed');
  assert((await Bun.file('/work/probe').text()) === 'allowed', 'Workspace unavailable');
  const routes = await readFile('/proc/net/route', 'utf8');
  assert(
    !routes
      .split('\n')
      .slice(1)
      .some((line) => line.split(/\s+/)[1] === '00000000'),
    'Default route present',
  );
  denied = false;
  try {
    await writeFile('/runtime/settings.json', 'probe');
  } catch {
    denied = true;
  }
  assert(denied, 'Runtime mount writable');
}

async function probe() {
  await boundary();
  const response = await gatewayHealth();
  assert(response.ok, 'Model gateway unavailable');
  const blocked = await fetch('http://gateway:8080/github', { signal: AbortSignal.timeout(3000) });
  assert(blocked.status === 403, 'General proxy available');
  spawn('sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' }).unref();
  const childBun = await version(['bun', '--version']);
  assert(childBun === Bun.version, 'Entry and child Bun versions differ');
  console.log(
    JSON.stringify({
      cli: await version(['codex', '--version']),
      bun: childBun,
      entryBun: Bun.version,
      git: await version(['git', '--version']),
      safety: 'probe-passed',
    }),
  );
}

async function gatewayHealth() {
  const deadline = Date.now() + 3000;
  while (true) {
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'Model gateway readiness deadline expired');
    try {
      return await fetch('http://gateway:8080/health', { signal: AbortSignal.timeout(remaining) });
    } catch {
      // これは起動の観測待ちであり、モデル要求や固定操作の再実行ではない。
      await Bun.sleep(Math.min(25, remaining));
    }
  }
}

async function artifacts(
  root: string,
  prefix = '',
  budget = { bytes: 0 },
): Promise<{ path: string; base64: string }[]> {
  const files: { path: string; base64: string }[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await artifacts(root, path, budget)));
    }
    assert(!entry.isSymbolicLink(), 'Artifact symlink not captured');
    if (entry.isFile()) {
      const file = Bun.file(join(root, path));
      budget.bytes += file.size;
      assert(
        file.size <= 1024 * 1024 && budget.bytes <= 8 * 1024 * 1024,
        'Artifact snapshot too large',
      );
      files.push({ path, base64: Buffer.from(await file.arrayBuffer()).toString('base64') });
    }
    assert(files.length <= 2000, 'Too many artifacts');
  }
  return files;
}

async function relay(
  stream: ReadableStream<Uint8Array>,
  target: NodeJS.WriteStream,
  budget: { bytes: number },
) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      budget.bytes += value.byteLength;
      if (budget.bytes > 16 * 1024 * 1024) {
        process.exit(125);
      }
      // 書込み中のbufferを所有し、完了前に次の読取りへ進まない。
      const output = Buffer.from(value);
      await new Promise<void>((resolve, reject) => {
        target.write(output, (error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    reader.releaseLock();
  }
}

async function actor(
  settings: Limits & { prompt: string; responseSchema?: unknown },
  observed: RuntimeVersions,
) {
  assert(process.env.BUN_JSC_numberOfGCMarkers === '1', 'Actor GC concurrency differs');
  await prepare();
  const config = [
    'model_provider="eval"',
    'model_providers.eval.name="Evaluation gateway"',
    'model_providers.eval.base_url="http://gateway:8080/v1"',
    'model_providers.eval.wire_api="responses"',
    'model_providers.eval.requires_openai_auth=false',
    'model_providers.eval.request_max_retries=0',
    'model_providers.eval.stream_max_retries=0',
    'features.multi_agent=false',
    'approval_policy="never"',
    'web_search="disabled"',
    `model_reasoning_effort=${JSON.stringify(settings.reasoning)}`,
  ];
  if (settings.responseSchema) {
    await mkdir('/work/repo/actor-records', { recursive: true });
    await writeFile(
      '/work/home/.codex/response-schema.json',
      JSON.stringify(settings.responseSchema),
    );
  }
  console.log(
    JSON.stringify({
      type: 'eval.runtime',
      ...observed,
    }),
  );
  const child = Bun.spawn(
    [
      'codex',
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--sandbox',
      'danger-full-access',
      '-m',
      settings.model,
      ...config.flatMap((value) => ['-c', value]),
      ...(settings.responseSchema
        ? [
            '--output-schema',
            '/work/home/.codex/response-schema.json',
            '-o',
            '/work/repo/actor-records/final.json',
          ]
        : []),
      '-',
    ],
    {
      cwd: '/work/repo',
      stdin: Buffer.from(settings.prompt),
      stdout: 'pipe',
      stderr: 'pipe',
      env: actorEnvironment(),
    },
  );
  const budget = { bytes: 0 };
  const [code] = await Promise.all([
    child.exited,
    relay(child.stdout, process.stdout, budget),
    relay(child.stderr, process.stderr, budget),
  ]);
  try {
    console.log(JSON.stringify({ type: 'eval.artifacts', files: await artifacts('/work/repo') }));
  } catch {
    console.log(JSON.stringify({ type: 'eval.artifacts_missing' }));
  }
  process.exitCode = code;
}

if (import.meta.main) {
  const settings: unknown = JSON.parse(await Bun.file('/runtime/settings.json').text());
  assert(record(settings), 'Missing settings');
  // PID 1 exits even if the host dies; all descendants in the container die with it.
  assert(
    typeof settings.expiresAt === 'number' && settings.expiresAt > Date.now(),
    'Deadline expired',
  );
  const timer = setTimeout(() => process.exit(124), settings.expiresAt - Date.now());
  try {
    const mode = process.argv[2];
    if (mode === 'probe') {
      await probe();
    } else {
      assert(
        typeof settings.model === 'string' &&
          typeof settings.reasoning === 'string' &&
          typeof settings.maxRequests === 'number' &&
          typeof settings.maxOutputTokens === 'number',
        'Missing model settings',
      );
      const limits: Limits = {
        model: settings.model,
        reasoning: settings.reasoning,
        maxRequests: settings.maxRequests,
        maxOutputTokens: settings.maxOutputTokens,
        expiresAt:
          typeof settings.requestExpiresAt === 'number'
            ? settings.requestExpiresAt
            : settings.expiresAt,
      };
      if (mode === 'gateway') {
        assert(process.env.OPENAI_API_KEY, 'Model authentication missing');
        assert(
          (await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim() === '0',
          'Gateway forwarding enabled',
        );
        limits.budget = await runtimeBudget();
        assert(!settings.budgetRequired || limits.budget, 'Gateway money delegation missing');
        const gateway = providerGateway(limits, process.env.OPENAI_API_KEY);
        Bun.serve({
          port: 8080,
          hostname: await gatewayBindAddress(),
          maxRequestBodySize: 8 * 1024 * 1024,
          fetch: (request) => gateway.handle(request),
        });
        process.on('exit', () => {
          gateway.stop();
          console.log(JSON.stringify(gateway.stats()));
        });
        await new Promise(() => {});
      } else {
        assert(mode === 'actor' && typeof settings.prompt === 'string', 'Unknown container role');
        // --versionを含むCLIの起動も、コンテナー内の境界照合より後に限る。
        await boundary();
        const observed = {
          cli: await version(['codex', '--version']),
          bun: await version(['bun', '--version']),
          entryBun: Bun.version,
          git: await version(['git', '--version']),
        };
        assert(
          observed.cli === settings.cliVersion &&
            observed.bun === settings.bunVersion &&
            observed.git === settings.gitVersion,
          'Actor versions differ from plan',
        );
        await actor(
          { ...limits, prompt: settings.prompt, responseSchema: settings.responseSchema },
          observed,
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
