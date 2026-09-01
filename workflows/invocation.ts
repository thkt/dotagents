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
  issueApprovalPath,
  statePath,
  workflowInputPath,
} from './shared/storage.ts';

const INTENT_PROTOCOL = 'codex-workflow-intent/v4' as const;
const ISSUE_APPROVAL_PROTOCOL = 'codex-issue-approval/v1' as const;
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

interface StoredIssueApproval {
  protocol: typeof ISSUE_APPROVAL_PROTOCOL;
  run_id: string;
  repo: string;
  operation: 'publish-one-github-issue';
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
  if (existing && existing.workflow === workflow && existing.repo === repo) {
    if (workflow === 'issue') armIssueApproval(runId, repo);
    return existing;
  }
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
  if (workflow === 'issue') armIssueApproval(runId, repo);
  return intent;
}

/** Records the one GitHub publication authorized by a leading explicit $issue invocation. */
function armIssueApproval(runId: string, repo: string): void {
  const approval: StoredIssueApproval = {
    protocol: ISSUE_APPROVAL_PROTOCOL,
    run_id: runId,
    repo,
    operation: 'publish-one-github-issue',
  };
  atomicWrite(issueApprovalPath(runId), approval);
}

/** Atomically consumes the task- and repository-bound approval before the GitHub write starts. */
function consumeIssueApproval(runId: string, repo: string): void {
  let value: unknown;
  const approvalFile = issueApprovalPath(runId);
  try {
    value = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as unknown;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new Error('explicit $issue publication approval is required');
    }
    throw new Error(`issue publication approval is unreadable: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('issue publication approval has an invalid shape');
  }
  const record = value as Record<string, unknown>;
  const fields = ['protocol', 'run_id', 'repo', 'operation'];
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field)) ||
    record.protocol !== ISSUE_APPROVAL_PROTOCOL ||
    record.run_id !== runId ||
    record.repo !== repo ||
    record.operation !== 'publish-one-github-issue'
  ) {
    throw new Error('issue publication approval has an invalid shape');
  }
  try {
    fs.unlinkSync(approvalFile);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new Error('explicit $issue publication approval is required');
    }
    throw error;
  }
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
function requireResearchIntent(runId: string, repo: string, inputFile: string): WorkflowIntent {
  return requireBoundIntent(runId, 'research', repo, inputFile, 'research input');
}

/** Proves that think startup matches its explicit task- and repository-bound invocation. */
function requireThinkIntent(runId: string, repo: string, inputFile: string): WorkflowIntent {
  return requireBoundIntent(runId, 'think', repo, inputFile, 'think input');
}

/** Proves that issue drafting matches its explicit task- and repository-bound invocation. */
function requireIssueIntent(runId: string, repo: string, inputFile: string): WorkflowIntent {
  return requireBoundIntent(runId, 'issue', repo, inputFile, 'issue input');
}

/** Clears the task-scoped intent and any publication authority derived from it. */
function clearIntent(runId: string): void {
  for (const file of [intentPath(runId), issueApprovalPath(runId)]) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}

export {
  armIntent,
  clearIntent,
  consumeIssueApproval,
  loadIntent,
  parseExplicitInvocation,
  requireIntent,
  requireIssueIntent,
  requireResearchIntent,
  requireThinkIntent,
};
export type { WorkflowIntent, WorkflowInvocation };
