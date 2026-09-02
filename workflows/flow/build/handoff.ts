/** @file Outcome: Build consumes only the exact Plan published in the selected GitHub Issue. */

import type { CompiledBuildPlan } from './authoring.ts';
import { sha256 } from '../../shared/evidence.ts';
import { FlowError } from '../../shared/errors.ts';
import { isObject, rejectUnknownKeys } from '../../shared/schema.ts';
import { assertGitHubRepository, GhIssueGateway, type IssueGateway } from '../../issue/github.ts';
import {
  parsePublicIssueBody,
  positiveIssue,
  repositoryName,
} from '../../issue/public-contract.ts';

export const BUILD_SOURCE_PROTOCOL = 'codex-build-source' as const;

export interface BuildSource {
  protocol: typeof BUILD_SOURCE_PROTOCOL;
  repository: string;
  issue_number: number;
}

export interface ResolvedBuildSource {
  repository: string;
  issue: number;
  title: string;
  body: string;
  body_sha256: string;
  plan: CompiledBuildPlan['value'];
}

/** Validates the portable selector without fetching its selected Issue. */
export function parseBuildSource(raw: unknown): BuildSource {
  if (!isObject(raw) || raw.protocol !== BUILD_SOURCE_PROTOCOL) {
    throw new FlowError(`build source.protocol must be ${BUILD_SOURCE_PROTOCOL}`);
  }
  rejectUnknownKeys(raw, ['protocol', 'repository', 'issue_number'], 'build source');
  return {
    protocol: BUILD_SOURCE_PROTOCOL,
    repository: repositoryName(raw.repository, 'build source.repository'),
    issue_number: positiveIssue(raw.issue_number, 'build source.issue_number'),
  };
}

/** Fetches the authoritative public Issue selected by repository and issue number. */
export function resolveBuildSource(
  raw: unknown,
  repo: string,
  gateway: Pick<IssueGateway, 'view'> = new GhIssueGateway(),
): ResolvedBuildSource {
  const source = parseBuildSource(raw);
  const repository = source.repository;
  const issueNumber = source.issue_number;
  assertGitHubRepository(repo, repository);
  const issue = gateway.view(repository, issueNumber);
  if (
    issue.number !== issueNumber ||
    issue.url !== `https://github.com/${repository}/issues/${issueNumber}`
  ) {
    throw new FlowError('GitHub returned a different Issue than the selected build source');
  }
  const parsed = parsePublicIssueBody(issue.body);
  return {
    repository,
    issue: issueNumber,
    title: issue.title,
    body: issue.body,
    body_sha256: sha256(issue.body),
    plan: parsed.plan.value,
  };
}

export function describeBuildSource() {
  return { protocol: BUILD_SOURCE_PROTOCOL, repository: 'owner/name', issue_number: 123 };
}
