/** @file Outcome: GitHub issue reads and writes use literal CLI arguments and return one verified record shape. */

import { FlowError } from '../shared/errors.ts';
import {
  GITHUB_RESPONSE_ERROR,
  githubIssueCreate,
  githubIssueEdit,
  githubIssuePublicationSearch,
  githubIssueView,
  githubLabelCreate,
  githubLabelList,
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
  labels: string[];
}

export interface IssueGateway {
  checkAccess(repository: string): void;
  view(repository: string, issue: number): GitHubIssue;
  findByPublicationId(repository: string, publicationId: string): GitHubIssue | null;
  ensureLabel(repository: string, label: string): void;
  create(repository: string, title: string, bodyFile: string, label: string): GitHubIssue;
  edit(repository: string, issue: number, bodyFile: string, label: string): GitHubIssue;
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
    !raw.url.startsWith('https://github.com/') ||
    !Array.isArray(raw.labels)
  ) {
    throw new FlowError('GitHub returned an invalid issue record', GITHUB_RESPONSE_ERROR);
  }
  const labels = raw.labels.map((label) => {
    if (!isObject(label) || typeof label.name !== 'string' || !label.name) {
      throw new FlowError('GitHub returned an invalid issue label', GITHUB_RESPONSE_ERROR);
    }
    return label.name;
  });
  return {
    number: Number(raw.number),
    title: raw.title,
    body: raw.body,
    url: raw.url,
    labels,
  };
}

function parseLabelNames(raw: unknown): string[] {
  if (!Array.isArray(raw))
    throw new FlowError('GitHub returned invalid labels', GITHUB_RESPONSE_ERROR);
  return raw.map((item) => {
    if (!isObject(item) || typeof item.name !== 'string')
      throw new FlowError('GitHub returned invalid labels', GITHUB_RESPONSE_ERROR);
    return item.name;
  });
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

const PRIORITY_LABELS: Record<string, { color: string; description: string }> = {
  'priority:critical': { color: 'b60205', description: 'Work that requires immediate attention.' },
  'priority:high': { color: 'd93f0b', description: 'Work that should be addressed soon.' },
  'priority:medium': { color: 'fbca04', description: 'Work with normal delivery priority.' },
  'priority:low': {
    color: '0e8a16',
    description: 'Work that can be addressed when capacity allows.',
  },
};

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

  ensureLabel(repository: string, label: string): void {
    const output = runGitHub(githubLabelList(repository, label));
    const labels = parseGitHubJson(output, 'GitHub label output');
    if (parseLabelNames(labels).includes(label)) return;
    const priority = PRIORITY_LABELS[label];
    if (!priority) throw new FlowError(`Unsupported issue label: ${label}`, 'decision_error');
    runGitHub(
      githubLabelCreate(repository, label, priority.color, priority.description),
      this.writeAuthority,
    );
  }

  create(repository: string, title: string, bodyFile: string, label: string): GitHubIssue {
    const url = runGitHub(
      githubIssueCreate(repository, title, bodyFile, label),
      this.writeAuthority,
    );
    return view(repository, issueNumber(url));
  }

  edit(repository: string, issue: number, bodyFile: string, label: string): GitHubIssue {
    runGitHub(githubIssueEdit(repository, issue, bodyFile, label), this.writeAuthority);
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
