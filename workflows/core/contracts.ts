export const MANIFEST_PROTOCOL = 'codex-flow-manifest/v1' as const;
export const STATE_PROTOCOL = 'codex-flow-state/v1' as const;
export const RESULT_PROTOCOL = 'codex-flow-control/v1' as const;
export const DIRECTIVE_PROTOCOL = 'codex-flow-directive/v2' as const;
export const GATE_PROTOCOL = 'codex-code-gate/v1' as const;
export const DESCRIPTION_PROTOCOL = 'codex-flow-description/v1' as const;

export type Workflow = 'code' | 'build';
export type FlowStatus = 'running' | 'completed' | 'ship-ready' | 'blocked';
export type GateExpectation = 'pass' | 'fail';
export type GateVerdict = 'pass' | 'fail' | 'blocked';
export type ActionName = 'branch' | 'commit' | 'ship';
export type ActorRole = 'red' | 'green' | 'direct';
export type ReportResult = 'actor-completed' | 'action-completed' | 'calibrate' | 'seal' | 'verify';

export interface GateSpec {
  command: string;
  expect: GateExpectation;
  failure_route: string;
  calibrate: boolean;
  timeout_ms?: number;
  require_output: string[];
  forbid_output: string[];
}

export interface ActorStep {
  id: string;
  kind: 'actor';
  files: string[];
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
  action: 'commit' | 'ship';
}

export type ActionStep = BranchActionStep | UnitActionStep;

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

export type RepoSnapshot = Record<string, string>;

export interface RepositoryInvariant {
  head: string | null;
  branch: string | null;
  changes: RepoSnapshot;
}

export interface Calibration {
  command: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

export interface GateCheck {
  kind: 'exit' | 'output_includes' | 'output_excludes';
  expected?: GateExpectation;
  actual?: number | null;
  signal?: NodeJS.Signals | null;
  value?: string;
  passed: boolean;
}

export interface GateReport {
  protocol: typeof GATE_PROTOCOL;
  gate_id: string;
  verdict: GateVerdict;
  classification: string;
  reason_codes: string[];
  failure_route: string | null;
  configured_failure_route: string;
  command: string;
  cwd: string;
  expected: GateExpectation;
  checks: GateCheck[];
  matches_expected_exit: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  execution_error: string | null;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
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
  history: Array<{ step_id: string; kind: FlowStep['kind']; verdict: GateVerdict }>;
  last_gate: GateReport | null;
  workflow_baseline: RepoSnapshot;
  actor_baseline: RepoSnapshot | null;
  action_baseline: RepositoryInvariant | null;
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
  gate?: GateReport;
  calibration?: Calibration;
}

export type FlowDirective =
  | { protocol: typeof DIRECTIVE_PROTOCOL; kind: 'done' | 'ship-ready'; workflow: Workflow }
  | { protocol: typeof DIRECTIVE_PROTOCOL; kind: 'blocked'; workflow: Workflow; gate: GateReport | null }
  | {
      protocol: typeof DIRECTIVE_PROTOCOL;
      kind: 'run-actor';
      workflow: Workflow;
      step_id: string;
      files: string[];
      report_result: 'actor-completed';
    }
  | {
      protocol: typeof DIRECTIVE_PROTOCOL;
      kind: 'run-action';
      workflow: Workflow;
      step_id: string;
      action: ActionName;
      parameters: Record<string, unknown>;
      report_result: 'action-completed';
    }
  | {
      protocol: typeof DIRECTIVE_PROTOCOL;
      kind: 'calibrate-gate';
      workflow: Workflow;
      step_id: string;
      command: string;
      report_result: 'calibrate';
    }
  | {
      protocol: typeof DIRECTIVE_PROTOCOL;
      kind: 'seal-gate';
      workflow: Workflow;
      step_id: string;
      calibration: Calibration;
      report_result: 'seal';
      evidence_source: 'calibration-literal';
    }
  | {
      protocol: typeof DIRECTIVE_PROTOCOL;
      kind: 'run-gate';
      workflow: Workflow;
      step_id: string;
      gate: Omit<GateSpec, 'calibrate' | 'timeout_ms'>;
      report_result: 'verify';
    };

export interface CommandResult {
  result: PublicState | FlowDirective | FlowDescription;
  exitCode: number;
}

export interface StepDescription {
  kind: FlowStep['kind'];
  required: string[];
  optional: string[];
  derived: string[];
  id_patterns?: string[];
  actions?: ActionName[];
}

export interface FlowDescription {
  protocol: typeof DESCRIPTION_PROTOCOL;
  workflow: Workflow;
  protocols: {
    manifest: typeof MANIFEST_PROTOCOL;
    directive: typeof DIRECTIVE_PROTOCOL;
    result: typeof RESULT_PROTOCOL;
    gate: typeof GATE_PROTOCOL;
  };
  manifest_template: {
    protocol: typeof MANIFEST_PROTOCOL;
    workflow: Workflow;
    repo: '<absolute-git-root>';
    max_corrections: 3;
    shipping_authorized: false;
    steps: [];
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
  directives: {
    reports: Array<{
      kind: Exclude<FlowDirective['kind'], 'done' | 'ship-ready' | 'blocked'>;
      report_result: ReportResult;
      evidence_source?: 'calibration-literal';
    }>;
    terminal: Array<'done' | 'ship-ready' | 'blocked'>;
  };
}
