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

async function runProbe(trigger: string, injection: string, blockReport = false) {
  const root = await mkdtemp(join(evidenceRoot, `${trigger}-${injection}-`));
  if (blockReport) {
    await mkdir(join(root, 'report.json'));
  }
  const env = { ...process.env };
  // Bunの自動回収を外し、command自身による子孫の終了を検証する。
  delete env.BUN_FEATURE_FLAG_NO_ORPHANS;
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dir, '../../support/process-cleanup-probe.ts'),
      target,
      root,
      trigger,
      injection,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
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
    const report: unknown = blockReport
      ? undefined
      : JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    return { code, forced, stderr, report };
  } finally {
    await cleanup(root);
  }
}

async function probe(trigger: string, injection: string) {
  const result = await runProbe(trigger, injection);
  expect(result).toMatchObject({ code: 0, forced: false });
  const report = object(result.report);
  expect(report.harnessError).toBeUndefined();
  expect(report.cleanupError).toBeUndefined();
  expect(report.groupAliveAfterCleanup).toBe(false);
  return report;
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

test('後片付けの一時的な存在確認EPERMでも消滅を再確認して報告を保存する', async () => {
  const report = await probe('exit', 'cleanup-EPERM-once');
  expect(report.injected).toMatchObject([{ signal: 0, error: { code: 'EPERM' } }]);
  expect(report.escaped).toEqual([]);
  expect(report.saved).toEqual({ stdout: '取得済みstdout\n', stderr: '取得済みstderr\n' });
}, 10000);

for (const injection of ['cleanup-EPERM', 'cleanup-exception']) {
  test(`後片付けの${injection}でも失敗と取得出力の報告を保存する`, async () => {
    const result = await runProbe('exit', injection);
    expect(result).toMatchObject({ code: 0, forced: false });
    const report = object(result.report);
    expect(report.harnessError).toBeUndefined();
    expect(report.cleanupError).toBeDefined();
    expect(report.groupAliveAfterCleanup).not.toBe(false);
    expect(report.escaped).toEqual([]);
    expect(report.saved).toEqual({ stdout: '取得済みstdout\n', stderr: '取得済みstderr\n' });
    assert(Array.isArray(report.injected));
    expect(report.injected.length).toBeGreaterThan(injection === 'cleanup-EPERM' ? 1 : 0);
    expect(report.injected[0]).toMatchObject({ signal: 0 });
    if (injection === 'cleanup-exception') {
      expect(report.cleanupError).toMatchObject({ code: 'EIO' });
    }
  }, 10000);
}

test('報告自体を書き込めない場合は非zero終了する', async () => {
  const result = await runProbe('exit', 'none', true);
  expect(result.forced).toBe(false);
  expect(result.code).not.toBeNull();
  expect(result.code).not.toBe(0);
}, 10000);
