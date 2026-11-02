import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sync } from '../../../feedback-loop/build.ts';
import { skillDir } from '../../support/feedback-loop-skill.ts';
import { files, fixture, run } from '../../support/feedback-loop-batch.ts';

// Issue #473: スキルはdotagentsのcheckoutなしで動き、.dotagents.jsonの扱いだけが版で異なる。
const variants = ['private', 'plugin'] as const;
const { '.dotagents.json': dotagentsJson, ...withoutDotagents } = files;

async function placed(repo: string) {
  const dir = join(repo, 'scripts/feedback-loop');
  const names = (await readdir(dir)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')] as const),
    ),
  );
}

test('スキルはgitとdotagentsのnode_modulesがない場所から起動できる', async () => {
  for (const variant of variants) {
    const dir = await skillDir(variant);
    const git = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' });
    expect(git.status, `${variant}がGit checkout内にあります`).not.toBe(0);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    expect((await readdir(join(dir, 'scripts'))).sort()).toEqual([
      'record-modules.ts',
      'runtime.mjs',
      'setup.mjs',
      'source.json',
    ]);
  }
});

for (const present of [false, true]) {
  test(`.dotagents.json${present ? 'がある' : 'がない'}repoで、両版は同じ補助ファイルを配置し、私用版だけがfeedbackCheckを接続する`, async () => {
    const outputs: Record<string, Record<string, string>> = {};
    for (const variant of variants) {
      const setup = join(await skillDir(variant), 'scripts/setup.mjs');
      await fixture(present ? files : withoutDotagents, async (f) => {
        const target = join(f.repo, '.dotagents.json');
        const before = present ? await readFile(target, 'utf8') : undefined;
        const result = run(f, [
          setup,
          'apply',
          '--repo',
          f.repo,
          '--feedback-command',
          'bun run test:affected',
        ]);
        expect(result.code, result.output).toBe(0);
        if (!present) {
          expect(existsSync(target)).toBe(false);
          expect(result.stdout.includes('feedbackCheckの接続を省きました')).toBe(
            variant === 'private',
          );
        } else if (variant === 'private') {
          expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
            ...JSON.parse(dotagentsJson),
            feedbackCheck: ['bun', 'run', 'check:feedback'],
          });
        } else {
          expect(await readFile(target, 'utf8')).toBe(before ?? '');
          expect(result.stdout).not.toContain('.dotagents.json');
        }
        const classified = run(f, ['run', 'check:classification']);
        expect(classified.code, classified.output).toBe(0);
        outputs[variant] = await placed(f.repo);
      });
    }
    expect(Object.keys(outputs.private ?? {})).toContain('runtime.mjs');
    expect(outputs.plugin).toEqual(outputs.private);
  });
}

test('Bun 1.4.4以外で起動すると、版の不一致を示してrepoを変更しない', async () => {
  const setup = join(await skillDir('plugin'), 'scripts/setup.mjs');
  await fixture(withoutDotagents, async (f) => {
    const result = spawnSync('node', [setup, 'inspect', '--repo', f.repo], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bun 1.4.4で起動してください（現在: Node.js');
    expect(existsSync(join(f.repo, 'scripts/feedback-loop'))).toBe(false);
  });
});

test('生成先が正本と食い違うと、checkは書き換えずに食い違いと余分なファイルを返す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feedback-loop-generated-'));
  try {
    expect((await sync('plugin', root, false)).stale).toContain('scripts/runtime.mjs');
    expect(await sync('plugin', root, true)).toEqual({ stale: [], extra: [] });
    await writeFile(join(root, 'scripts/runtime.mjs'), '// 手で編集した\n');
    await writeFile(join(root, 'references/tools.md'), '手で編集した\n');
    await writeFile(join(root, 'scripts/extra.mjs'), '\n');
    expect(await sync('plugin', root, true)).toEqual({
      stale: ['scripts/runtime.mjs', 'references/tools.md'],
      extra: ['scripts/extra.mjs'],
    });
    expect(await readFile(join(root, 'scripts/runtime.mjs'), 'utf8')).toBe('// 手で編集した\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
