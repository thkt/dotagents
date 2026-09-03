/** @file Outcome: An armed manifest advances only through declared transitions to a verified terminal state. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DESCRIPTION_PROTOCOL,
  MANIFEST_PROTOCOL,
  RESULT_PROTOCOL,
  STATE_PROTOCOL,
  type ActorStep,
  type ActorVerification,
  type BuildReviewInput,
  type BuildPlanUnit,
  type CorrectionContext,
  type FlowDirective,
  type SolidifyContext,
  type FlowDescription,
  type FlowManifest,
  type FlowState,
  type FlowStatus,
  type FlowStep,
  type GateReport,
  type GateStep,
  type PublicState,
  type RuntimeFailure,
  type ShellGateSpec,
  type Workflow,
  type WorkflowEscalation,
} from './contracts.ts';
import { DEFAULT_TIMEOUT_MS, parseArgs as parseGateArgs } from './shell-verification.ts';
import {
  clearIntent,
  loadIntent,
  requireBuildShipApproval,
  requireIntent,
  requireWorkflowInput,
} from '../invocation.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { implementationCommand } from '../shared/environment.ts';
import { readAbsoluteJson } from '../shared/runtime.ts';
import { atomicWrite, statePath, workflowInputPath } from '../shared/storage.ts';
import {
  gitText,
  gitOptionalText,
  gitOutput,
  nulPaths,
  repositoryControlChanges,
  repositoryInvariant,
  repoSnapshot,
  sameRepositoryInvariant,
  snapshotChanges,
} from '../shared/repository.ts';
import { shellCommand } from '../shared/command.ts';
import { isGitHubAccessFailureMessage } from '../shared/github.ts';
import { DEFAULT_MAX_CORRECTIONS, IMPLEMENTATION_ACTOR_ID } from './manifest-validation.ts';
import { isObject } from '../shared/schema.ts';
import { runIsolatedShellVerification } from './repository-isolation.ts';
import {
  actionAlreadyCompleted,
  actionDirective,
  prepareShipInput,
  validateActionCompletion,
} from '../build/git-actions.ts';
import { actorScreenshotAttachments, sealScreenshotAttachments } from '../build/screenshots.ts';
import { buildReviewGateReport, runStructuredBuildGate } from '../build/verification.ts';
import { compileBuildManifest } from '../build/manifest.ts';
import { describeBuildRunInput, parseBuildRunInput } from '../build/input.ts';
import { compileCodeManifest, describeCodeInput, parseCodeInput } from '../code/manifest.ts';
import { parseBuildReviewResult } from './agent.ts';

/** Loads the task-bound state and rejects stale or malformed records. */
function loadWorkflowState(runId: string): { file: string; state: FlowState } {
  const file = statePath(runId);
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as FlowState;
    if (state.protocol !== STATE_PROTOCOL) {
      if (/^codex-flow-state\/v\d+$/u.test(String(state.protocol))) {
        throw new FlowError(
          'workflow state uses an obsolete contract; start a new workflow from current inputs',
          'state_error',
        );
      }
      throw new FlowError('workflow state has an invalid protocol', 'state_error');
    }
    if (state.run_id !== runId) {
      throw new FlowError('workflow state has an invalid run id', 'state_error');
    }
    return { file, state };
  } catch (error) {
    if (errorCode(error) === 'ENOENT')
      throw new FlowError('no workflow is active for this task', 'no_flow');
    if (error instanceof FlowError) throw error;
    throw new FlowError(`workflow state is unreadable: ${errorMessage(error)}`, 'state_error');
  }
}

function inputHash(inputFile: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(inputFile)).digest('hex');
}

/** Seeds only the public Plan load; the complete manifest is validated after that Plan is known. */
function initialBuildManifest(
  repo: string,
  inputFile: string,
  issue: number,
  ship: boolean,
): FlowManifest {
  const startPoint = gitText(repo, ['rev-parse', 'HEAD'], 'build start point');
  return {
    protocol: MANIFEST_PROTOCOL,
    workflow: 'build',
    repo,
    max_corrections: DEFAULT_MAX_CORRECTIONS,
    shipping_authorized: ship,
    steps: [
      {
        id: 'load:plan',
        kind: 'gate',
        gate: {
          authority: 'build-plan',
          command: shellCommand('codex-build-plan', ['--input', inputFile]),
          input: inputFile,
          failure_route: 'blocked',
        },
      },
      {
        id: 'branch',
        kind: 'action',
        action: 'branch',
        branch_name: `codex/issue-${issue}`,
        start_point: startPoint,
      },
    ],
  };
}

function defaultBaseBranch(repo: string): string {
  const remoteHead = gitOptionalText(repo, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (!remoteHead?.startsWith('origin/') || remoteHead.length === 'origin/'.length) {
    throw new FlowError(
      'Build requires origin/HEAD to name the default base branch',
      'state_error',
    );
  }
  return remoteHead.slice('origin/'.length);
}

function startManifest(runId: string, inputFile: string): FlowManifest {
  const raw = readAbsoluteJson(inputFile, '--input');
  if (isObject(raw) && raw.issue_number !== undefined) {
    const intent = requireWorkflowInput(runId, 'build', inputFile);
    const request = parseBuildRunInput(raw);
    if (request.repo !== intent.repo) {
      throw new FlowError('build input belongs to a different Git worktree');
    }
    return initialBuildManifest(intent.repo, inputFile, request.issue_number, request.ship);
  }
  if (isObject(raw) && raw.request !== undefined) {
    const request = parseCodeInput(raw);
    requireIntent(runId, 'code', request.repo, inputFile);
    return compileCodeManifest(request);
  }
  throw new FlowError('workflow input must be a Build Issue selector or Code request');
}

function terminalStatus(state: FlowState): FlowStatus {
  if (state.cursor < state.manifest.steps.length) return 'running';
  return 'completed';
}

function publicState(state: FlowState): PublicState {
  const current = state.status === 'running' ? (state.manifest.steps[state.cursor] ?? null) : null;
  return {
    protocol: RESULT_PROTOCOL,
    verdict: state.status === 'blocked' || state.status === 'cancelled' ? 'blocked' : 'pass',
    workflow: state.workflow,
    status: state.status,
    current_step: current,
    cursor: state.cursor,
    total_steps: state.manifest.steps.length,
    correction_counts: state.correction_counts,
    last_gate: state.gate_reports.at(-1) ?? null,
    gate_reports: state.gate_reports,
    escalation: state.escalation,
    runtime_failure: state.runtime_failure ?? null,
    ship_authorization_revoked: state.ship_authorization_revoked,
  };
}

/** Identifies an action-free Build stop that can retry the same GitHub read. */
function isRetryableGitHubAccessBlock(state: FlowState): boolean {
  const lastGate = state.gate_reports.at(-1);
  const structured = lastGate?.evidence.kind === 'structured' ? lastGate.evidence.report : null;
  const legacyNetworkFailure =
    (lastGate?.classification === 'issue_contract_invalid' ||
      lastGate?.classification === 'github_issue_read_failed') &&
    typeof structured?.error === 'string' &&
    isGitHubAccessFailureMessage(structured.error);
  return (
    state.workflow === 'build' &&
    state.status === 'blocked' &&
    state.cursor === 0 &&
    state.build_plan === null &&
    state.manifest.steps[0]?.id === 'load:plan' &&
    lastGate?.gate_id === 'load:plan' &&
    ((lastGate.classification === 'github_issue_read_failed' && structured?.retryable === true) ||
      legacyNetworkFailure)
  );
}

/** Identifies an in-process failure whose exact controller step may be retried. */
function isRetryableRuntimeFailure(state: FlowState): boolean {
  const failure = state.runtime_failure;
  return (
    state.status === 'blocked' &&
    failure?.retryable === true &&
    failure.classification === 'model_unavailable'
  );
}

function save(file: string, state: FlowState): PublicState {
  atomicWrite(file, state);
  return publicState(state);
}

/** Starts an armed workflow after capturing its immutable repository baseline. */
function startWorkflow(runId: string, inputFile: string): PublicState {
  const manifest = startManifest(runId, inputFile);
  const file = statePath(runId);
  if (fs.existsSync(file)) {
    const existing = loadWorkflowState(runId).state;
    if (existing.status === 'running')
      throw new FlowError('a workflow is already active for this task', 'state_error');
  }
  if (manifest.workflow === 'build' && manifest.shipping_authorized) {
    requireBuildShipApproval(runId, manifest.repo);
  }
  const workflowBaseline = repoSnapshot(manifest.repo);
  if (manifest.workflow === 'build') {
    const staged = nulPaths(
      gitOutput(manifest.repo, ['diff', '--cached', '--name-only', '-z'], 'staged baseline scan'),
    );
    if (staged.length) {
      throw new FlowError(
        `build requires a clean index; staged baseline paths: ${staged.join(', ')}`,
      );
    }
    const actorFiles = new Set(
      manifest.steps
        .filter((step): step is ActorStep => step.kind === 'actor')
        .flatMap((step) => step.files),
    );
    const dirtyTargets = Object.keys(workflowBaseline).filter((file) => actorFiles.has(file));
    if (dirtyTargets.length) {
      throw new FlowError(
        `build requires clean actor files; pre-existing changes: ${dirtyTargets.join(', ')}`,
      );
    }
  }
  const state: FlowState = {
    protocol: STATE_PROTOCOL,
    run_id: runId,
    workflow: manifest.workflow,
    manifest,
    input_sha256: inputHash(inputFile),
    cursor: 0,
    status: 'running',
    correction_counts: {},
    gate_reports: [],
    build_plan: null,
    screenshots: [],
    workflow_baseline: workflowBaseline,
    actor_baseline: null,
    action_baseline: null,
    escalation: null,
    runtime_failure: null,
    ship_authorization_revoked: false,
  };
  prepareCurrentStep(state);
  const result = save(file, state);
  clearIntent(runId);
  return result;
}

function requireOriginalInput(state: FlowState, inputFile: string): void {
  if (path.resolve(inputFile) !== workflowInputPath(state.run_id)) {
    throw new FlowError('resume requires the hook-supplied input path', 'state_error');
  }
  if (inputHash(inputFile) !== state.input_sha256) {
    throw new FlowError('resume requires the original workflow input', 'state_error');
  }
}

export function escalateWorkflow(
  runId: string,
  stepId: string,
  escalationData: Omit<WorkflowEscalation, 'step_id'>,
): PublicState {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['actor']);
  state.status = 'blocked';
  state.actor_baseline = null;
  state.action_baseline = null;
  state.escalation = { step_id: step.id, ...escalationData };
  state.runtime_failure = null;
  return save(file, state);
}

/** Converts an exception raised inside the running controller into an explicit stop state. */
export function blockWorkflowOnRuntimeFailure(
  runId: string,
  stepId: string | null,
  stage: string,
  error: unknown,
): PublicState {
  const { file, state } = loadWorkflowState(runId);
  requireRunning(state);
  const current = state.manifest.steps[state.cursor];
  const classification = errorCode(error) || 'execution_error';
  const retryable =
    classification === 'model_unavailable' &&
    (stage === 'actor_model_call' || stage === 'build_semantic_review');
  state.status = 'blocked';
  state.actor_baseline = null;
  state.action_baseline = null;
  state.escalation = null;
  state.runtime_failure = {
    step_id: stepId ?? current?.id ?? 'controller',
    stage,
    classification,
    error: errorMessage(error),
    retryable,
  } satisfies RuntimeFailure;
  return save(file, state);
}

/** Resumes the active workflow, or starts it when no state exists. */
function startOrResumeWorkflow(runId: string, inputFile: string): PublicState {
  try {
    const loaded = loadWorkflowState(runId);
    const existing = loaded.state;
    if (isRetryableGitHubAccessBlock(existing)) {
      requireOriginalInput(existing, inputFile);
      const branch = existing.manifest.steps.find(
        (step) => step.kind === 'action' && step.action === 'branch',
      );
      if (!branch || repositoryInvariant(existing.manifest.repo).head !== branch.start_point) {
        throw new FlowError('repository HEAD changed after the blocked GitHub read', 'state_error');
      }
      existing.status = 'running';
      return save(loaded.file, existing);
    }
    if (isRetryableRuntimeFailure(existing)) {
      requireOriginalInput(existing, inputFile);
      existing.status = 'running';
      existing.runtime_failure = null;
      prepareCurrentStep(existing);
      return save(loaded.file, existing);
    }
    if (existing.status !== 'running') {
      if (
        (existing.escalation !== null || existing.runtime_failure != null) &&
        !loadIntent(runId)
      ) {
        if (path.resolve(inputFile) !== workflowInputPath(runId)) {
          throw new FlowError('resume requires the hook-supplied input path', 'state_error');
        }
        return publicState(existing);
      }
      return startWorkflow(runId, inputFile);
    }
    requireOriginalInput(existing, inputFile);
    return publicState(existing);
  } catch (error) {
    if (errorCode(error) === 'no_flow') return startWorkflow(runId, inputFile);
    throw error;
  }
}

/** Cancels only the exact active controller bound to this task and hook-supplied input. */
function cancelWorkflow(runId: string, inputFile: string): PublicState {
  const { file, state } = loadWorkflowState(runId);
  if (path.resolve(inputFile) !== workflowInputPath(runId)) {
    throw new FlowError('cancel requires the hook-supplied input path', 'state_error');
  }
  if (state.status === 'cancelled') return publicState(state);
  if (
    state.status !== 'running' &&
    !isRetryableGitHubAccessBlock(state) &&
    state.runtime_failure == null &&
    state.escalation === null
  ) {
    throw new FlowError(
      `workflow is ${state.status}; only an active workflow can be cancelled`,
      'state_error',
    );
  }
  state.status = 'cancelled';
  state.actor_baseline = null;
  state.action_baseline = null;
  state.escalation = null;
  state.runtime_failure = null;
  state.ship_authorization_revoked = true;
  clearIntent(runId);
  return save(file, state);
}

function requireRunning(state: FlowState): void {
  if (state.status !== 'running') throw new FlowError(`workflow is ${state.status}`, 'state_error');
}

function requireStep<T extends FlowStep['kind']>(
  state: FlowState,
  stepId: string,
  kinds: readonly T[],
): Extract<FlowStep, { kind: T }> {
  requireRunning(state);
  const step = state.manifest.steps[state.cursor];
  if (!step) throw new FlowError('workflow has no current step', 'state_error');
  if (step.id !== stepId)
    throw new FlowError(`expected step ${step.id}, received ${stepId}`, 'order_error');
  if (!kinds.includes(step.kind as T)) {
    throw new FlowError(`${step.id} is ${step.kind}, not ${kinds.join('/')}`, 'order_error');
  }
  return step as Extract<FlowStep, { kind: T }>;
}

function advanceToNextStep(state: FlowState): void {
  state.cursor += 1;
  state.status = terminalStatus(state);
  prepareCurrentStep(state);
}

/** Captures the entry invariant needed to enforce the next step's postconditions. */
function prepareCurrentStep(state: FlowState): void {
  const current = state.manifest.steps[state.cursor];
  state.actor_baseline =
    current?.kind === 'actor' ? repositoryInvariant(state.manifest.repo) : null;
  state.action_baseline =
    current?.kind === 'action' ? repositoryInvariant(state.manifest.repo) : null;
  if (current?.kind === 'action' && current.action === 'ship') prepareShipInput(state);
}

function actorScopeChanges(
  state: FlowState,
  step: ActorStep,
): {
  outside: string[];
  controlChanges: string[];
} {
  if (!isObject(state.actor_baseline))
    throw new FlowError(`${step.id} has no entry snapshot`, 'state_error');
  const current = repositoryInvariant(state.manifest.repo);
  const changed = snapshotChanges(state.actor_baseline.changes, current.changes);
  const allowed = step.files;
  const protectedPaths = new Set(Object.keys(state.workflow_baseline));
  return {
    outside: changed.filter(
      (relative) =>
        protectedPaths.has(relative) ||
        !allowed.some(
          (scope) =>
            scope === '.' ||
            relative === scope ||
            relative.startsWith(`${scope.replace(/\/$/u, '')}/`),
        ),
    ),
    controlChanges: repositoryControlChanges(state.actor_baseline, current, {
      includeIgnored: false,
    }),
  };
}

function completeActorOrAction(runId: string, stepId: string): PublicState {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['actor', 'action']);
  if (step.kind === 'actor') {
    const scope = actorScopeChanges(state, step);
    if (scope.controlChanges.length) {
      throw new FlowError(
        `${step.id} changed repository control state: ${scope.controlChanges.join(', ')}`,
        'scope_error',
      );
    }
    if (scope.outside.length) {
      throw new FlowError(
        `${step.id} changed files outside its declared scope: ${scope.outside.join(', ')}`,
        'scope_error',
      );
    }
    sealScreenshotAttachments(state.run_id, actorScreenshotAttachments(state, step.id));
  }
  if (step.kind === 'action') validateActionCompletion(state, step);
  if (
    step.kind === 'action' &&
    step.action === 'ship' &&
    (!state.manifest.shipping_authorized || state.ship_authorization_revoked)
  ) {
    throw new FlowError('shipping is not authorized', 'authorization_error');
  }
  advanceToNextStep(state);
  return save(file, state);
}

/** Advances an action whose externally observable postcondition survived an interrupted run. */
function reconcileCurrentAction(runId: string, stepId: string): boolean {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['action']);
  if (
    step.action === 'ship' &&
    (!state.manifest.shipping_authorized || state.ship_authorization_revoked)
  ) {
    throw new FlowError('shipping is not authorized', 'authorization_error');
  }
  if (!actionAlreadyCompleted(state, step)) return false;
  advanceToNextStep(state);
  save(file, state);
  return true;
}

function gateArgs(stepId: string, gate: ShellGateSpec, repo: string): string[] {
  const argv = [
    '--gate-id',
    stepId,
    '--failure-route',
    gate.failure_route,
    '--cwd',
    repo,
    '--expect',
    gate.expect,
    '--command',
    gate.command,
  ];
  if (gate.timeout_ms !== undefined) argv.push('--timeout-ms', String(gate.timeout_ms));
  return argv;
}

function correctionActorId(route: string | null): string | null {
  return route === 'direct:implementation' ? IMPLEMENTATION_ACTOR_ID : null;
}

function correctionOwner(state: FlowState, route: string | null): string | null {
  const actorId = correctionActorId(route);
  if (!actorId) return null;
  const ownerIndex = state.manifest.steps.findIndex(
    (candidate) => candidate.kind === 'actor' && candidate.id === actorId,
  );
  return ownerIndex >= 0 && ownerIndex < state.cursor ? actorId : null;
}

function correctionContext(state: FlowState, actorId: string): CorrectionContext | null {
  const gate = state.gate_reports.at(-1);
  if (!gate || gate.verdict !== 'fail' || correctionActorId(gate.failure_route) !== actorId)
    return null;
  const attempt = state.correction_counts[gate.gate_id];
  if (!attempt || attempt > state.manifest.max_corrections) return null;
  return { attempt, max_attempts: state.manifest.max_corrections, gate };
}

/** Records one Gate report and applies its sole legal advance, correction, or stop transition. */
function applyGateOutcome(
  state: FlowState,
  step: Extract<FlowStep, { kind: 'gate' }>,
  report: GateReport,
  advanceOnPass: boolean,
): void {
  state.gate_reports.push(report);
  if (report.verdict === 'pass') {
    if (
      state.workflow === 'build' &&
      step.id === 'test' &&
      step.owner === IMPLEMENTATION_ACTOR_ID &&
      (state.gate_reports.at(-2)?.gate_id !== 'test' ||
        state.gate_reports.at(-2)?.verdict !== 'pass')
    ) {
      state.cursor = state.manifest.steps.findIndex(
        (candidate) => candidate.kind === 'actor' && candidate.id === IMPLEMENTATION_ACTOR_ID,
      );
      prepareCurrentStep(state);
      return;
    }
    if (advanceOnPass) advanceToNextStep(state);
    return;
  }
  if (report.verdict === 'blocked') {
    state.status = 'blocked';
    return;
  }
  const owner = correctionOwner(state, report.failure_route);
  if (!owner) {
    state.status = 'blocked';
    state.actor_baseline = null;
    return;
  }
  const correction = (state.correction_counts[step.id] ?? 0) + 1;
  state.correction_counts[step.id] = correction;
  if (correction > state.manifest.max_corrections) {
    state.status = 'blocked';
    state.actor_baseline = null;
    return;
  }
  state.cursor = state.manifest.steps.findIndex((candidate) => candidate.id === owner);
  prepareCurrentStep(state);
}

function compileLoadedBuild(state: FlowState, step: Extract<FlowStep, { kind: 'gate' }>): void {
  if (step.gate.authority !== 'build-plan' || !state.build_plan || !('input' in step.gate)) return;
  const branch = state.manifest.steps.find(
    (candidate) => candidate.kind === 'action' && candidate.action === 'branch',
  );
  if (!branch || branch.action !== 'branch') {
    throw new FlowError('Build input has no branch seed', 'state_error');
  }
  const ship = state.manifest.shipping_authorized;
  const compiled = compileBuildManifest({
    repo: state.manifest.repo,
    input: step.gate.input,
    plan: state.build_plan,
    branchName: branch.branch_name,
    startPoint: branch.start_point,
    ...(ship ? { baseBranch: defaultBaseBranch(state.manifest.repo) } : {}),
    ship,
  });
  const actorFiles = new Set(
    compiled.steps
      .filter((candidate): candidate is ActorStep => candidate.kind === 'actor')
      .flatMap((candidate) => candidate.files),
  );
  const dirtyTargets = Object.keys(state.workflow_baseline).filter((file) =>
    [...actorFiles].some(
      (scope) =>
        scope === '.' || file === scope || file.startsWith(`${scope.replace(/\/$/u, '')}/`),
    ),
  );
  if (dirtyTargets.length) {
    throw new FlowError(
      `build requires clean actor files; pre-existing changes: ${dirtyTargets.join(', ')}`,
      'scope_error',
    );
  }
  state.manifest = compiled;
}

function compilationFailure(report: GateReport, error: unknown): GateReport {
  const classification = errorCode(error) || 'build_execution_invalid';
  const details = {
    verdict: 'blocked' as const,
    classification,
    reason_codes: [classification],
    failure_route: 'blocked' as const,
    error: errorMessage(error),
  };
  return {
    ...report,
    ...details,
    evidence: {
      kind: 'structured',
      report: {
        ...(report.evidence.kind === 'structured' ? report.evidence.report : {}),
        ...details,
      },
    },
  };
}

/** Runs the current gate and either advances, reroutes to its owner, or blocks. */
function runGate(runId: string, stepId: string): { result: PublicState; exitCode: number } {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['gate']);
  let report: GateReport;
  if (step.gate.authority === 'shell') {
    report = runIsolatedShellVerification(
      parseGateArgs(gateArgs(step.id, step.gate, state.manifest.repo)),
    ).report;
  } else {
    const before = repositoryInvariant(state.manifest.repo);
    report = runStructuredBuildGate(state, step);
    if (report.verdict === 'pass' && step.gate.authority === 'build-plan') {
      try {
        compileLoadedBuild(state, step);
      } catch (error) {
        state.build_plan = null;
        report = compilationFailure(report, error);
      }
    }
    const after = repositoryInvariant(state.manifest.repo);
    if (!sameRepositoryInvariant(before, after)) {
      report = {
        ...report,
        verdict: 'blocked',
        classification: 'gate_mutated_repository',
        reason_codes: ['gate_mutated_repository', ...report.reason_codes],
        failure_route: 'blocked',
      };
    }
  }
  applyGateOutcome(state, step, report, true);
  const result = save(file, state);
  result.gate = report;
  return { result, exitCode: report.verdict === 'pass' ? 0 : state.status === 'blocked' ? 2 : 1 };
}

function workflowStatus(runId: string): PublicState {
  return publicState(loadWorkflowState(runId).state);
}

function actorVerification(state: FlowState, step: ActorStep): ActorVerification {
  if (state.workflow === 'build' && step.id === IMPLEMENTATION_ACTOR_ID) {
    return { command: requireBuildPlan(state).testCommand, expect: 'pass' };
  }
  const gate = state.manifest.steps.find(
    (candidate): candidate is GateStep =>
      candidate.kind === 'gate' && candidate.id === 'test' && candidate.gate.authority === 'shell',
  );
  if (!gate) throw new FlowError(`${step.id} has no shared test gate`, 'state_error');
  if (gate.gate.authority !== 'shell') {
    throw new FlowError(`${step.id} verification must use shell authority`, 'state_error');
  }
  return {
    command: gate.gate.command,
    expect: gate.gate.expect,
  };
}

function buildReviewInput(state: FlowState): BuildReviewInput {
  if (!state.build_plan) {
    throw new FlowError('review:build has no validated Plan context', 'state_error');
  }
  const branch = state.manifest.steps.find(
    (step) => step.kind === 'action' && step.action === 'branch',
  );
  if (!branch || branch.action !== 'branch') {
    throw new FlowError('review:build has no branch context', 'state_error');
  }
  return {
    issue: state.build_plan.issue,
    base_ref: branch.start_point,
    plan: state.build_plan,
    verification: state.gate_reports.map((report) => ({
      gate_id: report.gate_id,
      verdict: report.verdict,
      classification: report.classification,
    })),
  };
}

function requireBuildPlan(state: FlowState): {
  goal: string;
  contract: string;
  tests: Array<{ id: string; name: string }>;
  testCommand: string;
  outcome: string;
  units: BuildPlanUnit[];
  files: string[];
} {
  if (!state.build_plan) {
    throw new FlowError('implementation actor has no validated Plan context', 'state_error');
  }
  return {
    goal: state.build_plan.outcome,
    contract: state.build_plan.units
      .map((unit) => `${unit.id}: ${unit.goal}\n${unit.contract}`)
      .join('\n\n'),
    tests: state.build_plan.units.flatMap((unit) => unit.tests),
    testCommand: state.build_plan.test_command,
    outcome: state.build_plan.outcome,
    units: state.build_plan.units,
    files: [...new Set(state.build_plan.units.flatMap((unit) => unit.files))],
  };
}

function solidifyContext(state: FlowState, step: ActorStep): SolidifyContext | null {
  if (state.workflow !== 'build' || step.id !== IMPLEMENTATION_ACTOR_ID) return null;
  const last = state.gate_reports.at(-1);
  if (!last || last.gate_id !== 'test' || last.verdict !== 'pass') return null;
  const plan = requireBuildPlan(state);
  return { outcome: plan.outcome, units: plan.units, files: plan.files };
}

/** Derives the sole permitted next operation from persisted controller state. */
function directiveForState(state: FlowState): FlowDirective {
  if (state.status === 'cancelled') {
    return { kind: 'cancelled' };
  }
  if (state.status === 'completed') {
    return { kind: 'done' };
  }
  if (state.status === 'blocked') {
    return { kind: 'blocked' };
  }
  const step = state.manifest.steps[state.cursor];
  if (!step) throw new FlowError('running workflow has no current step', 'state_error');
  if (step.kind === 'actor') {
    const planUnit =
      state.workflow === 'build' && step.id === IMPLEMENTATION_ACTOR_ID
        ? requireBuildPlan(state)
        : null;
    return {
      kind: 'run-actor',
      step_id: step.id,
      outcome: planUnit?.goal ?? step.outcome,
      contract: planUnit?.contract ?? null,
      tests: planUnit?.tests ?? [],
      files: step.files,
      verification: actorVerification(state, step),
      screenshots: actorScreenshotAttachments(state, step.id),
      correction: correctionContext(state, step.id),
      solidify: solidifyContext(state, step),
    };
  }
  if (step.kind === 'action') {
    return actionDirective(state, step);
  }
  if (step.gate.authority === 'build-review') {
    return {
      kind: 'run-review',
      step_id: 'review:build',
      input: buildReviewInput(state),
    };
  }
  return {
    kind: 'run-gate',
    step_id: step.id,
  };
}

/** Records the independent SDK review only for the current typed review gate. */
function completeBuildReview(
  runId: string,
  stepId: string,
  rawResult: unknown,
  durationMs: number,
): { result: PublicState; exitCode: number } {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['gate']);
  if (step.id !== 'review:build' || step.gate.authority !== 'build-review') {
    throw new FlowError(`${step.id} is not the semantic build review`, 'order_error');
  }
  const review = parseBuildReviewResult(rawResult);
  const report = buildReviewGateReport(step, state.manifest.repo, review, durationMs);
  applyGateOutcome(state, step, report, true);
  const result = save(file, state);
  result.gate = report;
  return { result, exitCode: report.verdict === 'pass' ? 0 : 2 };
}

function currentDirective(runId: string): FlowDirective {
  return directiveForState(loadWorkflowState(runId).state);
}

/** Completes the current directive without accepting a caller-supplied transition name. */
function completeCurrentDirective(
  runId: string,
  stepId: string,
): { result: PublicState; exitCode: number } {
  const directive = currentDirective(runId);
  if (!('step_id' in directive))
    throw new FlowError(`cannot complete ${directive.kind}`, 'order_error');
  if (directive.step_id !== stepId) {
    throw new FlowError(
      `expected completion for ${directive.step_id}, received ${stepId}`,
      'order_error',
    );
  }
  switch (directive.kind) {
    case 'run-actor':
    case 'run-action':
      return { result: completeActorOrAction(runId, stepId), exitCode: 0 };
    case 'run-review':
      throw new FlowError('run-review requires a structured SDK result', 'order_error');
    case 'run-gate':
      return runGate(runId, stepId);
  }
}

function describe(workflow: Workflow): FlowDescription {
  const executable = implementationCommand(workflow);
  const cli = {
    describe: `${executable} describe`,
    run: `${executable} run --input <absolute-json>`,
    cancel: `${executable} cancel --input <hook-supplied-json>`,
    task_binding: 'hook-injected' as const,
  };
  if (workflow === 'build') {
    return {
      protocol: DESCRIPTION_PROTOCOL,
      workflow,
      cli,
      defaults: { gate_timeout_ms: DEFAULT_TIMEOUT_MS },
      input_template: describeBuildRunInput(),
      execution: {
        source_of_truth: 'public-issue-plan',
        compiled: true,
        persisted: true,
      },
      cli_contracts: {
        reports: [
          { protocol: RESULT_PROTOCOL, command: `${executable} run --input <absolute-json>` },
        ],
      },
    };
  }
  return {
    protocol: DESCRIPTION_PROTOCOL,
    workflow,
    cli,
    defaults: {
      gate_timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    input_template: describeCodeInput(),
    execution: { source_of_truth: 'direct-request', compiled: true, persisted: true },
    cli_contracts: {
      reports: [
        { protocol: RESULT_PROTOCOL, command: `${executable} run --input <absolute-json>` },
      ],
    },
  };
}

export {
  completeCurrentDirective,
  completeBuildReview,
  cancelWorkflow,
  currentDirective,
  describe,
  loadWorkflowState,
  reconcileCurrentAction,
  startOrResumeWorkflow,
  isRetryableGitHubAccessBlock,
  isRetryableRuntimeFailure,
  workflowStatus,
};
