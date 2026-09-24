import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { develop } from '../development.ts';
import { publish, publishCli } from '../publish.ts';
import type { PublishInput } from '../publish.ts';
import { run, snapshot } from '../correction.ts';
import { command, withInterrupts } from '../process.ts';
import { assertConfig } from '../input.ts';
import { checkRevision, previousRun } from '../revision.ts';
import { readTarget } from '../target.ts';
import { correctionConfig, reviewReplySource } from './support/correction.ts';
import type { Config, State, Revision } from '../input.ts';
import { isRecord } from '../values.ts';
import { initializeTarget, githubTarget, git, targetConfig } from './support/target.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const issue = JSON.stringify({
  title: 'Visible result',
  body: 'Keep result visible',
  state: 'OPEN',
  updatedAt: '2026-09-20T00:00:00Z',
});
const updatedRequirements = {
  title: 'Visible result with reset',
  body: 'Keep result visible and clear it on reset',
  state: 'OPEN',
  updatedAt: '2026-09-21T00:00:00Z',
};
const updatedIssue = JSON.stringify(updatedRequirements);
const ok = (stdout = '') => ({ stdout, stderr: '', code: 0, timedOut: false, ms: 1 });
const reportPath = 'docs/research/start.md';
const reportContent = 'Reviewed start evidence.\n';

// Real Git and the existing development/publish entry points; only external responses are simulated.
async function fixture(root: string, media = false, setup: string[][] = [], report = false) {
  const repo = join(root, 'repo');
  const prior = join(root, 'prior');
  const dir = join(root, 'revision');
  await mkdir(repo);
  await initializeTarget(repo, {
    ...targetConfig,
    setup,
    capture: media ? { command: ['capture'], destination: 'media', required: true } : null,
  });
  if (report) {
    await mkdir(join(repo, 'docs/research'), { recursive: true });
    await writeFile(join(repo, reportPath), reportContent);
    git(repo, 'add', reportPath);
    git(repo, 'commit', '-m', 'reviewed report');
  }
  const initialBase = git(repo, 'rev-parse', 'HEAD');
  // GitHub does not create closing links from the body for a non-default base.
  const closingIssuesReferences: { url: string }[] = [];
  const pr = {
    url: 'https://github.com/team/component/pull/100',
    state: 'OPEN',
    isDraft: true,
    body: '',
    author: { login: 'operator' },
    headRefName: 'codex/development-99',
    headRefOid: '',
    baseRefName: 'release',
    headRepository: { name: 'component' },
    headRepositoryOwner: { login: 'team' },
    isCrossRepository: false,
    closingIssuesReferences,
    statusCheckRollup: [{ name: 'checks', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const request = join(root, 'request.md');
  await writeFile(
    request,
    'Adopted review: reset must clear the result. Scope: reset only. Source: human review #100.',
  );
  const hooks: {
    issueText: string;
    implementations: number;
    pushes: number;
    edits: number;
    verifications: number;
    beforeVerify?: () => Promise<void>;
    beforeActor?: () => Promise<void>;
  } = {
    issueText: issue,
    implementations: 0,
    pushes: 0,
    edits: 0,
    verifications: 0,
  };
  let remoteHead = '';
  const commands: { argv: string[]; cwd: string }[] = [];
  const publicationCommands: string[][] = [];
  async function gitCommand(argv: string[], cwd: string, input: string, timeout: number | null) {
    if (argv.includes('push')) {
      if (hooks.pushes) {
        expect(pr.isDraft).toBe(true);
      }
      hooks.pushes++;
      remoteHead = git(cwd, 'rev-parse', 'HEAD');
      pr.headRefOid = remoteHead;
      return ok();
    }
    return command(argv, cwd, input, timeout);
  }
  async function editPr(argv: string[]) {
    if (argv.includes('--attach')) {
      pr.body += '\nhttps://example.com/revision.png';
      return ok();
    }
    expect(pr.isDraft).toBe(true);
    hooks.edits++;
    const body = argv[argv.indexOf('--body-file') + 1];
    assert(body);
    pr.body = await readFile(body, 'utf8');
    return ok();
  }
  function undoDraft(argv: string[]) {
    expect(argv).toEqual(['gh', 'pr', 'ready', pr.url, '--repo', 'team/component', '--undo']);
    expect(hooks.pushes).toBe(1);
    pr.isDraft = true;
    return ok();
  }
  function branchPulls() {
    if (hooks.implementations < 2) {
      return [[]];
    }
    const pages = [
      [
        {
          html_url: pr.url,
          head: { ref: pr.headRefName, repo: { full_name: 'team/component' } },
          base: { ref: pr.baseRefName },
          draft: pr.isDraft,
        },
      ],
    ];
    return pages;
  }
  async function githubCommand(argv: string[]) {
    switch (`${argv[1]}/${argv[2]}`) {
      case 'issue/view':
        return ok(hooks.issueText);
      case 'pr/view':
        return ok(JSON.stringify(pr));
      case 'api/repos/team/component/pulls':
        expect(argv).toEqual([
          'gh',
          'api',
          'repos/team/component/pulls',
          '--method',
          'GET',
          '-f',
          'state=open',
          '-f',
          'head=team:codex/development-99',
          '--paginate',
          '--slurp',
        ]);
        return ok(JSON.stringify(branchPulls()));
      case 'pr/ready':
        return undoDraft(argv);
      case 'pr/edit':
        return editPr(argv);
      default:
        if (argv[2]?.includes('/git/ref/')) {
          return ok(JSON.stringify({ object: { sha: remoteHead } }));
        }
        const reply = githubTarget(argv);
        assert(reply !== undefined, `Unexpected GitHub fixture command: ${argv.join(' ')}`);
        return ok(reply);
    }
  }

  async function implementOriginal(cwd: string) {
    await writeFile(join(cwd, 'original-pr.txt'), 'original issue deliverable');
    if (report) {
      const original = await readFile(join(cwd, reportPath), 'utf8');
      await writeFile(join(cwd, reportPath), original + 'Published evidence revision.\n');
    }
  }
  async function actor(cwd: string, input: string) {
    hooks.implementations++;
    if (hooks.implementations === 1) {
      await implementOriginal(cwd);
    }
    if (hooks.implementations > 1) {
      await hooks.beforeActor?.();
      expect(input).toContain(await readFile(request, 'utf8'));
      expect(input).toContain(pr.body);
      if (media) {
        await mkdir(join(cwd, 'media'));
        await writeFile(join(cwd, 'media/result.png'), 'simulated capture');
      }
    }
    await writeFile(
      join(cwd, 'result.txt'),
      hooks.implementations === 1 ? 'implemented' : 'reset corrected',
    );
    return ok(JSON.stringify({ status: 'repaired', findings: 'Changed requested behavior' }));
  }
  const io = {
    command: async (argv: string[], cwd: string, input: string, timeout: number | null) => {
      commands.push({ argv, cwd });
      if (argv[0] === 'git') {
        return gitCommand(argv, cwd, input, timeout);
      }
      if (argv[0] === 'gh') {
        return githubCommand(argv);
      }
      if (argv.includes('repair')) {
        return actor(cwd, input);
      }
      throw Error(`Unexpected fixture command: ${argv.join(' ')}`);
    },
    verify: async (config: Config): Promise<State> => {
      hooks.verifications++;
      await hooks.beforeVerify?.();
      await mkdir(config.runDir, { recursive: true });
      const state: State = {
        reviewFormat: 4,
        baseCommit: config.baseCommit ?? initialBase,
        configHash: hash(JSON.stringify(config)),
        issueFormat: 1,
        issueHash: hash(hooks.issueText.trim()),
        source: await snapshot(config.cwd),
        repair: 0,
        review: 1,
        checks: 1,
        modelMs: 1,
        active: null,
        events: [],
        result: 'ready_for_human_review',
        reviewHistory: [
          {
            status: 'accepted',
            targetId: 'current',
            findings: 'Verified current output',
            assessments: {
              code: `Current change; evidence: ${prior}/verification/check-1.stdout`,
              requirements: 'Issue and adopted reset request satisfied',
              tests: 'Simulated check, live update untested',
              documentation:
                'Current instructions compared. Prior limitation and attachment: https://example.com/media.png',
            },
            items: [],
            documents: [],
            handoff: [],
          },
        ],
      };
      await writeFile(join(config.runDir, 'state.json'), JSON.stringify(state));
      return state;
    },
    publish: async (input: PublishInput): Promise<string> => {
      if (!input.revision) {
        pr.body =
          (await readFile(input.bodyFile, 'utf8')) +
          '\nPrior limitation and attachment: https://example.com/media.png';
        return pr.url;
      }
      return publish(input, {
        command: async (argv, cwd) => {
          publicationCommands.push(argv);
          const result = await io.command(argv, cwd, '', 660000);
          assert(result.code === 0, result.stderr);
          return result.stdout.trim();
        },
      });
    },
  };
  await develop(
    [
      '99',
      '--repo',
      repo,
      '--run-dir',
      prior,
      ...(report
        ? [
            '--start-commit',
            initialBase,
            '--report',
            `${reportPath}=${git(repo, 'rev-parse', `HEAD:${reportPath}`)}`,
          ]
        : []),
    ],
    io,
  );
  commands.length = 0;
  pr.isDraft = false;
  const cwd = join(prior, 'checkout');
  const oldHead = pr.headRefOid;
  const oldBody = pr.body;
  const args = [
    '99',
    '--repo',
    cwd,
    '--previous-run',
    prior,
    '--request-file',
    request,
    '--run-dir',
    dir,
  ];
  return {
    repo,
    cwd,
    prior,
    dir,
    request,
    args,
    io,
    hooks,
    pr,
    oldHead,
    oldBody,
    initialBase,
    commands,
    publicationCommands,
  };
}

async function readObject(path: string) {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(isRecord(value));
  return value;
}

function revisionInput(root: string): Revision {
  return {
    previousRun: join(root, 'previous'),
    runDirectory: join(root, 'current'),
    requestFile: join(root, 'request.txt'),
    request: 'Keep the agreed scope',
    url: 'https://github.com/team/component/pull/100',
    body: 'Closes #99',
    head: 'a'.repeat(40),
    branch: 'codex/revision',
    baseBranch: 'main',
    repository: 'team/component',
    issue: '99',
    issueText: issue,
    actor: 'operator',
    repositoryId: 123,
    targetText: '{}',
    localOnly: false,
  };
}

test('revision rejects missing repository names instead of matching their string coercion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revision-pr-response-'));
  try {
    const revision = revisionInput(root);
    await writeFile(revision.requestFile, revision.request);
    for (const [owner, name] of [
      ['undefined', 'component'],
      ['team', 'undefined'],
    ]) {
      revision.repository = `${owner}/${name}`;
      const pr = {
        url: revision.url,
        state: 'OPEN',
        isDraft: true,
        author: { login: revision.actor },
        headRefName: revision.branch,
        headRefOid: revision.head,
        baseRefName: revision.baseBranch,
        headRepositoryOwner: { login: owner },
        headRepository: { name },
        isCrossRepository: false,
        body: revision.body,
        closingIssuesReferences: [],
      };
      const check = () =>
        checkRevision(
          revision,
          root,
          async (argv) => {
            if (argv[0] === 'git') {
              return revision.branch;
            }
            if (argv[1] === 'pr') {
              return JSON.stringify(pr);
            }
            expect(argv).toEqual([
              'gh',
              'api',
              `repos/${revision.repository}/git/ref/heads/${revision.branch}`,
            ]);
            return JSON.stringify({ object: { sha: revision.head } });
          },
          {
            draft: 'require',
            issue: revision.issueText,
            target: {
              cwd: root,
              config: { ...targetConfig, repository: revision.repository },
              actor: revision.actor,
              repositoryId: revision.repositoryId,
              text: revision.targetText,
            },
          },
        );
      expect(await check()).toBe(revision.body);
      if (owner === 'undefined') {
        pr.headRepositoryOwner.login = undefined;
      } else {
        pr.headRepository.name = undefined;
      }
      await assert.rejects(check, /Revision PR identity changed/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration validates revision input before execution', () => {
  const config = correctionConfig('/revision-config');
  const revision = revisionInput('/revision-config');
  expect(() => assertConfig(config)).not.toThrow();
  expect(() => assertConfig({ ...config, revision })).not.toThrow();
  for (const [value, reason] of [
    [null, /Invalid revision input/],
    [{ ...revision, request: ' ' }, /Invalid revision request/],
    [{ ...revision, head: undefined }, /Invalid revision head/],
    [{ ...revision, repositoryId: '123' }, /Invalid revision target/],
    [{ ...revision, localOnly: 'false' }, /Invalid revision target/],
  ] as const) {
    expect(() => assertConfig({ ...config, revision: value })).toThrow(reason);
  }
});

for (const file of ['result.json', 'verification/state.json']) {
  test(`revision reconciles optional ${file} without swallowing failures`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'revision-records-'));
    try {
      const revision = revisionInput(root);
      const cwd = join(root, 'checkout');
      const sibling = join(root, 'sibling');
      await mkdir(join(sibling, 'verification'), { recursive: true });
      if (file === 'verification/state.json') {
        await writeFile(
          join(sibling, 'result.json'),
          JSON.stringify({ checkout: cwd, reason: 'Stopped', publication: 'not_attempted' }),
        );
      }
      // A later, deliberately changed request identifies successful reconciliation
      // without simulating GitHub or starting the complete development workflow.
      await writeFile(revision.requestFile, 'Changed request');
      let externalReads = 0;
      const check = () =>
        checkRevision(revision, cwd, async () => {
          externalReads++;
          throw new Error('Unexpected external operation');
        });
      const path = join(sibling, file);
      await assert.rejects(check, /Revision request changed/); // ENOENT is optional.
      await writeFile(path, '');
      if (file === 'result.json') {
        await assert.rejects(check, SyntaxError);
      } else {
        await assert.rejects(check, /Revision request changed/); // Empty state stays optional.
      }
      await writeFile(path, '{');
      await assert.rejects(check, SyntaxError);
      expect(await readFile(path, 'utf8')).toBe('{');
      await rm(path);
      await mkdir(path);
      await assert.rejects(check, { code: 'EISDIR' });
      expect(await readdir(path)).toEqual([]);
      expect(await readFile(revision.requestFile, 'utf8')).toBe('Changed request');
      expect(externalReads).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('standalone revision validates external configuration and binds it to the publication target', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-cli-')));
  try {
    const f = await fixture(root);
    f.io.publish = async (input: PublishInput) => {
      const configPath = join(f.dir, 'verification-config.json');
      const original = await readFile(configPath, 'utf8');
      const config: unknown = JSON.parse(original);
      assertConfig(config);
      assert(config.revision);
      const args = [
        '--repo',
        input.cwd,
        '--actor',
        'operator',
        '--head',
        input.head,
        '--title',
        input.title,
        '--body-file',
        input.bodyFile,
        '--revision-file',
        configPath,
      ];
      const io = {
        command: async (argv: string[], cwd: string) => {
          const result = await f.io.command(argv, cwd, '', 660000);
          assert(result.code === 0, result.stderr);
          return result.stdout.trim();
        },
      };
      const invalid: [string, RegExp][] = [
        ['{', /JSON/],
        [JSON.stringify({ ...config, check: [] }), /Invalid check command/],
        [JSON.stringify({ ...config, revision: undefined }), /Revision publication target differs/],
        [JSON.stringify({ ...config, cwd: f.repo }), /Revision publication target differs/],
        [
          JSON.stringify({ ...config, revision: { ...config.revision, branch: 'codex/other' } }),
          /Revision publication target differs/,
        ],
      ];
      try {
        for (const [contents, reason] of invalid) {
          await writeFile(configPath, contents);
          await assert.rejects(() => publishCli(args, io), reason);
          expect(f.hooks.edits).toBe(0);
        }
      } finally {
        await writeFile(configPath, original);
      }
      await assert.rejects(
        () => publish({ ...input, head: 'codex/other' }, io),
        /Revision publication target differs/,
      );
      expect(f.hooks.edits).toBe(0);
      return publishCli(args, io);
    };
    const result = await develop(f.args, f.io);
    expect(result.status).toBe('published_draft');
    expect(f.hooks.edits).toBe(1);
    expect(f.pr.body).toContain(result.commit ?? 'missing commit');
    expect(f.pr.body).toContain('Closes #99');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function successfulRevision(
  f: RevisionFixture,
  { localOnly = false, alreadyDraft = false }: { localOnly?: boolean; alreadyDraft?: boolean } = {},
) {
  const { pr, hooks } = f;
  const verifiedHeads: string[] = [];
  let beforeCommit = -1;
  hooks.beforeVerify = async () => {
    verifiedHeads.push(git(f.cwd, 'rev-parse', 'HEAD'));
    if (verifiedHeads.length === 2) {
      beforeCommit = f.commands.length;
    }
  };
  const result = await runRevision(f);
  expect(result.status).toBe(localOnly ? 'verified_local' : 'published_draft');
  const config = await readObject(join(f.dir, 'verification-config.json'));
  expect(config.baseCommit).toBe(f.initialBase);
  expect(config).toMatchObject({
    repairLimit: null,
    reviewLimit: null,
    modelTimeMs: null,
    revision: { head: f.oldHead },
  });
  expect(result.url).toBe(pr.url);
  expect(hooks.edits).toBe(localOnly ? 0 : 1);
  // Start inputs are checked at entry and after setup, once per canonical checkout.
  expect(f.commands.filter(({ argv }) => argv[1] === 'hash-object')).toEqual(
    Array.from({ length: 2 }, () => ({
      argv: ['git', 'hash-object', '--no-filters', '--', '.dotagents.json'],
      cwd: f.cwd,
    })),
  );
  if (localOnly) {
    expect(verifiedHeads).toEqual([f.oldHead]);
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.oldHead);
    expect(result.publication).toBe('not_attempted');
    expect(pr.isDraft).toBe(false);
    expect(f.commands.some(({ argv }) => argv[2] === 'ready')).toBe(false);
  } else {
    assert(result.commit);
    expect(verifiedHeads).toEqual([f.oldHead, f.oldHead, result.commit]);
    // One target reconciliation between the final pre-commit verify and staging.
    // Verification internals are simulated and excluded from these command counts.
    expect(beforeCommit).toBeGreaterThanOrEqual(0);
    const staging = f.commands.findIndex(({ argv }) => argv[0] === 'git' && argv[1] === 'add');
    expect(staging).toBeGreaterThan(beforeCommit);
    const boundary = f.commands.slice(beforeCommit, staging);
    expect(boundary.filter(({ argv }) => argv[0] === 'gh')).toHaveLength(6);
    expect(boundary.filter(({ argv }) => argv[0] === 'git')).toHaveLength(5);
    // Share one fresh target observation within the push boundary.
    const push = f.commands.findIndex(({ argv }) => argv.includes('push'));
    const beforePush = f.commands
      .slice(0, push)
      .findLastIndex(({ argv }) => argv.join(' ') === 'git rev-parse HEAD');
    expect(beforePush).toBeGreaterThan(staging);
    expect(push).toBeGreaterThan(beforePush);
    expect(
      f.commands.slice(beforePush, push).filter(({ argv }) => argv[2] === 'user'),
    ).toHaveLength(alreadyDraft ? 1 : 2);
    const conversions = f.commands.filter(({ argv }) => argv[2] === 'ready');
    expect(conversions).toHaveLength(alreadyDraft ? 0 : 1);
    expect(pr.isDraft).toBe(true);
    expect(result.remaining).toEqual(['published_body_check', 'mark_ready', 'human_review']);
    expect(result.commit).not.toBe(f.oldHead);
    expect(pr.body).toContain(result.commit ?? 'missing');
    expect(pr.body).toContain('Prior limitation and attachment: https://example.com/media.png');
    expect(pr.body).not.toContain(f.oldHead);
    expect(pr.body).not.toContain(f.prior);
    expect(result.ci).toBe('passed');
    expect(git(f.cwd, 'rev-parse', 'HEAD^')).toBe(f.oldHead);
    // Read the publication target once before editing and again after the edit.
    expect(f.publicationCommands.filter((argv) => argv[2] === 'user')).toHaveLength(2);
  }
}
type RevisionFixture = Awaited<ReturnType<typeof fixture>>;

function testRevision(name: string, check: (f: RevisionFixture) => Promise<void>) {
  test(`existing PR revision: ${name}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-')));
    try {
      await check(await fixture(root));
    } finally {
      await withInterrupts(async () => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

function runRevision(f: RevisionFixture): ReturnType<typeof develop>;
function runRevision(f: RevisionFixture, reason: RegExp): Promise<void>;
async function runRevision(
  f: RevisionFixture,
  reason?: RegExp,
): Promise<Awaited<ReturnType<typeof develop>> | void> {
  // Snapshot after case preparation, including intentionally unfinished/uncertain records.
  const priorState = await readFile(join(f.prior, 'verification/state.json'), 'utf8');
  const priorResult = await readFile(join(f.prior, 'result.json'), 'utf8');
  try {
    if (reason) {
      // Match only execution errors; preservation failures must fail the test independently.
      await assert.rejects(() => withInterrupts(() => develop(f.args, f.io)), reason);
      return;
    }
    return await withInterrupts(() => develop(f.args, f.io));
  } finally {
    expect(await readFile(join(f.prior, 'verification/state.json'), 'utf8')).toBe(priorState);
    expect(await readFile(join(f.prior, 'result.json'), 'utf8')).toBe(priorResult);
  }
}

function noRevisionPublication(f: RevisionFixture) {
  expect(f.hooks.pushes).toBe(1); // The fixture's original publication only.
  expect(f.hooks.edits).toBe(0);
}

async function stoppedRevision(f: RevisionFixture, reason: RegExp) {
  await runRevision(f, reason);
  const result = await readObject(join(f.dir, 'result.json'));
  expect(result.url).toBe(f.pr.url);
  expect(result.status).toBe('stopped');
  expect(result.nextAction).toBeTruthy();
  return result;
}

testRevision('success', async (f) => {
  await successfulRevision(f);
});

testRevision('already_draft', async (f) => {
  f.pr.isDraft = true;
  await successfulRevision(f, { alreadyDraft: true });
});

testRevision('local', async (f) => {
  f.args.push('--no-publish');
  f.pr.closingIssuesReferences = [{ url: 'https://github.com/team/component/issues/99' }];
  await successfulRevision(f, { localOnly: true });
});

testRevision('shared_branch', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][2] === 'repos/team/component/pulls' && f.hooks.implementations >= 2) {
      // Keep the normal first page; the conflicting PR is on a later page and another base.
      const pages: unknown = JSON.parse(result.stdout);
      assert(Array.isArray(pages));
      pages.push([
        {
          html_url: 'https://github.com/team/component/pull/101',
          head: { ref: f.pr.headRefName, repo: { full_name: 'team/component' } },
          base: { ref: 'main' },
          draft: false,
        },
      ]);
      return ok(JSON.stringify(pages));
    }
    return result;
  };
  const result = await stoppedRevision(
    f,
    /Open PR already uses this branch: https:\/\/github.com\/team\/component\/pull\/101/,
  );
  expect(result.publication).toBe('not_attempted');
  expect(result.commit).not.toBe(f.oldHead);
  noRevisionPublication(f);
  expect(f.pr.isDraft).toBe(false);
  expect(f.pr.headRefOid).toBe(f.oldHead);
  expect(f.pr.body).toBe(f.oldBody);
  expect(f.commands.some(({ argv }) => argv[2] === 'ready' || argv[2] === 'edit')).toBe(false);
});

testRevision('draft_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][2] === 'ready') {
      expect(args[0]).toEqual([
        'gh',
        'pr',
        'ready',
        f.pr.url,
        '--repo',
        'team/component',
        '--undo',
      ]);
      expect(f.hooks.pushes).toBe(1);
      return { ...ok(), code: 1, stderr: 'draft conversion failed fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /draft conversion failed fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  noRevisionPublication(f);
});

testRevision('draft_mismatch', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][2] === 'ready') {
      f.pr.isDraft = false;
    }
    return result;
  };
  const result = await stoppedRevision(f, /not draft/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  noRevisionPublication(f);
});

testRevision('draft_unknown', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][2] === 'ready') {
      throw Error('draft conversion response lost fixture');
    }
    return result;
  };
  const result = await stoppedRevision(f, /draft conversion response lost fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  noRevisionPublication(f);
});

testRevision('draft_body_changed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][2] === 'ready') {
      f.pr.body += '\nConcurrent edit during draft conversion';
    }
    return result;
  };
  const result = await stoppedRevision(f, /PR body changed/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  noRevisionPublication(f);
});

testRevision('dirty', async (f) => {
  await writeFile(join(f.cwd, 'untracked.txt'), 'keep me');
  await runRevision(f, /Checkout differs|clean tracked/);
  expect(f.hooks.implementations).toBe(1);
  noRevisionPublication(f);
  expect(await readFile(join(f.cwd, 'untracked.txt'), 'utf8')).toBe('keep me');
});

for (const [name, change, reason] of [
  [
    'wrong_head',
    (pr: RevisionFixture['pr']) => {
      pr.headRefOid = 'a'.repeat(40);
    },
    /PR identity changed/,
  ],
  [
    'wrong_author',
    (pr: RevisionFixture['pr']) => {
      pr.author.login = 'someone';
    },
    /PR identity changed/,
  ],
  [
    'wrong_repo',
    (pr: RevisionFixture['pr']) => {
      pr.headRepositoryOwner.login = 'another';
    },
    /PR identity changed/,
  ],
  [
    'wrong_branch',
    (pr: RevisionFixture['pr']) => {
      pr.headRefName = 'codex/development-100';
    },
    /PR identity changed/,
  ],
  [
    'wrong_base',
    (pr: RevisionFixture['pr']) => {
      pr.baseRefName = 'main';
    },
    /PR identity changed/,
  ],
  [
    'wrong_issue',
    (pr: RevisionFixture['pr']) => {
      pr.closingIssuesReferences = [{ url: 'https://github.com/team/component/issues/98' }];
    },
    /PR Issue changed/,
  ],
  [
    'wrong_body_issue',
    (pr: RevisionFixture['pr']) => {
      pr.body = pr.body.replace('Closes #99', 'Closes #990');
    },
    /PR Issue changed/,
  ],
  [
    'wrong_pr',
    (pr: RevisionFixture['pr']) => {
      pr.url = 'https://github.com/team/component/pull/101';
    },
    /PR identity changed/,
  ],
] as const) {
  testRevision(name, async (f) => {
    change(f.pr);
    await runRevision(f, reason);
    expect(f.hooks.implementations).toBe(1);
    noRevisionPublication(f);
  });
}

testRevision('body_changed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0].includes('repair')) {
      f.pr.body += '\nHand edit';
    }
    return result;
  };
  const result = await stoppedRevision(f, /PR body changed/);
  expect(result.publication).toBe('not_attempted');
  noRevisionPublication(f);
});

testRevision('request_changed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0].includes('repair')) {
      await writeFile(f.request, 'Expanded scope');
    }
    return result;
  };
  const result = await stoppedRevision(f, /Revision request changed/);
  expect(result.publication).toBe('not_attempted');
  noRevisionPublication(f);
});

testRevision('issue_after_push', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][1] === 'issue' && f.hooks.pushes > 1) {
      return ok(f.hooks.issueText.replace('Keep result visible', 'Changed requirement'));
    }
    return result;
  };
  const result = await stoppedRevision(f, /Agreed Issue changed/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  expect(f.hooks.pushes).toBe(2);
  expect(f.hooks.edits).toBe(0);
});

testRevision('target_after_push', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    // The publisher is entered after push, and performs its own target observation.
    if (args[0][2] === 'repos/team/component' && f.publicationCommands.length > 0) {
      return ok(
        JSON.stringify({ full_name: 'team/component', id: 456, permissions: { push: true } }),
      );
    }
    return result;
  };
  const result = await stoppedRevision(f, /Revision target or actor changed/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  expect(f.hooks.pushes).toBe(2);
  expect(f.hooks.edits).toBe(0);
});

for (const [name, reason, publication] of [
  ['unfinished_sibling', '', 'not_attempted'],
  ['uncertain_sibling', 'Interrupted', 'unconfirmed'],
] as const) {
  testRevision(name, async (f) => {
    const sibling = join(f.prior, '..', 'other-revision');
    await mkdir(sibling);
    await writeFile(
      join(sibling, 'result.json'),
      JSON.stringify({ checkout: f.cwd, reason, publication }),
    );
    await runRevision(f, /Unfinished or uncertain execution/);
    expect(f.hooks.implementations).toBe(1);
    noRevisionPublication(f);
  });
}

testRevision('unfinished', async (f) => {
  const path = join(f.prior, 'verification/state.json');
  await writeFile(
    path,
    JSON.stringify({
      ...(await readObject(path)),
      active: { role: 'repair', prefix: 'unfinished' },
    }),
  );
  await runRevision(f, /Previous verification is unfinished/);
  expect(f.hooks.implementations).toBe(1);
  noRevisionPublication(f);
});

testRevision('uncertain', async (f) => {
  const path = join(f.prior, 'result.json');
  await writeFile(
    path,
    JSON.stringify({ ...(await readObject(path)), publication: 'unconfirmed' }),
  );
  await runRevision(f, /Previous publication is incomplete/);
  expect(f.hooks.implementations).toBe(1);
  noRevisionPublication(f);
});

testRevision('commit_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][0] === 'git' && args[0].includes('commit')) {
      return { ...ok(), code: 1, stderr: 'commit rejected fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /commit rejected fixture/);
  expect(result.publication).toBe('not_attempted');
  noRevisionPublication(f);
});

testRevision('push_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][0] === 'git' && args[0].includes('push')) {
      expect(f.pr.isDraft).toBe(true);
      f.hooks.pushes++;
      return { ...ok(), code: 1, stderr: 'push rejected fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /push rejected fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('push_interrupt', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][0] === 'git' && args[0].includes('push')) {
      process.emit('SIGINT');
      throw Error('Interrupted push fixture');
    }
    return result;
  };
  const result = await stoppedRevision(f, /Interrupted push fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('edit_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (args[0][1] === 'pr' && args[0][2] === 'edit' && !args[0].includes('--attach')) {
      expect(f.pr.isDraft).toBe(true);
      f.hooks.edits++;
      return { ...ok(), code: 1, stderr: 'body update failed fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /body update failed fixture/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('edit_interrupt', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][1] === 'pr' && args[0][2] === 'edit' && !args[0].includes('--attach')) {
      process.emit('SIGTERM');
    }
    return result;
  };
  const result = await stoppedRevision(f, /Interrupted execution/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('readback_changed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][1] === 'pr' && args[0][2] === 'edit' && !args[0].includes('--attach')) {
      f.pr.body = 'Concurrent edit';
    }
    return result;
  };
  const result = await stoppedRevision(f, /PR body changed/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
});

testRevision('readback_actor_changed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    const result = await execute(...args);
    if (args[0][2] === 'user' && f.hooks.edits > 0 && f.publicationCommands.length > 0) {
      return ok(JSON.stringify({ login: 'another-operator' }));
    }
    return result;
  };
  const result = await stoppedRevision(f, /Revision target or actor changed/);
  expect(result.publication).toBe('unconfirmed');
  expect(result.commit).not.toBe(f.oldHead);
  expect(f.hooks.pushes).toBe(2);
  expect(f.hooks.edits).toBe(1);
});

testRevision('ci_failed', async (f) => {
  const execute = f.io.command;
  f.io.command = async (...args) => {
    if (
      args[0][1] === 'pr' &&
      args[0][2] === 'view' &&
      args[0].at(-1)?.includes('statusCheckRollup')
    ) {
      return { ...ok(), code: 1, stderr: 'CI unavailable fixture' };
    }
    return execute(...args);
  };
  const result = await stoppedRevision(f, /unavailable:/);
  expect(result.publication).toBe('published');
  expect(result.commit).not.toBe(f.oldHead);
});

for (const changed of ['none', 'actor', 'draft']) {
  test(`revision attachment reconciles a fresh target once: changed=${changed}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-media-')));
    try {
      const f = await fixture(root, true);
      let published = -1;
      const publish = f.io.publish;
      f.io.publish = async (input) => {
        const url = await publish(input);
        published = f.commands.length;
        if (changed === 'draft') {
          f.pr.isDraft = false;
        }
        return url;
      };
      const command = f.io.command;
      f.io.command = async (argv, cwd, input, timeout) => {
        const result = await command(argv, cwd, input, timeout);
        if (changed === 'actor' && published >= 0 && argv[2] === 'user') {
          return ok(JSON.stringify({ login: 'another-operator' }));
        }
        return result;
      };
      if (changed !== 'none') {
        await assert.rejects(
          () => develop(f.args, f.io),
          changed === 'actor' ? /Target configuration or GitHub actor changed/ : /not draft/,
        );
        const result = await readObject(join(f.dir, 'result.json'));
        expect(result).toMatchObject({
          status: 'stopped',
          publication: 'published',
          url: f.pr.url,
        });
        expect(result.remaining).toContain('attachments');
        expect(result.commit).toBe(f.pr.headRefOid);
        expect(f.commands.some(({ argv }) => argv.includes('--attach'))).toBe(false);
      } else {
        const result = await develop(f.args, f.io);
        expect(result.status).toBe('published_draft');
        expect(result.remaining).not.toContain('attachments');
        expect(result.remaining).toContain('rendered_media_check');
        const attachments = f.commands.filter(({ argv }) => argv.includes('--attach'));
        expect(attachments).toHaveLength(1);
        expect(attachments[0]?.argv).toContain(join(f.cwd, 'media/result.png'));
        const attach = f.commands.findIndex(({ argv }) => argv.includes('--attach'));
        expect(published).toBeGreaterThan(0);
        expect(attach).toBeGreaterThan(published);
        expect(
          f.commands.slice(published, attach).filter(({ argv }) => argv[2] === 'user'),
        ).toHaveLength(1);
        expect(f.pr.body).toContain('https://example.com/revision.png');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const boundary of ['reservation', 'setup', 'issue_during_setup']) {
  test(`revision rejects changes at the start boundary: ${boundary}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-start-')));
    try {
      const setup = ['git', 'status', '--porcelain'];
      const f = await fixture(root, false, [setup]);
      const priorState = await readFile(join(f.prior, 'verification/state.json'), 'utf8');
      const priorResult = await readFile(join(f.prior, 'result.json'), 'utf8');
      const initialVerifications = f.hooks.verifications;
      let changed = false;
      const command = f.io.command;
      f.io.command = async (argv, cwd, input, timeout) => {
        const result = await command(argv, cwd, input, timeout);
        if (boundary === 'reservation' && !changed && argv[1] === 'remote') {
          const reserved = await readObject(join(f.dir, 'result.json')).catch(() => undefined);
          if (reserved) {
            expect(reserved).toMatchObject({ reason: '', url: f.pr.url });
            await writeFile(f.request, 'Expanded scope');
            changed = true;
          }
        }
        if (boundary !== 'reservation' && argv.join(' ') === setup.join(' ')) {
          if (boundary === 'issue_during_setup') {
            f.hooks.issueText = updatedIssue;
          } else {
            f.pr.body += '\nConcurrent edit during setup';
          }
          await writeFile(join(f.cwd, 'untracked.txt'), 'Preserve setup work');
          changed = true;
        }
        return result;
      };
      const reason =
        boundary === 'reservation'
          ? /Revision request changed/
          : boundary === 'issue_during_setup'
            ? /Agreed Issue changed/
            : /PR body changed/;
      await assert.rejects(() => develop(f.args, f.io), reason);
      expect(changed).toBe(true);
      expect(f.commands.filter(({ argv }) => argv.join(' ') === setup.join(' '))).toHaveLength(
        boundary === 'reservation' ? 0 : 1,
      );
      expect(f.hooks.implementations).toBe(1); // Only the prior run's actor and publication.
      expect(f.hooks.verifications).toBe(initialVerifications);
      expect(f.hooks.pushes).toBe(1);
      expect(f.hooks.edits).toBe(0);
      expect(f.commands.some(({ argv }) => argv[2] === 'ready' || argv[1] === 'add')).toBe(false);
      expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.oldHead);
      const result = await readObject(join(f.dir, 'result.json'));
      expect(result).toMatchObject({
        status: 'stopped',
        phase: 'implementation',
        operation:
          boundary === 'reservation'
            ? 'check revision before setup'
            : 'check implementation inputs',
        publication: 'not_attempted',
        url: f.pr.url,
      });
      expect(result.reason).toMatch(reason);
      expect(result.nextAction).toContain('without resuming this run');
      if (boundary !== 'reservation') {
        expect(await readFile(join(f.cwd, 'untracked.txt'), 'utf8')).toBe('Preserve setup work');
      }
      expect(await readFile(join(f.prior, 'verification/state.json'), 'utf8')).toBe(priorState);
      expect(await readFile(join(f.prior, 'result.json'), 'utf8')).toBe(priorResult);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [mode, current, reason] of [
  ['closed', { state: 'CLOSED' }, /Issue must be open/],
  ['empty_title', { title: ' ' }, /Issue must be open/],
  ['empty_body', { body: ' ' }, /Issue must be open/],
  ['prior_issue_tampered', {}, /Previous Issue evidence differs/],
  ['changed_after_snapshot', {}, /Agreed Issue changed during revision/],
] as const) {
  test(`revision rejects invalid start requirements: ${mode}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-issue-')));
    try {
      const f = await fixture(root, false, [['git', 'status', '--porcelain']]);
      f.hooks.issueText = JSON.stringify({ ...updatedRequirements, ...current });
      if (mode === 'prior_issue_tampered') {
        await writeFile(join(f.prior, 'issue.json'), updatedIssue);
      }
      const priorFiles = ['issue.json', 'verification/state.json', 'result.json'];
      const priorEvidence = await Promise.all(
        priorFiles.map((path) => readFile(join(f.prior, path), 'utf8')),
      );
      const initialVerifications = f.hooks.verifications;
      const execute = f.io.command;
      let issueReads = 0;
      f.io.command = async (...args) => {
        const result = await execute(...args);
        if (args[0][1] === 'issue') {
          expect(args[0]).toEqual([
            'gh',
            'issue',
            'view',
            '99',
            '--repo',
            'team/component',
            '--json',
            'title,body,state,updatedAt',
          ]);
          issueReads++;
          if (mode === 'changed_after_snapshot' && issueReads === 1) {
            // Even a timestamp-only change after pinning must stop preparation.
            f.hooks.issueText = updatedIssue.replace('2026-09-21', '2026-09-22');
          }
        }
        return result;
      };
      await assert.rejects(() => develop(f.args, f.io), reason);
      expect(f.hooks.implementations).toBe(1);
      expect(f.hooks.verifications).toBe(initialVerifications);
      expect(f.hooks.pushes).toBe(1);
      expect(f.hooks.edits).toBe(0);
      expect(f.commands.some(({ argv }) => argv.join(' ') === 'git status --porcelain')).toBe(
        false,
      );
      expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.oldHead);
      expect(await readdir(root)).not.toContain('revision');
      expect(
        await Promise.all(priorFiles.map((path) => readFile(join(f.prior, path), 'utf8'))),
      ).toEqual(priorEvidence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [mode, reason] of [
  ['missing_report', /Required report is missing from start commit/],
  ['published_report', /Required report differs from reviewed version/],
] as const) {
  test(`revision rejects unsupported evidence before setup: ${mode}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-input-')));
    try {
      const setup = ['git', 'status', '--porcelain'];
      const f = await fixture(root, false, [setup], mode.endsWith('report'));
      if (mode.endsWith('report')) {
        const configPath = join(f.prior, 'verification-config.json');
        const config = await readObject(configPath);
        config.reports = [
          {
            path: mode === 'missing_report' ? 'docs/research/absent.md' : reportPath,
            blob: git(f.cwd, 'rev-parse', `HEAD:${reportPath}`),
          },
        ];
        await writeFile(configPath, JSON.stringify(config));
        const statePath = join(f.prior, 'verification/state.json');
        const state = await readObject(statePath);
        await writeFile(
          statePath,
          JSON.stringify({ ...state, configHash: hash(JSON.stringify(config)) }),
        );
      }
      const priorFiles = [
        'issue.json',
        'verification-config.json',
        'verification/state.json',
        'result.json',
      ];
      const priorEvidence = await Promise.all(
        priorFiles.map((file) => readFile(join(f.prior, file), 'utf8')),
      );
      const initialVerifications = f.hooks.verifications;
      await assert.rejects(() => develop(f.args, f.io), reason);
      expect(f.hooks.implementations).toBe(1);
      expect(f.hooks.verifications).toBe(initialVerifications);
      expect(f.hooks.pushes).toBe(1);
      expect(f.hooks.edits).toBe(0);
      expect(f.commands.some(({ argv }) => argv.join(' ') === setup.join(' '))).toBe(false);
      expect(f.commands.some(({ argv }) => argv[2] === 'ready' || argv[1] === 'add')).toBe(false);
      expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.oldHead);
      expect(git(f.cwd, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(await readdir(root)).not.toContain('revision');
      expect(
        await Promise.all(priorFiles.map((file) => readFile(join(f.prior, file), 'utf8'))),
      ).toEqual(priorEvidence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const verificationChanges: Record<string, RegExp> = {
  issue: /Agreed Issue changed/,
  request: /Revision request changed/,
  repository: /Revision target or actor changed/,
  config: /Revision target or actor changed/,
  actor: /Revision target or actor changed/,
  permission: /GitHub push permission required/,
  pr: /Revision PR body changed/,
};
for (const [change, expected] of Object.entries(verificationChanges)) {
  test(`existing PR revision stops changes during pre-commit verification: ${change}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-verify-')));
    try {
      const f = await fixture(root);
      const priorState = await readFile(join(f.prior, 'verification/state.json'), 'utf8');
      const priorResult = await readFile(join(f.prior, 'result.json'), 'utf8');
      const initialVerifications = f.hooks.verifications;
      let changed = false;
      f.hooks.beforeVerify = async () => {
        if (f.hooks.verifications !== initialVerifications + 2) {
          return;
        }
        changed = true;
        if (change === 'request') {
          await writeFile(f.request, 'Expanded scope');
        }
        if (change === 'config') {
          const path = join(f.cwd, '.dotagents.json');
          await writeFile(path, JSON.stringify({ ...(await readObject(path)), check: ['false'] }));
        }
        if (change === 'pr') {
          f.pr.body += '\nConcurrent edit during verification';
        }
      };
      const command = f.io.command;
      f.io.command = async (argv, cwd, input, timeout) => {
        const result = await command(argv, cwd, input, timeout);
        if (!changed || argv[0] !== 'gh') {
          return result;
        }
        if (change === 'issue' && argv[1] === 'issue') {
          return ok(issue.replace('Keep result visible', 'Changed requirements'));
        }
        if (change === 'actor' && argv[2] === 'user') {
          return ok(JSON.stringify({ login: 'another-operator' }));
        }
        if (argv[2] === 'repos/team/component') {
          return ok(
            JSON.stringify({
              full_name: 'team/component',
              id: change === 'repository' ? 456 : 123,
              permissions: { push: change !== 'permission' },
            }),
          );
        }
        return result;
      };
      await assert.rejects(() => develop(f.args, f.io), expected);
      expect(changed).toBe(true);
      expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.oldHead);
      expect(f.commands.some(({ argv }) => argv[0] === 'git' && argv[1] === 'add')).toBe(false);
      expect(f.hooks.pushes).toBe(1); // Only the fixture's original publication.
      expect(f.hooks.edits).toBe(0);
      expect(await readObject(join(f.dir, 'result.json'))).toMatchObject({
        status: 'stopped',
        publication: 'not_attempted',
        url: f.pr.url,
        phase: 'verification',
      });
      expect(await readFile(join(f.cwd, 'result.txt'), 'utf8')).toBe('reset corrected');
      expect(await readFile(join(f.prior, 'verification/state.json'), 'utf8')).toBe(priorState);
      expect(await readFile(join(f.prior, 'result.json'), 'utf8')).toBe(priorResult);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function retainedCorrectionEntry(
  verification: string,
  root: string,
  mode: string,
  rejectedState?: string,
) {
  // Entry stops before the target matched keep only the raw Issue read, never issue.txt.
  expect((await readdir(verification)).sort()).toEqual(
    mode === 'locked_body_changed'
      ? ['lock']
      : rejectedState
        ? ['state.json']
        : ['issue.stderr', 'issue.stdout'],
  );
  if (rejectedState) {
    expect(await readFile(join(verification, 'state.json'), 'utf8')).toBe(rejectedState);
  }
  if (mode !== 'body_changed') {
    expect(await Bun.file(join(root, 'reads')).exists()).toBe(false);
  }
  if (mode === 'locked_body_changed') {
    expect(await readFile(join(verification, 'lock/owner'), 'utf8')).toBe('existing execution');
  }
}

for (const [mode, reason] of [
  ['updated_issue', null],
  ['issue_changed', /Agreed Issue changed during revision/],
  ['request_changed', /Revision request changed/],
  ['actor_changed', /Revision target or actor changed/],
  ['permission_changed', /GitHub push permission required/],
  ['branch_changed', /Revision branch changed/],
  ['head_changed', /Revision PR identity changed/],
  ['ref_changed', /Revision remote ref differs/],
  ['body_changed', /Revision PR body changed/],
  ['locked_body_changed', /EEXIST/],
  ['invalid_state_body_changed', /JSON/],
  ['active_body_changed', /Interrupted execution/],
] as const) {
  test(`development verifies revisions through correction: ${mode}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-controller-')));
    const originalPath = process.env.PATH;
    try {
      const f = await fixture(root, false, [], mode === 'updated_issue');
      const currentIssue = updatedIssue;
      f.hooks.issueText = currentIssue;
      const priorFiles = [
        'issue.json',
        'result.json',
        'verification-config.json',
        'verification/state.json',
        'pr.json',
      ];
      const priorEvidence = await Promise.all(
        priorFiles.map((path) => readFile(join(f.prior, path), 'utf8')),
      );
      const livePr = join(root, 'pr.json');
      await writeFile(livePr, JSON.stringify(f.pr));
      const bin = join(root, 'bin');
      await mkdir(bin);
      const gh = join(bin, 'gh');
      const liveIssue = join(root, 'issue.json');
      const checked = join(root, 'checked');
      await writeFile(liveIssue, currentIssue + '\n');
      await writeFile(
        gh,
        `#!${process.execPath}
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
const args = process.argv.slice(2);
const pr = JSON.parse(readFileSync(${JSON.stringify(livePr)},'utf8'));
const changed = existsSync(${JSON.stringify(checked)});
if (changed && ${mode === 'head_changed'}) pr.headRefOid = 'f'.repeat(40);
if (['issue', 'pr'].includes(args[0])) appendFileSync(${JSON.stringify(join(root, 'reads'))}, args[0]+'\\n');
if(args[0] === 'issue') process.stdout.write(readFileSync(${JSON.stringify(liveIssue)},'utf8'));
else if(args[0] === 'pr') console.log(JSON.stringify(pr));
else if(args[1] === 'user') console.log(JSON.stringify({login:changed && ${mode === 'actor_changed'} ? 'another-operator' : 'operator'}));
else if(args[1].includes('/git/ref/')) console.log(JSON.stringify({object:{sha:changed && ${mode === 'ref_changed'} ? 'f'.repeat(40) : pr.headRefOid}}));
else if(args[1].includes('/branches/')) console.log('{"name":"release"}');
else console.log(JSON.stringify({full_name:'team/component',id:123,permissions:{push:!(changed && ${mode === 'permission_changed'})}}));
`,
      );
      await chmod(gh, 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      const helper = join(root, 'actor.js');
      await writeFile(
        helper,
        `
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const role = process.argv[2];
${reviewReplySource}
if(role === 'check') {
 writeFileSync(${JSON.stringify(checked)}, 'check completed');
 if (${mode === 'issue_changed'}) writeFileSync(${JSON.stringify(liveIssue)}, ${JSON.stringify(updatedIssue.replace('Keep result visible', 'Changed requirements'))});
 if (${mode === 'request_changed'}) writeFileSync(${JSON.stringify(f.request)}, 'Expanded scope');
 if (${mode === 'branch_changed'}) execFileSync('git', ['branch', '-m', 'changed-branch']);
 if (${reason !== null && mode !== 'issue_changed'}) process.exit(0);
 process.exit(readFileSync('result.txt','utf8') === 'corrected' ? 0 : 1);
}
if(role === 'repair') { writeFileSync('result.txt','corrected'); console.log(JSON.stringify({status:'repaired',findings:'Reset corrected'})); }
if(role === 'review') console.log(JSON.stringify(reviewReply('accepted','Issue and revision inspected')));
`,
      );
      let config: Config | undefined;
      let rejectedState: string | undefined;
      f.io.verify = async (input) => {
        config = {
          ...input,
          check: [process.execPath, helper, 'check'],
          repair: [process.execPath, helper, 'repair'],
          review: [process.execPath, helper, 'review'],
        };
        if (mode === 'invalid_state_body_changed' || mode === 'active_body_changed') {
          await mkdir(input.runDir, { recursive: true });
          rejectedState =
            mode === 'invalid_state_body_changed'
              ? '{'
              : JSON.stringify({
                  ...(await readObject(join(f.prior, 'verification/state.json'))),
                  configHash: hash(JSON.stringify(config)),
                  active: { role: 'repair', prefix: join(input.runDir, 'repair-1') },
                });
          await writeFile(join(input.runDir, 'state.json'), rejectedState);
        }
        return run(config);
      };
      const verification = join(f.dir, 'verification');
      const entryFailure = mode.endsWith('body_changed');
      if (entryFailure) {
        const execute = f.io.command;
        f.io.command = async (...args) => {
          const result = await execute(...args);
          if (args[0].includes('repair')) {
            f.pr.body += '\nHand edit';
            await writeFile(livePr, JSON.stringify(f.pr));
            if (mode === 'locked_body_changed') {
              await mkdir(join(verification, 'lock'), { recursive: true });
              await writeFile(join(verification, 'lock/owner'), 'existing execution');
            }
          }
          return result;
        };
      }
      if (reason) {
        await assert.rejects(() => develop(f.args, f.io), reason);
        const stopped = await readObject(join(f.dir, 'result.json'));
        expect(stopped.reason).toMatch(reason);
        expect(stopped).toMatchObject({
          status: 'stopped',
          phase: 'verification',
          publication: 'not_attempted',
          url: f.pr.url,
        });
        expect(f.hooks.pushes).toBe(1); // Only the fixture's original publication.
        expect(f.hooks.edits).toBe(0);
        expect(f.commands.some(({ argv }) => argv[1] === 'add' || argv[2] === 'ready')).toBe(false);
        expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.oldHead);
        expect(await readFile(join(f.cwd, 'result.txt'), 'utf8')).toBe('reset corrected');
        expect(
          await Promise.all(priorFiles.map((path) => readFile(join(f.prior, path), 'utf8'))),
        ).toEqual(priorEvidence);
        if (entryFailure) {
          await retainedCorrectionEntry(verification, root, mode, rejectedState);
          if (mode !== 'body_changed') {
            return;
          }
          assert(config);
          const retryConfig = config;
          const paths = await readdir(verification);
          const evidence = await Promise.all(
            paths.map((path) => readFile(join(verification, path), 'utf8')),
          );
          const reads = await readFile(join(root, 'reads'), 'utf8');
          await writeFile(liveIssue, 'changed after failed PR reconciliation');
          await assert.rejects(() => run(retryConfig), /Initial Issue evidence already exists/);
          expect(await readdir(verification)).toEqual(paths);
          expect(
            await Promise.all(paths.map((path) => readFile(join(verification, path), 'utf8'))),
          ).toEqual(evidence);
          expect(await readFile(join(root, 'reads'), 'utf8')).toBe(reads);
        } else {
          // Stop at the post-check boundary before even preparing a review target.
          expect((await readdir(verification)).sort()).toEqual([
            'check-1.stderr',
            'check-1.stdout',
            'issue.stderr',
            'issue.stdout',
            'issue.txt',
            'state.json',
          ]);
          expect(await readObject(join(verification, 'state.json'))).toMatchObject({
            repair: 0,
            review: 0,
            checks: 1,
            active: null,
          });
        }
        return;
      }
      const result = await develop(f.args, f.io);
      expect(result.status).toBe('published_draft');
      expect(f.hooks.pushes).toBe(2);
      expect(f.hooks.edits).toBe(1);
      const verifiedConfig = config;
      assert(verifiedConfig?.revision);
      const request = verifiedConfig.revision.request;
      const state = await readObject(join(verification, 'state.json'));
      expect(state.result).toBe('ready_for_human_review');
      expect(state.repair).toBe(1);
      expect(state.review).toBe(1);
      expect(state.checks).toBe(2);
      expect(state.issueHash).toBe(hash(currentIssue));
      expect(await readFile(join(verification, 'issue.stdout'), 'utf8')).toBe(currentIssue + '\n');
      expect(verifiedConfig.revision.issueText).toBe(currentIssue);
      expect(await readFile(join(f.dir, 'issue.json'), 'utf8')).toBe(currentIssue);
      const referenceBlob = git(f.cwd, 'rev-parse', `${f.initialBase}:${reportPath}`);
      expect(git(f.cwd, 'rev-parse', `${f.oldHead}:${reportPath}`)).not.toBe(referenceBlob);
      for (const promptFile of [
        join(f.dir, 'implementation.prompt'),
        join(verification, 'repair-1.prompt'),
        join(verification, 'review-1.prompt'),
      ]) {
        const prompt = await readFile(promptFile, 'utf8');
        expect(prompt).toContain(currentIssue);
        expect(prompt).toContain(`"startCommit":"${f.initialBase}"`);
        expect(prompt).toContain(JSON.stringify({ path: reportPath, blob: referenceBlob }));
        expect(prompt).not.toContain('"knowledge":');
      }
      expect(
        await Promise.all(priorFiles.map((path) => readFile(join(f.prior, path), 'utf8'))),
      ).toEqual(priorEvidence);
      const reads = (await readFile(join(root, 'reads'), 'utf8')).trim().split('\n');
      expect(reads.filter((role) => role === 'issue').length).toBeGreaterThan(1);
      expect(reads).toEqual(reads.filter((role) => role === 'pr').flatMap(() => ['issue', 'pr']));
      expect(await readFile(join(verifiedConfig.runDir, 'repair-1.prompt'), 'utf8')).toContain(
        request,
      );
      expect(await readFile(join(verifiedConfig.runDir, 'review-1.prompt'), 'utf8')).toContain(
        request,
      );
      expect(await readFile(join(verifiedConfig.runDir, 'review-1.prompt'), 'utf8')).toContain(
        f.oldBody,
      );
      expect(await readFile(join(verifiedConfig.runDir, 'review-1.diff'), 'utf8')).toContain(
        'original issue deliverable',
      );
      const target = await readObject(join(verifiedConfig.runDir, 'review-1.target.json'));
      expect(target).toMatchObject({
        baseCommit: f.initialBase,
        revision: { request, head: f.oldHead },
      });
      const saved = await readFile(join(verifiedConfig.runDir, 'state.json'), 'utf8');
      await writeFile(f.request, 'Another request');
      await assert.rejects(() => run(verifiedConfig), /Revision request changed/);
      expect(await readFile(join(verifiedConfig.runDir, 'state.json'), 'utf8')).toBe(saved);
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a revision reserves existing result evidence before another initial actor can start', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-parallel-')));
  try {
    const f = await fixture(root);
    let reconciled = false;
    f.hooks.beforeActor = async () => {
      f.hooks.beforeActor = undefined;
      const parallel = [...f.args];
      parallel[parallel.indexOf('--run-dir') + 1] = join(root, 'parallel');
      await assert.rejects(() => develop(parallel, f.io), /Unfinished or uncertain execution/);
      reconciled = true;
    };
    await successfulRevision(f);
    expect(reconciled).toBe(true);
    expect(f.hooks.implementations).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('previous Issue evidence requires the exact current hash', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-evidence-')));
  try {
    const f = await fixture(root);
    const target = await readTarget(f.cwd, async (argv, cwd) =>
      (await f.io.command(argv, cwd, '', 10000)).stdout.trim(),
    );
    const path = join(f.prior, 'verification/state.json');
    const original = await readObject(path);
    const evidence = join(f.prior, 'issue.json');
    const state = JSON.stringify({ ...original, issueHash: hash(issue) });
    await writeFile(path, state);
    await writeFile(evidence, issue);
    const read = () => previousRun(f.prior, f.cwd, '99', target);
    await read();
    for (const changed of [issue.replace('Keep result visible', 'Changed'), issue + '\n']) {
      await writeFile(evidence, changed);
      await assert.rejects(read, /Previous Issue evidence differs/);
      expect(await readFile(evidence, 'utf8')).toBe(changed);
    }
    expect(await readFile(path, 'utf8')).toBe(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
