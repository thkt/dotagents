import assert from 'node:assert/strict';
import { test, expect, afterEach } from 'bun:test';
import { realpath, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withInterrupts } from '../shared/process.ts';
import { publish, publishCli, checkPublishedPr, PublicationError } from '../implement/publish.ts';
import { readTarget } from '../shared/target.ts';
import { initializeTarget, githubTarget, git } from './support/target.ts';

afterEach(async () => {
  await withInterrupts(async () => {});
});

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

function testPublisher(
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

testPublisher('create', async (f, io) => {
  expect(await withInterrupts(() => publish(f.input, io))).toBe(
    'https://github.com/team/component/pull/2',
  );
  expect(f.publications).toEqual(['list', 'create']);
});

testPublisher('existing', async (f, io) => {
  f.existing = 'https://github.com/team/component/pull/1';
  expect(await withInterrupts(() => publishCli(f.args, io))).toBe(f.existing);
  expect(f.publications).toEqual(['list']);
});

testPublisher('stale_body', async (f, io) => {
  f.existing = 'https://github.com/team/component/pull/1';
  f.pr.body = 'Previous body';
  await assert.rejects(
    () => withInterrupts(() => publishCli(f.args, io)),
    /Existing PR body differs/,
  );
  expect(f.publications).toEqual(['list']);
});

for (const [name, existing, publications] of [
  ['actor_changed', '', ['list']],
  ['existing_actor_changed', 'https://github.com/team/component/pull/1', ['list']],
] as const) {
  testPublisher(name, async (f, io) => {
    f.existing = existing;
    const github = f.github;
    let users = 0;
    f.github = async (args) => {
      if (args[2] === 'user' && ++users > 1) {
        return JSON.stringify({ login: 'other' });
      }
      return github(args);
    };
    await assert.rejects(
      () => withInterrupts(() => publishCli(f.args, io)),
      /GitHub actor changed/,
    );
    expect(f.publications).toEqual([...publications]);
  });
}

for (const [name, existing, publications] of [
  ['wrong_author', 'https://github.com/team/component/pull/1', ['list']],
  ['created_wrong_author', '', ['list', 'create']],
] as const) {
  testPublisher(name, async (f, io) => {
    f.existing = existing;
    f.pr.user.login = 'old-app[bot]';
    await assert.rejects(() => withInterrupts(() => publishCli(f.args, io)), /PR author differs/);
    expect(f.publications).toEqual([...publications]);
  });
}

testPublisher('unexpected_actor', async (f, io) => {
  f.args[f.args.indexOf('--actor') + 1] = 'other';
  await assert.rejects(() => withInterrupts(() => publishCli(f.args, io)), /GitHub actor changed/);
  expect(f.publications).toEqual([]);
});

testPublisher('denied', async (f, io) => {
  const github = f.github;
  f.github = async (args) => (await github(args)).replace('"push":true', '"push":false');
  await assert.rejects(
    () => withInterrupts(() => publishCli(f.args, io)),
    /push permission required/,
  );
  expect(f.publications).toEqual([]);
});

testPublisher('empty', async (f, io) => {
  await writeFile(f.body, '');
  await assert.rejects(
    () => withInterrupts(() => publishCli(f.args, io)),
    /body must not be empty/,
  );
  expect(f.publications).toEqual([]);
});

testPublisher('create_failed', async (f, io) => {
  const github = f.github;
  f.github = async (args) => {
    const reply = await github(args);
    if (args[2] === 'create') {
      throw Error('create_failed');
    }
    return reply;
  };
  await assert.rejects(() => withInterrupts(() => publishCli(f.args, io)), /create_failed/);
  expect(f.publications).toEqual(['list', 'create']);
});

testPublisher('created_ready', async (f, io) => {
  f.pr.draft = false;
  await assert.rejects(
    () => withInterrupts(() => publishCli(f.args, io)),
    (error: unknown) => {
      assert(error instanceof PublicationError);
      assert.match(error.message, /not confirmed draft/);
      assert.equal(error.url, 'https://github.com/team/component/pull/2');
      return true;
    },
  );
  expect(f.publications).toEqual(['list', 'create']);
});

testPublisher('existing_ready', async (f, io) => {
  f.existing = 'https://github.com/team/component/pull/1';
  f.pr.draft = false;
  await assert.rejects(() => withInterrupts(() => publishCli(f.args, io)), /not confirmed draft/);
  expect(f.publications).toEqual(['list']);
});

for (const [name, change] of [
  [
    'wrong_head',
    (pr: Awaited<ReturnType<typeof fixture>>['f']['pr']) => {
      pr.head.sha = 'changed';
    },
  ],
  [
    'wrong_base',
    (pr: Awaited<ReturnType<typeof fixture>>['f']['pr']) => {
      pr.base.ref = 'main';
    },
  ],
] as const) {
  testPublisher(name, async (f, io) => {
    change(f.pr);
    await assert.rejects(
      () => withInterrupts(() => publishCli(f.args, io)),
      /Published PR target differs/,
    );
    expect(f.publications).toEqual(['list', 'create']);
  });
}

testPublisher('malformed_rest_identity', async (f) => {
  const input = {
    cwd: f.repo,
    repository: 'team/component',
    url: 'https://github.com/team/component/pull/2',
    actor: 'operator',
    body: 'Reviewable body',
    head: 'codex/test',
    base: 'release',
    commit: f.pr.head.sha,
  };
  const response = { ...f.pr, html_url: input.url };
  for (const [patch, reason] of [
    [{ user: null }, /PR author differs/],
    [{ state: 'OPEN' }, /Published PR target differs/],
    [{ head: { ref: input.head, sha: input.commit } }, /Published PR target differs/],
    [
      { head: { ref: 'codex/other', sha: input.commit, repo: { full_name: 'team/component' } } },
      /Published PR target differs/,
    ],
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

testPublisher('interrupted', async (f, io) => {
  const github = f.github;
  f.github = async (args) => {
    const reply = await github(args);
    if (args[2] === 'list') {
      process.emit('SIGINT');
    }
    return reply;
  };
  await assert.rejects(() => withInterrupts(() => publishCli(f.args, io)), /Interrupted execution/);
  expect(f.publications).toEqual(['list']);
});

test('publisher CLI rejects missing target before touching credentials', () => {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dir, '../implement/publish.ts')],
    {
      encoding: 'utf8',
      timeout: 10000,
    },
  );
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
