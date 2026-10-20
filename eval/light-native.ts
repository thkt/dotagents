import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertRunning, command } from '../scripts/shared/process.ts';
import { lightEnvironment, type LightConfig } from './light-data.ts';
import { LightProcesses } from './light-processes.ts';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function saveLightLog(path: string, body: string) {
  assert(Buffer.byteLength(body) <= (await logAllowance(dirname(path), 0)), '試行ログ容量上限');
  await writeFile(path, body, { flag: 'wx', mode: 0o600 });
}
export async function saveLight(path: string, value: unknown, trialLog = false) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (trialLog) {
    await saveLightLog(path, body);
  } else {
    await writeFile(path, body, { flag: 'wx', mode: 0o600 });
  }
}
export async function newLightDirectory(repo: string, path: string) {
  assert(isAbsolute(path), '保存先は絶対パスが必要です');
  const parent = await realpath(dirname(path));
  const destination = resolve(parent, path.split('/').at(-1) ?? '');
  assert(
    relative(await realpath(repo), destination).startsWith('../'),
    '証拠はcheckout外へ保存します',
  );
  await mkdir(destination, { mode: 0o700 });
  return destination;
}

export async function lightVersions(config: LightConfig, cwd: string) {
  const env = lightEnvironment(process.env);
  const cli = await command(
    [config.cliExecutable ?? 'codex', '--version'],
    cwd,
    '',
    10000,
    undefined,
    env,
  );
  const bun = await command(['bun', '--version'], cwd, '', 10000, undefined, env);
  const git = await command(['git', '--version'], cwd, '', 10000, undefined, env);
  assert(
    [cli, bun, git].every((result) => result.code === 0 && !result.timedOut) &&
      cli.stdout.trim() === config.cliVersion &&
      bun.stdout.trim() === config.bunVersion &&
      git.stdout.trim() === config.gitVersion,
    '実効CLI・子Bun・Gitの版が計画と一致しません',
  );
  const entries: Record<string, { path: string; sha256: string }> = {};
  for (const [key, name] of [
    ['cli', config.cliExecutable ?? 'codex'],
    ['bun', 'bun'],
    ['git', 'git'],
  ]) {
    assert(key && name);
    const entry = Bun.which(name);
    assert(entry, '起動入口がありません');
    const path = await realpath(entry);
    entries[key] = { path, sha256: sha256(await readFile(path)) };
  }
  return {
    entries,
    cli: cli.stdout.trim(),
    bun: bun.stdout.trim(),
    git: git.stdout.trim(),
    platform: process.platform,
    arch: process.arch,
  };
}

// 実ファイルのパスはホストが生成する。任意の読取り許可を設定入力から受け取らない。
export function lightProfile(
  workspace: string,
  temporary: string,
  immutable: string[],
  denied: string[],
  executables: string[],
  authenticationHome = temporary,
) {
  const filesystem: Record<string, string> = {
    ':root': 'deny',
    ':minimal': 'read',
    // 採用CLIはminimalから両scratch領域を暗黙に開く。子の専用領域だけを再度許可する。
    '/private/tmp': 'deny',
    '/private/var/tmp': 'deny',
    [workspace]: 'write',
    [temporary]: 'write',
  };
  for (const path of executables) {
    filesystem[path] = 'read';
  }
  for (const path of immutable) {
    filesystem[path] = 'read';
  }
  for (const path of denied) {
    filesystem[path] = 'deny';
  }
  return {
    default_permissions: 'eval-light',
    approval_policy: 'never',
    permissions: { 'eval-light': { filesystem, network: { enabled: false } } },
    web_search: 'disabled',
    mcp_servers: {},
    hooks: {},
    forced_login_method: 'chatgpt',
    history: { persistence: 'none' },
    agents: { enabled: false },
    skills: {
      config: [...new Set([temporary, authenticationHome])].flatMap((home) =>
        ['imagegen', 'openai-docs', 'skill-creator', 'skill-installer'].map((skill) => ({
          path: join(home, 'skills/.system', skill, 'SKILL.md'),
          enabled: false,
        })),
      ),
    },
    features: {
      multi_agent: false,
      apps: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      in_app_browser: false,
      computer_use: false,
      view_image: false,
      image_generation: false,
      plugins: false,
      hooks: false,
      network_proxy: { enabled: false },
      remote_plugin: false,
      memories: false,
      goals: false,
      shell_snapshot: false,
      skill_mcp_dependency_install: false,
      workspace_dependencies: false,
    },
    shell_environment_policy: {
      inherit: 'none',
      set: { PATH: '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary },
      ignore_default_excludes: false,
    },
    project_doc_max_bytes: 0,
  };
}
export function profileArguments(profile: ReturnType<typeof lightProfile>) {
  // CLIのkey=value解析は引用したdotted keyをTOMLとして解釈しない。
  // パス中のドットも保てるよう、各設定をTOML inline tableで渡す。
  const inline = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map(inline).join(',')}]`;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return `{${Object.entries(value)
        .map(([key, next]) => `${JSON.stringify(key)}=${inline(next)}`)
        .join(',')}}`;
    }
    const result = JSON.stringify(value);
    assert(result !== undefined, 'TOMLへ変換できない設定値です');
    return result;
  };
  return Object.entries(profile).flatMap(([key, value]) => ['-c', `${key}=${inline(value)}`]);
}

// runから自己認定せず、同じrunnerと採用CLIを確認したホストの外部証拠を必須にする。
export const boundaryProof = z.strictObject({
  status: z.literal('passed'),
  runnerHashes: z.record(z.string(), z.string()),
  versions: z.object({
    cli: z.string(),
    bun: z.string(),
    git: z.string(),
    platform: z.literal('darwin'),
    arch: z.string(),
    entries: z.record(
      z.string(),
      z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    ),
  }),
  profilePolicyHash: z.string(),
  fixtureHashes: z.record(z.string(), z.string()),
  readToolInventory: z.strictObject({
    exposed: z.tuple([]),
    log: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  observations: z.array(
    z.strictObject({
      method: z.enum(['command', 'read-tool', 'lifecycle']),
      target: z.string(),
      operation: z.enum(['read', 'write', 'network', 'execution']),
      result: z.enum(['allowed', 'denied', 'stopped']),
      log: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
export async function requireLightBoundary(
  config: LightConfig,
  runnerHashes: Record<string, string>,
  versions: Awaited<ReturnType<typeof lightVersions>>,
) {
  assert(config.boundaryEvidence, 'モデルなしホスト検証の証拠がありません。軽量実行は未対応です');
  const evidence = await readFile(config.boundaryEvidence);
  const proof = boundaryProof.parse(JSON.parse(evidence.toString('utf8')));
  assert.deepEqual(proof.runnerHashes, runnerHashes, 'ホスト検証のrunnerが異なります');
  assert.deepEqual(proof.versions, versions, 'ホスト検証の実効版・入口が異なります');
  assert(
    proof.profilePolicyHash === sha256(lightProfile.toString()),
    'profile生成方針が異なります',
  );
  for (const path of [
    'eval/tests/light-boundary.fixture.ts',
    'eval/tests/fixtures/light-host-cases.json',
    'eval/tests/light-cli.fixture.ts',
  ]) {
    assert(
      proof.fixtureHashes[path] === sha256(await readFile(resolve(import.meta.dir, '..', path))),
      '固定資産の版が異なります',
    );
  }
  const required = [
    ['command', 'public-input', 'read', 'allowed'],
    ['command', 'trial-workspace', 'write', 'allowed'],
    ['command', 'trial-temporary', 'write', 'allowed'],
    ...[
      'dummy-auth',
      'other-trial',
      'host-judgments',
      'synthetic-private',
      'unlisted-scratch-tmp',
      'unlisted-scratch-var-tmp',
    ].flatMap((target) => [
      ['command', target, 'read', 'denied'],
      ['command', target, 'write', 'denied'],
    ]),
    ['command', 'network', 'network', 'denied'],
    ...['timeout', 'SIGINT', 'SIGTERM', 'normal-child-exit'].map((target) => [
      'lifecycle',
      target,
      'execution',
      'stopped',
    ]),
  ];
  for (const [method, target, operation, result] of required) {
    assert(
      proof.observations.some(
        (item) =>
          item.method === method &&
          item.target === target &&
          item.operation === operation &&
          item.result === result,
      ),
      `モデルなし観測が不足: ${method}/${target}/${operation}`,
    );
  }
  for (const observation of proof.observations) {
    assert(
      isAbsolute(observation.log) && sha256(await readFile(observation.log)) === observation.sha256,
      'ホスト生ログの照合失敗',
    );
  }
  assert(
    isAbsolute(proof.readToolInventory.log) &&
      sha256(await readFile(proof.readToolInventory.log)) === proof.readToolInventory.sha256,
    '独立した読取りツールの無効化を確認した実効一覧の証拠がありません',
  );
  return {
    evidenceHash: sha256(evidence),
    profilePolicyHash: proof.profilePolicyHash,
  };
}

function groupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function pipesEnded(stdout: { readableEnded: boolean }, stderr: { readableEnded: boolean }) {
  return stdout.readableEnded && stderr.readableEnded;
}

function groupStopped(pid: number | undefined) {
  return pid === undefined || !groupExists(pid);
}

// 共有commandは出力を無制限に蓄積し、groupの消滅を観測しない。軽量経路では容量制限付き所有者を使う。
type NativeResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  reason: string | null;
  processesStopped: boolean;
  processes: ReturnType<LightProcesses['result']>;
  ms: number;
  cleanupMs: number;
};
export async function nativeCommand(
  argv: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  maxBytes = 16 * 1024 * 1024,
): Promise<NativeResult> {
  assertRunning();
  const [executable, ...args] = argv;
  assert(executable && maxBytes > 0, '起動前のログ容量上限');
  const start = performance.now();
  const child = spawn(executable, args, {
    cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const owned = new LightProcesses(child.pid);
  let stdout = '',
    stderr = '',
    bytes = 0,
    reason: string | null = null;
  let exited = false;
  let stoppedAt: number | undefined;
  let processResult: ReturnType<LightProcesses['result']> | undefined;
  const processSnapshot = () => (processResult ??= owned.result());
  const kill = () => {
    processResult = undefined;
    owned.kill();
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) {
          reason ??= 'process-stop-unknown';
        }
      }
    }
  };
  const pending = () => !groupStopped(child.pid) || !processSnapshot().stopped;
  const stop = (why: string) => {
    reason ??= why;
    stoppedAt ??= performance.now();
    kill();
  };
  const interrupt = (signal: string) => stop(signal);
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const collect = (data: string, stream: 'stdout' | 'stderr') => {
    bytes += Buffer.byteLength(data);
    if (bytes > maxBytes) {
      stop('log-capacity');
      return;
    }
    if (stream === 'stdout') {
      stdout += data;
    } else {
      stderr += data;
    }
  };
  child.stdout.setEncoding('utf8').on('data', (data: string) => collect(data, 'stdout'));
  child.stderr.setEncoding('utf8').on('data', (data: string) => collect(data, 'stderr'));
  const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
  let code: number | null = null;
  let startupError: string | null = null;
  child.once('exit', (value) => {
    code = value;
    exited = true;
    stoppedAt ??= performance.now();
    kill();
  });
  child.once('error', (cause) => {
    startupError = cause.message;
    exited = true;
    stoppedAt ??= performance.now();
  });
  try {
    while (!exited && performance.now() < (stoppedAt ?? start + timeoutMs) + 30000) {
      if (!owned.sample()) {
        stop('process-observation-unknown');
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    kill();
    stoppedAt ??= performance.now();
    while (pending() && performance.now() - stoppedAt < 30000) {
      kill();
      await new Promise((done) => setTimeout(done, 20));
    }
    while (
      child.pid &&
      !pipesEnded(child.stdout, child.stderr) &&
      performance.now() - stoppedAt < 30000
    ) {
      processResult = undefined;
      await new Promise((done) => setTimeout(done, 20));
    }
    if (child.pid && !pipesEnded(child.stdout, child.stderr)) {
      reason ??= 'output-end-unknown';
    }
    // 待機・停止操作を挟まない終了境界では、判定した観測を返却にも使う。
    const processes = processSnapshot();
    const processesStopped = exited && processes.stopped && groupStopped(child.pid);
    return {
      code,
      stdout,
      stderr,
      reason: reason ?? startupError,
      processesStopped,
      processes,
      ms: performance.now() - start,
      cleanupMs: performance.now() - stoppedAt,
    };
  } finally {
    clearTimeout(timer);
    kill();
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}

export async function logAllowance(directory: string, reserve = 4096) {
  let bytes = reserve; // 起動時の余裕。実際の保存量はsaveLightLogで別途検査する。
  for (const name of await readdir(directory)) {
    const stat = await lstat(join(directory, name));
    if (stat.isFile()) {
      bytes += stat.size;
    }
  }
  assert(bytes <= 16 * 1024 * 1024, '試行ログ容量上限');
  return 16 * 1024 * 1024 - bytes;
}

export async function collectLightArtifacts(
  workspace: string,
  destination: string,
  expiresAt = Infinity,
) {
  let count = 0,
    total = 0;
  const hashes: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const name of await readdir(directory)) {
      assert(performance.now() <= expiresAt, '成果物回収の時間枠超過');
      assert(++count <= 2000, '成果物ファイル数上限');
      const path = join(directory, name);
      const stat = await lstat(path);
      assert(!stat.isSymbolicLink(), 'symlink成果物は収集しません');
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      assert(
        stat.isFile() &&
          count <= 2000 &&
          stat.size <= 1024 * 1024 &&
          (total += stat.size) <= 8 * 1024 * 1024,
        '成果物容量上限',
      );
      const body = await readFile(path);
      const target = join(destination, relative(workspace, path));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, body, { flag: 'wx', mode: 0o600 });
      assert(performance.now() <= expiresAt, '成果物回収の時間枠超過');
      hashes[relative(workspace, path)] = sha256(body);
    }
  };
  await visit(workspace);
  assert(performance.now() <= expiresAt, '成果物回収の時間枠超過');
  return hashes;
}
