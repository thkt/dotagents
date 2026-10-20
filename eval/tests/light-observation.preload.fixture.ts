import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isRecord } from '../../scripts/shared/values.ts';
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join, basename } from 'node:path';
import * as data from '../data.ts';
import * as processTools from '../../scripts/shared/process.ts';

// 子プロセス専用。新実装のhelperを仮定せず、公開CLIのrunへ合成入力を接続する。
// profileの成立・実認証・実プロセス停止を認定するfixtureではない。
export const lightObservationPreload = import.meta.path;
if (process.env.LIGHT_OBSERVATION_SETTINGS) {
  const nativeExports: unknown = await import('../light-native.ts');
  assert(isRecord(nativeExports));
  const digest = (body: string) => createHash('sha256').update(body).digest('hex');
  const realFs = { ...fs };
  const settingsPath = process.env.LIGHT_OBSERVATION_SETTINGS;
  assert(settingsPath);
  const settings: unknown = JSON.parse(await realFs.readFile(settingsPath, 'utf8'));
  assert(isRecord(settings));
  const { root, scenario } = settings;
  assert(typeof root === 'string' && typeof scenario === 'string');
  let now = 1000;
  Object.defineProperty(performance, 'now', { value: () => now });
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const cap = 16 * 1024 * 1024;
  const events = join(root, 'observations.jsonl');
  const note = async (value: unknown) => fs.appendFile(events, `${JSON.stringify(value)}\n`);
  const versions = {
    cli: 'synthetic-cli',
    bun: '1.4.3',
    git: 'synthetic-git',
    entries: {},
    platform: 'darwin',
    arch: 'synthetic',
  };
  const files = {
    'AGENTS.md': '合成の通常入力。',
    'eval/fixtures/workspace/README.md': '合成の課題。',
  };
  const hashes = Object.fromEntries(
    Object.entries(files).map(([path, body]) => [path, digest(body)]),
  );
  const corpus = ['storage-fields', 'completion-message'].map((id) => ({
    id,
    source: 'https://example.invalid/public',
    prompt: '合成の固定操作。',
    expected: id === 'storage-fields' ? 'scoping' : 'implement',
    criteria: ['合成入力。'],
  }));
  await mock.module('../inputs.ts', () => ({
    blob: async () => JSON.stringify(corpus),
    prepareInputs: async (_repo: string, _config: unknown, selected: unknown) => ({
      selected,
      runner: { commit: 'synthetic-runner', uncommitted: false, sourceHashes: {} },
      variants: ['before', 'after'].map((side) => ({
        side,
        files,
        versions: hashes,
        actorInputs: [],
      })),
    }),
  }));
  await mock.module('../data.ts', () => ({ ...data, validateInputFiles: () => {} }));
  async function authenticate(environment: unknown, authScenario: string) {
    await note({ event: 'auth', environment });
    const statuses: Record<string, [string, number]> = {
      'auth-api': ['Logged in using an API key', 0],
      'auth-unknown': ['Unknown authentication', 0],
      'auth-absent': ['Not logged in', 1],
      'auth-failed': ['Logged in using ChatGPT', 1],
    };
    const [stdout, code] = statuses[authScenario] ?? ['Logged in using ChatGPT', 0];
    return { code, stdout, stderr: '', timedOut: false, ms: 0 };
  }
  await mock.module('../../scripts/shared/process.ts', () => ({
    ...processTools,
    command: async (
      argv: string[],
      _cwd: string,
      _input: string,
      _limit: number,
      _unused: unknown,
      environment: unknown,
    ) => {
      let stdout = '';
      if (argv.includes('ls-tree')) {
        stdout = 'eval/fixtures/workspace/README.md\n';
      } else if (argv.includes('status')) {
        return authenticate(environment, scenario);
      } else if (argv.includes('-e')) {
        stdout = process.execPath;
      } else {
        throw new Error(`合成経路外のコマンド: ${argv[0]}`);
      }
      return { code: 0, stdout, stderr: '', timedOut: false, ms: 0 };
    },
  }));
  let executions = 0;
  await mock.module('../light-native.ts', () => ({
    ...nativeExports,
    lightVersions: async () => versions,
    requireLightBoundary: async () => ({
      evidenceHash: 'synthetic',
      profilePolicyHash: 'synthetic',
    }),
    nativeCommand: async (
      argv: string[],
      cwd: string,
      _input: string,
      _timeout: number,
      environment: unknown,
      allowance: number,
    ) => {
      if (argv.includes('sandbox')) {
        return result('');
      }
      assert(argv.includes('exec'), '模擬対象はsandboxとexecだけ');
      executions++;
      await note({ event: 'exec', executions, allowance, argv, environment });
      if (scenario === 'registered-change' && executions === 1) {
        await realFs.writeFile(join(root, 'home/AGENTS.md'), 'SYNTHETIC_CHANGED_COMMON_CONTEXT');
      }
      // cwdはexecutionDirectory/workspace。証拠保存先は固定trial名から特定する。
      const trial = [
        'before-storage-fields',
        'after-storage-fields',
        'after-completion-message',
        'before-completion-message',
      ][executions - 1];
      assert(trial);
      const logs = join(root, 'run', trial);
      if (['aggregate', 'terminal', 'capacity-normal'].includes(scenario)) {
        return boundedOutput(cwd, logs, allowance);
      }
      const cleanupMs = scenario === 'cleanup' ? 200 : 0;
      now += 10 + cleanupMs;
      return {
        ...result(
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 },
          }) + '\n',
        ),
        ms: 10 + cleanupMs,
        cleanupMs,
      };
    },
  }));
  async function boundedOutput(cwd: string, logs: string, allowance: number) {
    for (let i = 0; i < 1000; i++) {
      await realFs.writeFile(join(cwd, `artifact-${i}.txt`), 'x');
    }
    const artifactHashes = { ...hashes };
    for (let i = 0; i < 1000; i++) {
      artifactHashes[`artifact-${i}.txt`] = digest('x');
    }
    const manifestBytes = Buffer.byteLength(`${JSON.stringify(artifactHashes, null, 2)}\n`);
    const current = await bytes(logs);
    const length =
      scenario === 'aggregate'
        ? allowance - 1
        : cap - current - manifestBytes - (scenario === 'capacity-normal' ? 16384 : 100);
    assert(length > 0 && length <= allowance, 'actor出力は起動時の容量枠内');
    const suffix =
      '\n' +
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 },
      }) +
      '\n';
    const prefix = '{"type":"synthetic.padding","text":"';
    const end = '"}';
    const stdout =
      prefix + 'x'.repeat(length - Buffer.byteLength(prefix + end + suffix)) + end + suffix;
    await note({
      event: 'bounded-output',
      bytes: Buffer.byteLength(stdout),
      allowance,
      manifestBytes,
      current,
    });
    return result(stdout);
  }
  function result(stdout: string) {
    return {
      code: 0,
      stdout,
      stderr: '',
      reason: null,
      processesStopped: true,
      processes: { stopped: true },
      ms: 10,
      cleanupMs: 0,
    };
  }
  async function bytes(directory: string) {
    let total = 0;
    for (const name of await realFs.readdir(directory)) {
      const info = await realFs.lstat(join(directory, name));
      if (info.isFile()) {
        total += info.size;
      }
    }
    return total;
  }
  let delayed = false;
  await mock.module('node:fs/promises', () => ({
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const body = await realFs.readFile(...args);
      // 実際の成果物読取りに到達した時だけ、回収末尾の論理時間を進める。
      if (
        !delayed &&
        scenario === 'collection' &&
        typeof args[0] === 'string' &&
        args[0].includes('/workspace/')
      ) {
        delayed = true;
        now += 101;
        await note({ event: 'collection-completed', now });
      }
      return body;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await realFs.writeFile(...args);
      const path = args[0];
      assert(typeof path === 'string');
      if (!delayed && scenario === 'save' && basename(path) === 'artifacts.json') {
        delayed = true;
        now += 101;
        await note({ event: 'save-completed', now });
      }
      if (basename(path) === 'trial.json') {
        await note({ event: 'trial-saved', now, bytes: await bytes(join(path, '..')) });
      }
    },
  }));
}
