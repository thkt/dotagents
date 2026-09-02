/** @file Outcome: Only closed manifests with safe scopes and valid workflow structure reach execution. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  gitRoot,
  gitText,
  nearestExistingParent,
  normalizeRepoPath,
  realpathInside,
} from '../shared/repository.ts';
import type {
  ActionName,
  ActionStep,
  ActorRole,
  FlowManifest,
  FlowStep,
  GateAuthority,
  GateSpec,
  GateStep,
  Workflow,
} from './contracts.ts';
import { MANIFEST_PROTOCOL, SAFE_ID } from './contracts.ts';
import { SHELL_CONTROL, shellCommand } from '../shared/command.ts';
import { FlowError, errorMessage } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys, stringArray, type JsonObject } from '../shared/schema.ts';
import { parseArgs as parseGateArgs } from './shell-gate.ts';

export const ACTIONS = new Set<ActionName>(['branch', 'commit', 'ship']);
export const UNIT_ACTOR = /^(U-\d{3}):(red|green|direct)$/u;
export const CLEANUP_ACTOR = /^cleanup:[A-Za-z0-9._-]+$/u;
export const BUILD_OPENING_IDS = ['load:plan', 'revalidate:plan', 'branch'] as const;
export const DEFAULT_MAX_CORRECTIONS = 3;
const GATE_AUTHORITIES = new Set<GateAuthority>([
  'shell',
  'build-plan',
  'build-revalidate',
  'build-artifacts',
  'build-review',
  'build-ship',
]);
const STEP_KINDS = new Set<FlowStep['kind']>(['actor', 'action', 'gate']);
const COMMIT_SUBJECT =
  /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9._/-]+\))?!?: [a-z0-9].*$/u;

function safeRelativeFile(value: unknown, label: string): string {
  const normalized = normalizeRepoPath(value);
  if (!normalized)
    throw new FlowError(`${label} must be a non-empty repo-relative path outside .git`);
  return normalized;
}

function validateActorFile(repo: string, value: unknown, label: string): string {
  const relative = safeRelativeFile(value, label);
  const absolute = path.resolve(repo, relative);
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new FlowError(`${label} must not be a symbolic link`);
  if (existing?.isDirectory()) throw new FlowError(`${label} must name a file`);
  const boundary = existing ? absolute : nearestExistingParent(absolute);
  if (!boundary || !realpathInside(repo, boundary)) {
    throw new FlowError(`${label} must stay inside the repository`);
  }
  const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--', relative]);
  if (ignored.status === 0) throw new FlowError(`${label} names an ignored path`);
  if (ignored.status !== 1)
    throw new FlowError(`${label} could not be checked against Git ignore rules`);
  return relative;
}

function failureRouteForOwner(owner: unknown): string | null {
  if (owner === undefined) return null;
  if (typeof owner !== 'string') throw new FlowError('gate.owner must be an actor id');
  const unitActor = UNIT_ACTOR.exec(owner);
  if (unitActor) return `${unitActor[2]}:${unitActor[1]}`;
  if (CLEANUP_ACTOR.test(owner)) return owner;
  throw new FlowError(`gate.owner must name a supported actor: ${owner}`);
}

function gateCommand(
  authority: GateAuthority,
  configured: unknown,
  { id, input, unitId, repo }: { id: string; input: unknown; unitId: unknown; repo: string },
): string {
  switch (authority) {
    case 'shell':
      return String(configured);
    case 'build-plan':
      return shellCommand('codex-build-plan', ['--input', String(input)]);
    case 'build-revalidate':
      return shellCommand('codex-build-revalidate', ['--input', String(input), '--repo', repo]);
    case 'build-artifacts':
      return shellCommand('codex-build-artifacts', [
        '--gate-id',
        id,
        '--unit',
        String(unitId),
        '--input',
        String(input),
        '--repo',
        repo,
      ]);
    case 'build-review':
      return 'codex-build-review';
    case 'build-ship':
      return 'codex-build-ship-verify';
  }
}

function validateGate(step: JsonObject, id: string, repo: string): GateSpec {
  if (!isObject(step.gate)) throw new FlowError(`${id}.gate must be an object`);
  const gate = step.gate;
  rejectUnknownKeys(
    gate,
    [
      'authority',
      'command',
      'input',
      'unit_id',
      'expect',
      'failure_route',
      'calibrate',
      'timeout_ms',
      'require_output',
      'forbid_output',
    ],
    `${id}.gate`,
  );
  const authority = gate.authority === undefined ? 'shell' : gate.authority;
  if (typeof authority !== 'string' || !GATE_AUTHORITIES.has(authority as GateAuthority)) {
    throw new FlowError(`${id}.gate.authority is invalid`);
  }
  if (authority === 'shell' && (typeof gate.command !== 'string' || !gate.command.trim())) {
    throw new FlowError(`${id}.gate.command is required for shell authority`);
  }
  if (authority !== 'shell' && gate.command !== undefined) {
    throw new FlowError(`${id}.gate.command is derived for ${authority}`);
  }
  const input = gate.input;
  if (
    authority === 'build-plan' ||
    authority === 'build-revalidate' ||
    authority === 'build-artifacts'
  ) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) {
      throw new FlowError(`${id}.gate.input must be an absolute build source JSON path`);
    }
  } else if (input !== undefined) {
    throw new FlowError(`${id}.gate.input is not supported for ${authority}`);
  }
  const unitId = gate.unit_id;
  if (authority === 'build-artifacts') {
    if (typeof unitId !== 'string' || !/^U-\d{3}$/u.test(unitId)) {
      throw new FlowError(`${id}.gate.unit_id must be U-NNN`);
    }
  } else if (unitId !== undefined) {
    throw new FlowError(`${id}.gate.unit_id is supported only by build-artifacts`);
  }
  const typedAuthority = authority as GateAuthority;
  const command = gateCommand(typedAuthority, gate.command, { id, input, unitId, repo });
  const derivedFailureRoute = failureRouteForOwner(step.owner);
  if (
    derivedFailureRoute &&
    gate.failure_route !== undefined &&
    gate.failure_route !== derivedFailureRoute
  ) {
    throw new FlowError(`${id}.gate.failure_route conflicts with owner`);
  }
  const failureRoute = derivedFailureRoute ?? gate.failure_route;
  if (typeof failureRoute !== 'string') {
    throw new FlowError(`${id}.gate.failure_route is required for a fail-closed gate`);
  }
  if (typedAuthority !== 'shell') {
    for (const [key, value] of [
      ['expect', gate.expect],
      ['calibrate', gate.calibrate],
      ['timeout_ms', gate.timeout_ms],
      ['require_output', gate.require_output],
      ['forbid_output', gate.forbid_output],
    ] as const) {
      if (value !== undefined)
        throw new FlowError(`${id}.gate.${key} is supported only by shell authority`);
    }
    const structured = { command, failure_route: failureRoute };
    if (typedAuthority === 'build-plan') {
      return { ...structured, authority: typedAuthority, input: input as string };
    }
    if (typedAuthority === 'build-revalidate') {
      return { ...structured, authority: typedAuthority, input: input as string };
    }
    if (typedAuthority === 'build-artifacts') {
      return {
        ...structured,
        authority: typedAuthority,
        input: input as string,
        unit_id: unitId as string,
      };
    }
    return { ...structured, authority: typedAuthority };
  }

  if (gate.expect !== 'pass' && gate.expect !== 'fail') {
    throw new FlowError(`${id}.gate.expect must be pass or fail`);
  }
  if (gate.calibrate !== undefined && typeof gate.calibrate !== 'boolean') {
    throw new FlowError(`${id}.gate.calibrate must be boolean`);
  }
  if (
    gate.timeout_ms !== undefined &&
    (typeof gate.timeout_ms !== 'number' ||
      !Number.isInteger(gate.timeout_ms) ||
      gate.timeout_ms <= 0)
  ) {
    throw new FlowError(`${id}.gate.timeout_ms must be a positive integer`);
  }
  const requireOutput = stringArray(gate.require_output ?? [], `${id}.gate.require_output`);
  const forbidOutput = stringArray(gate.forbid_output ?? [], `${id}.gate.forbid_output`);
  if (SHELL_CONTROL.test(command)) {
    throw new FlowError(`${id}.gate.command must be one command without shell control operators`);
  }
  if (command.includes(repo)) {
    throw new FlowError(`${id}.gate.command must use repository-relative paths for isolation`);
  }
  const calibration = gate.calibrate === true;
  if (calibration && gate.expect !== 'fail') {
    throw new FlowError(`${id}.gate.calibrate requires expect: fail`);
  }
  if (calibration && requireOutput.length) {
    throw new FlowError(`${id}.gate calibrates its output anchor at runtime`);
  }
  const gateArgv = [
    '--gate-id',
    id,
    '--failure-route',
    failureRoute,
    '--cwd',
    repo,
    '--expect',
    gate.expect,
    '--command',
    command,
  ];
  if (gate.timeout_ms !== undefined) gateArgv.push('--timeout-ms', String(gate.timeout_ms));
  for (const value of calibration ? ['calibration-placeholder'] : requireOutput) {
    gateArgv.push('--require-output', value);
  }
  for (const value of forbidOutput) gateArgv.push('--forbid-output', value);
  try {
    parseGateArgs(gateArgv);
  } catch (error) {
    throw new FlowError(`${id}.gate is invalid: ${errorMessage(error)}`);
  }
  return {
    authority: typedAuthority,
    command,
    expect: gate.expect,
    failure_route: failureRoute,
    calibrate: calibration,
    ...(gate.timeout_ms === undefined ? {} : { timeout_ms: gate.timeout_ms }),
    require_output: requireOutput,
    forbid_output: forbidOutput,
  };
}

/** Expands one unit mode into the exact actor, gate, artifact, and commit sequence. */
export function unitStepIds(unit: string, roles: ActorRole[], workflow: Workflow): string[] {
  const ids = roles.flatMap((role) => [`${unit}:${role}`, `${unit}:${role}:gate`]);
  if (workflow === 'build') ids.push(`${unit}:artifacts`, `${unit}:commit`);
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

  const baseline = steps.findIndex(
    (step) => step.kind === 'gate' && step.id.startsWith('baseline:'),
  );
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
    if (/^(?:baseline:|final:)/u.test(step.id) && step.owner !== undefined) {
      throw new FlowError(`${step.id} must be fail-closed`);
    }
  }

  const unitRoles = new Map<string, ActorRole[]>();
  for (const step of steps.filter((item) => item.kind === 'actor' && UNIT_ACTOR.test(item.id))) {
    const match = UNIT_ACTOR.exec(step.id);
    if (!match) continue;
    const unit = match[1];
    const role = match[2] as ActorRole | undefined;
    if (!unit || !role) throw new FlowError(`${step.id} has invalid actor captures`);
    const roles = unitRoles.get(unit) ?? [];
    roles.push(role);
    unitRoles.set(unit, roles);
  }
  if (!unitRoles.size) throw new FlowError('at least one U-NNN actor is required');
  if (manifest.workflow === 'build') {
    const cleanup = steps.find((step) => step.kind === 'actor' && CLEANUP_ACTOR.test(step.id));
    if (cleanup) {
      throw new FlowError(
        `build does not accept actor outside published Plan units: ${cleanup.id}`,
      );
    }
    const opening = steps.slice(0, BUILD_OPENING_IDS.length).map((step) => step.id);
    if (opening.join(',') !== BUILD_OPENING_IDS.join(',')) {
      throw new FlowError('build must start with load:plan, revalidate:plan, branch');
    }
  }
  for (const [unit, roles] of unitRoles) {
    const shape = roles.join(',');
    if (shape !== 'red,green' && shape !== 'direct') {
      throw new FlowError(`${unit} actor order must be red,green or direct`);
    }
    const firstRole = roles[0];
    if (!firstRole) throw new FlowError(`${unit} has no actor role`);
    const start = steps.findIndex((step) => step.id === `${unit}:${firstRole}`);
    const expected = unitStepIds(unit, roles, manifest.workflow);
    const actual = steps.slice(start, start + expected.length).map((step) => step.id);
    if (actual.join(',') !== expected.join(',')) {
      throw new FlowError(`${unit} must use its contiguous ${manifest.workflow} unit sequence`);
    }
  }
  if (manifest.workflow === 'build') {
    validateBuildSequence(manifest, steps, unitRoles);
  } else {
    if (steps.some((step) => step.kind === 'action')) {
      throw new FlowError('code workflow does not accept action steps');
    }
    if (steps.some((step) => step.kind === 'gate' && step.gate.authority !== 'shell')) {
      throw new FlowError('code workflow accepts only shell gate authority');
    }
  }
}

function validateBuildSequence(
  manifest: FlowManifest,
  steps: FlowStep[],
  unitRoles: Map<string, ActorRole[]>,
): void {
  for (const step of steps) {
    if (step.kind !== 'gate' || !/^U-\d{3}:red:gate$/u.test(step.id)) continue;
    if (step.gate.authority !== 'shell' || step.gate.expect !== 'fail' || !step.gate.calibrate) {
      throw new FlowError(`${step.id} must be a calibrated shell failure gate`);
    }
  }
  const authorityIds: Partial<Record<GateAuthority, RegExp>> = {
    'build-plan': /^load:plan$/u,
    'build-revalidate': /^revalidate:(?:plan|review|ship)$/u,
    'build-artifacts': /^U-\d{3}:artifacts$/u,
    'build-review': /^review:build$/u,
    'build-ship': /^ship:verify$/u,
  };
  for (const step of steps) {
    if (step.kind !== 'gate' || step.gate.authority === 'shell') continue;
    if (!authorityIds[step.gate.authority]?.test(step.id)) {
      throw new FlowError(`${step.gate.authority} authority is not valid for ${step.id}`);
    }
  }
  for (const required of ['load:plan', 'revalidate:plan', 'revalidate:review', 'review:build']) {
    if (!steps.some((step) => step.kind === 'gate' && step.id === required)) {
      throw new FlowError(`build requires the ${required} gate`);
    }
  }
  const authorities: Record<string, GateAuthority> = {
    'load:plan': 'build-plan',
    'revalidate:plan': 'build-revalidate',
    'review:build': 'build-review',
  };
  for (const [id, authority] of Object.entries(authorities)) {
    const gate = steps.find((step): step is GateStep => step.kind === 'gate' && step.id === id);
    if (gate?.gate.authority !== authority)
      throw new FlowError(`${id} must use ${authority} authority`);
  }
  if (
    !steps.some(
      (step) => step.id === 'branch' && step.kind === 'action' && step.action === 'branch',
    )
  ) {
    throw new FlowError('build requires a branch action');
  }
  for (const id of ['load:plan', 'revalidate:plan']) {
    const requiredGate = steps.find(
      (step): step is GateStep => step.kind === 'gate' && step.id === id,
    );
    if (!requiredGate || requiredGate.owner !== undefined)
      throw new FlowError(`${id} must be fail-closed`);
  }
  const finalIndex = steps.findIndex(
    (step) => step.kind === 'gate' && step.id.startsWith('final:'),
  );
  const reviewRevalidationIndex = steps.findIndex((step) => step.id === 'revalidate:review');
  const reviewRevalidation = steps[reviewRevalidationIndex];
  const reviewIndex = steps.findIndex((step) => step.id === 'review:build');
  const review = steps[reviewIndex];
  if (
    reviewRevalidationIndex !== finalIndex + 1 ||
    !reviewRevalidation ||
    reviewRevalidation.kind !== 'gate' ||
    reviewRevalidation.gate.authority !== 'build-revalidate' ||
    reviewRevalidation.owner !== undefined ||
    reviewIndex !== reviewRevalidationIndex + 1 ||
    !review ||
    review.kind !== 'gate' ||
    review.gate.authority !== 'build-review' ||
    review.owner !== undefined
  ) {
    throw new FlowError(
      'final gate must be followed by fail-closed revalidate:review and review:build',
    );
  }
  for (const [unit, roles] of unitRoles) {
    const owner = roles.includes('green') ? `${unit}:green` : `${unit}:direct`;
    const artifacts = steps.find(
      (step): step is GateStep => step.kind === 'gate' && step.id === `${unit}:artifacts`,
    );
    if (!artifacts || artifacts.owner !== owner) {
      throw new FlowError(`${unit}:artifacts must be owned by ${owner}`);
    }
    if (artifacts.gate.authority !== 'build-artifacts' || artifacts.gate.unit_id !== unit) {
      throw new FlowError(`${unit}:artifacts must use build-artifacts authority for ${unit}`);
    }
    const commit = steps.find(
      (step): step is ActionStep => step.kind === 'action' && step.id === `${unit}:commit`,
    );
    if (!commit || commit.action !== 'commit') {
      throw new FlowError(`${unit}:commit must use the commit action`);
    }
  }
  const ship = steps.find((step) => step.kind === 'action' && step.action === 'ship');
  if (manifest.shipping_authorized && !ship)
    throw new FlowError('shipping_authorized requires a ship action');
  if (ship && !manifest.shipping_authorized)
    throw new FlowError('a ship action requires shipping_authorized: true');
  if (!ship) {
    if (steps.at(-1) !== review) throw new FlowError('review:build must be the final build step');
    return;
  }
  const shipIndex = steps.indexOf(ship);
  const revalidation = steps[shipIndex - 1];
  if (
    !revalidation ||
    revalidation.kind !== 'gate' ||
    revalidation.id !== 'revalidate:ship' ||
    revalidation.gate.authority !== 'build-revalidate' ||
    revalidation.owner !== undefined
  ) {
    throw new FlowError('ship must be preceded by fail-closed revalidate:ship');
  }
  const verification = steps[shipIndex + 1];
  if (!verification || verification.kind !== 'gate' || verification.id !== 'ship:verify') {
    throw new FlowError('ship must be followed by ship:verify');
  }
  if (verification.gate.authority !== 'build-ship') {
    throw new FlowError('ship:verify must use build-ship authority');
  }
  if (verification.owner !== undefined) throw new FlowError('ship:verify must be fail-closed');
  if (steps.at(-1) !== verification) throw new FlowError('ship:verify must be the final step');
}

/** Parses an untrusted manifest into the controller's closed executable contract. */
export function validateManifest(raw: unknown): FlowManifest {
  if (!isObject(raw) || raw.protocol !== MANIFEST_PROTOCOL) {
    throw new FlowError(`manifest.protocol must be ${MANIFEST_PROTOCOL}`);
  }
  if (raw.workflow !== 'code' && raw.workflow !== 'build') {
    throw new FlowError('manifest.workflow must be code or build');
  }
  rejectUnknownKeys(
    raw,
    ['protocol', 'workflow', 'repo', 'max_corrections', 'shipping_authorized', 'steps'],
    'manifest',
  );
  if (typeof raw.repo !== 'string' || !path.isAbsolute(raw.repo)) {
    throw new FlowError('manifest.repo must be absolute');
  }
  const repo = gitRoot(raw.repo);
  if (fs.realpathSync(raw.repo) !== repo)
    throw new FlowError('manifest.repo must equal the Git root');
  const maxCorrections =
    raw.max_corrections === undefined ? DEFAULT_MAX_CORRECTIONS : raw.max_corrections;
  if (
    typeof maxCorrections !== 'number' ||
    !Number.isInteger(maxCorrections) ||
    maxCorrections < 0 ||
    maxCorrections > 20
  ) {
    throw new FlowError('max_corrections must be an integer from 0 to 20');
  }
  if (raw.shipping_authorized !== undefined && typeof raw.shipping_authorized !== 'boolean') {
    throw new FlowError('shipping_authorized must be boolean');
  }
  if (!Array.isArray(raw.steps) || !raw.steps.length)
    throw new FlowError('manifest.steps is required');

  const ids = new Set<string>();
  const steps: FlowStep[] = raw.steps.map((value: unknown, index: number): FlowStep => {
    if (!isObject(value) || typeof value.id !== 'string' || !SAFE_ID.test(value.id)) {
      throw new FlowError(`steps[${index}].id is invalid`);
    }
    const item = value;
    const id = item.id as string;
    if (ids.has(id)) throw new FlowError(`duplicate step id: ${id}`);
    ids.add(id);
    if (typeof item.kind !== 'string' || !STEP_KINDS.has(item.kind as FlowStep['kind'])) {
      throw new FlowError(`${id}.kind is invalid`);
    }
    if (item.kind === 'actor') {
      rejectUnknownKeys(item, ['id', 'kind', 'outcome', 'files'], id);
      if (!UNIT_ACTOR.test(id) && !CLEANUP_ACTOR.test(id)) {
        throw new FlowError(`${id} is not a supported actor id`);
      }
      if (typeof item.outcome !== 'string' || !item.outcome.trim() || item.outcome.length > 4000) {
        throw new FlowError(`${id}.outcome must be a non-empty string of at most 4000 characters`);
      }
      if (!Array.isArray(item.files) || !item.files.length) {
        throw new FlowError(`${id}.files must be a non-empty array`);
      }
      const files = item.files.map((file: unknown, fileIndex: number) =>
        validateActorFile(repo, file, `${id}.files[${fileIndex}]`),
      );
      if (new Set(files).size !== files.length)
        throw new FlowError(`${id}.files contains duplicates`);
      return { id, kind: 'actor', outcome: item.outcome.trim(), files };
    }
    if (item.kind === 'action') {
      if (typeof item.action !== 'string' || !ACTIONS.has(item.action as ActionName)) {
        throw new FlowError(`${id}.action is invalid`);
      }
      const action = item.action as ActionName;
      if (action === 'branch') return validateBranchAction(item, id, repo);
      if (action === 'commit') {
        rejectUnknownKeys(item, ['id', 'kind', 'action', 'subject'], id);
        if (!/^U-\d{3}:commit$/u.test(id))
          throw new FlowError('commit action id must be U-NNN:commit');
        if (
          typeof item.subject !== 'string' ||
          item.subject.length > 72 ||
          item.subject !== item.subject.toLowerCase() ||
          SHELL_CONTROL.test(item.subject) ||
          !COMMIT_SUBJECT.test(item.subject)
        ) {
          throw new FlowError(
            `${id}.subject must be a lowercase Conventional Commit subject of at most 72 characters`,
          );
        }
        return { id, kind: 'action', action, subject: item.subject };
      }
      return validateShipAction(item, id, repo);
    }
    rejectUnknownKeys(item, ['id', 'kind', 'owner', 'gate'], id);
    if (item.owner !== undefined && typeof item.owner !== 'string') {
      throw new FlowError(`${id}.owner must be a string`);
    }
    const owner = item.owner as string | undefined;
    return {
      id,
      kind: 'gate',
      ...(owner === undefined ? {} : { owner }),
      gate: validateGate(item, id, repo),
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

function githubRepository(remoteUrl: string): string | null {
  const scpTarget =
    /^(?:[^@\s]+@)?github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/iu.exec(
      remoteUrl,
    )?.[1];
  if (scpTarget) return scpTarget;
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    return (
      /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(parsed.pathname)?.[1] ?? null
    );
  } catch {
    return null;
  }
}

function validateShipAction(item: JsonObject, id: string, repo: string): ActionStep {
  rejectUnknownKeys(item, ['id', 'kind', 'action', 'remote', 'repository', 'base_branch'], id);
  if (id !== 'ship') throw new FlowError('ship action id must be ship');
  if (typeof item.remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(item.remote)) {
    throw new FlowError('ship.remote is invalid');
  }
  if (
    typeof item.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item.repository)
  ) {
    throw new FlowError('ship.repository must be OWNER/REPO');
  }
  const repository = item.repository;
  if (typeof item.base_branch !== 'string') throw new FlowError('ship.base_branch is required');
  const checked = spawnSync('git', ['check-ref-format', '--branch', item.base_branch], {
    encoding: 'utf8',
  });
  if (checked.status !== 0) throw new FlowError('ship.base_branch is invalid');
  const remote = spawnSync(
    'git',
    ['-C', repo, 'remote', 'get-url', '--push', '--all', item.remote],
    { encoding: 'utf8' },
  );
  if (remote.status !== 0) throw new FlowError(`ship.remote does not exist: ${item.remote}`);
  const targets = remote.stdout.split(/\r?\n/u).filter(Boolean).map(githubRepository);
  if (
    !targets.length ||
    targets.some((target) => target?.toLowerCase() !== repository.toLowerCase())
  ) {
    throw new FlowError(`ship.remote push URL must be GitHub repository ${repository}`);
  }
  return {
    id: 'ship',
    kind: 'action',
    action: 'ship',
    remote: item.remote,
    repository,
    base_branch: item.base_branch,
  };
}

function validateBranchAction(item: JsonObject, id: string, repo: string): ActionStep {
  rejectUnknownKeys(item, ['id', 'kind', 'action', 'branch_name', 'start_point'], id);
  if (id !== 'branch') throw new FlowError('branch action id must be branch');
  if (typeof item.branch_name !== 'string' || !item.branch_name) {
    throw new FlowError(`${id}.branch_name is required`);
  }
  const checked = spawnSync('git', ['check-ref-format', '--branch', item.branch_name], {
    encoding: 'utf8',
  });
  if (checked.status !== 0) throw new FlowError(`${id}.branch_name is invalid`);
  if (typeof item.start_point !== 'string' || !/^[0-9a-f]{40,64}$/u.test(item.start_point)) {
    throw new FlowError(`${id}.start_point must be a full commit id`);
  }
  const resolved = gitText(
    repo,
    ['rev-parse', `${item.start_point}^{commit}`],
    `${id}.start_point lookup`,
  );
  if (resolved !== item.start_point) throw new FlowError(`${id}.start_point is not canonical`);
  const exists = spawnSync('git', [
    '-C',
    repo,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${item.branch_name}`,
  ]);
  if (exists.status === 0) throw new FlowError(`${id}.branch_name already exists`);
  return {
    id: 'branch',
    kind: 'action',
    action: 'branch',
    branch_name: item.branch_name,
    start_point: item.start_point,
  };
}
