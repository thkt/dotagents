import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import { fixture, writeProbe, run, paths, entry } from '../../support/runner-selection.ts';
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function terminateGroup(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(isRecord(error) && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await condition())) {
    assert(Date.now() < deadline, '状態待機の期限超過');
    await Bun.sleep(10);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal}の取消は非ゼロで終了し、workerとその子プロセスを残さない`, async () => {
    await fixture(async (cwd) => {
      for (const name of ['first', 'second']) {
        await writeProbe(
          cwd,
          name,
          `
test('${name} cancellation', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  await Bun.write('${name}.pids.json', JSON.stringify([process.pid, child.pid]));
  await new Promise(() => {});
}, 30000);`,
        );
      }
      const command = spawn(process.execPath, [entry, 'bun', ...paths, '--parallel=2'], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: 'true', TMPDIR: join(cwd, 'reports') },
      });
      let output = '';
      command.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });
      command.stderr.on('data', (data: Buffer) => {
        output += data.toString();
      });
      let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const ended = new Promise<void>((resolve, reject) => {
        command.once('exit', (code, signal) => {
          result = { code, signal };
          resolve();
        });
        command.once('error', reject);
      });
      const pids: number[] = [];
      try {
        await waitFor(async () => {
          for (const name of ['first', 'second']) {
            if (!(await Bun.file(join(cwd, `${name}.pids.json`)).exists())) {
              return false;
            }
          }
          return true;
        });
        for (const name of ['first', 'second']) {
          const observed: unknown = JSON.parse(
            await readFile(join(cwd, `${name}.pids.json`), 'utf8'),
          );
          assert(Array.isArray(observed) && observed.length === 2);
          for (const pid of observed) {
            assert(typeof pid === 'number' && Number.isInteger(pid) && pid > 0);
            pids.push(pid);
          }
        }
        expect(pids.every(alive)).toBe(true);
        command.kill(signal);
        await waitFor(async () => result !== undefined && pids.every((pid) => !alive(pid)));
        expect(result?.code).not.toBe(0);
        expect(output).not.toContain('All tests executed.');
        expect(await readdir(join(cwd, 'reports'))).toEqual([]);
      } finally {
        terminateGroup(command.pid);
        await ended;
      }
    });
  }, 20000);
}

for (const parallel of [false, true]) {
  test(`workerの強制終了を成功にしない: ${parallel ? 'parallel' : 'serial'}`, async () => {
    await fixture(async (cwd) => {
      const args = [...paths, ...(parallel ? ['--parallel=2'] : [])];
      const normal = run(cwd, args);
      expect(normal.code, normal.output).toBe(0);
      expect(normal.output).toMatch(/Ran 2 tests across 2 files/);
      await writeProbe(
        cwd,
        'second',
        "test('second crash', () => { console.error('SECOND_CRASH'); process.kill(process.pid, 'SIGKILL'); });",
      );
      const crashed = run(cwd, args);
      expect(crashed.code, crashed.output).toBe(1);
      expect(crashed.output).toContain('SECOND_CRASH');
      expect(crashed.output).not.toContain('All tests executed.');
    });
  });
}
