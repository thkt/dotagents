/** @file Outcome: Issue inputs and drafts cross preview and publish boundaries as closed contracts. */

import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError } from '../shared/errors.ts';
import { gitRoot } from '../shared/repository.ts';
import { thinkArtifactDirectory } from '../shared/storage.ts';
import { githubRepositoryForRemote } from './github.ts';
import { digest, positiveIssue, repositoryName } from './public-contract.ts';
import { enumValue, isObject, rejectUnknownKeys, requiredString } from '../shared/schema.ts';

export const ISSUE_DRAFT_PROTOCOL = 'codex-issue-draft' as const;
export const ISSUE_RESULT_PROTOCOL = 'codex-issue-result' as const;
export const ISSUE_DESCRIPTION_PROTOCOL = 'codex-issue-description' as const;
const PUBLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface IssueInputBase {
  repo: string;
  repository: string;
  remote: string;
  think_report: string;
}

export type IssueInput = IssueInputBase &
  ({ mode: 'create'; title: string } | { mode: 'attach-plan'; target_issue: number });

interface ExistingIssueSnapshot {
  title: string;
  body_sha256: string;
}

export interface IssueDraft {
  protocol: typeof ISSUE_DRAFT_PROTOCOL;
  generated_at: string;
  repo: string;
  repository: string;
  remote: string;
  issue_number: number | null;
  title: string;
  publication_id: string;
  body_file: string;
  body_sha256: string;
  existing_issue: ExistingIssueSnapshot | null;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value === null ? null : positiveIssue(value, label);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new FlowError(`${label} must be absolute`);
  }
  return path.resolve(value);
}

function remoteName(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[A-Za-z0-9._-]+$/u.test(result)) {
    throw new FlowError(`${label} has invalid characters`);
  }
  return result;
}

/** Validates the human decisions required before a read-only issue draft is built. */
export function validateIssueInput(raw: unknown): IssueInput {
  if (!isObject(raw)) throw new FlowError('issue input must be an object');
  const mode = enumValue(raw.mode, ['create', 'attach-plan'] as const, 'issue input.mode');
  const suppliedRepo = requiredString(raw.repo, 'issue input.repo');
  const repo = gitRoot(suppliedRepo, 'issue input.repo must be a Git worktree');
  const remote = 'origin';
  const common = {
    repo,
    repository: githubRepositoryForRemote(repo, remote),
    remote,
    think_report: path.resolve(
      path.isAbsolute(requiredString(raw.think_report, 'issue input.think_report'))
        ? String(raw.think_report)
        : path.join(thinkArtifactDirectory(repo), String(raw.think_report)),
    ),
  };
  if (mode === 'attach-plan') {
    return {
      ...common,
      mode,
      target_issue: positiveIssue(raw.target_issue, 'issue input.target_issue'),
    };
  }
  const title = requiredString(raw.title, 'issue input.title');
  if (title.includes('\n')) {
    throw new FlowError('issue input.title must be one line');
  }
  return { ...common, mode, title };
}

/** Revalidates the immutable draft immediately before same-invocation publication. */
export function parseIssueDraft(raw: unknown): IssueDraft {
  if (!isObject(raw) || raw.protocol !== ISSUE_DRAFT_PROTOCOL) {
    throw new FlowError(`issue draft.protocol must be ${ISSUE_DRAFT_PROTOCOL}`);
  }
  rejectUnknownKeys(
    raw,
    [
      'protocol',
      'generated_at',
      'repo',
      'repository',
      'remote',
      'issue_number',
      'title',
      'publication_id',
      'body_file',
      'body_sha256',
      'existing_issue',
    ],
    'issue draft',
  );
  const generatedAt = requiredString(raw.generated_at, 'issue draft.generated_at');
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime) || new Date(generatedTime).toISOString() !== generatedAt) {
    throw new FlowError('issue draft.generated_at must be an ISO timestamp');
  }
  const repoPath = absolutePath(raw.repo, 'issue draft.repo');
  const repo = gitRoot(repoPath, 'issue draft.repo must be a Git worktree');
  if (fs.realpathSync(repoPath) !== repo) {
    throw new FlowError('issue draft.repo must equal the Git root');
  }
  const issueNumber = nullablePositiveInteger(raw.issue_number, 'issue draft.issue_number');
  let existingIssue: ExistingIssueSnapshot | null = null;
  if (raw.existing_issue !== null) {
    if (!isObject(raw.existing_issue)) {
      throw new FlowError('issue draft.existing_issue must be an object or null');
    }
    rejectUnknownKeys(raw.existing_issue, ['title', 'body_sha256'], 'issue draft.existing_issue');
    existingIssue = {
      title: requiredString(raw.existing_issue.title, 'issue draft.existing_issue.title'),
      body_sha256: digest(raw.existing_issue.body_sha256, 'issue draft.existing_issue.body_sha256'),
    };
  }
  if ((issueNumber !== null) !== (existingIssue !== null)) {
    throw new FlowError('issue draft target and existing_issue are inconsistent');
  }
  return {
    protocol: ISSUE_DRAFT_PROTOCOL,
    generated_at: generatedAt,
    repo,
    repository: repositoryName(raw.repository, 'issue draft.repository'),
    remote: remoteName(raw.remote, 'issue draft.remote'),
    issue_number: issueNumber,
    title: requiredString(raw.title, 'issue draft.title'),
    publication_id: (() => {
      const value = requiredString(raw.publication_id, 'issue draft.publication_id');
      if (!PUBLICATION_ID.test(value)) {
        throw new FlowError('issue draft.publication_id must be a UUIDv4');
      }
      return value;
    })(),
    body_file: absolutePath(raw.body_file, 'issue draft.body_file'),
    body_sha256: digest(raw.body_sha256, 'issue draft.body_sha256'),
    existing_issue: existingIssue,
  };
}
