/** @file Outcome: GitHub issue reads and writes use literal CLI arguments and return one verified record shape. */

import { spawnSync } from 'node:child_process';

import { FlowError } from '../shared/errors.ts';
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
  view(repository: string, issue: number): GitHubIssue;
  ensureLabel(repository: string, label: string): void;
  create(repository: string, title: string, bodyFile: string, label: string): GitHubIssue;
  edit(repository: string, issue: number, bodyFile: string, label: string): GitHubIssue;
}

function command(args: string[], label: string): string {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new FlowError(`${label} failed${detail ? `: ${detail}` : ''}`, 'external_error');
  }
  return result.stdout.trim();
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
    throw new FlowError('GitHub returned an invalid issue record', 'external_error');
  }
  const labels = raw.labels.map((label) => {
    if (!isObject(label) || typeof label.name !== 'string' || !label.name) {
      throw new FlowError('GitHub returned an invalid issue label', 'external_error');
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
  if (!Array.isArray(raw)) throw new FlowError('GitHub returned invalid labels', 'external_error');
  return raw.map((item) => {
    if (!isObject(item) || typeof item.name !== 'string')
      throw new FlowError('GitHub returned invalid labels', 'external_error');
    return item.name;
  });
}

function issueNumber(url: string): number {
  const match = /\/issues\/(\d+)\/?$/u.exec(url);
  if (!match) throw new FlowError('GitHub did not return an issue URL', 'external_error');
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
  const output = command(
    [
      'issue',
      'view',
      String(issue),
      '--repo',
      repository,
      '--json',
      'number,title,body,url,labels',
    ],
    'gh issue view',
  );
  try {
    return parseIssue(JSON.parse(output) as unknown);
  } catch (error) {
    if (error instanceof FlowError) throw error;
    throw new FlowError('GitHub issue output is not valid JSON', 'external_error');
  }
}

/** Uses the signed-in GitHub CLI while keeping all authored content outside the shell command. */
export class GhIssueGateway implements IssueGateway {
  view(repository: string, issue: number): GitHubIssue {
    return view(repository, issue);
  }

  ensureLabel(repository: string, label: string): void {
    const output = command(
      [
        'label',
        'list',
        '--repo',
        repository,
        '--search',
        label,
        '--limit',
        '100',
        '--json',
        'name',
      ],
      'gh label list',
    );
    let labels: unknown;
    try {
      labels = JSON.parse(output) as unknown;
    } catch {
      throw new FlowError('GitHub label output is not valid JSON', 'external_error');
    }
    if (parseLabelNames(labels).includes(label)) return;
    const priority = PRIORITY_LABELS[label];
    if (!priority) throw new FlowError(`Unsupported issue label: ${label}`, 'decision_error');
    command(
      [
        'label',
        'create',
        label,
        '--repo',
        repository,
        '--color',
        priority.color,
        '--description',
        priority.description,
      ],
      'gh label create',
    );
  }

  create(repository: string, title: string, bodyFile: string, label: string): GitHubIssue {
    const url = command(
      [
        'issue',
        'create',
        '--repo',
        repository,
        '--title',
        title,
        '--body-file',
        bodyFile,
        '--label',
        label,
      ],
      'gh issue create',
    );
    return view(repository, issueNumber(url));
  }

  edit(repository: string, issue: number, bodyFile: string, label: string): GitHubIssue {
    command(
      [
        'issue',
        'edit',
        String(issue),
        '--repo',
        repository,
        '--body-file',
        bodyFile,
        '--add-label',
        label,
      ],
      'gh issue edit',
    );
    return view(repository, issue);
  }
}

/** Proves that the selected owner/name is one configured remote of the current worktree. */
export function assertGitHubRemote(repo: string, remote: string, repository: string): void {
  const url = gitText(repo, ['remote', 'get-url', '--push', remote], `Git remote ${remote}`);
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/u.exec(
      url,
    );
  if (match?.[1] !== repository) {
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
