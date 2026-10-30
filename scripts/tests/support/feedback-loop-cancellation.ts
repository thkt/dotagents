import { expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord } from '../../shared/values.ts';
import { baseEnv } from './feedback-loop-batch.ts';
import type { Fixture } from './feedback-loop-batch.ts';

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert(isRecord(error) && error.code === 'ESRCH', String(error));
    return false;
  }
}

function terminate(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    assert(isRecord(error) && error.code === 'ESRCH', String(error));
  }
}

async function waitFor(condition: () => boolean, message: () => string) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    assert(Date.now() < deadline, message());
    await Bun.sleep(10);
  }
}

export async function cancelFeedbackCommand(f: Fixture, target: 'host' | 'runtime') {
  const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'));
  assert(isRecord(pkg) && isRecord(pkg.scripts));
  const script = pkg.scripts['test:affected'];
  assert(typeof script === 'string');
  const argv = script.split(' ');
  const trace = join(f.signals, 'cancel-trace.json');
  const result = join(f.signals, 'cancel-result.json');
  if (target === 'host') {
    const path = join(f.signals, 'cancel-host.ts');
    await writeFile(
      path,
      `
import { command, withInterrupts } from ${JSON.stringify(resolve(import.meta.dir, '../../shared/process.ts'))};
import { writeFileSync } from 'node:fs';
try {
  const result = await withInterrupts(() => command(${JSON.stringify(argv)}, ${JSON.stringify(f.repo)}, '', null));
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ result }));
} catch (error) {
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ error: String(error) }));
}
`,
    );
    argv.splice(0, argv.length, process.execPath, path);
  }
  const executable = argv.shift();
  assert(executable);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv(f),
    CANCEL_TRACE: trace,
    CANCEL_STARTED: join(f.signals, 'test-started'),
  };
  delete env.BUN_FEATURE_FLAG_NO_ORPHANS;
  const child = spawn(executable, argv, {
    cwd: f.repo,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  let code: number | null | undefined;
  let closed = false;
  const ended = new Promise<void>((done, fail) => {
    child.once('close', (status) => {
      code = status;
      closed = true;
      done();
    });
    child.once('error', fail);
  });
  const children = new Set<number>();
  try {
    await waitFor(
      () => existsSync(trace),
      () => `取消対象の処理へ到達しません: ${output}`,
    );
    const observed: unknown = JSON.parse(readFileSync(trace, 'utf8'));
    assert(
      isRecord(observed) &&
        typeof observed.child === 'number' &&
        typeof observed.parent === 'number',
    );
    children.add(observed.child);
    children.add(observed.parent);
    expect([...children].every(alive)).toBe(true);
    child.kill('SIGTERM');
    await waitFor(
      () => closed,
      () => `取消後も${target}がpipeを待っています: ${output}`,
    );
    if (target === 'host') {
      const outcome: unknown = JSON.parse(await readFile(result, 'utf8'));
      assert(isRecord(outcome));
      expect(outcome.error).toContain('Interrupted execution');
    } else {
      expect(code, output).not.toBe(0);
    }
    expect([...children].filter(alive), '取消後も起動した処理が残っています').toEqual([]);
  } finally {
    for (const pid of [...children, ...(child.pid === undefined ? [] : [child.pid])]) {
      terminate(-pid);
      terminate(pid);
    }
    await ended;
    await waitFor(
      () => [...children].every((pid) => !alive(pid)),
      () => 'テストの後始末で子プロセスが残りました',
    );
  }
}
