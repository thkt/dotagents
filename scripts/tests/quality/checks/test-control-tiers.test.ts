import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';

const entry = resolve(import.meta.dir, '../../../test-runtime/runner.ts');
const header = "import { test } from 'bun:test';\n";
const quality = 'scripts/tests/quality/a.test.ts';
const assurance = 'scripts/tests/assurance/guard.test.ts';

async function withTiers(run: (cwd: string) => Promise<void>) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'test-control-tiers-')));
  try {
    const manifest: unknown = JSON.parse(
      await readFile(resolve(import.meta.dir, '../../../../package.json'), 'utf8'),
    );
    assert(isRecord(manifest) && isRecord(manifest.scripts));
    const script = manifest.scripts['test:control'];
    assert(typeof script === 'string');
    const files = {
      'package.json': JSON.stringify({
        scripts: { 'test:control': script.replace('scripts/test-runtime/runner.ts', entry) },
      }),
      [quality]: `${header}test('quality', () => console.log('QUALITY_RAN'));\n`,
      [assurance]: `${header}test('guard', () => console.log('ASSURANCE_RAN'));\n`,
    };
    for (const [path, body] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), body);
    }
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function control(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['run', 'test:control', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, TMPDIR: cwd },
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: result.stdout + result.stderr };
}

test('test:controlの引数なしはqualityとassuranceの両方を実行する', async () => {
  await withTiers(async (cwd) => {
    const result = control(cwd);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('QUALITY_RAN');
    expect(result.output).toContain('ASSURANCE_RAN');
    expect(result.output).toMatch(/Ran 2 tests across 2 files/);
  });
});

test('test:controlのパス指定は指定したassuranceだけを実行する', async () => {
  await withTiers(async (cwd) => {
    const result = control(cwd, assurance);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('ASSURANCE_RAN');
    expect(result.output).not.toContain('QUALITY_RAN');
  });
});

test('test:controlの全件実行はassuranceの失敗を非ゼロ終了で返す', async () => {
  await withTiers(async (cwd) => {
    await writeFile(
      join(cwd, assurance),
      `${header}test('fails', () => { throw new Error('ASSURANCE_FAILED'); });\n`,
    );
    const result = control(cwd);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('1 fail');
    expect(result.output).toMatch(/Ran 2 tests across 2 files/);
  });
});

test('runnerは廃止した選択引数を成功として扱わない', async () => {
  await withTiers(async (cwd) => {
    for (const argument of ['--affected', '--affected=main']) {
      const result = control(cwd, argument);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('Unsupported argument');
      expect(result.output).not.toContain('QUALITY_RAN');
    }
  });
});
