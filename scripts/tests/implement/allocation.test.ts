import assert from 'node:assert/strict';
import { isRecord } from '../../shared/values.ts';
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function isAllocator(
  value: unknown,
): value is (repo: string, common: string, dir: string) => Promise<string> {
  return typeof value === 'function';
}

test('開始準備はcheckoutとGit領域内のディレクトリを作成前に拒否する', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'allocate-')));
  try {
    const entry = resolve(import.meta.dir, '../../implement/orchestrator.ts');
    const source = await readFile(entry, 'utf8');
    // 外部操作を伴うフローから隔離し、実際の割当処理とファイルシステムを使う。
    const isolated = source.replace(
      /from (['"])(\.[^'"]+)\1/g,
      (_match, _quote, path: string) => `from ${JSON.stringify(resolve(dirname(entry), path))}`,
    );
    const moduleFile = join(root, 'orchestrator.ts');
    await writeFile(moduleFile, `${isolated}\nexport { allocateDirectory };\n`);
    const isolatedModule: unknown = await import(moduleFile);
    assert(isRecord(isolatedModule));
    const { allocateDirectory } = isolatedModule;
    assert(isAllocator(allocateDirectory));
    const repo = join(root, 'checkout');
    const common = join(root, 'git');
    await mkdir(repo);
    await mkdir(common);
    const safe = join(root, 'safe', 'run');
    expect(await allocateDirectory(repo, common, safe)).toBe(safe);
    expect(existsSync(safe)).toBe(true);
    for (const storage of [repo, common]) {
      const parent = join(storage, 'new-parent');
      await assert.rejects(
        () => allocateDirectory(repo, common, join(parent, 'run')),
        /Run directory/,
      );
      expect(existsSync(parent)).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
