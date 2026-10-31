import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  baseEnv,
  config,
  files,
  fixture,
  header,
  installed,
  retainedRecords,
  run,
  seed,
} from '../../support/feedback-loop-batch.ts';

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert(isRecord(error) && error.code === 'ESRCH', String(error));
    return false;
  }
}

async function waitFor(condition: () => boolean, message: () => string) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    assert(Date.now() < deadline, message());
    await Bun.sleep(10);
  }
}

function terminate(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    assert(isRecord(error) && error.code === 'ESRCH', String(error));
  }
}

for (const cancellation of ['timeout', 'SIGTERM'] as const) {
  test(`ホストの${cancellation}取消は生成入口のBun leader・workerとpipeを解放する`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({ ...config, bunWorkers: 2 }),
        'test/b.test.ts': `${header}import { writeFileSync } from 'node:fs';
test('b', async () => {
  if (process.env.HOST_CANCEL_TRACE) {
    writeFileSync(process.env.HOST_CANCEL_TRACE, JSON.stringify({ worker: process.pid, leader: process.ppid }));
    await new Promise(() => {});
  }
  expect(1).toBe(1);
}, 30000);\n`,
      },
      async (f) => {
        installed(f);
        const original = await seed(f);
        await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
        const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'));
        assert(isRecord(pkg) && isRecord(pkg.scripts));
        const script = pkg.scripts['test:affected'];
        assert(typeof script === 'string');
        const argv = script.split(' ');
        expect(argv.shift()).toBe('bun');
        const trace = join(f.signals, 'worker.json');
        const resultPath = join(f.signals, 'result.json');
        const hostPath = join(f.signals, 'host.ts');
        await writeFile(
          hostPath,
          `
import { command, withInterrupts } from ${JSON.stringify(resolve(import.meta.dir, '../../../shared/process.ts'))};
import { writeFileSync } from 'node:fs';
try {
  const result = await withInterrupts(() => command(${JSON.stringify([process.execPath, ...argv])}, ${JSON.stringify(f.repo)}, '', ${cancellation === 'timeout' ? '500' : 'null'}));
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ result }));
} catch (error) {
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: String(error) }));
}
`,
        );
        const env: NodeJS.ProcessEnv = { ...baseEnv(f), HOST_CANCEL_TRACE: trace };
        delete env.BUN_FEATURE_FLAG_NO_ORPHANS;
        const host = spawn(process.execPath, [hostPath], {
          cwd: f.repo,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
        let output = '';
        host.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
        host.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
        let closed = false;
        const ended = new Promise<void>((done, fail) => {
          host.once('close', () => {
            closed = true;
            done();
          });
          host.once('error', fail);
        });
        const children = new Set<number>();
        try {
          await waitFor(
            () => existsSync(trace),
            () => `取消前に実Bunテストへ到達しません: ${output}`,
          );
          const observed: unknown = JSON.parse(readFileSync(trace, 'utf8'));
          assert(
            isRecord(observed) &&
              typeof observed.worker === 'number' &&
              typeof observed.leader === 'number',
          );
          children.add(observed.worker);
          children.add(observed.leader);
          expect([...children].every(alive)).toBe(true);
          if (cancellation === 'SIGTERM') {
            host.kill('SIGTERM');
          }
          await waitFor(
            () => closed,
            () => `取消後もホストがpipeを待っています: ${output}`,
          );
          const outcome: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
          assert(isRecord(outcome));
          if (cancellation === 'timeout') {
            assert(isRecord(outcome.result), JSON.stringify(outcome));
            expect(outcome.result.timedOut).toBe(true);
            expect(outcome.result.code).not.toBe(0);
          } else {
            expect(outcome.error).toContain('Interrupted execution');
          }
          expect(
            [...children].filter(alive),
            'ホスト取消後もleaderまたはworkerが残っています',
          ).toEqual([]);
          expect(await retainedRecords(f)).toContain(original);
          await unlink(join(f.repo, 'new-input.txt'));
          const repaired = run(f, ['run', 'test:affected']);
          expect(repaired.code, repaired.output).toBe(0);
          expect(repaired.output).toContain('quality選択: 2');
          await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
          const affected = run(f, ['run', 'test:affected']);
          expect(affected.code, affected.output).toBe(0);
          expect(affected.output).toContain('quality選択: 1');
          expect(affected.output).not.toContain('quality全件の理由:');
          expect(await retainedRecords(f)).toContain(original);
        } finally {
          for (const pid of [...children, ...(host.pid === undefined ? [] : [host.pid])]) {
            terminate(-pid);
            terminate(pid);
          }
          await ended;
          await waitFor(
            () => [...children].every((pid) => !alive(pid)),
            () => 'テストの後始末で子プロセスが残りました',
          );
        }
      },
    );
  }, 20000);
}
