/** @file Outcome: Actors, shell verification, and read-only snapshots use disposable repositories so rejected changes and mid-run edits never reach the worktree. */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GATE_PROTOCOL, type GateOptions, type GateReport } from './contracts.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import {
  gitOptionalText,
  nulPaths,
  repositoryControlChanges,
  repositoryInvariant,
  type RepositoryInvariant,
  sameRepositoryInvariant,
  sameWorkflowRepositoryInvariant,
  snapshotChanges,
  normalizeRepoPath,
} from '../shared/repository.ts';
import { runShellVerification } from './shell-verification.ts';
import {
  actorPublicationPath,
  actorPublicationPayloadDirectory,
  atomicWrite,
} from '../runtime/storage.ts';
import { sealRepository, type SourceSeal } from './source-seal.ts';

/** Tree-ish of the empty tree: the index of a repository without commits diffs against it. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SANDBOX_PREFIX = 'codex-repository-sandbox-';
const SANDBOX_GIT_TIMEOUT_MS = 120_000;
const STALE_SANDBOX_MS = 24 * 60 * 60_000;

interface RepositorySandbox extends Disposable {
  directory: string;
}

interface SandboxOptions {
  /** Actors and gates need ignored files such as node_modules; a read-only snapshot does not. */
  includeIgnored: boolean;
  timeoutMs: number;
}

const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = {
  includeIgnored: true,
  timeoutMs: SANDBOX_GIT_TIMEOUT_MS,
};

function git(repo: string, args: string[], input?: Buffer, timeoutMs?: number): Buffer {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: null,
    input,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  if (errorCode(result.error) === 'ETIMEDOUT') {
    throw new FlowError(`git ${args[0]} exceeded ${timeoutMs}ms`, 'state_error');
  }
  if (result.status !== 0) {
    throw new FlowError(
      Buffer.from(result.stderr || '')
        .toString('utf8')
        .trim() || `git ${args[0]} failed`,
      'state_error',
    );
  }
  return Buffer.from(result.stdout || '');
}

function ignoredPaths(repo: string, timeoutMs: number): Set<string> {
  const listed = git(
    repo,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    undefined,
    timeoutMs,
  );
  return new Set(nulPaths(listed).map((entry) => entry.replace(/\/$/u, '')));
}

function copyWorkingTree(source: string, destination: string, skip: Set<string>): void {
  for (const entry of fs.readdirSync(destination)) {
    if (entry !== '.git')
      fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source)) {
    if (entry === '.git' || skip.has(entry)) continue;
    fs.cpSync(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      dereference: false,
      mode: fs.constants.COPYFILE_FICLONE,
      filter: (file) => path.basename(file) !== '.git' && !skip.has(path.relative(source, file)),
    });
  }
}

/** Removes sandbox roots a killed process left behind; a live run is younger than the threshold. */
function reapStaleSandboxes(now: number = Date.now()): void {
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp)) {
    if (!entry.startsWith(SANDBOX_PREFIX)) continue;
    const root = path.join(tmp, entry);
    const stat = fs.statSync(root, { throwIfNoEntry: false });
    if (!stat || now - stat.mtimeMs < STALE_SANDBOX_MS) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createRepositorySandbox(
  repo: string,
  options: SandboxOptions = DEFAULT_SANDBOX_OPTIONS,
): RepositorySandbox {
  const sourceBefore = repositoryInvariant(repo);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX));
  const directory = path.join(root, 'repo');
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--no-local', repo, directory], {
      encoding: 'utf8',
      timeout: options.timeoutMs,
    });
    if (errorCode(clone.error) === 'ETIMEDOUT') {
      throw new FlowError(`git clone exceeded ${options.timeoutMs}ms`, 'state_error');
    }
    if (clone.status !== 0) {
      throw new FlowError(clone.stderr.trim() || 'git clone failed', 'state_error');
    }
    const head = gitOptionalText(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head)
      git(directory, ['checkout', '--quiet', '--detach', head], undefined, options.timeoutMs);
    const staged = git(
      repo,
      ['diff', '--cached', '--binary', head ?? EMPTY_TREE, '--'],
      undefined,
      options.timeoutMs,
    );
    if (staged.length) {
      git(
        directory,
        ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'],
        staged,
        options.timeoutMs,
      );
    }
    const skip = options.includeIgnored ? new Set<string>() : ignoredPaths(repo, options.timeoutMs);
    copyWorkingTree(repo, directory, skip);
    const sourceAfter = repositoryInvariant(repo);
    const unchanged = options.includeIgnored
      ? sameRepositoryInvariant(sourceBefore, sourceAfter)
      : sameWorkflowRepositoryInvariant(sourceBefore, sourceAfter);
    if (!unchanged) {
      throw new FlowError('repository changed while its snapshot was being created', 'state_error');
    }
    return {
      directory,
      [Symbol.dispose]: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Runs read-only work against one disposable copy of the repository state captured at entry. */
export async function withRepositorySnapshot<T>(
  repo: string,
  run: (snapshotRepo: string) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  reapStaleSandboxes();
  using snapshot = createRepositorySandbox(repo, {
    includeIgnored: false,
    timeoutMs: options.timeoutMs ?? SANDBOX_GIT_TIMEOUT_MS,
  });
  return await run(snapshot.directory);
}

interface PublicationTarget {
  path: string;
  before: string;
  after: string;
  deleted: boolean;
  executable: boolean;
  payload_sha256: string | null;
}

interface PendingPublication<T> {
  protocol: 'codex-flow-actor-publication';
  step_id: string;
  source_before_digest: string;
  source_before: RepositoryInvariant;
  expected_after_seal: SourceSeal;
  targets: PublicationTarget[];
  result: T;
}

function fileFingerprint(repo: string, relative: string): string {
  const target = path.join(repo, relative);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return 'missing';
  if (!stat.isFile()) return `unsupported:${stat.mode}`;
  return `file:${Boolean(stat.mode & 0o111)}:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
}

function stagedPayload(runId: string, relative: string): string {
  return path.join(actorPublicationPayloadDirectory(runId), relative);
}

function applyPending<T>(runId: string, repo: string, pending: PendingPublication<T>): T {
  const targets = new Set(pending.targets.map((target) => target.path));
  const current = repositoryInvariant(repo);
  const withoutTargets = (changes: Record<string, string>) =>
    Object.fromEntries(Object.entries(changes).filter(([relative]) => !targets.has(relative)));
  if (
    current.head !== pending.source_before.head ||
    current.branch !== pending.source_before.branch ||
    JSON.stringify(current.metadata) !== JSON.stringify(pending.source_before.metadata) ||
    JSON.stringify(withoutTargets(current.changes)) !==
      JSON.stringify(withoutTargets(pending.source_before.changes))
  ) {
    throw new FlowError('non-target source changed during actor publication', 'state_error');
  }
  for (const target of pending.targets) {
    const fingerprint = fileFingerprint(repo, target.path);
    if (fingerprint === target.after) continue;
    if (fingerprint !== target.before) {
      throw new FlowError(`${target.path} has an unexpected publication state`, 'state_error');
    }
    const destination = path.join(repo, target.path);
    if (target.deleted) {
      fs.rmSync(destination, { force: true });
      continue;
    }
    const payload = stagedPayload(runId, target.path);
    const bytes = fs.readFileSync(payload);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== target.payload_sha256) {
      throw new FlowError(`${target.path} staged payload changed`, 'state_error');
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.publication`;
    fs.writeFileSync(temporary, bytes, { mode: target.executable ? 0o755 : 0o644 });
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  }
  const after = sealRepository(repo, {
    logical: {
      head: pending.expected_after_seal.head,
      branch: pending.expected_after_seal.branch,
      base_commit: pending.expected_after_seal.base_commit,
    },
  });
  if (after.source_digest !== pending.expected_after_seal.source_digest) {
    throw new FlowError(
      'published repository does not match its expected source seal',
      'state_error',
    );
  }
  return pending.result;
}

/** Publishes an actor through a durable idempotent record that survives process interruption. */
export async function runRecoverableActor<T>(
  runId: string,
  stepId: string,
  repo: string,
  allowedFiles: readonly string[],
  run: (sandboxRepo: string) => Promise<T>,
): Promise<T> {
  const recordPath = actorPublicationPath(runId);
  if (fs.existsSync(recordPath)) {
    const pending = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as PendingPublication<T>;
    if (pending.protocol !== 'codex-flow-actor-publication' || pending.step_id !== stepId) {
      throw new FlowError('pending actor publication belongs to another step', 'state_error');
    }
    return applyPending(runId, repo, pending);
  }
  const sourceInvariant = repositoryInvariant(repo);
  const sourceBefore = sealRepository(repo);
  using sandbox = createRepositorySandbox(repo);
  const before = repositoryInvariant(sandbox.directory);
  const result = await run(sandbox.directory);
  const after = repositoryInvariant(sandbox.directory);
  const controlChanges = repositoryControlChanges(before, after);
  if (controlChanges.length) {
    throw new FlowError(
      `actor changed repository control state: ${controlChanges.join(', ')}`,
      'scope_error',
    );
  }
  const changed = snapshotChanges(before.changes, after.changes);
  const outside = changed.filter(
    (relative) =>
      !allowedFiles.some(
        (scope) =>
          scope === '.' ||
          relative === scope ||
          relative.startsWith(`${scope.replace(/\/$/u, '')}/`),
      ),
  );
  if (outside.length)
    throw new FlowError(
      `actor changed files outside its declared scope: ${outside.join(', ')}`,
      'scope_error',
    );
  if (!sameWorkflowRepositoryInvariant(sourceInvariant, repositoryInvariant(repo))) {
    throw new FlowError('repository changed while actor was isolated', 'state_error');
  }
  const logical = {
    head: sourceBefore.head,
    branch: sourceBefore.branch,
    base_commit: sourceBefore.base_commit,
  };
  const expectedAfter = sealRepository(sandbox.directory, { logical });
  const targets = changed.map((relative): PublicationTarget => {
    if (!normalizeRepoPath(relative))
      throw new FlowError('actor produced an unsafe target', 'scope_error');
    const source = path.join(sandbox.directory, relative);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (stat && !stat.isFile())
      throw new FlowError(`${relative} must remain a regular file`, 'scope_error');
    let payloadDigest: string | null = null;
    if (stat) {
      const bytes = fs.readFileSync(source);
      payloadDigest = crypto.createHash('sha256').update(bytes).digest('hex');
      const payload = stagedPayload(runId, relative);
      fs.mkdirSync(path.dirname(payload), { recursive: true, mode: 0o700 });
      fs.writeFileSync(payload, bytes, { mode: 0o600 });
    }
    return {
      path: relative,
      before: fileFingerprint(repo, relative),
      after: fileFingerprint(sandbox.directory, relative),
      deleted: !stat,
      executable: Boolean(stat && stat.mode & 0o111),
      payload_sha256: payloadDigest,
    };
  });
  const pending: PendingPublication<T> = {
    protocol: 'codex-flow-actor-publication',
    step_id: stepId,
    source_before_digest: sourceBefore.source_digest,
    source_before: sourceInvariant,
    expected_after_seal: expectedAfter,
    targets,
    result,
  };
  atomicWrite(recordPath, pending);
  return applyPending(runId, repo, pending);
}

export function completeActorPublication(runId: string): void {
  fs.rmSync(actorPublicationPath(runId), { force: true });
  fs.rmSync(actorPublicationPayloadDirectory(runId), { recursive: true, force: true });
}

export function pendingActorPublicationStep(runId: string): string | null {
  const file = actorPublicationPath(runId);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    protocol?: unknown;
    step_id?: unknown;
  };
  if (value.protocol !== 'codex-flow-actor-publication' || typeof value.step_id !== 'string') {
    throw new FlowError('pending actor publication has an invalid shape', 'state_error');
  }
  return value.step_id;
}

/** Runs a gate in a disposable clone and blocks if it attempts any mutation. */
export function runIsolatedShellVerification(options: GateOptions): {
  report: GateReport;
  processExitCode: number;
} {
  let created: RepositorySandbox;
  try {
    created = createRepositorySandbox(options.cwd);
  } catch (error) {
    return {
      processExitCode: 2,
      report: {
        protocol: GATE_PROTOCOL,
        gate_id: options.gateId,
        verdict: 'blocked',
        classification: 'gate_isolation_failed',
        reason_codes: ['gate_isolation_failed'],
        failure_route: 'blocked',
        configured_failure_route: options.failureRoute,
        command: options.command,
        cwd: options.cwd,
        expected: options.expect,
        duration_ms: 0,
        evidence: {
          kind: 'shell',
          checks: [],
          matches_expected_exit: false,
          exit_code: null,
          signal: null,
          timed_out: false,
          execution_error: errorMessage(error),
          stdout_tail: '',
          stderr_tail: '',
        },
      },
    };
  }
  using sandbox = created;
  const before = repositoryInvariant(sandbox.directory);
  const result = runShellVerification({ ...options, cwd: sandbox.directory });
  const after = repositoryInvariant(sandbox.directory);
  const report = {
    ...result.report,
    cwd: options.cwd,
  };
  if (sameRepositoryInvariant(before, after)) return { ...result, report };
  return {
    processExitCode: 2,
    report: {
      ...report,
      verdict: 'blocked',
      classification: 'gate_attempted_repository_mutation',
      reason_codes: ['gate_attempted_repository_mutation', ...report.reason_codes],
      failure_route: 'blocked',
    },
  };
}
