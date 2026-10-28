import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  fixture,
  runAffected,
  changeTarget,
  recordFile,
  header,
  entry,
  baseEnv,
} from '../../support/runner-affected.ts';
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

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert(Date.now() < deadline, message);
    await Bun.sleep(20);
  }
}

test('SIGINT で中断した--affected は記録ファイルを書き換えない', async () => {
  const hang =
    `${header}import { writeFileSync } from 'node:fs';\n` +
    `test('hang', async () => {
  const marker = process.env.HANG_MARKER;
  if (marker) {
    writeFileSync(marker, 'started');
    await new Promise(() => {});
  }
  expect((await import('./target.ts')).value).toBeGreaterThan(0);
}, 60000);\n`;
  await fixture(
    {
      'scripts/tests/target.ts': 'export const value = 1;\n',
      'scripts/tests/hang.test.ts': hang,
    },
    async (f) => {
      await changeTarget(f, 2);
      const first = runAffected(f);
      expect(first.code, first.output).toBe(0);
      const path = recordFile(f.repo);
      const before = readFileSync(path, 'utf8');
      const entriesBefore = readdirSync(dirname(path)).sort();

      await changeTarget(f, 3);
      const marker = join(f.signals, 'hang.started');
      const command = spawn(process.execPath, [entry, 'bun', '--affected'], {
        cwd: f.repo,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...baseEnv(f), HANG_MARKER: marker },
      });
      let output = '';
      command.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });
      command.stderr.on('data', (data: Buffer) => {
        output += data.toString();
      });
      let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const ended = new Promise<void>((resolveEnded, reject) => {
        command.once('exit', (code, signal) => {
          result = { code, signal };
          resolveEnded();
        });
        command.once('error', reject);
      });
      try {
        await waitFor(
          () => existsSync(marker) || result !== undefined,
          `テストファイルが開始しませんでした: ${output}`,
        );
        expect(existsSync(marker), `選んだテストファイルが開始しません: ${output}`).toBe(true);
        command.kill('SIGINT');
        await waitFor(() => result !== undefined, `SIGINT で終了しません: ${output}`);
        expect(result?.code, output).not.toBe(0);
        expect(output).not.toContain('All tests executed.');
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(readdirSync(dirname(path)).sort()).toEqual(entriesBefore);
      } finally {
        terminateGroup(command.pid);
        await ended;
      }
    },
  );
}, 90000);
