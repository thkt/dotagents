import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { develop } from '../../implement/orchestrator.ts';
import { publish } from '../../implement/publish.ts';
import type { PublishInput } from '../../implement/publish.ts';
import { snapshot } from '../../implement/correction.ts';
import { command, withInterrupts } from '../../shared/process.ts';

import { correctionConfig } from './correction.ts';
import type { Config, State, Revision } from '../../implement/input.ts';
import { isRecord } from '../../shared/values.ts';
import { initializeTarget, githubTarget, git, targetConfig } from './target.ts';

export const shellLiteral = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const issue = JSON.stringify({
  title: 'Visible result',
  body: 'Keep result visible',
  state: 'OPEN',
  updatedAt: '2026-09-20T00:00:00Z',
});
export const updatedRequirements = {
  title: 'Visible result with reset',
  body: 'Keep result visible and clear it on reset',
  state: 'OPEN',
  updatedAt: '2026-09-21T00:00:00Z',
};
export const updatedIssue = JSON.stringify(updatedRequirements);
export const ok = (stdout = '') => ({ stdout, stderr: '', code: 0, timedOut: false, ms: 1 });
export const reportPath = 'docs/research/start.md';
const reportContent = 'Reviewed start evidence.\n';

// 実Gitと修正・公開入口を使う。通常は前回記録を準備し、接続ケースだけ初回公開を通す。
export async function fixture(
  root: string,
  media = false,
  setup: string[][] = [],
  report = false,
  local: false | 'untracked' | 'ignored' = false,
  initialPublication = false,
  settings: Partial<typeof targetConfig> = {},
) {
  const prior = join(root, 'prior');
  const cwd = join(prior, 'checkout');
  const repo = initialPublication ? join(root, 'repo') : cwd;
  const dir = join(root, 'revision');
  await mkdir(repo, { recursive: true });
  await initializeTarget(repo, {
    ...targetConfig,
    setup,
    capture: media ? { command: ['capture'], destination: 'media', required: true } : null,
    ...settings,
  });
  if (local) {
    git(repo, 'rm', '--cached', '.dotagents.json');
    git(repo, 'commit', '-m', 'local configuration');
    if (local === 'ignored') {
      await writeFile(join(repo, '.git/info/exclude'), '/.dotagents.json\n');
    }
  }
  if (report) {
    await mkdir(join(repo, 'docs/research'), { recursive: true });
    await writeFile(join(repo, reportPath), reportContent);
    git(repo, 'add', reportPath);
    git(repo, 'commit', '-m', 'reviewed report');
  }
  const initialBase = git(repo, 'rev-parse', 'HEAD');
  const reports = report
    ? [{ path: reportPath, blob: git(repo, 'rev-parse', `${initialBase}:${reportPath}`) }]
    : [];
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
    verificationEntries: number;
    beforeCommitVerify?: () => Promise<void>;
    beforePushVerify?: () => Promise<void>;
    beforeVerify?: (head: string) => Promise<void>;
    beforeActor?: () => Promise<void>;
  } = {
    issueText: issue,
    implementations: 0,
    pushes: 0,
    edits: 0,
    verificationEntries: 0,
  };
  let remoteHead = '';
  let priorPublished = false;
  const commands: { argv: string[]; cwd: string }[] = [];
  const independentTests: {
    cwd: string;
    prompt: string;
    source: string;
    implementations: number;
  }[] = [];
  const publicationCommands: string[][] = [];
  const implementationPrompts: string[] = [];
  async function gitCommand(argv: string[], cwd: string, input: string, timeout: number | null) {
    if (argv.includes('push')) {
      if (priorPublished) {
        expect(pr.isDraft).toBe(true);
      }
      hooks.pushes++;
      const source = argv.at(-1)?.split(':')[0];
      assert(source);
      remoteHead = git(cwd, 'rev-parse', source);
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
    expect(hooks.pushes).toBe(0);
    pr.isDraft = true;
    return ok();
  }
  function branchPulls() {
    if (!priorPublished) {
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
    implementationPrompts.push(input);
    hooks.implementations++;
    if (!priorPublished) {
      await implementOriginal(cwd);
    }
    if (priorPublished) {
      await hooks.beforeActor?.();
      expect(input).toContain(await readFile(request, 'utf8'));
      expect(input).toContain(pr.body);
      if (media) {
        await mkdir(join(cwd, 'media'));
        await writeFile(join(cwd, 'media/result.png'), 'simulated capture');
      }
    }
    await writeFile(join(cwd, 'result.txt'), priorPublished ? 'reset corrected' : 'implemented');
    return ok(JSON.stringify({ status: 'repaired', findings: 'Changed requested behavior' }));
  }
  async function verifiedState(config: Config): Promise<State> {
    return {
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
  }
  const io = {
    command: async (
      argv: string[],
      cwd: string,
      input: string,
      timeout: number | null,
      prefix?: string,
    ) => {
      commands.push({ argv, cwd });
      if (argv[0] === 'git') {
        return gitCommand(argv, cwd, input, timeout);
      }
      if (argv[0] === 'gh') {
        return githubCommand(argv);
      }
      if (argv.includes('test')) {
        const match = input.match(/入力: (\{[^\n]+\})/);
        assert(match?.[1], 'テスト作成入力が必要');
        const context: unknown = JSON.parse(match[1]);
        assert(isRecord(context) && typeof context.targetId === 'string');
        independentTests.push({
          cwd,
          prompt: input,
          source: await readFile(join(cwd, 'result.txt'), 'utf8'),
          implementations: hooks.implementations,
        });
        const response = ok(
          JSON.stringify({
            targetId: context.targetId,
            status: 'unnecessary',
            findings: '既存の検証で受入条件を確認できるため追加テストは不要です。',
            files: [],
          }),
        );
        assert(prefix);
        await writeFile(`${prefix}.stdout`, response.stdout);
        await writeFile(`${prefix}.stderr`, response.stderr);
        return response;
      }
      if (argv.includes('repair')) {
        return actor(cwd, input);
      }
      throw Error(`Unexpected fixture command: ${argv.join(' ')}`);
    },
    verify: async (config: Config): Promise<State> => {
      hooks.verificationEntries++;
      const boundaryHook =
        config.revision &&
        (hooks.beforeCommitVerify || hooks.beforePushVerify) &&
        (await Bun.file(join(config.runDir, 'state.json')).exists());
      if (boundaryHook || hooks.beforeVerify) {
        const head = git(config.cwd, 'rev-parse', 'HEAD');
        if (boundaryHook) {
          if (head === config.revision?.head) {
            await hooks.beforeCommitVerify?.();
          } else {
            await hooks.beforePushVerify?.();
          }
        }
        await hooks.beforeVerify?.(head);
      }
      await mkdir(config.runDir, { recursive: true });
      const state = await verifiedState(config);
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
  if (initialPublication) {
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
  } else {
    git(repo, 'checkout', '-b', pr.headRefName);
    await implementOriginal(repo);
    await writeFile(join(repo, 'result.txt'), 'implemented');
    git(repo, 'add', 'result.txt', 'original-pr.txt', ...(report ? [reportPath] : []));
    git(repo, 'commit', '-m', '前回の公開成果物');
    remoteHead = git(repo, 'rev-parse', 'HEAD');
    pr.headRefOid = remoteHead;
    pr.body = `Closes #99\nPublished ${remoteHead}\nPrior limitation and attachment: https://example.com/media.png`;
    const targetText = await readFile(join(repo, '.dotagents.json'), 'utf8');
    const config: Config = {
      ...correctionConfig(root),
      cwd: repo,
      runDir: join(prior, 'verification'),
      baseCommit: initialBase,
      targetText,
      reports,
    };
    await mkdir(config.runDir, { recursive: true });
    const records = {
      'verification-config.json': config,
      'verification/state.json': await verifiedState(config),
      'target.json': { text: targetText, actor: 'operator', repositoryId: 123 },
      'result.json': {
        publication: 'published',
        phase: 'ci',
        status: 'published_draft',
        reason: 'Published as draft; ready requires assigned AI checks',
        terminal: true,
        finishedAt: '2026-09-20T00:00:00Z',
        checkout: repo,
        repository: 'team/component',
        issue: 'https://github.com/team/component/issues/99',
        url: pr.url,
        commit: remoteHead,
        branch: pr.headRefName,
      },
      'pr.json': pr,
    };
    for (const [path, value] of Object.entries(records)) {
      await writeFile(join(prior, path), JSON.stringify(value));
    }
    await writeFile(join(prior, 'issue.json'), issue);
    await writeFile(join(prior, 'pr-url.txt'), pr.url);
  }
  // 準備の呼出しを修正操作の計数に混ぜない。接続検証でも同じ起点から数える。
  commands.length = 0;
  independentTests.length = 0;
  hooks.implementations = 0;
  hooks.verificationEntries = 0;
  hooks.pushes = 0;
  priorPublished = true;
  pr.isDraft = false;
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
    independentTests,
    publicationCommands,
    implementationPrompts,
  };
}

export async function readObject(path: string) {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(isRecord(value));
  return value;
}

export function revisionInput(root: string): Revision {
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

export function testRevision(
  name: string,
  check: (f: RevisionFixture) => Promise<void>,
  local: false | 'untracked' | 'ignored' = false,
) {
  test(`existing PR revision: ${name}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-')));
    try {
      await check(await fixture(root, false, [], false, local));
    } finally {
      await withInterrupts(async () => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

export function runRevision(f: RevisionFixture): ReturnType<typeof develop>;
export function runRevision(f: RevisionFixture, reason: RegExp): Promise<void>;
export async function runRevision(
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

export function noRevisionPublication(f: RevisionFixture) {
  expect(f.hooks.pushes).toBe(0); // 修正のpushは未実施。
  expect(f.hooks.edits).toBe(0);
}

export async function stoppedRevision(f: RevisionFixture, reason: RegExp) {
  await runRevision(f, reason);
  const result = await readObject(join(f.dir, 'result.json'));
  expect(result.url).toBe(f.pr.url);
  expect(result.status).toBe('stopped');
  expect(result.nextAction).toBeTruthy();
  return result;
}

export type RevisionFixture = Awaited<ReturnType<typeof fixture>>;
