/** @file Outcome: A validated public Plan deterministically becomes the only Build execution. */

import type { ActorRole, BuildPlanContext, FlowManifest, GateExpectation } from '../contracts.ts';
import { DEFAULT_MAX_CORRECTIONS, validateManifest } from '../manifest.ts';
import { FlowError } from '../../shared/errors.ts';

interface CompileBuildOptions {
  repo: string;
  input: string;
  plan: BuildPlanContext;
  branchName: string;
  startPoint: string;
  baseBranch?: string;
  ship: boolean;
}

function shellGate(
  id: string,
  command: string,
  expect: GateExpectation,
  failureRoute: string,
  owner?: string,
  calibrate = false,
): unknown {
  return {
    id,
    kind: 'gate',
    ...(owner ? { owner } : {}),
    gate: {
      authority: 'shell',
      command,
      expect,
      calibrate,
      failure_route: failureRoute,
      require_output: [],
      forbid_output: [],
    },
  };
}

function unitCommitSubject(unit: BuildPlanContext['units'][number]): string {
  const prefix = `chore(${unit.id.toLowerCase()}): `;
  const normalized = unit.goal
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/gu, ' ')
    .trim();
  const summary = normalized.replace(/^[^a-z0-9]+/u, '') || 'implement published plan unit';
  return `${prefix}${summary}`.slice(0, 72).trimEnd();
}

function unitSteps(
  plan: BuildPlanContext,
  input: string,
  unit: BuildPlanContext['units'][number],
): unknown[] {
  const roles: ActorRole[] = unit.tests.length ? ['red', 'green'] : ['direct'];
  const steps: unknown[] = [];
  for (const role of roles) {
    const actorId = `${unit.id}:${role}`;
    steps.push(
      { id: actorId, kind: 'actor', outcome: unit.goal, files: [...unit.files] },
      shellGate(
        `${actorId}:gate`,
        plan.test_command,
        role === 'red' ? 'fail' : 'pass',
        `${role}:${unit.id}`,
        actorId,
        role === 'red',
      ),
    );
  }
  const owner = `${unit.id}:${roles.at(-1)!}`;
  const commitSubject = unitCommitSubject(unit);
  steps.push(
    {
      id: `${unit.id}:artifacts`,
      kind: 'gate',
      owner,
      gate: {
        authority: 'build-artifacts',
        input,
        unit_id: unit.id,
        failure_route: `${roles.at(-1)}:${unit.id}`,
      },
    },
    {
      id: `${unit.id}:commit`,
      kind: 'action',
      action: 'commit',
      subject: commitSubject,
    },
  );
  return steps;
}

/** Compiles Plan facts into normalized controller steps without accepting alternate intent. */
export function compileBuildManifest({
  repo,
  input,
  plan,
  branchName,
  startPoint,
  baseBranch,
  ship,
}: CompileBuildOptions): FlowManifest {
  const steps: unknown[] = [
    {
      id: 'load:plan',
      kind: 'gate',
      gate: {
        authority: 'build-plan',
        input,
        failure_route: 'blocked',
      },
    },
    {
      id: 'revalidate:plan',
      kind: 'gate',
      gate: {
        authority: 'build-revalidate',
        input,
        failure_route: 'blocked',
      },
    },
    {
      id: 'branch',
      kind: 'action',
      action: 'branch',
      branch_name: branchName,
      start_point: startPoint,
    },
    shellGate('baseline:test', plan.test_command, 'pass', 'blocked'),
    ...plan.units.flatMap((unit) => unitSteps(plan, input, unit)),
    shellGate('final:test', plan.test_command, 'pass', 'triage'),
    {
      id: 'revalidate:review',
      kind: 'gate',
      gate: {
        authority: 'build-revalidate',
        input,
        failure_route: 'blocked',
      },
    },
    {
      id: 'review:build',
      kind: 'gate',
      gate: { authority: 'build-review', failure_route: 'blocked' },
    },
  ];
  if (ship) {
    if (!baseBranch) throw new FlowError('shipping Build requires a base branch', 'state_error');
    steps.push(
      {
        id: 'revalidate:ship',
        kind: 'gate',
        gate: {
          authority: 'build-revalidate',
          input,
          failure_route: 'blocked',
        },
      },
      {
        id: 'ship',
        kind: 'action',
        action: 'ship',
        remote: 'origin',
        repository: plan.repository,
        base_branch: baseBranch,
      },
      {
        id: 'ship:verify',
        kind: 'gate',
        gate: { authority: 'build-ship', failure_route: 'blocked' },
      },
    );
  }
  return validateManifest({
    protocol: 'codex-flow-manifest',
    workflow: 'build',
    repo,
    max_corrections: DEFAULT_MAX_CORRECTIONS,
    shipping_authorized: ship,
    steps,
  });
}
