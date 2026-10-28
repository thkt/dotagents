import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  fixture,
  entry,
  baseEnv,
  recordFile,
  readRecordFile,
} from '../../support/runner-affected.ts';

const manifest: unknown = await Bun.file(
  new URL('../../../../package.json', import.meta.url),
).json();
assert(isRecord(manifest) && isRecord(manifest.scripts));
const affected = manifest.scripts['test:affected'];
assert(typeof affected === 'string');
const scripts: Record<string, string> = {
  'test:affected': affected.replace('scripts/test-runtime/runner.ts', entry),
};
// 互換名を残す場合にも固定集合の復活を検出する。廃止する判断は拘束しない。
if (typeof manifest.scripts['test:feedback'] === 'string') {
  scripts['test:feedback'] = manifest.scripts['test:feedback'].replace(
    'scripts/test-runtime/runner.ts',
    entry,
  );
}
const header = "import { test, expect } from 'bun:test';\n";
const files = {
  'package.json': JSON.stringify({ type: 'module', scripts }),
  'scripts/shared/target.ts': 'export const value = 1;\n',
  'scripts/tests/quality/a.test.ts':
    header +
    "test('a', async () => { console.log('QUALITY_A'); expect((await import('../../shared/target.ts')).value).toBeGreaterThan(0); });\n",
  'scripts/tests/quality/b.test.ts':
    header + "test('b', () => { console.log('QUALITY_B'); expect(1).toBe(1); });\n",
  'scripts/tests/assurance/guard.test.ts':
    header +
    "test('guard', async () => { console.log('ASSURANCE_GUARD'); expect((await import('../../shared/target.ts')).value).toBeGreaterThan(0); });\n",
};

function run(f: Parameters<typeof baseEnv>[0], args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 30000,
    env: baseEnv(f),
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, output: result.stdout + result.stderr };
}

for (const name of Object.keys(scripts)) {
  test(`${name}は初回全件と関連選択の双方で品質だけを候補にする`, async () => {
    await fixture(files, async (f) => {
      await writeFile(join(f.repo, 'scripts/shared/target.ts'), 'export const value = 2;\n');
      const first = run(f, ['run', name]);
      expect(first.code, first.output).toBe(0);
      expect(first.output).toContain('QUALITY_A');
      expect(first.output).toContain('QUALITY_B');
      expect(first.output).not.toContain('ASSURANCE_GUARD');
      expect(first.output).toMatch(/品質|quality/i);
      expect(first.output).toMatch(/候補[^\n]*2|2[^\n]*候補/);
      expect(first.output).toMatch(/全体\s*check\D{0,10}ではありません/);
      expect(Object.keys(readRecordFile(f.repo)).sort()).toEqual([
        join(f.repo, 'scripts/tests/quality/a.test.ts'),
        join(f.repo, 'scripts/tests/quality/b.test.ts'),
      ]);
      await writeFile(join(f.repo, 'scripts/shared/target.ts'), 'export const value = 3;\n');
      const second = run(f, ['run', name]);
      expect(second.code, second.output).toBe(0);
      expect(second.output).toContain('QUALITY_A');
      expect(second.output).not.toContain('QUALITY_B');
      expect(second.output).not.toContain('ASSURANCE_GUARD');
      expect(second.output).toMatch(/選[^\n]*1\s*件/);
      expect(second.output).toMatch(/候補[^\n]*2|2[^\n]*候補/);
    });
  }, 30000);
}

for (const condition of [
  'missing',
  'invalid',
  'unreadable',
  'fixed',
  'unknown',
  'assurance',
] as const) {
  test(`品質全件への復帰でも安心を自動選択しない: ${condition}`, async () => {
    await fixture(files, async (f) => {
      const record = recordFile(f.repo);
      if (condition !== 'missing') {
        await mkdir(dirname(record), { recursive: true });
        if (condition === 'unreadable') {
          await mkdir(record);
        } else {
          await writeFile(
            record,
            condition === 'invalid'
              ? '{broken'
              : JSON.stringify({
                  [join(f.repo, 'scripts/tests/quality/a.test.ts')]: [
                    join(f.repo, 'scripts/shared/target.ts'),
                  ],
                  [join(f.repo, 'scripts/tests/quality/b.test.ts')]: [],
                  [join(f.repo, 'scripts/tests/assurance/guard.test.ts')]: [
                    join(f.repo, 'scripts/shared/target.ts'),
                  ],
                }),
          );
        }
      }
      const changed = {
        fixed: 'tsconfig.json',
        unknown: 'guide.md',
        assurance: 'scripts/tests/assurance/guard.test.ts',
        missing: 'scripts/shared/target.ts',
        invalid: 'scripts/shared/target.ts',
        unreadable: 'scripts/shared/target.ts',
      }[condition];
      const changedBody = {
        fixed: '{}\n',
        unknown: 'changed\n',
        assurance: files['scripts/tests/assurance/guard.test.ts'] + '\n',
        missing: 'export const value = 2;\n',
        invalid: 'export const value = 2;\n',
        unreadable: 'export const value = 2;\n',
      }[condition];
      await writeFile(join(f.repo, changed), changedBody);
      // 読取り不能はディレクトリで再現し、権限やroot実行に依存しない。
      const result = run(f, ['run', 'test:affected']);
      if (condition !== 'unreadable') {
        expect(result.code, result.output).toBe(0);
      }
      expect(result.output).toContain('QUALITY_A');
      expect(result.output).toContain('QUALITY_B');
      expect(result.output).not.toContain('ASSURANCE_GUARD');
      expect(result.output).toMatch(/品質|quality/i);
      const reason = {
        missing: /記録.*(?:なし|ない|ありません|初回)|初回|reason.*record/i,
        invalid: /警告|不正|形式|記録.*(?:読|壊|invalid)/i,
        unreadable: /警告|読.*(?:ない|不能)|EISDIR/,
        fixed: /tsconfig\.json|固定/,
        unknown: /guide\.md|影響.*(?:不明|見つから)/,
        assurance: /guard\.test\.ts|影響.*(?:不明|見つから)/,
      }[condition];
      expect(result.output).toMatch(reason);
      expect(result.output).toMatch(/Ran 2 tests across 2 files/);
      expect(result.output).toMatch(/全体\s*check\D{0,10}ではありません/);
    });
  }, 30000);
}

test('安心の直接実行と全件実行は両分類に届き、記録なし経路は依存記録を更新しない', async () => {
  await fixture(files, async (f) => {
    await writeFile(join(f.repo, 'scripts/shared/target.ts'), 'export const value = 2;\n');
    const recorded = run(f, [
      entry,
      'bun',
      'scripts/tests/quality',
      'scripts/tests/assurance',
      '--affected',
    ]);
    expect(recorded.code, recorded.output).toBe(0);
    expect(recorded.output).toMatch(/Ran 3 tests across 3 files/);
    const before = readFileSync(recordFile(f.repo), 'utf8');
    const direct = run(f, [entry, 'bun', 'scripts/tests/assurance/guard.test.ts']);
    expect(direct.code, direct.output).toBe(0);
    expect(direct.output).toContain('ASSURANCE_GUARD');
    expect(direct.output).not.toContain('QUALITY_A');
    const all = run(f, [entry, 'bun']);
    expect(all.code, all.output).toBe(0);
    expect(all.output).toMatch(/Ran 3 tests across 3 files/);
    for (const marker of ['QUALITY_A', 'QUALITY_B', 'ASSURANCE_GUARD']) {
      expect(all.output).toContain(marker);
    }
    expect(await readFile(recordFile(f.repo), 'utf8')).toBe(before);
    await writeFile(
      join(f.repo, 'scripts/tests/assurance/guard.test.ts'),
      header + "test('fails', () => { expect(1).toBe(2); });\n",
    );
    await writeFile(join(f.repo, 'tsconfig.json'), '{}\n');
    for (const args of [[], ['--affected']]) {
      const failed = run(f, [entry, 'bun', ...args]);
      expect(failed.code, failed.output).toBe(1);
      expect(failed.output).toMatch(/Ran 3 tests across 3 files/);
      expect(failed.output).toContain('1 fail');
    }
  });
}, 30000);

for (const dependency of ['fs', 'branch', 'isolated-child'] as const) {
  test(`一部だけ依存が記録された変更は全件へ戻る保証がない: ${dependency}`, async () => {
    const body =
      dependency === 'fs'
        ? "import { readFileSync } from 'node:fs';\ntest('reader', () => { expect(readFileSync(['scripts', 'shared', 'target.ts'].join('/'), 'utf8')).toContain('value = 1'); });\n"
        : dependency === 'branch'
          ? "test('branch', async () => { if (process.env.CHECK_BRANCH) expect((await import(['..', '..', 'shared', 'target.ts'].join('/'))).value).toBe(1); });\n"
          : "import { spawnSync } from 'node:child_process';\ntest('child', () => { const child = spawnSync(process.execPath, ['scripts/reader.ts'], { env: {}, encoding: 'utf8' }); expect(child.status).toBe(0); expect(child.stdout.trim()).toBe('1'); });\n";
    await fixture(
      {
        ...files,
        'scripts/tests/quality/b.test.ts': header + body,
        'scripts/reader.ts': "import { value } from './shared/target.ts'; console.log(value);\n",
      },
      async (f) => {
        await writeFile(
          join(f.repo, 'scripts/shared/target.ts'),
          'export const value = 1; // first\n',
        );
        const first = run(f, [entry, 'bun', 'scripts/tests/quality', '--affected']);
        expect(first.code, first.output).toBe(0);
        const records = readRecordFile(f.repo);
        expect(records[join(f.repo, 'scripts/tests/quality/a.test.ts')]).toContain(
          join(f.repo, 'scripts/shared/target.ts'),
        );
        expect(records[join(f.repo, 'scripts/tests/quality/b.test.ts')]).not.toContain(
          join(f.repo, 'scripts/shared/target.ts'),
        );
        // 初回の未commit変更を解消し、次は共有モジュールだけを変える。
        const git = spawnSync(
          'git',
          [
            '-c',
            'user.name=test',
            '-c',
            'user.email=test@example.com',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-am',
            'recorded input',
          ],
          { cwd: f.repo, encoding: 'utf8' },
        );
        expect(git.status, git.stderr).toBe(0);
        await writeFile(join(f.repo, 'scripts/shared/target.ts'), 'export const value = 2;\n');
        const partial = run(f, [entry, 'bun', 'scripts/tests/quality', '--affected']);
        expect(partial.code, partial.output).toBe(0);
        expect(partial.output).toMatch(/Ran 1 test across 1 file/);
        // 直接実行は漏れた分岐・fs読取り・環境分離した子Bunへ届き、同じ変更を検出する。
        const direct = spawnSync(
          process.execPath,
          [entry, 'bun', 'scripts/tests/quality/b.test.ts'],
          {
            cwd: f.repo,
            encoding: 'utf8',
            timeout: 30000,
            env: { ...baseEnv(f), CHECK_BRANCH: '1' },
          },
        );
        expect(direct.error).toBeUndefined();
        expect(direct.status, direct.stdout + direct.stderr).toBe(1);
        expect(direct.stdout + direct.stderr).toContain('1 fail');
      },
    );
  }, 30000);
}
