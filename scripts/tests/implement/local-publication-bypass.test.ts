import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { object } from '../support/correction.ts';
import { formalTree } from '../support/formal-host-return.ts';
import { localPublicationFixture } from '../support/local-publication.ts';
import { git, initializeTarget, targetConfig } from '../support/target.ts';

type Fixture = Awaited<ReturnType<typeof localPublicationFixture>>;
const publicBranch = 'codex/standalone-publication';
const nativeBranch = 'codex/development-99';

async function fixture() {
  const f = await localPublicationFixture(publicBranch);
  try {
    // cloneが残したlocal branchだけを除く。元のcheckoutとrunは編集しない。
    git(f.published, 'branch', '-D', nativeBranch);
    expect(git(f.checkout, 'branch', '--show-current')).toBe(nativeBranch);
    expect(git(f.published, 'branch', '--show-current')).toBe(publicBranch);
    expect(
      git(f.published, 'for-each-ref', '--format=%(refname)', `refs/heads/${nativeBranch}`),
    ).toBe('');
    expect(git(f.published, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(f.published, 'rev-parse', 'HEAD')).toBe(f.pr.headRefOid);
    expect(git(f.published, 'show', 'HEAD:deliverable.txt')).toBe('accepted deliverable');
    expect(object(JSON.parse(await readFile(join(f.prior, 'result.json'), 'utf8')))).toMatchObject({
      terminal: true,
      status: 'verified_local',
      localOnly: true,
      publication: 'not_attempted',
    });
    return f;
  } catch (error) {
    await f.dispose();
    throw error;
  }
}

async function retained(f: Fixture) {
  return Promise.all([formalTree(f.prior, true), formalTree(f.checkout), formalTree(f.published)]);
}

async function stopped(f: Fixture, args: string[], reason: RegExp) {
  const before = await retained(f);
  const offset = (await f.observations()).length;
  const result = await f.cli(args);
  const calls = (await f.observations()).slice(offset);
  // 終了codeだけでは、担当を起動してから止まる回避やbranch衝突を見逃す。
  expect(calls.filter((call) => call.role !== 'github').map((call) => call.role)).toEqual([]);
  expect(
    calls.some(
      (call) =>
        Array.isArray(call.argv) && ['create', 'edit', 'ready'].includes(String(call.argv[2])),
    ),
  ).toBe(false);
  expect(await retained(f)).toEqual(before);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.doesNotMatch(
    result.stderr,
    /Unknown option|ERR_PARSE_ARGS|Cannot find|ENOENT|SyntaxError|ReferenceError|already exists/i,
  );
  assert.match(result.stderr, reason);
}

test('単独公開の別branch 既定名branch不在でも同じIssueの通常起動は初回担当へ進まない', async () => {
  const f = await fixture();
  try {
    await f.changeControl({ pr: { ...f.pr, isDraft: false } });
    // 採用引数のない入口も単独で検証し、採用CLIの未接続で空振りさせない。
    await stopped(
      f,
      ['99', '--repo', f.published, '--run-dir', join(f.root, 'ordinary')],
      /PR|停止|照合|既存|previous|publication|adopt/i,
    );
  } finally {
    await f.dispose();
  }
}, 60000);

test('単独公開の別branch 採用のdraft拒否後も通常起動で回避せず原本と公開先を保つ', async () => {
  const f = await fixture();
  try {
    await f.changeControl({ pr: { ...f.pr, isDraft: false } });
    await stopped(f, f.args, /draft/i);
    await stopped(
      f,
      ['99', '--repo', f.published, '--run-dir', join(f.root, 'bypass')],
      /PR|停止|照合|既存|previous|publication|adopt/i,
    );
  } finally {
    await f.dispose();
  }
}, 60000);

async function ordinary(f: Fixture, number: string, repo: string) {
  const before = await Promise.all([formalTree(f.prior, true), formalTree(f.checkout)]);
  const offset = (await f.observations()).length;
  const dir = join(f.root, `ordinary-${number}-${repo === f.published ? 'same' : 'other'}`);
  const result = await f.cli([number, '--repo', repo, '--run-dir', dir, '--no-publish']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  expect(object(JSON.parse(result.stdout))).toMatchObject({
    status: 'verified_local',
    publication: 'not_attempted',
  });
  const calls = (await f.observations()).slice(offset);
  expect(
    calls
      .filter((call) => ['test', 'repair', 'review'].includes(String(call.role)))
      .map((call) => call.role),
  ).toEqual(['test', 'repair', 'review']);
  const input = object(
    JSON.parse(
      String(calls.find((call) => call.role === 'test')?.prompt)
        .split('入力: ')[1]
        ?.split('\n')[0] ?? '',
    ),
  );
  expect(input.stage).toBe('initial');
  expect(calls.some((call) => call.role === 'check')).toBe(true);
  expect(calls.some((call) => call.role === 'push')).toBe(false);
  expect(await Promise.all([formalTree(f.prior, true), formalTree(f.checkout)])).toEqual(before);
  expect(git(f.published, 'branch', '--show-current')).toBe(publicBranch);
  expect(git(f.published, 'rev-parse', 'HEAD')).toBe(f.pr.headRefOid);
}

test('単独公開の別branch 同じrepoの別Issueの通常起動を拒否しない', async () => {
  const f = await fixture();
  try {
    await f.changeControl({ pr: { ...f.pr, isDraft: false } });
    await ordinary(f, '98', f.published);
  } finally {
    await f.dispose();
  }
}, 60000);

test('単独公開の別branch 別repoの同じIssue番号の通常起動を拒否しない', async () => {
  const f = await fixture();
  try {
    await f.changeControl({ pr: { ...f.pr, isDraft: false } });
    const repo = join(f.root, 'unrelated');
    await mkdir(repo);
    await initializeTarget(repo, {
      ...targetConfig,
      repository: 'team/unrelated',
      check: ['sh', '-c', 'test "$(cat result.txt)" = implemented'],
    });
    await mkdir(join(repo, 'docs/research'), { recursive: true });
    await writeFile(join(repo, f.report), await readFile(join(f.repo, f.report)));
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', '合成の別repoの参照資料');
    // 追加repoのGitHub観測だけを補う。元のrepo・PRの応答は維持する。
    const preload = join(f.root, 'preload.ts');
    const source = await readFile(preload, 'utf8');
    const targetCall = /githubTarget\(argv,(\{[^\n]+?\})\)/;
    assert(targetCall.test(source), 'fixtureのGitHub対象観測が必要');
    assert(source.includes('stdout=JSON.stringify(c.pr?[['), 'fixtureのPR一覧観測が必要');
    await writeFile(
      preload,
      source
        .replace(
          targetCall,
          "githubTarget(argv,argv[2]?.startsWith('repos/team/unrelated')?{...$1,repository:'team/unrelated'}:$1)",
        )
        .replace(
          'stdout=JSON.stringify(c.pr?[[',
          "stdout=JSON.stringify(argv[2]==='repos/team/unrelated/pulls'?[[]]:c.pr?[[",
        ),
    );
    await ordinary(f, '99', repo);
  } finally {
    await f.dispose();
  }
}, 60000);

test('単独公開の別branch 既定名branch不在でも正常採用は同じPRの新しい修正へ進む', async () => {
  const f = await fixture();
  try {
    const before = await Promise.all([formalTree(f.prior, true), formalTree(f.checkout)]);
    const result = await f.cli(f.args);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    expect(object(JSON.parse(result.stdout))).toMatchObject({
      status: 'published_draft',
      publication: 'published',
      branch: publicBranch,
      url: f.pr.url,
    });
    const calls = await f.observations();
    expect(
      calls
        .filter((call) => ['test', 'repair', 'review'].includes(String(call.role)))
        .map((call) => call.role),
    ).toEqual(['test', 'repair', 'review']);
    const input = object(
      JSON.parse(
        String(calls.find((call) => call.role === 'test')?.prompt)
          .split('入力: ')[1]
          ?.split('\n')[0] ?? '',
      ),
    );
    expect(input.stage).toBe('revision');
    expect(calls.some((call) => call.role === 'check')).toBe(true);
    expect(calls.some((call) => Array.isArray(call.argv) && call.argv[2] === 'create')).toBe(false);
    expect(git(f.published, 'branch', '--show-current')).toBe(publicBranch);
    expect(
      git(f.published, 'for-each-ref', '--format=%(refname)', `refs/heads/${nativeBranch}`),
    ).toBe('');
    expect(await Promise.all([formalTree(f.prior, true), formalTree(f.checkout)])).toEqual(before);
  } finally {
    await f.dispose();
  }
}, 60000);
