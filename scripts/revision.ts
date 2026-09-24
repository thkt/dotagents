import assert from 'node:assert/strict';
import { readFile, realpath, access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { assertConfig, assertState } from './input.ts';
import type { Revision } from './input.ts';
import { isRecord } from './values.ts';
import { issueText } from './issue.ts';
import { readTarget } from './target.ts';
import { assertRunning } from './process.ts';
import type { Reader } from './target.ts';
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
  assertConfig(config);
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
  // Only legacy runs hashed raw stdout while development saved trimmed JSON.
  assert(original === issueText(original), 'Previous Issue evidence differs');
  assert(
    state.issueHash === hash(original) ||
      (state.issueFormat === undefined && state.issueHash === hash(original + '\n')),
    'Previous Issue evidence differs',
  );
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
        `Human-adopted revision request (fixed input):\n${revision.request}`,
        `Revision starts at published commit ${revision.head}. Assess both the entire PR against the agreed Issue and this revision against the adopted request; do not reuse previous acceptance or finding IDs.`,
        'The accepted review assessments and handoff become the new public PR body. Compare the previous body with current artifacts and explicitly retain all still-applicable change explanations, unresolved limitations and public attachment links in those fields. Do not copy obsolete success claims or historical generated sections. Missing necessary context is needs_changes; documents[] source links alone do not preserve uploaded attachments.',
        `Previous PR body (reference for the updated description):\n${revision.body}`,
      ].join('\n')
    : '';
}

// Existing result.json is the execution entry point; no separate retry ledger.
async function reconcileExecutions(revision: Revision, cwd: string) {
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
    await inactiveVerification(dir);
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

async function inactiveVerification(dir: string) {
  const state = await optionalFile(join(dir, 'verification/state.json'));
  if (state) {
    const value: unknown = JSON.parse(state);
    assert(
      isRecord(value) && value.active === null && value.result,
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
