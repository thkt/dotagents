/** @file Outcome: A fetched Issue Plan becomes a validated internal Build manifest. */

import type { BuildPlanContext, FlowManifest } from '../execution/contracts.ts';
import { implementationSteps } from '../execution/implementation-steps.ts';
import { DEFAULT_MAX_CORRECTIONS, validateManifest } from '../execution/manifest-validation.ts';
import { FlowError } from '../shared/errors.ts';

interface CompileBuildOptions {
  repo: string;
  input: string;
  plan: BuildPlanContext;
  branchName: string;
  startPoint: string;
  baseBranch?: string;
  ship: boolean;
}

export function compileBuildManifest({
  repo,
  input,
  plan,
  branchName,
  startPoint,
  baseBranch,
  ship,
}: CompileBuildOptions): FlowManifest {
  let testNumber = 1;
  const implementation = plan.units.map((unit) => ({
    id: unit.id,
    outcome: unit.goal,
    contract: unit.contract,
    tests: unit.tests.map((test) => ({
      ...test,
      id: `T-${String(testNumber++).padStart(3, '0')}`,
    })),
    scope_paths: unit.files,
  }));
  if (!implementation.length) throw new FlowError('Build Plan must contain an implementation unit');
  const steps: unknown[] = [
    {
      id: 'load:plan',
      kind: 'gate',
      gate: { authority: 'build-plan', input, failure_route: 'blocked' },
    },
    {
      id: 'branch',
      kind: 'action',
      action: 'branch',
      branch_name: branchName,
      start_point: startPoint,
    },
    ...implementationSteps(implementation, plan.test_command),
    {
      id: 'artifacts',
      kind: 'gate',
      gate: { authority: 'build-artifacts', failure_route: 'blocked' },
    },
    {
      id: 'review:build',
      kind: 'gate',
      gate: { authority: 'build-review', failure_route: 'blocked' },
    },
    {
      id: 'build:commit',
      kind: 'action',
      action: 'commit',
      subject: 'chore: implement published issue plan',
    },
  ];
  if (ship) {
    if (!baseBranch) throw new FlowError('shipping Build requires a base branch', 'state_error');
    steps.push(
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
