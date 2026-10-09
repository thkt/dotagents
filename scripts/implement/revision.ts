import assert from 'node:assert/strict';
import { z } from 'zod';
import { readFile, realpath, access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { assertPreviousConfig, assertState } from './input.ts';
import type { Revision } from './input.ts';
import { isRecord } from '../shared/values.ts';
import { issueText } from './issue.ts';
import { readTarget } from '../shared/target.ts';
import { assertRunning, interruptionMessage } from '../shared/process.ts';
import type { Reader } from '../shared/target.ts';
import { graphQlPrPublication, matchPrPublication, referencesIssue } from './pr-identity.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function previousRun(
  directory: string,
  cwd: string,
  issue: string,
  target: Awaited<ReturnType<typeof readTarget>>,
) {
  const dir = await realpath(directory);
  const result = await json(join(dir, 'result.json'));
  const config = await json(join(dir, 'verification-config.json'));
  const state = await json(join(dir, 'verification/state.json'));
  const savedTarget = await json(join(dir, 'target.json'));
  assertPreviousConfig(config);
  assertState(state);
  assert(isRecord(result) && isRecord(savedTarget), 'Missing previous development records');
  assert(
    result.publication === 'published' &&
      result.phase === 'ci' &&
      ['stopped', 'published_draft', 'ready_for_human_review'].includes(String(result.status)),
    'Previous publication is incomplete or unconfirmed; reconcile GitHub and retained evidence',
  );
  assert(
    state.active === null &&
      state.result === 'ready_for_human_review' &&
      state.reviewHistory.at(-1)?.status === 'accepted',
    'Previous verification is unfinished',
  );
  assert(!(await hasExecutionLock(dir)), 'Previous execution is active; reconcile its process');
  assert(
    state.configHash === hash(JSON.stringify(config)) && config.baseCommit === state.baseCommit,
    'Previous verification configuration is inconsistent',
  );
  assert(
    typeof result.checkout === 'string' &&
      (await realpath(result.checkout)) === cwd &&
      (await realpath(config.cwd)) === cwd &&
      (await realpath(config.runDir)) === join(dir, 'verification'),
    'Previous checkout or verification directory differs',
  );
  assert(
    result.repository === target.config.repository &&
      result.issue === `https://github.com/${target.config.repository}/issues/${issue}` &&
      savedTarget.text === target.text &&
      savedTarget.actor === target.actor &&
      savedTarget.repositoryId === target.repositoryId,
    'Previous repository, Issue, configuration or actor differs',
  );
  assert(
    typeof result.url === 'string' &&
      typeof result.commit === 'string' &&
      typeof result.branch === 'string',
    'Previous publication identity missing',
  );
  assert(
    (await readFile(join(dir, 'pr-url.txt'), 'utf8')).trim() === result.url,
    'Previous PR URL differs',
  );
  const publication = await json(join(dir, 'pr.json'));
  assert(
    isRecord(publication) &&
      publication.url === result.url &&
      publication.headRefOid === result.commit &&
      publication.baseRefName === target.config.baseBranch &&
      publication.state === 'OPEN' &&
      typeof publication.body === 'string',
    'Previous published target is inconsistent; reconcile GitHub',
  );
  const original = await readFile(join(dir, 'issue.json'), 'utf8');
  assert(original === issueText(original), 'Previous Issue evidence differs');
  assert(state.issueHash === hash(original), 'Previous Issue evidence differs');
  return {
    dir,
    result,
    config,
    state,
    url: result.url,
    head: result.commit,
    branch: result.branch,
    body: publication.body,
  };
}

export async function checkRevision(
  revision: Revision,
  cwd: string,
  read: Reader,
  {
    head = revision.head,
    body = revision.body,
    captureBody = false,
    draft,
    issue,
    target,
  }: {
    head?: string;
    body?: string;
    captureBody?: boolean;
    draft?: 'ensure' | 'require';
    issue?: string; // Comparison text already converted by the acquiring caller.
    target?: Awaited<ReturnType<typeof readTarget>>;
  } = {},
) {
  await reconcileExecutions(revision, cwd);
  assert(
    (await readFile(revision.requestFile, 'utf8')) === revision.request,
    'Revision request changed; preserve work and obtain a new explicit request',
  );
  assert(
    (issue ??
      issueText(
        await read(
          [
            'gh',
            'issue',
            'view',
            revision.issue,
            '--repo',
            revision.repository,
            '--json',
            'title,body,state,updatedAt',
          ],
          cwd,
        ),
      )) === revision.issueText,
    'Agreed Issue changed during revision',
  );
  target ??= await readTarget(cwd, read, !revision.localOnly);
  assert(
    target.text === revision.targetText &&
      target.actor === revision.actor &&
      target.repositoryId === revision.repositoryId,
    'Revision target or actor changed',
  );
  assert(
    (await read(['git', 'branch', '--show-current'], cwd)) === revision.branch,
    'Revision branch changed',
  );
  const pr: unknown = JSON.parse(
    await read(
      [
        'gh',
        'pr',
        'view',
        revision.url,
        '--repo',
        revision.repository,
        '--json',
        'url,state,isDraft,body,author,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,closingIssuesReferences',
      ],
      cwd,
    ),
  );
  assert(
    isRecord(pr) &&
      isRecord(pr.author) &&
      isRecord(pr.headRepository) &&
      isRecord(pr.headRepositoryOwner),
    'Invalid revision PR response',
  );
  const match = matchPrPublication(graphQlPrPublication(pr), {
    url: revision.url,
    actor: revision.actor,
    branch: revision.branch,
    repository: revision.repository,
    commit: head,
    base: revision.baseBranch,
    body,
  });
  assert(
    match.target && match.author && pr.isCrossRepository === false,
    'Revision PR identity changed; reconcile repository, author, head and base',
  );
  assert(
    typeof pr.body === 'string' && (captureBody || match.body),
    'Revision PR body changed; preserve unreviewed edits',
  );
  // Non-default bases have no automatic closing links; the harness publishes an
  // explicit Issue reference in the body. Any links returned must still agree.
  assert(
    referencesIssue(pr.body, revision.issue) &&
      Array.isArray(pr.closingIssuesReferences) &&
      pr.closingIssuesReferences.length <= 1 &&
      pr.closingIssuesReferences.every(
        (issue) =>
          isRecord(issue) &&
          issue.url === `https://github.com/${revision.repository}/issues/${revision.issue}`,
      ),
    'Revision PR Issue changed',
  );
  const ref = await read(
    ['gh', 'api', `repos/${revision.repository}/git/ref/heads/${revision.branch}`],
    cwd,
  );
  const value: unknown = JSON.parse(ref);
  assert(
    isRecord(value) && isRecord(value.object) && value.object.sha === head,
    'Revision remote ref differs from PR head',
  );
  if (draft) {
    assert(typeof pr.isDraft === 'boolean', 'Revision PR draft state unavailable');
    if (draft === 'ensure' && !match.draft) {
      assertRunning();
      await read(['gh', 'pr', 'ready', revision.url, '--repo', revision.repository, '--undo'], cwd);
      assertRunning();
      // The mutation invalidates the earlier target, actor, Issue and body observations.
      return checkRevision(revision, cwd, read, { head, body, draft: 'require' });
    }
    assert(match.draft, 'Revision PR is not draft; reconcile before further publication');
  }
  return pr.body;
}

export function revisionContext(revision?: Revision) {
  return revision
    ? [
        `人が採用した修正要求（固定入力）:\n${revision.request}`,
        '採用された指摘ごとに、原因が再発し得るか、合意範囲内で必要な更新が現在の成果物へ反映されているかを確認してください。対象は再利用する手順、重要な判断記録、追加の検出価値があるテストやlintです。すべてのコメントを規則にしたり、範囲外の改善を完了条件にしたりしないでください。',
        `修正は公開済みcommit ${revision.head}から始まります。PR全体を合意済みIssueに照らして評価すると同時に、今回の修正を採用済み要求に照らして評価してください。以前の受入や指摘IDを再利用しないでください。`,
        'acceptedとなった評価のassessmentsとhandoffが、新しい公開PR本文になります。以前の本文を現在の成果物と比較し、今も適用される変更説明、未解決の限界、公開済み添付リンクを、これらの項目に明示的に残してください。古くなった成功の主張や過去の生成済みの節をコピーしないでください。必要な文脈が欠けていればneeds_changesです。documents[]の出典リンクだけでは、アップロード済み添付を保持できません。',
        `以前のPR本文（説明更新の参照用）:\n${revision.body}`,
      ].join('\n')
    : '';
}

// Existing result.json is the execution entry point; no separate retry ledger.
export async function reconcileExecutions(
  revision: Pick<Revision, 'previousRun' | 'runDirectory'>,
  cwd: string,
) {
  const parent = dirname(revision.previousRun);
  assert(
    dirname(revision.runDirectory) === parent,
    'Revision evidence must be a sibling of previous run so unfinished executions can be reconciled',
  );
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const dir = join(parent, entry.name);
    if (!entry.isDirectory() || dir === revision.runDirectory) {
      continue;
    }
    const record = await optionalFile(join(dir, 'result.json'));
    if (record === undefined) {
      continue;
    }
    const result: unknown = JSON.parse(record);
    if (!isRecord(result) || result.checkout !== cwd) {
      continue;
    }
    await inactiveVerification(dir, result);
    assert(
      result.reason && result.publication !== 'unconfirmed',
      `Unfinished or uncertain execution requires reconciliation: ${dir}; preserve records and check its process and GitHub state`,
    );
  }
}

async function optionalFile(path: string) {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
}

const interruptionTimes = z.object({ startedAt: z.iso.datetime(), finishedAt: z.iso.datetime() });

function terminalInterruption(dir: string, result: Record<string, unknown>) {
  const times = interruptionTimes.safeParse(result);
  if (!times.success) {
    return false;
  }
  const started = Date.parse(times.data.startedAt);
  const finished = Date.parse(times.data.finishedAt);
  return (
    result.terminal === true &&
    result.status === 'stopped' &&
    result.phase === 'verification' &&
    result.reason === interruptionMessage &&
    result.publication === 'not_attempted' &&
    result.evidence === dir &&
    result.details === join(dir, 'verification/state.json') &&
    Number.isFinite(started) &&
    Number.isFinite(finished) &&
    finished >= started
  );
}

async function inactiveVerification(dir: string, result: Record<string, unknown>) {
  const state = await optionalFile(join(dir, 'verification/state.json'));
  assert(
    state !== undefined || result.phase !== 'verification' || result.reason !== interruptionMessage,
    `Missing interrupted verification state requires reconciliation: ${dir}`,
  );
  if (state !== undefined) {
    const value: unknown = JSON.parse(state);
    assertState(value);
    assert(
      value.active === null && (value.result || terminalInterruption(dir, result)),
      `Unfinished verification requires reconciliation: ${dir}`,
    );
  }
  assert(!(await hasExecutionLock(dir)), `Active verification requires reconciliation: ${dir}`);
}

async function hasExecutionLock(dir: string) {
  return access(join(dir, 'verification/lock')).then(
    () => true,
    (error: unknown) => {
      assert(isRecord(error) && error.code === 'ENOENT', `Cannot inspect execution lock: ${dir}`);
      return false;
    },
  );
}
