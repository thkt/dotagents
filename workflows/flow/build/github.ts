/** @file Outcome: Build observes one typed draft pull request and distinguishes absence from unsafe uncertainty. */

import { FlowError, errorCode } from '../../shared/errors.ts';
import {
  GITHUB_COMMAND_ERROR,
  GITHUB_RESPONSE_ERROR,
  githubPrView,
  parseGitHubJson,
  runGitHub,
} from '../../shared/github.ts';
import { isObject } from '../../shared/schema.ts';

interface GitHubPullRequest {
  url: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  title: string;
  body: string;
}

interface DraftPullRequestExpectation {
  repository: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

type DraftPullRequestInspection =
  | { status: 'matched'; pullRequest: GitHubPullRequest }
  | { status: 'absent'; error: string }
  | { status: 'mismatch'; pullRequest: GitHubPullRequest; error: string };

function parsePullRequest(raw: unknown, repository: string): GitHubPullRequest {
  const urlRepository =
    isObject(raw) && typeof raw.url === 'string'
      ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/u.exec(raw.url)?.[1]
      : null;
  if (
    !isObject(raw) ||
    typeof raw.url !== 'string' ||
    urlRepository !== repository ||
    typeof raw.isDraft !== 'boolean' ||
    typeof raw.baseRefName !== 'string' ||
    typeof raw.headRefName !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.body !== 'string'
  ) {
    throw new FlowError('GitHub returned an invalid pull request record', GITHUB_RESPONSE_ERROR);
  }
  return {
    url: raw.url,
    isDraft: raw.isDraft,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    title: raw.title,
    body: raw.body,
  };
}

function pullRequest(raw: string, repository: string): GitHubPullRequest {
  return parsePullRequest(parseGitHubJson(raw, 'GitHub pull request output'), repository);
}

function mismatchFields(
  pullRequest: GitHubPullRequest,
  expected: DraftPullRequestExpectation,
): string[] {
  return [
    ...(pullRequest.isDraft ? [] : ['isDraft']),
    ...(pullRequest.baseRefName === expected.baseBranch ? [] : ['baseRefName']),
    ...(pullRequest.headRefName === expected.branch ? [] : ['headRefName']),
    ...(pullRequest.title === expected.title ? [] : ['title']),
    ...(pullRequest.body === expected.body ? [] : ['body']),
  ];
}

/** Reads a draft PR once; only an explicit not-found result is safe to treat as absent. */
export function inspectDraftPullRequest(
  expected: DraftPullRequestExpectation,
): DraftPullRequestInspection {
  let output: string;
  try {
    output = runGitHub(githubPrView(expected.repository, expected.branch));
  } catch (error) {
    if (
      errorCode(error) === GITHUB_COMMAND_ERROR &&
      error instanceof Error &&
      /(?:no pull requests found|could not resolve to a pull request)/iu.test(error.message)
    ) {
      return { status: 'absent', error: error.message };
    }
    throw error;
  }
  const value = pullRequest(output, expected.repository);
  const mismatches = mismatchFields(value, expected);
  return mismatches.length
    ? {
        status: 'mismatch',
        pullRequest: value,
        error: `GitHub draft pull request mismatched fields: ${mismatches.join(', ')}`,
      }
    : { status: 'matched', pullRequest: value };
}
