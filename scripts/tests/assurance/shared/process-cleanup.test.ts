import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const target = resolve(
  process.env.PROCESS_MODULE ?? join(import.meta.dir, '../../../shared/process.ts'),
);
const evidenceRoot = process.env.PROCESS_EVIDENCE
  ? resolve(process.env.PROCESS_EVIDENCE)
  : await mkdtemp(join(tmpdir(), 'process-cleanup-'));
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
  if (
    isObject(value) &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    typeof value.timedOut === 'boolean'
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    const found = acquired(child);
    if (found) {
      return found;
    }
  }
}

async function cleanup(root: string) {
  // runnerの異常終了でも、この試験が起動したgroupだけ回収する。
  try {
    const group = Number(await readFile(join(root, 'group.pid'), 'utf8'));
    if (Number.isSafeInteger(group) && group > 1) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (error) {
        assert(error instanceof Error && 'code' in error && error.code === 'ESRCH');
      }
      assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

async function probe(trigger: string, injection: string) {
  const root = await mkdtemp(join(evidenceRoot, `${trigger}-${injection}-`));
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dir, '../../support/process-cleanup-probe.ts'),
      target,
      root,
      trigger,
      injection,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => {
    stdout += data;
  });
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    child.kill('SIGKILL');
  }, 8000);
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  await writeFile(join(root, 'probe.stdout'), stdout);
  await writeFile(join(root, 'probe.stderr'), stderr);
  try {
    expect({ code, forced, stderr }).toMatchObject({ code: 0, forced: false });
    const parsed: unknown = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    const report = object(parsed);
    expect(report.harnessError).toBeUndefined();
    expect(report.cleanupError).toBeUndefined();
    expect(report.groupAliveAfterCleanup).toBe(false);
    return report;
  } finally {
    await cleanup(root);
  }
}

test('正常なgroup終了は取得出力と既知の非zero終了を保存する', async () => {
  const report = await probe('exit', 'none');
  expect(report.escaped).toEqual([]);
  expect(report.first).toMatchObject({
    status: 'fulfilled',
    value: { code: 7, stdout: '取得済みstdout\n', stderr: '取得済みstderr\n', timedOut: false },
  });
  expect(report.saved).toEqual({ stdout: '取得済みstdout\n', stderr: '取得済みstderr\n' });
  expect(report.groupAliveBeforeNext).toBe(false);
  expect(report.nextStarted).toBe(true);
}, 10000);

for (const trigger of ['exit', 'timeout', 'signal']) {
  test(`${trigger}のgroup終了エラーは記録を保ってrejectし、未回収groupがあれば次の起動を拒否する`, async () => {
    const report = await probe(trigger, 'EPERM');
    assert(Array.isArray(report.injected));
    expect(report.injected.length).toBeGreaterThan(0);
    expect(report.escaped).toEqual([]);
    const first = object(report.first);
    expect(first.status).toBe('rejected');
    expect(JSON.stringify(first.error)).toContain('controlled owned-group kill failure');
    expect(JSON.stringify(first.error)).toContain('EPERM');
    const result = acquired(first.error);
    assert(result);
    expect(result).toMatchObject({
      stdout: '取得済みstdout\n',
      stderr: '取得済みstderr\n',
      timedOut: trigger === 'timeout',
    });
    if (trigger === 'exit') {
      expect(result.code).toBe(7);
    } else {
      expect(result.code === null || result.code === undefined).toBe(true);
    }
    expect(report.saved).toEqual({ stdout: '取得済みstdout\n', stderr: '取得済みstderr\n' });
    if (report.groupAliveBeforeNext === true) {
      expect(object(report.next).status).toBe('rejected');
      expect(report.nextStarted).toBe(false);
    }
  }, 10000);
}
