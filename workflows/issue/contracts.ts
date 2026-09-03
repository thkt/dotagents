/** @file Outcome: Issue inputs carry only the decisions needed to draft and publish. */

import path from 'node:path';

import { FlowError } from '../shared/errors.ts';
import { gitRoot } from '../shared/repository.ts';
import { thinkArtifactDirectory } from '../shared/storage.ts';
import { githubRepositoryForRemote } from './github.ts';
import { positiveIssue } from './public-contract.ts';
import { enumValue, isObject, requiredString } from '../shared/schema.ts';

export const ISSUE_RESULT_PROTOCOL = 'codex-issue-result' as const;
export const ISSUE_DESCRIPTION_PROTOCOL = 'codex-issue-description' as const;

interface IssueInputBase {
  repo: string;
  repository: string;
  remote: string;
  think_report: string;
  title: string;
  prose: string;
}

export type IssueInput = IssueInputBase &
  ({ mode: 'create' } | { mode: 'update'; target_issue: number });

interface ExistingIssueSnapshot {
  title: string;
  body_sha256: string;
}

export interface IssueDraft {
  repository: string;
  issue_number: number | null;
  title: string;
  existing_issue: ExistingIssueSnapshot | null;
}

/** Validates the human decisions required before a read-only issue draft is built. */
export function validateIssueInput(raw: unknown): IssueInput {
  if (!isObject(raw)) throw new FlowError('issue input must be an object');
  const mode = enumValue(raw.mode, ['create', 'update'] as const, 'issue input.mode');
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
  const title = requiredString(raw.title, 'issue input.title');
  if (title.includes('\n')) {
    throw new FlowError('issue input.title must be one line');
  }
  const prose = requiredString(raw.prose, 'issue input.prose');
  if (/^##[ \t]+Plan[ \t]*$/imu.test(prose)) {
    throw new FlowError('issue input.prose must not contain the reserved Plan section');
  }
  if (mode === 'update') {
    return {
      ...common,
      mode,
      target_issue: positiveIssue(raw.target_issue, 'issue input.target_issue'),
      title,
      prose,
    };
  }
  return { ...common, mode, title, prose };
}
