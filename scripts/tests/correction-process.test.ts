import { test, expect, afterEach } from 'bun:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { correctionFixture, controller, object, events } from './support/correction.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

test('time limit terminates actor and keeps consumed reservation', async () => {
  const t = await trial('timeout', { modelTimeMs: 100 });
  t.execute();
  const state = await t.state();
  expect(state.result).toBe('execution_limit');
  expect(state.repair).toBe(1);
  expect(state.active).toBeNull();
  expect(object(events(state.events).at(-1)).timedOut).toBe(true);
  t.execute();
  expect((await t.state()).repair).toBe(1);
});

test('check timeout is unavailable evidence and does not start a model', async () => {
  const t = await trial('check_timeout', { checkTimeMs: 100 });
  t.execute();
  const state = await t.state();
  expect(state.result).toBe('check_unavailable');
  expect([state.repair, state.review]).toEqual([0, 0]);
  expect(object(events(state.events)[0]).timedOut).toBe(true);
});

test('check startup failure retains the error without starting a model', async () => {
  const t = await trial('normal', { check: ['/nonexistent-correction-test-command'] });
  expect(t.execute().status).toBe(1);
  const state = await t.state();
  expect(state.result).toBe('check_unavailable');
  expect([state.repair, state.review]).toEqual([0, 0]);
  const error = await readFile(join(t.config.runDir, 'check-1.stderr'), 'utf8');
  expect(error).toContain('ENOENT');
});

async function waitForFile(path: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await Bun.sleep(20);
  }
  throw Error(`Timed out waiting for ${path}`);
}

for (const role of ['check', 'repair', 'review', 'capture'] as const) {
  // Every role checks its reservation; the other signals exercise the shared handler once.
  for (const signal of role === 'repair'
    ? (['SIGINT', 'SIGTERM', 'SIGKILL'] as const)
    : (['SIGTERM'] as const)) {
    test(`${signal} during ${role} preserves reservation and blocks duplicate execution`, async () => {
      const t = await trial('normal', { checkTimeMs: 15000 });
      if (role === 'review') {
        await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
      }
      const pidFile = join(t.root, 'actor.pid');
      const heartbeat = join(t.config.cwd, 'heartbeat');
      const worker = join(t.root, 'worker.js');
      await writeFile(
        worker,
        `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const [heartbeat, pidFile] = process.argv.slice(2);
if (pidFile) {
  spawn(process.execPath, [process.argv[1], heartbeat], {stdio:'inherit'});
  writeFileSync(pidFile, String(process.pid));
} else {
  setInterval(() => writeFileSync(heartbeat, String(Date.now())), 20);
}
`,
      );
      await writeFile(
        t.configFile,
        JSON.stringify({ ...t.config, [role]: [process.execPath, worker, heartbeat, pidFile] }),
      );
      const child = spawn(process.execPath, [controller, t.configFile], { stdio: 'ignore' });
      const stateFile = join(t.config.runDir, 'state.json');
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
      let group: number | undefined;
      try {
        group = Number(await waitForFile(pidFile));
        await waitForFile(heartbeat);
        const before = await readFile(stateFile, 'utf8');
        const state = object(JSON.parse(before));
        expect(object(state.active).role).toBe(role);
        expect(state[role === 'check' || role === 'capture' ? 'checks' : role]).toBe(
          role === 'capture' ? 0 : 1,
        );
        // A second controller must not enter the same run while the first is alive.
        expect(t.execute().status).toBe(1);
        child.kill(signal);
        expect(await closed).toBe(signal === 'SIGKILL' ? null : 1);
        if (signal !== 'SIGKILL') {
          const stopped = await readFile(heartbeat, 'utf8');
          await Bun.sleep(150);
          expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
        }
        expect(await readFile(stateFile, 'utf8')).toBe(before);
        const retry = t.execute();
        expect(retry.status).toBe(1);
        expect(retry.stderr).toContain(signal === 'SIGKILL' ? 'EEXIST' : 'Interrupted execution');
        expect(await readFile(stateFile, 'utf8')).toBe(before);
      } finally {
        child.kill('SIGKILL');
        if (group !== undefined) {
          try {
            process.kill(-group, 'SIGKILL');
          } catch {
            /* Already stopped. */
          }
        }
        await closed;
      }
    }, 10000);
  }
}

test('split UTF-8 survives requirements, actor replies and both logs', async () => {
  const t = await trial('unicode');
  await writeFile(
    join(t.root, 'helper.js'),
    `import {readFileSync,writeFileSync} from 'node:fs';
const role=process.argv[2];
async function split(stream,text) {
 const bytes=Buffer.from(text);
 const cut=bytes.findIndex(byte=>byte>127)+1;
 stream.write(bytes.subarray(0,cut));
 await new Promise(resolve=>setTimeout(resolve,50));
 stream.write(bytes.subarray(cut));
}
if(role==='issue') await split(process.stdout,'日本語の要件');
if(role==='check' && readFileSync('source.txt','utf8')==='broken') {
 await split(process.stdout,'確認結果');
 await split(process.stderr,'修正が必要');
 process.exitCode=1;
}
if(role==='repair') {
 writeFileSync('source.txt','correct');
 await split(process.stdout,JSON.stringify({status:'repaired',findings:'修正済み'}));
}
if(role==='review') await split(process.stdout,JSON.stringify({status:'accepted',findings:'検証済み'}));
`,
  );
  expect(t.execute().status).toBe(0);
  for (const role of ['repair', 'review']) {
    expect(await readFile(join(t.config.runDir, `${role}-1.prompt`), 'utf8')).toContain(
      '日本語の要件',
    );
  }
  expect(await readFile(join(t.config.runDir, 'check-1.stdout'), 'utf8')).toBe('確認結果');
  expect(await readFile(join(t.config.runDir, 'check-1.stderr'), 'utf8')).toBe('修正が必要');
  for (const [role, findings] of [
    ['repair', '修正済み'],
    ['review', '検証済み'],
  ]) {
    const reply = object(
      JSON.parse(await readFile(join(t.config.runDir, `${role}-1.stdout`), 'utf8')),
    );
    expect(reply.findings).toBe(findings);
  }
});
