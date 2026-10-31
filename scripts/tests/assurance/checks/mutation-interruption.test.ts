import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withoutAutoMaintenance } from '../../../test-runtime/runner.ts';

const cli = resolve(import.meta.dir, '../../../test-runtime/mutation/cli.ts');

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd, encoding: 'utf8', env: withoutAutoMaintenance(process.env) },
  );
  assert.equal(result.status, 0, result.stderr);
}

async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert(Date.now() < deadline, 'condition not reached');
    await Bun.sleep(50);
  }
}

test('実行中にSIGTERMを受けると子プロセスを止めて一時コピーを消す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-signal-'));
  try {
    const repo = join(root, 'repo');
    const temp = join(root, 'tmp');
    const probe = join(root, 'probe');
    await mkdir(repo);
    await mkdir(temp);
    await mkdir(probe);
    git(repo, 'init', '-q');
    // 基準の品質テストが開始を記録してから待ち、止められなければ終了も記録する。
    await write(repo, {
      'package.json': JSON.stringify({ type: 'module' }),
      'scripts/tests/quality/wait.test.ts': [
        "import { test } from 'bun:test';",
        "import { writeFileSync } from 'node:fs';",
        "test('wait', async () => {",
        '  writeFileSync(`${process.env.MUTATION_PROBE}/started`, String(process.pid));',
        '  await Bun.sleep(2000);',
        "  writeFileSync(`${process.env.MUTATION_PROBE}/finished`, '');",
        '}, 10000);',
        '',
      ].join('\n'),
    });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const child = spawn(process.execPath, [cli, '--base', 'HEAD'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...withoutAutoMaintenance(process.env), TMPDIR: temp, MUTATION_PROBE: probe },
    });
    let diagnostic = '';
    child.stdout.on('data', (data: Buffer) => {
      diagnostic += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      diagnostic += data.toString();
    });
    let ended = false;
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => {
        ended = true;
        resolve(code);
      }),
    );
    await until(() => existsSync(join(probe, 'started')) || ended, 15000);
    expect(existsSync(join(probe, 'started')), diagnostic).toBe(true);
    expect((await readdir(temp)).filter((name) => name.startsWith('mutate-diff-'))).toHaveLength(1);
    child.kill('SIGTERM');
    expect(await exited).not.toBe(0);
    // 待機中のテストprocessが終わったことを確かめてから、終了記録の不在を見る。
    const waiting = Number(await readFile(join(probe, 'started'), 'utf8'));
    await until(() => !alive(waiting), 5000);
    expect(existsSync(join(probe, 'finished'))).toBe(false);
    expect((await readdir(temp)).filter((name) => name.startsWith('mutate-diff-'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
