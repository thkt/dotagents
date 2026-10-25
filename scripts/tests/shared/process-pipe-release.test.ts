import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const target = resolve(
  process.env.PROCESS_MODULE ?? join(import.meta.dir, '../../shared/process.ts'),
);
const evidenceRoot = process.env.PROCESS_EVIDENCE
  ? resolve(process.env.PROCESS_EVIDENCE)
  : await mkdtemp(join(tmpdir(), 'process-pipe-release-'));
await mkdir(evidenceRoot, { recursive: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert(isObject(value));
  return value;
}

function acquired(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if ('stdout' in value && 'stderr' in value && 'timedOut' in value) {
    return object(value);
  }
  for (const item of Object.values(value)) {
    const found = acquired(item);
    if (found) {
      return found;
    }
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    return false;
  }
}

function killOwnedGroup(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }
  assert(Number.isSafeInteger(pid) && pid > 1);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    assert(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

async function maybePid(root: string, name: string) {
  try {
    return Number(await readFile(join(root, name), 'utf8'));
  } catch (error) {
    assert(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
}

async function waitForReport(root: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, 'settled.json'), 'utf8'));
      return object(parsed);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await Bun.sleep(10);
  }
  throw Error(`command did not settle; inspect ${root}`);
}

async function boundedExit(closed: Promise<number | null>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then((code) => ({ natural: true, code })),
      new Promise<{ natural: false; code: null }>((resolve) => {
        timer = setTimeout(() => resolve({ natural: false, code: null }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(inputBytes: number) {
  const root = await mkdtemp(join(evidenceRoot, `stdin-${inputBytes}-`));
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dir, '../support/process-pipe-release-probe.ts'),
      target,
      root,
      String(inputBytes),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => {
    stdout += data;
  });
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const observation: Record<string, unknown> = { inputBytes, controller: child.pid };
  try {
    const report = await waitForReport(root);
    const group = await maybePid(root, 'group.pid');
    assert(group !== undefined);
    observation.groupAliveAfterReject = alive(-group);
    observation.exit = await boundedExit(closed, 1500);
    observation.report = report;
    observation.saved = {
      stdout: await readFile(join(root, 'acquired.stdout'), 'utf8'),
      stderr: await readFile(join(root, 'acquired.stderr'), 'utf8'),
    };
    return observation;
  } finally {
    killOwnedGroup(await maybePid(root, 'group.pid'));
    await boundedExit(closed, 500);
    killOwnedGroup(child.pid);
    await closed;
    const pids = [
      await maybePid(root, 'group.pid'),
      await maybePid(root, 'descendant.pid'),
      child.pid,
    ];
    const deadline = Date.now() + 1000;
    while (pids.some((pid) => pid !== undefined && alive(pid)) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    observation.remaining = pids.filter((pid) => pid !== undefined && alive(pid));
    await writeFile(join(root, 'observation.json'), `${JSON.stringify(observation, null, 2)}\n`);
    await writeFile(join(root, 'controller.stdout'), stdout);
    await writeFile(join(root, 'controller.stderr'), stderr);
    expect(observation.remaining).toEqual([]);
  }
}

for (const inputBytes of [0, 8 * 1024 * 1024]) {
  test(`group終了失敗後はstdin ${inputBytes} bytesでもcontrollerが自然終了する`, async () => {
    const observation = await probe(inputBytes);
    const report = object(observation.report);
    assert(Array.isArray(report.injected));
    expect(report.injected.length).toBeGreaterThan(0);
    expect(report.escaped).toEqual([]);
    const first = object(report.first);
    expect(first.status).toBe('rejected');
    expect(JSON.stringify(first.error)).toContain('EPERM');
    const result = acquired(first.error);
    assert(result);
    expect(result).toMatchObject({
      stdout: '取得済みstdout\n',
      stderr: '取得済みstderr\n',
      timedOut: false,
    });
    expect(result.code === null || result.code === undefined).toBe(true);
    expect(observation.saved).toEqual({ stdout: '取得済みstdout\n', stderr: '取得済みstderr\n' });
    expect(observation.exit).toEqual({ natural: true, code: 0 });
  }, 10000);
}
