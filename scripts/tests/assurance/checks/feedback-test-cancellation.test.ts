import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alive } from '../../support/process-alive.ts';
import { header, nestedEnv, withFeedbackRepository } from '../../support/feedback-loop-fixture.ts';

const entry = resolve(import.meta.dir, '../../../test-runtime/feedback-test.ts');

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert(Date.now() < deadline, message);
    await Bun.sleep(20);
  }
}

function exited(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
}

function terminateGroup(pid: number | undefined) {
  try {
    process.kill(-(pid ?? 0), 'SIGKILL');
  } catch {
    // 正常に終了していれば、グループはすでにありません。
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`起動入口は${signal}で先に終了せず、bunの後片付けを待って同じ終了コードを返す`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-test-signal-')));
    const started = join(root, 'started');
    const finished = join(root, 'finished');
    const script = `const fs = require('node:fs');
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(finished)}, 'done');
  process.exit(7);
}, 300));
fs.writeFileSync(${JSON.stringify(started)}, 'started');
setInterval(() => {}, 1000);`;
    const command = spawn(process.execPath, [entry, '-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    const result = exited(command);
    try {
      await waitFor(() => existsSync(started), 'bunが開始しませんでした');
      assert(command.pid);
      process.kill(-command.pid, signal);
      expect(await result).toEqual({ code: 7, signal: null });
      expect(existsSync(finished)).toBe(true);
    } finally {
      terminateGroup(command.pid);
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test(`test:affectedの${signal}取消は非ゼロで終了し、workerを残さず成功記録を採用しない`, async () => {
    const hang = `${header}import { writeFileSync } from 'node:fs';
test('hang', async () => {
  writeFileSync(process.env.HANG_MARKER!, String(process.pid));
  await new Promise(() => {});
}, 60000);\n`;
    await withFeedbackRepository({ 'scripts/tests/quality/hang.test.ts': hang }, async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const marker = join(cwd, '..', 'hang.pid');
      const command = spawn(process.execPath, ['scripts/feedback-loop/runtime.mjs', 'affected'], {
        cwd,
        stdio: 'ignore',
        env: { ...nestedEnv(cwd), HANG_MARKER: marker },
      });
      const result = exited(command);
      await waitFor(() => existsSync(marker), 'テストファイルが開始しませんでした');
      const worker = Number(readFileSync(marker, 'utf8'));
      expect(alive(worker)).toBe(true);
      command.kill(signal);
      expect((await result).code).toBe(1);
      await waitFor(() => !alive(worker), `workerが残っています: ${worker}`);
      const records = join(cwd, '.feedback-loop-records', 'test-deps.json');
      expect(existsSync(`${records}.pending`)).toBe(false);
      expect(JSON.parse(readFileSync(records, 'utf8'))).toEqual({});
    });
  }, 30000);
}
