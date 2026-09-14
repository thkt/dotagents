import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  realpath,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  readdir,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { session } from '../discovery-input.ts';

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
const entry = resolve(import.meta.dir, '../discovery.ts');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function cli(...args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 10000 });
}
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'discovery-test-')));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init');
  const criteriaFile = join(root, 'criteria.json');
  const rules = {
    purpose: 'Is the purpose known?',
    evidence: 'Can evidence support the next decision?',
  };
  await writeFile(criteriaFile, JSON.stringify(rules));
  const config = {
    repo,
    contextDir: join(root, 'context'),
    task: 'trial',
    referencePaths: ['README.md'],
    criteriaFile,
    request: 'Make reset understandable',
  };
  const configFile = join(root, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const started = cli('start', configFile);
  expect(started.status).toBe(0);
  const dir = started.stdout.trim();
  const file = join(root, 'input.json');
  const state = async () => {
    const value: unknown = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    session(value);
    return value;
  };
  const send = async (action: string, value: unknown) => {
    await writeFile(file, JSON.stringify(value));
    return cli(action, dir, file);
  };
  const evaluate = async (missing = false) =>
    send('assess', {
      revision: (await state()).revision,
      decision: 'Choose reset behavior',
      checks: {
        purpose: { status: 'sufficient', reason: 'Request identifies the intended user result' },
        evidence: {
          status: missing ? 'missing' : 'sufficient',
          reason: missing
            ? 'Need user preference for scope'
            : 'Existing behavior and proposed scope checked',
        },
      },
      next: missing
        ? 'Stop UI implementation; obtain scope then reassess'
        : 'Prepare the scoped proposal',
    });
  return { root, repo, config, configFile, dir, file, state, send, evaluate };
}

test('decisions and evidence require reassessment before progress', async () => {
  const t = await setup();
  expect(cli('gate', t.dir).status).toBe(1);
  const report = join(t.root, 'notes.md');
  await writeFile(report, 'Existing reset behavior verified against source revision abc.');
  expect(cli('note', t.dir, report).status).toBe(0);
  expect((await t.evaluate(true)).status).toBe(0);
  expect(cli('gate', t.dir).status).toBe(1);
  await writeFile(
    report,
    'Agreed: retain focus for repeated searches; owner: requester; scope: reset control.',
  );
  expect(cli('note', t.dir, report).status).toBe(0);
  expect(cli('status', t.dir).status).toBe(0);
  expect(cli('gate', t.dir).status).toBe(1);
  expect((await t.evaluate()).status).toBe(0);
  expect(cli('gate', t.dir).status).toBe(0);
  const completed = await t.state();
  expect(completed.entries.some((item) => item.text.includes('source revision abc'))).toBe(true);
  expect(completed.entries.some((item) => item.text.includes('Agreed: retain focus'))).toBe(true);
  expect(cli('note', t.dir, report).status).toBe(0);
  expect(cli('gate', t.dir).status).toBe(1);
});

test('all criteria and current revision are required; inputs do not replace saved criteria', async () => {
  const t = await setup();
  const originalCriteria = (await t.state()).criteria;
  await writeFile(t.config.criteriaFile, '{}');
  for (const checks of [
    {},
    {
      purpose: { status: 'sufficient', reason: 'known' },
      evidence: { status: ['missing'], reason: 'Need more evidence' },
    },
    {
      purpose: { status: 'sufficient', reason: 'known' },
      evidence: { status: 'sufficient', reason: '' },
    },
  ]) {
    expect(
      (await t.send('assess', { revision: 0, decision: 'Choose', checks, next: 'Continue' }))
        .status,
    ).toBe(1);
  }
  expect((await t.evaluate()).status).toBe(0);
  const before = await t.state();
  expect((await t.send('assess', before.assessment)).status).toBe(1);
  expect(await t.state()).toEqual(before);
  expect(before.criteria).toEqual(originalCriteria);
});

test('research archiving requires sufficient context and preserves existing records', async () => {
  const t = await setup();
  const report = join(t.root, 'report.md');
  await writeFile(report, 'Question, current sources, conclusion and unresolved scope.');
  expect(cli('archive', t.dir, report).status).toBe(1);
  expect((await t.evaluate()).status).toBe(0);
  const saved = cli('archive', t.dir, report);
  expect(saved.status).toBe(0);
  expect(cli('archive', t.dir, report).stdout).toBe(saved.stdout);
  expect(await readFile(saved.stdout.trim(), 'utf8')).toContain('current sources');
  expect(await readdir(join(t.config.contextDir, 'research'))).toHaveLength(1);
});

test('existing tasks, mismatched repositories and context inside checkout are rejected', async () => {
  const t = await setup();
  const before = await t.state();
  expect(cli('start', t.configFile).status).toBe(1);
  const other = join(t.root, 'other');
  await mkdir(other);
  const invalid = [
    [{ repo: other }, /not a git repository/],
    [{ contextDir: join(t.repo, 'private') }, /Context must be outside/],
    [{ referencePaths: ['../outside.md'] }, /Reference must be repo-relative/],
    [{ task: '../escape' }, /Invalid task ID/],
  ] as const;
  for (const [index, [override, reason]] of invalid.entries()) {
    await writeFile(
      t.configFile,
      JSON.stringify({ ...t.config, task: `invalid-${index}`, ...override }),
    );
    const stopped = cli('start', t.configFile);
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toMatch(reason);
    expect(await readdir(join(t.config.contextDir, 'work'))).toEqual(['trial']);
  }
  const link = join(t.root, 'linked');
  await symlink(t.repo, link);
  await writeFile(t.configFile, JSON.stringify({ ...t.config, contextDir: link }));
  expect(cli('start', t.configFile).status).toBe(1);
  expect(await t.state()).toEqual(before);
});

test('lock and unfinished save block even a previously sufficient evaluation', async () => {
  const t = await setup();
  expect((await t.evaluate()).status).toBe(0);
  const before = await t.state();
  await mkdir(join(t.dir, 'lock'));
  expect(cli('gate', t.dir).status).toBe(1);
  expect((await t.evaluate()).status).toBe(1);
  await rm(join(t.dir, 'lock'), { recursive: true });
  await mkdir(join(t.dir, 'state.json.tmp'));
  expect((await t.evaluate()).status).toBe(1);
  expect(await t.state()).toEqual(before);
  expect(cli('gate', t.dir).status).toBe(1);
});

test('corrupt saved state does not pass the gate', async () => {
  const t = await setup();
  await writeFile(join(t.dir, 'state.json'), '{"assessment":"accepted"}');
  expect(cli('gate', t.dir).status).toBe(1);
  expect(await readFile(join(t.dir, 'state.json'), 'utf8')).toBe('{"assessment":"accepted"}');
});

test('question-tracking sessions are preserved and cannot silently pass the gate', async () => {
  const t = await setup();
  expect((await t.evaluate()).status).toBe(0);
  const current = await t.state();
  const previous = JSON.stringify({ ...current, question: null });
  await writeFile(join(t.dir, 'state.json'), previous);
  expect(cli('gate', t.dir).status).toBe(1);
  expect(await readFile(join(t.dir, 'state.json'), 'utf8')).toBe(previous);
});

test('symlinked work and research storage cannot redirect writes', async () => {
  const t = await setup();
  const archive = join(t.config.contextDir, 'research');
  await symlink(t.repo, archive);
  await writeFile(t.file, 'Report');
  expect((await t.evaluate()).status).toBe(0);
  expect(cli('archive', t.dir, t.file).status).toBe(1);
  const work = join(t.config.contextDir, 'work');
  await rm(work, { recursive: true });
  await symlink(t.repo, work);
  expect(cli('start', t.configFile).status).toBe(1);
  expect(await readdir(t.repo)).toEqual(['.git']);
});

for (const binding of ['git-directory', 'checkout']) {
  test(
    binding === 'checkout'
      ? 'legacy checkout binding accepts a linked worktree'
      : 'worktrees share research and keep task assessments separate',
    async () => {
      const t = await setup();
      git(
        t.repo,
        '-c',
        'user.name=Trial',
        '-c',
        'user.email=trial@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      );
      const linked = join(t.root, 'linked');
      git(t.repo, 'worktree', 'add', '--detach', linked);
      if (binding === 'checkout') {
        await writeFile(join(t.config.contextDir, 'repository.txt'), t.repo);
        await writeFile(
          t.configFile,
          JSON.stringify({ ...t.config, repo: linked, task: 'legacy' }),
        );
        const started = cli('start', t.configFile);
        expect(started.status).toBe(0);
        expect(cli('gate', started.stdout.trim()).status).toBe(1);
        return;
      }
      await writeFile(t.file, 'Reusable finding with source and scope.');
      expect((await t.evaluate()).status).toBe(0);
      const report = cli('archive', t.dir, t.file);
      expect(report.status).toBe(0);
      const archived = await readFile(report.stdout.trim(), 'utf8');
      const before = await t.state();
      await writeFile(t.configFile, JSON.stringify({ ...t.config, repo: linked, task: 'next' }));
      const started = cli('start', t.configFile);
      expect(started.status).toBe(0);
      const next: unknown = JSON.parse(cli('status', started.stdout.trim()).stdout);
      session(next);
      expect(next.repo).toBe(linked);
      expect(next.referencePaths).toEqual(['README.md']);
      expect(next.entries).toEqual([]);
      expect(cli('gate', started.stdout.trim()).status).toBe(1);
      expect(await t.state()).toEqual(before);
      expect(await readFile(report.stdout.trim(), 'utf8')).toBe(archived);
      expect(await readdir(join(t.config.contextDir, 'research'))).toHaveLength(1);
      const clone = join(t.root, 'clone');
      git(t.root, 'clone', t.repo, clone);
      await writeFile(t.configFile, JSON.stringify({ ...t.config, repo: clone, task: 'clone' }));
      expect(cli('start', t.configFile).status).toBe(1);
    },
  );
}

test('continuing operations reject a different repository at the saved checkout path', async () => {
  const t = await setup();
  git(t.repo, 'config', 'user.name', 'Test');
  git(t.repo, 'config', 'user.email', 'test@example.com');
  git(t.repo, 'commit', '--allow-empty', '-m', 'base');
  const checkout = join(t.root, 'linked');
  git(t.repo, 'worktree', 'add', '--detach', checkout);
  await writeFile(t.configFile, JSON.stringify({ ...t.config, repo: checkout, task: 'linked' }));
  const started = cli('start', t.configFile);
  expect(started.status).toBe(0);
  const dir = started.stdout.trim();
  await t.evaluate();
  await writeFile(t.file, JSON.stringify((await t.state()).assessment));
  expect(cli('assess', dir, t.file).status).toBe(0);
  const before = await readFile(join(dir, 'state.json'), 'utf8');
  await rename(checkout, join(t.root, 'preserved'));
  await mkdir(checkout);
  git(checkout, 'init');
  const note = join(t.root, 'note.md');
  await writeFile(note, 'Different repository');
  for (const args of [
    ['gate', dir],
    ['note', dir, note],
    ['archive', dir, note],
  ]) {
    const result = cli(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Context belongs to another repository');
  }
  expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(before);
  expect(await readdir(t.config.contextDir)).not.toContain('research');
});
