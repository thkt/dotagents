import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  fixture,
  baseEnv,
  entry,
  git,
  header,
  recordFile,
  runAffected,
} from '../../support/runner-affected.ts';

// Issue #466 要求3と公開呼出し仕様の「導入後の呼出しと完了条件」に照合。
// 前回資産の期待値を維持し、現在の出力へ合わせて緩めない。
test('採用コードと依存構造が変わった記録で、変更入力を読むテストを落とさない', async () => {
  await fixture(
    {
      'scripts/tests/old.ts': 'export const value = 1;\n',
      'scripts/tests/input.ts': 'export const value = 1;\n',
      'scripts/tests/route.ts': "export { value } from './old.ts';\n",
      'scripts/tests/a.test.ts':
        header +
        "import { value } from './route.ts';\ntest('bounded', () => { console.log('A_RAN'); expect(value).toBeLessThan(3); });\n",
      'scripts/tests/b.test.ts':
        header +
        "import { value } from './input.ts';\ntest('positive', () => { console.log('B_RAN'); expect(value).toBeGreaterThan(0); });\n",
    },
    async (f) => {
      // 正常な全件実行で実際の依存記録を作る。記録の形式は固定しない。
      await writeFile(join(f.repo, 'scripts/tests/old.ts'), 'export const value = 2;\n');
      const first = runAffected(f);
      expect(first.code, first.output).toBe(0);
      expect(first.output).toContain('A_RAN');
      expect(first.output).toContain('B_RAN');
      git(f.repo, 'add', '-A');
      git(f.repo, 'commit', '-m', '正常な記録の基点');

      // 同じ依存構造の正常対照。Bが入力を読み、Aは別の入力を読む。
      await writeFile(join(f.repo, 'scripts/tests/input.ts'), 'export const value = 2;\n');
      const control = runAffected(f);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('B_RAN');
      git(f.repo, 'add', '-A');
      git(f.repo, 'commit', '-m', '正常な入力');

      // 採用コードを進めるが、記録の再生成はしない。
      // 次の差分はinput.tsだけになる。古い記録ではBだけに到達する。
      await writeFile(
        join(f.repo, 'scripts/tests/route.ts'),
        "export { value } from './input.ts';\n",
      );
      git(f.repo, 'add', '-A');
      git(f.repo, 'commit', '-m', '依存構造を変更');
      await writeFile(join(f.repo, 'scripts/tests/input.ts'), 'export const value = 3;\n');
      const direct = spawnSync(process.execPath, [entry, 'bun', 'scripts/tests/a.test.ts'], {
        cwd: f.repo,
        encoding: 'utf8',
        timeout: 30000,
        env: baseEnv(f),
      });
      const directOutput = direct.stdout + direct.stderr;
      expect(direct.error).toBeUndefined();
      expect(direct.signal).toBeNull();
      expect(direct.status, directOutput).toBe(1);
      expect(directOutput).toContain('A_RAN');
      expect(directOutput).toContain('1 fail');
      const stale = runAffected(f);
      expect(stale.output).toContain('B_RAN');
      expect(stale.output).toContain('A_RAN');
      expect(stale.output).toContain('1 fail');
      expect(stale.code, stale.output).toBe(1);
    },
  );
}, 60000);

test('未commitの依存構造で取得した記録を、コード復元後の部分選択に流用しない', async () => {
  await fixture(
    {
      'scripts/tests/old.ts': 'export const value = 1;\n',
      'scripts/tests/input.ts': 'export const value = 1;\n',
      'scripts/tests/route.ts': "export { value } from './input.ts';\n",
      'scripts/tests/a.test.ts':
        header +
        "import { value } from './route.ts'; test('bounded', () => { console.log('A_RAN'); expect(value).toBeLessThan(3); });\n",
      'scripts/tests/b.test.ts':
        header +
        "import { value } from './input.ts'; test('positive', () => { console.log('B_RAN'); expect(value).toBeGreaterThan(0); });\n",
    },
    async (f) => {
      const head = git(f.repo, 'rev-parse', 'HEAD');
      const route = join(f.repo, 'scripts/tests/route.ts');
      const input = join(f.repo, 'scripts/tests/input.ts');
      await writeFile(route, "export { value } from './old.ts';\n");
      const recorded = runAffected(f);
      expect(recorded.code, recorded.output).toBe(0);
      expect(recorded.output).toContain('A_RAN');
      expect(recorded.output).toContain('B_RAN');

      // HEADは同じで、記録時だけ存在した依存構造の差分も消える。
      await writeFile(route, "export { value } from './input.ts';\n");
      await writeFile(input, 'export const value = 2;\n');
      const control = spawnSync(process.execPath, [entry, 'bun', 'scripts/tests/a.test.ts'], {
        cwd: f.repo,
        encoding: 'utf8',
        timeout: 30000,
        env: baseEnv(f),
      });
      expect(control.error).toBeUndefined();
      expect(control.signal).toBeNull();
      expect(control.status, control.stdout + control.stderr).toBe(0);
      expect(control.stdout + control.stderr).toContain('A_RAN');

      await writeFile(input, 'export const value = 3;\n');
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(f.repo, 'diff', '--name-only')).toBe('scripts/tests/input.ts');
      const direct = spawnSync(process.execPath, [entry, 'bun', 'scripts/tests/a.test.ts'], {
        cwd: f.repo,
        encoding: 'utf8',
        timeout: 30000,
        env: baseEnv(f),
      });
      expect(direct.error).toBeUndefined();
      expect(direct.signal).toBeNull();
      expect(direct.status, direct.stdout + direct.stderr).toBe(1);
      expect(direct.stdout + direct.stderr).toContain('1 fail');
      const restored = runAffected(f);
      expect(restored.output).toContain('B_RAN');
      expect(restored.output).toContain('A_RAN');
      expect(restored.output).toContain('1 fail');
      expect(restored.code, restored.output).toBe(1);
    },
  );
}, 60000);

test('失敗した関連実行の後も、直前の成功した依存原記録を保持する', async () => {
  await fixture(
    {
      'scripts/tests/input.ts': 'export const value = 1;\n',
      'scripts/tests/a.test.ts':
        header +
        "import { value } from './input.ts';\ntest('positive', () => { console.log('A_RAN'); expect(value).toBeGreaterThan(0); });\n",
      'scripts/tests/b.test.ts':
        header +
        "import { value } from './input.ts';\ntest('bounded', () => { console.log('B_RAN'); expect(value).toBeLessThan(3); });\n",
    },
    async (f) => {
      await writeFile(join(f.repo, 'scripts/tests/input.ts'), 'export const value = 2;\n');
      const control = runAffected(f);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('A_RAN');
      expect(control.output).toContain('B_RAN');
      const original = await readFile(recordFile(f.repo), 'utf8');

      await writeFile(join(f.repo, 'scripts/tests/input.ts'), 'export const value = 3;\n');
      const failed = runAffected(f);
      expect(failed.output).toContain('A_RAN');
      expect(failed.output).toContain('B_RAN');
      expect(failed.output).toContain('1 fail');
      expect(failed.code, failed.output).toBe(1);

      // 利用中の記録を無効化する方式と退避する方式の両方を許す。
      // 退避名・新形式は固定せず、worktree固有の保存先で原文を照合する。
      const directory = dirname(recordFile(f.repo));
      const entries = await readdir(directory, { recursive: true, withFileTypes: true });
      const bodies = await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
      );
      expect(bodies, '失敗前の成功した原記録が保存先から失われています').toContain(original);
    },
  );
}, 60000);
