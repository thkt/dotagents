/** @file Outcome: Ephemeral task runs and repository-local artifacts have separate stable storage ownership. */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import { defaultWorkflowRuntimeDirectory } from './environment.ts';
import { FlowError } from './errors.ts';

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
  return path.join(runtimeRoot(), runKey(runId));
}

export function statePath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'state.json');
}

export function intentPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'intent.json');
}

export function issueApprovalPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'issue-approval.json');
}

export function buildShipApprovalPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'build-ship-approval.json');
}

export function workflowInputPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'input.json');
}

export function buildSourcePath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'build-source.json');
}

export function prInputPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'pr-input.json');
}

export function prBodyPath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'pr-body.md');
}

/** Repository-local artifacts are durable handoff and audit cache, never Build authority. */
export function workflowArtifactDirectory(repo: string): string {
  const configured = process.env.CODEX_FLOW_ARTIFACT_DIR?.trim();
  return configured
    ? path.join(path.resolve(configured), repositoryStateKey(repo))
    : path.join(fs.realpathSync(repo), '.codex', 'workflow-artifacts');
}

export function researchArtifactDirectory(repo: string): string {
  return path.join(workflowArtifactDirectory(repo), 'research');
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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
