/** @file Outcome: Issue inputs and drafts cross preview and publish boundaries as closed contracts. */

import * as fs from 'node:fs';
import path from 'node:path';

import { parseBuildPlanAuthoring, type BuildPlanAuthoring } from '../flow/build/authoring.ts';
import { FlowError } from '../shared/errors.ts';
import { gitRoot } from '../shared/repository.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';

export const ISSUE_INPUT_PROTOCOL = 'codex-issue-input' as const;
export const ISSUE_DRAFT_PROTOCOL = 'codex-issue-draft' as const;
export const ISSUE_RESULT_PROTOCOL = 'codex-issue-result' as const;
export const ISSUE_DESCRIPTION_PROTOCOL = 'codex-issue-description' as const;
const PUBLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type IssueMode = 'create' | 'attach-plan';
type IssuePriority = 'critical' | 'high' | 'medium' | 'low';

export interface IssueInput {
  protocol: typeof ISSUE_INPUT_PROTOCOL;
  repo: string;
  repository: string;
  remote: string;
  mode: IssueMode;
  think_report: string;
  title: string | null;
  target_issue: number | null;
  priority: IssuePriority;
}

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
  mode: IssueMode;
  issue_number: number | null;
  title: string;
  priority_label: string;
  publication_id: string;
  body_file: string;
  body_sha256: string;
  think_report: string;
  think_sha256: string;
  plan: BuildPlanAuthoring;
  repository_fingerprint: string;
  existing_issue: ExistingIssueSnapshot | null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FlowError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new FlowError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value === null ? null : positiveInteger(value, label);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new FlowError(`${label} must be ${values.join(', ')}`);
  }
  return value as T;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new FlowError(`${label} must be absolute`);
  }
  return path.resolve(value);
}

function digest(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new FlowError(`${label} must be a SHA-256 digest`);
  return result;
}

function repositoryName(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(result)) {
    throw new FlowError(`${label} must be owner/name`);
  }
  return result;
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
  if (!isObject(raw) || raw.protocol !== ISSUE_INPUT_PROTOCOL) {
    throw new FlowError(`issue input.protocol must be ${ISSUE_INPUT_PROTOCOL}`);
  }
  rejectUnknownKeys(
    raw,
    [
      'protocol',
      'repo',
      'repository',
      'remote',
      'mode',
      'think_report',
      'title',
      'target_issue',
      'priority',
    ],
    'issue input',
  );
  const suppliedRepo = absolutePath(raw.repo, 'issue input.repo');
  const repo = gitRoot(suppliedRepo, 'issue input.repo must be a Git worktree');
  if (fs.realpathSync(suppliedRepo) !== repo) {
    throw new FlowError('issue input.repo must equal the Git root');
  }
  const mode = enumValue(raw.mode, ['create', 'attach-plan'] as const, 'issue input.mode');
  const title = nullableString(raw.title, 'issue input.title');
  const targetIssue = nullablePositiveInteger(raw.target_issue, 'issue input.target_issue');
  if (mode === 'create' && (title === null || targetIssue !== null)) {
    throw new FlowError('create mode requires title and target_issue null');
  }
  if (mode === 'attach-plan' && (title !== null || targetIssue === null)) {
    throw new FlowError('attach-plan mode requires target_issue and title null');
  }
  if (
    title?.includes('\n') ||
    /^\[(?:Bug|Feature|Docs|Chore|バグ|機能|ドキュメント|保守)\]/u.test(title ?? '')
  ) {
    throw new FlowError('issue input.title must be one line without a task-type prefix');
  }
  const remote = remoteName(raw.remote, 'issue input.remote');
  return {
    protocol: ISSUE_INPUT_PROTOCOL,
    repo,
    repository: repositoryName(raw.repository, 'issue input.repository'),
    remote,
    mode,
    think_report: absolutePath(raw.think_report, 'issue input.think_report'),
    title,
    target_issue: targetIssue,
    priority: enumValue(
      raw.priority,
      ['critical', 'high', 'medium', 'low'] as const,
      'issue input.priority',
    ),
  };
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
      'mode',
      'issue_number',
      'title',
      'priority_label',
      'publication_id',
      'body_file',
      'body_sha256',
      'think_report',
      'think_sha256',
      'plan',
      'repository_fingerprint',
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
  const mode = enumValue(raw.mode, ['create', 'attach-plan'] as const, 'issue draft.mode');
  const issueNumber = nullablePositiveInteger(raw.issue_number, 'issue draft.issue_number');
  if ((mode === 'create') !== (issueNumber === null)) {
    throw new FlowError('issue draft mode and issue_number are inconsistent');
  }
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
  if ((mode === 'attach-plan') !== (existingIssue !== null)) {
    throw new FlowError('issue draft mode and existing_issue are inconsistent');
  }
  return {
    protocol: ISSUE_DRAFT_PROTOCOL,
    generated_at: generatedAt,
    repo,
    repository: repositoryName(raw.repository, 'issue draft.repository'),
    remote: remoteName(raw.remote, 'issue draft.remote'),
    mode,
    issue_number: issueNumber,
    title: requiredString(raw.title, 'issue draft.title'),
    priority_label: enumValue(
      raw.priority_label,
      ['priority:critical', 'priority:high', 'priority:medium', 'priority:low'] as const,
      'issue draft.priority_label',
    ),
    publication_id: (() => {
      const value = requiredString(raw.publication_id, 'issue draft.publication_id');
      if (!PUBLICATION_ID.test(value)) {
        throw new FlowError('issue draft.publication_id must be a UUIDv4');
      }
      return value;
    })(),
    body_file: absolutePath(raw.body_file, 'issue draft.body_file'),
    body_sha256: digest(raw.body_sha256, 'issue draft.body_sha256'),
    think_report: absolutePath(raw.think_report, 'issue draft.think_report'),
    think_sha256: digest(raw.think_sha256, 'issue draft.think_sha256'),
    plan: parseBuildPlanAuthoring(raw.plan),
    repository_fingerprint: digest(
      raw.repository_fingerprint,
      'issue draft.repository_fingerprint',
    ),
    existing_issue: existingIssue,
  };
}
