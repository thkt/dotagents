/** @file Outcome: Workflow execution starts only from an explicit task- and repository-bound invocation. */

import * as fs from 'node:fs';
import path from 'node:path';

import { assertNoCleanup, ownCleanup } from '../cleanup/state.ts';
import type { Workflow } from '../execution/contracts.ts';
import { errorCode, errorMessage } from '../shared/errors.ts';
import { gitRoot } from '../shared/repository.ts';
import { atomicWrite, intentPath, statePath, workflowInputPath } from './storage.ts';
import { acquireWorkflowOwnership } from './ownership.ts';
import { CHILD_PREFIX } from './stage-return.ts';
import { loadThinkState } from '../think/state.ts';
import { loadResearchState } from '../research/state.ts';
import { loadIssueState } from '../issue/state.ts';

const INTENT_PROTOCOL = 'codex-workflow-intent' as const;
type WorkflowInvocation = Workflow | 'issue' | 'research' | 'think' | 'cleanup';
type Authorization = 'publish-one-github-issue' | 'push-and-create-one-draft-pr' | null;

interface StoredWorkflowIntent {
  protocol: typeof INTENT_PROTOCOL;
  run_id: string;
  workflow: WorkflowInvocation;
  repo: string;
  authorization: Authorization;
  cleanup?: CleanupInvocation;
}

interface WorkflowIntent extends StoredWorkflowIntent {
  input_path: string;
}

interface ArmIntentOptions {
  runId: string;
  workflow: WorkflowInvocation;
  cwd: string;
  cleanup?: CleanupInvocation;
}

type WorkflowInputName =
  | 'build input'
  | 'code input'
  | 'issue input'
  | 'research input'
  | 'think input'
  | 'cleanup input';

function hasRunningFlow(runId: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(runId), 'utf8')) as {
      status?: unknown;
      handoff?: { proposal?: unknown } | null;
    };
    if (typeof value.status !== 'string') throw new Error('workflow state has an invalid status');
    return (
      value.status === 'running' ||
      Boolean(value.status === 'blocked' && value.handoff && !value.handoff.proposal)
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new Error(`workflow state is unreadable: ${errorMessage(error)}`);
  }
}

/** Recognizes only a leading explicit skill invocation, never an incidental mention. */
function parseExplicitInvocation(prompt: string | undefined): WorkflowInvocation | null {
  const value = prompt ?? '';
  const raw = /^\s*\$(build|code|issue|research|think|cleanup)(?=\s|$)/u.exec(value);
  if (raw) return raw[1] as WorkflowInvocation;

  const linked = /^\s*\[\$(build|code|issue|research|think|cleanup)\]\([^)\r\n]+\)(?=\s|$)/u.exec(
    value,
  );
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
    input_path: workflowInputPath(intent.run_id, intent.workflow),
  };
}

function authorizationFor(workflow: WorkflowInvocation): Authorization {
  if (workflow === 'issue') return 'publish-one-github-issue';
  if (workflow === 'build') return 'push-and-create-one-draft-pr';
  return null;
}

function requireAuthorization(runId: string, repo: string, workflow: 'issue' | 'build'): void {
  const intent = loadIntent(runId);
  if (
    !intent ||
    intent.repo !== repo ||
    intent.workflow !== workflow ||
    intent.authorization !== authorizationFor(workflow)
  ) {
    throw new Error(`explicit $${workflow} authorization is required for this task and repository`);
  }
}

/** Binds one explicit invocation to its task, workflow, repository, and private paths. */
function armIntent({ runId, workflow, cwd, cleanup }: ArmIntentOptions): WorkflowIntent {
  if (runId.startsWith(CHILD_PREFIX))
    throw new Error('child invocations require the parent runner');
  using _ownership = acquireWorkflowOwnership(runId);
  const issue = loadIssueState(runId);
  if (issue && issue.phase !== 'completed' && issue.phase !== 'blocked')
    throw new Error(
      'Issue is active or publication is unresolved; resume it and reconcile publication before a new intent',
    );
  const think = loadThinkState(runId);
  if (think && think.phase !== 'completed' && think.phase !== 'blocked')
    throw new Error('Think is active for this task; resume it with the original input');
  const research = loadResearchState(runId);
  if (research && research.phase !== 'completed' && research.phase !== 'blocked')
    throw new Error('Research is active for this task; resume it with the original input');
  if (hasRunningFlow(runId)) throw new Error('a workflow is already active for this task');
  const repo = gitRoot(cwd, 'explicit workflow invocation requires a Git worktree');
  using _repository =
    workflow === 'cleanup' || workflow === 'build' || workflow === 'code' ? ownCleanup(repo) : null;
  assertNoCleanup(repo);
  if ((workflow === 'cleanup') !== (cleanup !== undefined))
    throw new Error('cleanup invocation must bind its exact command');
  if (cleanup) cleanup = parseCleanupInput(cleanup);
  const stored: StoredWorkflowIntent = {
    protocol: INTENT_PROTOCOL,
    run_id: runId,
    workflow,
    repo,
    authorization: authorizationFor(workflow),
    ...(cleanup ? { cleanup } : {}),
  };
  const intent = hydrateIntent(stored);
  fs.mkdirSync(path.dirname(intent.input_path), { recursive: true, mode: 0o700 });
  atomicWrite(intentPath(runId), stored);
  return intent;
}

/** Validates the task- and repository-bound authority before Ship enters controller state. */
function requireBuildShipApproval(runId: string, repo: string): void {
  requireAuthorization(runId, repo, 'build');
}

/** Atomically consumes the task- and repository-bound approval before the GitHub write starts. */
function consumeIssueApproval(runId: string, repo: string): void {
  requireAuthorization(runId, repo, 'issue');
  fs.unlinkSync(intentPath(runId));
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
  const fields = [
    'protocol',
    'run_id',
    'workflow',
    'repo',
    'authorization',
    ...(record.workflow === 'cleanup' ? ['cleanup'] : []),
  ];
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field)) ||
    record.protocol !== INTENT_PROTOCOL ||
    record.run_id !== runId ||
    (record.workflow !== 'build' &&
      record.workflow !== 'code' &&
      record.workflow !== 'issue' &&
      record.workflow !== 'research' &&
      record.workflow !== 'think' &&
      record.workflow !== 'cleanup') ||
    record.authorization !== authorizationFor(record.workflow as WorkflowInvocation) ||
    typeof record.repo !== 'string' ||
    !path.isAbsolute(record.repo)
  )
    throw new Error('workflow intent has an invalid shape');
  return hydrateIntent({
    protocol: record.protocol,
    run_id: record.run_id,
    workflow: record.workflow,
    repo: record.repo,
    authorization: record.authorization as Authorization,
    ...(record.workflow === 'cleanup' ? { cleanup: parseCleanupInput(record.cleanup) } : {}),
  });
}

function requireBoundIntent(
  runId: string,
  workflow: WorkflowInvocation,
  repo: string,
  inputFile: string,
  inputName: WorkflowInputName,
): WorkflowIntent {
  const intent = requireBoundInput(runId, workflow, inputFile, inputName);
  if (intent.repo !== repo) throw new Error('workflow intent belongs to a different Git worktree');
  return intent;
}

function requireBoundInput(
  runId: string,
  workflow: WorkflowInvocation,
  inputFile: string,
  inputName: WorkflowInputName,
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
  inputName: WorkflowInputName,
): WorkflowIntent {
  using _ownership = acquireWorkflowOwnership(runId);
  const intent = requireBoundInput(runId, workflow, inputFile, inputName);
  clearIntent(runId);
  return intent;
}

/** Proves that startup matches the exact intent armed by the hook. */
function requireIntent(
  runId: string,
  workflow: Workflow,
  repo: string,
  inputFile: string,
): WorkflowIntent {
  return requireBoundIntent(runId, workflow, repo, inputFile, 'code input');
}

/** Proves that one implementation CLI uses the input armed for its exact workflow. */
function requireWorkflowInput(
  runId: string,
  workflow: Workflow,
  inputFile: string,
): WorkflowIntent {
  return requireBoundInput(runId, workflow, inputFile, `${workflow} input`);
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

/** Clears the task-scoped intent and any external-write authority derived from it. */
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
  consumeIssueApproval,
  loadIntent,
  parseBuildIssueNumber,
  parseExplicitInvocation,
  requireBuildShipApproval,
  requireIntent,
  requireIssueIntent,
  requireResearchIntent,
  requireThinkIntent,
  requireWorkflowInput,
  stopPendingIntent,
};
export type { WorkflowIntent };

export type CleanupInvocation =
  | { command: 'prepare'; issue: number }
  | { command: 'run'; prepared_digest: string };
function parseCleanupInput(value: unknown): CleanupInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid cleanup invocation');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2) throw new Error('invalid cleanup invocation');
  if (v.command === 'prepare' && Number.isSafeInteger(v.issue) && Number(v.issue) > 0)
    return { command: 'prepare', issue: Number(v.issue) };
  if (
    v.command === 'run' &&
    typeof v.prepared_digest === 'string' &&
    /^[0-9a-f]{64}$/u.test(v.prepared_digest)
  )
    return { command: 'run', prepared_digest: v.prepared_digest };
  throw new Error('invalid cleanup invocation');
}
export function parseCleanupInvocation(prompt: string | undefined): CleanupInvocation {
  const args = (prompt ?? '')
    .replace(/^\s*(?:\$cleanup|\[\$cleanup\]\([^)\r\n]+\))\s*/u, '')
    .trim();
  if (/^#?[1-9]\d*$/u.test(args))
    return parseCleanupInput({ command: 'prepare', issue: Number(args.replace(/^#/u, '')) });
  const approved = /^approve ([0-9a-f]{64})$/u.exec(args);
  if (approved) return { command: 'run', prepared_digest: approved[1]! };
  throw new Error('use $cleanup <issue> or $cleanup approve <prepared digest>');
}
export function requireCleanupIntent(
  runId: string,
  repo: string,
  inputFile: string,
): WorkflowIntent {
  return requireBoundIntent(runId, 'cleanup', repo, inputFile, 'cleanup input');
}
