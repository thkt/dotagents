import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isRecord } from '../../scripts/shared/values.ts';
import type { prepareLightHostCase } from './light-host-driver.fixture.ts';

type Prepared = Awaited<ReturnType<typeof prepareLightHostCase>>;
type CommandResult = {
  code: number | null;
  reason: string | null;
  processesStopped: boolean;
  stdout: string;
  stderr: string;
  cleanupMs: number;
};
type Runtime = {
  lightProfile: (
    workspace: string,
    temporary: string,
    immutable: string[],
    protectedPaths: string[],
    executables: string[],
    auth: string,
  ) => unknown;
  profileArguments: (profile: unknown) => string[];
  nativeCommand: (
    argv: string[],
    cwd: string,
    input: string,
    limit: number,
    env: Record<string, string>,
  ) => Promise<CommandResult>;
  collectLightArtifacts: (workspace: string, output: string) => Promise<unknown>;
};

function runtimeAdapter(imported: unknown): Runtime {
  assert(isRecord(imported));
  const module = imported;
  function call(name: string, args: unknown[]): unknown {
    const fn = module[name];
    assert(typeof fn === 'function', `対象版に必要な補助がない: ${name}`);
    const result: unknown = Reflect.apply(fn, undefined, args);
    return result;
  }
  return {
    lightProfile: (...args) => call('lightProfile', args),
    profileArguments: (...args) => z.array(z.string()).parse(call('profileArguments', args)),
    nativeCommand: async (...args) =>
      z
        .object({
          code: z.number().nullable(),
          reason: z.string().nullable(),
          processesStopped: z.boolean(),
          stdout: z.string(),
          stderr: z.string(),
          cleanupMs: z.number(),
        })
        .passthrough()
        .parse(await call('nativeCommand', args)),
    collectLightArtifacts: async (...args) => await call('collectLightArtifacts', args),
  };
}

// CLI自身のHOMEと認証保存先は合成の通常環境。actorのHOMEはprofileで一時領域へ限定する。
export function lightHostEnvironment(prepared: Prepared) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: prepared.cliHome,
    CODEX_HOME: prepared.auth,
    TMPDIR: prepared.temporary,
  };
}

// 純粋な接続。外部endpoint・実認証・通常設定を受け付ける引数は設けない。
export function lightHostArgv(prepared: Prepared, profileArgs: string[], port: number) {
  assert(Number.isInteger(port) && port > 0 && port < 65536);
  const argv = [
    prepared.config.cliExecutable,
    'exec',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '-C',
    prepared.workspace,
    '-m',
    'gpt-6.1-sol',
    ...profileArgs,
    '-c',
    'model_reasoning_effort="medium"',
    '-c',
    'model_provider="native-local-fixture"',
    '-c',
    `model_providers.native-local-fixture={name="Native model-free fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
    '-c',
    'features.enable_request_compression=false',
  ];
  if (prepared.publicFiles) {
    argv.push(
      '-c',
      `developer_instructions=${JSON.stringify(prepared.publicFiles.developerInstructions)}`,
    );
  }
  if (prepared.responseSchema) {
    argv.push('--output-schema', join(prepared.root, 'schema.json'));
  }
  return [...argv, '-'];
}

function recorder(root: string, initialBytes = 0) {
  let bytes = initialBytes;
  return async (name: string, body: string) => {
    bytes += Buffer.byteLength(body);
    assert(bytes <= 16 * 1024 * 1024, 'ホスト記録16MiB上限。部分記録を保持して停止');
    await writeFile(join(root, name), body, { flag: 'wx', mode: 0o600 });
  };
}

async function snapshots(prepared: Prepared) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(prepared.paths).map(async ([label, path]) => {
        const body = await readFile(path);
        return [
          label,
          { body: body.toString(), sha256: createHash('sha256').update(body).digest('hex') },
        ] as const;
      }),
    ),
  );
}

async function processObservation(prepared: Prepared) {
  const raw = await readFile(join(prepared.workspace, 'native-processes.json'), 'utf8').catch(
    (cause: unknown) => {
      assert(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT');
      return null;
    },
  );
  if (raw === null) {
    return { reached: false, processes: [] };
  }
  const ids = z.array(z.number().int().positive()).length(2).parse(JSON.parse(raw));
  return {
    reached: true,
    raw,
    processes: ids.map((pid) => {
      try {
        process.kill(pid, 0);
        return { pid, observation: '存在' };
      } catch (cause) {
        assert(cause instanceof Error && 'code' in cause);
        return { pid, observation: cause.code === 'ESRCH' ? '終了' : '不明', error: String(cause) };
      }
    }),
  };
}

async function runtimeEvidence(prepared: Prepared, save: ReturnType<typeof recorder>) {
  const sources = [
    join(prepared.config.repoRoot, 'eval/light-native.ts'),
    import.meta.path,
    join(import.meta.dir, 'light-host-driver.fixture.ts'),
    join(import.meta.dir, 'light-native-responses.fixture.ts'),
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      sources.map(
        async (path) =>
          [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ] as const,
      ),
    ),
  );
  const versions = [];
  for (const executable of [
    prepared.config.cliExecutable,
    prepared.config.bunExecutable,
    prepared.config.gitExecutable,
  ]) {
    const result = Bun.spawnSync([executable, '--version'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: lightHostEnvironment(prepared),
    });
    const record = {
      executable,
      code: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      sha256: createHash('sha256')
        .update(await readFile(executable))
        .digest('hex'),
    };
    versions.push(record);
    assert.equal(result.exitCode, 0, JSON.stringify(record));
  }
  const revision = Bun.spawnSync(
    [prepared.config.gitExecutable, '-C', prepared.config.repoRoot, 'rev-parse', 'HEAD'],
    { timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: prepared.cliHome } },
  );
  assert.equal(revision.exitCode, 0);
  await save(
    'versions.json',
    JSON.stringify(
      {
        hashes,
        versions,
        runnerCommit: new TextDecoder().decode(revision.stdout).trim(),
        driverRuntime: { path: process.execPath, version: Bun.version },
      },
      null,
      2,
    ),
  );
}

function interruptObserver(prepared: Prepared) {
  let ready = false;
  const signal = prepared.config.caseId === 'interrupt-SIGINT' ? 'SIGINT' : 'SIGTERM';
  const timer = setInterval(() => {
    if (ready) {
      return;
    }
    void readFile(join(prepared.workspace, 'native-processes.json'), 'utf8')
      .then((raw) => {
        const ids: unknown = JSON.parse(raw);
        assert(
          Array.isArray(ids) &&
            ids.length === 2 &&
            ids.every((id) => Number.isInteger(id) && id > 0),
        );
        if (!ready) {
          ready = true;
          process.kill(process.pid, signal);
        }
      })
      .catch(() => {
        /* fixtureの到達前・部分書込みは待つ。期限はnativeCommandが守る。 */
      });
  }, 30);
  return { stop: () => clearInterval(timer), reached: () => ready };
}

// 固定SSEの受信・保存を注入可能にし、通常テストからlistenerを起動しない。
export function lightHostResponder(prepared: Prepared, save: ReturnType<typeof recorder>) {
  let index = 0;
  let failed = false;
  const arrivals: unknown[] = [];
  const fetch = async (request: Request) => {
    try {
      assert(
        request.method === 'POST' && new URL(request.url).pathname === '/v1/responses',
        '固定Responses以外の要求',
      );
      assert(!failed, '前の要求失敗後は再開しない');
      const current = index++;
      // 巨大本文は保存上限より前に拒否する。レスポンスは既存fixtureのbyteを維持する。
      const raw = await request.text();
      assert(Buffer.byteLength(raw) <= 16 * 1024 * 1024, '要求本文16MiB超過');
      await save(`request-${current}.json`, raw);
      const step = prepared.steps[current];
      const matched = Boolean(step && step.requestIncludes.every((value) => raw.includes(value)));
      arrivals.push({
        index: current,
        matched,
        sha256: createHash('sha256').update(raw).digest('hex'),
        required: step?.requestIncludes,
      });
      assert(step && matched, '固定要求と不一致。外部推論へ転送しない');
      await save(`response-${current}.sse`, step.sse);
      return new Response(step.sse, { headers: { 'content-type': 'text/event-stream' } });
    } catch (cause) {
      failed = true;
      arrivals.push({ error: String(cause) });
      return new Response('Fixed request unavailable', { status: 400 });
    }
  };
  return { fetch, observations: () => ({ arrivals, failed, requests: index }) };
}

export async function executeLightHostCase(prepared: Prepared) {
  const initialSizes = await Promise.all(
    ['prepared.json', 'light-host-cases.json'].map(
      async (name) => (await readFile(join(prepared.root, name))).length,
    ),
  );
  const save = recorder(
    prepared.root,
    initialSizes.reduce((total, size) => total + size, 0),
  );
  // 対象checkoutの補助を再利用する。authorTestsのbaseには未実装なのでrun時だけ解決する。
  const imported: unknown = await import(join(prepared.config.repoRoot, 'eval/light-native.ts'));
  const runtime = runtimeAdapter(imported);
  await runtimeEvidence(prepared, save);
  const profile = runtime.lightProfile(
    prepared.workspace,
    prepared.temporary,
    prepared.immutable,
    prepared.protectedPaths,
    [prepared.config.bunExecutable, prepared.config.gitExecutable],
    prepared.auth,
  );
  if (prepared.responseSchema) {
    await save('schema.json', JSON.stringify(prepared.responseSchema));
  }
  const responder = lightHostResponder(prepared, save);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 16 * 1024 * 1024,
    fetch: responder.fetch,
  });
  let observer: ReturnType<typeof interruptObserver> | undefined;
  try {
    assert(server.port);
    const argv = lightHostArgv(prepared, runtime.profileArguments(profile), server.port);
    await save(
      'connection.json',
      JSON.stringify(
        { argv, profile, environment: lightHostEnvironment(prepared), fixture: prepared.fixture },
        null,
        2,
      ),
    );
    if (prepared.config.caseId.startsWith('interrupt-')) {
      observer = interruptObserver(prepared);
    }
    const result = await runtime.nativeCommand(
      argv,
      prepared.workspace,
      prepared.prompt,
      prepared.config.caseId === 'timeout' ? 4000 : 20000,
      lightHostEnvironment(prepared),
    );
    observer?.stop();
    await save(
      'result.json',
      JSON.stringify(
        { result, ...responder.observations(), interruptReached: observer?.reached() ?? null },
        null,
        2,
      ),
    );
    assert(
      result.processesStopped && result.cleanupMs <= 30000,
      '停止不明または後始末超過。成功にしない',
    );
    await save('after.json', JSON.stringify(await snapshots(prepared), null, 2));
    await save(
      'process-observation.json',
      JSON.stringify(await processObservation(prepared), null, 2),
    );
    await mkdir(join(prepared.root, 'artifacts'), { mode: 0o700 });
    const artifacts = await runtime.collectLightArtifacts(
      prepared.workspace,
      join(prepared.root, 'artifacts'),
    );
    await save('artifacts.json', JSON.stringify(artifacts, null, 2));
    // 完了・拒否・未到達の裁定はraw操作記録とhost-casesを照合するホストに残す。
    assert(!responder.observations().failed, '要求不一致または保存失敗。記録を残して停止');
    assert(
      result.code === 0 && result.reason === null,
      'CLI失敗・期限・割込み。記録を確認して停止',
    );
  } catch (cause) {
    await save(
      'error.json',
      JSON.stringify({ error: String(cause), ...responder.observations() }, null, 2),
    );
    throw cause;
  } finally {
    observer?.stop();
    await server.stop(true);
  }
}
