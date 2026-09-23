// Runs only in the disposable container. No host credentials are passed to the actor.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

interface Limits {
  model: string;
  reasoning: string;
  maxRequests: number;
  maxOutputTokens: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remoteInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(remoteInput);
  }
  if (!record(value)) {
    return false;
  }
  if (
    [
      'file_id',
      'image_url',
      'audio_url',
      'file_url',
      'video_url',
      'container',
      'server_url',
      'tools',
    ].some((key) => key in value)
  ) {
    return true;
  }
  return Object.values(value).some(remoteInput);
}

function inlineInput(value: unknown): boolean {
  if (typeof value === 'string') {
    return true;
  }
  // Text conversation and local function/custom tool history from Codex 0.156.1.
  // Reject unknown item kinds: references and input controls are not conversation.
  const types = [
    'message',
    'reasoning',
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
  ];
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => record(item) && types.includes(String(item.type)))
  );
}

export function providerBody(value: unknown, limits: Limits) {
  assert(record(value) && value.model === limits.model, 'Model mismatch');
  assert(
    record(value.reasoning) && value.reasoning.effort === limits.reasoning,
    'Settings mismatch',
  );
  assert(
    !value.background && !value.conversation && !value.previous_response_id,
    'Independent requests required',
  );
  assert(!value.prompt && !remoteInput(value.input), 'Remote stored inputs forbidden');
  assert(inlineInput(value.input), 'Unsupported input item or control');
  const tools = value.tools ?? [];
  assert(
    Array.isArray(tools) &&
      tools.every(
        (tool: unknown) => record(tool) && ['function', 'custom'].includes(String(tool.type)),
      ),
    'Remote tools forbidden',
  );
  return { ...value, store: false, max_output_tokens: limits.maxOutputTokens };
}

function monitorResponse(body: ReadableStream<Uint8Array>, fail: () => void) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let pending = '',
        completed = false;
      const decoder = new TextDecoder();
      const observe = (line: string) => {
        if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') {
          return;
        }
        const event: unknown = JSON.parse(line.slice(5));
        if (record(event) && event.type === 'response.completed') {
          completed = true;
        }
        if (
          record(event) &&
          ['error', 'response.failed', 'response.incomplete'].includes(String(event.type))
        ) {
          fail();
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
          controller.enqueue(value);
        }
        if (pending.trim()) {
          observe(pending);
        }
        if (!completed) {
          fail();
        }
        controller.close();
      } catch (error) {
        fail();
        controller.error(error);
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      fail();
      return reader.cancel();
    },
  });
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
      try {
        assert(
          request.method === 'POST' &&
            new URL(request.url).pathname === '/v1/responses' &&
            !new URL(request.url).search,
          'Endpoint forbidden',
        );
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
          failed = true;
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
          monitorResponse(response.body, () => {
            failed = true;
          }),
          {
            headers: {
              'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream',
            },
          },
        );
      } catch {
        rejected++;
        return new Response('Request refused', { status: 403 });
      }
    },
  };
}

async function version(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const result = (await new Response(child.stdout).text()).trim();
  assert((await child.exited) === 0, 'Tool version unavailable');
  return result;
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

async function probe() {
  const status = await readFile('/proc/self/status', 'utf8');
  assert(/^CapEff:\s+0+$/m.test(status), 'Capabilities present');
  assert(/^NoNewPrivs:\s+1$/m.test(status), 'Privilege escalation possible');
  assert(
    process.getuid?.() === 1000 && process.pid === 1,
    'Unexpected actor user or PID namespace',
  );
  assert(
    !Object.keys(process.env).some((key) => /TOKEN|KEY|AUTH|PROXY/.test(key)),
    'Credentials or proxy environment present',
  );
  assert(!(await Bun.file('/var/run/docker.sock').exists()), 'Docker socket visible');
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
  const response = await fetch('http://gateway:8080/health', { signal: AbortSignal.timeout(3000) });
  assert(response.ok, 'Model gateway unavailable');
  const blocked = await fetch('http://gateway:8080/github', { signal: AbortSignal.timeout(3000) });
  assert(blocked.status === 403, 'General proxy available');
  spawn('sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' }).unref();
  console.log(
    JSON.stringify({
      cli: await version(['codex', '--version']),
      bun: Bun.version,
      git: await version(['git', '--version']),
      safety: 'probe-passed',
    }),
  );
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
  for await (const chunk of stream) {
    budget.bytes += chunk.byteLength;
    if (budget.bytes > 16 * 1024 * 1024) {
      process.exit(125);
    }
    target.write(chunk);
  }
}

async function actor(settings: Limits & { prompt: string }) {
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
    'web_search="disabled"',
    `model_reasoning_effort=${JSON.stringify(settings.reasoning)}`,
  ];
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
      'workspace-write',
      '-m',
      settings.model,
      ...config.flatMap((value) => ['-c', value]),
      '-',
    ],
    {
      cwd: '/work/repo',
      stdin: Buffer.from(settings.prompt),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/work/home',
        CODEX_HOME: '/work/home/.codex',
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
      },
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
      const limits = {
        model: settings.model,
        reasoning: settings.reasoning,
        maxRequests: settings.maxRequests,
        maxOutputTokens: settings.maxOutputTokens,
      };
      if (mode === 'gateway') {
        assert(process.env.OPENAI_API_KEY, 'Model authentication missing');
        const gateway = providerGateway(limits, process.env.OPENAI_API_KEY);
        Bun.serve({
          port: 8080,
          hostname: String(settings.gatewayAddress),
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
        await actor({ ...limits, prompt: settings.prompt });
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
