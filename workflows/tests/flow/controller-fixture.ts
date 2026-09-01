/** @file Outcome: Controller tests share one isolated repository and workflow-state fixture. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'bun:test';

import { renderPlanMarkdown, type BuildPlanAuthoring } from '../../flow/build/authoring.ts';
import { BUILD_SOURCE_PROTOCOL } from '../../flow/build/handoff.ts';
import { renderPublicIssueBody } from '../../issue/public-contract.ts';
import * as flow from '../../flow/controller.ts';
import * as intent from '../../invocation.ts';
import type {
  ActionStep,
  ActorStep,
  FlowManifest,
  GateAuthority,
  GateExpectation,
  PublicState,
  Workflow,
} from '../../flow/contracts.ts';

interface FixtureGateStep {
  id: string;
  kind: 'gate';
  owner?: string;
  gate: {
    authority?: GateAuthority;
    command?: string;
    input?: string;
    unit_id?: string;
    expect?: GateExpectation;
    calibrate?: boolean;
    timeout_ms?: number;
    failure_route?: string;
    require_output?: string[];
    forbid_output?: string[];
  };
}

type FixtureStep = ActorStep | ActionStep | FixtureGateStep;

interface FixtureManifest {
  protocol: typeof flow.MANIFEST_PROTOCOL;
  workflow: Workflow;
  repo: string;
  max_corrections: number;
  shipping_authorized?: boolean;
  steps: FixtureStep[];
}

export function fixture({
  failingUnitGate = false,
  workflow = 'code',
}: { failingUnitGate?: boolean; workflow?: 'code' | 'build' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-test-'));
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const issueFile = path.join(root, 'github-issue.json');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\nexec /bin/cat '${issueFile}'\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ''}`;
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'flow@example.test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Flow Test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/project.git'], {
    encoding: 'utf8',
  });
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  spawnSync('git', ['-C', repo, 'add', 'README.md'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture'], { encoding: 'utf8' });
  const startPoint = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const steps: FixtureStep[] = [
    {
      id: 'baseline:test',
      kind: 'gate',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
    },
    {
      id: 'U-001:direct',
      kind: 'actor',
      outcome: 'The fixture behavior is implemented.',
      files: ['src.js'],
    },
    {
      id: 'U-001:direct:gate',
      kind: 'gate',
      owner: 'U-001:direct',
      gate: {
        command: failingUnitGate ? 'false' : 'git status --porcelain',
        expect: 'pass',
        failure_route: 'direct:U-001',
      },
    },
    {
      id: 'final:test',
      kind: 'gate',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'triage' },
    },
  ];
  if (workflow === 'build') {
    steps.splice(
      0,
      steps.length,
      {
        id: 'load:plan',
        kind: 'gate',
        gate: {
          authority: 'build-plan',
          input: path.join(root, 'plan.json'),
          failure_route: 'blocked',
        },
      },
      {
        id: 'revalidate:plan',
        kind: 'gate',
        gate: {
          authority: 'build-revalidate',
          input: path.join(root, 'plan.json'),
          failure_route: 'blocked',
        },
      },
      {
        id: 'branch',
        kind: 'action',
        action: 'branch',
        branch_name: 'codex/flow-test',
        start_point: startPoint,
      },
      {
        id: 'branch:verify',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'baseline:test',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'U-001:direct',
        kind: 'actor',
        outcome: 'The fixture behavior is implemented.',
        files: ['src.js'],
      },
      {
        id: 'U-001:direct:gate',
        kind: 'gate',
        owner: 'U-001:direct',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'direct:U-001' },
      },
      {
        id: 'U-001:artifacts',
        kind: 'gate',
        owner: 'U-001:direct',
        gate: {
          authority: 'build-artifacts',
          input: path.join(root, 'plan.json'),
          unit_id: 'U-001',
          failure_route: 'direct:U-001',
        },
      },
      { id: 'U-001:commit', kind: 'action', action: 'commit', subject: 'chore: update fixture' },
      {
        id: 'U-001:commit:verify',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'final:test',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'triage' },
      },
    );
  }
  const manifest: FixtureManifest = {
    protocol: flow.MANIFEST_PROTOCOL,
    workflow,
    repo,
    max_corrections: 1,
    steps,
  };
  const manifestFile = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const previous = process.env.CODEX_FLOW_STATE_DIR;
  process.env.CODEX_FLOW_STATE_DIR = state;
  onTestFinished(() => {
    process.env.PATH = previousPath;
    if (previous === undefined) delete process.env.CODEX_FLOW_STATE_DIR;
    else process.env.CODEX_FLOW_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manifest, manifestFile, repo, startPoint };
}

export function requireGate(manifest: FixtureManifest, id: string): FixtureGateStep {
  const step = manifest.steps.find(
    (candidate): candidate is FixtureGateStep => candidate.kind === 'gate' && candidate.id === id,
  );
  if (!step) throw new Error(`missing gate fixture: ${id}`);
  return step;
}

export function requireActor(manifest: FixtureManifest): ActorStep {
  const step = manifest.steps.find(
    (candidate): candidate is ActorStep => candidate.kind === 'actor',
  );
  if (!step) throw new Error('missing actor fixture');
  return step;
}

export function enableShipping(manifest: FixtureManifest): void {
  manifest.shipping_authorized = true;
  manifest.steps.push(
    {
      id: 'revalidate:ship',
      kind: 'gate',
      gate: {
        authority: 'build-revalidate',
        input: '/hook-supplied-build-source.json',
        failure_route: 'blocked',
      },
    },
    {
      id: 'ship',
      kind: 'action',
      action: 'ship',
      remote: 'origin',
      repository: 'owner/project',
      base_branch: 'main',
    },
    {
      id: 'ship:verify',
      kind: 'gate',
      gate: { authority: 'build-ship', failure_route: 'blocked' },
    },
  );
}

export function startFlow(
  runId: string,
  manifestFile: string,
  beforeStart?: () => void,
): PublicState {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as FlowManifest;
  const pending = intent.armIntent({
    runId,
    workflow: manifest.workflow,
    cwd: manifest.repo,
  });
  if (manifest.workflow === 'build') {
    if (!pending.build_source_path) throw new Error('missing fixture build source path');
    fs.mkdirSync(path.dirname(pending.build_source_path), { recursive: true });
    const plan: BuildPlanAuthoring = {
      outcome: 'fixture outcome',
      root_cause: null,
      test_command: 'node --test',
      reference_module: {
        kind: 'no-module',
        reason: 'fixture has no reference module',
        path: null,
        files: [],
        instances: 0,
        conventions: [],
      },
      preconditions: [],
      backlog_candidates: [],
      rules: [],
      manual_verification: ['Open the fixture and observe the rendered value.'],
      units: [
        {
          id: 'U-001',
          goal: 'fixture unit',
          files: ['src.js'],
          contract: 'preserve fixture contract',
          tests: [],
          seam: false,
        },
      ],
    };
    const body = renderPublicIssueBody(renderPlanMarkdown(plan), plan, 'english');
    const issueFile = path.join(path.dirname(manifest.repo), 'github-issue.json');
    fs.writeFileSync(
      issueFile,
      JSON.stringify({
        number: 42,
        title: 'フィクスチャ',
        body,
        url: 'https://github.com/owner/project/issues/42',
        labels: [],
      }),
    );
    fs.writeFileSync(
      pending.build_source_path,
      JSON.stringify({
        protocol: BUILD_SOURCE_PROTOCOL,
        repository: 'owner/project',
        issue_number: 42,
      }),
    );
    for (const step of manifest.steps) {
      if (
        step.kind === 'gate' &&
        (step.gate.authority === 'build-plan' ||
          step.gate.authority === 'build-revalidate' ||
          step.gate.authority === 'build-artifacts')
      ) {
        step.gate.input = pending.build_source_path;
      }
    }
    fs.writeFileSync(pending.input_path, JSON.stringify(manifest));
    beforeStart?.();
    return flow.startWorkflow(runId, pending.input_path);
  } else {
    fs.copyFileSync(manifestFile, pending.input_path);
  }
  beforeStart?.();
  return flow.startWorkflow(runId, pending.input_path);
}
