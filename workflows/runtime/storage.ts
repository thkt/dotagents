/** @file Outcome: Ephemeral task runs and repository-local artifacts have separate stable storage ownership. */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { defaultWorkflowRuntimeDirectory } from './environment.ts';
import { FlowError } from '../shared/errors.ts';

const DEFAULT_RUNTIME_DIR = defaultWorkflowRuntimeDirectory();

function runKey(runId: string): string {
  if (!runId || runId.length > 256) throw new FlowError('--run-id is required');
  return crypto.createHash('sha256').update(runId).digest('hex');
}

function runtimeRoot(): string {
  return path.resolve(process.env.CODEX_FLOW_RUNTIME_DIR || DEFAULT_RUNTIME_DIR);
}

function repositoryStateKey(repo: string): string {
  return crypto.createHash('sha256').update(fs.realpathSync(repo)).digest('hex');
}

/** One hook-created directory owns every ephemeral record for one task. */
export function workflowRunDirectory(runId: string): string {
  const directory = path.join(runtimeRoot(), runKey(runId));
  protectPrivateStorage(runtimeRoot(), 'directory');
  protectPrivateStorage([directory], 'directory');
  protectPrivateStorage(
    [
      'ownership.sqlite',
      'ownership.sqlite-journal',
      'ownership.sqlite-wal',
      'ownership.sqlite-shm',
    ].map((name) => path.join(directory, name)),
  );
  return directory;
}

export function statePath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'state.json');
}

export function thinkStatePath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'think-state.json');
}

export function researchStatePath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'research-state.json');
}

export function intentPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'intent.json');
}

export function workflowInputPath(
  runId: string,
  workflow: 'build' | 'code' | 'issue' | 'research' | 'think' | 'cleanup',
): string {
  return path.join(workflowRunDirectory(runId), `${workflow}-input.json`);
}

export function prInputPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'pr-input.json');
}

export function prBodyPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'pr-body.md');
}

export function buildScreenshotPath(runId: string, name: string): string {
  return path.join(workflowRunDirectory(runId), 'screenshots', name);
}

export function screenshotSealPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'screenshot-seal.json');
}

export function actorPublicationPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'actor-publication.json');
}

export function actorPublicationPayloadDirectory(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'actor-publication-payloads');
}

/** Repository-local artifacts are durable handoff and audit cache, never Build authority. */
export function workflowArtifactDirectory(repo: string): string {
  const configured = process.env.CODEX_FLOW_ARTIFACT_DIR?.trim();
  const directory = configured
    ? path.join(path.resolve(configured), repositoryStateKey(repo))
    : path.join(fs.realpathSync(repo), '.codex', 'workflow-artifacts');
  protectPrivateStorage(configured ? path.resolve(configured) : directory, 'directory');
  protectPrivateStorage(directory, 'directory');
  return directory;
}

export function researchArtifactDirectory(repo: string): string {
  return path.join(workflowArtifactDirectory(repo), 'research');
}

export function knowledgeArtifactDirectory(repo: string): string {
  return path.join(workflowArtifactDirectory(repo), 'knowledge');
}

export function thinkArtifactDirectory(repo: string): string {
  return path.join(workflowArtifactDirectory(repo), 'think');
}

export function issueArtifactDirectory(repo: string): string {
  return path.join(workflowArtifactDirectory(repo), 'issue');
}

/** Replaces a private state record atomically so readers never observe partial JSON. */
export function atomicWrite(file: string, value: unknown): void {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Replaces one private or generated text artifact atomically. */
export function atomicWriteText(file: string, value: string): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  protectPrivateStorage([file, temporary]);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function artifactPaths(
  directory: string,
  seed: string,
  generatedAt: Date,
  fallback: string,
): { json: string; markdown: string } {
  const timestamp = generatedAt
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const slug =
    seed
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.slice(0, 6)
      .join('-') || fallback;
  const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  const base = `${timestamp}-${slug}-${digest}`;
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const json = path.join(directory, `${name}.json`);
    const markdown = path.join(directory, `${name}.md`);
    if (!fs.existsSync(json) && !fs.existsSync(markdown)) return { json, markdown };
  }
}

/** Cleanup evidence has a fixed repository-local durability boundary. */
export function cleanupArtifactDirectory(repo: string): string {
  return path.join(cleanupRepository(repo), '.codex', 'workflow-artifacts', 'cleanup');
}

/** Stable repository owner shared by the primary and linked worktrees. */
export function cleanupRepository(repo: string): string {
  const result = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z'], {
    encoding: 'utf8',
  });
  const primary = result.stdout?.split('\0').find((v) => v.startsWith('worktree '));
  if (result.status !== 0 || !primary)
    throw new FlowError('cannot resolve cleanup repository owner', 'cleanup_unsupported');
  return fs.realpathSync(primary.slice(9));
}

/** Resolve existing ancestors before creation, including persisted destinations and symlinks. */
export function protectPrivateStorage(
  destination: string | readonly string[],
  kind: 'file' | 'directory' = 'file',
): void {
  const groups = new Map<string, Set<string>>();
  const destinations = typeof destination === 'string' ? [destination] : destination;
  for (const entry of destinations) {
    // Avoid normalizing a symlink/.. path differently from the eventual filesystem write.
    if (entry.split(path.sep).includes('..'))
      throw new FlowError('Private storage has an unsafe path', 'state_error');
    const absolute = path.resolve(entry);
    // Private records are regular entries; replacement must not clobber a tracked symlink.
    if (kind === 'file' && fs.lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new FlowError('Private storage has an unsafe path', 'state_error');
    let ancestor = absolute;
    while (!fs.existsSync(ancestor)) {
      const entry = fs.lstatSync(ancestor, { throwIfNoEntry: false });
      // Another process may have created this directory after the existence check.
      if (entry?.isDirectory()) break;
      if (entry) throw new FlowError('Private storage has an unsafe path', 'state_error');
      ancestor = path.dirname(ancestor);
    }
    const resolvedAncestor = fs.realpathSync(ancestor);
    const resolved = path.resolve(resolvedAncestor, path.relative(ancestor, absolute));
    let owner = fs.statSync(ancestor).isDirectory()
      ? resolvedAncestor
      : path.dirname(resolvedAncestor);
    while (!fs.existsSync(path.join(owner, '.git'))) {
      const parent = path.dirname(owner);
      if (parent === owner) break;
      owner = parent;
    }
    if (!fs.existsSync(path.join(owner, '.git'))) continue;
    const relative = path.relative(owner, resolved).split(path.sep).join('/');
    const entries = groups.get(owner) ?? new Set<string>();
    entries.add(kind === 'directory' ? `${relative}/` : relative);
    // A file's namespace must be private before recursive mkdir or temporary-file creation.
    if (kind === 'file') entries.add(`${path.posix.dirname(relative)}/`);
    groups.set(owner, entries);
  }
  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (const [repo, entries] of groups) {
    const tracked = spawnSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8' });
    const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '--no-index', '--stdin', '-z'], {
      encoding: 'utf8',
      input: [...entries].join('\0') + '\0',
    });
    const matches = new Set(ignored.stdout?.split('\0'));
    if (
      tracked.status !== 0 ||
      ignored.status !== 0 ||
      [...entries].some((entry) => {
        const relative = entry.replace(/\/$/u, '');
        return (
          !relative ||
          relative === '.' ||
          overlaps(relative, 'research/records') ||
          overlaps(relative, 'research/reports') ||
          tracked.stdout
            .split('\0')
            .filter(Boolean)
            .some((file) => overlaps(relative, file)) ||
          !matches.has(entry)
        );
      })
    )
      throw new FlowError(
        'Private storage inside a repository must be Git-ignored and disjoint from tracked files and the Research corpus',
        'state_error',
      );
  }
}
