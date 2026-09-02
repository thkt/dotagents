/** @file Outcome: Build gates derive deterministic reports from validated Plan and workflow state. */

import * as fs from 'node:fs';
import path from 'node:path';

import { gitFileList, verifyArtifacts } from './artifacts.ts';
import { inspectDraftPullRequest } from './github.ts';
import { describeBuildSource, resolveBuildSource, type ResolvedBuildSource } from './handoff.ts';
import { validatePlan } from './plan.ts';
import { revalidatePlan } from './revalidate.ts';
import {
  GATE_PROTOCOL,
  type ActionStep,
  type ActorStep,
  type ActorRole,
  type BuildPlanContext,
  type BuildReviewResult,
  type FlowDescription,
  type FlowManifest,
  type FlowState,
  type GateReport,
  type GateStep,
  type StructuredGateResult,
} from '../contracts.ts';
import { UNIT_ACTOR } from '../manifest.ts';
import { FlowError, errorCode, errorMessage } from '../../shared/errors.ts';
import { GITHUB_ACCESS_ERROR, GITHUB_COMMAND_ERROR } from '../../shared/github.ts';
import { prBodyPath } from '../../shared/storage.ts';

function readJson(file: string, label: string): unknown {
  if (!path.isAbsolute(file)) throw new FlowError(`${label} must be absolute`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new FlowError(`${label} is not readable JSON: ${errorMessage(error)}`);
  }
}

function buildPlanContext(value: ResolvedBuildSource): BuildPlanContext {
  return {
    repository: value.repository,
    issue: value.issue,
    title: value.title,
    body_sha256: value.body_sha256,
    outcome: value.plan.outcome,
    test_command: value.plan.test_command,
    manual_verification: value.plan.manual_verification,
    screenshots: value.plan.screenshots ?? [],
    units: value.plan.units.map((unit) => ({
      id: unit.id,
      goal: unit.goal,
      contract: unit.contract,
      files: unit.files,
      tests: unit.tests,
      seam: unit.seam,
    })),
  };
}

/** Exposes the published-issue handoff through workflow self-description. */
export function describeBuildSourceInput(): NonNullable<FlowDescription['inputs']>['source'] {
  return {
    template: describeBuildSource(),
  };
}

type ManifestUnitScope = {
  roles: ActorRole[];
  files: Set<string>;
  roleFiles: Map<ActorRole, Set<string>>;
};

function manifestUnitScopes(manifest: FlowManifest): Map<string, ManifestUnitScope> {
  const scopes = new Map<string, ManifestUnitScope>();
  for (const step of manifest.steps) {
    if (step.kind !== 'actor') continue;
    const match = UNIT_ACTOR.exec(step.id);
    if (!match) continue;
    const unitId = match[1]!;
    const role = match[2] as ActorRole;
    const scope: ManifestUnitScope = scopes.get(unitId) ?? {
      roles: [],
      files: new Set(),
      roleFiles: new Map(),
    };
    scope.roles.push(role);
    const roleFiles = scope.roleFiles.get(role) ?? new Set<string>();
    for (const file of step.files) {
      scope.files.add(file);
      roleFiles.add(file);
    }
    scope.roleFiles.set(role, roleFiles);
    scopes.set(unitId, scope);
  }
  return scopes;
}

function initiallyMissingTestedPlanFiles(plan: BuildPlanContext, repo: string): Set<string> {
  return new Set(
    [...new Set(plan.units.flatMap((unit) => (unit.tests.length ? unit.files : [])))].filter(
      (file) => !fs.existsSync(path.resolve(repo, file)),
    ),
  );
}

/** Returns every unit-level mismatch between a validated Plan and its manifest. */
export function buildManifestPlanBlockers(
  manifest: FlowManifest,
  plan: BuildPlanContext,
  repo: string,
): string[] {
  const manifestUnits = manifestUnitScopes(manifest);

  const blockers: string[] = [];
  const initiallyMissing = initiallyMissingTestedPlanFiles(plan, repo);
  const planIds = new Set(plan.units.map((unit) => unit.id));
  for (const unitId of manifestUnits.keys()) {
    if (!planIds.has(unitId)) blockers.push(`manifest has unit absent from Plan: ${unitId}`);
  }
  for (const planUnit of plan.units) {
    const manifestUnit = manifestUnits.get(planUnit.id);
    if (!manifestUnit) {
      blockers.push(`manifest is missing Plan unit: ${planUnit.id}`);
      continue;
    }
    const expectedRoles = planUnit.tests.length ? 'red,green' : 'direct';
    if (manifestUnit.roles.join(',') !== expectedRoles) {
      blockers.push(`${planUnit.id} requires ${expectedRoles} actors from its Plan tests`);
    }
    const unitActors = manifest.steps.filter(
      (step): step is ActorStep => step.kind === 'actor' && step.id.startsWith(`${planUnit.id}:`),
    );
    for (const actor of unitActors) {
      if (actor.outcome !== planUnit.goal) {
        blockers.push(`${actor.id}.outcome must equal ${planUnit.id}.goal from the Plan`);
      }
    }
    const plannedFiles = new Set(planUnit.files);
    const missingFiles = planUnit.files.filter((file) => !manifestUnit.files.has(file));
    const extraFiles = [...manifestUnit.files].filter((file) => !plannedFiles.has(file));
    if (missingFiles.length) {
      blockers.push(`${planUnit.id} actor scope is missing Plan files: ${missingFiles.join(', ')}`);
    }
    if (extraFiles.length) {
      blockers.push(
        `${planUnit.id} actor scope has files absent from Plan: ${extraFiles.join(', ')}`,
      );
    }
    if (planUnit.tests.length) {
      for (const file of planUnit.files) {
        if (!initiallyMissing.has(file)) continue;
        for (const role of ['red', 'green'] as const) {
          const roleFiles = manifestUnit.roleFiles.get(role);
          if (roleFiles && !roleFiles.has(file)) {
            blockers.push(
              `${planUnit.id}:${role} scope is missing initially absent Plan file: ${file}`,
            );
          }
        }
      }
    }
  }
  for (const step of manifest.steps) {
    if (
      step.kind !== 'gate' ||
      step.gate.authority !== 'shell' ||
      !/^(?:baseline:|final:|U-\d{3}:(?:red|green|direct):gate$)/u.test(step.id)
    ) {
      continue;
    }
    if (step.gate.command !== plan.test_command) {
      blockers.push(`${step.id}.gate.command must equal Plan test_command`);
    }
  }
  return blockers;
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
    failure_route: result.failure_route,
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
  const source = 'input' in step.gate ? readJson(step.gate.input, `${step.id}.gate.input`) : null;
  let input: ReturnType<typeof resolveBuildSource> | null = null;
  if ('input' in step.gate) {
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
  if (
    input &&
    step.gate.authority !== 'build-plan' &&
    state.build_plan &&
    (input.repository !== state.build_plan.repository ||
      input.issue !== state.build_plan.issue ||
      input.title !== state.build_plan.title ||
      input.body_sha256 !== state.build_plan.body_sha256)
  ) {
    return normalizeGate(step, state.manifest.repo, startedAt, {
      verdict: 'blocked',
      classification: 'issue_contract_stale',
      reason_codes: ['issue_contract_stale'],
      failure_route: 'blocked',
      expected_body_sha256: state.build_plan.body_sha256,
      actual_body_sha256: input.body_sha256,
      expected_title: state.build_plan.title,
      actual_title: input.title,
    });
  }
  switch (step.gate.authority) {
    case 'build-plan': {
      report = validatePlan(
        input && {
          issue: input.issue,
          title: input.title,
          body: input.body,
          plan: input.plan,
        },
      );
      if (report.verdict === 'pass') {
        if (!input) throw new FlowError('validated Plan input has no build context', 'state_error');
        const context = buildPlanContext(input);
        const blockers = buildManifestPlanBlockers(state.manifest, context, state.manifest.repo);
        if (blockers.length) {
          report = {
            ...report,
            verdict: 'fail',
            classification: 'manifest_plan_mismatch',
            reason_codes: ['manifest_plan_mismatch'],
            failure_route: 'blocked',
            blockers,
          };
        } else {
          state.build_plan = context;
        }
      }
      break;
    }
    case 'build-revalidate':
      report = revalidatePlan(input, state.manifest.repo);
      break;
    case 'build-artifacts': {
      const branch = state.manifest.steps.find(
        (candidate): candidate is ActionStep =>
          candidate.kind === 'action' && candidate.action === 'branch',
      );
      if (!branch || branch.action !== 'branch') {
        throw new FlowError(`${step.id} has no build artifact context`, 'state_error');
      }
      report = verifyArtifacts(
        input,
        state.manifest.repo,
        gitFileList(state.manifest.repo, branch.start_point),
        Object.keys(state.workflow_baseline),
        step.id,
        step.gate.unit_id,
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
