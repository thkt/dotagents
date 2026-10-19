import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { collectLightArtifacts, nativeCommand, saveLight } from '../light-native.ts';
import { isRecord } from '../../scripts/shared/values.ts';
import { lightNativeWorker } from './light-native.worker.ts';

async function temporary(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'light-native-contract-'));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('ネイティブ起動は実処理と課題内失敗を観測しCLIの非0終了と区別する', async () => {
  await temporary(async (root) => {
    for (const code of [0, 23]) {
      const script = `const task=Bun.spawnSync(['/bin/sh','-c','exit 7']);console.log('SYNTHETIC_TASK_EXIT_'+task.exitCode);console.log('SYNTHETIC_REACHED');console.error('SYNTHETIC_STDERR');process.exit(${code});`;
      const result = await nativeCommand([process.execPath, '-e', script], root, '', 5000, {});
      expect(result.code).toBe(code);
      expect(result.stdout).toContain('SYNTHETIC_REACHED');
      expect(result.stdout).toContain('SYNTHETIC_TASK_EXIT_7');
      expect(result.stderr).toContain('SYNTHETIC_STDERR');
      expect(result.reason).toBeNull();
      expect(result.processesStopped).toBe(true);
    }
  });
});

test('16MiBのログ上限を超える実出力を切り詰め成功へ変換しない', async () => {
  await temporary(async (root) => {
    const result = await nativeCommand(
      [
        process.execPath,
        '-e',
        "console.log('SYNTHETIC_REACHED');process.stdout.write('x'.repeat(17*1024*1024));",
      ],
      root,
      '',
      5000,
      {},
    );
    expect(result.stdout).toContain('SYNTHETIC_REACHED');
    expect(result.reason).toBeTruthy();
    expect(result.processesStopped).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
  });
});

async function pids(path: string) {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(
    Array.isArray(value) &&
      value.length === 2 &&
      value.every((pid) => Number.isInteger(pid) && pid > 0),
  );
  return value.map((pid: unknown) => {
    assert(typeof pid === 'number');
    return pid;
  });
}

function stopped(ids: number[]) {
  for (const pid of ids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
}

function cleanup(ids: number[]) {
  for (const pid of ids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 終了済みの子処理は操作しない。 */
    }
  }
}

test('期限で実際に開始した通常の親子を止め、終了を成功と混同しない', async () => {
  await temporary(async (root) => {
    const ready = join(root, 'ready.json');
    let ids: number[] = [];
    try {
      const result = await nativeCommand(
        [process.execPath, lightNativeWorker, 'operation', ready],
        root,
        '',
        1000,
        {},
      );
      ids = await pids(ready);
      expect(result.stdout).toContain('SYNTHETIC_OPERATION_REACHED');
      expect(result.reason).toBe('timeout');
      expect(result.processesStopped).toBe(true);
      expect(result.cleanupMs).toBeLessThanOrEqual(30000);
      stopped(ids);
    } finally {
      cleanup(ids);
    }
  });
}, 10000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal}で実処理到達後の親子を止め、割込みの原記録を返す`, async () => {
    await temporary(async (root) => {
      const ready = join(root, 'ready.json');
      const worker = Bun.spawn([process.execPath, lightNativeWorker, 'wrapper', ready], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let ids: number[] = [];
      try {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            ids = await pids(ready);
            break;
          } catch {
            await Bun.sleep(10);
          }
        }
        assert.equal(ids.length, 2, '未到達を割込み停止の成功にしない');
        worker.kill(signal);
        const raw = await new Response(worker.stdout).text();
        const error = await new Response(worker.stderr).text();
        assert.equal(await worker.exited, 0, raw + error);
        const result: unknown = JSON.parse(raw);
        assert(isRecord(result));
        expect(result.reason).toBeTruthy();
        expect(result.stdout).toContain('SYNTHETIC_OPERATION_REACHED');
        expect(result.processesStopped).toBe(true);
        assert(typeof result.cleanupMs === 'number' && result.cleanupMs <= 30000);
        stopped(ids);
      } finally {
        worker.kill();
        cleanup(ids);
      }
    });
  }, 15000);
}

test('新規JSON保存は既存記録を上書きせず、失敗を呼出側へ伝える', async () => {
  await temporary(async (root) => {
    const path = join(root, 'record.json');
    await saveLight(path, { original: true });
    const original = await readFile(path, 'utf8');
    await assert.rejects(saveLight(path, { original: false }));
    expect(await readFile(path, 'utf8')).toBe(original);
    await assert.rejects(saveLight(join(root, 'absent', 'record.json'), {}));
  });
});

for (const [scenario, size, count, allowed] of [
  ['normal', 1048576, 1, true],
  ['normal-total', 1048576, 8, true],
  ['normal-count', 1, 2000, true],
  ['file-limit', 1048577, 1, false],
  ['total-limit', 1048576, 9, false],
  ['count-limit', 1, 2001, false],
  ['symlink', 1, 1, false],
] as const) {
  test(`成果物収集は原本文・hashを保持し容量と通常ファイルを検査する: ${scenario}`, async () => {
    await temporary(async (root) => {
      const source = join(root, 'workspace');
      const destination = join(root, 'collected');
      await mkdir(source);
      await mkdir(destination);
      for (let i = 0; i < count; i++) {
        await writeFile(join(source, `${i}.txt`), Buffer.alloc(size, 120));
      }
      if (scenario === 'symlink') {
        await symlink(join(source, '0.txt'), join(source, 'alias'));
      }
      if (!allowed) {
        await assert.rejects(collectLightArtifacts(source, destination));
        return;
      }
      const hashes = await collectLightArtifacts(source, destination);
      const original = await readFile(join(source, '0.txt'));
      expect(await readFile(join(destination, '0.txt'))).toEqual(original);
      expect(Object.keys(hashes)).toHaveLength(count);
      expect(hashes['0.txt']).toBe(createHash('sha256').update(original).digest('hex'));
    });
  });
}
