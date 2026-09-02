/** @file Outcome: Every GitHub CLI operation has one closed access policy and literal argv builder. */

import { spawnSync } from 'node:child_process';

import { shellCommand } from './command.ts';
import { FlowError } from './errors.ts';

export const GITHUB_ACCESS_ERROR = 'github_access_error' as const;
export const GITHUB_COMMAND_ERROR = 'github_command_error' as const;
export const GITHUB_RESPONSE_ERROR = 'github_response_error' as const;
export const GITHUB_EXECUTABLE = 'gh' as const;

export type GitHubWriteAuthority = 'issue-publication' | 'build-ship';
export type GitHubOperation =
  | 'repo:view'
  | 'issue:view'
  | 'issue:publication-search'
  | 'label:list'
  | 'label:create'
  | 'issue:create'
  | 'issue:edit'
  | 'pr:create'
  | 'pr:view';

export interface GitHubOperationPolicy {
  readonly access: 'read' | 'write';
  readonly authority: GitHubWriteAuthority | null;
}

export const GITHUB_OPERATION_POLICIES: Readonly<Record<GitHubOperation, GitHubOperationPolicy>> =
  Object.freeze({
    'repo:view': Object.freeze({ access: 'read', authority: null }),
    'issue:view': Object.freeze({ access: 'read', authority: null }),
    'issue:publication-search': Object.freeze({ access: 'read', authority: null }),
    'label:list': Object.freeze({ access: 'read', authority: null }),
    'label:create': Object.freeze({ access: 'write', authority: 'issue-publication' }),
    'issue:create': Object.freeze({ access: 'write', authority: 'issue-publication' }),
    'issue:edit': Object.freeze({ access: 'write', authority: 'issue-publication' }),
    'pr:create': Object.freeze({ access: 'write', authority: 'build-ship' }),
    'pr:view': Object.freeze({ access: 'read', authority: null }),
  });

const REGISTERED_GITHUB_INVOCATION: unique symbol = Symbol('registered GitHub invocation');

export interface GitHubInvocation {
  readonly [REGISTERED_GITHUB_INVOCATION]: true;
  readonly executable: typeof GITHUB_EXECUTABLE;
  readonly operation: GitHubOperation;
  readonly args: readonly string[];
}

export interface GitHubAttachment {
  path: string;
  alt: string;
}

function invocation(operation: GitHubOperation, args: string[]): GitHubInvocation {
  const request = {
    executable: GITHUB_EXECUTABLE,
    operation,
    args: Object.freeze([...args]),
  } as GitHubInvocation;
  Object.defineProperty(request, REGISTERED_GITHUB_INVOCATION, { value: true });
  return Object.freeze(request);
}

export function githubRepoView(repository: string): GitHubInvocation {
  return invocation('repo:view', ['repo', 'view', repository, '--json', 'nameWithOwner']);
}

export function githubIssueView(repository: string, issue: number): GitHubInvocation {
  return invocation('issue:view', [
    'issue',
    'view',
    String(issue),
    '--repo',
    repository,
    '--json',
    'number,title,body,url,labels',
  ]);
}

export function githubIssuePublicationSearch(
  repository: string,
  publicationId: string,
): GitHubInvocation {
  return invocation('issue:publication-search', [
    'issue',
    'list',
    '--repo',
    repository,
    '--state',
    'all',
    '--search',
    `${publicationId} in:body`,
    '--limit',
    '100',
    '--json',
    'number,title,body,url,labels',
  ]);
}

export function githubLabelList(repository: string, label: string): GitHubInvocation {
  return invocation('label:list', [
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
  ]);
}

export function githubLabelCreate(
  repository: string,
  label: string,
  color: string,
  description: string,
): GitHubInvocation {
  return invocation('label:create', [
    'label',
    'create',
    label,
    '--repo',
    repository,
    '--color',
    color,
    '--description',
    description,
  ]);
}

export function githubIssueCreate(
  repository: string,
  title: string,
  bodyFile: string,
  label: string,
): GitHubInvocation {
  return invocation('issue:create', [
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
  ]);
}

export function githubIssueEdit(
  repository: string,
  issue: number,
  bodyFile: string,
  label: string,
): GitHubInvocation {
  return invocation('issue:edit', [
    'issue',
    'edit',
    String(issue),
    '--repo',
    repository,
    '--body-file',
    bodyFile,
    '--add-label',
    label,
  ]);
}

export function githubPrCreate(
  repository: string,
  head: string,
  base: string,
  title: string,
  bodyFile: string,
  attachments: readonly GitHubAttachment[] = [],
): GitHubInvocation {
  return invocation('pr:create', [
    'pr',
    'create',
    '--draft',
    '--repo',
    repository,
    '--head',
    head,
    '--base',
    base,
    '--title',
    title,
    '--body-file',
    bodyFile,
    ...attachments.flatMap((attachment) => ['--attach', `${attachment.path}#${attachment.alt}`]),
  ]);
}

export function githubPrView(repository: string, branch: string): GitHubInvocation {
  return invocation('pr:view', [
    'pr',
    'view',
    branch,
    '--repo',
    repository,
    '--json',
    'url,isDraft,baseRefName,headRefName,title,body',
  ]);
}

export function githubShellCommand(request: GitHubInvocation): string {
  return shellCommand(request.executable, [...request.args]);
}

const GITHUB_ACCESS_FAILURE =
  /(?:error connecting to api\.github\.com|check your internet connection|could not resolve host|temporary failure in name resolution|no such host|network is unreachable|failed to connect|connection (?:refused|timed out)|tls handshake timeout|not logged into any github hosts|authentication failed|bad credentials|requires authentication|token\b[^\n]*\bis invalid|http 40[13]|resource not accessible by integration|keyring|keychain)/iu;

/** Identifies a GitHub failure that may succeed with network/keyring access restored. */
export function isGitHubAccessFailureMessage(message: string): boolean {
  return GITHUB_ACCESS_FAILURE.test(message);
}

/** Parses one successful GitHub CLI JSON response under a stable error code. */
export function parseGitHubJson(output: string, label: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new FlowError(`${label} is not valid JSON`, GITHUB_RESPONSE_ERROR);
  }
}

/** Executes one registered operation only when its write authority matches. */
export function runGitHub(
  request: GitHubInvocation,
  authority: GitHubWriteAuthority | null = null,
): string {
  if (request[REGISTERED_GITHUB_INVOCATION] !== true) {
    throw new FlowError(
      'GitHub invocation must come from the closed registry',
      'authorization_error',
    );
  }
  const policy = GITHUB_OPERATION_POLICIES[request.operation];
  if (policy.authority !== authority) {
    throw new FlowError(
      `${request.operation} requires ${policy.authority ?? 'read-only'} GitHub authority`,
      'authorization_error',
    );
  }
  const result = spawnSync(request.executable, [...request.args], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new FlowError(
      `${request.executable} ${request.operation} failed${detail ? `: ${detail}` : ''}`,
      isGitHubAccessFailureMessage(detail) ? GITHUB_ACCESS_ERROR : GITHUB_COMMAND_ERROR,
    );
  }
  return result.stdout.trim();
}

/** Removes GitHub credentials from untrusted shell-gate subprocesses. */
export function withoutGitHubCredentials(
  environment: NodeJS.ProcessEnv,
  isolatedConfigDirectory: string,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
  ]) {
    delete result[key];
  }
  result.GH_CONFIG_DIR = isolatedConfigDirectory;
  result.GH_PROMPT_DISABLED = 'true';
  return result;
}
