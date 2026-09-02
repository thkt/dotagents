/** @file Outcome: Workflow execution starts only from an explicit task- and repository-bound invocation. */

import * as fs from 'node:fs';
import path from 'node:path';

import type { Workflow } from './flow/contracts.ts';
import { errorCode, errorMessage } from './shared/errors.ts';
import { gitRoot } from './shared/repository.ts';
import {
  atomicWrite,
  buildShipApprovalPath,
  intentPath,
  issueApprovalPath,
  statePath,
  workflowInputPath,
} from './shared/storage.ts';

const INTENT_PROTOCOL = 'codex-workflow-intent' as const;
const ISSUE_APPROVAL_PROTOCOL = 'codex-issue-approval' as const;
const BUILD_SHIP_APPROVAL_PROTOCOL = 'codex-build-ship-approval' as const;
type WorkflowInvocation = Workflow | 'issue' | 'research' | 'think';

interface ApprovalSpec {
  protocol: string;
  operation: string;
  path(runId: string): string;
  label: string;
  missing: string;
}

const ISSUE_APPROVAL: ApprovalSpec = {
  protocol: ISSUE_APPROVAL_PROTOCOL,
  operation: 'publish-one-github-issue-and-ensure-priority-label',
  path: issueApprovalPath,
  label: 'issue publication approval',
  missing: 'explicit $issue publication approval is required',
};

const BUILD_SHIP_APPROVAL: ApprovalSpec = {
  protocol: BUILD_SHIP_APPROVAL_PROTOCOL,
  operation: 'push-and-create-one-draft-pr',
  path: buildShipApprovalPath,
  label: 'build Ship approval',
  missing: 'explicit $build Ship approval is required',
};

interface StoredWorkflowIntent {
  protocol: typeof INTENT_PROTOCOL;
  run_id: string;
  workflow: WorkflowInvocation;
  repo: string;
}

interface WorkflowIntent extends StoredWorkflowIntent {
  input_path: string;
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

/** Reads the optional Issue shorthand immediately following an explicit Build invocation. */
function parseBuildIssueNumber(prompt: string | undefined): number | null {
  const value = prompt ?? '';
  const match = /^\s*(?:\$build|\[\$build\]\([^)\r\n]+\))\s+#([^\s]+)/u.exec(value);
  if (!match) return null;
  if (!/^[1-9]\d*$/u.test(match[1]!)) {
    throw new Error('build Issue shorthand must be a positive integer such as #123');
  }
  const issue = Number(match[1]);
  if (!Number.isSafeInteger(issue)) {
    throw new Error('build Issue shorthand is outside the supported integer range');
  }
  return issue;
}

function hydrateIntent(intent: StoredWorkflowIntent): WorkflowIntent {
  return {
    ...intent,
    input_path: workflowInputPath(intent.run_id),
  };
}

function approvalFor(workflow: WorkflowInvocation): ApprovalSpec | null {
  if (workflow === 'issue') return ISSUE_APPROVAL;
  if (workflow === 'build') return BUILD_SHIP_APPROVAL;
  return null;
}

function armApproval(spec: ApprovalSpec, runId: string, repo: string): void {
  atomicWrite(spec.path(runId), {
    protocol: spec.protocol,
    run_id: runId,
    repo,
    operation: spec.operation,
  });
}

function requireApproval(spec: ApprovalSpec, runId: string, repo: string): string {
  const approvalFile = spec.path(runId);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as unknown;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(spec.missing);
    throw new Error(`${spec.label} is unreadable: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${spec.label} has an invalid shape`);
  }
  const record = value as Record<string, unknown>;
  const fields = ['protocol', 'run_id', 'repo', 'operation'];
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field)) ||
    record.protocol !== spec.protocol ||
    record.run_id !== runId ||
    record.repo !== repo ||
    record.operation !== spec.operation
  ) {
    throw new Error(`${spec.label} has an invalid shape`);
  }
  return approvalFile;
}

function consumeApproval(spec: ApprovalSpec, runId: string, repo: string): void {
  const approvalFile = requireApproval(spec, runId, repo);
  try {
    fs.unlinkSync(approvalFile);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(spec.missing);
    throw error;
  }
}

/** Binds one explicit invocation to its task, workflow, repository, and private paths. */
function armIntent({ runId, workflow, cwd }: ArmIntentOptions): WorkflowIntent {
  if (hasRunningFlow(runId)) throw new Error('a workflow is already active for this task');
  const repo = gitRoot(cwd, 'explicit workflow invocation requires a Git worktree');
  const existing = loadIntent(runId);
  if (existing && existing.workflow === workflow && existing.repo === repo) {
    const approval = approvalFor(workflow);
    if (approval) armApproval(approval, runId, repo);
    return existing;
  }
  const stored: StoredWorkflowIntent = {
    protocol: INTENT_PROTOCOL,
    run_id: runId,
    workflow,
    repo,
  };
  const intent = hydrateIntent(stored);
  fs.mkdirSync(path.dirname(intent.input_path), { recursive: true, mode: 0o700 });
  atomicWrite(intentPath(runId), stored);
  const approval = approvalFor(workflow);
  if (approval) armApproval(approval, runId, repo);
  return intent;
}

/** Validates the task- and repository-bound authority before Ship enters controller state. */
function requireBuildShipApproval(runId: string, repo: string): void {
  requireApproval(BUILD_SHIP_APPROVAL, runId, repo);
}

/** Atomically consumes the task- and repository-bound approval before the GitHub write starts. */
function consumeIssueApproval(runId: string, repo: string): void {
  consumeApproval(ISSUE_APPROVAL, runId, repo);
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
  inputName: 'build input' | 'manifest' | 'issue input' | 'research input' | 'think input',
): WorkflowIntent {
  const intent = requireBoundInput(runId, workflow, inputFile, inputName);
  if (intent.repo !== repo) throw new Error('workflow intent belongs to a different Git worktree');
  return intent;
}

function requireBoundInput(
  runId: string,
  workflow: WorkflowInvocation,
  inputFile: string,
  inputName: 'build input' | 'manifest' | 'issue input' | 'research input' | 'think input',
): WorkflowIntent {
  const intent = loadIntent(runId);
  if (!intent || intent.workflow !== workflow)
    throw new Error(`explicit $${workflow} invocation is required`);
  if (path.resolve(inputFile) !== intent.input_path) {
    throw new Error(`use the ${inputName} path supplied by the workflow hook`);
  }
  return intent;
}

/** Terminates an unstarted explicit workflow through its exact task-bound input path. */
function stopPendingIntent(
  runId: string,
  workflow: WorkflowInvocation,
  inputFile: string,
  inputName: 'build input' | 'manifest' | 'issue input' | 'research input' | 'think input',
): WorkflowIntent {
  const intent = requireBoundInput(runId, workflow, inputFile, inputName);
  clearIntent(runId);
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

/** Proves that Build startup uses only its hook-bound request file. */
function requireBuildIntent(runId: string, inputFile: string): WorkflowIntent {
  return requireBoundInput(runId, 'build', inputFile, 'build input');
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

/** Consumes terminal model intent while preserving an exact retry after transport unavailability. */
async function consumeIntentAfter<T>(runId: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    clearIntent(runId);
    return result;
  } catch (error) {
    if (errorCode(error) !== 'model_unavailable') clearIntent(runId);
    throw error;
  }
}

/** Clears the task-scoped intent and any external-write authority derived from it. */
function clearIntent(runId: string): void {
  for (const file of [intentPath(runId), issueApprovalPath(runId), buildShipApprovalPath(runId)]) {
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
  consumeIntentAfter,
  consumeIssueApproval,
  loadIntent,
  parseBuildIssueNumber,
  parseExplicitInvocation,
  requireBuildShipApproval,
  requireBuildIntent,
  requireIntent,
  requireIssueIntent,
  requireResearchIntent,
  requireThinkIntent,
  stopPendingIntent,
};
export type { WorkflowIntent };
