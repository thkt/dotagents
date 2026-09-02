/** @file Outcome: Repository paths and snapshots expose scope changes without escaping the worktree. */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError, errorCode } from './errors.ts';

export type RepoSnapshot = Record<string, string>;

export interface RepositoryInvariant {
  head: string | null;
  branch: string | null;
  changes: RepoSnapshot;
  ignored: RepoSnapshot;
  metadata: RepoSnapshot;
}

export type WorkflowRepositoryInvariant = Pick<
  RepositoryInvariant,
  'head' | 'branch' | 'changes' | 'metadata'
>;

/** Normalizes an untrusted path only when it stays repo-relative and outside .git. */
export function normalizeRepoPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || value.includes('\0'))
    return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized === '.git' ||
    normalized.startsWith('.git/')
  )
    return null;
  return normalized;
}

export function realpathInside(root: string, target: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

export function nearestExistingParent(target: string): string | null {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export function gitRoot(repo: string, message = 'manifest repo must be a Git worktree'): string {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new FlowError(message);
  return fs.realpathSync(result.stdout.trim());
}

export function gitOutput(repo: string, args: string[], label: string): Buffer {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: null });
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr || '')
      .toString('utf8')
      .trim();
    throw new FlowError(`${label} failed${detail ? `: ${detail}` : ''}`, 'state_error');
  }
  return Buffer.from(result.stdout || '');
}

export function gitText(repo: string, args: string[], label: string): string {
  return gitOutput(repo, args, label).toString('utf8').trim();
}

export function gitOptionalText(repo: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function nulPaths(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function changedPaths(repo: string): string[] {
  const paths = new Set([
    ...nulPaths(gitOutput(repo, ['diff', '--name-only', '-z'], 'worktree diff')),
    ...nulPaths(gitOutput(repo, ['diff', '--cached', '--name-only', '-z'], 'index diff')),
    ...nulPaths(
      gitOutput(repo, ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked scan'),
    ),
  ]);
  return [...paths].sort();
}

function worktreeFingerprint(repo: string, relative: string): string {
  const absolute = path.resolve(repo, relative);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(absolute)}`;
    if (stat.isFile()) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      return `file:${stat.mode & 0o777}:${hash}`;
    }
    return `other:${stat.mode & 0o777}`;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Fingerprints every dirty path across the worktree, index, and untracked set. */
export function repoSnapshot(repo: string): RepoSnapshot {
  return Object.fromEntries(
    changedPaths(repo).map((relative) => {
      const index = gitOutput(
        repo,
        ['ls-files', '-s', '-z', '--', relative],
        'index fingerprint',
      ).toString('base64');
      return [relative, `${worktreeFingerprint(repo, relative)}:${index}`];
    }),
  );
}

function ignoredSnapshot(repo: string): RepoSnapshot {
  const paths = nulPaths(
    gitOutput(
      repo,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      'ignored scan',
    ),
  );
  return Object.fromEntries(
    paths.map((relative) => {
      const absolute = path.resolve(repo, relative);
      const stat = fs.lstatSync(absolute);
      const identity = stat.isSymbolicLink()
        ? `symlink:${fs.readlinkSync(absolute)}`
        : `${stat.mode & 0o777}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      return [relative, identity];
    }),
  );
}

const CODEX_MANAGED_REF_PREFIX = 'refs/codex/';

/**
 * Captures repository-owned refs while excluding refs maintained by the Codex host.
 * Desktop turn checkpoints and snapshots are operational state, not repository mutations.
 */
function repositoryRefs(repo: string): string {
  const output = gitOutput(
    repo,
    ['for-each-ref', '--format=%(refname)%00%(objectname)%00'],
    'ref scan',
  ).toString('utf8');
  const records = output
    .split('\n')
    .filter((record) => record && !record.startsWith(CODEX_MANAGED_REF_PREFIX));
  return Buffer.from(records.map((record) => `${record}\n`).join('')).toString('base64');
}

/** Captures actor/gate-visible files plus Git control state for mutation checks. */
export function repositoryInvariant(repo: string): RepositoryInvariant {
  return {
    head: gitOptionalText(repo, ['rev-parse', 'HEAD']),
    branch: gitOptionalText(repo, ['branch', '--show-current']),
    changes: repoSnapshot(repo),
    ignored: ignoredSnapshot(repo),
    metadata: {
      refs: repositoryRefs(repo),
      config: gitOutput(repo, ['config', '--local', '--null', '--list'], 'config scan').toString(
        'base64',
      ),
      index: gitOutput(repo, ['ls-files', '-s', '-v', '-z'], 'index scan').toString('base64'),
    },
  };
}

export function sameRepositoryInvariant(
  left: RepositoryInvariant,
  right: RepositoryInvariant,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function workflowRepositoryInvariant(
  invariant: RepositoryInvariant,
): WorkflowRepositoryInvariant {
  return {
    head: invariant.head,
    branch: invariant.branch,
    changes: invariant.changes,
    metadata: invariant.metadata,
  };
}

/** Compares workflow state while ignoring external changes to ignored files. */
export function sameWorkflowRepositoryInvariant(
  left: RepositoryInvariant,
  right: RepositoryInvariant,
): boolean {
  return (
    JSON.stringify(workflowRepositoryInvariant(left)) ===
    JSON.stringify(workflowRepositoryInvariant(right))
  );
}

export function sameRepoSnapshot(left: RepoSnapshot, right: RepoSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Names repository control state changed between two invariant captures. */
export function repositoryControlChanges(
  before: RepositoryInvariant,
  after: RepositoryInvariant,
  options: { includeIgnored?: boolean } = {},
): string[] {
  return [
    ...(before.head === after.head ? [] : ['HEAD']),
    ...(before.branch === after.branch ? [] : ['branch']),
    ...(options.includeIgnored === false || sameRepoSnapshot(before.ignored, after.ignored)
      ? []
      : ['ignored files']),
    ...(sameRepoSnapshot(before.metadata, after.metadata) ? [] : ['Git metadata']),
  ];
}

/** Returns only paths whose fingerprints changed between two snapshots. */
export function snapshotChanges(
  before: RepoSnapshot | null | undefined,
  after: RepoSnapshot | null | undefined,
): string[] {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((relative) => before?.[relative] !== after?.[relative])
    .sort();
}

/** Rejects the run when the live repository moved while a workflow read from its snapshot. */
export function requireUnchangedRepository(
  before: RepositoryInvariant,
  repo: string,
  workflow: string,
): void {
  if (!sameWorkflowRepositoryInvariant(before, repositoryInvariant(repo))) {
    throw new FlowError(`repository changed while ${workflow} was running`, 'state_error');
  }
}
