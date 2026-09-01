/** @file Outcome: Per-task workflow records use private, portable paths and atomic replacement. */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import { defaultWorkflowStateDirectory } from './environment.ts';
import { FlowError } from './errors.ts';

const DEFAULT_STATE_DIR = defaultWorkflowStateDirectory();

function runKey(runId: string): string {
  if (!runId || runId.length > 256) throw new FlowError('--run-id is required');
  return crypto.createHash('sha256').update(runId).digest('hex');
}

function stateDirectory(): string {
  return process.env.CODEX_FLOW_STATE_DIR || DEFAULT_STATE_DIR;
}

export function repositoryStateKey(repo: string): string {
  return crypto.createHash('sha256').update(fs.realpathSync(repo)).digest('hex');
}

export function statePath(runId: string): string {
  return path.join(stateDirectory(), `${runKey(runId)}.json`);
}

export function intentPath(runId: string): string {
  return path.join(stateDirectory(), 'intents', `${runKey(runId)}.json`);
}

export function issueApprovalPath(runId: string): string {
  return path.join(stateDirectory(), 'issue-approvals', `${runKey(runId)}.json`);
}

export function workflowInputPath(runId: string): string {
  return path.join(stateDirectory(), 'inputs', `${runKey(runId)}.json`);
}

export function buildSourcePath(runId: string): string {
  return path.join(stateDirectory(), 'build-sources', `${runKey(runId)}.json`);
}

export function prInputPath(runId: string): string {
  return path.join(stateDirectory(), 'pr-inputs', `${runKey(runId)}.json`);
}

export function prBodyPath(runId: string): string {
  return path.join(stateDirectory(), 'pr-bodies', `${runKey(runId)}.md`);
}

export function researchArtifactDirectory(repo: string): string {
  return path.join(stateDirectory(), 'research', repositoryStateKey(repo));
}

export function thinkArtifactDirectory(repo: string): string {
  return path.join(stateDirectory(), 'think', repositoryStateKey(repo));
}

export function issueArtifactDirectory(repo: string): string {
  return path.join(stateDirectory(), 'issue', repositoryStateKey(repo));
}

/** Replaces a private state record atomically so readers never observe partial JSON. */
export function atomicWrite(file: string, value: unknown): void {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Replaces one private or generated text artifact atomically. */
export function atomicWriteText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
