import assert from 'node:assert/strict';
import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GeminiUnavailable } from '../writing.ts';
import { reviewDocuments } from '../writing-review.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function documentTrial(committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'writing-cache-')));
  roots.push(root);
  const cwd = join(root, 'repo'),
    dir = join(root, 'evidence');
  await mkdir(cwd);
  await mkdir(dir);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  if (committed) {
    git('commit', '--allow-empty', '-m', 'base');
  }
  const file = join(cwd, 'README.md');
  await writeFile(file, '長い文章。4件です。');
  return { cwd, dir, file, git };
}

function rewriter(file: string, name = 'README.md', [from, to] = ['長い文章', '短い文']) {
  return async (argv: string[]) =>
    argv[0] === 'agy'
      ? JSON.stringify({
          documents: [{ name, body: (await readFile(file, 'utf8')).replace(from, to) }],
        })
      : JSON.stringify({ status: 'accepted', findings: '条件は同じ' });
}

for (const change of ['document', 'facts'] as const) {
  test(`successful review is reused only until ${change} changes`, async () => {
    const t = await documentTrial();
    const runner = rewriter(t.file);
    await reviewDocuments(t.cwd, '4件', t.dir, runner);
    expect(await readFile(t.file, 'utf8')).toBe('短い文。4件です。');
    const mustNotRun = async () => {
      throw Error('Unchanged input must reuse its review');
    };
    if (change === 'document') {
      await reviewDocuments(t.cwd, '4件', t.dir, mustNotRun);
    }
    const facts = change === 'facts' ? '4件。新たな出典。' : '4件';
    if (change === 'document') {
      await writeFile(t.file, '長い文章。4件です。追記。');
    }
    // The candidate must differ from the current document so a wrongly adopted one is detected.
    const rewrite = change === 'facts' ? rewriter(t.file, 'README.md', ['短い文', '一文']) : runner;
    let evaluated = false;
    await assert.rejects(
      () =>
        reviewDocuments(t.cwd, facts, t.dir, async (argv) => {
          if (argv[0] === 'agy') {
            return rewrite(argv);
          }
          evaluated = true;
          return JSON.stringify({
            status: 'needs_changes',
            findings: '変更後の資料は再確認が必要',
          });
        }),
      /did not accept/,
    );
    expect(evaluated).toBe(true);
    expect(await readFile(t.file, 'utf8')).toBe(
      change === 'document' ? '長い文章。4件です。追記。' : '短い文。4件です。',
    );
  });
}

test('staged renamed documents receive the reviewed text', async () => {
  const t = await documentTrial();
  const retained = '保持する説明。\n'.repeat(30) + '長い文章。4件です。\n';
  await writeFile(t.file, retained);
  t.git('add', '.');
  t.git('commit', '-m', 'document');
  t.git('mv', 'README.md', 'renamed.md');
  const file = join(t.cwd, 'renamed.md');
  await writeFile(file, retained + '追記。\n');
  t.git('add', '.');
  expect(t.git('diff', '--cached', '--name-status')).toMatch(/^R/);
  await reviewDocuments(t.cwd, '4件', t.dir, rewriter(file, 'renamed.md'));
  expect(await readFile(file, 'utf8')).toBe(retained.replace('長い文章', '短い文') + '追記。\n');
});

for (const change of ['document', 'facts'] as const) {
  test(`${change} changing during review prevents candidate adoption`, async () => {
    const t = await documentTrial();
    const runner = rewriter(t.file);
    let facts = '4件';
    await assert.rejects(
      () =>
        reviewDocuments(
          t.cwd,
          facts,
          t.dir,
          async (argv) => {
            const output = await runner(argv);
            if (argv[0] !== 'agy') {
              if (change === 'document') {
                await writeFile(t.file, '利用者が編集中の文書。');
              } else {
                facts = '5件';
              }
            }
            return output;
          },
          async () => facts,
        ),
      change === 'document' ? /target changed/ : /facts changed/,
    );
    expect(await readFile(t.file, 'utf8')).toBe(
      change === 'document' ? '利用者が編集中の文書。' : '長い文章。4件です。',
    );
  });
}

test('unfinished adoption blocks review even with no uncommitted documents', async () => {
  const t = await documentTrial();
  await writeFile(join(t.dir, 'active.json'), JSON.stringify({ phase: 'adopting' }));
  const mustNotRun = async () => {
    throw Error('Interrupted adoption must not start a model');
  };
  await assert.rejects(() => reviewDocuments(t.cwd, '4件', t.dir, mustNotRun), /reconciliation/);
  t.git('add', '.');
  t.git('commit', '-m', 'adopted');
  await assert.rejects(() => reviewDocuments(t.cwd, '4件', t.dir, mustNotRun), /reconciliation/);
  expect(await readFile(t.file, 'utf8')).toBe('長い文章。4件です。');
});

test('a checkout without commits stops as a git failure before any model runs', async () => {
  const t = await documentTrial(false);
  const mustNotRun = async () => {
    throw Error('A failed git listing must not start a model');
  };
  await assert.rejects(
    () => reviewDocuments(t.cwd, '4件', t.dir, mustNotRun),
    /git failed; inspect/,
  );
  expect(await readFile(t.file, 'utf8')).toBe('長い文章。4件です。');
});

test('unavailable review is reused for identical input and retried for new facts', async () => {
  const t = await documentTrial();
  const unavailable = async () => {
    throw new GeminiUnavailable('cli_missing');
  };
  await reviewDocuments(t.cwd, '4件', t.dir, unavailable);
  const mustNotRun = async () => {
    throw Error('Unchanged input must reuse its skip');
  };
  await reviewDocuments(t.cwd, '4件', t.dir, mustNotRun);
  expect(await readFile(t.file, 'utf8')).toBe('長い文章。4件です。');
  await reviewDocuments(t.cwd, '新たな根拠', t.dir, rewriter(t.file));
  expect(await readFile(t.file, 'utf8')).toBe('短い文。4件です。');
});

for (const kind of ['new', 'tracked'] as const) {
  test(`${kind} document entering the review set prevents candidate adoption`, async () => {
    const t = await documentTrial();
    const added = join(t.cwd, 'ADDED.md');
    if (kind === 'tracked') {
      await writeFile(added, '既存の説明。');
      t.git('add', 'ADDED.md');
      t.git('commit', '-m', 'existing document');
    }
    const runner = rewriter(t.file);
    await assert.rejects(
      () =>
        reviewDocuments(t.cwd, '4件', t.dir, async (argv) => {
          const response = await runner(argv);
          if (argv[0] !== 'agy') {
            await writeFile(added, '確認中に加わった説明。');
          }
          return response;
        }),
      /Writing target changed during review/,
    );
    expect(await readFile(t.file, 'utf8')).toBe('長い文章。4件です。');
    expect(await readFile(added, 'utf8')).toBe('確認中に加わった説明。');
    expect(await readFile(join(t.dir, 'active.json'), 'utf8')).toContain('reviewing');
  });
}
