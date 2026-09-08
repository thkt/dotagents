/** @file Outcome: Tests allocate isolated temporary state and always restore process state. */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, onTestFinished } from 'bun:test';

/** Allocates a directory owned by the current test and removes it after the test. */
export function temporaryDirectory(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Gives one test module separate private runtime and artifact roots, then restores both. */
export function useTemporaryWorkflowStorage(prefix: string): {
  runtime: string;
  artifacts: string;
} {
  const previousRuntime = process.env.CODEX_FLOW_RUNTIME_DIR;
  const previousArtifacts = process.env.CODEX_FLOW_ARTIFACT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const runtime = path.join(root, 'runtime');
  const artifacts = path.join(root, 'artifacts');
  process.env.CODEX_FLOW_RUNTIME_DIR = runtime;
  process.env.CODEX_FLOW_ARTIFACT_DIR = artifacts;
  afterAll(() => {
    if (previousRuntime === undefined) delete process.env.CODEX_FLOW_RUNTIME_DIR;
    else process.env.CODEX_FLOW_RUNTIME_DIR = previousRuntime;
    if (previousArtifacts === undefined) delete process.env.CODEX_FLOW_ARTIFACT_DIR;
    else process.env.CODEX_FLOW_ARTIFACT_DIR = previousArtifacts;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { runtime, artifacts };
}

/** Set fixture policy before inventory capture; shared Git excludes survive worktree/branch changes. */
export function ignoreWorkflowStorage(repo: string): void {
  const common = execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  const info = path.resolve(repo, common, 'info');
  fs.mkdirSync(info, { recursive: true });
  const rule = '\n/.codex/workflow-artifacts/\n';
  fs.appendFileSync(path.join(info, 'exclude'), rule);
  // Snapshots copy worktree files, so carry the same policy into their source seals.
  fs.appendFileSync(path.join(repo, '.gitignore'), rule);
}
