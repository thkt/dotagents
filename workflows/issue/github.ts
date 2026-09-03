/** @file Outcome: GitHub issue reads and writes use literal CLI arguments and return one verified record shape. */

import { FlowError } from '../shared/errors.ts';
import {
  GITHUB_RESPONSE_ERROR,
  githubIssueCreate,
  githubIssueEdit,
  githubIssuePublicationSearch,
  githubIssueView,
  githubRepoView,
  parseGitHubJson,
  runGitHub,
  type GitHubWriteAuthority,
} from '../shared/github.ts';
import { gitText } from '../shared/repository.ts';
import { isObject } from '../shared/schema.ts';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface IssueGateway {
  checkAccess(repository: string): void;
  view(repository: string, issue: number): GitHubIssue;
  findByPublicationId(repository: string, publicationId: string): GitHubIssue | null;
  create(repository: string, title: string, bodyFile: string): GitHubIssue;
  edit(repository: string, issue: number, bodyFile: string): GitHubIssue;
}

function parseIssue(raw: unknown): GitHubIssue {
  if (
    !isObject(raw) ||
    !Number.isInteger(raw.number) ||
    Number(raw.number) < 1 ||
    typeof raw.title !== 'string' ||
    !raw.title.trim() ||
    typeof raw.body !== 'string' ||
    typeof raw.url !== 'string' ||
    !raw.url.startsWith('https://github.com/')
  ) {
    throw new FlowError('GitHub returned an invalid issue record', GITHUB_RESPONSE_ERROR);
  }
  return {
    number: Number(raw.number),
    title: raw.title,
    body: raw.body,
    url: raw.url,
  };
}

function parseIssueList(raw: unknown): GitHubIssue[] {
  if (!Array.isArray(raw)) {
    throw new FlowError('GitHub returned an invalid issue list', GITHUB_RESPONSE_ERROR);
  }
  return raw.map(parseIssue);
}

function issueNumber(url: string): number {
  const match = /\/issues\/(\d+)\/?$/u.exec(url);
  if (!match) throw new FlowError('GitHub did not return an issue URL', GITHUB_RESPONSE_ERROR);
  return Number(match[1]);
}

function view(repository: string, issue: number): GitHubIssue {
  const output = runGitHub(githubIssueView(repository, issue));
  return parseIssue(parseGitHubJson(output, 'GitHub issue output'));
}

/** Uses the signed-in GitHub CLI while keeping all authored content outside the shell command. */
export class GhIssueGateway implements IssueGateway {
  private readonly writeAuthority: GitHubWriteAuthority | null;

  constructor(writeAuthority: GitHubWriteAuthority | null = null) {
    this.writeAuthority = writeAuthority;
  }

  checkAccess(repository: string): void {
    const output = runGitHub(githubRepoView(repository));
    const value = parseGitHubJson(output, 'GitHub repository output');
    if (!isObject(value) || value.nameWithOwner !== repository) {
      throw new FlowError('GitHub returned a different repository', GITHUB_RESPONSE_ERROR);
    }
  }

  view(repository: string, issue: number): GitHubIssue {
    return view(repository, issue);
  }

  findByPublicationId(repository: string, publicationId: string): GitHubIssue | null {
    const output = runGitHub(githubIssuePublicationSearch(repository, publicationId));
    const matches = parseIssueList(parseGitHubJson(output, 'GitHub issue list output')).filter(
      (issue) => issue.body.includes(`publication_id:${publicationId}`),
    );
    if (matches.length > 1) {
      throw new FlowError('GitHub returned duplicate issue publications', GITHUB_RESPONSE_ERROR);
    }
    return matches[0] ?? null;
  }

  create(repository: string, title: string, bodyFile: string): GitHubIssue {
    const url = runGitHub(githubIssueCreate(repository, title, bodyFile), this.writeAuthority);
    return view(repository, issueNumber(url));
  }

  edit(repository: string, issue: number, bodyFile: string): GitHubIssue {
    runGitHub(githubIssueEdit(repository, issue, bodyFile), this.writeAuthority);
    return view(repository, issue);
  }
}

function githubRepositoryFromUrl(url: string): string | null {
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/u.exec(
      url,
    );
  return match?.[1] ?? null;
}

/** Resolves one configured GitHub remote to its portable owner/name identifier. */
export function githubRepositoryForRemote(repo: string, remote: string = 'origin'): string {
  const url = gitText(repo, ['remote', 'get-url', '--push', remote], `Git remote ${remote}`);
  const repository = githubRepositoryFromUrl(url);
  if (!repository) {
    throw new FlowError(`Git remote ${remote} is not a github.com repository`, 'state_error');
  }
  return repository;
}

/** Proves that the selected owner/name is one configured remote of the current worktree. */
export function assertGitHubRemote(repo: string, remote: string, repository: string): void {
  if (githubRepositoryForRemote(repo, remote) !== repository) {
    throw new FlowError(`Git remote ${remote} does not resolve to ${repository}`, 'state_error');
  }
}

/** Proves that the selected public repository is reachable through one configured remote. */
export function assertGitHubRepository(repo: string, repository: string): void {
  const remotes = gitText(repo, ['remote'], 'Git remotes').split(/\r?\n/u).filter(Boolean);
  for (const remote of remotes) {
    try {
      assertGitHubRemote(repo, remote, repository);
      return;
    } catch {
      // Continue until every configured remote has been checked.
    }
  }
  throw new FlowError(`Git worktree has no remote for ${repository}`, 'state_error');
}
