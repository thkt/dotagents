import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import { defaultWorkflowStateDirectory } from '../../runtime/paths.ts';
import type { Workflow } from './contracts.ts';

const INTENT_PROTOCOL = 'codex-flow-intent/v1' as const;

interface FlowIntent {
  protocol: typeof INTENT_PROTOCOL;
  run_id: string;
  workflow: Workflow;
  repo: string;
  manifest_path: string;
  created_at: string;
}

interface ArmIntentOptions {
  runId: string;
  workflow: Workflow;
  cwd: string;
}

function stateDirectory(): string {
  return process.env.CODEX_FLOW_STATE_DIR || defaultWorkflowStateDirectory();
}

function runKey(runId: string): string {
  if (!runId || runId.length > 256) throw new Error('workflow intent requires a Codex session_id');
  return crypto.createHash('sha256').update(runId).digest('hex');
}

function intentPath(runId: string): string {
  return path.join(stateDirectory(), 'intents', `${runKey(runId)}.json`);
}

function manifestPath(runId: string): string {
  return path.join(stateDirectory(), 'manifests', `${runKey(runId)}.json`);
}

function flowStatePath(runId: string): string {
  return path.join(stateDirectory(), `${runKey(runId)}.json`);
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function gitRoot(cwd: string): string {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('explicit workflow invocation requires a Git worktree');
  return fs.realpathSync(result.stdout.trim());
}

function hasRunningFlow(runId: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(flowStatePath(runId), 'utf8')) as { status?: unknown };
    return value.status === 'running';
  } catch {
    return false;
  }
}

function parseExplicitInvocation(prompt: string | undefined): Workflow | null {
  const match = /^\s*\$(build|code)(?=\s|$)/u.exec(prompt || '');
  return (match?.[1] as Workflow | undefined) || null;
}

function armIntent({ runId, workflow, cwd }: ArmIntentOptions): FlowIntent {
  if (hasRunningFlow(runId)) throw new Error('a workflow is already active for this task');
  const repo = gitRoot(cwd);
  const existing = loadIntent(runId);
  if (existing && existing.workflow === workflow && existing.repo === repo) return existing;
  const intent: FlowIntent = {
    protocol: INTENT_PROTOCOL,
    run_id: runId,
    workflow,
    repo,
    manifest_path: manifestPath(runId),
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(intent.manifest_path), { recursive: true, mode: 0o700 });
  atomicWrite(intentPath(runId), intent);
  return intent;
}

function loadIntent(runId: string | undefined): FlowIntent | null {
  if (!runId) return null;
  try {
    const value = JSON.parse(fs.readFileSync(intentPath(runId), 'utf8')) as FlowIntent;
    if (
      value.protocol !== INTENT_PROTOCOL
      || value.run_id !== runId
      || (value.workflow !== 'build' && value.workflow !== 'code')
      || !path.isAbsolute(value.repo)
      || !path.isAbsolute(value.manifest_path)
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function requireIntent(
  runId: string,
  workflow: Workflow,
  repo: string,
  manifestFile: string,
): FlowIntent {
  const intent = loadIntent(runId);
  if (!intent) throw new Error(`explicit $${workflow} invocation is required`);
  if (intent.workflow !== workflow) {
    throw new Error(`explicit $${workflow} invocation is required for this manifest`);
  }
  if (intent.repo !== repo) throw new Error('workflow intent belongs to a different Git worktree');
  if (path.resolve(manifestFile) !== intent.manifest_path) {
    throw new Error('use the manifest path supplied by the workflow hook');
  }
  return intent;
}

function clearIntent(runId: string): void {
  try {
    fs.unlinkSync(intentPath(runId));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export {
  INTENT_PROTOCOL,
  armIntent,
  clearIntent,
  intentPath,
  loadIntent,
  manifestPath,
  parseExplicitInvocation,
  requireIntent,
};
export type { ArmIntentOptions, FlowIntent };
