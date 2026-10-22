import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../../scripts/shared/values.ts';

const source = resolve(import.meta.dir, '../..');
const manifests = ['trusted-inputs.json', 'light-common-inputs.json'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'trusted-integrity-'));
  for (const path of [
    'eval/tests/trusted-inputs.ts',
    'scripts/shared/values.ts',
    'scripts/tests/support/target.ts',
    ...manifests.map((file) => `eval/tests/fixtures/${file}`),
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(source, path), join(root, path));
  }
  return root;
}

async function probe(root: string, file?: string, replacement?: unknown, gitPath?: string) {
  // 同じmoduleで正常準備を完了してから別repoを検査し、成功cacheの流用も検出する。
  const entry = join(root, 'probe.ts');
  await writeFile(
    entry,
    `import { lightInputRepository } from './eval/tests/trusted-inputs.ts';
import { writeFile } from 'node:fs/promises';
await lightInputRepository(${JSON.stringify(join(root, 'normal'))});
console.log('NORMAL_COMPLETE');
${file ? `await writeFile(${JSON.stringify(join(root, 'eval/tests/fixtures', file))}, ${JSON.stringify(JSON.stringify(replacement))});` : ''}
await lightInputRepository(${JSON.stringify(join(root, 'next'))});
console.log('NEXT_COMPLETE');
`,
  );
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, PATH: gitPath ?? process.env.PATH },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stdout).toContain('NORMAL_COMPLETE');
  return result;
}

test('固定された両packを別repoにも省略せず展開できる', async () => {
  const root = await fixture();
  try {
    const result = await probe(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('NEXT_COMPLETE');
    for (const repo of ['normal', 'next']) {
      const result = spawnSync(
        'git',
        ['cat-file', '-t', '0c7316253a9768844eb1c224961e00be52dcdcf2'],
        {
          cwd: join(root, repo),
          encoding: 'utf8',
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('commit');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

for (const file of manifests) {
  for (const field of ['mode', 'gitBlob', 'sha256', 'absent', 'pack'] as const) {
    test(`${file}: 正常準備の後も${field}の違反を個別に拒否する`, async () => {
      const root = await fixture();
      try {
        const value: unknown = JSON.parse(
          await readFile(join(root, 'eval/tests/fixtures', file), 'utf8'),
        );
        assert(isRecord(value) && Array.isArray(value.entries));
        // 後方のentryを選び、先頭だけを検査する誤りも区別する。
        const present: unknown = value.entries.findLast(
          (entry: unknown) => isRecord(entry) && entry.absent !== true,
        );
        assert(isRecord(present) && typeof present.path === 'string');
        let diagnostic: string;
        if (field === 'pack') {
          assert(typeof value.packBase64 === 'string' && typeof value.packSha256 === 'string');
          const pack = Buffer.from(value.packBase64, 'base64');
          pack[0] = 0;
          value.packBase64 = pack.toString('base64');
          diagnostic = value.packSha256;
        } else if (field === 'absent') {
          // 実pack中に存在するpathを不存在として宣言する。他の照合値は変えない。
          value.entries.push({ commit: present.commit, path: present.path, absent: true });
          diagnostic = present.path;
        } else {
          diagnostic = field === 'mode' ? '100755' : '0'.repeat(field === 'gitBlob' ? 40 : 64);
          present[field] = diagnostic;
        }
        const result = await probe(root, file, value);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout).not.toContain('NEXT_COMPLETE');
        expect(result.stderr).toContain('AssertionError');
        expect(result.stderr).toContain(diagnostic);
        expect(result.stderr).not.toMatch(/Cannot find|SyntaxError|ENOENT|index-pack.*failed/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
  }
}

for (const [index, file] of manifests.entries()) {
  test(`${file}: 同じmanifestでも別repoのobjectを毎回確認する`, async () => {
    const root = await fixture();
    try {
      const realGit = Bun.which('git');
      assert(realGit);
      const bin = join(root, 'bin');
      await mkdir(bin);
      // 次のrepoで選んだpackだけを展開直後に除き、前回の照合成功の流用を区別する。
      await writeFile(
        join(bin, 'git'),
        `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'pipe'] });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status === 0 && process.cwd().endsWith('/next') && process.argv[2] === 'index-pack') {
  const counter = join(process.cwd(), 'pack-count');
  const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(count + 1));
  if (count === ${index}) {
    const id = result.stdout.toString().trim().split(/\\s+/).at(-1);
    for (const extension of ['pack', 'idx']) {
      rmSync(join(process.cwd(), '.git/objects/pack', 'pack-' + id + '.' + extension));
    }
  }
}
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      const result = await probe(root, undefined, undefined, `${bin}:${process.env.PATH ?? ''}`);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).not.toContain('NEXT_COMPLETE');
      expect(result.stderr).toContain('AssertionError');
      expect(result.stderr).toContain('not a tree object');
      expect(result.stderr).not.toMatch(/Cannot find|SyntaxError|ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
}
