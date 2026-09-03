/** @file Outcome: Build reads one selected GitHub Issue Plan at startup. */

import type { BuildPlanAuthoring } from '../plan/contracts.ts';
import { FlowError } from '../shared/errors.ts';
import { gitRoot } from '../shared/repository.ts';
import { isObject, requiredString } from '../shared/schema.ts';
import {
  assertGitHubRepository,
  GhIssueGateway,
  githubRepositoryForRemote,
  type IssueGateway,
} from '../issue/github.ts';
import { parsePublicIssueBody, positiveIssue, repositoryName } from '../issue/public-contract.ts';

export interface BuildRunInput {
  repo: string;
  issue_number: number;
  ship: boolean;
  repository?: string;
}

export interface ResolvedBuildSource {
  repository: string;
  issue: number;
  title: string;
  plan: BuildPlanAuthoring;
}

export function parseBuildRunInput(raw: unknown): BuildRunInput {
  if (!isObject(raw)) throw new FlowError('build input must be an object');
  const repo = gitRoot(
    requiredString(raw.repo, 'build input.repo'),
    'build input.repo must be a Git worktree',
  );
  if (raw.ship !== undefined && typeof raw.ship !== 'boolean') {
    throw new FlowError('build input.ship must be boolean');
  }
  return {
    repo,
    issue_number: positiveIssue(raw.issue_number, 'build input.issue_number'),
    ship: raw.ship === true,
    ...(raw.repository === undefined
      ? {}
      : { repository: repositoryName(raw.repository, 'build input.repository') }),
  };
}

export function resolveBuildSource(
  raw: unknown,
  repo: string,
  gateway: Pick<IssueGateway, 'view'> = new GhIssueGateway(),
): ResolvedBuildSource {
  const input = parseBuildRunInput(raw);
  if (input.repo !== repo) throw new FlowError('build input belongs to a different Git worktree');
  const repository = input.repository ?? githubRepositoryForRemote(repo, 'origin');
  assertGitHubRepository(repo, repository);
  const issue = gateway.view(repository, input.issue_number);
  if (issue.number !== input.issue_number) {
    throw new FlowError('GitHub returned a different Issue than the selected build source');
  }
  return {
    repository,
    issue: issue.number,
    title: issue.title,
    plan: parsePublicIssueBody(issue.body).plan.value,
  };
}

export function describeBuildRunInput() {
  return { repo: '/absolute/git-root', issue_number: 123, ship: false };
}
