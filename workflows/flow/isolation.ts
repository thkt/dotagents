/** @file Outcome: Actors and shell gates use disposable repositories so rejected changes never reach the worktree. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GATE_PROTOCOL,
  type BuildPlanUnit,
  type CalibrationCandidate,
  type GateOptions,
  type GateReport,
} from './contracts.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import {
  repositoryControlChanges,
  repositoryInvariant,
  sameRepositoryInvariant,
  sameWorkflowRepositoryInvariant,
  snapshotChanges,
} from '../shared/repository.ts';
import { runShellVerification } from './shell-gate.ts';

interface RepositorySandbox {
  directory: string;
  dispose(): void;
}

function git(repo: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: null, input });
  if (result.status !== 0) {
    throw new Error(
      Buffer.from(result.stderr || '')
        .toString('utf8')
        .trim() || `git ${args[0]} failed`,
    );
  }
  return Buffer.from(result.stdout || '');
}

function copyWorkingTree(source: string, destination: string): void {
  for (const entry of fs.readdirSync(destination)) {
    if (entry !== '.git')
      fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source)) {
    if (entry === '.git') continue;
    fs.cpSync(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      dereference: false,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  }
}

function createRepositorySandbox(repo: string): RepositorySandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repository-sandbox-'));
  const directory = path.join(root, 'repo');
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--no-local', repo, directory], {
      encoding: 'utf8',
    });
    if (clone.status !== 0) throw new Error(clone.stderr.trim() || 'git clone failed');
    const head = git(repo, ['rev-parse', 'HEAD']).toString('utf8').trim();
    git(directory, ['checkout', '--quiet', '--detach', head]);
    const staged = git(repo, ['diff', '--cached', '--binary', 'HEAD', '--']);
    if (staged.length)
      git(directory, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], staged);
    copyWorkingTree(repo, directory);
    return {
      directory,
      dispose: () => fs.rmSync(root, { recursive: true, force: true }),
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
): Promise<T> {
  const snapshot = createRepositorySandbox(repo);
  try {
    return await run(snapshot.directory);
  } finally {
    snapshot.dispose();
  }
}

function copyActorFile(sourceRepo: string, targetRepo: string, relative: string): void {
  const source = path.join(sourceRepo, relative);
  const target = path.join(targetRepo, relative);
  const stat = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!stat) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    return;
  }
  if (!stat.isFile()) throw new FlowError(`${relative} must remain a regular file`, 'scope_error');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(target, stat.mode & 0o777);
}

/** Runs an actor in a disposable clone and publishes only its allowed file changes. */
export async function runIsolatedActor(
  repo: string,
  allowedFiles: readonly string[],
  run: (sandboxRepo: string) => Promise<void>,
): Promise<void> {
  const sourceBefore = repositoryInvariant(repo);
  const sandbox = createRepositorySandbox(repo);
  try {
    const before = repositoryInvariant(sandbox.directory);
    await run(sandbox.directory);
    const after = repositoryInvariant(sandbox.directory);
    const controlChanges = repositoryControlChanges(before, after);
    if (controlChanges.length) {
      throw new FlowError(
        `actor changed repository control state: ${controlChanges.join(', ')}`,
        'scope_error',
      );
    }
    const changed = snapshotChanges(before.changes, after.changes);
    const allowed = new Set(allowedFiles);
    const outside = changed.filter((relative) => !allowed.has(relative));
    if (outside.length) {
      throw new FlowError(
        `actor changed files outside its declared scope: ${outside.join(', ')}`,
        'scope_error',
      );
    }
    if (!sameWorkflowRepositoryInvariant(sourceBefore, repositoryInvariant(repo))) {
      throw new FlowError('repository changed while actor was isolated', 'state_error');
    }
    for (const relative of changed) copyActorFile(sandbox.directory, repo, relative);
  } finally {
    sandbox.dispose();
  }
}

/** Runs a gate in a disposable clone and blocks if it attempts any mutation. */
export function runIsolatedShellVerification(
  options: GateOptions,
  plannedTests?: BuildPlanUnit['tests'] | null,
): {
  report: GateReport;
  processExitCode: number;
  candidates: CalibrationCandidate[];
} {
  let sandbox: RepositorySandbox;
  try {
    sandbox = createRepositorySandbox(options.cwd);
  } catch (error) {
    return {
      processExitCode: 2,
      candidates: [],
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
  try {
    const before = repositoryInvariant(sandbox.directory);
    const result = runShellVerification({ ...options, cwd: sandbox.directory }, plannedTests);
    const after = repositoryInvariant(sandbox.directory);
    const report = {
      ...result.report,
      cwd: options.cwd,
    };
    if (sameRepositoryInvariant(before, after)) return { ...result, report };
    return {
      processExitCode: 2,
      candidates: result.candidates,
      report: {
        ...report,
        verdict: 'blocked',
        classification: 'gate_attempted_repository_mutation',
        reason_codes: ['gate_attempted_repository_mutation', ...report.reason_codes],
        failure_route: 'blocked',
      },
    };
  } finally {
    sandbox.dispose();
  }
}
