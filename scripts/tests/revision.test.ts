import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { develop } from '../development.ts';
import { publish, publishCli } from '../publish.ts';
import type { PublishInput } from '../publish.ts';
import { run, snapshot } from '../correction.ts';
import { command, withInterrupts } from '../process.ts';
import { assertConfig } from '../input.ts';
import { reviewReplySource } from './support/correction.ts';
import type { Config, State } from '../input.ts';
import { isRecord } from '../values.ts';
import { initializeTarget, githubTarget, git, targetConfig } from './support/target.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const issue = JSON.stringify({
  title: 'Visible result',
  body: 'Keep result visible',
  state: 'OPEN',
});
const ok = (stdout = '') => ({ stdout, stderr: '', code: 0, timedOut: false, ms: 1 });

// Real Git and the existing development/publish entry points; only external responses are simulated.
async function fixture(root: string, media = false) {
  const repo = join(root, 'repo');
  const prior = join(root, 'prior');
  const dir = join(root, 'revision');
  await mkdir(repo);
  await initializeTarget(repo, {
    ...targetConfig,
    capture: media ? { command: ['capture'], destination: 'media', required: true } : null,
  });
  const initialBase = git(repo, 'rev-parse', 'HEAD');
  // GitHub does not create closing links from the body for a non-default base.
  const closingIssuesReferences: { url: string }[] = [];
  const pr = {
    url: 'https://github.com/team/component/pull/100',
    state: 'OPEN',
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
    mode: string;
    implementations: number;
    pushes: number;
    edits: number;
    verifications: number;
    beforeVerify?: () => Promise<void>;
    beforeActor?: () => Promise<void>;
  } = {
    mode: '',
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
      hooks.pushes++;
      if (hooks.mode === 'push_failed') {
        return { ...ok(), code: 1, stderr: 'push rejected fixture' };
      }
      remoteHead = git(cwd, 'rev-parse', 'HEAD');
      pr.headRefOid = remoteHead;
      if (hooks.mode === 'push_interrupt') {
        process.emit('SIGINT');
        throw Error('Interrupted push fixture');
      }
      return ok();
    }
    if (argv.includes('commit') && hooks.mode === 'commit_failed') {
      return { ...ok(), code: 1, stderr: 'commit rejected fixture' };
    }
    return command(argv, cwd, input, timeout);
  }
  async function editPr(argv: string[]) {
    if (argv.includes('--attach')) {
      pr.body += '\nhttps://example.com/revision.png';
      return ok();
    }
    hooks.edits++;
    if (hooks.mode === 'edit_failed') {
      return { ...ok(), code: 1, stderr: 'body update failed fixture' };
    }
    const body = argv[argv.indexOf('--body-file') + 1];
    assert(body);
    pr.body = await readFile(body, 'utf8');
    if (hooks.mode === 'edit_interrupt') {
      process.emit('SIGTERM');
    }
    if (hooks.mode === 'readback_changed') {
      pr.body = 'Concurrent edit';
    }
    return ok();
  }
  function issueReply() {
    return ok(
      hooks.mode === 'issue_after_push' && hooks.pushes > 1
        ? issue.replace('Keep result visible', 'Changed requirement')
        : issue,
    );
  }
  async function githubCommand(argv: string[]) {
    if (argv[1] === 'issue') {
      return issueReply();
    }
    if (argv[1] === 'pr' && argv[2] === 'view') {
      if (hooks.mode === 'ci_failed' && argv.at(-1)?.includes('statusCheckRollup')) {
        return { ...ok(), code: 1, stderr: 'CI unavailable fixture' };
      }
      return ok(JSON.stringify(pr));
    }
    if (argv[2] === 'edit') {
      return editPr(argv);
    }
    if (argv[2]?.includes('/git/ref/')) {
      return ok(JSON.stringify({ object: { sha: remoteHead } }));
    }
    const reply = githubTarget(argv);
    if (reply !== undefined) {
      return ok(reply);
    }
    throw Error(`Unexpected GitHub fixture command: ${argv.join(' ')}`);
  }
  async function actor(cwd: string, input: string) {
    hooks.implementations++;
    if (hooks.implementations === 1) {
      await writeFile(join(cwd, 'original-pr.txt'), 'original issue deliverable');
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
    if (hooks.mode === 'body_changed') {
      pr.body += '\nHand edit';
    }
    if (hooks.mode === 'request_changed') {
      await writeFile(request, 'Expanded scope');
    }
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
        reviewFormat: 3,
        baseCommit: config.baseCommit ?? initialBase,
        configHash: hash(JSON.stringify(config)),
        issueHash: hash(issue),
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
          if (hooks.mode === 'target_after_push' && argv[2] === 'repos/team/component') {
            return JSON.stringify({
              full_name: 'team/component',
              id: 456,
              permissions: { push: true },
            });
          }
          if (hooks.mode === 'readback_actor_changed' && hooks.edits && argv[2] === 'user') {
            return JSON.stringify({ login: 'another-operator' });
          }
          return result.stdout.trim();
        },
      });
    },
  };
  await develop(['99', '--repo', repo, '--run-dir', prior], io);
  commands.length = 0;
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
    expect(result.status).toBe('ready_for_human_review');
    expect(f.hooks.edits).toBe(1);
    expect(f.pr.body).toContain(result.commit ?? 'missing commit');
    expect(f.pr.body).toContain('Closes #99');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const failures: Record<string, RegExp> = {
  dirty: /Checkout differs|clean tracked/,
  wrong_head: /PR identity changed/,
  wrong_author: /PR identity changed/,
  wrong_repo: /PR identity changed/,
  wrong_base: /PR identity changed/,
  wrong_issue: /PR Issue changed/,
  wrong_body_issue: /PR Issue changed/,
  wrong_pr: /PR identity changed/,
  body_changed: /PR body changed/,
  issue_after_push: /Agreed Issue changed/,
  target_after_push: /Revision target or actor changed/,
  unfinished_sibling: /Unfinished or uncertain execution/,
  uncertain_sibling: /Unfinished or uncertain execution/,
  unfinished: /Previous verification is unfinished/,
  uncertain: /Previous publication is incomplete/,
  request_changed: /Revision request changed/,
  commit_failed: /commit rejected fixture/,
  push_failed: /push rejected fixture/,
  push_interrupt: /Interrupted push fixture/,
  edit_failed: /body update failed fixture/,
  edit_interrupt: /Interrupted execution/,
  readback_changed: /PR body changed/,
  readback_actor_changed: /Revision target or actor changed/,
  ci_failed: /unavailable:/,
};
async function successfulRevision(f: Awaited<ReturnType<typeof fixture>>, mode: string) {
  const { pr, hooks } = f;
  const verifiedHeads: string[] = [];
  let beforeCommit = -1;
  hooks.beforeVerify = async () => {
    verifiedHeads.push(git(f.cwd, 'rev-parse', 'HEAD'));
    if (verifiedHeads.length === 2) {
      beforeCommit = f.commands.length;
    }
  };
  const result = await develop(f.args, f.io);
  expect(result.status).toBe(mode === 'local' ? 'verified_local' : 'ready_for_human_review');
  const config = await readObject(join(f.dir, 'verification-config.json'));
  expect(config.baseCommit).toBe(f.initialBase);
  expect(config).toMatchObject({
    repairLimit: 2,
    reviewLimit: 2,
    modelTimeMs: null,
    revision: { head: f.oldHead },
  });
  expect(result.url).toBe(pr.url);
  expect(hooks.edits).toBe(mode === 'local' ? 0 : 1);
  // Start inputs are checked at entry and after setup, once per canonical checkout.
  expect(f.commands.filter(({ argv }) => argv[1] === 'hash-object')).toEqual(
    Array.from({ length: 2 }, () => ({
      argv: ['git', 'hash-object', '--no-filters', '--', '.dotagents.json'],
      cwd: f.cwd,
    })),
  );
  if (mode === 'local') {
    expect(verifiedHeads).toEqual([f.oldHead]);
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.oldHead);
    expect(result.publication).toBe('not_attempted');
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
    ).toHaveLength(1);
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
async function stoppedRevision(f: Awaited<ReturnType<typeof fixture>>, mode: string) {
  const { pr, hooks } = f;
  const expected = failures[mode];
  assert(expected);
  await assert.rejects(() => withInterrupts(() => develop(f.args, f.io)), expected);
  const result = await readObject(join(f.dir, 'result.json')).catch(() => undefined);
  if (
    [
      'push_failed',
      'push_interrupt',
      'edit_failed',
      'edit_interrupt',
      'readback_changed',
      'readback_actor_changed',
      'ci_failed',
      'commit_failed',
      'request_changed',
      'body_changed',
      'issue_after_push',
      'target_after_push',
    ].includes(mode)
  ) {
    assert(result);
    expect(result.url).toBe(pr.url);
    expect(result.status).toBe('stopped');
    expect(result.publication).toBe(
      mode === 'ci_failed'
        ? 'published'
        : ['commit_failed', 'request_changed', 'body_changed'].includes(mode)
          ? 'not_attempted'
          : 'unconfirmed',
    );
    expect(result.nextAction).toBeTruthy();
    if (['issue_after_push', 'target_after_push'].includes(mode)) {
      expect(hooks.edits).toBe(0);
      expect(hooks.pushes).toBe(2);
    }
    if (mode === 'readback_actor_changed') {
      expect(hooks.edits).toBe(1);
      expect(hooks.pushes).toBe(2);
    }
    if (!['request_changed', 'commit_failed', 'body_changed'].includes(mode)) {
      expect(result.commit).not.toBe(f.oldHead);
    }
  } else {
    expect(hooks.implementations).toBe(1);
  }
  if (
    [
      'dirty',
      'wrong_head',
      'wrong_author',
      'wrong_repo',
      'wrong_base',
      'wrong_issue',
      'wrong_body_issue',
      'wrong_pr',
      'body_changed',
      'unfinished',
      'uncertain',
      'request_changed',
      'commit_failed',
    ].includes(mode)
  ) {
    expect(hooks.pushes).toBe(1);
    expect(hooks.edits).toBe(0);
  }
}
for (const mode of ['success', 'local', ...Object.keys(failures)]) {
  test(`existing PR revision: ${mode}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-')));
    try {
      const f = await fixture(root);
      const priorState = await readFile(join(f.prior, 'verification/state.json'), 'utf8');
      const priorResult = await readFile(join(f.prior, 'result.json'), 'utf8');
      const { pr, hooks } = f;
      hooks.mode = mode;
      const identityChanges: Record<string, () => void> = {
        wrong_head: () => {
          pr.headRefOid = 'a'.repeat(40);
        },
        wrong_author: () => {
          pr.author.login = 'someone';
        },
        wrong_repo: () => {
          pr.headRepositoryOwner.login = 'another';
        },
        wrong_base: () => {
          pr.baseRefName = 'main';
        },
        wrong_issue: () => {
          pr.closingIssuesReferences = [{ url: 'https://github.com/team/component/issues/98' }];
        },
        wrong_body_issue: () => {
          pr.body = pr.body.replace('Closes #99', 'Closes #990');
        },
        wrong_pr: () => {
          pr.url = 'https://github.com/team/component/pull/101';
        },
      };
      identityChanges[mode]?.();
      if (mode === 'dirty') {
        await writeFile(join(f.cwd, 'untracked.txt'), 'keep me');
      }
      if (mode === 'unfinished') {
        await writeFile(
          join(f.prior, 'verification/state.json'),
          JSON.stringify({
            ...(await readObject(join(f.prior, 'verification/state.json'))),
            active: { role: 'repair', prefix: 'unfinished' },
          }),
        );
      }
      if (mode === 'uncertain') {
        await writeFile(
          join(f.prior, 'result.json'),
          JSON.stringify({
            ...(await readObject(join(f.prior, 'result.json'))),
            publication: 'unconfirmed',
          }),
        );
      }
      if (mode.endsWith('_sibling')) {
        const sibling = join(root, 'other-revision');
        await mkdir(sibling);
        await writeFile(
          join(sibling, 'result.json'),
          JSON.stringify({
            checkout: f.cwd,
            reason: mode === 'unfinished_sibling' ? '' : 'Interrupted',
            publication: mode === 'uncertain_sibling' ? 'unconfirmed' : 'not_attempted',
          }),
        );
      }
      if (mode === 'local') {
        f.args.push('--no-publish');
        pr.closingIssuesReferences = [{ url: 'https://github.com/team/component/issues/99' }];
      }
      if (mode === 'success' || mode === 'local') {
        await successfulRevision(f, mode);
      } else {
        await stoppedRevision(f, mode);
      }
      if (!['unfinished', 'uncertain'].includes(mode)) {
        expect(await readFile(join(f.prior, 'verification/state.json'), 'utf8')).toBe(priorState);
        expect(await readFile(join(f.prior, 'result.json'), 'utf8')).toBe(priorResult);
      }
      if (mode === 'dirty') {
        expect(await readFile(join(f.cwd, 'untracked.txt'), 'utf8')).toBe('keep me');
      }
    } finally {
      await withInterrupts(async () => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const changed of [false, true]) {
  test(`revision attachment reconciles a fresh target once: actor changed=${changed}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-media-')));
    try {
      const f = await fixture(root, true);
      let published = -1;
      const publish = f.io.publish;
      f.io.publish = async (input) => {
        const url = await publish(input);
        published = f.commands.length;
        return url;
      };
      const command = f.io.command;
      f.io.command = async (argv, cwd, input, timeout) => {
        const result = await command(argv, cwd, input, timeout);
        if (changed && published >= 0 && argv[2] === 'user') {
          return ok(JSON.stringify({ login: 'another-operator' }));
        }
        return result;
      };
      if (changed) {
        await assert.rejects(
          () => develop(f.args, f.io),
          /Target configuration or GitHub actor changed/,
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
        expect(result.status).toBe('ready_for_human_review');
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

for (const changedIssue of [false, true]) {
  test(`correction evaluates the whole PR and request with live Issue checks: changed=${changedIssue}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-controller-')));
    const originalPath = process.env.PATH;
    try {
      const f = await fixture(root);
      await develop([...f.args, '--no-publish'], f.io);
      const config: unknown = JSON.parse(
        await readFile(join(f.dir, 'verification-config.json'), 'utf8'),
      );
      assertConfig(config);
      assert(config.revision);
      const request = config.revision.request;
      const bin = join(root, 'bin');
      await mkdir(bin);
      const gh = join(bin, 'gh');
      const liveIssue = join(root, 'issue.json');
      await writeFile(liveIssue, issue + '\n');
      await writeFile(
        gh,
        `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const args = process.argv.slice(2);
const pr = ${JSON.stringify(f.pr)};
if (['issue', 'pr'].includes(args[0])) appendFileSync(${JSON.stringify(join(root, 'reads'))}, args[0]+'\\n');
if(args[0] === 'issue') process.stdout.write(readFileSync(${JSON.stringify(liveIssue)},'utf8'));
else if(args[0] === 'pr') console.log(JSON.stringify(pr));
else if(args[1] === 'user') console.log('{"login":"operator"}');
else if(args[1].includes('/git/ref/')) console.log(JSON.stringify({object:{sha:pr.headRefOid}}));
else if(args[1].includes('/branches/')) console.log('{"name":"release"}');
else console.log('{"full_name":"team/component","id":123,"permissions":{"push":true}}');
`,
      );
      await chmod(gh, 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      const helper = join(root, 'actor.js');
      await writeFile(
        helper,
        `
import {readFileSync,writeFileSync} from 'node:fs';
const role = process.argv[2];
${reviewReplySource}
if(role === 'check') {
 if (${changedIssue}) writeFileSync(${JSON.stringify(liveIssue)}, ${JSON.stringify(issue.replace('Keep result visible', 'Changed requirements'))});
 process.exit(readFileSync('result.txt','utf8') === 'corrected' ? 0 : 1);
}
if(role === 'repair') { writeFileSync('result.txt','corrected'); console.log(JSON.stringify({status:'repaired',findings:'Reset corrected'})); }
if(role === 'review') console.log(JSON.stringify(reviewReply('accepted','Issue and revision inspected')));
`,
      );
      config.runDir = join(f.dir, 'controller');
      config.check = [process.execPath, helper, 'check'];
      config.repair = [process.execPath, helper, 'repair'];
      config.review = [process.execPath, helper, 'review'];
      if (changedIssue) {
        await assert.rejects(() => run(config), /Agreed Issue changed during revision/);
        expect(await readObject(join(config.runDir, 'state.json'))).toMatchObject({
          repair: 0,
          review: 0,
          checks: 1,
          active: null,
        });
        expect(await readFile(join(f.cwd, 'result.txt'), 'utf8')).toBe('reset corrected');
        return;
      }
      const state = await run(config);
      expect(state.result).toBe('ready_for_human_review');
      expect(state.repair).toBe(1);
      expect(state.review).toBe(1);
      expect(state.issueHash).toBe(hash(issue + '\n'));
      const reads = (await readFile(join(root, 'reads'), 'utf8')).trim().split('\n');
      expect(reads.filter((role) => role === 'issue').length).toBeGreaterThan(1);
      expect(reads).toEqual(reads.filter((role) => role === 'pr').flatMap(() => ['issue', 'pr']));
      expect(await readFile(join(config.runDir, 'repair-1.prompt'), 'utf8')).toContain(request);
      expect(await readFile(join(config.runDir, 'review-1.prompt'), 'utf8')).toContain(request);
      expect(await readFile(join(config.runDir, 'review-1.prompt'), 'utf8')).toContain(f.oldBody);
      expect(await readFile(join(config.runDir, 'review-1.diff'), 'utf8')).toContain(
        'original issue deliverable',
      );
      const target = await readObject(join(config.runDir, 'review-1.target.json'));
      expect(target).toMatchObject({
        baseCommit: f.initialBase,
        revision: { request, head: f.oldHead },
      });
      const saved = await readFile(join(config.runDir, 'state.json'), 'utf8');
      await writeFile(f.request, 'Another request');
      await assert.rejects(() => run(config), /Revision request changed/);
      expect(await readFile(join(config.runDir, 'state.json'), 'utf8')).toBe(saved);
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
    await successfulRevision(f, 'success');
    expect(reconciled).toBe(true);
    expect(f.hooks.implementations).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
