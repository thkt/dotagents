import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isRecord } from '../scripts/shared/values.ts';
import { lightEnvironment } from './light-data.ts';
import {
  lightProfile,
  nativeCommand,
  profileArguments,
  saveLight,
  sha256,
} from './light-native.ts';

function observation(
  result: Awaited<ReturnType<typeof nativeCommand>>,
  method: string,
  expected: string,
) {
  if (!result.processesStopped || result.reason) {
    return 'unconfirmed';
  }
  let event: unknown;
  try {
    event = JSON.parse(result.stdout);
  } catch {
    return 'unconfirmed';
  }
  if (!isRecord(event)) {
    return 'unconfirmed';
  }
  if (expected === 'allowed') {
    return result.code === 0 && event.status === 'completed' ? 'allowed' : 'unconfirmed';
  }
  if (event.status === 'failed' && ['EPERM', 'EACCES'].includes(String(event.code))) {
    return 'denied';
  }
  if (
    method === 'shell-read' &&
    isRecord(event.observation) &&
    event.observation.code !== 0 &&
    /Operation not permitted|Permission denied/.test(String(event.observation.stderr))
  ) {
    return 'denied';
  }
  return 'unconfirmed';
}

type OperationResult = Awaited<ReturnType<typeof nativeCommand>>;
function networkEvent(result: OperationResult) {
  if (
    !result.processesStopped ||
    result.reason ||
    !result.processes.stopped ||
    result.processes.observationFailed ||
    result.processes.records.some((entry) => !entry.stopped)
  ) {
    return null;
  }
  try {
    const event: unknown = JSON.parse(result.stdout);
    return isRecord(event) && event.kind === 'network' ? event : null;
  } catch {
    return null;
  }
}

// 同じ実行ファイル・固定操作・宛先・環境の、profile外→内→外を比較する。
// errno単独や、異なる通信プログラムの成功からは拒否を認定しない。
export function networkBoundaryObservation(
  inside: OperationResult,
  before: OperationResult,
  after: OperationResult,
  denial?: { program: string; port: number },
) {
  const normal = (result: OperationResult) => {
    const event = networkEvent(result);
    return (
      result.code === 0 &&
      event?.status === 'completed' &&
      isRecord(event.observation) &&
      event.observation.connected === true
    );
  };
  const event = networkEvent(inside);
  const correlatedDenial =
    denial &&
    inside.stderr.includes('=== Sandbox denials ===') &&
    inside.stderr
      .split('\n')
      .some(
        (line) => line.trim() === `(${denial.program}) network-outbound remote:*:${denial.port}`,
      );
  const denied =
    ['EPERM', 'EACCES'].includes(String(event?.code)) ||
    (event?.code === 'ECONNREFUSED' && correlatedDenial);
  return normal(before) &&
    normal(after) &&
    inside.code === 1 &&
    event?.status === 'failed' &&
    denied
    ? 'denied'
    : 'unconfirmed';
}

async function diagnoseOperation(
  root: string,
  workspace: string,
  temporary: string,
  home: string,
  profile: ReturnType<typeof lightProfile>,
  executable: string,
  fixture: string,
  method: string,
  path: string,
  target: string,
  expected: string,
  cliExecutable: string,
) {
  const before = method === 'network' ? null : sha256(await readFile(path));
  const env = {
    ...lightEnvironment(process.env),
    HOME: temporary,
    CODEX_HOME: home,
    TMPDIR: temporary,
  };
  const normal = () =>
    nativeCommand([executable, fixture, method, path], workspace, '', 10000, env);
  const networkBefore = method === 'network' ? await normal() : null;
  const result = await nativeCommand(
    [
      cliExecutable,
      'sandbox',
      ...(method === 'network' ? ['--log-denials'] : []),
      '-C',
      workspace,
      '-P',
      'eval-light',
      ...profileArguments(profile),
      executable,
      fixture,
      method,
      path,
    ],
    workspace,
    '',
    10000,
    env,
  );
  const networkAfter = method === 'network' ? await normal() : null;
  const after = method === 'network' ? null : sha256(await readFile(path));
  const log = join(root, `${target}-${method}.json`);
  await saveLight(log, {
    ...result,
    targetPath: path,
    fixtureHash: sha256(await readFile(fixture)),
    canaryBefore: before,
    canaryAfter: after,
    ...(networkBefore && networkAfter
      ? { controls: { before: networkBefore, after: networkAfter } }
      : {}),
  });
  let actual =
    networkBefore && networkAfter
      ? networkBoundaryObservation(result, networkBefore, networkAfter, {
          program: basename(executable),
          port: Number(new URL(path).port),
        })
      : observation(result, method, expected);
  if (method === 'write' && expected !== 'allowed' && before !== after) {
    actual = 'unconfirmed';
  }
  return {
    method,
    target: target,
    expected: expected,
    result: actual,
    log,
    sha256: sha256(await readFile(log)),
  };
}

// 公式sandbox入口で既存の独立固定操作を実行する。CLIの公開読取りツールは代用せず未確認に残す。
async function diagnoseOperations(
  directory: string,
  executables: string[],
  cliExecutable: string,
  canary: string,
) {
  const root = join(directory, 'diagnostic');
  const workspace = join(root, 'workspace');
  const temporary = join(root, 'temporary');
  const home = join(root, 'dummy-auth');
  for (const path of [workspace, temporary, home]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const fixtureSource = resolve(import.meta.dir, 'tests/light-boundary.fixture.ts');
  const fixture = join(workspace, 'boundary-probe.ts');
  const fixtureBody = await readFile(fixtureSource);
  await writeFile(fixture, fixtureBody, { flag: 'wx', mode: 0o600 });
  await saveLight(join(root, 'fixture.json'), {
    source: fixtureSource,
    path: fixture,
    sha256: sha256(fixtureBody),
  });
  const scratchTmp = await mkdtemp('/private/tmp/dotagents-light-boundary-');
  const scratchVarTmp = await mkdtemp('/private/var/tmp/dotagents-light-boundary-');
  const files: Record<string, string> = {
    'public-input': join(workspace, 'public.txt'),
    'trial-workspace': join(workspace, 'write.txt'),
    'trial-temporary': join(temporary, 'write.txt'),
    'dummy-auth': join(home, 'auth.json'),
    'dummy-auth-alias': join(temporary, 'auth-alias.txt'),
    'other-trial': join(root, 'other-trial'),
    'host-judgments': join(root, 'host-judgments'),
    'synthetic-private': join(root, 'synthetic-private'),
    // 個別denyへ追加しない。minimalの暗黙scratch許可を広く開いていないことを観測する。
    'unlisted-scratch-tmp': join(scratchTmp, 'canary.txt'),
    'unlisted-scratch-var-tmp': join(scratchVarTmp, 'canary.txt'),
    'reachable-loopback-canary': canary,
  };
  for (const [target, path] of Object.entries(files).filter(
    ([target]) => !['reachable-loopback-canary', 'dummy-auth-alias'].includes(target),
  )) {
    await writeFile(path, `SYNTHETIC_${target}\n`, { flag: 'wx', mode: 0o600 });
  }
  assert(files['dummy-auth'] && files['dummy-auth-alias']);
  await symlink(files['dummy-auth'], files['dummy-auth-alias']);
  const profile = lightProfile(
    workspace,
    temporary,
    [join(workspace, 'public.txt'), fixture],
    [
      home,
      join(root, 'other-trial'),
      join(root, 'host-judgments'),
      join(root, 'synthetic-private'),
    ],
    executables,
    home,
  );
  await saveLight(join(root, 'profile.json'), profile);
  const manifest: unknown = JSON.parse(
    await readFile(resolve(import.meta.dir, 'tests/fixtures/light-host-cases.json'), 'utf8'),
  );
  assert(isRecord(manifest) && Array.isArray(manifest.operations));
  const records = [];
  const executable = executables[0];
  assert(executable);
  for (const entry of manifest.operations) {
    assert(
      isRecord(entry) &&
        typeof entry.target === 'string' &&
        typeof entry.expected === 'string' &&
        Array.isArray(entry.methods),
    );
    const path = files[entry.target];
    assert(path);
    for (const method of entry.methods) {
      assert(typeof method === 'string');
      if (method === 'read-tool') {
        records.push({
          method,
          target: entry.target,
          result: 'unconfirmed',
          reason: '公開読取りツールの独立したモデルなし確認が必要',
        });
        continue;
      }
      const record = await diagnoseOperation(
        root,
        workspace,
        temporary,
        home,
        profile,
        executable,
        fixture,
        method,
        path,
        entry.target,
        entry.expected,
        cliExecutable,
      );
      records.push(record);
      const actual = record.result;
      // 起動不能の診断を全拒否条件の成功へ読み替えない。
      if (entry.target === 'public-input' && actual !== 'allowed') {
        return {
          status: 'unavailable',
          records,
          reason: 'モデルなし正常対照が成立しないため後続診断を停止',
          inferenceLaunched: false,
        };
      }
    }
  }
  return {
    status: 'unavailable',
    records,
    reason:
      'コマンド診断と公開読取りツール・期限・割込み・通常子処理の確認は別です。完全なホスト証拠は未作成',
    inferenceLaunched: false,
  };
}

export async function diagnoseLight(
  directory: string,
  executables: string[],
  cliExecutable: string,
) {
  // 公開の合成本文だけを返す。モデル要求の応答・転送機能は持たない。
  const body = 'SYNTHETIC_NATIVE_NETWORK_CANARY\n';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      new Response(new URL(request.url).pathname === '/canary' ? body : '', {
        status: new URL(request.url).pathname === '/canary' ? 200 : 404,
      }),
  });
  const canary = `http://127.0.0.1:${server.port}/canary`;
  const control = async () => {
    const response = await fetch(canary, { signal: AbortSignal.timeout(3000) });
    assert(response.status === 200 && (await response.text()) === body, '通信正常対照の失敗');
    return { status: response.status, sha256: sha256(body) };
  };
  try {
    const before = await control();
    const diagnostic = await diagnoseOperations(directory, executables, cliExecutable, canary);
    const after = await control();
    await saveLight(join(directory, 'network-control.json'), { canary, before, after });
    return diagnostic;
  } finally {
    await server.stop(true);
  }
}
