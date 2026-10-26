import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { validateInputFiles } from '../data.ts';
import { prepareInputs } from '../inputs.ts';
import { isRecord } from '../../scripts/shared/values.ts';
import { initializeTarget, git, targetConfig } from '../../scripts/tests/support/target.ts';

// #409でも維持する入力選別と公開blobの検証。実行方式・認証を起動しない。
const config = {
  repository: 'thkt/dotagents' as const,
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  corpusCommit: 'c'.repeat(40),
  workspaceCommit: 'a'.repeat(40),
  workspaceFiles: ['README.md'],
  instructionFiles: ['AGENTS.md', 'skills/scoping/SKILL.md', 'skills/implement/SKILL.md'],
  model: 'gpt-6.1-sol',
  reasoning: 'medium' as const,
  outputDirectory: '/tmp/eval-not-executed',
};
const caseContext = { body: 'PUBLIC_ISSUE_BODY_CANARY' };
const cases = [
  {
    id: 'positive',
    source: 'https://example.invalid/public',
    prompt: '公開の課題',
    expected: 'scoping' as const,
    criteria: ['公開の判定基準'],
  },
];
async function preparePlan(repo: string, input: Parameters<typeof prepareInputs>[1]) {
  validateInputFiles(input);
  return prepareInputs(
    repo,
    input,
    cases.map((item) => ({ ...item, contextBody: caseContext.body })),
  );
}
test('共通指示の許可は文書に限定し、課題・評価情報・秘密情報を混ぜない', () => {
  const instructions = (path: string) => ({
    ...config,
    workspaceFiles: ['result.txt'],
    instructionFiles: [...config.instructionFiles, path],
  });
  for (const path of [
    'skills/references/documents.md',
    'skills/references/natural-japanese.md',
    'docs/wiki/development-policy.md',
    'README.md',
    'scripts/README.md',
  ]) {
    expect(() => validateInputFiles(instructions(path))).not.toThrow();
  }
  for (const path of [
    'eval/eval.ts',
    'eval/corpus/cases.json',
    'scripts/eval/eval.ts',
    'scripts/eval/corpus/cases.json',
    'evals/answers.md',
    '.agents/AGENTS.md',
  ]) {
    expect(() => validateInputFiles(instructions(path))).toThrow('host-only');
  }
  for (const path of [
    'skills/references/.env',
    'skills/references/auth.json',
    'skills/references/credentials/guide.md',
    'skills/references/config.toml',
  ]) {
    expect(() => validateInputFiles(instructions(path))).toThrow('credentials');
  }
  for (const path of [
    'scripts/implement/review.ts',
    'scripts/tests/eval/eval.test.ts',
    'skills/references/helper.ts',
    'docs/research/expected.md',
    'docs/wiki/arbitrary.md',
  ]) {
    expect(() => validateInputFiles(instructions(path))).toThrow('Unsupported instruction');
  }
  expect(() =>
    validateInputFiles({ ...instructions('README.md'), workspaceFiles: ['README.md'] }),
  ).toThrow('overlap');
});

for (const path of [
  'scripts/implement/orchestrator.ts',
  'scripts/implement/repair.ts',
  'scripts/implement/codex-actor.ts',
]) {
  test(`初回担当の信頼版コード${path}を共通workspaceへ移して指示比較を迂回できない`, () => {
    // 課題側の通常コードは引き続き許可する。
    expect(() =>
      validateInputFiles({ ...config, workspaceFiles: ['src/messages.ts'] }),
    ).not.toThrow();
    expect(() => validateInputFiles({ ...config, workspaceFiles: [path] })).toThrow();
  });
}

test('8課題の追加集合を既存5課題と分離し、採点指示を通常依頼へ混ぜない', async () => {
  const corpus: unknown = JSON.parse(
    await readFile(resolve(import.meta.dir, '../corpus/cases.json'), 'utf8'),
  );
  assert(Array.isArray(corpus));
  const oldIds = ['requirements', 'implementation', 'question', 'review', 'ambiguous'];
  const added = corpus.filter(
    (item): item is Record<string, unknown> => isRecord(item) && !oldIds.includes(String(item.id)),
  );
  expect(added).toHaveLength(8);
  expect(new Set(added.map((item) => item.id)).size).toBe(8);
  expect(corpus.filter((item) => isRecord(item) && oldIds.includes(String(item.id)))).toHaveLength(
    5,
  );
  for (const item of added) {
    assert(isRecord(item) && typeof item.prompt === 'string');
    expect(item.prompt).not.toMatch(
      /前提を検証して|理由の確度を調べて|利用例から設計して|機械化・lint化を考えて/,
    );
    expect(String(item.id)).not.toMatch(
      /positive|negative|correct|incorrect|necessary|unnecessary/,
    );
    expect(Array.isArray(item.criteria) && item.criteria.length > 0).toBe(true);
  }
});

test('新配置でも課題の通常入力だけを許可し、ホスト用コード・採点情報を拒否する', () => {
  expect(() =>
    validateInputFiles({
      ...config,
      workspaceFiles: ['eval/fixtures/workspace/tests/work-areas.test.ts'],
    }),
  ).not.toThrow();
  for (const path of [
    'eval/eval.ts',
    'eval/README.md',
    'eval/corpus/cases.json',
    'eval/tests/task-fixtures.test.ts',
    'eval/tests/fixtures/trusted-inputs.json',
    'scripts/tests/eval/task-fixtures.test.ts',
  ]) {
    expect(() => validateInputFiles({ ...config, workspaceFiles: [path] })).toThrow('host-only');
    expect(() =>
      validateInputFiles({ ...config, instructionFiles: [...config.instructionFiles, path] }),
    ).toThrow('host-only');
  }
  // 課題用の通常資料でも指示側へ移してA/Bの差に混ぜない。
  expect(() =>
    validateInputFiles({
      ...config,
      instructionFiles: [...config.instructionFiles, 'eval/fixtures/workspace/specs.md'],
    }),
  ).toThrow();
});

async function fixture(
  root: string,
  instructionVersions: Record<string, [string | null, string]> = {
    'AGENTS.md': ['Before instructions', 'After instructions'],
  },
) {
  const repo = join(root, 'repo');
  await mkdir(repo);
  await initializeTarget(repo, { ...targetConfig, repository: 'thkt/dotagents', remote: 'origin' });
  for (const path of ['eval/corpus', 'skills/scoping', 'skills/implement']) {
    await mkdir(join(repo, path), { recursive: true });
  }
  await writeFile(join(repo, 'README.md'), 'Public task context');
  await writeFile(join(repo, 'AGENTS.md'), 'Before instructions');
  await writeFile(join(repo, 'skills/scoping/SKILL.md'), 'Public scoping body');
  await writeFile(join(repo, 'skills/implement/SKILL.md'), 'Public implement body');
  for (const [path, [before]] of Object.entries(instructionVersions)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    if (before !== null) {
      await writeFile(join(repo, path), before);
    }
  }
  await writeFile(
    join(repo, 'eval/corpus/cases.json'),
    JSON.stringify([
      { ...cases[0], criteria: ['HOST_ONLY_EXPECTED_CANARY'], context: caseContext },
    ]),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'public inputs');
  const before = git(repo, 'rev-parse', 'HEAD');
  for (const [path, [, after]] of Object.entries(instructionVersions)) {
    await writeFile(join(repo, path), after);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'instruction candidate');
  const after = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'PRIVATE_UNCOMMITTED_CANARY');
  const plan = {
    ...config,
    before,
    after,
    corpusCommit: before,
    workspaceCommit: before,
    outputDirectory: join(root, 'run'),
  };
  return { root, repo, plan };
}

test('共通参照だけの変更を両版の内容・hash・変更一覧へ反映し、課題と参照不足を区別する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-eval-plan-'));
  try {
    const common = 'skills/references/documents.md';
    const policy = 'docs/wiki/development-policy.md';
    const guide = '[文書](skills/references/documents.md) [方針](docs/wiki/development-policy.md)';
    const oldBody = '[課題](../../README.md) [旧参照](old.md#読む)';
    const newBody =
      '[課題](../../README.md) [新参照](new.md) [節](#読む) [外部](https://example.com)';
    const { repo, plan } = await fixture(root, {
      'AGENTS.md': [guide, guide],
      [common]: [oldBody, newBody],
      [policy]: ['変更前の方針', '変更後の方針'],
      'README.md': ['固定した課題', '比較へ混ぜない課題変更'],
    });
    const input = { ...plan, instructionFiles: [...plan.instructionFiles, common, policy] };
    const prepared = await preparePlan(repo, input);
    expect(prepared.changedInstructions).toEqual([common, policy]);
    for (const [index, body, missing] of [
      [0, oldBody, 'old.md'],
      [1, newBody, 'new.md'],
    ] as const) {
      const variant = prepared.variants[index];
      assert(variant);
      expect(variant.files[common]).toBe(body);
      expect(variant.versions[common]).toBe(createHash('sha256').update(body).digest('hex'));
      expect(variant.files[policy]).toBe(index === 0 ? '変更前の方針' : '変更後の方針');
      expect(variant.files['README.md']).toBe('固定した課題');
      expect(variant.versions['README.md']).toBe(
        createHash('sha256').update('固定した課題').digest('hex'),
      );
      expect(variant.missingReferences).toEqual([
        { source: common, target: `skills/references/${missing}` },
      ]);
      expect(Object.keys(variant.files).sort()).toEqual(
        [...input.workspaceFiles, ...input.instructionFiles].sort(),
      );
    }
    expect(prepared.variants[0]?.versions[policy]).not.toBe(prepared.variants[1]?.versions[policy]);
    await assert.rejects(() => preparePlan(repo, plan), /No relevant instruction changes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('共通参照も通常の追跡済みUTF-8 blobだけを使い、作業差分・symlink・未追跡入力を読まない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-eval-plan-'));
  try {
    const path = 'skills/references/documents.md';
    const link = 'skills/references/link.md';
    const { repo, plan } = await fixture(root, {
      [path]: ['変更前', '変更後'],
      [link]: ['通常の参照文書', '通常の参照文書'],
    });
    await writeFile(join(repo, path), 'PRIVATE_LOCAL_CANARY');
    // 比較先にも同じパスを残し、欠落による拒否でsymlink検査の回帰を隠さない。
    await rm(join(repo, link));
    await symlink('documents.md', join(repo, link));
    await writeFile(join(repo, 'skills/references/binary.md'), Buffer.from([0, 255]));
    git(repo, 'add', 'skills/references/link.md', 'skills/references/binary.md');
    git(repo, 'commit', '-qm', 'invalid input fixtures');
    const after = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'skills/references/untracked.md'), 'PRIVATE_UNTRACKED_CANARY');
    const input = { ...plan, after, instructionFiles: [...plan.instructionFiles, path] };
    const prepared = await preparePlan(repo, input);
    expect(prepared.variants.map((variant) => variant.files[path])).toEqual(['変更前', '変更後']);
    for (const [name, reason] of [
      ['link.md', /Expected regular committed file/],
      ['untracked.md', /Expected regular committed file/],
      ['binary.md', /Evaluation input must be UTF-8 text/],
    ] as const) {
      await assert.rejects(
        () =>
          preparePlan(repo, {
            ...input,
            before: after,
            after: plan.before,
            instructionFiles: [...input.instructionFiles, `skills/references/${name}`],
          }),
        reason,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('新設3資料はAの不存在とBの通常blobを保持し、空補完やBからのコピーをしない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'instruction-presence-'));
  try {
    const paths = [
      'skills/references/premise-validation.md',
      'skills/references/caller-first-design.md',
      'skills/references/mechanization.md',
    ];
    const versions: Record<string, [string | null, string]> = {
      'AGENTS.md': ['既存の指示を維持する', '既存の指示を維持する'],
    };
    for (const path of paths) {
      versions[path] = [null, `新設した公開資料: ${path}`];
    }
    const { repo, plan } = await fixture(root, versions);
    const input = { ...plan, instructionFiles: [...plan.instructionFiles, ...paths] };
    const prepared = await preparePlan(repo, input);
    expect(prepared.changedInstructions).toEqual(paths);
    const [before, after] = prepared.variants;
    assert(before && after);
    expect(before.commit).toBe(plan.before);
    expect(after.commit).toBe(plan.after);
    expect(before.files['AGENTS.md']).toBe('既存の指示を維持する');
    expect(before.files['README.md']).toBe(after.files['README.md']);
    for (const path of paths) {
      expect(Object.hasOwn(before.files, path)).toBe(false);
      expect(Object.hasOwn(before.versions, path)).toBe(false);
      expect(after.files[path]).toBe(`新設した公開資料: ${path}`);
      expect(after.versions[path]).toBe(
        createHash('sha256').update(`新設した公開資料: ${path}`).digest('hex'),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('新設扱いは必須資料の欠落・B側の不存在・取得不能・symlinkを許可しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'instruction-presence-'));
  try {
    const path = 'skills/references/mechanization.md';
    const { repo, plan } = await fixture(root, { [path]: [null, '公開資料'] });
    const input = { ...plan, instructionFiles: [...plan.instructionFiles, path] };
    // 先にBの正常blobへ到達できる対照を確認する。Aの欠落は今回の新設資料だけ。
    expect(git(repo, 'show', `${plan.after}:${path}`)).toBe('公開資料');
    for (const absent of ['AGENTS.md', path]) {
      // 各反例のindexも正常なBへ戻す。作業ファイルだけの復元では欠落が混在する。
      git(repo, 'checkout', plan.after, '--', 'AGENTS.md', path);
      await rm(join(repo, absent));
      git(repo, 'add', absent);
      git(repo, 'commit', '-qm', 'missing required input');
      const after = git(repo, 'rev-parse', 'HEAD');
      const retained = absent === path ? 'AGENTS.md' : path;
      expect(git(repo, 'ls-tree', after, '--', absent)).toBe('');
      expect(git(repo, 'ls-tree', after, '--', retained)).toMatch(/^100644 blob /);
      await assert.rejects(
        () => preparePlan(repo, { ...input, before: plan.after, after }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`Expected regular committed file: ${absent}`),
      );
    }
    git(repo, 'checkout', plan.after, '--', 'AGENTS.md', path);
    await assert.rejects(() => preparePlan(repo, { ...input, after: '0'.repeat(40) }));
    await writeFile(join(repo, 'AGENTS.md'), '既存指示');
    await rm(join(repo, path));
    await symlink('../../../README.md', join(repo, path));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'symlink is not an absent document');
    await assert.rejects(
      () =>
        preparePlan(repo, { ...input, before: plan.after, after: git(repo, 'rev-parse', 'HEAD') }),
      /Expected regular committed file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
