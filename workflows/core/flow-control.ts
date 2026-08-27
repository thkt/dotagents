#!/usr/bin/env node

// Shared deterministic controller for the code and build skills.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DESCRIPTION_PROTOCOL,
  DIRECTIVE_PROTOCOL,
  GATE_PROTOCOL,
  MANIFEST_PROTOCOL,
  RESULT_PROTOCOL,
  STATE_PROTOCOL,
  type ActionStep,
  type ActionName,
  type ActorRole,
  type ActorStep,
  type Calibration,
  type CommandResult,
  type FlowDirective,
  type FlowDescription,
  type FlowManifest,
  type FlowState,
  type FlowStatus,
  type FlowStep,
  type GateOptions,
  type GateReport,
  type GateSpec,
  type GateStep,
  type PublicState,
  type RepoSnapshot,
  type ReportResult,
  type RepositoryInvariant,
  type StepDescription,
  type Workflow,
} from './contracts.ts';
import { parseArgs as parseGateArgs, runVerification } from './verify-command.ts';
import {
  defaultWorkflowStateDirectory,
  isMainModule,
} from '../../runtime/paths.ts';

const DEFAULT_STATE_DIR = defaultWorkflowStateDirectory();
const STEP_KINDS = new Set<FlowStep['kind']>(['actor', 'action', 'gate']);
const ACTIONS = new Set<ActionName>(['branch', 'commit', 'ship']);
const UNIT_ACTOR = /^(U-\d{3}):(red|green|direct)$/;
const CLEANUP_ACTOR = /^cleanup:[A-Za-z0-9._-]+$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHELL_CONTROL = /(?:\r|\n|&&|\|\||[;|`<>]|\$\()/u;
const BUILD_OPENING_IDS = ['load:plan', 'revalidate:plan', 'branch', 'branch:verify'] as const;
type NonterminalDirectiveKind = Exclude<FlowDirective['kind'], 'done' | 'ship-ready' | 'blocked'>;
const REPORT_RESULTS = {
  'run-actor': 'actor-completed',
  'run-action': 'action-completed',
  'calibrate-gate': 'calibrate',
  'seal-gate': 'seal',
  'run-gate': 'verify',
} as const satisfies Record<NonterminalDirectiveKind, ReportResult>;

class FlowError extends Error {
  readonly code: string;

  constructor(message: string, code = 'usage_error') {
    super(message);
    this.code = code;
  }
}

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function singletonArgs(argv: string[]): { command: string; args: Record<string, string> } {
  const args: Record<string, string> = Object.create(null);
  const command = argv[0];
  if (!command) throw new FlowError('command is required');
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/.test(flag || '')) throw new FlowError(`invalid flag: ${flag || ''}`);
    if (value === undefined || value === '') throw new FlowError(`missing value for ${flag}`);
    if (Object.hasOwn(args, flag)) throw new FlowError(`${flag} may be provided only once`);
    args[flag] = value;
  }
  return { command, args };
}

function stateDirectory(): string {
  return process.env.CODEX_FLOW_STATE_DIR || DEFAULT_STATE_DIR;
}

function statePath(runId: string): string {
  if (!runId || runId.length > 256) throw new FlowError('--run-id is required');
  const key = crypto.createHash('sha256').update(runId).digest('hex');
  return path.join(stateDirectory(), `${key}.json`);
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof FlowError
    ? error.code
    : error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
}

function readJson(file: string, label: string): unknown {
  if (!path.isAbsolute(file)) throw new FlowError(`${label} must be absolute`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new FlowError(`${label} is not readable JSON: ${errorMessage(error)}`);
  }
}

function loadState(runId: string): { file: string; state: FlowState } {
  const file = statePath(runId);
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as FlowState;
    if (state.protocol !== STATE_PROTOCOL || state.run_id !== runId) {
      throw new FlowError('workflow state has an invalid protocol or run id', 'state_error');
    }
    return { file, state };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new FlowError('no workflow is active for this task', 'no_flow');
    if (error instanceof FlowError) throw error;
    throw new FlowError(`workflow state is unreadable: ${errorMessage(error)}`, 'state_error');
  }
}

function gitRoot(repo: string): string {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new FlowError('manifest repo must be a Git worktree');
  return fs.realpathSync(result.stdout.trim());
}

function gitOutput(repo: string, args: string[], label: string): Buffer {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: null });
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new FlowError(`${label} failed${detail ? `: ${detail}` : ''}`, 'state_error');
  }
  return Buffer.from(result.stdout || '');
}

function gitText(repo: string, args: string[], label: string): string {
  return gitOutput(repo, args, label).toString('utf8').trim();
}

function gitOptionalText(repo: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function nulPaths(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function changedPaths(repo: string): string[] {
  const paths = new Set([
    ...nulPaths(gitOutput(repo, ['diff', '--name-only', '-z'], 'worktree diff')),
    ...nulPaths(gitOutput(repo, ['diff', '--cached', '--name-only', '-z'], 'index diff')),
    ...nulPaths(gitOutput(repo, ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked scan')),
  ]);
  return [...paths].sort();
}

function worktreeFingerprint(repo: string, relative: string): string {
  const absolute = path.resolve(repo, relative);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(absolute)}`;
    if (stat.isFile()) {
      return `file:${stat.mode & 0o777}:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
    }
    return `other:${stat.mode & 0o777}`;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

function repoSnapshot(repo: string): RepoSnapshot {
  return Object.fromEntries(changedPaths(repo).map((relative) => {
    const index = gitOutput(repo, ['ls-files', '-s', '-z', '--', relative], 'index fingerprint').toString('base64');
    return [relative, `${worktreeFingerprint(repo, relative)}:${index}`];
  }));
}

function repositoryInvariant(repo: string): RepositoryInvariant {
  return {
    head: gitOptionalText(repo, ['rev-parse', 'HEAD']),
    branch: gitOptionalText(repo, ['branch', '--show-current']),
    changes: repoSnapshot(repo),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotChanges(before: RepoSnapshot | null | undefined, after: RepoSnapshot | null | undefined): string[] {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((relative) => before?.[relative] !== after?.[relative])
    .sort();
}

function safeRelativeFile(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0')) {
    throw new FlowError(`${label} must be a non-empty repo-relative path`);
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new FlowError(`${label} escapes the repository`);
  }
  return normalized;
}

function failureRouteForOwner(owner: unknown): string | null {
  if (owner === undefined) return null;
  if (typeof owner !== 'string') throw new FlowError('gate.owner must be an actor id');
  const unitActor = UNIT_ACTOR.exec(owner);
  if (unitActor) return `${unitActor[2]}:${unitActor[1]}`;
  if (CLEANUP_ACTOR.test(owner)) return owner;
  throw new FlowError(`gate.owner must name a supported actor: ${owner}`);
}

function validateGate(step: Record<string, any>, repo: string): GateSpec {
  if (!object(step.gate)) throw new FlowError(`${step.id}.gate must be an object`);
  const gate = step.gate;
  if (typeof gate.command !== 'string' || !gate.command.trim()) {
    throw new FlowError(`${step.id}.gate.command is required`);
  }
  if (SHELL_CONTROL.test(gate.command)) {
    throw new FlowError(`${step.id}.gate.command must be one command without shell control operators`);
  }
  const calibration = gate.calibrate === true;
  if (calibration && gate.expect !== 'fail') {
    throw new FlowError(`${step.id}.gate.calibrate requires expect: fail`);
  }
  if (calibration && (gate.require_output || []).length) {
    throw new FlowError(`${step.id}.gate calibrates its output anchor at runtime`);
  }
  const derivedFailureRoute = failureRouteForOwner(step.owner);
  if (derivedFailureRoute && gate.failure_route !== undefined && gate.failure_route !== derivedFailureRoute) {
    throw new FlowError(`${step.id}.gate.failure_route conflicts with owner ${step.owner}`);
  }
  const failureRoute = derivedFailureRoute || gate.failure_route;
  if (typeof failureRoute !== 'string') {
    throw new FlowError(`${step.id}.gate.failure_route is required for a fail-closed gate`);
  }
  const gateArgv = [
    '--gate-id', step.id,
    '--failure-route', failureRoute,
    '--cwd', repo,
    '--expect', gate.expect,
    '--command', gate.command,
  ];
  if (gate.timeout_ms !== undefined) gateArgv.push('--timeout-ms', String(gate.timeout_ms));
  for (const value of calibration ? ['calibration-placeholder'] : gate.require_output || []) {
    gateArgv.push('--require-output', value);
  }
  for (const value of gate.forbid_output || []) gateArgv.push('--forbid-output', value);
  try {
    parseGateArgs(gateArgv);
  } catch (error) {
    throw new FlowError(`${step.id}.gate is invalid: ${errorMessage(error)}`);
  }
  return {
    command: gate.command,
    expect: gate.expect,
    failure_route: failureRoute,
    calibrate: calibration,
    timeout_ms: gate.timeout_ms,
    require_output: gate.require_output || [],
    forbid_output: gate.forbid_output || [],
  };
}

function unitStepIds(unit: string, roles: ActorRole[], workflow: Workflow): string[] {
  const ids = roles.flatMap((role) => [`${unit}:${role}`, `${unit}:${role}:gate`]);
  if (workflow === 'build') ids.push(`${unit}:artifacts`, `${unit}:commit`, `${unit}:commit:verify`);
  return ids;
}

function validateSequence(manifest: FlowManifest, steps: FlowStep[]): void {
  const correctionTargets = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'actor') correctionTargets.set(step.id, index);
    if (step.kind !== 'actor') continue;
    const next = steps[index + 1];
    if (!next || next.kind !== 'gate' || next.owner !== step.id) {
      throw new FlowError(`${step.id} must be followed immediately by an owned gate`);
    }
    if (next.id !== `${step.id}:gate`) {
      throw new FlowError(`${step.id} must be followed by ${step.id}:gate`);
    }
  }
  for (const [index, step] of steps.entries()) {
    if (step.kind !== 'gate' || step.owner === undefined) continue;
    const ownerIndex = correctionTargets.get(step.owner);
    if (ownerIndex === undefined || ownerIndex >= index) {
      throw new FlowError(`${step.id}.owner must name an earlier actor`);
    }
  }

  const baseline = steps.findIndex((step) => step.kind === 'gate' && step.id.startsWith('baseline:'));
  const firstActor = steps.findIndex((step) => step.kind === 'actor');
  const final = steps.findIndex((step) => step.kind === 'gate' && step.id.startsWith('final:'));
  if (baseline < 0 || firstActor < 0 || baseline > firstActor) {
    throw new FlowError('a baseline:* gate must precede the first actor');
  }
  if (final < 0 || final < firstActor) throw new FlowError('a final:* gate must follow all actors');
  if (steps.slice(final + 1).some((step) => step.kind === 'actor')) {
    throw new FlowError('no actor may run after final gates begin');
  }
  for (const step of steps.filter((item) => item.kind === 'gate')) {
    if (/^(?:baseline:|final:)/.test(step.id) && step.owner !== undefined) {
      throw new FlowError(`${step.id} must be fail-closed`);
    }
  }

  const unitRoles = new Map<string, ActorRole[]>();
  for (const step of steps.filter((item) => item.kind === 'actor' && UNIT_ACTOR.test(item.id))) {
    const match = UNIT_ACTOR.exec(step.id);
    if (!match) continue;
    const unit = match[1];
    const role = match[2] as ActorRole;
    const roles = unitRoles.get(unit) || [];
    roles.push(role);
    unitRoles.set(unit, roles);
  }
  if (!unitRoles.size) throw new FlowError('at least one U-NNN actor is required');
  if (manifest.workflow === 'build') {
    const opening = steps.slice(0, BUILD_OPENING_IDS.length).map((step) => step.id);
    if (opening.join(',') !== BUILD_OPENING_IDS.join(',')) {
      throw new FlowError('build must start with load:plan, revalidate:plan, branch, branch:verify');
    }
  }
  for (const [unit, roles] of unitRoles) {
    const shape = roles.join(',');
    if (shape !== 'red,green' && shape !== 'direct') {
      throw new FlowError(`${unit} actor order must be red,green or direct`);
    }
    const start = steps.findIndex((step) => step.id === `${unit}:${roles[0]}`);
    const expected = unitStepIds(unit, roles, manifest.workflow);
    const actual = steps.slice(start, start + expected.length).map((step) => step.id);
    if (actual.join(',') !== expected.join(',')) {
      throw new FlowError(`${unit} must use its contiguous ${manifest.workflow} unit sequence`);
    }
  }

  if (manifest.workflow === 'build') {
    for (const required of ['load:plan', 'revalidate:plan', 'branch:verify']) {
      if (!steps.some((step) => step.kind === 'gate' && step.id === required)) {
        throw new FlowError(`build requires the ${required} gate`);
      }
    }
    if (!steps.some((step) => step.id === 'branch' && step.kind === 'action' && step.action === 'branch')) {
      throw new FlowError('build requires a branch action');
    }
    for (const id of ['load:plan', 'revalidate:plan', 'branch:verify']) {
      const requiredGate = steps.find((step): step is GateStep => step.kind === 'gate' && step.id === id);
      if (!requiredGate || requiredGate.owner !== undefined) {
        throw new FlowError(`${id} must be fail-closed`);
      }
    }
    for (const unit of unitRoles.keys()) {
      const roles = unitRoles.get(unit);
      if (!roles) throw new FlowError(`${unit} has no actor roles`);
      const owner = roles.includes('green') ? `${unit}:green` : `${unit}:direct`;
      const artifacts = steps.find((step): step is GateStep => step.kind === 'gate' && step.id === `${unit}:artifacts`);
      if (!artifacts || artifacts.owner !== owner) {
        throw new FlowError(`${unit}:artifacts must be owned by ${owner}`);
      }
      const commit = steps.find((step): step is ActionStep => step.kind === 'action' && step.id === `${unit}:commit`);
      if (!commit || commit.action !== 'commit') {
        throw new FlowError(`${unit}:commit must use the commit action`);
      }
      const commitVerification = steps.find(
        (step): step is GateStep => step.kind === 'gate' && step.id === `${unit}:commit:verify`,
      );
      if (!commitVerification || commitVerification.owner !== undefined) {
        throw new FlowError(`${unit}:commit:verify must be fail-closed`);
      }
    }
    const ship = steps.find((step) => step.kind === 'action' && step.action === 'ship');
    if (manifest.shipping_authorized && !ship) {
      throw new FlowError('shipping_authorized requires a ship action');
    }
    if (ship && !manifest.shipping_authorized) {
      throw new FlowError('a ship action requires shipping_authorized: true');
    }
    if (ship) {
      if (ship.id !== 'ship') throw new FlowError('ship action id must be ship');
      const shipIndex = steps.indexOf(ship);
      const verification = steps[shipIndex + 1];
      if (!verification || verification.kind !== 'gate' || verification.id !== 'ship:verify') {
        throw new FlowError('ship must be followed by ship:verify');
      }
      if (verification.owner !== undefined) throw new FlowError('ship:verify must be fail-closed');
      if (steps.at(-1) !== verification) throw new FlowError('ship:verify must be the final step');
    }
  } else if (steps.some((step) => step.kind === 'action')) {
    throw new FlowError('code workflow does not accept action steps');
  }
}

function validateManifest(raw: unknown): FlowManifest {
  if (!object(raw) || raw.protocol !== MANIFEST_PROTOCOL) {
    throw new FlowError(`manifest.protocol must be ${MANIFEST_PROTOCOL}`);
  }
  if (raw.workflow !== 'code' && raw.workflow !== 'build') {
    throw new FlowError('manifest.workflow must be code or build');
  }
  if (typeof raw.repo !== 'string' || !path.isAbsolute(raw.repo)) {
    throw new FlowError('manifest.repo must be absolute');
  }
  const repo = gitRoot(raw.repo);
  if (fs.realpathSync(raw.repo) !== repo) throw new FlowError('manifest.repo must equal the Git root');
  const maxCorrections = raw.max_corrections === undefined ? 3 : Number(raw.max_corrections);
  if (!Number.isInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > 20) {
    throw new FlowError('max_corrections must be an integer from 0 to 20');
  }
  if (!Array.isArray(raw.steps) || !raw.steps.length) throw new FlowError('manifest.steps is required');

  const ids = new Set<string>();
  const steps: FlowStep[] = raw.steps.map((item: unknown, index: number): FlowStep => {
    if (!object(item) || !SAFE_ID.test(item.id || '')) throw new FlowError(`steps[${index}].id is invalid`);
    if (ids.has(item.id)) throw new FlowError(`duplicate step id: ${item.id}`);
    ids.add(item.id);
    if (!STEP_KINDS.has(item.kind as FlowStep['kind'])) throw new FlowError(`${item.id}.kind is invalid`);
    if (item.kind === 'actor') {
      if (!UNIT_ACTOR.test(item.id) && !CLEANUP_ACTOR.test(item.id)) {
        throw new FlowError(`${item.id} is not a supported actor id`);
      }
      if (!Array.isArray(item.files) || !item.files.length) {
        throw new FlowError(`${item.id}.files must be a non-empty array`);
      }
      return {
        id: item.id,
        kind: 'actor',
        files: item.files.map((file: unknown, i: number) => safeRelativeFile(file, `${item.id}.files[${i}]`)),
      };
    }
    if (item.kind === 'action') {
      if (!ACTIONS.has(item.action as ActionName)) throw new FlowError(`${item.id}.action is invalid`);
      if (item.action === 'branch') {
        if (typeof item.branch_name !== 'string' || !item.branch_name) {
          throw new FlowError(`${item.id}.branch_name is required`);
        }
        const checked = spawnSync('git', ['check-ref-format', '--branch', item.branch_name], { encoding: 'utf8' });
        if (checked.status !== 0) throw new FlowError(`${item.id}.branch_name is invalid`);
        if (!/^[0-9a-f]{40,64}$/.test(item.start_point || '')) {
          throw new FlowError(`${item.id}.start_point must be a full commit id`);
        }
        const resolved = gitText(repo, ['rev-parse', `${item.start_point}^{commit}`], `${item.id}.start_point lookup`);
        if (resolved !== item.start_point) throw new FlowError(`${item.id}.start_point is not canonical`);
        const exists = spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${item.branch_name}`]);
        if (exists.status === 0) throw new FlowError(`${item.id}.branch_name already exists`);
        return {
          id: item.id,
          kind: 'action',
          action: 'branch',
          branch_name: item.branch_name,
          start_point: item.start_point,
        };
      }
      return { id: item.id, kind: 'action', action: item.action as 'commit' | 'ship' };
    }
    return {
      id: item.id,
      kind: 'gate',
      owner: item.owner,
      gate: validateGate(item, repo),
    };
  });

  const manifest: FlowManifest = {
    protocol: MANIFEST_PROTOCOL,
    workflow: raw.workflow,
    repo,
    max_corrections: maxCorrections,
    shipping_authorized: raw.shipping_authorized === true,
    steps,
  };
  validateSequence(manifest, steps);
  return manifest;
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
  const current = state.manifest.steps[state.cursor] || null;
  return {
    protocol: RESULT_PROTOCOL,
    verdict: state.status === 'blocked' ? 'blocked' : 'pass',
    workflow: state.workflow,
    status: state.status,
    current_step: current,
    cursor: state.cursor,
    total_steps: state.manifest.steps.length,
    manifest_hash: state.manifest_hash,
    correction_counts: state.correction_counts,
    sealed_gates: state.sealed_gates,
    last_gate: state.last_gate || null,
  };
}

function save(file: string, state: FlowState): PublicState {
  atomicWrite(file, state);
  return publicState(state);
}

function start(runId: string, manifestFile: string): PublicState {
  const manifest = validateManifest(readJson(manifestFile, '--manifest'));
  const file = statePath(runId);
  if (fs.existsSync(file)) {
    const existing = loadState(runId).state;
    if (existing.status === 'running') throw new FlowError('a workflow is already active for this task', 'state_error');
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
    history: [],
    last_gate: null,
    workflow_baseline: repoSnapshot(manifest.repo),
    actor_baseline: null,
    action_baseline: null,
  };
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
  if (step.id !== stepId) throw new FlowError(`expected step ${step.id}, received ${stepId}`, 'order_error');
  if (!kinds.includes(step.kind as T)) {
    throw new FlowError(`${step.id} is ${step.kind}, not ${kinds.join('/')}`, 'order_error');
  }
  return step as Extract<FlowStep, { kind: T }>;
}

function advance(state: FlowState): void {
  state.cursor += 1;
  state.status = terminalStatus(state);
  prepareCurrentStep(state);
}

function prepareCurrentStep(state: FlowState): void {
  const current = state.manifest.steps[state.cursor];
  state.actor_baseline = current?.kind === 'actor' ? repoSnapshot(state.manifest.repo) : null;
  state.action_baseline = current?.kind === 'action'
    ? repositoryInvariant(state.manifest.repo)
    : null;
}

function actorScopeChanges(state: FlowState): {
  step: ActorStep | null;
  changed: string[];
  outside: string[];
} {
  const step = state.manifest.steps[state.cursor];
  if (!step || step.kind !== 'actor') return { step: null, changed: [], outside: [] };
  if (!object(state.actor_baseline)) throw new FlowError(`${step.id} has no entry snapshot`, 'state_error');
  const changed = snapshotChanges(state.actor_baseline, repoSnapshot(state.manifest.repo));
  const allowed = new Set(step.files);
  return { step, changed, outside: changed.filter((relative) => !allowed.has(relative)) };
}

function unitFiles(state: FlowState, unit: string): string[] {
  return [...new Set(state.manifest.steps
    .filter((step): step is ActorStep => step.kind === 'actor' && step.id.startsWith(`${unit}:`))
    .flatMap((step) => step.files))];
}

function validateActionCompletion(state: FlowState, step: ActionStep): void {
  if (!object(state.action_baseline)) throw new FlowError(`${step.id} has no entry snapshot`, 'state_error');
  const current = repositoryInvariant(state.manifest.repo);
  if (step.action === 'branch') {
    if (current.branch !== step.branch_name || current.head !== step.start_point) {
      throw new FlowError(`${step.id} did not reach ${step.branch_name} at ${step.start_point}`, 'postcondition_error');
    }
    if (!sameValue(current.changes, state.workflow_baseline)) {
      throw new FlowError(`${step.id} changed the workflow baseline files`, 'postcondition_error');
    }
  }
  if (step.action === 'commit') {
    const unit = /^(U-\d{3}):commit$/.exec(step.id)?.[1];
    if (!unit) throw new FlowError(`${step.id} is not a unit commit`, 'postcondition_error');
    if (current.head === state.action_baseline.head) {
      throw new FlowError(`${step.id} did not create a commit`, 'postcondition_error');
    }
    const parent = gitText(state.manifest.repo, ['rev-parse', 'HEAD^'], `${step.id} parent lookup`);
    if (parent !== state.action_baseline.head) {
      throw new FlowError(`${step.id} must create exactly one commit on the verified HEAD`, 'postcondition_error');
    }
    const committed = nulPaths(gitOutput(
      state.manifest.repo,
      ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'],
      `${step.id} path lookup`,
    ));
    const allowed = new Set(unitFiles(state, unit));
    const outside = committed.filter((relative) => !allowed.has(relative));
    if (!committed.length || outside.length) {
      throw new FlowError(`${step.id} committed paths outside its unit: ${outside.join(', ') || 'empty commit'}`, 'scope_error');
    }
    if (!sameValue(current.changes, state.workflow_baseline)) {
      throw new FlowError(`${step.id} did not restore the workflow baseline dirty state`, 'postcondition_error');
    }
  }
}

function completeStep(runId: string, stepId: string): PublicState {
  const { file, state } = loadState(runId);
  const step = requireStep(state, stepId, ['actor', 'action']);
  if (step.kind === 'actor') {
    const scope = actorScopeChanges(state);
    if (scope.outside.length) {
      throw new FlowError(`${step.id} changed files outside its declared scope: ${scope.outside.join(', ')}`, 'scope_error');
    }
  }
  if (step.kind === 'action') validateActionCompletion(state, step);
  if (step.kind === 'action' && step.action === 'ship' && !state.manifest.shipping_authorized) {
    throw new FlowError('shipping is not authorized', 'authorization_error');
  }
  state.history.push({ step_id: step.id, kind: step.kind, verdict: 'pass' });
  advance(state);
  return save(file, state);
}

function gateArgs(step: GateStep, repo: string, requiredOutput = step.gate.require_output): string[] {
  const gate = step.gate;
  const argv = [
    '--gate-id', step.id,
    '--failure-route', gate.failure_route,
    '--cwd', repo,
    '--expect', gate.expect,
    '--command', gate.command,
  ];
  if (gate.timeout_ms !== undefined) argv.push('--timeout-ms', String(gate.timeout_ms));
  for (const value of requiredOutput) argv.push('--require-output', value);
  for (const value of gate.forbid_output) argv.push('--forbid-output', value);
  return argv;
}

function runGate(runId: string, stepId: string): { result: PublicState; exitCode: number } {
  const { file, state } = loadState(runId);
  const step = requireStep(state, stepId, ['gate']);
  const sealed = state.sealed_gates[step.id];
  if (step.gate.calibrate && !sealed) {
    throw new FlowError(`${step.id} must be calibrated and sealed before its official gate`, 'order_error');
  }
  const options = parseGateArgs(gateArgs(step, state.manifest.repo, sealed || step.gate.require_output));
  const before = repositoryInvariant(state.manifest.repo);
  let { report } = runVerification(options);
  const after = repositoryInvariant(state.manifest.repo);
  if (!sameValue(before, after)) {
    report = {
      ...report,
      verdict: 'blocked',
      classification: 'gate_mutated_repository',
      reason_codes: ['gate_mutated_repository', ...(report.reason_codes || [])],
      failure_route: 'blocked',
    };
  }
  state.last_gate = report;
  state.history.push({ step_id: step.id, kind: 'gate', verdict: report.verdict });
  if (report.verdict === 'pass') {
    advance(state);
  } else if (report.verdict === 'blocked' || !step.owner) {
    state.status = 'blocked';
  } else {
    const correction = (state.correction_counts[step.id] || 0) + 1;
    state.correction_counts[step.id] = correction;
    if (correction > state.manifest.max_corrections) {
      state.status = 'blocked';
      state.actor_baseline = null;
    } else {
      state.cursor = state.manifest.steps.findIndex((candidate) => candidate.id === step.owner);
      prepareCurrentStep(state);
    }
  }
  const result = save(file, state);
  result.gate = report;
  return { result, exitCode: report.verdict === 'pass' ? 0 : state.status === 'blocked' ? 2 : 1 };
}

function runCalibration(runId: string, stepId: string): { result: PublicState; exitCode: number } {
  const { file, state } = loadState(runId);
  const step = requireStep(state, stepId, ['gate']);
  if (!step.gate.calibrate) throw new FlowError(`${step.id} is not a calibration gate`, 'order_error');
  if (state.sealed_gates[step.id]) throw new FlowError(`${step.id} is already sealed`, 'order_error');
  const options: GateOptions = {
    gateId: step.id,
    failureRoute: step.gate.failure_route,
    cwd: state.manifest.repo,
    expect: 'fail',
    command: step.gate.command,
    timeoutMs: step.gate.timeout_ms || 60_000,
    tailBytes: 12_000,
    requiredOutput: [],
    forbiddenOutput: step.gate.forbid_output,
  };
  const before = repositoryInvariant(state.manifest.repo);
  let { report } = runVerification(options);
  const after = repositoryInvariant(state.manifest.repo);
  if (!sameValue(before, after)) {
    report = {
      ...report,
      verdict: 'blocked',
      classification: 'gate_mutated_repository',
      reason_codes: ['gate_mutated_repository', ...(report.reason_codes || [])],
      failure_route: 'blocked',
    };
  }
  state.last_gate = { ...report, classification: `calibration_${report.classification}` };
  if (report.verdict !== 'pass') {
    state.status = report.verdict === 'blocked' ? 'blocked' : state.status;
    if (report.verdict === 'fail' && step.owner) {
      const correction = (state.correction_counts[step.id] || 0) + 1;
      state.correction_counts[step.id] = correction;
      if (correction > state.manifest.max_corrections) state.status = 'blocked';
      else {
        state.cursor = state.manifest.steps.findIndex((candidate) => candidate.id === step.owner);
        prepareCurrentStep(state);
      }
    }
    const result = save(file, state);
    result.gate = state.last_gate;
    return { result, exitCode: state.status === 'blocked' ? 2 : 1 };
  }
  state.calibrations[step.id] = {
    command: step.gate.command,
    exit_code: report.exit_code,
    stdout_tail: report.stdout_tail,
    stderr_tail: report.stderr_tail,
  };
  const result = save(file, state);
  result.calibration = state.calibrations[step.id];
  return { result, exitCode: 0 };
}

function sealGate(runId: string, stepId: string, requiredOutput: string | undefined): PublicState {
  const { file, state } = loadState(runId);
  const step = requireStep(state, stepId, ['gate']);
  if (!step.gate.calibrate) throw new FlowError(`${step.id} is not a calibration gate`, 'order_error');
  if (typeof requiredOutput !== 'string' || !requiredOutput.trim() || requiredOutput.length > 2000) {
    throw new FlowError('--require-output must be a non-empty literal of at most 2000 characters');
  }
  const calibration = state.calibrations[step.id];
  if (!calibration) throw new FlowError(`${step.id} has no calibration result`, 'order_error');
  const combined = `${calibration.stdout_tail}\n${calibration.stderr_tail}`;
  if (!combined.includes(requiredOutput)) {
    throw new FlowError('--require-output was not present in the calibration output', 'evidence_error');
  }
  state.sealed_gates[step.id] = [requiredOutput];
  delete state.calibrations[step.id];
  return save(file, state);
}

function status(runId: string): PublicState {
  return publicState(loadState(runId).state);
}

function nextDirectiveFromState(state: FlowState): FlowDirective {
  if (state.status === 'completed') {
    return { protocol: DIRECTIVE_PROTOCOL, kind: 'done', workflow: state.workflow };
  }
  if (state.status === 'ship-ready') {
    return { protocol: DIRECTIVE_PROTOCOL, kind: 'ship-ready', workflow: state.workflow };
  }
  if (state.status === 'blocked') {
    return {
      protocol: DIRECTIVE_PROTOCOL,
      kind: 'blocked',
      workflow: state.workflow,
      gate: state.last_gate || null,
    };
  }
  const step = state.manifest.steps[state.cursor];
  if (!step) throw new FlowError('running workflow has no current step', 'state_error');
  if (step.kind === 'actor') {
    return {
      protocol: DIRECTIVE_PROTOCOL,
      kind: 'run-actor',
      workflow: state.workflow,
      step_id: step.id,
      files: step.files,
      report_result: REPORT_RESULTS['run-actor'],
    };
  }
  if (step.kind === 'action') {
    return {
      protocol: DIRECTIVE_PROTOCOL,
      kind: 'run-action',
      workflow: state.workflow,
      step_id: step.id,
      action: step.action,
      parameters: actionParameters(state, step),
      report_result: REPORT_RESULTS['run-action'],
    };
  }
  if (step.gate.calibrate && !state.sealed_gates[step.id]) {
    const calibration = state.calibrations[step.id];
    if (!calibration) {
      return {
        protocol: DIRECTIVE_PROTOCOL,
        kind: 'calibrate-gate',
        workflow: state.workflow,
        step_id: step.id,
        command: step.gate.command,
        report_result: REPORT_RESULTS['calibrate-gate'],
      };
    }
    return {
      protocol: DIRECTIVE_PROTOCOL,
      kind: 'seal-gate',
      workflow: state.workflow,
      step_id: step.id,
      calibration,
      report_result: REPORT_RESULTS['seal-gate'],
      evidence_source: 'calibration-literal',
    };
  }
  return {
    protocol: DIRECTIVE_PROTOCOL,
    kind: 'run-gate',
    workflow: state.workflow,
    step_id: step.id,
    gate: {
      command: step.gate.command,
      expect: step.gate.expect,
      failure_route: step.gate.failure_route,
      require_output: state.sealed_gates[step.id] || step.gate.require_output,
      forbid_output: step.gate.forbid_output,
    },
    report_result: REPORT_RESULTS['run-gate'],
  };
}

function actionParameters(state: FlowState, step: ActionStep): Record<string, unknown> {
  if (step.action === 'branch') {
    return { branch_name: step.branch_name, start_point: step.start_point };
  }
  if (step.action === 'commit') {
    const unit = /^(U-\d{3}):commit$/.exec(step.id)?.[1];
    return { files: unit ? unitFiles(state, unit) : [] };
  }
  return {};
}

function nextDirective(runId: string): FlowDirective {
  return validateDirective(nextDirectiveFromState(loadState(runId).state));
}

function validateDirective(directive: unknown): FlowDirective {
  if (!object(directive) || directive.protocol !== DIRECTIVE_PROTOCOL) {
    throw new FlowError(`directive.protocol must be ${DIRECTIVE_PROTOCOL}`, 'state_error');
  }
  if (directive.workflow !== 'code' && directive.workflow !== 'build') {
    throw new FlowError('directive.workflow is invalid', 'state_error');
  }
  const shapes: Record<string, string[]> = {
    done: [],
    'ship-ready': [],
    blocked: ['gate'],
    'run-actor': ['step_id', 'files', 'report_result'],
    'run-action': ['step_id', 'action', 'parameters', 'report_result'],
    'calibrate-gate': ['step_id', 'command', 'report_result'],
    'seal-gate': ['step_id', 'calibration', 'report_result', 'evidence_source'],
    'run-gate': ['step_id', 'gate', 'report_result'],
  };
  const fields = typeof directive.kind === 'string' ? shapes[directive.kind] : undefined;
  if (!fields) throw new FlowError('directive.kind is invalid', 'state_error');
  const allowed = new Set(['protocol', 'kind', 'workflow', ...fields]);
  const unknown = Object.keys(directive).filter((key) => !allowed.has(key));
  if (unknown.length) throw new FlowError(`directive has unknown fields: ${unknown.join(', ')}`, 'state_error');
  for (const field of fields) {
    if (!Object.hasOwn(directive, field)) throw new FlowError(`directive.${field} is required`, 'state_error');
  }
  if (directive.step_id !== undefined && !SAFE_ID.test(directive.step_id)) {
    throw new FlowError('directive.step_id is invalid', 'state_error');
  }
  if (directive.kind === 'run-actor' && !Array.isArray(directive.files)) {
    throw new FlowError('directive.files must be an array', 'state_error');
  }
  if (directive.kind === 'run-action') {
    if (!ACTIONS.has(directive.action as ActionName) || !object(directive.parameters)) {
      throw new FlowError('directive action contract is invalid', 'state_error');
    }
    const parameterShapes: Record<ActionName, string[]> = {
      branch: ['branch_name', 'start_point'],
      commit: ['files'],
      ship: [],
    };
    const parameterFields = parameterShapes[directive.action as ActionName];
    const unknownParameters = Object.keys(directive.parameters)
      .filter((key) => !parameterFields.includes(key));
    if (unknownParameters.length || parameterFields.some((key) => !Object.hasOwn(directive.parameters, key))) {
      throw new FlowError('directive.parameters has an invalid shape', 'state_error');
    }
  }
  const expectedReport = REPORT_RESULTS[directive.kind as NonterminalDirectiveKind] as ReportResult | undefined;
  if (expectedReport !== undefined && directive.report_result !== expectedReport) {
    throw new FlowError('directive.report_result is invalid', 'state_error');
  }
  if (directive.kind === 'seal-gate' && directive.evidence_source !== 'calibration-literal') {
    throw new FlowError('directive.evidence_source is invalid', 'state_error');
  }
  return directive as FlowDirective;
}

function report(
  runId: string,
  stepId: string,
  result: string,
  evidence?: string,
): { result: PublicState; exitCode: number } {
  const directive = nextDirective(runId);
  if (!('step_id' in directive)) throw new FlowError(`cannot report against ${directive.kind}`, 'order_error');
  if (directive.step_id !== stepId) {
    throw new FlowError(`expected report for ${directive.step_id}, received ${stepId}`, 'order_error');
  }
  if (directive.kind === 'run-actor' && result === 'actor-completed') {
    return { result: completeStep(runId, stepId), exitCode: 0 };
  }
  if (directive.kind === 'run-action' && result === 'action-completed') {
    return { result: completeStep(runId, stepId), exitCode: 0 };
  }
  if (directive.kind === 'calibrate-gate' && result === 'calibrate') {
    return runCalibration(runId, stepId);
  }
  if (directive.kind === 'seal-gate' && result === 'seal') {
    return { result: sealGate(runId, stepId, evidence), exitCode: 0 };
  }
  if (directive.kind === 'run-gate' && result === 'verify') {
    return runGate(runId, stepId);
  }
  throw new FlowError(`directive ${directive.kind} does not accept result ${result}`, 'order_error');
}

function describe(workflow: Workflow): FlowDescription {
  const stepContracts: StepDescription[] = [
    {
      kind: 'actor',
      required: ['id', 'kind', 'files'],
      optional: [],
      derived: [],
      id_patterns: [UNIT_ACTOR.source, CLEANUP_ACTOR.source],
    },
    {
      kind: 'gate',
      required: ['id', 'kind', 'gate.command', 'gate.expect'],
      optional: [
        'owner',
        'gate.failure_route',
        'gate.calibrate',
        'gate.timeout_ms',
        'gate.require_output',
        'gate.forbid_output',
      ],
      derived: ['gate.failure_route:owner'],
    },
  ];
  if (workflow === 'build') {
    stepContracts.push({
      kind: 'action',
      required: ['id', 'kind', 'action'],
      optional: ['branch_name', 'start_point'],
      derived: [],
      actions: [...ACTIONS],
    });
  }
  const directiveKinds = Object.keys(REPORT_RESULTS) as NonterminalDirectiveKind[];
  return {
    protocol: DESCRIPTION_PROTOCOL,
    workflow,
    protocols: {
      manifest: MANIFEST_PROTOCOL,
      directive: DIRECTIVE_PROTOCOL,
      result: RESULT_PROTOCOL,
      gate: GATE_PROTOCOL,
    },
    manifest_template: {
      protocol: MANIFEST_PROTOCOL,
      workflow,
      repo: '<absolute-git-root>',
      max_corrections: 3,
      shipping_authorized: false,
      steps: [],
    },
    step_contracts: stepContracts,
    sequence: {
      opening: workflow === 'build' ? [...BUILD_OPENING_IDS, 'baseline:*'] : ['baseline:*'],
      unit_modes: {
        red_green: unitStepIds('U-NNN', ['red', 'green'], workflow),
        direct: unitStepIds('U-NNN', ['direct'], workflow),
      },
      closing: workflow === 'build'
        ? ['final:*', 'ship?', 'ship:verify?']
        : ['final:*'],
    },
    directives: {
      reports: directiveKinds.map((kind) => ({
        kind,
        report_result: REPORT_RESULTS[kind],
        ...(kind === 'seal-gate' ? { evidence_source: 'calibration-literal' as const } : {}),
      })),
      terminal: ['done', 'ship-ready', 'blocked'],
    },
  };
}

interface ErrorResult {
  protocol: typeof RESULT_PROTOCOL;
  verdict: 'blocked';
  status: 'error';
  classification: string;
  error: string;
}

function errorResult(error: unknown): ErrorResult {
  return {
    protocol: RESULT_PROTOCOL,
    verdict: 'blocked',
    status: 'error',
    classification: errorCode(error) || 'execution_error',
    error: errorMessage(error),
  };
}

function commandArgs(
  args: Record<string, string>,
  allowed: string[],
  required: string[] = [],
): void {
  const accepted = new Set(['--run-id', ...allowed]);
  const unknown = Object.keys(args).filter((flag) => !accepted.has(flag));
  if (unknown.length) throw new FlowError(`unsupported flag: ${unknown.join(', ')}`);
  for (const flag of required) {
    if (!args[flag]) throw new FlowError(`${flag} is required`);
  }
}

function main(argv: string[] = process.argv.slice(2)): CommandResult {
  const { command, args } = singletonArgs(argv);
  if (command === 'describe') {
    commandArgs(args, ['--workflow'], ['--workflow']);
    const workflow = args['--workflow'];
    if (workflow !== 'code' && workflow !== 'build') {
      throw new FlowError('--workflow must be code or build');
    }
    return { result: describe(workflow), exitCode: 0 };
  }
  const runId = args['--run-id'];
  if (!runId) throw new FlowError('--run-id is required');
  if (command === 'start') {
    commandArgs(args, ['--manifest'], ['--manifest']);
    return { result: start(runId, args['--manifest']!), exitCode: 0 };
  }
  if (command === 'status') {
    commandArgs(args, []);
    return { result: status(runId), exitCode: 0 };
  }
  if (command === 'next') {
    commandArgs(args, []);
    return { result: nextDirective(runId), exitCode: 0 };
  }
  if (command === 'report') {
    commandArgs(args, ['--step', '--result', '--evidence'], ['--step', '--result']);
    return report(runId, args['--step']!, args['--result']!, args['--evidence']);
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  try {
    const { result, exitCode } = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error), null, 2)}\n`);
    process.exitCode = 2;
  }
}

export {
  DEFAULT_STATE_DIR,
  DESCRIPTION_PROTOCOL,
  DIRECTIVE_PROTOCOL,
  MANIFEST_PROTOCOL,
  RESULT_PROTOCOL,
  STATE_PROTOCOL,
  actorScopeChanges,
  changedPaths,
  completeStep,
  describe,
  errorResult,
  loadState,
  main,
  nextDirective,
  nextDirectiveFromState,
  publicState,
  report,
  runGate,
  runCalibration,
  safeRelativeFile,
  start,
  statePath,
  validateManifest,
  validateDirective,
  sealGate,
};
