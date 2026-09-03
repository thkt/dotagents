/** @file Outcome: Build verification derives deterministic reports from validated Plan and workflow state. */

import * as fs from 'node:fs';

import { gitFileList, verifyArtifacts } from './artifact-verification.ts';
import { inspectDraftPullRequest } from './github.ts';
import { resolveBuildSource, type ResolvedBuildSource } from './input.ts';
import { validatePlan } from '../plan/validation.ts';
import {
  GATE_PROTOCOL,
  type ActionStep,
  type BuildPlanContext,
  type BuildReviewResult,
  type FlowState,
  type GateReport,
  type GateStep,
  type StructuredGateResult,
} from '../execution/contracts.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { GITHUB_ACCESS_ERROR, GITHUB_COMMAND_ERROR } from '../shared/github.ts';
import { readAbsoluteJson } from '../shared/runtime.ts';
import { prBodyPath } from '../shared/storage.ts';

function buildPlanContext(value: ResolvedBuildSource): BuildPlanContext {
  return {
    repository: value.repository,
    issue: value.issue,
    title: value.title,
    outcome: value.plan.outcome,
    test_command: value.plan.test_command,
    units: value.plan.units.map((unit, unitIndex) => ({
      id: `U-${String(unitIndex + 1).padStart(3, '0')}`,
      goal: unit.goal,
      contract: unit.contract,
      files: unit.files,
      tests: unit.tests.map((name, testIndex) => ({
        id: `T-${String(testIndex + 1).padStart(3, '0')}`,
        name,
      })),
    })),
  };
}

function verifyShip(state: FlowState): StructuredGateResult {
  const ship = state.manifest.steps.find(
    (candidate): candidate is ActionStep =>
      candidate.kind === 'action' && candidate.action === 'ship',
  );
  const branch = state.manifest.steps.find(
    (candidate): candidate is ActionStep =>
      candidate.kind === 'action' && candidate.action === 'branch',
  );
  if (!ship || ship.action !== 'ship' || !branch || branch.action !== 'branch') {
    throw new FlowError('ship verification has no action context', 'state_error');
  }
  const body = fs.readFileSync(prBodyPath(state.run_id), 'utf8');
  try {
    const inspection = inspectDraftPullRequest({
      repository: ship.repository,
      branch: branch.branch_name,
      baseBranch: ship.base_branch,
      title: state.build_plan?.title || '',
      body,
    });
    const passed = inspection.status === 'matched';
    return {
      protocol: 'codex-build-ship',
      verdict: passed ? 'pass' : 'blocked',
      classification: passed ? 'pass' : 'ship_verification_failed',
      reason_codes: passed ? [] : ['ship_verification_failed'],
      failure_route: passed ? null : 'blocked',
      ...(inspection.status === 'absent' ? {} : inspection.pullRequest),
      ...(passed ? {} : { error: inspection.error }),
    };
  } catch (error) {
    return {
      protocol: 'codex-build-ship',
      verdict: 'blocked',
      classification: 'ship_verification_failed',
      reason_codes: ['ship_verification_failed'],
      failure_route: 'blocked',
      error: errorMessage(error),
    };
  }
}

function normalizeGate(
  step: GateStep,
  repo: string,
  startedAt: number,
  value: StructuredGateResult,
): GateReport {
  return {
    protocol: GATE_PROTOCOL,
    gate_id: step.id,
    verdict: value.verdict,
    classification: value.classification,
    reason_codes: value.reason_codes,
    failure_route: value.verdict === 'pass' ? null : (value.failure_route ?? 'blocked'),
    configured_failure_route: step.gate.failure_route,
    command: step.gate.command,
    cwd: repo,
    duration_ms: Date.now() - startedAt,
    evidence: { kind: 'structured', report: value },
  };
}

/** Normalizes an SDK semantic review into the same durable evidence model as other gates. */
export function buildReviewGateReport(
  step: GateStep,
  repo: string,
  result: BuildReviewResult,
  durationMs: number,
): GateReport {
  return {
    protocol: GATE_PROTOCOL,
    gate_id: step.id,
    verdict: result.verdict,
    classification: result.classification,
    reason_codes: result.reason_codes,
    failure_route: result.verdict === 'pass' ? null : step.gate.failure_route,
    configured_failure_route: step.gate.failure_route,
    command: step.gate.command,
    cwd: repo,
    duration_ms: durationMs,
    evidence: { kind: 'structured', report: result },
  };
}

/** Runs one typed build authority and normalizes its result into controller evidence. */
export function runStructuredBuildGate(state: FlowState, step: GateStep): GateReport {
  const startedAt = Date.now();
  const source =
    step.gate.authority === 'build-plan'
      ? readAbsoluteJson(step.gate.input, `${step.id}.gate.input`)
      : null;
  let input: ReturnType<typeof resolveBuildSource> | null = null;
  if (source !== null) {
    try {
      input = resolveBuildSource(source, state.manifest.repo);
    } catch (error) {
      const code = errorCode(error);
      const githubReadFailed = code === GITHUB_ACCESS_ERROR || code === GITHUB_COMMAND_ERROR;
      const classification = githubReadFailed
        ? 'github_issue_read_failed'
        : 'issue_contract_invalid';
      return normalizeGate(step, state.manifest.repo, startedAt, {
        verdict: 'blocked',
        classification,
        reason_codes: [classification],
        failure_route: 'blocked',
        retryable: code === GITHUB_ACCESS_ERROR,
        error: errorMessage(error),
      });
    }
  }
  let report: StructuredGateResult;
  switch (step.gate.authority) {
    case 'build-plan': {
      report = validatePlan(
        input && {
          issue: input.issue,
          title: input.title,
          plan: input.plan,
        },
      );
      if (report.verdict === 'pass') {
        if (!input) throw new FlowError('validated Plan input has no build context', 'state_error');
        state.build_plan = buildPlanContext(input);
        state.screenshots = input.screenshots;
      }
      break;
    }
    case 'build-artifacts': {
      if (!state.build_plan) {
        throw new FlowError(`${step.id} has no validated build Plan`, 'state_error');
      }
      const branch = state.manifest.steps.find(
        (candidate): candidate is ActionStep =>
          candidate.kind === 'action' && candidate.action === 'branch',
      );
      if (!branch || branch.action !== 'branch') {
        throw new FlowError(`${step.id} has no build artifact context`, 'state_error');
      }
      report = verifyArtifacts(
        state.build_plan,
        state.manifest.repo,
        gitFileList(state.manifest.repo, branch.start_point),
        Object.keys(state.workflow_baseline),
        step.id,
      );
      break;
    }
    case 'build-review':
      throw new FlowError(`${step.id} must run through SDK review authority`, 'state_error');
    case 'build-ship':
      report = verifyShip(state);
      break;
    case 'shell':
      throw new FlowError(`${step.id} authority shell is not a build authority`, 'state_error');
  }
  return normalizeGate(step, state.manifest.repo, startedAt, report);
}
