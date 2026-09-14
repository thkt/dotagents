import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { develop } from '../development.ts';
import { command } from '../correction.ts';
import type { Config, State } from '../input.ts';
import { initializeTarget, githubTarget, targetConfig } from './support/target.ts';

const issue = JSON.stringify({
  title: 'Make result visible',
  body: 'Show the requested result.',
  state: 'OPEN',
  updatedAt: '1',
});
const stopReasons = {
  denied_start: /GitHub push permission required/,
  permission_lost: /GitHub push permission required/,
  attachment_actor_changed: /Target configuration or GitHub actor changed/,
  initial_failure: /Initial implementation process failed/,
  needs_human: /Human decision required: Need agreement on scope/,
  invalid_reply: /Invalid implementation reply/,
  timeout: /Initial implementation timed out/,
  review_failure: /Verification stopped: review_failed/,
  requirements_changed: /Requirements changed during implementation/,
  source_changed: /Verified source or requirements changed/,
  ci_failure: /PR created but CI is not confirmed/,
  writing_failure: /Command failed: .*; Writing review failed in fixture/,
  wrong_repo: /GitHub repository mismatch/,
  missing_check: /Verification command is required/,
  wrong_issue: /Issue does not match target repository/,
  wrong_push: /Remote\/repository mismatch/,
  actor_changed: /Target configuration or GitHub actor changed/,
  local_actor_changed: /Target configuration or GitHub actor changed/,
  config_changed: /Target configuration or GitHub actor changed/,
  branch_changed: /Actor changed branch or HEAD/,
  head_changed: /Actor changed branch or HEAD/,
  dirty: /Commit or preserve pending work before development/,
};

async function checkStop(
  mode: keyof typeof stopReasons,
  dir: string,
  reviews: number,
  implementations: number,
) {
  if (mode === 'denied_start') {
    expect(implementations).toBe(0);
    expect(existsSync(join(dir, 'checkout'))).toBe(false);
  }
  if (
    !['denied_start', 'wrong_repo', 'dirty', 'missing_check', 'wrong_issue', 'wrong_push'].includes(
      mode,
    )
  ) {
    expect(await readFile(join(dir, 'stopped.txt'), 'utf8')).toMatch(stopReasons[mode]);
  }
  if (
    [
      'initial_failure',
      'needs_human',
      'invalid_reply',
      'timeout',
      'requirements_changed',
      'wrong_repo',
      'dirty',
      'missing_check',
      'wrong_issue',
      'wrong_push',
    ].includes(mode)
  ) {
    expect(reviews).toBe(0);
  }
}

function actorReply(mode: string) {
  return mode === 'invalid_reply'
    ? 'not JSON'
    : JSON.stringify({
        status: mode === 'needs_human' ? 'needs_human' : 'repaired',
        findings: 'Need agreement on scope',
      });
}

function implementationResult(mode: string) {
  return {
    ...ok(actorReply(mode)),
    code: mode === 'initial_failure' ? 1 : 0,
    ms: 500,
    timedOut: mode === 'timeout',
  };
}

async function writingStub(argv: string[], mode: string) {
  if (mode === 'writing_failure') {
    return { ...ok(), code: 1, stderr: 'Writing review failed in fixture' };
  }
  const input = argv[argv.indexOf('--input') + 1];
  const output = argv[argv.indexOf('--output') + 1];
  assert(input && output);
  await writeFile(output, await readFile(input, 'utf8'));
  return ok();
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, ms: 1 });
async function git(cwd: string, ...args: string[]) {
  const result = await command(['git', ...args], cwd, '', 10000);
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

async function prepareInput(repo: string, mode: string, settings: typeof targetConfig) {
  if (mode === 'missing_check') {
    await writeFile(join(repo, '.dotagents.json'), JSON.stringify({ ...settings, check: [] }));
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'unset verification');
  }
  if (mode === 'wrong_push') {
    await git(
      repo,
      'remote',
      'set-url',
      '--push',
      settings.remote,
      'git@github.com:other/repo.git',
    );
  }
  return git(repo, 'rev-parse', 'HEAD');
}

function targetResponse(
  mode: string,
  reply: string,
  repository: string,
  reviews: number,
  publications: number,
) {
  if (mode === 'wrong_repo') {
    return reply.replace(repository, 'other/repo');
  }
  if (
    ['denied_start', 'local_denied'].includes(mode) ||
    (mode === 'permission_lost' && reviews > 0)
  ) {
    reply = reply.replace('"push":true', '"push":false');
  }
  if (mode === 'attachment_actor_changed' && publications > 0) {
    reply = reply.replace('operator', 'different-operator');
  }
  return ['actor_changed', 'local_actor_changed'].includes(mode) && reviews > 0
    ? reply.replace('operator', 'different-operator')
    : reply;
}
function localArguments(mode: string) {
  return mode === 'local_actor_changed' ? ['--no-publish'] : [];
}
async function changeTarget(mode: string, config: Config, settings: typeof targetConfig) {
  switch (mode) {
    case 'config_changed':
      await writeFile(join(config.cwd, '.dotagents.json'), JSON.stringify(settings) + '\n');
      break;
    case 'branch_changed':
      await git(config.cwd, 'switch', '-c', 'unexpected');
      break;
    case 'head_changed':
      await git(config.cwd, 'add', '.');
      await git(config.cwd, 'commit', '-m', 'unexpected actor commit');
  }
}

for (const mode of [
  'success',
  'denied_start',
  'permission_lost',
  'local_denied',
  'attachment_actor_changed',
  'initial_failure',
  'needs_human',
  'invalid_reply',
  'timeout',
  'local_only',
  'review_failure',
  'requirements_changed',
  'source_changed',
  'ci_failure',
  'writing_failure',
  'wrong_repo',
  'dirty',
  'missing_check',
  'wrong_issue',
  'wrong_push',
  'other_repo',
  'actor_changed',
  'local_actor_changed',
  'config_changed',
  'branch_changed',
  'head_changed',
] as const) {
  test(`development ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'development-'));
    const repo = join(root, 'repo');
    const dir = join(root, 'run');
    await mkdir(repo);
    const settings =
      mode === 'other_repo'
        ? {
            ...targetConfig,
            setup: [['sh', '-c', 'printf configured > setup.txt']],
            check: [
              'sh',
              '-c',
              'test "$(cat result.txt)" = implemented && test "$(cat setup.txt)" = configured',
            ],
          }
        : {
            repository: 'thkt/dotagents-workflow-trial',
            remote: 'origin',
            baseBranch: 'main',
            setup: [
              ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
              ['bun', 'run', 'setup:e2e'],
            ],
            check: ['bun', 'run', 'check'],
            capture: {
              command: [
                'bun',
                '{harness}/scripts/capture.ts',
                'trial/capture.spec.js',
                'trial/playwright.config.js',
              ],
              destination: 'trial/evidence/generated',
              required: false,
            },
          };
    await initializeTarget(repo, settings);
    const original = await prepareInput(repo, mode, settings);
    if (mode === 'dirty') {
      await writeFile(join(repo, 'unrelated.txt'), 'retain');
    }
    let implementations = 0,
      reviews = 0,
      pushes = 0,
      publications = 0;
    async function github(argv: string[], cwd: string) {
      const targetReply = githubTarget(argv, settings);
      if (targetReply !== undefined) {
        return ok(targetResponse(mode, targetReply, settings.repository, reviews, publications));
      }
      switch (`${argv[1]}/${argv[2]}`) {
        case 'issue/view':
          return ok(
            mode === 'requirements_changed' && implementations
              ? issue.replace('visible', 'different')
              : issue,
          );
        case 'pr/checks':
          return {
            ...ok(),
            code: mode === 'ci_failure' ? 1 : 0,
          };
        case 'pr/view':
          return ok(
            JSON.stringify({
              url: `https://github.com/${settings.repository}/pull/100`,
              headRefOid: await git(cwd, 'rev-parse', 'HEAD'),
              baseRefName: settings.baseBranch,
              state: 'OPEN',
              body: 'Closes #99',
              statusCheckRollup: [{ name: 'checks' }],
            }),
          );
        default:
          throw Error('Unexpected gh call');
      }
    }
    const io = {
      command: async (
        argv: string[],
        cwd: string,
        input: string,
        timeout: number,
        prefix?: string,
      ) => {
        if (argv[1]?.endsWith('/writing-review.ts')) {
          return writingStub(argv, mode);
        }
        if (argv[0] === 'git' && argv.includes('push')) {
          pushes++;
          expect(argv).toContain(
            `remote.dotagents-publish.pushurl=https://github.com/${settings.repository}.git`,
          );
          expect(argv).toContain('credential.helper=!gh auth git-credential');
          return ok();
        }
        if (['git', 'sh'].includes(argv[0] ?? '')) {
          return command(argv, cwd, input, timeout, prefix);
        }
        if (argv[0] === 'gh') {
          return github(argv, cwd);
        }
        if (argv[0] === 'bun') {
          return ok();
        }
        implementations++;
        if (mode === 'other_repo') {
          expect(input).not.toContain('CAPTURE_OUTPUT');
          expect(input).not.toContain('Close video contexts');
          expect(input).toContain('If the agreed Issue needs media, return needs_human');
          expect(await readFile(join(cwd, 'setup.txt'), 'utf8')).toBe('configured');
        }
        expect(input).toContain('Show the requested result.');
        await writeFile(join(cwd, 'result.txt'), 'implemented');
        return implementationResult(mode);
      },
      verify: async (config: Config): Promise<State> => {
        reviews++;
        if (reviews === 1) {
          await changeTarget(mode, config, settings);
          if (mode === 'attachment_actor_changed') {
            const media = join(config.cwd, 'trial/evidence/generated');
            await mkdir(media, { recursive: true });
            await writeFile(join(media, 'view.png'), 'image');
          }
        }
        if (mode === 'other_repo') {
          expect(config.check).toEqual(settings.check);
          expect(config.capture).toBeUndefined();
          expect((await command(config.check, config.cwd, '', 10000)).code).toBe(0);
        }
        if (mode === 'success') {
          expect(config.capture?.length).toBeGreaterThan(0);
          expect(config.modelTimeMs).toBe(1200000 - 500);
        }
        expect(await readFile(join(config.cwd, 'result.txt'), 'utf8')).toBe('implemented');
        return {
          configHash: '',
          issueHash: '',
          repair: 0,
          review: 1,
          checks: 1,
          modelMs: 1,
          active: null,
          events: [],
          findings: 'Verified current implementation and media',
          result:
            mode === 'review_failure'
              ? 'review_failed'
              : mode === 'source_changed' && reviews > 1
                ? 'target_changed_after_stop'
                : 'ready_for_human_review',
        };
      },
      publish: async (args: string[]) => {
        expect(args).toContain('--repo');
        expect(args[args.indexOf('--actor') + 1]).toBe('operator');
        publications++;
        expect(pushes).toBe(1);
        return `https://github.com/${settings.repository}/pull/100`;
      },
    };
    try {
      const args = [
        mode === 'wrong_issue'
          ? 'https://github.com/other/repo/issues/99'
          : `https://github.com/${settings.repository}/issues/99`,
        '--repo',
        repo,
        '--run-dir',
        dir,
      ];
      args.push(...localArguments(mode));
      if (mode === 'local_only' || mode === 'other_repo' || mode === 'local_denied') {
        const result = await develop([...args, '--no-publish'], io);
        assert('status' in result);
        expect(result.status).toBe('verified_local');
        expect(pushes).toBe(0);
        expect(publications).toBe(0);
      } else if (mode === 'success') {
        const result = await develop(args, io);
        assert('ci' in result);
        expect(result.ci).toBe('passed');
        expect(result.url).toContain('/pull/100');
        expect(publications).toBe(1);
        const body = await readFile(join(dir, 'pr.md'), 'utf8');
        expect(body).toContain('Verified current implementation and media');
        expect(body).not.toContain('Need agreement on scope');
        await assert.rejects(() => develop(args, io), /EEXIST/);
        expect(implementations).toBe(1);
        expect(publications).toBe(1);
      } else {
        await assert.rejects(() => develop(args, io), stopReasons[mode]);
        expect(publications).toBe(
          ['ci_failure', 'attachment_actor_changed'].includes(mode) ? 1 : 0,
        );
        expect(pushes).toBe(['ci_failure', 'attachment_actor_changed'].includes(mode) ? 1 : 0);
        await checkStop(mode, dir, reviews, implementations);
        if (mode === 'ci_failure') {
          expect(await readFile(join(dir, 'pr-url.txt'), 'utf8')).toContain('/pull/100');
        }
      }
      expect(await git(repo, 'rev-parse', 'HEAD')).toBe(original);
      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('old');
      if (mode === 'dirty') {
        expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('retain');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
