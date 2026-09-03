/** @file Outcome: Only closed manifests with safe scopes and valid workflow structure reach execution. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  gitRoot,
  gitOptionalText,
  gitText,
  nearestExistingParent,
  normalizeRepoPath,
  realpathInside,
} from '../shared/repository.ts';
import type {
  ActionName,
  ActionStep,
  FlowManifest,
  FlowStep,
  GateAuthority,
  GateSpec,
  GateStep,
} from './contracts.ts';
import { MANIFEST_PROTOCOL, SAFE_ID } from './contracts.ts';
import { SHELL_CONTROL, shellCommand } from '../shared/command.ts';
import { FlowError } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys, type JsonObject } from '../shared/schema.ts';

const ACTIONS = new Set<ActionName>(['branch', 'commit', 'ship']);
export const IMPLEMENTATION_ACTOR_ID = 'implementation:direct';
const BUILD_OPENING_IDS = ['load:plan', 'branch'] as const;
export const DEFAULT_MAX_CORRECTIONS = 3;
const GATE_AUTHORITIES = new Set<GateAuthority>([
  'shell',
  'build-plan',
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
  const relative = value === '.' ? '.' : safeRelativeFile(value, label);
  const absolute = path.resolve(repo, relative);
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  const boundary = existing ? absolute : nearestExistingParent(absolute);
  if (!boundary || !realpathInside(repo, boundary)) {
    throw new FlowError(`${label} must stay inside the repository`);
  }
  if (relative === '.') return relative;
  const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--', relative]);
  if (ignored.status === 0) throw new FlowError(`${label} names an ignored path`);
  if (ignored.status !== 1)
    throw new FlowError(`${label} could not be checked against Git ignore rules`);
  return relative;
}

function failureRouteForOwner(owner: unknown): string | null {
  if (owner === undefined) return null;
  if (typeof owner !== 'string') throw new FlowError('gate.owner must be an actor id');
  if (owner === IMPLEMENTATION_ACTOR_ID) return 'direct:implementation';
  throw new FlowError(`gate.owner must name a supported actor: ${owner}`);
}

function gateCommand(
  authority: GateAuthority,
  configured: unknown,
  { id, input, repo }: { id: string; input: unknown; repo: string },
): string {
  switch (authority) {
    case 'shell':
      return String(configured);
    case 'build-plan':
      return shellCommand('codex-build-plan', ['--input', String(input)]);
    case 'build-artifacts':
      return shellCommand('codex-build-artifacts', ['--gate-id', id, '--repo', repo]);
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
    ['authority', 'command', 'input', 'unit_id', 'expect', 'failure_route', 'timeout_ms'],
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
  if (authority === 'build-plan') {
    if (typeof input !== 'string' || !path.isAbsolute(input)) {
      throw new FlowError(`${id}.gate.input must be an absolute build source JSON path`);
    }
  } else if (input !== undefined) {
    throw new FlowError(`${id}.gate.input is not supported for ${authority}`);
  }
  const unitId = gate.unit_id;
  if (unitId !== undefined) throw new FlowError(`${id}.gate.unit_id is no longer supported`);
  const typedAuthority = authority as GateAuthority;
  const command = gateCommand(typedAuthority, gate.command, { id, input, repo });
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
      ['timeout_ms', gate.timeout_ms],
    ] as const) {
      if (value !== undefined)
        throw new FlowError(`${id}.gate.${key} is supported only by shell authority`);
    }
    const structured = { command, failure_route: failureRoute };
    if (typedAuthority === 'build-plan') {
      return { ...structured, authority: typedAuthority, input: input as string };
    }
    if (typedAuthority === 'build-artifacts') {
      return {
        ...structured,
        authority: typedAuthority,
      };
    }
    return { ...structured, authority: typedAuthority };
  }

  if (gate.expect !== 'pass') throw new FlowError(`${id}.gate.expect must be pass`);
  if (
    gate.timeout_ms !== undefined &&
    (typeof gate.timeout_ms !== 'number' ||
      !Number.isInteger(gate.timeout_ms) ||
      gate.timeout_ms <= 0)
  ) {
    throw new FlowError(`${id}.gate.timeout_ms must be a positive integer`);
  }
  if (SHELL_CONTROL.test(command)) {
    throw new FlowError(`${id}.gate.command must be one command without shell control operators`);
  }
  if (command.includes(repo)) {
    throw new FlowError(`${id}.gate.command must use repository-relative paths for isolation`);
  }
  return {
    authority: typedAuthority,
    command,
    expect: gate.expect,
    failure_route: failureRoute,
    ...(gate.timeout_ms === undefined ? {} : { timeout_ms: gate.timeout_ms }),
  };
}

function validateSequence(manifest: FlowManifest, steps: FlowStep[]): void {
  const correctionTargets = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'actor') correctionTargets.set(step.id, index);
  }
  for (const [index, step] of steps.entries()) {
    if (step.kind !== 'gate' || step.owner === undefined) continue;
    const ownerIndex = correctionTargets.get(step.owner);
    if (ownerIndex === undefined || ownerIndex >= index) {
      throw new FlowError(`${step.id}.owner must name an earlier actor`);
    }
  }

  const firstActor = steps.findIndex((step) => step.kind === 'actor');
  if (firstActor < 0) throw new FlowError('workflow requires an implementation actor');

  const implementationActors = steps.filter(
    (step) => step.kind === 'actor' && step.id === IMPLEMENTATION_ACTOR_ID,
  );
  if (implementationActors.length !== 1) {
    throw new FlowError('workflow requires exactly one implementation actor');
  }
  if (manifest.workflow === 'build') {
    const opening = steps.slice(0, BUILD_OPENING_IDS.length).map((step) => step.id);
    if (opening.join(',') !== BUILD_OPENING_IDS.join(',')) {
      throw new FlowError('build must start with load:plan, branch');
    }
  }
  if (manifest.workflow === 'build') {
    validateBuildSequence(manifest, steps);
  } else {
    if (steps.some((step) => step.kind === 'action')) {
      throw new FlowError('code workflow does not accept action steps');
    }
    if (steps.some((step) => step.kind === 'gate' && step.gate.authority !== 'shell')) {
      throw new FlowError('code workflow accepts only shell gate authority');
    }
    const lastActor = steps.findLastIndex((step) => step.kind === 'actor');
    if (!steps.slice(lastActor + 1).some((step) => step.kind === 'gate')) {
      throw new FlowError('code workflow requires a test gate after implementation');
    }
  }
}

function validateBuildSequence(manifest: FlowManifest, steps: FlowStep[]): void {
  const authorityIds: Partial<Record<GateAuthority, RegExp>> = {
    'build-plan': /^load:plan$/u,
    'build-artifacts': /^artifacts$/u,
    'build-review': /^review:build$/u,
    'build-ship': /^ship:verify$/u,
  };
  for (const step of steps) {
    if (step.kind !== 'gate' || step.gate.authority === 'shell') continue;
    if (!authorityIds[step.gate.authority]?.test(step.id)) {
      throw new FlowError(`${step.gate.authority} authority is not valid for ${step.id}`);
    }
  }
  for (const required of ['load:plan', 'test', 'artifacts', 'review:build']) {
    if (!steps.some((step) => step.kind === 'gate' && step.id === required)) {
      throw new FlowError(`build requires the ${required} gate`);
    }
  }
  const authorities: Record<string, GateAuthority> = {
    'load:plan': 'build-plan',
    artifacts: 'build-artifacts',
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
  const loadPlan = steps.find(
    (step): step is GateStep => step.kind === 'gate' && step.id === 'load:plan',
  );
  if (!loadPlan || loadPlan.owner !== undefined) {
    throw new FlowError('load:plan must be fail-closed');
  }
  const testIndex = steps.findIndex((step) => step.id === 'test');
  const artifactsIndex = steps.findIndex((step) => step.id === 'artifacts');
  const reviewIndex = steps.findIndex((step) => step.id === 'review:build');
  const review = steps[reviewIndex];
  const commitIndex = steps.findIndex((step) => step.id === 'build:commit');
  if (
    artifactsIndex !== testIndex + 1 ||
    reviewIndex !== artifactsIndex + 1 ||
    commitIndex !== reviewIndex + 1 ||
    !review ||
    review.kind !== 'gate' ||
    review.gate.authority !== 'build-review'
  ) {
    throw new FlowError('Build must run test, scope check, review, then one commit');
  }
  const commit = steps[commitIndex];
  if (!commit || commit.kind !== 'action' || commit.action !== 'commit') {
    throw new FlowError('build:commit must be the single commit action');
  }
  const ship = steps.find((step) => step.kind === 'action' && step.action === 'ship');
  if (manifest.shipping_authorized && !ship)
    throw new FlowError('shipping_authorized requires a ship action');
  if (ship && !manifest.shipping_authorized)
    throw new FlowError('a ship action requires shipping_authorized: true');
  if (!ship) {
    if (steps.at(-1) !== commit) throw new FlowError('build:commit must be the final build step');
    return;
  }
  const shipIndex = steps.indexOf(ship);
  if (shipIndex !== commitIndex + 1) throw new FlowError('ship must follow build:commit');
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
    if (isObject(raw) && /^codex-flow-manifest\/v\d+$/u.test(String(raw.protocol))) {
      throw new FlowError(
        'manifest uses an obsolete contract; regenerate it from the current workflow describe output',
      );
    }
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
      if (id !== IMPLEMENTATION_ACTOR_ID) {
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
        if (id !== 'build:commit') throw new FlowError('commit action id must be build:commit');
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
  const existing = gitOptionalText(repo, ['rev-parse', `refs/heads/${item.branch_name}^{commit}`]);
  if (existing !== null && existing !== item.start_point) {
    throw new FlowError(`${id}.branch_name already exists at a different commit`);
  }
  return {
    id: 'branch',
    kind: 'action',
    action: 'branch',
    branch_name: item.branch_name,
    start_point: item.start_point,
  };
}
