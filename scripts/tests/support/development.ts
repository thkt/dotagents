import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, withInterrupts } from '../../process.ts';
import type { Config, State } from '../../input.ts';
import type { PublishInput } from '../../publish.ts';
import { reviewSummary } from '../../review.ts';
import type { Review } from '../../review.ts';
import { initializeTarget, githubTarget, targetConfig } from './target.ts';

export const issue = JSON.stringify({
  title: 'Make result visible',
  body: 'Show the requested result.',
  state: 'OPEN',
  updatedAt: '1',
});
export const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, ms: 1 });
export async function git(cwd: string, ...args: string[]) {
  const result = await command(['git', ...args], cwd, '', 10000);
  expect(result.code).toBe(0);
  return result.stdout.trim();
}
export const mediaCapture = {
  command: ['capture-fixture'],
  destination: 'review/media',
  required: false,
};

async function developmentFixture(root: string, overrides: Partial<typeof targetConfig>) {
  const repo = join(root, 'repo');
  const dir = join(root, 'run');
  const settings = {
    ...targetConfig,
    setup: [['sh', '-c', 'printf configured > setup.txt']],
    check: [
      'sh',
      '-c',
      'test "$(cat result.txt)" = implemented && test "$(cat setup.txt)" = configured',
    ],
    ...overrides,
  };
  await mkdir(repo);
  await initializeTarget(repo, settings);
  const review: Review = {
    status: 'accepted',
    targetId: 'internal-current-target',
    findings: `Internal narrative: ${dir}/verification/review-2.stdout\nRAW_LOG_ONLY`,
    assessments: {
      code: `Keep the requested result visible until reset so readers can inspect it. The /home/settings route now preserves the selected filters; see https://example.com/results. 詳細は${dir}/verification/check-2.stdoutを確認済みだが実サービスのタイミングは未確認。`,
      requirements: 'Issue #99 requires a visible result; result.txt now retains that result.',
      tests: `Reset and empty-input checks passed; live service behavior remains unverified. Details: ${dir}/verification/check-2.stdout`,
      documentation:
        'The historical pointer observation applies only to pointer input; focus movement remains an unagreed proposal.',
    },
    items: [
      {
        id: 'R1-result',
        introducedIn: 'internal-old-target',
        kind: 'defect',
        area: 'requirements',
        required: true,
        location: { path: 'result.txt', line: 1 },
        condition: 'Reset left stale content.',
        impact: 'Readers could see an obsolete result.',
        evidence: `RAW_LOG_ONLY\n${dir}/verification/check-1.stderr`,
        action: 'Clear the retained result on reset.',
        disposition: 'fixed',
        reason: `Reset now clears the result, confirmed by the reset check (${dir}/verification/check-2.stdout).`,
      },
      {
        id: 'R2-live',
        introducedIn: 'internal-current-target',
        kind: 'concern',
        area: 'tests',
        required: false,
        location: { path: null, line: null },
        condition: 'Live service timing is unmeasured.',
        impact: 'Timing may differ in production.',
        evidence: 'Only simulated service responses were available.',
        action: '担当AI: Report live service timing as unverified.',
        disposition: 'open',
        reason: 'This run verifies the agreed local behavior only.',
      },
    ],
    documents: [
      {
        path: '.dotagents.json',
        role: 'current',
        reason: 'Defines the local check; its success does not establish live service behavior.',
      },
    ],
    handoff: [
      `担当AI: 実サービスAの応答が遅い場合、結果の保持時間を計測する。現時点では未計測（${dir}/verification/check-2.stdout）。`,
      '運用担当: 実サービスBの応答が遅い場合、結果の保持時間を計測する。現時点では未計測。',
    ],
  };
  const firstItem = review.items[0];
  assert(firstItem);
  const history: Review[] = [
    {
      ...review,
      status: 'needs_changes',
      targetId: 'internal-old-target',
      items: [
        { ...firstItem, disposition: 'open', reason: 'Still reproducible in the first check.' },
      ],
    },
    review,
  ];
  const { status: _status, items, ...details } = review;
  const rawReview = JSON.stringify({
    ...details,
    updates: [{ id: firstItem.id, disposition: firstItem.disposition, reason: firstItem.reason }],
    newItems: items
      .slice(1)
      .map(({ id: _id, introducedIn: _introducedIn, disposition: _disposition, ...item }) => item),
  });
  const summary = reviewSummary(history, [
    join(dir, 'verification/review-1.json'),
    join(dir, 'verification/review-2.json'),
  ]);

  const calls = { implementations: 0, reviews: 0, pushes: 0, publications: 0, attachments: 0 };
  const prReads: string[] = [];
  let attached = false;
  const fixture = {
    repo,
    dir,
    settings,
    calls,
    prReads,
    history,
    rawReview,
    summary,
    args: [`https://github.com/${settings.repository}/issues/99`, '--repo', repo, '--run-dir', dir],
    // Overrides are the actual IO boundaries; individual tests own fault injection.
    localCommand: command,
    async implement(
      this: void,
      _argv: string[],
      cwd: string,
      _input: string,
      _timeout: number | null,
      prefix?: string,
    ): ReturnType<typeof command> {
      const response = {
        ...ok(
          JSON.stringify({
            status: 'repaired',
            findings: 'Implementation claim, not verification',
          }),
        ),
        ms: 500,
      };
      await writeFile(`${prefix}.stdout`, response.stdout);
      await writeFile(`${prefix}.stderr`, 'Actor diagnostic');
      await writeFile(join(cwd, 'result.txt'), 'implemented');
      return response;
    },
    async prView(this: void, argv: string[], cwd: string, timeout: number | null) {
      expect(timeout).toBe(660000);
      return ok(
        JSON.stringify({
          url: `https://github.com/${settings.repository}/pull/100`,
          headRefOid: await git(cwd, 'rev-parse', 'HEAD'),
          baseRefName: settings.baseBranch,
          state: 'OPEN',
          isDraft: true,
          body: attached ? 'Closes #99\nAttached media' : 'Closes #99',
          statusCheckRollup: [{ name: 'checks', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
      );
    },
    async github(this: void, argv: string[], cwd: string, timeout: number | null) {
      switch (`${argv[1]}/${argv[2]}`) {
        case `api/repos/${settings.repository}/pulls/100`:
          return ok(
            JSON.stringify({
              html_url: `https://github.com/${settings.repository}/pull/100`,
              state: 'open',
              draft: true,
              user: { login: 'operator' },
              head: {
                ref: await git(cwd, 'branch', '--show-current'),
                sha: await git(cwd, 'rev-parse', 'HEAD'),
                repo: { full_name: settings.repository },
              },
              base: { ref: settings.baseBranch, repo: { full_name: settings.repository } },
              body: await readFile(join(dir, 'pr.md'), 'utf8'),
            }),
          );
        case 'issue/view':
          return ok(issue);
        case `api/repos/${settings.repository}/pulls`:
          expect(argv).toContain('--paginate');
          expect(argv).toContain('--slurp');
          expect(argv).toContain('state=open');
          expect(argv).toContain(`head=${settings.repository.split('/')[0]}:codex/development-99`);
          expect(argv).not.toContain('--base');
          return ok(JSON.stringify([[]]));
        case 'pr/edit':
          attached = true;
          return ok();
        case 'pr/view':
          return fixture.prView(argv, cwd, timeout);
        default: {
          const reply = githubTarget(argv, settings);
          assert(reply !== undefined, 'Unexpected gh call');
          return ok(reply);
        }
      }
    },
    async verify(this: void, config: Config): Promise<State> {
      if (calls.reviews === 1) {
        await mkdir(config.runDir, { recursive: true });
        await writeFile(join(config.runDir, 'review-2.stdout'), rawReview);
        if (settings.capture) {
          const media = join(config.cwd, 'review/media');
          await mkdir(media, { recursive: true });
          await writeFile(join(media, 'view.png'), 'image');
        }
      }
      expect(await readFile(join(config.cwd, 'result.txt'), 'utf8')).toBe('implemented');
      return {
        reviewFormat: 4,
        baseCommit: await git(config.cwd, 'rev-parse', 'HEAD'),
        reviewHistory: history,
        configHash: '',
        issueHash: '',
        repair: 0,
        review: 1,
        checks: 1,
        modelMs: 1,
        active: null,
        events: [],
        findings: summary,
        result: 'ready_for_human_review',
      };
    },
    async publish(this: void, input: PublishInput) {
      expect(input.cwd).toBe(join(dir, 'checkout'));
      expect(input.actor).toBe('operator');
      expect(calls.pushes).toBe(1);
      expect(input.bodyFile).toBe(join(dir, 'pr.md'));
      expect(await readFile(input.bodyFile, 'utf8')).toContain('Closes #99');
      return `https://github.com/${settings.repository}/pull/100`;
    },
  };
  async function githubCommand(
    argv: string[],
    cwd: string,
    timeout: number | null,
    prefix?: string,
  ) {
    if (argv[1] === 'pr' && argv[2] === 'edit') {
      calls.attachments++;
    }
    if (argv[1] === 'pr' && argv[2] === 'view') {
      prReads.push(argv.at(-1) ?? '');
    }
    const response = await fixture.github(argv, cwd, timeout);
    if (prefix) {
      await writeFile(`${prefix}.stdout`, response.stdout);
      await writeFile(`${prefix}.stderr`, response.stderr);
    }
    return response;
  }
  const io = {
    command: async (
      argv: string[],
      cwd: string,
      input: string,
      timeout: number | null,
      prefix?: string,
    ) => {
      if (argv[0] === 'git' && argv.includes('push')) {
        calls.pushes++;
        expect(argv).toContain(
          `remote.dotagents-publish.pushurl=https://github.com/${settings.repository}.git`,
        );
        expect(argv).toContain('credential.helper=!gh auth git-credential');
        return ok();
      }
      if (['git', 'sh'].includes(argv[0] ?? '')) {
        expect(timeout).toBe(660000);
        return fixture.localCommand(argv, cwd, input, timeout, prefix);
      }
      if (argv[0] === 'gh') {
        return githubCommand(argv, cwd, timeout, prefix);
      }
      expect(argv.slice(1, 3)).toEqual([
        new URL('../../codex-actor.ts', import.meta.url).pathname,
        'repair',
      ]);
      expect(timeout).toBeNull();
      expect(input).toContain('Show the requested result.');
      calls.implementations++;
      return fixture.implement(argv, cwd, input, timeout, prefix);
    },
    verify: async (config: Config) => {
      expect(config).not.toHaveProperty('writing');
      expect(config.modelTimeMs).toBeNull();
      expect(config.repairLimit).toBe(2);
      expect(config.reviewLimit).toBe(2);
      expect(config.checkTimeMs).toBe(540000);
      calls.reviews++;
      const state = await fixture.verify(config);
      if (calls.reviews === 1) {
        await writeFile(join(config.runDir, 'state.json'), JSON.stringify(state));
      }
      return state;
    },
    publish: async (input: PublishInput) => {
      calls.publications++;
      return fixture.publish(input);
    },
  };
  return Object.assign(fixture, { io });
}

export type DevelopmentFixture = Awaited<ReturnType<typeof developmentFixture>>;
export function testDevelopment(
  name: string,
  run: (fixture: DevelopmentFixture) => Promise<void>,
  settings: Partial<typeof targetConfig> = {},
) {
  test(`development ${name}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'development run-')));
    try {
      await run(await developmentFixture(root, settings));
    } finally {
      await withInterrupts(async () => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
