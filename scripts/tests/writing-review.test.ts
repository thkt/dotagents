import assert from 'node:assert/strict';
import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, realpath, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GeminiUnavailable } from '../writing.ts';
import { reviewDocuments, reviewFile } from '../writing-review.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function documentTrial(committed = true, repoName = 'repo') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'writing-cache-')));
  roots.push(root);
  const cwd = join(root, repoName),
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

async function put(cwd: string, name: string, body: string) {
  const path = join(cwd, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

test('documents selects configured human text and never sends or rewrites excluded bodies', async () => {
  const t = await documentTrial();
  const excluded = [
    'AGENTS.md',
    'docs/SKILL.md',
    '.agents/notes.md',
    '.codex/prompts/review.md',
    'skills/scoping/references/issue.md',
    '.github/instructions/style.instructions.md',
    'docs/fixtures/example.md',
    'docs/tests/example.md',
    'docs/issue-59.md',
    'research/issue-59-writing-targets.md',
    'docs/issues/59.md',
    'docs/draft.md',
    'docs/data.json',
    'arbitrary.md',
  ];
  for (const name of excluded) {
    await put(t.cwd, name, `対象外本文: ${name}`);
  }
  await put(t.cwd, 'docs/proposal.md', '---\nwriting-purpose: issue\n---\n合意前の要求。');
  await put(t.cwd, 'manual/guide.md', '長い操作説明。');
  await put(
    t.cwd,
    '.dotagents.json',
    JSON.stringify({
      writing: {
        documents: [
          'README.md',
          'docs/',
          'manual/',
          'research/',
          '.agents/',
          '.codex/',
          'skills/',
          '.github/',
          'AGENTS.md',
        ],
        exclude: ['docs/draft.md'],
      },
    }),
  );
  const sent: string[] = [];
  await reviewDocuments(t.cwd, '4件', t.dir, async (argv, _cwd, input) => {
    sent.push(argv[0] === 'agy' ? (argv.at(-1) ?? '') : input);
    return argv[0] === 'agy'
      ? JSON.stringify({
          documents: [
            { name: 'README.md', body: '短い文。4件です。' },
            { name: 'manual/guide.md', body: '短い操作説明。' },
          ],
        })
      : JSON.stringify({ status: 'accepted', findings: '意味は同じ' });
  });
  expect(sent).toHaveLength(2);
  for (const prompt of sent) {
    expect(prompt).not.toContain('対象外本文');
    expect(prompt).not.toContain('合意前の要求');
    expect(prompt).toContain('長い操作説明');
  }
  expect(await readFile(t.file, 'utf8')).toBe('短い文。4件です。');
  expect(await readFile(join(t.cwd, 'manual/guide.md'), 'utf8')).toBe('短い操作説明。');
  for (const name of excluded) {
    expect(await readFile(join(t.cwd, name), 'utf8')).toBe(`対象外本文: ${name}`);
  }
  expect(await readFile(join(t.cwd, 'docs/proposal.md'), 'utf8')).toContain('合意前の要求');
});

test('default selection leaves Issue-only and AI-only work outside review, without skip receipts', async () => {
  const t = await documentTrial();
  t.git('add', '.');
  t.git('commit', '-m', 'existing document');
  const excluded = ['research/findings.md', 'notes.md', 'docs/issue.md', 'AGENTS.md'];
  const mustNotRun = async () => {
    throw Error('Excluded work must not run a model');
  };
  for (const body of ['新規の要求。', '更新した要求。']) {
    for (const name of excluded) {
      await put(t.cwd, name, body);
    }
    await reviewDocuments(t.cwd, '要求', t.dir, mustNotRun);
    for (const name of excluded) {
      expect(await readFile(join(t.cwd, name), 'utf8')).toBe(body);
    }
    expect((await readdir(t.dir)).filter((name) => name.endsWith('.json'))).toEqual([]);
    t.git('add', '.');
    t.git('commit', '-m', 'requirements');
  }
});

for (const phase of ['during', 'after'] as const) {
  test(`selection changing ${phase} review rejects stale candidates or receipts`, async () => {
    const t = await documentTrial();
    const config = join(t.cwd, '.dotagents.json');
    await writeFile(config, JSON.stringify({ writing: { documents: ['README.md'] } }));
    await put(t.cwd, 'manual/guide.md', '新たな対象。');
    const change = () =>
      writeFile(
        config,
        JSON.stringify({
          writing: {
            documents: ['README.md', phase === 'during' ? 'manual/' : 'unused/'],
          },
        }),
      );
    const rewrite = rewriter(t.file);
    if (phase === 'during') {
      await assert.rejects(
        () =>
          reviewDocuments(t.cwd, '4件', t.dir, async (argv) => {
            const result = await rewrite(argv);
            if (argv[0] !== 'agy') {
              await change();
            }
            return result;
          }),
        /Writing target changed/,
      );
      expect(await readFile(t.file, 'utf8')).toBe('長い文章。4件です。');
      expect(await readFile(join(t.dir, 'active.json'), 'utf8')).toContain('reviewing');
    } else {
      await reviewDocuments(t.cwd, '4件', t.dir, rewrite);
      await change();
      await assert.rejects(
        () =>
          reviewDocuments(t.cwd, '4件', t.dir, async () => {
            throw Error('New selection requires review');
          }),
        /New selection requires review/,
      );
      expect(await readFile(t.file, 'utf8')).toBe('短い文。4件です。');
    }
    expect(await readFile(join(t.cwd, 'manual/guide.md'), 'utf8')).toBe('新たな対象。');
  });
}

test('file mode refuses known excluded inputs before models or output writes', async () => {
  const t = await documentTrial();
  const facts = join(t.dir, 'facts.md');
  await writeFile(facts, '根拠');
  const output = join(t.dir, 'output.md');
  for (const name of [
    'AGENTS.md',
    'docs/SKILL.md',
    '.codex/prompts/task.md',
    'docs/test.txt',
    'docs/issue-59.md',
    'docs/proposal.md',
  ]) {
    const body = name.endsWith('proposal.md')
      ? '---\nwriting-purpose: issue\n---\n要求。'
      : '保持する原文。';
    await put(t.cwd, name, body);
    await assert.rejects(
      () =>
        reviewFile(join(t.cwd, name), facts, output, t.dir, async () => {
          throw Error('Must not start a writing model');
        }),
      /human-facing Markdown|Issue drafts/,
    );
    expect(await readFile(join(t.cwd, name), 'utf8')).toBe(body);
    expect(await readdir(t.dir)).toEqual(['facts.md']);
  }
});

test('file mode keeps an external PR original and writes a candidate only after fidelity acceptance', async () => {
  const t = await documentTrial();
  const original = join(t.dir, 'pr.md');
  await writeFile(original, '長いPR説明。');
  const facts = join(t.dir, 'facts.md');
  await writeFile(facts, '合意した変更');
  const output = join(t.dir, 'output.md');
  const prompts: string[] = [];
  await reviewFile(original, facts, output, t.dir, async (argv, _cwd, input) => {
    prompts.push(argv[0] === 'agy' ? (argv.at(-1) ?? '') : input);
    return argv[0] === 'agy'
      ? JSON.stringify({ documents: [{ name: 'body', body: '短いPR説明。' }] })
      : JSON.stringify({ status: 'accepted', findings: '合意と一致' });
  });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('短いPR説明');
  expect(await readFile(original, 'utf8')).toBe('長いPR説明。');
  expect(await readFile(output, 'utf8')).toBe('短いPR説明。');
  expect(await readdir(join(t.dir, 'review'))).toContain('accepted.json');
});

test('file selection uses the checkout boundary even when invoked inside excluded directories', async () => {
  const t = await documentTrial(true, '.agents');
  const facts = join(t.dir, 'facts.md');
  const output = join(t.dir, 'output.md');
  await writeFile(facts, '4件');
  await reviewFile(t.file, facts, output, t.dir, rewriter(t.file, 'body'));
  expect(await readFile(output, 'utf8')).toBe('短い文。4件です。');

  const rejectedDir = join(t.dir, 'rejected');
  await mkdir(rejectedDir);
  const worker = join(t.dir, 'worker.ts');
  await writeFile(
    worker,
    `import { reviewFile } from ${JSON.stringify(join(import.meta.dir, '../writing-review.ts'))};
await reviewFile(process.argv[2], ${JSON.stringify(facts)},
  ${JSON.stringify(join(rejectedDir, 'output.md'))}, ${JSON.stringify(rejectedDir)},
  async () => { throw Error('Must not send AI instructions'); });`,
  );
  for (const name of ['.agents/private.md', 'skills/scoping/references/session.md']) {
    await put(t.cwd, name, 'AI用の指示。');
    const input = join(t.cwd, name);
    const result = spawnSync(process.execPath, [worker, input], {
      cwd: dirname(input),
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Writing file must be human-facing Markdown or a PR body');
    expect(result.stderr).not.toContain('Must not send AI instructions');
    expect(await readFile(input, 'utf8')).toBe('AI用の指示。');
    expect(await readdir(rejectedDir)).toEqual([]);
  }
});

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
  await mkdir(join(t.cwd, 'docs'));
  t.git('mv', 'README.md', 'docs/renamed.md');
  const file = join(t.cwd, 'docs/renamed.md');
  await writeFile(file, retained + '追記。\n');
  t.git('add', '.');
  expect(t.git('diff', '--cached', '--name-status')).toMatch(/^R/);
  await reviewDocuments(t.cwd, '4件', t.dir, rewriter(file, 'docs/renamed.md'));
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
    await mkdir(join(t.cwd, 'docs'));
    const added = join(t.cwd, 'docs/added.md');
    if (kind === 'tracked') {
      await writeFile(added, '既存の説明。');
      t.git('add', 'docs/added.md');
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

for (const change of ['facts', 'set'] as const) {
  test(`cached writing result is rejected when ${change} changes during reuse`, async () => {
    const t = await documentTrial();
    await reviewDocuments(t.cwd, '4件', t.dir, rewriter(t.file));
    const receipts = (await readdir(t.dir)).filter((name) => name.startsWith('done-'));
    await assert.rejects(
      () =>
        reviewDocuments(
          t.cwd,
          '4件',
          t.dir,
          async () => {
            throw Error('Same input must not start another model');
          },
          async () => {
            if (change === 'set') {
              await put(t.cwd, 'docs/added.md', '新たな説明。');
            }
            return change === 'facts' ? '5件' : '4件';
          },
        ),
      change === 'facts'
        ? /Writing facts changed during reuse/
        : /Writing target changed during reuse/,
    );
    expect(await readFile(t.file, 'utf8')).toBe('短い文。4件です。');
    expect((await readdir(t.dir)).filter((name) => name.startsWith('done-'))).toEqual(receipts);
  });
}
