import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';

const entry = resolve(import.meta.dir, '../../../lint/feedback-loop-bundle.ts');
const fakeFullCommit = 'a'.repeat(40);
const bundled = {
  'scripts/setup.mjs': 'console.log("setup");\n',
  'references/contract.md': '# 仕様\n',
};

const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.excludesFile=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
}

// 検査対象のrepoを一時ディレクトリに作り、同梱とupstream.jsonが一致した状態から始める。
async function withRepo(run: (root: string, skill: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-loop-bundle-')));
  const skill = join(root, 'skills/setup-feedback-loop');
  try {
    await writeFiles(skill, {
      ...bundled,
      'SKILL.md': '# 私用版の手順\n',
      'upstream.json': JSON.stringify({
        repository: 'thkt/feedback-loop',
        directory: 'dist/private',
        commit: fakeFullCommit,
        files: Object.fromEntries(
          Object.entries(bundled).map(([path, body]) => [path, sha256(body)]),
        ),
      }),
    });
    await run(root, skill);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function patchManifest(skill: string, patch: Record<string, string>) {
  const manifest: unknown = JSON.parse(await readFile(join(skill, 'upstream.json'), 'utf8'));
  assert(isRecord(manifest));
  await writeFile(join(skill, 'upstream.json'), JSON.stringify({ ...manifest, ...patch }));
}

function runBundle(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: result.stdout + result.stderr };
}

test('同梱ファイルがupstream.jsonと一致すれば終了0でcommitを表示し、SKILL.mdは照合しない', async () => {
  await withRepo(async (root) => {
    const result = runBundle(root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(fakeFullCommit);
    expect(result.output).toContain('2件');
  });
});

for (const [name, change, diagnostic] of [
  [
    '内容の書き換え',
    (skill: string) => writeFile(join(skill, 'scripts/setup.mjs'), 'tampered\n'),
    'sha256が一致しません: scripts/setup.mjs',
  ],
  [
    '同梱ファイルの欠落',
    (skill: string) => rm(join(skill, 'references/contract.md')),
    'ファイルがありません: references/contract.md',
  ],
  [
    '記録にないファイルの追加',
    (skill: string) => writeFile(join(skill, 'scripts/extra.mjs'), 'extra\n'),
    'upstream.jsonに記録がありません: scripts/extra.mjs',
  ],
  [
    '別の配布元の記録',
    async (skill: string) => {
      await patchManifest(skill, { repository: 'other/feedback-loop' });
    },
    'repository',
  ],
  [
    '別のディレクトリの記録',
    async (skill: string) => {
      await patchManifest(skill, { directory: 'dist/plugin' });
    },
    'directory',
  ],
  ['短いcommitの記録', (skill: string) => patchManifest(skill, { commit: 'abc1234' }), '40桁'],
] as const) {
  test(`同梱の食い違いは非ゼロ終了し、対象を示す: ${name}`, async () => {
    await withRepo(async (root, skill) => {
      await change(skill);
      const result = runBundle(root);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
    });
  });
}

test('upstream.jsonがなければ非ゼロ終了する', async () => {
  await withRepo(async (root, skill) => {
    await rm(join(skill, 'upstream.json'));
    const result = runBundle(root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('upstream.json');
  });
});

test('updateは指定commitのdist/privateで置き換え、後のcommitと作業ツリーの変更を取り込まない', async () => {
  await withRepo(async (root, skill) => {
    const source = join(root, 'source');
    await writeFiles(source, {
      'dist/private/scripts/runtime.mjs': 'first\n',
      'dist/private/references/guide.md': '# 手順\n',
      'scripts/feedback-loop/runtime.ts': 'not bundled\n',
    });
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'first');
    const first = git(source, 'rev-parse', 'HEAD');
    await writeFile(join(source, 'dist/private/scripts/runtime.mjs'), 'second\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'second');
    await writeFile(join(source, 'dist/private/scripts/runtime.mjs'), 'working tree\n');

    const result = runBundle(root, 'update', '--source', source, '--commit', first.slice(0, 10));
    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(skill, 'scripts/runtime.mjs'), 'utf8')).toBe('first\n');
    expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe('# 私用版の手順\n');
    expect(await Bun.file(join(skill, 'scripts/setup.mjs')).exists()).toBe(false);
    const manifest: unknown = JSON.parse(await readFile(join(skill, 'upstream.json'), 'utf8'));
    expect(manifest).toMatchObject({
      commit: first,
      files: {
        'scripts/runtime.mjs': sha256('first\n'),
        'references/guide.md': sha256('# 手順\n'),
      },
    });
    expect(runBundle(root).code).toBe(0);
  });
});

test('updateは存在しないcommitで同梱を変更せず非ゼロ終了する', async () => {
  await withRepo(async (root, skill) => {
    const source = join(root, 'source');
    await writeFiles(source, { 'dist/private/scripts/runtime.mjs': 'first\n' });
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'first');
    const result = runBundle(root, 'update', '--source', source, '--commit', 'f'.repeat(40));
    expect(result.code, result.output).toBe(1);
    expect(await readFile(join(skill, 'scripts/setup.mjs'), 'utf8')).toBe(
      bundled['scripts/setup.mjs'],
    );
  });
});

for (const [name, files, diagnostic] of [
  ['dist/privateのないcommit', { 'README.md': 'x\n' }, 'dist/privateがありません'],
  [
    '同梱対象外のファイルを含むcommit',
    {
      'dist/private/scripts/runtime.mjs': 'new\n',
      'dist/private/hooks/run.sh': 'x\n',
    },
    '同梱対象外',
  ],
] as const) {
  test(`updateは${name}で同梱を変更せず非ゼロ終了する`, async () => {
    await withRepo(async (root, skill) => {
      const source = join(root, 'source');
      await writeFiles(source, files);
      git(source, 'init', '-q', '-b', 'main');
      git(source, 'add', '-A');
      git(source, 'commit', '-q', '-m', 'first');
      const result = runBundle(root, 'update', '--source', source, '--commit', 'HEAD');
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
      expect(await readFile(join(skill, 'scripts/setup.mjs'), 'utf8')).toBe(
        bundled['scripts/setup.mjs'],
      );
      expect(runBundle(root).code).toBe(0);
    });
  });
}

test('package scriptのcheckとcheck:feedbackは同梱検査を実行する', async () => {
  const manifest: unknown = JSON.parse(
    await readFile(resolve(import.meta.dir, '../../../../package.json'), 'utf8'),
  );
  assert(isRecord(manifest) && isRecord(manifest.scripts));
  expect(manifest.scripts['check:generated']).toBe('bun scripts/lint/feedback-loop-bundle.ts');
  for (const name of ['check', 'check:feedback']) {
    expect(String(manifest.scripts[name]).split(' && ')).toContain('bun run check:generated');
  }
});
