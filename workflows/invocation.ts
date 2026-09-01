/** @file Outcome: Workflow execution starts only from an explicit task- and repository-bound invocation. */

import * as fs from 'node:fs';
import path from 'node:path';

import type { Workflow } from './flow/contracts.ts';
import { errorCode, errorMessage } from './shared/errors.ts';
import { gitRoot } from './shared/repository.ts';
import {
  atomicWrite,
  buildSourcePath,
  intentPath,
  statePath,
  workflowInputPath,
} from './shared/storage.ts';

const INTENT_PROTOCOL = 'codex-workflow-intent/v4' as const;
type WorkflowInvocation = Workflow | 'issue' | 'research' | 'think';

interface StoredWorkflowIntent {
  protocol: typeof INTENT_PROTOCOL;
  run_id: string;
  workflow: WorkflowInvocation;
  repo: string;
}

interface WorkflowIntent extends StoredWorkflowIntent {
  input_path: string;
  build_source_path: string | null;
}

interface ArmIntentOptions {
  runId: string;
  workflow: WorkflowInvocation;
  cwd: string;
}

function hasRunningFlow(runId: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(runId), 'utf8')) as { status?: unknown };
    if (typeof value.status !== 'string') throw new Error('workflow state has an invalid status');
    return value.status === 'running';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new Error(`workflow state is unreadable: ${errorMessage(error)}`);
  }
}

/** Recognizes only a leading explicit skill invocation, never an incidental mention. */
function parseExplicitInvocation(prompt: string | undefined): WorkflowInvocation | null {
  const value = prompt ?? '';
  const raw = /^\s*\$(build|code|issue|research|think)(?=\s|$)/u.exec(value);
  if (raw) return raw[1] as WorkflowInvocation;

  const linked = /^\s*\[\$(build|code|issue|research|think)\]\([^)\r\n]+\)(?=\s|$)/u.exec(value);
  return (linked?.[1] as WorkflowInvocation | undefined) ?? null;
}

function hydrateIntent(intent: StoredWorkflowIntent): WorkflowIntent {
  return {
    ...intent,
    input_path: workflowInputPath(intent.run_id),
    build_source_path: intent.workflow === 'build' ? buildSourcePath(intent.run_id) : null,
  };
}

/** Binds one explicit invocation to its task, workflow, repository, and private paths. */
function armIntent({ runId, workflow, cwd }: ArmIntentOptions): WorkflowIntent {
  if (hasRunningFlow(runId)) throw new Error('a workflow is already active for this task');
  const repo = gitRoot(cwd, 'explicit workflow invocation requires a Git worktree');
  const existing = loadIntent(runId);
  if (existing && existing.workflow === workflow && existing.repo === repo) return existing;
  const stored: StoredWorkflowIntent = {
    protocol: INTENT_PROTOCOL,
    run_id: runId,
    workflow,
    repo,
  };
  const intent = hydrateIntent(stored);
  for (const file of [intent.input_path, intent.build_source_path]) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  atomicWrite(intentPath(runId), stored);
  return intent;
}

/** Loads and validates an armed intent without trusting persisted JSON. */
function loadIntent(runId: string | undefined): WorkflowIntent | null {
  if (!runId) return null;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(intentPath(runId), 'utf8')) as unknown;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(`workflow intent is unreadable: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow intent has an invalid shape');
  }
  const record = value as Record<string, unknown>;
  const fields = ['protocol', 'run_id', 'workflow', 'repo'];
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field)) ||
    record.protocol !== INTENT_PROTOCOL ||
    record.run_id !== runId ||
    (record.workflow !== 'build' &&
      record.workflow !== 'code' &&
      record.workflow !== 'issue' &&
      record.workflow !== 'research' &&
      record.workflow !== 'think') ||
    typeof record.repo !== 'string' ||
    !path.isAbsolute(record.repo)
  )
    throw new Error('workflow intent has an invalid shape');
  return hydrateIntent({
    protocol: record.protocol,
    run_id: record.run_id,
    workflow: record.workflow,
    repo: record.repo,
  });
}

function requireBoundIntent(
  runId: string,
  workflow: WorkflowInvocation,
  repo: string,
  inputFile: string,
  inputName: 'manifest' | 'issue input' | 'research input' | 'think input',
): WorkflowIntent {
  const intent = loadIntent(runId);
  if (!intent || intent.workflow !== workflow)
    throw new Error(`explicit $${workflow} invocation is required`);
  if (intent.repo !== repo) throw new Error('workflow intent belongs to a different Git worktree');
  if (path.resolve(inputFile) !== intent.input_path) {
    throw new Error(`use the ${inputName} path supplied by the workflow hook`);
  }
  return intent;
}

/** Proves that startup matches the exact intent armed by the hook. */
function requireIntent(
  runId: string,
  workflow: Workflow,
  repo: string,
  manifestFile: string,
): WorkflowIntent {
  return requireBoundIntent(runId, workflow, repo, manifestFile, 'manifest');
}

/** Proves that research startup matches its explicit task- and repository-bound invocation. */
function requireResearchIntent(runId: string, repo: string): WorkflowIntent {
  const intent = loadIntent(runId);
  if (!intent || intent.workflow !== 'research')
    throw new Error('explicit $research invocation is required');
  if (intent.repo !== repo) throw new Error('workflow intent belongs to a different Git worktree');
  return intent;
}

/** Proves that think startup matches its explicit task- and repository-bound invocation. */
function requireThinkIntent(runId: string, repo: string): WorkflowIntent {
  const intent = loadIntent(runId);
  if (!intent || intent.workflow !== 'think')
    throw new Error('explicit $think invocation is required');
  if (intent.repo !== repo) throw new Error('workflow intent belongs to a different Git worktree');
  return intent;
}

/** Proves that issue drafting matches its explicit task- and repository-bound invocation. */
function requireIssueIntent(runId: string, repo: string, inputFile: string): WorkflowIntent {
  return requireBoundIntent(runId, 'issue', repo, inputFile, 'issue input');
}

/** Consumes an intent after controller state has been created successfully. */
function clearIntent(runId: string): void {
  try {
    fs.unlinkSync(intentPath(runId));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export {
  armIntent,
  clearIntent,
  loadIntent,
  parseExplicitInvocation,
  requireIntent,
  requireIssueIntent,
  requireResearchIntent,
  requireThinkIntent,
};
export type { WorkflowIntent, WorkflowInvocation };
