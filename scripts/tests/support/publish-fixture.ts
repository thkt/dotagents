import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { realpath, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeTarget, githubTarget, git } from './target.ts';

async function fixture(dir: string) {
  const repo = join(dir, 'checkout');
  await mkdir(repo);
  await initializeTarget(repo);
  const commit = git(repo, 'rev-parse', 'HEAD');
  const body = join(dir, 'body with spaces.md');
  await writeFile(body, 'Reviewable body');
  const pr = {
    state: 'open',
    draft: true,
    head: { ref: 'codex/test', sha: commit, repo: { full_name: 'team/component' } },
    base: { ref: 'release', repo: { full_name: 'team/component' } },
    body: 'Reviewable body',
    user: { login: 'operator' },
  };
  const publications: string[] = [];
  const f = {
    repo,
    body,
    pr,
    publications,
    existing: '',
    input: {
      cwd: repo,
      actor: 'operator',
      head: 'codex/test',
      commit,
      title: 'Title with spaces',
      bodyFile: body,
    },
    args: [
      '--repo',
      repo,
      '--actor',
      'operator',
      '--head',
      'codex/test',
      '--commit',
      commit,
      '--title',
      'Title with spaces',
      '--body-file',
      body,
    ],
    github: async (args: string[]): Promise<string> => {
      if (args[1] === 'api' && args[2]?.includes('/pulls/')) {
        return JSON.stringify({
          ...pr,
          html_url: `https://github.com/team/component/pull/${args[2].split('/').at(-1)}`,
        });
      }
      const reply = githubTarget(args);
      if (reply !== undefined) {
        return reply;
      }
      expect(args.slice(0, 2)).toEqual(['gh', 'pr']);
      for (const [flag, value] of [
        ['--repo', 'team/component'],
        ['--head', 'codex/test'],
        ['--base', 'release'],
      ]) {
        assert(flag);
        expect(args[args.indexOf(flag) + 1]).toBe(value);
      }
      if (args[2] === 'list') {
        return f.existing;
      }
      expect(args).toContain('--draft');
      expect(args[args.indexOf('--body-file') + 1]).toBe(body);
      expect(args[args.indexOf('--title') + 1]).toBe('Title with spaces');
      return 'https://github.com/team/component/pull/2';
    },
  };
  const io = {
    command: async (args: string[], cwd: string) => {
      if (args[0] === 'git') {
        return git(cwd, ...args.slice(1));
      }
      if (args[1] === 'pr') {
        assert(args[2]);
        publications.push(args[2]);
        expect(cwd).toBe(repo);
      }
      return f.github(args);
    },
  };
  return { f, io };
}

export function testPublisher(
  name: string,
  check: (
    f: Awaited<ReturnType<typeof fixture>>['f'],
    io: Awaited<ReturnType<typeof fixture>>['io'],
  ) => Promise<void>,
) {
  test(`publisher: ${name}`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'publisher-test-')));
    try {
      const { f, io } = await fixture(dir);
      await check(f, io);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
