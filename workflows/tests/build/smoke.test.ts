/** @file Outcome: A minimal Build input reaches a verified local completion from one public Issue read. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { ActorEscalation } from '../../execution/agent.ts';
import { loadWorkflowState } from '../../execution/controller.ts';
import { workflowRunDirectory } from '../../runtime/storage.ts';
import { executeAction } from '../../build/git-actions.ts';
import { type BuildPlanAuthoring } from '../../plan/contracts.ts';
import type { FlowDirective } from '../../execution/contracts.ts';
import { runWorkflow, type WorkflowRuntime } from '../../execution/engine.ts';
import { armIntent } from '../../runtime/invocation.ts';
import { renderPublicIssueBody } from '../../issue/public-contract.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-build-smoke-storage-');

function reviewResult(directive: Extract<FlowDirective, { kind: 'run-review' }>, blocking = false) {
  return {
    protocol: 'codex-build-review-candidate' as const,
    step_id: 'review:build' as const,
    source_digest: directive.input.source_digest,
    actor_receipt_digest: directive.input.actor_receipt_digest,
    dispatch_id: directive.input.dispatch_id,
    summary: blocking ? '主値に修正が必要。' : 'Plan を満たす。',
    findings: blocking
      ? [
          {
            severity: 'blocking' as const,
            code: 'incomplete',
            message: '主値を修正する。',
            unit_ids: ['U-001'],
            files: ['unit.ts'],
            evidence: [
              {
                path: '.gitignore',
                detail: 'related repository evidence outside writable scope',
              },
            ],
          },
        ]
      : [],
  };
}

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function buildFixture(plan: BuildPlanAuthoring) {
  const repo = temporaryDirectory('codex-build-smoke-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@example.test');
  git(repo, 'config', 'user.name', 'Smoke');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  fs.writeFileSync(path.join(repo, 'unit.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, 'other.ts'), 'export const other = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.DS_Store\n');
  git(repo, 'add', 'unit.ts', 'other.ts');
  git(repo, 'commit', '-qm', 'init');
  const startPoint = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', startPoint);
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const body = renderPublicIssueBody('Build fixture.', plan);
  const issueFile = `${repo}.issue.json`;
  fs.writeFileSync(
    issueFile,
    JSON.stringify({
      number: 1,
      title: 'Smoke build',
      body,
      url: 'https://github.com/owner/repo/issues/1',
    }),
  );
  const bin = `${repo}.bin`;
  fs.mkdirSync(bin);
  const countFile = path.join(bin, 'count');
  fs.writeFileSync(countFile, '');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\nprintf x >> '${countFile}'\nexec /bin/cat '${issueFile}'\n`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ''}`;
  onTestFinished(() => {
    process.env.PATH = previousPath;
    fs.rmSync(issueFile, { force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const runId = `build-smoke-${crypto.randomUUID()}`;
  const pending = armIntent({ runId, workflow: 'build', cwd: repo });
  fs.writeFileSync(pending.input_path, JSON.stringify({ repo, issue_number: 1, ship: false }));
  return { repo, startPoint, countFile, runId, input: pending.input_path };
}

test('Build fetches the Issue Plan, implements, verifies, reviews, and commits once', async () => {
  const plan: BuildPlanAuthoring = {
    outcome: '値が更新される。',
    test_command: 'git diff --check',
    units: [
      {
        goal: '値を更新する。',
        files: ['unit.ts'],
        contract: 'value が 2 になる。',
        tests: ['差分に空白エラーがない。'],
      },
    ],
  };
  const { repo, startPoint, countFile, runId, input } = buildFixture(plan);
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(sandboxRepo, directive) {
        fs.writeFileSync(path.join(sandboxRepo, 'unit.ts'), 'export const value = 2;\n');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_repo, directive) {
        return reviewResult(directive);
      },
    },
    executeAction,
  };
  const result = await runWorkflow(runId, input, runtime);
  assert.equal(result.exitCode, 0, JSON.stringify(result.result));
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'completed');
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 2/u);
  assert.equal(git(repo, 'rev-list', '--count', `${startPoint}..HEAD`), '1');
}, 30_000);

test('a blocking semantic review corrects the shared actor, then re-verifies and commits once', async () => {
  const plan: BuildPlanAuthoring = {
    outcome: '両方の値が更新される。',
    test_command: 'git diff --check',
    units: [
      {
        goal: '主値を更新する。',
        files: ['unit.ts'],
        contract: 'value が更新される。',
        tests: ['差分に空白エラーがない。'],
      },
      {
        goal: '関連値を更新する。',
        files: ['other.ts'],
        contract: 'other が更新される。',
        tests: ['関連ファイルも検証される。'],
      },
    ],
  };
  const { repo, startPoint, countFile, runId, input } = buildFixture(plan);
  type ActorDirective = Extract<FlowDirective, { kind: 'run-actor' }>;
  const actorCalls: ActorDirective[] = [];
  const actions: string[] = [];
  const directives: string[] = [];
  let reviews = 0;
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(sandboxRepo, directive) {
        actorCalls.push(directive);
        fs.writeFileSync(
          path.join(sandboxRepo, 'unit.ts'),
          `export const value = ${actorCalls.length === 1 ? 2 : 3};\n`,
        );
        fs.writeFileSync(path.join(sandboxRepo, 'other.ts'), 'export const other = 2;\n');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_repo, directive) {
        reviews += 1;
        return reviewResult(directive, reviews === 1);
      },
    },
    executeAction(actionRepo, directive) {
      actions.push(directive.action);
      executeAction(actionRepo, directive);
    },
    onDirective(directive) {
      if (directive.kind === 'run-actor') directives.push('implementation');
      else if (directive.kind === 'run-gate') directives.push(directive.step_id);
      else if (directive.kind === 'run-review') directives.push('review:build');
      else if (directive.kind === 'run-action') directives.push(directive.action);
    },
  };

  const result = await runWorkflow(runId, input, runtime);
  assert.equal(result.exitCode, 0, JSON.stringify(result.result));
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'completed');
  assert.equal(reviews, 2);
  assert.equal(actorCalls.length, 2);
  assert.equal(actorCalls[0]?.correction, null);
  assert.deepEqual(
    actorCalls.map((call) => call.files),
    [
      ['unit.ts', 'other.ts'],
      ['unit.ts', 'other.ts'],
    ],
  );
  assert.equal(actorCalls[1]?.correction?.attempt, 1);
  assert.equal(actorCalls[1]?.correction?.gate.gate_id, 'review:build');
  assert.deepEqual(directives, [
    'load:plan',
    'branch',
    'implementation',
    'test:implementation',
    'artifacts',
    'review:build',
    'implementation',
    'test:implementation',
    'artifacts',
    'review:build',
    'commit',
  ]);
  const gateIds = result.result.gate_reports.map((gate) => gate.gate_id);
  assert.equal(gateIds.filter((id) => id === 'load:plan').length, 1);
  assert.equal(gateIds.filter((id) => id === 'test:implementation').length, 2);
  assert.equal(gateIds.filter((id) => id === 'review:build').length, 2);
  assert.deepEqual(actions, ['branch', 'commit']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 3/u);
  assert.equal(git(repo, 'rev-list', '--count', `${startPoint}..HEAD`), '1');
}, 30_000);

const returnPlan: BuildPlanAuthoring = {
  outcome: 'Export value 2.',
  test_command: 'git diff --check',
  units: [
    {
      goal: 'Export value 2.',
      files: ['unit.ts'],
      contract: 'The value is 2.',
      tests: ['The change has no whitespace errors.'],
    },
  ],
};
const returnResearch = {
  async investigate() {
    return {
      answer: 'The current value is 1.',
      findings: [
        {
          statement: 'The current value is 1.',
          kind: 'fact' as const,
          confidence: 'high' as const,
          qualification: null,
          evidence: [
            {
              kind: 'repository' as const,
              source: 'unit.ts',
              locator: 'L1',
              supports: 'The source exports 1.',
            },
          ],
          implication: 'Update to 2.',
        },
      ],
      rejected: [],
      unknowns: [],
      limitations: [],
    };
  },
  async audit() {
    return { summary: 'Supported.', findings: [] };
  },
};

test('verified Build Research returns to the same actor under the original public Plan', async () => {
  const { repo, runId, input, countFile } = buildFixture(returnPlan);
  let first = true;
  let suspended = '';
  const result = await runWorkflow(runId, input, {
    agent: {
      async runActor(sandbox, directive) {
        if (first) {
          first = false;
          suspended = directive.step_id;
          throw new ActorEscalation(
            'research',
            'Which value is currently exported?',
            'Confirmed missing source evidence.',
          );
        }
        assert.equal(directive.step_id, suspended);
        assert.equal(directive.research?.length, 1);
        fs.writeFileSync(path.join(sandbox, 'unit.ts'), 'export const value = 2;\n');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_repo, directive) {
        return reviewResult(directive);
      },
    },
    executeAction,
    children: { research: returnResearch },
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 2/);
}, 15000);

test('Build Think may research once but stops for Issue publication without adopting the proposed Plan', async () => {
  const { repo, runId, input, countFile } = buildFixture(returnPlan);
  let designs = 0;
  let actors = 0;
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor() {
        actors++;
        throw new ActorEscalation(
          'think',
          'Which public value should be required?',
          'Confirmed requirement decision beyond the current contract.',
        );
      },
      async reviewBuild() {
        throw Error('old Build must not review or ship');
      },
    },
    executeAction,
    children: {
      research: returnResearch,
      think: {
        async design(_i, reports) {
          designs++;
          return reports.length
            ? { status: 'ready', plan: returnPlan, research_questions: [] }
            : {
                status: 'research_required',
                plan: null,
                research_questions: ['Which value is currently exported?'],
              };
        },
        async review() {
          return { summary: 'Supported.', findings: [] };
        },
      },
    },
  };
  const result = await runWorkflow(runId, input, runtime);
  assert.equal(result.exitCode, 2);
  const state = loadWorkflowState(runId).state;
  assert.equal(state.escalation?.next_step, 'issue');
  assert.ok(state.handoff?.proposal);
  assert.equal(actors, 1);
  assert.equal(designs, 2);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 1/);
  const returns = JSON.parse(
    fs.readFileSync(
      path.join(workflowRunDirectory(runId), `returns-${state.invocation_id}.json`),
      'utf8',
    ),
  ).state.entries;
  assert.equal(returns.length, 2);
  await runWorkflow(runId, input, runtime);
  assert.equal(actors, 1);
  assert.equal(designs, 2);
}, 15000);

test('nested Think gaps cannot exceed the Build root budget and retain a diagnostic stop', async () => {
  const { runId, input, repo } = buildFixture(returnPlan);
  const result = await runWorkflow(runId, input, {
    agent: {
      async runActor() {
        throw new ActorEscalation(
          'think',
          'Missing requirement.',
          'Confirmed outside-contract choice.',
        );
      },
      async reviewBuild() {
        throw Error('no review');
      },
    },
    executeAction,
    children: {
      research: returnResearch,
      think: {
        async design() {
          return {
            status: 'research_required',
            plan: null,
            research_questions: ['Which required value is correct?'],
          };
        },
        async review() {
          return { summary: 'Supported gap.', findings: [] };
        },
      },
    },
  });
  assert.equal(result.exitCode, 2);
  const state = loadWorkflowState(runId).state;
  assert.match(state.runtime_failure!.error, /limit of two/);
  assert.equal(state.handoff!.proposal, null);
  assert.throws(
    () => armIntent({ runId, workflow: 'build', cwd: repo }),
    /workflow is already active/,
  );
}, 15000);

test('Build restart reconciles completed child and adopted proposal without another Issue read or model call', async () => {
  for (const boundary of ['child-completed', 'adopted']) {
    const { runId, input, countFile } = buildFixture(returnPlan);
    const script = path.join(temporaryDirectory('build-return-process-'), 'run.ts');
    fs.writeFileSync(
      script,
      `
 import fs from 'node:fs';import {mock} from 'bun:test';
 const rename=fs.renameSync;fs.renameSync=(...args)=>{rename(...args);const file=String(args[1]);
 if(${JSON.stringify(boundary)}==='child-completed'&&file.includes('returns-')&&file.endsWith('.json')){const s=JSON.parse(fs.readFileSync(file,'utf8')).state;if(s.entries[0]?.result)process.exit(73);}
 if(${JSON.stringify(boundary)}==='adopted'&&file.endsWith('/state.json')){const s=JSON.parse(fs.readFileSync(file,'utf8'));if(s.handoff?.proposal)process.exit(73);}
 };
 mock.module('node:fs',()=>({...fs,default:fs}));
 const {runWorkflow}=await import(${JSON.stringify(new URL('../../execution/engine.ts', import.meta.url).pathname)});
 const {ActorEscalation}=await import(${JSON.stringify(new URL('../../execution/agent.ts', import.meta.url).pathname)});
 const {executeAction}=await import(${JSON.stringify(new URL('../../build/git-actions.ts', import.meta.url).pathname)});
 await runWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)},{agent:{async runActor(){throw new ActorEscalation('think','Which public value is required?','Confirmed outside-contract decision.');},async reviewBuild(){throw Error('no review');}},executeAction,children:{think:{async design(){return {status:'ready',plan:${JSON.stringify(returnPlan)},research_questions:[]};},async review(){return {summary:'Pass.',findings:[]};}}}});
 `,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const err = new Response(child.stderr).text();
    assert.equal(await child.exited, 73, await err);
    const result = await runWorkflow(runId, input, {
      agent: {
        async runActor() {
          throw Error('no actor redispatch');
        },
        async reviewBuild() {
          throw Error('no review');
        },
      },
      executeAction() {
        throw Error('no action');
      },
      children: {
        think: {
          async design() {
            throw Error('no designer redispatch');
          },
          async review() {
            throw Error('no reviewer redispatch');
          },
        },
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(loadWorkflowState(runId).state.escalation?.next_step, 'issue');
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  }
}, 15000);

test('unknown Research remains explicit actor context and repeated unresolved returns exhaust the root budget', async () => {
  const { runId, input } = buildFixture(returnPlan);
  let actors = 0;
  const result = await runWorkflow(runId, input, {
    agent: {
      async runActor(_repo, directive) {
        if (actors > 0) {
          assert.equal(directive.research?.length, actors);
          assert.equal(
            directive.research?.[0]?.unknowns[0]?.question,
            'Which deployment value is required?',
          );
        }
        actors++;
        throw new ActorEscalation(
          'research',
          'Which deployment value is required?',
          'The required external fact remains unavailable.',
        );
      },
      async reviewBuild() {
        throw Error('unresolved facts cannot pass');
      },
    },
    executeAction,
    children: {
      research: {
        ...returnResearch,
        async investigate() {
          return {
            answer: 'The deployment requirement is not supplied.',
            findings: [],
            rejected: [],
            unknowns: [
              {
                question: 'Which deployment value is required?',
                resolution: 'Obtain the external deployment requirement.',
              },
            ],
            limitations: [],
          };
        },
      },
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(actors, 3);
  assert.match(loadWorkflowState(runId).state.runtime_failure!.error, /limit of two/);
}, 15000);

test('a modified Build handoff snapshot cannot dispatch a child', async () => {
  const { runId, input } = buildFixture(returnPlan);
  let designs = 0;
  const result = await runWorkflow(runId, input, {
    agent: {
      async runActor() {
        throw new ActorEscalation(
          'think',
          'Which value is required?',
          'Confirmed outside-contract decision.',
        );
      },
      async reviewBuild() {
        throw Error('no review');
      },
    },
    executeAction,
    onDirective(directive) {
      if (directive.kind === 'blocked') {
        const state = loadWorkflowState(runId).state;
        if (state.handoff)
          fs.writeFileSync(path.join(state.handoff.snapshot, 'unit.ts'), 'tampered source');
      }
    },
    children: {
      think: {
        async design() {
          designs++;
          return { status: 'ready', plan: returnPlan, research_questions: [] };
        },
        async review() {
          return { summary: 'Pass.', findings: [] };
        },
      },
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(designs, 0);
  assert.match(loadWorkflowState(runId).state.runtime_failure!.error, /caller snapshot changed/);
}, 15000);
