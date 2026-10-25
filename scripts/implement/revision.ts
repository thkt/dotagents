import { verifyLocalPublication } from './local-publication-records.ts';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertPreviousConfig, assertState } from './input.ts';
import type { Revision } from './input.ts';
import { isRecord } from '../shared/values.ts';
import { issueText } from './issue.ts';
import { readTarget } from '../shared/target.ts';
import { assertRunning } from '../shared/process.ts';
import type { Reader } from '../shared/target.ts';
import { graphQlPrPublication, matchPrPublication, referencesIssue } from './pr-identity.ts';
import { verifyReviewReturn } from './review-recovery-records.ts';
import { interruptionReturn } from './host-records.ts';
import { hasExecutionLock, reconcileExecutions } from './execution-history.ts';

export { reconcileExecutions } from './execution-history.ts';

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

async function sourceBranch(revision: Revision) {
  if (!revision.localPublication) {
    return revision.branch;
  }
  const original = await json(join(revision.localPublication.previousRun, 'result.json'));
  assert(
    isRecord(original) && typeof original.branch === 'string' && original.branch.trim(),
    '採用元のbranch記録を照合できません',
  );
  return original.branch;
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
  await verifyLocalPublication(revision.localPublication, cwd, revision.runDirectory, read);
  if (revision.reviewReturn) {
    assert(
      interruptionReturn(revision) &&
        revision.reviewReturn.branch === (await sourceBranch(revision)),
      '修正元の停止照合履歴が一致しません',
    );
    await verifyReviewReturn(
      revision.reviewReturn,
      cwd,
      join(revision.runDirectory, 'verification'),
      undefined,
      undefined,
      undefined,
      true,
    );
  } else {
    await reconcileExecutions(revision, cwd);
  }
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
  await checkAdoptedRemote(revision, target.config.remote, head, cwd, read);
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

async function checkAdoptedRemote(
  revision: Revision,
  remote: string,
  head: string,
  cwd: string,
  read: Reader,
) {
  if (!revision.localPublication) {
    return;
  }
  const refs = await read(
    ['git', 'ls-remote', '--refs', remote, `refs/heads/${revision.branch}`],
    cwd,
  );
  assert(
    refs === `${head}\trefs/heads/${revision.branch}`,
    '採用したremote refとPR headが一致しません',
  );
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
