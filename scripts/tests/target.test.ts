import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeTarget, git, githubTarget, targetConfig } from './support/target.ts';
import { readTarget, pushArguments, issueNumber } from '../target.ts';

test('push uses the verified HTTPS target despite pushInsteadOf and rejects insteadOf', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'push-target-'));
  try {
    await initializeTarget(cwd);
    git(cwd, 'config', 'remote.upstream.pushurl', 'git@github.com:team/component.git');
    git(cwd, 'config', 'url.git@github.com:other/.pushInsteadOf', 'https://github.com/team/');
    const read = async (argv: string[]) => git(cwd, ...argv.slice(1));
    expect(git(cwd, 'remote', 'get-url', '--push', 'upstream')).toBe(
      'git@github.com:team/component.git',
    );
    const args = await pushArguments('team/component', 'codex/test', cwd, read);
    const options = args.slice(1, args.indexOf('push'));
    expect(git(cwd, ...options, 'ls-remote', '--get-url', 'dotagents-publish')).toBe(
      'https://github.com/team/component.git',
    );
    expect(args.slice(-2)).toEqual(['dotagents-publish', 'codex/test:refs/heads/codex/test']);
    // Resolve the actual push transport, but forbid it before any network access.
    const probe = spawnSync(
      'git',
      [
        ...options,
        '-c',
        'protocol.https.allow=never',
        'push',
        '--dry-run',
        'dotagents-publish',
        'HEAD:refs/heads/codex/test',
      ],
      { cwd, encoding: 'utf8', timeout: 10000 },
    );
    expect(probe.status).toBe(128);
    expect(probe.stderr).toContain("transport 'https' not allowed");

    git(cwd, 'config', 'url.git@github.com:other/.insteadOf', 'https://github.com/team/');
    await assert.rejects(
      () => pushArguments('team/component', 'codex/test', cwd, read),
      /Effective push URL/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target preserves empty and whitespace command arguments', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'target-argv-'));
  try {
    const settings = { ...targetConfig, setup: [['printf', '%s', '']], check: ['tr', ' ', '_'] };
    await initializeTarget(cwd, settings);
    const target = await readTarget(
      cwd,
      async (argv) => githubTarget(argv) ?? git(cwd, ...argv.slice(1)),
    );
    expect(target.config.setup).toEqual(settings.setup);
    expect(target.config.check).toEqual(settings.check);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Issue identifiers accept exact supported forms, never embedded URLs', () => {
  for (const input of ['12', '#12', 'https://github.com/team/component/issues/12']) {
    expect(issueNumber(input, 'team/component')).toBe('12');
  }
  for (const input of [
    '1https://github.com/team/component/issues/2',
    'https://github.com/other/component/issues/12',
    'https://github.com/team/component/issues/#12',
  ]) {
    expect(() => issueNumber(input, 'team/component')).toThrow(
      'Issue does not match target repository',
    );
  }
});

test('branch publication does not publish reachable annotated tags from user push settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'push-refs-'));
  const cwd = join(root, 'checkout'),
    remote = join(root, 'remote.git');
  try {
    await mkdir(cwd);
    await mkdir(remote);
    await initializeTarget(cwd);
    git(remote, 'init', '--bare');
    git(cwd, 'switch', '-c', 'codex/test');
    git(cwd, 'tag', '-a', 'unpublished-release', '-m', 'Keep this tag local');
    git(cwd, 'config', 'push.followTags', 'true');
    const args = await pushArguments('team/component', 'codex/test', cwd, async (argv) =>
      git(cwd, ...argv.slice(1)),
    );
    // Substitute only the transport destination so real ref publication stays local.
    const local = args
      .slice(1)
      .map((arg) => arg.replace('https://github.com/team/component.git', remote));
    local.splice(local.indexOf('push'), 0, '-c', 'protocol.file.allow=always');
    git(cwd, ...local);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/codex/test');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CI check policy must be explicit with unique nonempty names', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ci-policy-'));
  try {
    await initializeTarget(cwd);
    const read = async (argv: string[]) => githubTarget(argv) ?? git(cwd, ...argv.slice(1));
    for (const ciChecks of [undefined, [''], ['checks', 'checks']]) {
      await writeFile(join(cwd, '.dotagents.json'), JSON.stringify({ ...targetConfig, ciChecks }));
      await assert.rejects(() => readTarget(cwd, read), /Explicit unique CI check names/);
    }
    await writeFile(
      join(cwd, '.dotagents.json'),
      JSON.stringify({ ...targetConfig, ciChecks: [] }),
    );
    expect((await readTarget(cwd, read)).config.ciChecks).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target validates writing paths before execution and preserves explicit selection', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'writing-policy-'));
  try {
    await initializeTarget(cwd);
    const read = async (argv: string[]) => githubTarget(argv) ?? git(cwd, ...argv.slice(1));
    for (const writing of [
      null,
      { documents: ['../outside/'] },
      { documents: ['/docs/'] },
      { documents: ['docs/**/*.md'] },
      { documents: ['docs/'], exclude: 'issues/' },
      { documents: ['docs/'], excludes: ['docs/request.md'] },
    ]) {
      await writeFile(join(cwd, '.dotagents.json'), JSON.stringify({ ...targetConfig, writing }));
      await assert.rejects(() => readTarget(cwd, read), /Invalid writing selection/);
    }
    for (const writing of [
      { documents: ['manual/', 'README.md'], exclude: ['manual/request.md'] },
      { documents: [] },
    ]) {
      await writeFile(join(cwd, '.dotagents.json'), JSON.stringify({ ...targetConfig, writing }));
      expect((await readTarget(cwd, read)).config.writing).toEqual(writing);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
