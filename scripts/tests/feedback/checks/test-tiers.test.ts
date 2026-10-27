import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const tiers = ['feedback', 'quality', 'assurance'];
// Bunが既定で探すテストファイル名。階層外に置かれてもtest:controlでは実行されるため、すべてを対象にする。
const testFile = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

async function untieredTests(root: string) {
  const files = (await readdir(root, { recursive: true }))
    .map((path) => path.split('\\').join('/'))
    .filter((path) => testFile.test(path));
  return {
    files,
    untiered: files.filter((path) => !tiers.includes(path.split('/')[0] ?? '')).sort(),
  };
}

async function tree(paths: string[], run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'test-tiers-'));
  try {
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), '');
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tiered = [
  'feedback/checks/runner.test.ts',
  'quality/implement/development.test.ts',
  'assurance/shared/process-cleanup.test.ts',
  'runner.ts',
  'support/development.ts',
  'fixtures/human-decision-recovery/public-contract.json',
];

test('3階層のいずれかに置いたテストと、階層外の補助ファイルは分類漏れにしない', async () => {
  await tree(tiered, async (root) => {
    const result = await untieredTests(root);
    expect(result.files).toHaveLength(3);
    expect(result.untiered).toEqual([]);
  });
});

for (const misplaced of [
  'root.test.ts',
  'implement/development.test.ts',
  'support/helper.test.ts',
  'fast/checks/runner.test.ts',
  'feedback-extra/runner.test.ts',
  'implement/legacy.spec.js',
]) {
  test(`階層外・未知の階層のテストは分類漏れとして拒否する: ${misplaced}`, async () => {
    await tree([...tiered, misplaced], async (root) => {
      expect((await untieredTests(root)).untiered).toEqual([misplaced]);
    });
  });
}

test('scripts/testsのテストファイルはすべていずれか1つの階層に置かれている', async () => {
  const result = await untieredTests(resolve(import.meta.dir, '../..'));
  expect(result.files).toContain('feedback/checks/test-tiers.test.ts');
  expect(result.untiered).toEqual([]);
});
