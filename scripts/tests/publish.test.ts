import assert from 'node:assert/strict';
import { test, expect, afterEach } from 'bun:test';
import { realpath, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withInterrupts } from '../correction.ts';
import { publish } from '../publish.ts';
import { readTarget } from '../target.ts';
import { initializeTarget, githubTarget, git } from './support/target.ts';

afterEach(async () => {
  await withInterrupts(async () => {});
});

function targetReply(args: string[], mode: string, users: number) {
  if (args[1] === 'api' && args[2]?.includes('/pulls/')) {
    return JSON.stringify({
      body: mode === 'stale_body' ? 'Previous body' : 'Reviewable body',
      user: {
        login: ['wrong_author', 'created_wrong_author'].includes(mode)
          ? 'old-app[bot]'
          : 'operator',
      },
    });
  }
  if (args[2] === 'user') {
    return JSON.stringify({
      login:
        ['actor_changed', 'existing_actor_changed'].includes(mode) && users > 1
          ? 'other'
          : 'operator',
    });
  }
  const reply = githubTarget(args);
  if (reply !== undefined) {
    return mode === 'denied' ? reply.replace('"push":true', '"push":false') : reply;
  }
}

function publicationReply(args: string[], mode: string, body: string) {
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
    if (mode === 'interrupted') {
      process.emit('SIGINT');
    }
    return ['existing', 'wrong_author', 'stale_body', 'existing_actor_changed'].includes(mode)
      ? 'https://github.com/team/component/pull/1'
      : '';
  }
  expect(args[args.indexOf('--body-file') + 1]).toBe(body);
  expect(args[args.indexOf('--title') + 1]).toBe('Title with spaces');
  if (mode === 'create_failed') {
    throw Error('create_failed');
  }
  return 'https://github.com/team/component/pull/2';
}

for (const mode of [
  'create',
  'existing',
  'stale_body',
  'existing_actor_changed',
  'wrong_author',
  'created_wrong_author',
  'actor_changed',
  'unexpected_actor',
  'denied',
  'empty',
  'create_failed',
  'interrupted',
] as const) {
  test(`publisher: ${mode}`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'publisher-test-')));
    try {
      const repo = join(dir, 'checkout');
      await mkdir(repo);
      await initializeTarget(repo);
      const body = join(dir, 'body with spaces.md');
      await writeFile(body, mode === 'empty' ? '' : 'Reviewable body');
      const publications: string[][] = [];
      let users = 0;
      const io = {
        command: async (args: string[], cwd: string) => {
          if (args[0] === 'git') {
            return git(cwd, ...args.slice(1));
          }
          if (args[2] === 'user') {
            users++;
          }
          const reply = targetReply(args, mode, users);
          if (reply !== undefined) {
            return reply;
          }
          publications.push(args);
          expect(cwd).toBe(repo);
          return publicationReply(args, mode, body);
        },
      };
      const args = [
        '--repo',
        repo,
        '--actor',
        mode === 'unexpected_actor' ? 'other' : 'operator',
        '--head',
        'codex/test',
        '--title',
        'Title with spaces',
        '--body-file',
        body,
      ];
      if (['create', 'existing'].includes(mode)) {
        const result = await withInterrupts(() => publish(args, io));
        expect(result).toBe(
          `https://github.com/team/component/pull/${mode === 'existing' ? 1 : 2}`,
        );
      } else {
        assert(mode !== 'create' && mode !== 'existing');
        const reasons = {
          stale_body: /Existing PR body differs/,
          existing_actor_changed: /GitHub actor changed/,
          wrong_author: /PR author differs/,
          created_wrong_author: /PR author differs/,
          actor_changed: /GitHub actor changed/,
          unexpected_actor: /GitHub actor changed/,
          denied: /push permission required/,
          empty: /body must not be empty/,
          create_failed: /create_failed/,
          interrupted: /Interrupted execution/,
        };
        await assert.rejects(() => withInterrupts(() => publish(args, io)), reasons[mode]);
      }
      expect(publications.map((args) => args[2])).toEqual(
        ['unexpected_actor', 'denied', 'empty'].includes(mode)
          ? []
          : ['create', 'create_failed', 'created_wrong_author'].includes(mode)
            ? ['list', 'create']
            : ['list'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('publisher CLI rejects missing target before touching credentials', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../publish.ts')], {
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Publish failed: Required: --repo CHECKOUT');
});

test('publisher rejects another GitHub host before invoking commands', async () => {
  const previous = process.env.GH_HOST;
  process.env.GH_HOST = 'github.example.invalid';
  let calls = 0;
  try {
    await assert.rejects(
      () =>
        readTarget('/nonexistent', async () => {
          calls++;
          throw Error('unexpected command');
        }),
      /GH_HOST must be github.com/,
    );
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) {
      delete process.env.GH_HOST;
    } else {
      process.env.GH_HOST = previous;
    }
  }
});
