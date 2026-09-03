/** @file Outcome: Build reads one selected GitHub Issue Plan at startup. */

import type { BuildPlanAuthoring } from '../plan/contracts.ts';
import { SCREENSHOT_CAP, safeScreenshotName, type ScreenshotSpec } from './screenshot-contract.ts';
import { FlowError } from '../shared/errors.ts';
import { gitRoot } from '../shared/repository.ts';
import { isObject, objectArray, rejectUnknownKeys, requiredString } from '../shared/schema.ts';
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
  screenshots: ScreenshotSpec[];
  repository?: string;
}

export interface ResolvedBuildSource {
  repository: string;
  issue: number;
  title: string;
  plan: BuildPlanAuthoring;
  screenshots: ScreenshotSpec[];
}

function parseScreenshots(raw: unknown): ScreenshotSpec[] {
  const screenshots = objectArray(raw ?? [], 'build input.screenshots');
  if (screenshots.length > SCREENSHOT_CAP) {
    throw new FlowError(`build input.screenshots may contain at most ${SCREENSHOT_CAP} items`);
  }
  const names = new Set<string>();
  return screenshots.map((item, index) => {
    const label = `build input.screenshots[${index}]`;
    rejectUnknownKeys(item, ['name', 'alt'], label);
    if (!safeScreenshotName(item.name)) {
      throw new FlowError(`${label}.name must be a safe image filename`);
    }
    const normalizedName = item.name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new FlowError(`build input contains duplicate screenshot name ${item.name}`);
    }
    names.add(normalizedName);
    return { name: item.name, alt: requiredString(item.alt, `${label}.alt`) };
  });
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
  const ship = raw.ship === true;
  const screenshots = parseScreenshots(raw.screenshots);
  if (!ship && screenshots.length) {
    throw new FlowError('build input.screenshots require ship to be true');
  }
  return {
    repo,
    issue_number: positiveIssue(raw.issue_number, 'build input.issue_number'),
    ship,
    screenshots,
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
    screenshots: input.screenshots,
  };
}

export function describeBuildRunInput() {
  return { repo: '/absolute/git-root', issue_number: 123, ship: false, screenshots: [] };
}
