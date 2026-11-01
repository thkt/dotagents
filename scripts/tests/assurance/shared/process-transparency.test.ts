import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';

const target = resolve(
  process.env.PROCESS_MODULE ?? join(import.meta.dir, '../../../shared/process.ts'),
);
const evidenceRoot = process.env.PROCESS_EVIDENCE
  ? resolve(process.env.PROCESS_EVIDENCE)
  : await mkdtemp(join(tmpdir(), 'process-transparency-'));
await mkdir(evidenceRoot, { recursive: true });

function object(value: unknown) {
  assert(isRecord(value));
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

function fulfilled(report: Record<string, unknown>) {
  expect(report.status).toBe('fulfilled');
  const value = object(report.value);
  expect(value).toMatchObject({ code: 0, timedOut: false });
  return value;
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

async function groupPid(root: string) {
  try {
    return Number(await readFile(join(root, 'group.pid'), 'utf8'));
  } catch (error) {
    assert(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
}

async function assertGroupGone(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return;
      }
    }
    await Bun.sleep(20);
  }
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
}

async function probe(scenario: string, input: Buffer) {
  const root = await mkdtemp(join(evidenceRoot, `${scenario}-`));
  await writeFile(join(root, 'input'), input);
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, '../../support/process-transparency-probe.ts'), target, root, scenario],
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
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    killOwnedGroup(child.pid);
  }, 8000);
  const code = await closed;
  clearTimeout(timer);
  try {
    expect({ code, forced, stderr }).toMatchObject({ code: 0, forced: false });
    const parsed: unknown = JSON.parse(await readFile(join(root, 'settled.json'), 'utf8'));
    const report = object(parsed);
    return {
      report,
      stdout: await readFile(join(root, 'acquired.stdout')),
      stderr: await readFile(join(root, 'acquired.stderr')),
    };
  } finally {
    const group = await groupPid(root);
    killOwnedGroup(group);
    killOwnedGroup(child.pid);
    await assertGroupGone(group);
    await assertGroupGone(child.pid);
    await writeFile(
      join(root, 'observation.json'),
      `${JSON.stringify({ scenario, group, controller: child.pid, code, forced, inputBytes: input.length, inputSha256: createHash('sha256').update(input).digest('hex') }, null, 2)}\n`,
    );
    await writeFile(join(root, 'controller.stdout'), stdout);
    await writeFile(join(root, 'controller.stderr'), stderr);
  }
}

test('stdoutとstderrの先頭BOMを戻り値と保存原出力へ保持する', async () => {
  const result = await probe('bom', Buffer.alloc(0));
  const value = fulfilled(result.report);
  expect(value.stdout).toBe('\ufeffA');
  expect(value.stderr).toBe('\ufeffB');
  expect(result.stdout.toString('hex')).toBe('efbbbf41');
  expect(result.stderr.toString('hex')).toBe('efbbbf42');
}, 10000);

test('正常childへ大きなstdinの全byteを透過的に渡す', async () => {
  const input = Buffer.from('\ufeff日本語\r\n' + '0123456789abcdef'.repeat(512 * 1024));
  const result = await probe('large-stdin', input);
  const value = fulfilled(result.report);
  assert(typeof value.stdout === 'string');
  const actual: unknown = JSON.parse(value.stdout);
  expect(actual).toEqual({
    bytes: input.length,
    sha256: createHash('sha256').update(input).digest('hex'),
  });
  expect(result.stdout.toString('utf8')).toBe(value.stdout);
  expect(value.stderr).toBe('');
  expect(result.stderr.length).toBe(0);
}, 10000);

test('一部出力後のread失敗とgroup終了失敗を、取得完了へ補完しない', async () => {
  const result = await probe('read-failure', Buffer.alloc(0));
  expect(result.report.conditions).toMatchObject({ readFailures: 1, stderrEof: true });
  const conditions = object(result.report.conditions);
  assert(typeof conditions.groupKills === 'number');
  expect(conditions.groupKills).toBeGreaterThan(0);
  expect(result.report.escaped).toEqual([]);
  expect(result.report.status).toBe('rejected');
  expect(JSON.stringify(result.report.error)).toContain('EPERM');
  expect(JSON.stringify(result.report.error)).toContain('controlled stdout read failure');
  const error = object(result.report.error);
  expect(error.outputComplete).toBe(false);
  const value = acquired(error);
  assert(value);
  expect(value).toMatchObject({ stdout: 'partial stdout', timedOut: false });
  expect(value.code === null || value.code === undefined).toBe(true);
  expect(result.stdout.toString('utf8')).toBe('partial stdout');
  assert(typeof value.stderr === 'string');
  expect(result.stderr.toString('utf8')).toBe(value.stderr);
}, 10000);
