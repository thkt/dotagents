import { test, expect, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { correctionFixture, controller, object, events } from '../../support/correction.ts';
import { alive } from '../../support/process-alive.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

async function childWriter(root: string) {
  const pidFile = join(root, 'actor.pid');
  const heartbeat = join(root, 'heartbeat');
  const worker = join(root, 'worker.js');
  await writeFile(
    worker,
    `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const [heartbeat, pidFile] = process.argv.slice(2);
if (pidFile) {
  console.log('actor started');
  console.error('actor diagnostic');
  spawn(process.execPath, [process.argv[1], heartbeat], {stdio:'inherit'});
  writeFileSync(pidFile, String(process.pid));
} else {
  setInterval(() => writeFileSync(heartbeat, String(Date.now())), 20);
}
`,
  );
  return { argv: [process.execPath, worker, heartbeat, pidFile], heartbeat, pidFile };
}

for (const failure of ['check', 'timeout'] as const) {
  test(`one-shot review preserves ${failure} evidence without repair or reexecution`, async () => {
    const t = await trial('normal');
    const { repair: _repair, ...config } = t.config;
    const { argv, heartbeat } = await childWriter(t.root);
    if (failure === 'timeout') {
      await writeFile(join(config.cwd, 'source.txt'), 'correct');
    }
    await writeFile(
      t.configFile,
      JSON.stringify({
        ...config,
        reviewTimeMs: 300,
        review: argv,
      }),
    );
    expect(t.execute('review').status).toBe(1);
    const state = await t.state();
    expect(state).toMatchObject({
      result: failure === 'check' ? 'check_failed' : 'review_timeout',
      review: failure === 'check' ? 0 : 1,
      repair: 0,
      checks: 1,
      active: null,
      reviewHistory: [],
    });
    const paths = ['state.json', 'check-1.stdout', 'check-1.stderr'];
    if (failure === 'timeout') {
      paths.push('review-1.stdout', 'review-1.stderr');
      expect(object(events(state.events).at(-1)).timedOut).toBe(true);
      const stopped = await readFile(heartbeat, 'utf8');
      await Bun.sleep(100);
      expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
      expect(await readFile(join(config.runDir, 'review-1.stdout'), 'utf8')).toContain(
        'actor started',
      );
    }
    const evidence = () =>
      Promise.all(paths.map((path) => readFile(join(config.runDir, path), 'utf8')));
    const before = await evidence();
    expect(t.execute('review').status).toBe(1);
    expect(await evidence()).toEqual(before);
    expect(await Bun.file(join(config.runDir, 'repair-1.prompt')).exists()).toBe(false);
    expect(await Bun.file(join(config.runDir, 'review-2.target.json')).exists()).toBe(false);
  });
}

test('check timeout is unavailable evidence and does not start a model', async () => {
  const t = await trial('check_timeout', { checkTimeMs: 100 });
  t.execute();
  const state = await t.state();
  expect(state.result).toBe('check_unavailable');
  expect([state.repair, state.review]).toEqual([0, 0]);
  expect(object(events(state.events)[0]).timedOut).toBe(true);
});

for (const role of ['check', 'repair'] as const) {
  test(`${role} startup failure retains the error and stops subsequent models`, async () => {
    const t = await trial('normal', { [role]: ['/nonexistent-correction-test-command'] });
    expect(t.execute().status).toBe(1);
    const state = await t.state();
    expect(state.result).toBe(role === 'check' ? 'check_unavailable' : 'repair_failed');
    expect([state.repair, state.review]).toEqual([role === 'check' ? 0 : 1, 0]);
    expect(state.active).toBeNull();
    const error = await readFile(join(t.config.runDir, `${role}-1.stderr`), 'utf8');
    expect(error).toContain('ENOENT');
  });
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, 'utf8');
      if (contents.trim()) {
        return contents;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await Bun.sleep(20);
  }
  throw Error(`Timed out waiting for ${path}`);
}

for (const [role, budget] of [
  ['check', 15000],
  ['repair', 15000],
  ['review', 15000],
  ['capture', 15000],
  ['check', null],
  ['capture', null],
] as const) {
  // Every role checks its reservation; the other signals exercise the shared handler once.
  for (const signal of role === 'repair'
    ? (['SIGINT', 'SIGTERM', 'SIGKILL'] as const)
    : (['SIGTERM'] as const)) {
    test(`${signal} during ${role} (${budget}) preserves reservation and blocks duplicate execution`, async () => {
      const t = await trial('normal', {
        checkTimeMs: 15000,
      });
      if (role === 'review') {
        await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
      }
      const { argv, heartbeat, pidFile } = await childWriter(t.root);
      await writeFile(
        t.configFile,
        JSON.stringify({ ...t.config, checkTimeMs: budget, [role]: argv }),
      );
      const child = spawn(process.execPath, [controller, t.configFile], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.setEncoding('utf8').on('data', (text) => {
        diagnostic += text;
      });
      const stateFile = join(t.config.runDir, 'state.json');
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
      let group: number | undefined;
      try {
        group = Number(
          await Promise.race([
            waitForFile(pidFile),
            closed.then((code) => {
              throw Error(`対象コマンド起動前にcontrollerが終了: code=${code}; ${diagnostic}`);
            }),
          ]),
        );
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
          const prefix = object(state.active).prefix;
          assert(typeof prefix === 'string');
          expect(await readFile(`${prefix}.stdout`, 'utf8')).toContain('actor started');
          expect(await readFile(`${prefix}.stderr`, 'utf8')).toContain('actor diagnostic');
        }
        const terminal = await readFile(stateFile, 'utf8');
        if (signal === 'SIGKILL') {
          expect(terminal).toBe(before);
        } else {
          expect(JSON.parse(terminal)).toEqual({ ...state, result: 'interrupted' });
        }
        const retry = t.execute();
        expect(retry.status).toBe(1);
        expect(retry.stderr).toContain(signal === 'SIGKILL' ? 'EEXIST' : 'Interrupted execution');
        expect(await readFile(stateFile, 'utf8')).toBe(terminal);
      } finally {
        child.kill('SIGKILL');
        if (group !== undefined && Number.isSafeInteger(group) && group > 1) {
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

test('successful check leaves no child writer after acceptance', async () => {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  const worker = join(t.root, 'successful-check.js');
  const groupFile = join(t.root, 'group');
  const childFile = join(t.root, 'child');
  // Wait for the child to record its PID so it is surely running at acceptance.
  await writeFile(
    worker,
    `import {spawn} from 'node:child_process'; import {existsSync, writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(groupFile)}, String(process.pid));
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('source.txt','late edit'),500);setInterval(()=>{},1000)`,
    )}], {stdio:'ignore'});
    child.unref();
    while (!existsSync(${JSON.stringify(childFile)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
  );
  await writeFile(t.configFile, JSON.stringify({ ...t.config, check: [process.execPath, worker] }));
  let group: number | undefined;
  try {
    const result = t.execute();
    group = Number(await readFile(groupFile, 'utf8'));
    expect({ status: result.status, state: await t.state(), stderr: result.stderr }).toMatchObject({
      status: 0,
      state: { result: 'ready_for_human_review' },
    });
    // SIGKILL is not awaited, so poll until the PID disappears.
    const child = Number(await readFile(childFile, 'utf8'));
    const deadline = Date.now() + 2000;
    while (alive(child)) {
      assert(Date.now() < deadline, `Late writer ${child} is still running after acceptance`);
      await Bun.sleep(20);
    }
    expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
  } finally {
    if (group) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
      }
    }
  }
});
