/** @file Outcome: All flow components share one current model of legal states and messages. */

import type { RepositoryInvariant, RepoSnapshot } from '../shared/repository.ts';
import type { ScreenshotSpec } from '../build/screenshot-contract.ts';
import type { SourceSeal } from './source-seal.ts';

export const MANIFEST_PROTOCOL = 'codex-flow-manifest' as const;
export const STATE_PROTOCOL = 'codex-flow-state' as const;
export const RESULT_PROTOCOL = 'codex-flow-control' as const;
/** Step and gate identifiers: printable, shell-safe, at most 128 characters. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const GATE_PROTOCOL = 'codex-code-gate' as const;
export const DESCRIPTION_PROTOCOL = 'codex-flow-description' as const;

export type Workflow = 'code' | 'build';
export type FlowStatus = 'running' | 'completed' | 'blocked' | 'cancelled';
export interface WorkflowEscalation {
  step_id: string;
  next_step: 'think' | 'research';
  question: string;
  summary: string;
}
export interface RuntimeFailure {
  step_id: string;
  stage: string;
  classification: string;
  error: string;
  retryable: boolean;
}
type GateExpectation = 'pass';
type GateVerdict = 'pass' | 'fail' | 'blocked';
export type GateAuthority =
  | 'shell'
  | 'build-plan'
  | 'build-artifacts'
  | 'build-review'
  | 'build-ship';
export type ActionName = 'branch' | 'commit' | 'ship';

interface GateSpecBase {
  command: string;
  failure_route: string;
}

export interface ShellGateSpec extends GateSpecBase {
  authority: 'shell';
  expect: 'pass';
  timeout_ms?: number;
}

interface BuildPlanGateSpec extends GateSpecBase {
  authority: 'build-plan';
  input: string;
}

interface BuildArtifactsGateSpec extends GateSpecBase {
  authority: 'build-artifacts';
}

interface BuildReviewGateSpec extends GateSpecBase {
  authority: 'build-review';
}

interface BuildShipGateSpec extends GateSpecBase {
  authority: 'build-ship';
}

export type GateSpec =
  | ShellGateSpec
  | BuildPlanGateSpec
  | BuildArtifactsGateSpec
  | BuildReviewGateSpec
  | BuildShipGateSpec;

export interface ActorStep {
  id: string;
  kind: 'actor';
  unit_id: string;
  stage: 'direct' | 'solidify';
  outcome: string;
  contract: string;
  tests: Array<{ id: string; name: string }>;
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
  run_id: string;
  remote: string;
  repository: string;
  branch: string;
  base_branch: string;
  title: string;
  pr_input_path: string;
  pr_body_path: string;
  attachments: Array<ScreenshotSpec & { path: string; sha256: string }>;
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

interface GateCheck {
  kind: 'exit';
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
  actor_receipt_digest?: string;
  source_digest?: string;
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
}

export interface FlowState {
  protocol: typeof STATE_PROTOCOL;
  run_id: string;
  workflow: Workflow;
  manifest: FlowManifest;
  input_sha256: string;
  cursor: number;
  status: FlowStatus;
  correction_counts: Record<string, number>;
  unit_attempts: Record<string, number>;
  receipt_history: ActorReceipt[];
  active_receipts: Record<string, ActorReceipt>;
  correction_queue: string[];
  correction_queue_cursor: number | null;
  reviewed_content_digest: string | null;
  reviewed_source_seal: SourceSeal | null;
  gate_reports: GateReport[];
  build_plan: BuildPlanContext | null;
  screenshots: ScreenshotSpec[];
  workflow_baseline: RepoSnapshot;
  actor_baseline: RepositoryInvariant | null;
  actor_binding: ActorBinding | null;
  action_baseline: RepositoryInvariant | null;
  escalation: WorkflowEscalation | null;
  runtime_failure: RuntimeFailure | null;
  ship_authorization_revoked: boolean;
}

export interface ActorBinding {
  run_id: string;
  workflow: Workflow;
  unit_id: string;
  stage: 'direct' | 'solidify';
  step_id: string;
  attempt: number;
  predecessor_receipt_digest: string | null;
  input_source_digest: string;
  active_receipt_set_digest: string;
}

export interface ActorResult {
  protocol: 'codex-flow-actor-result';
  binding: ActorBinding;
  status: 'completed' | 'escalated';
  summary: string;
  route: 'think' | 'research' | null;
  question: string | null;
}

export interface ActorReceipt {
  protocol: 'codex-flow-actor-receipt';
  binding: ActorBinding;
  source_after_digest: string;
  scope_digest: string;
  summary: string;
  digest: string;
}

export interface BuildPlanUnit {
  id: string;
  goal: string;
  contract: string;
  files: string[];
  tests: Array<{ id: string; name: string }>;
}

export interface BuildPlanContext {
  repository: string;
  issue: number;
  title: string;
  outcome: string;
  test_command: string;
  units: BuildPlanUnit[];
}

export interface SolidifyContext {
  outcome: string;
  units: BuildPlanUnit[];
  files: string[];
}

export interface BuildReviewInput {
  issue: number;
  base_ref: string;
  plan: BuildPlanContext;
  verification: Array<{
    gate_id: string;
    verdict: GateVerdict;
    classification: string;
  }>;
  source_digest: string;
  receipt_set_digest: string;
}

interface BuildReviewFinding {
  severity: 'blocking' | 'advisory';
  code: string;
  message: string;
  unit_ids: string[];
  files: string[];
  evidence: Array<{ path: string; detail: string }>;
}

export interface BuildReviewCandidate {
  protocol: 'codex-build-contract-review' | 'codex-build-quality-review';
  role: 'contract' | 'quality';
  step_id: 'review:build';
  source_digest: string;
  receipt_set_digest: string;
  summary: string;
  findings: BuildReviewFinding[];
}

export interface BuildReviewResult extends StructuredGateResult {
  protocol: 'codex-build-review';
  verdict: 'pass' | 'fail';
  classification: 'pass' | 'semantic_review_failed';
  reason_codes: string[];
  failure_route: 'blocked' | null;
  summary: string;
  findings: BuildReviewFinding[];
  source_digest: string;
  receipt_set_digest: string;
  candidates: BuildReviewCandidate[];
}

export interface PublicState {
  protocol: typeof RESULT_PROTOCOL;
  verdict: 'pass' | 'blocked';
  workflow: Workflow;
  status: FlowStatus;
  current_step: FlowStep | null;
  cursor: number;
  total_steps: number;
  correction_counts: Record<string, number>;
  last_gate: GateReport | null;
  gate_reports: GateReport[];
  escalation: WorkflowEscalation | null;
  runtime_failure: RuntimeFailure | null;
  ship_authorization_revoked: boolean;
  gate?: GateReport;
}

export interface CorrectionContext {
  attempt: number;
  max_attempts: number;
  gate: GateReport;
}

export type FlowDirective =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'blocked' }
  | {
      kind: 'run-actor';
      step_id: string;
      binding: ActorBinding;
      outcome: string;
      contract: string | null;
      tests: Array<{ id: string; name: string }>;
      files: string[];
      verification: ActorVerification;
      screenshots?: Array<ScreenshotSpec & { path: string }>;
      correction: CorrectionContext | null;
      solidify: SolidifyContext | null;
    }
  | RunActionDirective
  | {
      kind: 'run-review';
      step_id: 'review:build';
      input: BuildReviewInput;
    }
  | {
      kind: 'run-gate';
      step_id: string;
    };

export interface CommandResult {
  result: PublicState | FlowDescription;
  exitCode: number;
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
  input_template?: Record<string, unknown>;
  execution?: {
    source_of_truth: 'public-issue-plan' | 'direct-request';
    compiled: true;
    persisted: true;
  };
  cli_contracts: {
    reports: Array<{ protocol: string; command: string }>;
  };
}
