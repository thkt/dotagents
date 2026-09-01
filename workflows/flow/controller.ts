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
  type BuildPlanUnit,
  type CorrectionContext,
  type FlowDirective,
  type FlowDescription,
  type FlowManifest,
  type FlowState,
  type FlowStatus,
  type FlowStep,
  type GateOptions,
  type GateReport,
  type PublicState,
  type ShellGateSpec,
  type StepDescription,
  type Workflow,
  type WorkflowEscalation,
} from './contracts.ts';
import {
  DEFAULT_TAIL_BYTES,
  DEFAULT_TIMEOUT_MS,
  parseArgs as parseGateArgs,
} from './shell-gate.ts';
import { clearIntent, loadIntent, requireBuildShipApproval, requireIntent } from '../invocation.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { atomicWrite, statePath, workflowInputPath } from '../shared/storage.ts';
import {
  gitOutput,
  nulPaths,
  repositoryControlChanges,
  repositoryInvariant,
  repoSnapshot,
  sameRepositoryInvariant,
  snapshotChanges,
} from '../shared/repository.ts';
import {
  ACTIONS,
  BUILD_OPENING_IDS,
  CLEANUP_ACTOR,
  DEFAULT_MAX_CORRECTIONS,
  UNIT_ACTOR,
  unitStepIds,
  validateManifest,
} from './manifest.ts';
import { isObject } from '../shared/schema.ts';
import { runIsolatedShellVerification } from './isolation.ts';
import { actionDirective, prepareShipInput, validateActionCompletion } from './build/actions.ts';
import { describeBuildSourceInput, runStructuredBuildGate } from './build/gates.ts';

function readJson(file: string, label: string): unknown {
  if (!path.isAbsolute(file)) throw new FlowError(`${label} must be absolute`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new FlowError(`${label} is not readable JSON: ${errorMessage(error)}`);
  }
}

/** Loads the task-bound state and rejects stale or malformed records. */
function loadWorkflowState(runId: string): { file: string; state: FlowState } {
  const file = statePath(runId);
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as FlowState;
    if (state.protocol !== STATE_PROTOCOL || state.run_id !== runId) {
      throw new FlowError('workflow state has an invalid protocol or run id', 'state_error');
    }
    return { file, state };
  } catch (error) {
    if (errorCode(error) === 'ENOENT')
      throw new FlowError('no workflow is active for this task', 'no_flow');
    if (error instanceof FlowError) throw error;
    throw new FlowError(`workflow state is unreadable: ${errorMessage(error)}`, 'state_error');
  }
}

function manifestHash(manifest: FlowManifest): string {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function terminalStatus(state: FlowState): FlowStatus {
  if (state.cursor < state.manifest.steps.length) return 'running';
  if (state.workflow === 'build' && !state.manifest.shipping_authorized) return 'ship-ready';
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
    manifest_hash: state.manifest_hash,
    correction_counts: state.correction_counts,
    sealed_gates: state.sealed_gates,
    last_gate: state.gate_reports.at(-1) ?? null,
    gate_reports: state.gate_reports,
    escalation: state.escalation,
    ship_authorization_revoked: state.ship_authorization_revoked,
  };
}

function save(file: string, state: FlowState): PublicState {
  atomicWrite(file, state);
  return publicState(state);
}

/** Starts an armed workflow after capturing its immutable repository baseline. */
function startWorkflow(runId: string, manifestFile: string): PublicState {
  const manifest = validateManifest(readJson(manifestFile, '--manifest'));
  const file = statePath(runId);
  if (fs.existsSync(file)) {
    const existing = loadWorkflowState(runId).state;
    if (existing.status === 'running')
      throw new FlowError('a workflow is already active for this task', 'state_error');
  }
  const intent = requireIntent(runId, manifest.workflow, manifest.repo, manifestFile);
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
    if (!intent.build_source_path) {
      throw new FlowError('build workflow has no hook-supplied source path');
    }
    const mismatched = manifest.steps.filter(
      (step) =>
        step.kind === 'gate' &&
        (step.gate.authority === 'build-plan' ||
          step.gate.authority === 'build-revalidate' ||
          step.gate.authority === 'build-artifacts') &&
        step.gate.input !== intent.build_source_path,
    );
    if (mismatched.length) {
      throw new FlowError(
        `build gates must use the hook-supplied source path: ${intent.build_source_path}`,
      );
    }
  }
  const state: FlowState = {
    protocol: STATE_PROTOCOL,
    run_id: runId,
    workflow: manifest.workflow,
    manifest,
    manifest_hash: manifestHash(manifest),
    cursor: 0,
    status: 'running',
    correction_counts: {},
    sealed_gates: {},
    calibrations: {},
    gate_reports: [],
    build_plan: null,
    workflow_baseline: workflowBaseline,
    actor_baseline: null,
    action_baseline: null,
    escalation: null,
    ship_authorization_revoked: false,
  };
  const result = save(file, state);
  clearIntent(runId);
  return result;
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
  return save(file, state);
}

/** Resumes the active workflow, or starts it when no state exists. */
function startOrResumeWorkflow(runId: string, manifestFile: string): PublicState {
  try {
    const existing = loadWorkflowState(runId).state;
    if (existing.status !== 'running') {
      if (existing.escalation !== null && !loadIntent(runId)) {
        if (path.resolve(manifestFile) !== workflowInputPath(runId)) {
          throw new FlowError('resume requires the hook-supplied manifest path', 'state_error');
        }
        return publicState(existing);
      }
      return startWorkflow(runId, manifestFile);
    }
    if (path.resolve(manifestFile) !== workflowInputPath(runId)) {
      throw new FlowError('resume requires the hook-supplied manifest path', 'state_error');
    }
    return publicState(existing);
  } catch (error) {
    if (errorCode(error) === 'no_flow') return startWorkflow(runId, manifestFile);
    throw error;
  }
}

/** Cancels only the exact active controller bound to this task and hook-supplied manifest. */
function cancelWorkflow(runId: string, manifestFile: string): PublicState {
  const { file, state } = loadWorkflowState(runId);
  if (path.resolve(manifestFile) !== workflowInputPath(runId)) {
    throw new FlowError('cancel requires the hook-supplied manifest path', 'state_error');
  }
  if (state.status === 'cancelled') return publicState(state);
  if (state.status !== 'running') {
    throw new FlowError(
      `workflow is ${state.status}; only an active workflow can be cancelled`,
      'state_error',
    );
  }
  state.status = 'cancelled';
  state.actor_baseline = null;
  state.action_baseline = null;
  state.escalation = null;
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
  const allowed = new Set(step.files);
  return {
    outside: changed.filter((relative) => !allowed.has(relative)),
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

function gateArgs(
  stepId: string,
  gate: ShellGateSpec,
  repo: string,
  requiredOutput = gate.require_output,
): string[] {
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
  for (const value of requiredOutput) argv.push('--require-output', value);
  for (const value of gate.forbid_output) argv.push('--forbid-output', value);
  return argv;
}

function correctionActorId(route: string | null): string | null {
  if (!route || route === 'blocked' || route === 'triage') return null;
  const unit = /^(red|green|direct):(U-\d{3})$/u.exec(route);
  return unit ? `${unit[2]}:${unit[1]}` : route.startsWith('cleanup:') ? route : null;
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

/** Runs the current gate and either advances, reroutes to its owner, or blocks. */
function runGate(runId: string, stepId: string): { result: PublicState; exitCode: number } {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['gate']);
  const sealed = state.sealed_gates[step.id];
  if (step.gate.authority === 'shell' && step.gate.calibrate && !sealed) {
    throw new FlowError(
      `${step.id} must be calibrated and sealed before its official gate`,
      'order_error',
    );
  }
  let report: GateReport;
  if (step.gate.authority === 'shell') {
    report = runIsolatedShellVerification(
      parseGateArgs(
        gateArgs(step.id, step.gate, state.manifest.repo, sealed ?? step.gate.require_output),
      ),
    ).report;
  } else {
    const before = repositoryInvariant(state.manifest.repo);
    report = runStructuredBuildGate(state, step);
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

function plannedCalibrationTests(
  state: FlowState,
  step: Extract<FlowStep, { kind: 'gate' }>,
): BuildPlanUnit['tests'] | null {
  if (state.workflow !== 'build') return null;
  const owner = step.owner ? UNIT_ACTOR.exec(step.owner) : null;
  if (!owner || owner[2] !== 'red') return null;
  const unit = state.build_plan?.units.find((candidate) => candidate.id === owner[1]);
  if (!unit?.tests.length) {
    throw new FlowError(`${step.id} has no planned test names for calibration`, 'state_error');
  }
  return unit.tests;
}

/** Observes an expected failure before an agent selects its stable evidence anchor. */
function runCalibration(runId: string, stepId: string): { result: PublicState; exitCode: number } {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['gate']);
  if (step.gate.authority !== 'shell')
    throw new FlowError(`${step.id} calibration requires shell authority`, 'state_error');
  if (!step.gate.calibrate)
    throw new FlowError(`${step.id} is not a calibration gate`, 'order_error');
  if (state.sealed_gates[step.id])
    throw new FlowError(`${step.id} is already sealed`, 'order_error');
  const options: GateOptions = {
    gateId: step.id,
    failureRoute: step.gate.failure_route,
    cwd: state.manifest.repo,
    expect: 'fail',
    command: step.gate.command,
    timeoutMs: step.gate.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    tailBytes: DEFAULT_TAIL_BYTES,
    requiredOutput: [],
    forbiddenOutput: step.gate.forbid_output,
  };
  const { report: observedReport, candidates } = runIsolatedShellVerification(
    options,
    plannedCalibrationTests(state, step),
  );
  const report =
    observedReport.verdict === 'pass' && candidates.length === 0
      ? {
          ...observedReport,
          verdict: 'fail' as const,
          classification: 'missing_calibration_evidence',
          reason_codes: ['missing_calibration_evidence'],
          failure_route: step.gate.failure_route,
        }
      : observedReport;
  if (report.evidence.kind !== 'shell') {
    throw new FlowError(`${step.id} calibration returned non-shell evidence`, 'state_error');
  }
  const calibrationReport = { ...report, classification: `calibration_${report.classification}` };
  applyGateOutcome(state, step, calibrationReport, false);
  if (report.verdict !== 'pass') {
    const result = save(file, state);
    result.gate = calibrationReport;
    return { result, exitCode: state.status === 'blocked' ? 2 : 1 };
  }
  const calibration = {
    command: step.gate.command,
    exit_code: report.evidence.exit_code,
    stdout_tail: report.evidence.stdout_tail,
    stderr_tail: report.evidence.stderr_tail,
    candidates,
  };
  state.calibrations[step.id] = calibration;
  const result = save(file, state);
  result.calibration = calibration;
  return { result, exitCode: 0 };
}

/** Seals a calibrated gate with one controller-extracted candidate. */
function sealGate(runId: string, stepId: string, candidateId: string | undefined): PublicState {
  const { file, state } = loadWorkflowState(runId);
  const step = requireStep(state, stepId, ['gate']);
  if (step.gate.authority !== 'shell')
    throw new FlowError(`${step.id} sealing requires shell authority`, 'state_error');
  if (!step.gate.calibrate)
    throw new FlowError(`${step.id} is not a calibration gate`, 'order_error');
  if (typeof candidateId !== 'string' || !candidateId.trim() || candidateId.length > 128) {
    throw new FlowError('--candidate-id must be a non-empty id of at most 128 characters');
  }
  const calibration = state.calibrations[step.id];
  if (!calibration) throw new FlowError(`${step.id} has no calibration result`, 'order_error');
  const candidate = calibration.candidates.find(({ id }) => id === candidateId);
  if (!candidate)
    throw new FlowError('--candidate-id is not a calibration candidate', 'evidence_error');
  state.sealed_gates[step.id] = [candidate.text];
  delete state.calibrations[step.id];
  return save(file, state);
}

function workflowStatus(runId: string): PublicState {
  return publicState(loadWorkflowState(runId).state);
}

function actorVerification(state: FlowState, step: ActorStep): ActorVerification {
  const gate = state.manifest.steps[state.cursor + 1];
  if (!gate || gate.kind !== 'gate' || gate.owner !== step.id) {
    throw new FlowError(`${step.id} has no owned verification gate`, 'state_error');
  }
  if (gate.gate.authority !== 'shell') {
    throw new FlowError(`${step.id} verification must use shell authority`, 'state_error');
  }
  return {
    command: gate.gate.command,
    expect: gate.gate.expect,
  };
}

/** Derives the sole permitted next operation from persisted controller state. */
function directiveForState(state: FlowState): FlowDirective {
  if (state.status === 'cancelled') {
    return { kind: 'cancelled' };
  }
  if (state.status === 'completed') {
    return { kind: 'done' };
  }
  if (state.status === 'ship-ready') {
    return { kind: 'ship-ready' };
  }
  if (state.status === 'blocked') {
    return { kind: 'blocked' };
  }
  const step = state.manifest.steps[state.cursor];
  if (!step) throw new FlowError('running workflow has no current step', 'state_error');
  if (step.kind === 'actor') {
    return {
      kind: 'run-actor',
      step_id: step.id,
      outcome: step.outcome,
      files: step.files,
      verification: actorVerification(state, step),
      correction: correctionContext(state, step.id),
    };
  }
  if (step.kind === 'action') {
    return actionDirective(state, step);
  }
  if (step.gate.authority === 'shell' && step.gate.calibrate && !state.sealed_gates[step.id]) {
    const calibration = state.calibrations[step.id];
    if (!calibration) {
      return {
        kind: 'calibrate-gate',
        step_id: step.id,
      };
    }
    return {
      kind: 'seal-gate',
      step_id: step.id,
      calibration,
    };
  }
  return {
    kind: 'run-gate',
    step_id: step.id,
  };
}

function currentDirective(runId: string): FlowDirective {
  return directiveForState(loadWorkflowState(runId).state);
}

/** Completes the current directive without accepting a caller-supplied transition name. */
function completeCurrentDirective(
  runId: string,
  stepId: string,
  candidateId?: string,
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
    case 'calibrate-gate':
      return runCalibration(runId, stepId);
    case 'seal-gate':
      return { result: sealGate(runId, stepId, candidateId), exitCode: 0 };
    case 'run-gate':
      return runGate(runId, stepId);
  }
}

function describe(workflow: Workflow): FlowDescription {
  const stepContracts: StepDescription[] = [
    {
      kind: 'actor',
      required: ['id', 'kind', 'outcome', 'files'],
      optional: [],
      derived: [],
      id_patterns: [UNIT_ACTOR.source, CLEANUP_ACTOR.source],
    },
    {
      kind: 'gate',
      required: ['id', 'kind', 'gate.authority'],
      optional: ['owner', 'gate.failure_route'],
      derived: ['gate.failure_route:owner'],
      conditional_required: {
        shell: ['gate.command', 'gate.expect'],
        'build-plan': ['gate.input'],
        'build-revalidate': ['gate.input'],
        'build-artifacts': ['gate.input', 'gate.unit_id'],
        'build-ship': [],
      },
      conditional_optional: {
        shell: ['gate.calibrate', 'gate.timeout_ms', 'gate.require_output', 'gate.forbid_output'],
        'build-plan': [],
        'build-revalidate': [],
        'build-artifacts': [],
        'build-ship': [],
      },
    },
  ];
  if (workflow === 'build') {
    stepContracts.push({
      kind: 'action',
      required: ['id', 'kind', 'action'],
      optional: ['branch_name', 'start_point', 'subject', 'remote', 'repository', 'base_branch'],
      derived: [],
      actions: [...ACTIONS],
      conditional_required: {
        branch: ['branch_name', 'start_point'],
        commit: ['subject'],
        ship: ['remote', 'repository', 'base_branch'],
      },
    });
  }
  return {
    protocol: DESCRIPTION_PROTOCOL,
    workflow,
    cli: {
      describe: `codex-flow describe --workflow ${workflow}`,
      run: 'codex-flow run --manifest <absolute-json>',
      cancel: 'codex-flow cancel --manifest <hook-supplied-json>',
      task_binding: 'hook-injected',
    },
    defaults: {
      gate_timeout_ms: DEFAULT_TIMEOUT_MS,
    },
    manifest_template: {
      protocol: MANIFEST_PROTOCOL,
      workflow,
      repo: '<absolute-git-root>',
      max_corrections: DEFAULT_MAX_CORRECTIONS,
      shipping_authorized: false,
      steps: [],
    },
    executable_example: {
      required_sequence:
        workflow === 'build' ? ['branch', 'baseline', 'final'] : ['baseline', 'final'],
      manifest: {
        protocol: MANIFEST_PROTOCOL,
        workflow,
        repo: '<absolute-git-root>',
        max_corrections: DEFAULT_MAX_CORRECTIONS,
        shipping_authorized: false,
        steps:
          workflow === 'build'
            ? [
                {
                  id: 'load:plan',
                  kind: 'gate',
                  gate: {
                    authority: 'build-plan',
                    input: '<absolute-build-source-json>',
                    failure_route: 'triage',
                  },
                },
                {
                  id: 'revalidate:plan',
                  kind: 'gate',
                  gate: {
                    authority: 'build-revalidate',
                    input: '<absolute-build-source-json>',
                    failure_route: 'triage',
                  },
                },
                {
                  id: 'branch',
                  kind: 'action',
                  action: 'branch',
                  branch_name: 'codex/example',
                  start_point: '<git-ref>',
                },
                {
                  id: 'branch:verify',
                  kind: 'gate',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'triage',
                    require_output: [],
                    forbid_output: [],
                  },
                },
                {
                  id: 'baseline:direct',
                  kind: 'gate',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'triage',
                    require_output: [],
                    forbid_output: [],
                  },
                },
                {
                  id: 'U-001:direct',
                  kind: 'actor',
                  outcome: '<unit-outcome>',
                  files: ['<repo-relative-file>'],
                },
                {
                  id: 'U-001:direct:gate',
                  kind: 'gate',
                  owner: 'U-001:direct',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'direct:U-001',
                    require_output: [],
                    forbid_output: [],
                  },
                },
                {
                  id: 'U-001:artifacts',
                  kind: 'gate',
                  owner: 'U-001:direct',
                  gate: {
                    authority: 'build-artifacts',
                    input: '<absolute-build-source-json>',
                    unit_id: 'U-001',
                    failure_route: 'direct:U-001',
                  },
                },
                { id: 'U-001:commit', kind: 'action', action: 'commit', subject: 'feat: unit' },
                {
                  id: 'U-001:commit:verify',
                  kind: 'gate',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'triage',
                    require_output: [],
                    forbid_output: [],
                  },
                },
                {
                  id: 'final:direct',
                  kind: 'gate',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'triage',
                    require_output: [],
                    forbid_output: [],
                  },
                },
              ]
            : [
                {
                  id: 'baseline:direct',
                  kind: 'gate',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'triage',
                    require_output: [],
                    forbid_output: [],
                  },
                },
                {
                  id: 'U-001:direct',
                  kind: 'actor',
                  outcome: '<unit-outcome>',
                  files: ['<repo-relative-file>'],
                },
                {
                  id: 'U-001:direct:gate',
                  kind: 'gate',
                  owner: 'U-001:direct',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'direct:U-001',
                    require_output: [],
                    forbid_output: [],
                  },
                },
                {
                  id: 'final:direct',
                  kind: 'gate',
                  gate: {
                    authority: 'shell',
                    command: 'true',
                    expect: 'pass',
                    calibrate: false,
                    failure_route: 'triage',
                    require_output: [],
                    forbid_output: [],
                  },
                },
              ],
      },
    },
    cli_contracts: {
      reports: [
        { protocol: RESULT_PROTOCOL, command: 'codex-flow run --manifest <absolute-json>' },
      ],
    },
    ...(workflow === 'build' ? { inputs: { source: describeBuildSourceInput() } } : {}),
    step_contracts: stepContracts,
    sequence: {
      opening: workflow === 'build' ? [...BUILD_OPENING_IDS, 'baseline:*'] : ['baseline:*'],
      unit_modes: {
        red_green: unitStepIds('U-NNN', ['red', 'green'], workflow),
        direct: unitStepIds('U-NNN', ['direct'], workflow),
      },
      closing:
        workflow === 'build'
          ? ['final:*', 'revalidate:ship?', 'ship?', 'ship:verify?']
          : ['final:*'],
    },
  };
}

export {
  DESCRIPTION_PROTOCOL,
  MANIFEST_PROTOCOL,
  completeCurrentDirective,
  cancelWorkflow,
  currentDirective,
  describe,
  loadWorkflowState,
  startOrResumeWorkflow,
  startWorkflow,
  statePath,
  validateManifest,
  workflowStatus,
};
