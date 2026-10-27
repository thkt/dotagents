import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';

const entry = resolve(import.meta.dir, '../../runner.ts');

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'runner-selection-'));
  try {
    await mkdir(join(cwd, 'selected'));
    await mkdir(join(cwd, 'reports'));
    await writeFile(
      join(cwd, 'observe-report.js'),
      `
import { mock } from 'bun:test';
import * as filesystem from 'node:fs/promises';
const fs = { ...filesystem };
mock.module('node:fs/promises', () => ({ ...fs, async readFile(path, encoding) {
  const text = await fs.readFile(path, encoding);
  if (String(path).endsWith('results.xml')) await fs.writeFile('observed.xml', text);
  return text;
} }));`,
    );
    await writeProbe(cwd, 'first', "test('first', () => console.log('FIRST_COMPLETED'));");
    await writeProbe(cwd, 'second', "test('second', () => console.log('SECOND_COMPLETED'));");
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeProbe(cwd: string, name: string, body: string) {
  await writeFile(
    join(cwd, 'selected', `${name}.test.js`),
    `import { test, expect } from 'bun:test';\n${body}`,
  );
}

function run(cwd: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--preload', join(cwd, 'observe-report.js'), entry, 'bun', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CI: 'false', TMPDIR: join(cwd, 'reports') },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, output: result.stdout + result.stderr };
}

const paths = ['selected/first.test.js', 'selected/second.test.js'];

for (const selection of ['default', 'selected', 'serial'] as const) {
  test(`test:controlの接続は既定2workerと対象選択を保つ: ${selection}`, async () => {
    await fixture(async (cwd) => {
      const manifest: unknown = JSON.parse(
        await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
      );
      assert(isRecord(manifest) && isRecord(manifest.scripts));
      const script = manifest.scripts['test:control'];
      assert(typeof script === 'string');
      await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({
          scripts: {
            'test:control': script.replace('scripts/tests/runner.ts', entry),
          },
        }),
      );
      await mkdir(join(cwd, 'scripts/tests'), { recursive: true });
      await writeFile(
        join(cwd, 'scripts/tests/default.test.js'),
        "import { test } from 'bun:test'; test('default', () => console.log('DEFAULT_COMPLETED'));",
      );
      const args = selection === 'default' ? [] : [...paths];
      if (selection === 'serial') {
        args.push('--parallel=1');
      }
      const result = spawnSync(process.execPath, ['run', 'test:control', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, TMPDIR: join(cwd, 'reports') },
      });
      const output = result.stdout + result.stderr;
      expect(result.error).toBeUndefined();
      expect(result.status, output).toBe(0);
      expect(output.includes('2x PARALLEL')).toBe(selection !== 'serial');
      expect(output.includes('DEFAULT_COMPLETED')).toBe(selection === 'default');
      expect(output.includes('FIRST_COMPLETED')).toBe(selection !== 'default');
      expect(output.includes('SECOND_COMPLETED')).toBe(selection !== 'default');
      expect(output).toMatch(
        selection === 'default' ? /Ran 1 test across 1 file/ : /Ran 2 tests across 2 files/,
      );
      expect(output).toContain('All tests executed.');
    });
  });
}

test('複数パスは指定順を変えても全ファイルを一度ずつ実行し、無関係なファイルを選ばない', async () => {
  await fixture(async (cwd) => {
    await writeProbe(cwd, 'unselected', "throw new Error('UNSELECTED_FILE');");
    for (const selected of [paths, [...paths].reverse()]) {
      const result = run(cwd, selected);
      expect(result.code, result.output).toBe(0);
      expect(result.output.match(/FIRST_COMPLETED/g)).toHaveLength(1);
      expect(result.output.match(/SECOND_COMPLETED/g)).toHaveLength(1);
      expect(result.output).toMatch(/Ran 2 tests across 2 files/);
      expect(result.output).not.toContain('UNSELECTED_FILE');
      expect(result.output).toContain('All tests executed.');
    }
  });
});

for (const parallel of [false, true]) {
  for (const scenario of ['normal', 'failure', 'skip', 'only', 'crash'] as const) {
    test(`後続ファイルと集計: ${parallel ? 'parallel' : 'serial'} ${scenario}`, async () => {
      await fixture(async (cwd) => {
        const bodies = {
          normal: "test('second', () => { console.log('SECOND_COMPLETED'); expect(2).toBe(2); });",
          failure: "test('second failure', () => { expect('SECOND_FAILURE').toBe('SUCCESS'); });",
          skip: "test.skip('second skipped', () => {});",
          only: "test.only('second only', () => {});",
          crash:
            "test('second crash', () => { console.error('SECOND_CRASH'); process.kill(process.pid, 'SIGKILL'); });",
        };
        await writeProbe(cwd, 'second', bodies[scenario]);
        const result = run(cwd, [...paths, ...(parallel ? ['--parallel=2'] : [])]);
        expect(result.code, result.output).toBe(scenario === 'normal' ? 0 : 1);
        expect(result.output.includes('All tests executed.')).toBe(scenario === 'normal');
        if (scenario === 'normal') {
          expect(result.output).toContain('FIRST_COMPLETED');
          expect(result.output).toContain('SECOND_COMPLETED');
          expect(result.output).toMatch(/Ran 2 tests across 2 files/);
          const xml = await readFile(join(cwd, 'observed.xml'), 'utf8');
          expect(xml).toMatch(/<testsuites\b[^>]*tests="2"/);
          expect(xml.match(/<testcase\b/g)).toHaveLength(2);
          expect(xml).toContain('first.test.js');
          expect(xml).toContain('second.test.js');
        } else {
          const diagnostic = {
            failure: /SECOND_FAILURE/,
            skip: /Unexecuted tests/,
            only: /\.only/,
            crash: /SECOND_CRASH/,
          }[scenario];
          expect(result.output).toMatch(diagnostic);
        }
      });
    });
  }
}

for (const argument of ['--unknown-runner-option', '--parallel=0', '--parallel=invalid']) {
  test(`不正引数を無視して成功にしない: ${argument}`, async () => {
    await fixture(async (cwd) => {
      const result = run(cwd, [paths[0] ?? '', argument]);
      expect(result.code, result.output).toBe(1);
      expect(result.output).not.toContain('All tests executed.');
      expect(result.output).toMatch(/argument|option|parallel|Usage|引数/i);
    });
  });
}

test('存在しない後続パスを無視して成功にしない', async () => {
  await fixture(async (cwd) => {
    const result = run(cwd, [paths[0] ?? '', 'selected/missing.test.js']);
    expect(result.code, result.output).toBe(1);
    expect(result.output).not.toContain('All tests executed.');
    expect(result.output).toContain('missing.test.js');
  });
});

test('並列の対象0件は成功にならない', async () => {
  await fixture(async (cwd) => {
    await mkdir(join(cwd, 'empty'));
    const result = run(cwd, ['empty', '--parallel=2']);
    expect(result.code, result.output).toBe(1);
    expect(result.output).not.toContain('All tests executed.');
    expect(result.output).not.toContain('FIRST_COMPLETED');
  });
});

test('並列workerは別プロセスで同時に到達し、全ファイルの完了を待つ', async () => {
  await fixture(async (cwd) => {
    for (const [name, peer] of [
      ['first', 'second'],
      ['second', 'first'],
    ]) {
      await writeProbe(
        cwd,
        name ?? '',
        `
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
test('${name} barrier', async () => {
  writeFileSync('${name}.ready', String(process.pid));
  const deadline = Date.now() + 3000;
  while (!existsSync('${peer}.ready')) {
    if (Date.now() > deadline) throw new Error('PEER_NOT_STARTED');
    await Bun.sleep(10);
  }
  expect(Number(readFileSync('${peer}.ready', 'utf8'))).not.toBe(process.pid);
  writeFileSync('${name}.done', 'completed');
});`,
      );
    }
    const result = run(cwd, [...paths, '--parallel=2']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Ran 2 tests across 2 files/);
    for (const name of ['first', 'second']) {
      expect(await readFile(join(cwd, `${name}.done`), 'utf8')).toBe('completed');
    }
  });
}, 20000);

test('時間記録は選択した両ファイルの完了に対応し、未選択ファイルを含めない', async () => {
  await fixture(async (cwd) => {
    await writeProbe(cwd, 'unselected', "throw new Error('UNSELECTED_FILE');");
    const timings = join(cwd, 'timings.json');
    const result = run(cwd, [...paths, '--parallel=2', `--timings=${timings}`, '--update-timings']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('FIRST_COMPLETED');
    expect(result.output).toContain('SECOND_COMPLETED');
    const text = await readFile(timings, 'utf8');
    const report: unknown = JSON.parse(text);
    assert(isRecord(report) && isRecord(report.files));
    expect(Object.keys(report.files).sort()).toEqual(paths);
    for (const duration of Object.values(report.files)) {
      assert(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0);
    }
  });
});

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
