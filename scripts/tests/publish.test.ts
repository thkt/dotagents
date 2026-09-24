import assert from 'node:assert/strict';
import { test, expect, afterEach } from 'bun:test';
import { realpath, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withInterrupts } from '../process.ts';
import { publish, publishCli, checkPublishedPr, PublicationError } from '../publish.ts';
import { readTarget } from '../target.ts';
import { isRecord } from '../values.ts';
import { initializeTarget, githubTarget, git } from './support/target.ts';

afterEach(async () => {
  await withInterrupts(async () => {});
});

function publishedReply(args: string[], mode: string, commit: string) {
  return JSON.stringify({
    html_url: `https://github.com/team/component/pull/${args[2]?.split('/').at(-1)}`,
    state: 'open',
    draft: !['created_ready', 'existing_ready'].includes(mode),
    head: {
      ref: 'codex/test',
      sha: mode === 'wrong_head' ? 'changed' : commit,
      repo: { full_name: 'team/component' },
    },
    base: {
      ref: mode === 'wrong_base' ? 'main' : 'release',
      repo: { full_name: 'team/component' },
    },
    body: mode === 'stale_body' ? 'Previous body' : 'Reviewable body',
    user: {
      login: ['wrong_author', 'created_wrong_author'].includes(mode) ? 'old-app[bot]' : 'operator',
    },
  });
}

test('publication readback rejects malformed REST identity without losing the known URL', async () => {
  const input = {
    cwd: '/unused',
    repository: 'team/component',
    url: 'https://github.com/team/component/pull/2',
    actor: 'operator',
    body: 'Reviewable body',
    head: 'codex/test',
    base: 'release',
    commit: 'verified',
  };
  const response: unknown = JSON.parse(
    publishedReply(['gh', 'api', 'pulls/2'], 'create', input.commit),
  );
  assert(isRecord(response));
  for (const [patch, reason] of [
    [{ user: null }, /PR author differs/],
    [{ state: 'OPEN' }, /Published PR target differs/],
    [{ head: { ref: input.head, sha: input.commit } }, /Published PR target differs/],
    [
      { base: { ref: input.base, repo: { full_name: 'other/repo' } } },
      /Published PR target differs/,
    ],
    [{ draft: undefined }, /not confirmed draft/],
    [{ draft: 'true' }, /not confirmed draft/],
    [{ body: null }, /Existing PR body differs/],
  ] as const) {
    await assert.rejects(
      () => checkPublishedPr(input, async () => JSON.stringify({ ...response, ...patch })),
      (error: unknown) => {
        assert(error instanceof PublicationError);
        expect(error.url).toBe(input.url);
        assert.match(error.message, reason);
        return true;
      },
    );
  }
});

function targetReply(args: string[], mode: string, users: number, commit: string) {
  if (args[1] === 'api' && args[2]?.includes('/pulls/')) {
    return publishedReply(args, mode, commit);
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
    return [
      'existing',
      'wrong_author',
      'stale_body',
      'existing_actor_changed',
      'existing_ready',
    ].includes(mode)
      ? 'https://github.com/team/component/pull/1'
      : '';
  }
  expect(args).toContain('--draft');
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
  'created_ready',
  'existing_ready',
  'wrong_head',
  'wrong_base',
  'interrupted',
] as const) {
  test(`publisher: ${mode}`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'publisher-test-')));
    try {
      const repo = join(dir, 'checkout');
      await mkdir(repo);
      await initializeTarget(repo);
      const commit = git(repo, 'rev-parse', 'HEAD');
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
          const reply = targetReply(args, mode, users, commit);
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
        const result = await withInterrupts(() =>
          mode === 'create'
            ? publish(
                {
                  cwd: repo,
                  actor: 'operator',
                  head: 'codex/test',
                  title: 'Title with spaces',
                  bodyFile: body,
                },
                io,
              )
            : publishCli(args, io),
        );
        expect(result).toBe(
          `https://github.com/team/component/pull/${mode === 'existing' ? 1 : 2}`,
        );
      } else {
        assert(mode !== 'create' && mode !== 'existing');
        const reasons = {
          created_ready: /not confirmed draft/,
          existing_ready: /not confirmed draft/,
          wrong_head: /Published PR target differs/,
          wrong_base: /Published PR target differs/,
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
        await assert.rejects(
          () => withInterrupts(() => publishCli(args, io)),
          (error: unknown) => {
            assert(error instanceof Error);
            assert.match(error.message, reasons[mode]);
            if (mode === 'created_ready') {
              assert(error instanceof PublicationError);
              assert.equal(error.url, 'https://github.com/team/component/pull/2');
            }
            return true;
          },
        );
      }
      expect(publications.map((args) => args[2])).toEqual(
        ['unexpected_actor', 'denied', 'empty'].includes(mode)
          ? []
          : [
                'create',
                'create_failed',
                'created_wrong_author',
                'created_ready',
                'wrong_head',
                'wrong_base',
              ].includes(mode)
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

test('publisher CLI rejects invalid arguments before invoking commands', async () => {
  const args = [
    '--repo',
    '/unused',
    '--head',
    'topic',
    '--title',
    'Title',
    '--body-file',
    '/unused.md',
  ];
  let calls = 0;
  const io = {
    command: async () => {
      calls++;
      throw Error('unexpected command');
    },
  };
  for (const [input, reason] of [
    [[...args, '--unknown'], /Unknown option/],
    [[...args, '--title', '   '], /Required:/],
    [[...args, '--head'], /argument missing/],
  ] as const) {
    await assert.rejects(() => publishCli([...input], io), reason);
  }
  expect(calls).toBe(0);
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
