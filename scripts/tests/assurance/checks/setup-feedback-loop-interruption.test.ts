import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  baseEnv,
  config,
  files,
  fixture,
  header,
  installed,
  recordFile,
  retainedRecords,
  seed,
} from '../../support/feedback-loop-batch.ts';

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

async function waitFor(condition: () => boolean, message: () => string) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    assert(Date.now() < deadline, message());
    await Bun.sleep(10);
  }
}

function workerPids(directory: string) {
  return ['b', 'c']
    .map((name) => join(directory, `${name}.pid`))
    .filter(existsSync)
    .map((path) => Number(readFileSync(path, 'utf8')));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`生成入口の${signal}取消は起動済みworkerを終了し、一括候補の成功記録を採用しない`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({ ...config, bunWorkers: 2 }),
        'test/a.test.ts':
          header +
          "import { writeFileSync } from 'node:fs'; test('a', () => { expect(1).toBe(1); if (process.env.BATCH_SIGNALS) writeFileSync(process.env.BATCH_SIGNALS + '/a.done', 'done'); });\n",
        ...Object.fromEntries(
          ['b', 'c'].map((name) => [
            `test/${name}.test.ts`,
            `${header}import { writeFileSync } from 'node:fs';
test('${name}', async () => {
  if (process.env.BATCH_SIGNALS) {
    writeFileSync(process.env.BATCH_SIGNALS + '/${name}.pid', String(process.pid));
    await new Promise(() => {});
  }
  expect(1).toBe(1);
}, 30000);\n`,
          ]),
        ),
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
        const command = spawn(process.execPath, argv, {
          cwd: f.repo,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...baseEnv(f), BATCH_SIGNALS: f.signals },
        });
        let output = '';
        command.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
        command.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
        let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        const ended = new Promise<void>((done, fail) => {
          command.once('close', (code, signal) => {
            result = { code, signal };
            done();
          });
          command.once('error', fail);
        });
        try {
          await waitFor(
            () => existsSync(join(f.signals, 'a.done')) && existsSync(join(f.signals, 'b.pid')),
            () => `取消前の成功対照と実行中テストが揃いません: ${output}`,
          );
          const pids = workerPids(f.signals);
          expect(pids.length).toBeGreaterThan(0);
          expect(pids.every(alive)).toBe(true);
          command.kill(signal);
          await waitFor(
            () => result !== undefined,
            () => `取消が完了しません: ${output}`,
          );
          expect(result?.code, output).not.toBe(0);
          expect(workerPids(f.signals).some(alive), '生成入口の終了後もworkerが残っています').toBe(
            false,
          );
          expect(await retainedRecords(f)).toContain(original);
          const current = await readFile(recordFile(f.repo), 'utf8');
          for (const name of ['a', 'b', 'c']) {
            expect(current, output).not.toContain(join(f.repo, `test/${name}.test.ts`));
          }
        } finally {
          if (command.pid !== undefined) {
            try {
              process.kill(-command.pid, 'SIGKILL');
            } catch (error) {
              assert(isRecord(error) && error.code === 'ESRCH', String(error));
            }
          }
          await ended;
        }
      },
    );
  }, 20000);
}
