/** @file Outcome: All flow components share one versioned model of legal states and messages. */

import type { RepositoryInvariant, RepoSnapshot } from '../shared/repository.ts';

export const MANIFEST_PROTOCOL = 'codex-flow-manifest/v4' as const;
export const STATE_PROTOCOL = 'codex-flow-state/v8' as const;
export const RESULT_PROTOCOL = 'codex-flow-control/v5' as const;
export const GATE_PROTOCOL = 'codex-code-gate/v3' as const;
export const DESCRIPTION_PROTOCOL = 'codex-flow-description/v6' as const;

export type Workflow = 'code' | 'build';
export type FlowStatus = 'running' | 'completed' | 'ship-ready' | 'blocked' | 'cancelled';
export interface WorkflowEscalation {
  step_id: string;
  next_step: 'think' | 'research';
  question: string;
  summary: string;
}
export type GateExpectation = 'pass' | 'fail';
export type GateVerdict = 'pass' | 'fail' | 'blocked';
export type GateAuthority =
  | 'shell'
  | 'build-plan'
  | 'build-revalidate'
  | 'build-artifacts'
  | 'build-ship';
export type ActionName = 'branch' | 'commit' | 'ship';
export type ActorRole = 'red' | 'green' | 'direct';

interface GateSpecBase {
  command: string;
  failure_route: string;
}

export interface ShellGateSpec extends GateSpecBase {
  authority: 'shell';
  expect: GateExpectation;
  calibrate: boolean;
  timeout_ms?: number;
  require_output: string[];
  forbid_output: string[];
}

interface BuildPlanGateSpec extends GateSpecBase {
  authority: 'build-plan';
  input: string;
}

interface BuildRevalidateGateSpec extends GateSpecBase {
  authority: 'build-revalidate';
  input: string;
}

interface BuildArtifactsGateSpec extends GateSpecBase {
  authority: 'build-artifacts';
  input: string;
  unit_id: string;
}

interface BuildShipGateSpec extends GateSpecBase {
  authority: 'build-ship';
}

export type GateSpec =
  | ShellGateSpec
  | BuildPlanGateSpec
  | BuildRevalidateGateSpec
  | BuildArtifactsGateSpec
  | BuildShipGateSpec;

export interface ActorStep {
  id: string;
  kind: 'actor';
  outcome: string;
  files: string[];
}

export interface ActorVerification {
  command: string;
  expect: GateExpectation;
}

export interface BranchActionStep {
  id: 'branch';
  kind: 'action';
  action: 'branch';
  branch_name: string;
  start_point: string;
}

export interface UnitActionStep {
  id: string;
  kind: 'action';
  action: 'commit';
  subject: string;
}

export interface ShipActionStep {
  id: 'ship';
  kind: 'action';
  action: 'ship';
  remote: string;
  repository: string;
  base_branch: string;
}

export type ActionStep = BranchActionStep | UnitActionStep | ShipActionStep;

export interface BranchActionParameters {
  branch_name: string;
  start_point: string;
}

export interface CommitActionParameters {
  files: string[];
  subject: string;
  trailers: string[];
}

export interface ShipActionParameters {
  remote: string;
  repository: string;
  branch: string;
  base_branch: string;
  title: string;
  pr_input_path: string;
  pr_body_path: string;
}

export type ActionParameters =
  | BranchActionParameters
  | CommitActionParameters
  | ShipActionParameters;

export type RunActionDirective = {
  kind: 'run-action';
  step_id: string;
} & (
  | { action: 'branch'; parameters: BranchActionParameters }
  | { action: 'commit'; parameters: CommitActionParameters }
  | { action: 'ship'; parameters: ShipActionParameters }
);

export interface GateStep {
  id: string;
  kind: 'gate';
  owner?: string;
  gate: GateSpec;
}

export type FlowStep = ActorStep | ActionStep | GateStep;

export interface FlowManifest {
  protocol: typeof MANIFEST_PROTOCOL;
  workflow: Workflow;
  repo: string;
  max_corrections: number;
  shipping_authorized: boolean;
  steps: FlowStep[];
}

interface Calibration {
  command: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  candidates: CalibrationCandidate[];
}

export interface CalibrationCandidate {
  id: string;
  text: string;
  test_id?: string;
}

export interface GateCheck {
  kind: 'exit' | 'output_includes' | 'output_excludes';
  expected?: GateExpectation;
  actual?: number | null;
  signal?: NodeJS.Signals | null;
  value?: string;
  passed: boolean;
}

interface ShellGateEvidence {
  kind: 'shell';
  checks: GateCheck[];
  matches_expected_exit: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  execution_error: string | null;
  stdout_tail: string;
  stderr_tail: string;
}

interface StructuredGateEvidence {
  kind: 'structured';
  report: StructuredGateResult;
}

interface GateReportBase {
  protocol: typeof GATE_PROTOCOL;
  gate_id: string;
  verdict: GateVerdict;
  classification: string;
  reason_codes: string[];
  failure_route: string | null;
  configured_failure_route: string;
  command: string;
  cwd: string;
  duration_ms: number;
}

interface ShellGateReport extends GateReportBase {
  expected: GateExpectation;
  evidence: ShellGateEvidence;
}

interface StructuredGateReport extends GateReportBase {
  evidence: StructuredGateEvidence;
}

export type GateReport = ShellGateReport | StructuredGateReport;

export interface StructuredGateResult {
  [key: string]: unknown;
  verdict: GateVerdict;
  classification: string;
  reason_codes: string[];
  failure_route: string | null;
}

export interface GateOptions {
  gateId: string;
  failureRoute: string;
  cwd: string;
  expect: GateExpectation;
  command: string;
  timeoutMs: number;
  tailBytes: number;
  requiredOutput: string[];
  forbiddenOutput: string[];
}

export interface FlowState {
  protocol: typeof STATE_PROTOCOL;
  run_id: string;
  workflow: Workflow;
  manifest: FlowManifest;
  manifest_hash: string;
  cursor: number;
  status: FlowStatus;
  correction_counts: Record<string, number>;
  sealed_gates: Record<string, string[]>;
  calibrations: Record<string, Calibration>;
  gate_reports: GateReport[];
  build_plan: BuildPlanContext | null;
  workflow_baseline: RepoSnapshot;
  actor_baseline: RepositoryInvariant | null;
  action_baseline: RepositoryInvariant | null;
  escalation: WorkflowEscalation | null;
  ship_authorization_revoked: boolean;
}

export interface BuildPlanUnit {
  id: string;
  contract: string;
  files: string[];
  tests: Array<{ id: string; name: string }>;
  seam: boolean;
}

export interface BuildPlanContext {
  repository: string;
  issue: number;
  title: string;
  body_sha256: string;
  manual_verification: string[];
  units: BuildPlanUnit[];
}

export interface PublicState {
  protocol: typeof RESULT_PROTOCOL;
  verdict: 'pass' | 'blocked';
  workflow: Workflow;
  status: FlowStatus;
  current_step: FlowStep | null;
  cursor: number;
  total_steps: number;
  manifest_hash: string;
  correction_counts: Record<string, number>;
  sealed_gates: Record<string, string[]>;
  last_gate: GateReport | null;
  gate_reports: GateReport[];
  escalation: WorkflowEscalation | null;
  ship_authorization_revoked: boolean;
  gate?: GateReport;
  calibration?: Calibration;
}

export interface CorrectionContext {
  attempt: number;
  max_attempts: number;
  gate: GateReport;
}

export type FlowDirective =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'ship-ready' }
  | { kind: 'blocked' }
  | {
      kind: 'run-actor';
      step_id: string;
      outcome: string;
      files: string[];
      verification: ActorVerification;
      correction: CorrectionContext | null;
    }
  | RunActionDirective
  | {
      kind: 'calibrate-gate';
      step_id: string;
    }
  | {
      kind: 'seal-gate';
      step_id: string;
      calibration: Calibration;
    }
  | {
      kind: 'run-gate';
      step_id: string;
    };

export interface CommandResult {
  result: PublicState | FlowDescription;
  exitCode: number;
}

export interface StepDescription {
  kind: FlowStep['kind'];
  required: string[];
  optional: string[];
  derived: string[];
  id_patterns?: string[];
  actions?: ActionName[];
  conditional_required?: Record<string, string[]>;
  conditional_optional?: Record<string, string[]>;
}

export interface FlowDescription {
  protocol: typeof DESCRIPTION_PROTOCOL;
  workflow: Workflow;
  cli: {
    describe: string;
    run: string;
    cancel: string;
    task_binding: 'hook-injected';
  };
  defaults: {
    gate_timeout_ms: number;
  };
  manifest_template: {
    protocol: typeof MANIFEST_PROTOCOL;
    workflow: Workflow;
    repo: '<absolute-git-root>';
    max_corrections: number;
    shipping_authorized: false;
    steps: [];
  };
  executable_example: {
    required_sequence: string[];
    manifest: Record<string, unknown>;
  };
  cli_contracts: {
    reports: Array<{ protocol: string; command: string }>;
  };
  inputs?: {
    source: {
      template: Record<string, unknown>;
    };
  };
  step_contracts: StepDescription[];
  sequence: {
    opening: string[];
    unit_modes: {
      red_green: string[];
      direct: string[];
    };
    closing: string[];
  };
}
