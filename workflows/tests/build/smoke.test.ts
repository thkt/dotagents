/** @file Outcome: A minimal Build input reaches a verified local completion from one public Issue read. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { assertNoImplementation } from '../../cleanup/state.ts';
import { ActorEscalation } from '../../execution/agent.ts';
import { loadWorkflowState } from '../../execution/controller.ts';
import { workflowRunDirectory, workflowInputPath } from '../../runtime/storage.ts';
import { draftIssueWorkflow } from '../../issue/runner.ts';
import type { IssueGateway } from '../../issue/github.ts';
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

async function rejectMissingJournal(
  runId: string,
  input: string,
  countFile: string,
): Promise<void> {
  const { loadThinkState, thinkDigest } = await import('../../think/state.ts');
  const { loadResearchState } = await import('../../research/state.ts');
  const { runStageReturn, saveStageReturnTransition } =
    await import('../../runtime/stage-return.ts');
  const { handle } = await import('../../../hooks/workflow-enforcer.ts');
  const parent = loadWorkflowState(runId).state;
  const file = path.join(workflowRunDirectory(runId), `returns-${parent.invocation_id}.json`);
  const journal = fs.readFileSync(file, 'utf8');
  const entries = JSON.parse(journal).state.entries as {
    id: string;
    route: 'think' | 'research';
  }[];
  const children = entries.map((e) =>
    e.route === 'think' ? loadThinkState(e.id) : loadResearchState(e.id),
  );
  const originalInput = fs.readFileSync(input, 'utf8');
  const reads = fs.readFileSync(countFile, 'utf8');
  const head = git(parent.manifest.repo, 'rev-parse', 'HEAD');
  const status = git(parent.manifest.repo, 'status', '--porcelain');
  let calls = 0;
  const forbidden = async (): Promise<never> => {
    calls++;
    throw Error('No dispatch without existing ownership');
  };
  const runtime: WorkflowRuntime = {
    agent: { runActor: forbidden, reviewBuild: forbidden },
    executeAction() {
      calls++;
      throw Error('No action without existing ownership');
    },
    children: {
      think: { design: forbidden, review: forbidden },
      research: { investigate: forbidden, audit: forbidden },
    },
  };
  fs.unlinkSync(file);
  try {
    await assert.rejects(
      runWorkflow(runId, input, runtime),
      /missing cross-stage ownership record.*retain/,
    );
    if (parent.handoff && !parent.handoff.proposal) {
      await assert.rejects(
        runStageReturn(runId, 'build', runtime.children),
        /missing cross-stage ownership record/,
      );
      for (const prompt of ['Private', '$build 1']) {
        const hook = handle({
          hook_event_name: 'UserPromptSubmit',
          session_id: runId,
          cwd: parent.manifest.repo,
          prompt,
        });
        assert.equal(hook.decision, 'block');
        assert.match(hook.reason!, /missing cross-stage ownership record/);
      }
    }
    assert.throws(
      () =>
        saveStageReturnTransition(runId, 'build', thinkDigest(parent), thinkDigest(parent), () => {
          calls++;
          throw Error('No parent persistence without ownership');
        }),
      /missing cross-stage ownership record/,
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(input, 'utf8'), originalInput);
    assert.equal(fs.readFileSync(countFile, 'utf8'), reads);
    assert.equal(git(parent.manifest.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(git(parent.manifest.repo, 'status', '--porcelain'), status);
    assert.deepEqual(loadWorkflowState(runId).state, parent);
    assert.deepEqual(
      entries.map((e) => (e.route === 'think' ? loadThinkState(e.id) : loadResearchState(e.id))),
      children,
    );
  } finally {
    fs.writeFileSync(file, journal);
  }
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
  assert.equal(fs.existsSync(path.join(repo, '.codex/workflow-artifacts/cleanup/source')), false);
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 2/u);
  assert.equal(git(repo, 'rev-list', '--count', `${startPoint}..HEAD`), '1');
  fs.rmSync(workflowRunDirectory(runId), { recursive: true });
  assertNoImplementation(repo);
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
  const proposedPlan = JSON.parse(
    JSON.stringify(returnPlan).replaceAll('value 2', 'value 3').replaceAll('is 2', 'is 3'),
  ) as BuildPlanAuthoring;
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
            ? { status: 'ready', plan: proposedPlan, research_questions: [] }
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

  const originalState = fs.readFileSync(
    path.join(workflowRunDirectory(runId), 'state.json'),
    'utf8',
  );
  const issueInput = workflowInputPath(runId, 'issue');
  fs.writeFileSync(
    issueInput,
    JSON.stringify({
      repo,
      mode: 'update',
      target_issue: 1,
      think_report: state.handoff!.proposal,
      title: 'Export value 3.',
      prose: 'Update the required value to 3.',
    }),
  );
  const remote = `${repo}.issue.json`;
  let issueWrites = 0;
  const gateway: IssueGateway = {
    checkAccess() {},
    view() {
      return JSON.parse(fs.readFileSync(remote, 'utf8'));
    },
    create() {
      throw new Error('must update the existing Issue');
    },
    edit(_repo, _number, title, bodyFile) {
      issueWrites++;
      const issue = {
        ...this.view('owner/repo', 1),
        title,
        body: fs.readFileSync(bodyFile, 'utf8'),
      };
      fs.writeFileSync(remote, JSON.stringify(issue));
      return issue;
    },
  };
  const issueAgent = {
    async correct() {
      throw new Error('faithful initial draft');
    },
    async review() {
      return { summary: 'Faithful revised Plan.', findings: [] };
    },
  };
  await assert.rejects(
    draftIssueWorkflow(runId, issueInput, gateway, undefined, issueAgent),
    /explicit/,
  );
  armIntent({ runId, workflow: 'issue', cwd: repo });
  const publication = await draftIssueWorkflow(runId, issueInput, gateway, undefined, issueAgent);
  assert.equal(issueWrites, 1);
  assert.equal(
    fs.readFileSync(path.join(workflowRunDirectory(runId), 'state.json'), 'utf8'),
    originalState,
  );
  assert.equal(publication.next_step, 'build');
  const nextRun = crypto.randomUUID();
  const nextInput = armIntent({ runId: nextRun, workflow: 'build', cwd: repo }).input_path;
  fs.writeFileSync(nextInput, JSON.stringify({ ...publication.build_source, ship: false }));
  let nextActors = 0;
  const next = await runWorkflow(nextRun, nextInput, {
    agent: {
      async runActor(sandbox, directive) {
        nextActors++;
        fs.writeFileSync(path.join(sandbox, 'unit.ts'), 'export const value = 3;\n');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'Exported value 3.',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_repo, directive) {
        return reviewResult(directive);
      },
    },
    executeAction,
  });
  assert.equal(next.exitCode, 0, JSON.stringify(next));
  assert.equal(nextActors, 1);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'xx');
  const accepted = loadWorkflowState(nextRun).state.build_plan!;
  assert.equal(accepted.outcome, proposedPlan.outcome);
  assert.equal(accepted.test_command, proposedPlan.test_command);
  assert.deepEqual(
    accepted.units.map(({ goal, files, contract, tests }) => ({
      goal,
      files,
      contract,
      tests: tests.map((test) => test.name),
    })),
    proposedPlan.units,
  );
  assert.equal(
    fs.readFileSync(path.join(workflowRunDirectory(runId), 'state.json'), 'utf8'),
    originalState,
  );
}, 30000);

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
 if(${JSON.stringify(boundary)}==='child-completed'&&file.endsWith('think-state.json')){const s=JSON.parse(fs.readFileSync(file,'utf8')).state;if(s.phase==='completed')process.exit(73);}
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

test.each([false, true])(
  'matched Ship retries only receipt persistence; changed evidence blocks (%s)',
  async (changed) => {
    const plan: BuildPlanAuthoring = {
      outcome: 'Update value.',
      test_command: 'git diff --check',
      units: [
        {
          goal: 'Update value.',
          files: ['unit.ts'],
          contract: 'value is 2.',
          tests: ['No whitespace errors.'],
        },
      ],
    };
    const { repo, startPoint, runId, input } = buildFixture(plan);
    fs.writeFileSync(input, JSON.stringify({ repo, issue_number: 1, ship: true }));
    const bin = `${repo}.bin`;
    const remoteFile = path.join(bin, 'remote.json');
    const prFile = path.join(bin, 'pr.json');
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/usr/bin/env bun
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('ls-remote')) {
  if (!fs.existsSync(${JSON.stringify(remoteFile)})) process.exit(2);
  const r = JSON.parse(fs.readFileSync(${JSON.stringify(remoteFile)}, 'utf8'));
  console.log(r.oid + '\\trefs/heads/' + r.branch); process.exit(0);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'issue') { process.stdout.write(fs.readFileSync(${JSON.stringify(`${repo}.issue.json`)}, 'utf8')); }
else if (args[0] === 'repo') console.log(JSON.stringify({ id: 'R_fixture', nameWithOwner: 'owner/repo' }));
else if (fs.existsSync(${JSON.stringify(prFile)})) process.stdout.write(fs.readFileSync(${JSON.stringify(prFile)}, 'utf8'));
else { console.error('no pull requests found'); process.exit(1); }
`,
      { mode: 0o700 },
    );
    let pushes = 0,
      prs = 0,
      actors = 0;
    const runtime: WorkflowRuntime = {
      agent: {
        async runActor(sandboxRepo, directive) {
          actors++;
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
      executeAction(repo, directive) {
        if (directive.action !== 'ship') {
          executeAction(repo, directive);
          return;
        }
        executeAction(repo, directive, (invocation) => {
          if (invocation.executable === 'git') {
            pushes++;
            fs.writeFileSync(
              remoteFile,
              JSON.stringify({
                oid: git(repo, 'rev-parse', 'HEAD'),
                branch: directive.parameters.branch,
              }),
            );
          } else {
            prs++;
            fs.writeFileSync(
              prFile,
              JSON.stringify({
                number: 7,
                url: 'https://github.com/owner/repo/pull/7',
                state: 'OPEN',
                mergedAt: null,
                isDraft: true,
                title: directive.parameters.title,
                body: fs.readFileSync(directive.parameters.pr_body_path, 'utf8'),
                baseRefName: 'main',
                headRefName: directive.parameters.branch,
                headRefOid: git(repo, 'rev-parse', 'HEAD'),
                headRepository: { id: 'R_fixture', nameWithOwner: 'owner/repo' },
              }),
            );
          }
        });
      },
    };
    const original = fs.linkSync;
    fs.linkSync = (source, destination) => {
      if (String(destination).includes('/cleanup/source/'))
        throw new Error('injected receipt persistence failure');
      original(source, destination);
    };
    try {
      const blocked = await runWorkflow(runId, input, runtime);
      assert.equal(blocked.exitCode, 2, JSON.stringify(blocked.result));
      assert.equal(
        loadWorkflowState(runId).state.gate_reports.at(-1)?.classification,
        'ship_receipt_persistence_failed',
      );
    } finally {
      fs.linkSync = original;
    }
    if (changed) {
      const proof = JSON.parse(fs.readFileSync(prFile, 'utf8'));
      proof.headRefOid = 'a'.repeat(40);
      fs.writeFileSync(prFile, JSON.stringify(proof));
    }
    const done = await runWorkflow(runId, input, runtime);
    assert.equal(done.exitCode, changed ? 2 : 0, JSON.stringify(done.result));
    if (changed)
      assert.equal(
        loadWorkflowState(runId).state.gate_reports.at(-1)?.classification,
        'ship_verification_failed',
      );
    assert.equal(pushes, 1);
    assert.equal(prs, 1);
    assert.equal(actors, 1);
    assert.equal(git(repo, 'rev-list', '--count', `${startPoint}..HEAD`), '1');
  },
  60_000,
);

for (const field of ['plan', 'attempt'] as const) {
  test(`Build revalidates the persisted handoff ${field} before reserving or resuming a child`, async () => {
    const { runId, input, countFile } = buildFixture(returnPlan);
    const result = await runWorkflow(runId, input, {
      agent: {
        async runActor() {
          throw new ActorEscalation(
            'research',
            'Which policy applies?',
            'Confirmed user-owned decision.',
          );
        },
        async reviewBuild() {
          throw Error('No Build review.');
        },
      },
      executeAction,
      onDirective(directive) {
        if (directive.kind !== 'blocked') return;
        const { file, state } = loadWorkflowState(runId);
        if (field === 'plan') state.build_plan!.outcome = 'Unpublished replacement Plan';
        else state.actor_attempt++;
        fs.writeFileSync(file, JSON.stringify(state));
      },
      children: {
        research: {
          async investigate() {
            throw Error('No investigator under edited authority.');
          },
          async audit() {
            throw Error('No auditor under edited authority.');
          },
        },
      },
    });
    assert.equal(result.exitCode, 2);
    const { state } = loadWorkflowState(runId);
    assert.match(state.runtime_failure!.error, /handoff authority changed before child execution/);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(workflowRunDirectory(runId), `returns-${state.invocation_id}.json`),
          'utf8',
        ),
      ).state.entries,
      [],
    );
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  }, 15000);
}

for (const route of ['research', 'think', 'think-research'] as const) {
  test(`Build ${route} rejects authority edited during child waiting before journaling it`, async () => {
    const { repo, runId, input, countFile } = buildFixture(returnPlan);
    const head = git(repo, 'rev-parse', 'HEAD');
    let actors = 0;
    let mutations = 0;
    const question = {
      id: 'deployment-policy',
      prompt: 'Which deployment policy applies?',
      choices: [
        { label: 'Public', description: 'Allow public access.' },
        { label: 'Private', description: 'Require authentication.' },
      ],
      recommendation: null,
    };
    const mutateAuthority = () => {
      const { file, state } = loadWorkflowState(runId);
      state.build_plan!.outcome = 'Unpublished replacement Plan';
      state.actor_attempt++;
      fs.writeFileSync(file, JSON.stringify(state));
      mutations++;
      return { summary: 'Necessary user-owned policy.', findings: [] };
    };
    const result = await runWorkflow(runId, input, {
      agent: {
        async runActor() {
          actors++;
          throw new ActorEscalation(
            route === 'research' ? 'research' : 'think',
            'Which policy applies?',
            'Confirmed user-owned policy decision.',
          );
        },
        async reviewBuild() {
          throw Error('No Build review while waiting.');
        },
      },
      executeAction,
      children: {
        research: {
          async investigate() {
            return { status: 'waiting', question };
          },
          async audit() {
            return mutateAuthority();
          },
        },
        think: {
          async design() {
            return route === 'think-research'
              ? {
                  status: 'research_required',
                  plan: null,
                  research_questions: ['Which deployment policy applies?'],
                }
              : { status: 'waiting', plan: null, research_questions: [], question };
          },
          async review() {
            return route === 'think'
              ? mutateAuthority()
              : { summary: 'Research is necessary.', findings: [] };
          },
        },
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal('status' in result.result && result.result.status === 'waiting', false);
    assert.equal(actors, 1);
    assert.equal(mutations, 1);
    const { state } = loadWorkflowState(runId);
    assert.match(state.runtime_failure!.error, /stale Build parent authority/);
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(workflowRunDirectory(runId), `returns-${state.invocation_id}.json`),
        'utf8',
      ),
    ).state;
    assert.equal(journal.waiting, null);
    assert.equal(journal.adoption, null);
    assert.deepEqual(journal.parents, {});
    assert.equal(journal.entries.length, route === 'think-research' ? 2 : 1);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
    const { handle } = await import('../../../hooks/workflow-enforcer.ts');
    const response = handle({
      hook_event_name: 'UserPromptSubmit',
      session_id: runId,
      cwd: repo,
      prompt: 'Private',
    });
    assert.equal(response.hookSpecificOutput?.additionalContext, undefined);
  }, 20000);

  test(`Build ${route} waiting routes one bound root answer without changing public authority`, async () => {
    const { repo, runId, input, countFile } = buildFixture(returnPlan);
    let actors = 0,
      designs = 0,
      investigations = 0,
      audits = 0,
      reviews = 0,
      actions = 0;
    const question = {
      id: 'policy',
      prompt: 'Which deployment policy is in scope for the proposed decision?',
      choices: [
        { label: 'Public', description: 'Public deployment.' },
        { label: 'Private', description: 'Private deployment.' },
      ],
      recommendation: 'Private',
    };
    const runtime: WorkflowRuntime = {
      agent: {
        async runActor(sandbox, directive) {
          if (++actors === 1)
            throw new ActorEscalation(
              route === 'research' ? 'research' : 'think',
              'Which deployment policy applies?',
              'Confirmed user-owned policy decision.',
            );
          assert.equal(route, 'research');
          assert.equal(directive.research?.length, 1);
          fs.writeFileSync(path.join(sandbox, 'unit.ts'), 'export const value = 2;\n');
          return {
            protocol: 'codex-flow-actor-result',
            binding: directive.binding,
            status: 'completed',
            summary: 'Done.',
            route: null,
            question: null,
          };
        },
        async reviewBuild(_r, directive) {
          return reviewResult(directive);
        },
      },
      executeAction(r, directive) {
        actions++;
        executeAction(r, directive);
      },
      children: {
        research: {
          async investigate(i) {
            investigations++;
            return i.clarification_answers?.length
              ? returnResearch.investigate()
              : { status: 'waiting', question };
          },
          async audit() {
            audits++;
            return returnResearch.audit();
          },
        },
        think: {
          async design(i, reports) {
            designs++;
            if (reports.length) assert.deepEqual(i.clarification_answers, [answer]);
            if (route === 'think-research')
              return reports.length
                ? { status: 'ready', plan: returnPlan, research_questions: [] }
                : {
                    status: 'research_required',
                    plan: null,
                    research_questions: ['Which deployment policy applies?'],
                  };
            return i.clarification_answers?.length
              ? { status: 'ready', plan: returnPlan, research_questions: [] }
              : { status: 'waiting', plan: null, research_questions: [], question };
          },
          async review(i, _draft, reports) {
            if (reports.length) assert.deepEqual(i.clarification_answers, [answer]);
            reviews++;
            return { summary: 'Necessary user-owned decision or supported Plan.', findings: [] };
          },
        },
      },
    };
    const waiting = await runWorkflow(runId, input, runtime);
    assert('status' in waiting.result && waiting.result.status === 'waiting');
    const pending = waiting.result;
    assert.equal('report_json' in pending, false);
    assert.equal(pending.owner.task, runId);
    const before = loadWorkflowState(runId).state;
    const head = git(repo, 'rev-parse', 'HEAD');
    const counts = [actors, designs, investigations, audits, reviews, actions];
    await rejectMissingJournal(runId, input, countFile);
    assert.deepEqual(await runWorkflow(runId, input, runtime), waiting);
    assert.deepEqual([actors, designs, investigations, audits, reviews, actions], counts);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
    assert.deepEqual(loadWorkflowState(runId).state, before);
    const { handle } = await import('../../../hooks/workflow-enforcer.ts');
    const { thinkDigest } = await import('../../think/state.ts');
    const { researchStatePath, thinkStatePath } = await import('../../runtime/storage.ts');
    const leafFile =
      pending.owner.workflow === 'research'
        ? researchStatePath(pending.owner.leaf)
        : thinkStatePath(pending.owner.leaf);
    const leafBytes = fs.readFileSync(leafFile, 'utf8');
    const envelope = JSON.parse(leafBytes);
    if (pending.owner.workflow === 'research') {
      envelope.state.pending_question.prompt = 'Unreviewed nested replacement';
      envelope.state.investigations[0].proposal.prompt = envelope.state.pending_question.prompt;
    } else envelope.state.candidate.question.prompt = 'Unreviewed nested replacement';
    envelope.digest = thinkDigest(envelope.state);
    fs.writeFileSync(leafFile, JSON.stringify(envelope));
    const promptInput = {
      hook_event_name: 'UserPromptSubmit' as const,
      session_id: runId,
      cwd: repo,
      prompt: 'Private',
    };
    const rejected = handle(promptInput);
    assert.equal(rejected.decision, 'block');
    assert.equal(rejected.hookSpecificOutput?.additionalContext, undefined);
    const editedOwner = JSON.parse(leafBytes);
    editedOwner.state.pending_owner.root = 'another-root';
    editedOwner.digest = thinkDigest(editedOwner.state);
    fs.writeFileSync(leafFile, JSON.stringify(editedOwner));
    const ownerRejected = handle(promptInput);
    assert.equal(ownerRejected.decision, 'block');
    assert.equal(ownerRejected.hookSpecificOutput?.additionalContext, undefined);
    fs.writeFileSync(leafFile, leafBytes);
    const parentFile = loadWorkflowState(runId).file;
    const parentBytes = fs.readFileSync(parentFile, 'utf8');
    fs.writeFileSync(
      parentFile,
      JSON.stringify({ ...before, actor_attempt: before.actor_attempt + 1 }),
    );
    assert.equal(handle(promptInput).decision, 'block');
    fs.writeFileSync(parentFile, parentBytes);
    assert(
      handle(promptInput).hookSpecificOutput?.additionalContext?.includes(JSON.stringify(question)),
    );
    assert.deepEqual([actors, designs, investigations, audits, reviews, actions], counts);
    const original = JSON.parse(fs.readFileSync(input, 'utf8'));
    const answer = {
      owner: pending.owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: question.recommendation,
      selection: null,
      answer: 'Preserve private deployment policy.',
    };
    for (const invalid of [
      { ...original, issue_number: 999, clarification_answers: [answer] },
      {
        ...original,
        clarification_answers: [{ ...answer, owner: { ...answer.owner, task: 'other-task' } }],
      },
    ]) {
      fs.writeFileSync(input, JSON.stringify(invalid));
      await assert.rejects(runWorkflow(runId, input, runtime), /original input|owner/);
      assert.deepEqual([actors, designs, investigations, audits, reviews, actions], counts);
    }
    fs.writeFileSync(input, JSON.stringify({ ...original, clarification_answers: [answer] }));
    await rejectMissingJournal(runId, input, countFile);
    const resumed = await runWorkflow(runId, input, runtime);
    const after = loadWorkflowState(runId).state;
    assert.equal(after.invocation_id, before.invocation_id);
    assert.equal(after.input_sha256, before.input_sha256);
    assert.deepEqual(after.build_plan, before.build_plan);
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
    const record = JSON.parse(
      fs.readFileSync(
        path.join(workflowRunDirectory(runId), `returns-${before.invocation_id}.json`),
        'utf8',
      ),
    ).state;
    assert.equal(record.entries.length, route === 'think-research' ? 2 : 1);
    assert(record.entries.some((entry: { id: string }) => entry.id === pending.owner.leaf));
    if (route === 'research') {
      assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
      assert.equal(actors, 2);
    } else {
      assert.equal(after.escalation?.next_step, 'issue', JSON.stringify(resumed));
      assert.equal(actors, 1);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      assert.equal(actions, counts[5]);
    }
  }, 20000);
}

for (const route of ['research', 'think', 'think-research'] as const) {
  for (const boundary of ['throw', 'intent', 'parent', 'settled']) {
    test(`Build ${route} recovers thrown child publication failures at ${boundary}`, async () => {
      const { loadResearchState, researchPublicationPaths } =
        await import('../../research/state.ts');
      const { loadThinkState, thinkPublicationPaths } = await import('../../think/state.ts');
      const { repo, runId, input, countFile } = buildFixture(returnPlan);
      const question = {
        id: 'failure-policy',
        prompt: 'Which user-owned deployment policy must the investigation cover?',
        choices: [
          { label: 'Public', description: 'Cover public deployment.' },
          { label: 'Private', description: 'Cover private deployment.' },
        ],
        recommendation: null,
      };
      let actors = 0;
      const runtime: WorkflowRuntime = {
        agent: {
          async runActor(sandbox, directive) {
            if (++actors === 1)
              throw new ActorEscalation(
                route === 'research' ? 'research' : 'think',
                'Which deployment policy applies?',
                'Confirmed user-owned policy decision.',
              );
            assert.equal(route, 'research');
            assert.equal(directive.research?.length, 1);
            fs.writeFileSync(path.join(sandbox, 'unit.ts'), 'export const value = 2;\n');
            return {
              protocol: 'codex-flow-actor-result',
              binding: directive.binding,
              status: 'completed',
              summary: 'Done.',
              route: null,
              question: null,
            };
          },
          async reviewBuild(_repo, directive) {
            return reviewResult(directive);
          },
        },
        executeAction,
        children: {
          research: {
            ...returnResearch,
            async investigate() {
              return { status: 'waiting', question };
            },
          },
          think: {
            async design(_input, reports) {
              return route === 'think-research'
                ? reports.length
                  ? { status: 'ready', plan: returnPlan, research_questions: [] }
                  : {
                      status: 'research_required',
                      plan: null,
                      research_questions: ['Which deployment policy applies?'],
                    }
                : { status: 'waiting', plan: null, research_questions: [], question };
            },
            async review() {
              return { summary: 'Supported.', findings: [] };
            },
          },
        },
      };
      const waiting = await runWorkflow(runId, input, runtime);
      assert('status' in waiting.result && waiting.result.status === 'waiting');
      const owner = waiting.result.owner;
      const before = loadWorkflowState(runId).state;
      const head = git(repo, 'rev-parse', 'HEAD');
      const answer = {
        owner,
        question_id: question.id,
        prompt: question.prompt,
        choices: question.choices,
        recommendation: null,
        selection: null,
        answer: 'Cover private deployment.',
      };
      fs.writeFileSync(
        input,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(input, 'utf8')),
          clarification_answers: [answer],
        }),
      );
      const paths =
        route === 'think'
          ? thinkPublicationPaths(loadThinkState(owner.leaf)!)
          : researchPublicationPaths(loadResearchState(owner.leaf)!);
      const directory = temporaryDirectory('build-answered-publication-failure-');
      const script = path.join(directory, 'run.ts');
      const calls = path.join(directory, 'calls');
      const failure = 'Temporary child publication failure';
      fs.writeFileSync(
        script,
        `
        import fs from 'node:fs'; import {mock} from 'bun:test';
        const rename=fs.renameSync; let failed=false;
        const log=(value)=>fs.appendFileSync(${JSON.stringify(calls)},value+'\\n');
        fs.renameSync=(...args)=>{
          const file=String(args[1]);
          if(!failed && file===${JSON.stringify(paths.markdown)}){failed=true;log('publication');throw Error(${JSON.stringify(failure)});}
          rename(...args);
          if(!failed)return;
          if(file.includes('returns-') && file.endsWith('.json')){
            const s=JSON.parse(fs.readFileSync(file,'utf8')).state;
            if(${JSON.stringify(boundary)}==='intent' && s.parent_transition?.parent===${JSON.stringify(runId)})process.exit(73);
            if(${JSON.stringify(boundary)}==='settled' && !s.parent_transition){
              const parent=JSON.parse(fs.readFileSync(${JSON.stringify(loadWorkflowState(runId).file)},'utf8'));
              if(parent.runtime_failure?.error===${JSON.stringify(failure)})process.exit(73);
            }
          }
          if(${JSON.stringify(boundary)}==='parent' && file===${JSON.stringify(loadWorkflowState(runId).file)} && JSON.parse(fs.readFileSync(file,'utf8')).runtime_failure?.error===${JSON.stringify(failure)})process.exit(73);
        };
        mock.module('node:fs',()=>({...fs,default:fs}));
        const {runWorkflow}=await import(${JSON.stringify(new URL('../../execution/engine.ts', import.meta.url).pathname)});
        const result=await runWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)},{
          agent:{async runActor(){throw Error('No actor before child publication');},async reviewBuild(){throw Error('No Build review before child publication');}},
          executeAction(){throw Error('No Git action before child publication');},
          children:{
            research:{async investigate(){log('investigate');return ${JSON.stringify(await returnResearch.investigate())};},async audit(){log('audit');return {summary:'Supported.',findings:[]};}},
            think:{async design(){log('design');return {status:'ready',plan:${JSON.stringify(returnPlan)},research_questions:[]};},async review(){log('review');return {summary:'Supported.',findings:[]};}}
          }
        });
        if(result.result.status!=='blocked')throw Error(JSON.stringify(result));
        process.exit(74);
      `,
      );
      const child = Bun.spawn([process.execPath, script], {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = new Response(child.stderr).text();
      const stdout = new Response(child.stdout).text();
      assert.equal(await child.exited, boundary === 'throw' ? 74 : 73, await stderr);
      await stdout;
      assert.equal(
        fs.readFileSync(calls, 'utf8'),
        route === 'think' ? 'design\nreview\npublication\n' : 'investigate\naudit\npublication\n',
      );
      const failed = loadWorkflowState(runId).state;
      assert.equal(failed.actor_attempt, before.actor_attempt);
      assert.deepEqual(failed.build_plan, before.build_plan);
      assert.equal(failed.input_sha256, before.input_sha256);
      assert.equal(failed.handoff!.binding, before.handoff!.binding);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
      const journalFile = path.join(
        workflowRunDirectory(runId),
        `returns-${before.invocation_id}.json`,
      );
      await rejectMissingJournal(runId, input, countFile);
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')).state;
      assert.equal(journal.adoption.phase, 'routed');
      assert.equal(Boolean(journal.parent_transition), ['intent', 'parent'].includes(boundary));
      const leaf = route === 'think' ? loadThinkState(owner.leaf)! : loadResearchState(owner.leaf)!;
      assert.equal(leaf.phase, 'publish');
      assert.deepEqual(leaf.clarification_history, [answer]);
      if (boundary === 'throw' || boundary === 'parent') {
        const file = loadWorkflowState(runId).file;
        const bytes = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(
          file,
          JSON.stringify({ ...failed, actor_attempt: failed.actor_attempt + 1 }),
        );
        await assert.rejects(
          runWorkflow(runId, input, runtime),
          /authority changed|parent changed/,
        );
        fs.writeFileSync(file, bytes);
        assert.equal(actors, 1);
      }
      runtime.children = {
        research: {
          async investigate() {
            throw Error('Accepted investigator must not repeat');
          },
          async audit() {
            throw Error('Accepted audit must not repeat');
          },
        },
        think: {
          async design(i, reports) {
            assert.equal(route, 'think-research');
            assert.equal(reports.length, 1);
            assert.deepEqual(i.clarification_answers, [answer]);
            return { status: 'ready', plan: returnPlan, research_questions: [] };
          },
          async review() {
            assert.equal(route, 'think-research');
            return { summary: 'Supported.', findings: [] };
          },
        },
      };
      const resumed = await runWorkflow(runId, input, runtime);
      const after = loadWorkflowState(runId).state;
      assert.equal(after.invocation_id, before.invocation_id);
      assert.equal(after.input_sha256, before.input_sha256);
      assert.deepEqual(after.build_plan, before.build_plan);
      assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
      const settled = JSON.parse(fs.readFileSync(journalFile, 'utf8')).state;
      assert.equal(settled.parent_transition, null);
      assert.equal(settled.adoption, null);
      assert.deepEqual(
        settled.entries.map((entry: { id: string }) => entry.id),
        journal.entries.map((entry: { id: string }) => entry.id),
      );
      assert.equal(settled.entries.length, route === 'think-research' ? 2 : 1);
      const accepted =
        route === 'think' ? loadThinkState(owner.leaf)! : loadResearchState(owner.leaf)!;
      assert.deepEqual(accepted.clarification_history, [answer]);
      assert.deepEqual(accepted.dispatch_history, leaf.dispatch_history);
      assert.equal(accepted.corrections, leaf.corrections);
      assert(fs.existsSync(paths.json) && fs.existsSync(paths.markdown));
      if (route === 'research') {
        assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
        assert.equal(actors, 2);
      } else {
        assert.equal(after.escalation?.next_step, 'issue', JSON.stringify(resumed));
        assert.equal(actors, 1);
        assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      }
    }, 30000);
  }
}

for (const boundary of [
  'root',
  'routing',
  'routed',
  'leaf',
  'parent-intent',
  'parent-write',
  'parent-settled',
  'design-dispatch',
  'design-result',
  'review-dispatch',
  'review-result',
  'review-correction',
  'design-error',
  'think-blocked',
  'think-publish',
  'think-completed',
  'throw-before',
  'throw-after',
  'throw-journal-before',
  'throw-journal-after',
  'throw-settle-before',
  'throw-settle-after',
]) {
  test(`Build to Think to Research validates every parent and recovers at ${boundary}`, async () => {
    const { runId, input, countFile } = buildFixture(returnPlan);
    const question = {
      id: 'bound-policy',
      prompt: 'Which user-owned policy must the proposed Plan preserve?',
      choices: [
        { label: 'Public', description: 'Public access.' },
        { label: 'Private', description: 'Private access.' },
      ],
      recommendation: null,
    };
    let investigators = 0,
      designers = 0,
      actors = 0;
    const runtime: WorkflowRuntime = {
      agent: {
        async runActor() {
          actors++;
          throw new ActorEscalation(
            'think',
            'Which policy applies?',
            'Confirmed outside-contract policy decision.',
          );
        },
        async reviewBuild() {
          throw new Error('No Build review before Issue publication.');
        },
      },
      executeAction,
      children: {
        think: {
          async design(i, reports) {
            designers++;
            if (reports.length) assert.deepEqual(i.clarification_answers, [answer]);
            return reports.length
              ? { status: 'ready', plan: returnPlan, research_questions: [] }
              : {
                  status: 'research_required',
                  plan: null,
                  research_questions: ['Investigate the policy implications.'],
                };
          },
          async review(i, _draft, reports) {
            if (reports.length) assert.deepEqual(i.clarification_answers, [answer]);
            return { summary: 'Supported decision.', findings: [] };
          },
        },
        research: {
          async investigate(i) {
            investigators++;
            return i.clarification_answers?.length
              ? returnResearch.investigate()
              : { status: 'waiting', question };
          },
          async audit() {
            return returnResearch.audit();
          },
        },
      },
    };
    const waiting = await runWorkflow(runId, input, runtime);
    assert('status' in waiting.result && waiting.result.status === 'waiting');
    const owner = waiting.result.owner;
    const before = loadWorkflowState(runId).state;
    const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
    const answer = {
      owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: null,
      selection: 'Private',
      answer: null,
    };
    fs.writeFileSync(input, JSON.stringify({ ...raw, clarification_answers: [answer] }));
    const script = path.join(temporaryDirectory('build-answer-exit-'), 'run.ts');
    fs.writeFileSync(
      script,
      `
      import fs from 'node:fs'; import {mock} from 'bun:test';
      const boundary=${JSON.stringify(boundary)};
      const failure='Interrupted intermediate Think write';
      let failed=false;
      const rename=fs.renameSync;
      fs.renameSync=(...args)=>{
        const file=String(args[1]);
        const next=file.endsWith('think-state.json') ? JSON.parse(fs.readFileSync(String(args[0]),'utf8')).state : null;
        const adoptingResearch=next?.phase==='design' && next.research.length===1 && next.attempts===0;
        const journalNext=file.includes('returns-') ? JSON.parse(fs.readFileSync(String(args[0]),'utf8')).state : null;
        const intermediateTransition=journalNext?.parent_transition?.parent.startsWith('stage-child:');
        const thinker=journalNext?.entries.find(e=>e.route==='think');
        const parent=thinker && journalNext.adoption?.phase==='routed' ? JSON.parse(fs.readFileSync(thinkStatePath(thinker.id),'utf8')).state : null;
        const settlingResearch=journalNext?.adoption?.phase==='routed' && !journalNext.parent_transition && parent?.phase==='design' && parent.research.length===1 && parent.attempts===0;
        if(boundary==='throw-settle-before' && settlingResearch && !failed){failed=true;throw Error(failure);}
        if(boundary==='throw-journal-before' && intermediateTransition && !failed){failed=true;throw Error(failure);}
        if(boundary==='throw-before' && adoptingResearch && !failed){failed=true;throw Error(failure);}
        rename(...args);
        if(boundary==='throw-after' && adoptingResearch && !failed){failed=true;throw Error(failure);}
        if(boundary==='throw-journal-after' && intermediateTransition && !failed){failed=true;throw Error(failure);}
        if(boundary==='throw-settle-after' && settlingResearch && !failed){failed=true;throw Error(failure);}
        if(file.includes('returns-')){
          const journal=JSON.parse(fs.readFileSync(file,'utf8')).state;
          if(boundary==='routed' && journal.adoption?.phase==='routed')process.exit(73);
          const parent=journal.entries.find(e=>e.route==='think');
          if(parent && journal.adoption?.phase==='routed'){
            // This is a subprocess hook around real atomic writes, not a synthetic journal.
            const current=JSON.parse(fs.readFileSync(thinkStatePath(parent.id),'utf8')).state;
            if(boundary==='parent-intent' && journal.parent_transition?.parent===parent.id)process.exit(73);
            if(boundary==='parent-settled' && !journal.parent_transition && current.phase==='design' && current.research.length===1 && current.attempts===0)process.exit(73);
          }
        }
        if(next && next.research.length===1){
          if(boundary==='parent-write' && adoptingResearch)process.exit(73);
          if(boundary==='design-dispatch' && next.phase==='design' && next.attempts===1)process.exit(73);
          if(boundary==='design-result' && next.phase==='validate')process.exit(73);
          if(boundary==='review-dispatch' && next.phase==='review' && next.attempts===1)process.exit(73);
          if(boundary==='review-result' && next.phase==='decide')process.exit(73);
          if(boundary==='review-correction' && next.phase==='design' && next.corrections===1)process.exit(73);
          if(boundary==='design-error' && next.phase==='design' && next.reason==='Model unavailable')process.exit(73);
          if(boundary==='think-blocked' && next.phase==='blocked')process.exit(73);
          if(boundary==='think-publish' && next.phase==='publish')process.exit(73);
        }
        if(file.includes('returns-') && ${JSON.stringify(boundary)}==='root' && JSON.parse(fs.readFileSync(file,'utf8')).state.adoption?.phase==='adopting')process.exit(73);
        if(file.endsWith('research-input.json') && ${JSON.stringify(boundary)}==='routing')process.exit(73);
        if(file.endsWith('research-state.json') && ${JSON.stringify(boundary)}==='leaf'){const s=JSON.parse(fs.readFileSync(file,'utf8')).state;if(s.clarification_history.length===1 && s.phase==='investigate')process.exit(73);}
        if(file.endsWith('think-state.json') && ${JSON.stringify(boundary)}==='think-completed' && JSON.parse(fs.readFileSync(file,'utf8')).state.phase==='completed')process.exit(73);
      };
      mock.module('node:fs',()=>({...fs,default:fs}));
      const {thinkStatePath}=await import(${JSON.stringify(new URL('../../runtime/storage.ts', import.meta.url).pathname)});
      const {runWorkflow}=await import(${JSON.stringify(new URL('../../execution/engine.ts', import.meta.url).pathname)});
      const result=await runWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)},{agent:{async runActor(){throw Error('No actor while awaiting Issue publication.');},async reviewBuild(){throw Error('No Build review.');}},executeAction(){throw Error('No Git action.');},children:{think:{async design(i){if(boundary==='design-error' || boundary==='think-blocked')throw Error('Model unavailable');if(JSON.stringify(i.clarification_answers)!==${JSON.stringify(JSON.stringify([answer]))})throw Error('Designer missing child answer history');return {status:'ready',plan:${JSON.stringify(returnPlan)},research_questions:[]};},async review(i){if(boundary==='review-correction')return {summary:'Correction required.',findings:[{severity:'blocking',condition:'Preserve the selected policy.',message:'Clarify the selected policy in the Plan.',evidence:['The answer selects Private.']}]};if(JSON.stringify(i.clarification_answers)!==${JSON.stringify(JSON.stringify([answer]))})throw Error('Reviewer missing child answer history');return {summary:'Pass.',findings:[]};}},research:{async investigate(){return ${JSON.stringify(await returnResearch.investigate())};},async audit(){return {summary:'Pass.',findings:[]};}}}});
      if(boundary.startsWith('throw-')){if(result.result.runtime_failure?.error!==failure)throw Error(JSON.stringify(result));process.exit(74);}
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    assert.equal(await child.exited, boundary.startsWith('throw-') ? 74 : 73, await stderr);
    const journalFile = path.join(
      workflowRunDirectory(runId),
      `returns-${before.invocation_id}.json`,
    );
    await rejectMissingJournal(runId, input, countFile);
    const interruptedJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8')).state;
    const parentId = interruptedJournal.entries.find(
      (entry: { route: string }) => entry.route === 'think',
    ).id;
    const { loadThinkState, saveThinkState, thinkDigest } = await import('../../think/state.ts');
    const { loadResearchState } = await import('../../research/state.ts');
    const interruptedParent = loadThinkState(parentId)!;
    const interruptedLeaf = loadResearchState(owner.leaf)!;
    if (boundary === 'routed') {
      const bytes = fs.readFileSync(journalFile, 'utf8');
      const incompatible = JSON.parse(bytes);
      incompatible.state.protocol = 'codex-stage-returns-v6';
      incompatible.digest = thinkDigest(incompatible.state);
      const edited = JSON.stringify(incompatible);
      fs.writeFileSync(journalFile, edited);
      await assert.rejects(
        runWorkflow(runId, input, runtime),
        /cross-stage state cannot resume.*retain it/,
      );
      assert.equal(fs.readFileSync(journalFile, 'utf8'), edited);
      assert.equal(investigators, 1);
      assert.equal(designers, 1);
      fs.writeFileSync(journalFile, bytes);
    }
    // Re-saving a valid state envelope must not authorize new selected evidence,
    // candidates, reviews or budgets, including either side of an unfinished write.
    for (const field of [
      'knowledge',
      'research',
      'candidate',
      'review',
      'corrections',
      'dispatch_history',
      'clarification_history',
    ] as const) {
      const changed = structuredClone(interruptedParent);
      if (field === 'knowledge' || field === 'research')
        changed[field].push({
          path: 'edited-context.json',
          generated_at: '2026-01-01T00:00:00.000Z',
          question: 'Injected evidence selection',
          answer: 'Changed captured context.',
          findings: [],
          unknowns: [
            {
              question: 'Injected unresolved fact.',
              resolution: 'Inspect the selected repository evidence.',
            },
          ],
          limitations: [],
          clarification_answers: [],
        });
      else if (field === 'candidate') {
        if (!changed.candidate) continue;
        if (changed.candidate.plan) changed.candidate.plan.outcome += ' Changed authority.';
        else changed.candidate.research_questions.push('Injected factual question.');
      } else if (field === 'clarification_history') changed.clarification_history.push(answer);
      else if (field === 'review') {
        if (!changed.review) continue;
        changed.review.summary = 'Changed independent acceptance';
      } else if (field === 'corrections') changed.corrections = (changed.corrections + 1) % 4;
      else changed.dispatch_history.push(crypto.randomUUID());
      saveThinkState(parentId, changed);
      assert.equal(loadThinkState(parentId)!.stage_binding, interruptedParent.stage_binding);
      await assert.rejects(
        runWorkflow(runId, input, runtime),
        /parent authority changed|parent changed/,
      );
      assert.equal(investigators, 1);
      assert.equal(designers, 1);
      assert.equal(actors, 1);
      saveThinkState(parentId, interruptedParent);
    }
    await runWorkflow(runId, input, runtime);
    const after = loadWorkflowState(runId).state;
    assert.equal(after.escalation?.next_step, boundary === 'think-blocked' ? 'think' : 'issue');
    assert.equal(after.invocation_id, before.invocation_id);
    assert.equal(after.input_sha256, before.input_sha256);
    assert.deepEqual(after.build_plan, before.build_plan);
    assert.equal(actors, 1);
    assert.equal(investigators, interruptedLeaf.phase === 'completed' ? 1 : 2);
    assert.equal(designers, ['research', 'design'].includes(interruptedParent.phase) ? 2 : 1);
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
    const record = JSON.parse(
      fs.readFileSync(
        path.join(workflowRunDirectory(runId), `returns-${before.invocation_id}.json`),
        'utf8',
      ),
    ).state;
    assert.equal(record.entries.length, 2);
    assert(record.entries.some((entry: { id: string }) => entry.id === owner.leaf));
    assert.deepEqual(loadResearchState(owner.leaf)!.clarification_history, [answer]);
    const parent = loadThinkState(
      record.entries.find((entry: { route: string }) => entry.route === 'think').id,
    )!;
    assert.deepEqual(parent.research[0]!.clarification_answers, [answer]);
    assert.equal(parent.input.clarification_answers, undefined);
    assert.equal(parent.corrections, interruptedParent.corrections);
    assert.deepEqual(
      parent.dispatch_history.slice(0, interruptedParent.dispatch_history.length),
      interruptedParent.dispatch_history,
    );
    assert.equal(parent.phase, boundary === 'think-blocked' ? 'blocked' : 'completed');
    if (boundary === 'think-blocked') assert.equal(parent.attempts, 2);
  }, 30000);
}

test('a nested Think decision after answered Research retains chronological full context and the same two children', async () => {
  const { runId, input, countFile } = buildFixture(returnPlan);
  const questions = ['research-policy', 'think-policy'].map((id) => ({
    id,
    prompt: `${id}: Which necessary user-owned policy is in scope?`,
    choices: [
      { label: 'Private', description: 'Restrict access.' },
      { label: 'Public', description: 'Allow public access.' },
    ],
    recommendation: null,
  }));
  const answers: import('../../runtime/clarification.ts').ClarificationAnswer[] = [];
  let calls = 0;
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor() {
        calls++;
        throw new ActorEscalation(
          'think',
          'Which policy applies?',
          'Confirmed outside-contract policy decision.',
        );
      },
      async reviewBuild() {
        throw new Error('No implementation review.');
      },
    },
    executeAction,
    children: {
      research: {
        async investigate(i) {
          calls++;
          return i.clarification_answers?.length
            ? returnResearch.investigate()
            : { status: 'waiting', question: questions[0]! };
        },
        async audit() {
          calls++;
          return returnResearch.audit();
        },
      },
      think: {
        async design(i, reports) {
          calls++;
          if (!reports.length)
            return {
              status: 'research_required',
              plan: null,
              research_questions: ['Investigate the governing policy.'],
            };
          assert.deepEqual(i.clarification_answers, answers);
          return answers.length === 1
            ? { status: 'waiting', plan: null, research_questions: [], question: questions[1]! }
            : { status: 'ready', plan: returnPlan, research_questions: [] };
        },
        async review(i, _draft, reports) {
          calls++;
          if (reports.length) assert.deepEqual(i.clarification_answers, answers);
          return { summary: 'Necessary decision or supported Plan.', findings: [] };
        },
      },
    },
  };
  let result = await runWorkflow(runId, input, runtime);
  const capturedPlan = loadWorkflowState(runId).state.build_plan;
  const original = JSON.parse(fs.readFileSync(input, 'utf8'));
  const leaves: string[] = [];
  for (const question of questions) {
    assert('status' in result.result && result.result.status === 'waiting');
    assert.deepEqual(result.result.question, question);
    leaves.push(result.result.owner.leaf);
    const settledCalls = calls;
    assert.deepEqual(await runWorkflow(runId, input, runtime), result);
    assert.equal(calls, settledCalls);
    answers.push({
      owner: result.result.owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: null,
      selection: 'Private',
      answer: null,
    });
    fs.writeFileSync(input, JSON.stringify({ ...original, clarification_answers: answers }));
    result = await runWorkflow(runId, input, runtime);
  }
  assert.notEqual(leaves[0], leaves[1]);
  const state = loadWorkflowState(runId).state;
  assert.equal(state.escalation?.next_step, 'issue');
  assert.deepEqual(state.build_plan, capturedPlan);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  const record = JSON.parse(
    fs.readFileSync(
      path.join(workflowRunDirectory(runId), `returns-${state.invocation_id}.json`),
      'utf8',
    ),
  ).state;
  assert.equal(record.entries.length, 2);
  const { loadThinkState } = await import('../../think/state.ts');
  const parent = loadThinkState(leaves[1]!)!;
  assert.deepEqual(parent.research[0]!.clarification_answers, answers.slice(0, 1));
  assert.deepEqual(parent.clarification_history, answers.slice(1));
}, 20000);

test('fresh Build rejects unowned answer history before reading the Issue or dispatching', async () => {
  const { parseBuildRunInput } = await import('../../build/input.ts');
  const { repo, runId, input, countFile } = buildFixture(returnPlan);
  const original = JSON.parse(fs.readFileSync(input, 'utf8'));
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor() {
        throw new Error('No actor dispatch.');
      },
      async reviewBuild() {
        throw new Error('No review dispatch.');
      },
    },
    executeAction() {
      throw new Error('No Git action.');
    },
  };
  for (const clarification_answers of [[{ question_id: 'fabricated' }], 'invalid', null]) {
    const submitted = { ...original, clarification_answers };
    assert.throws(() => parseBuildRunInput(submitted), /existing waiting owner/);
    fs.writeFileSync(input, JSON.stringify(submitted));
    await assert.rejects(runWorkflow(runId, input, runtime), /existing waiting owner/);
    assert.equal(fs.readFileSync(countFile, 'utf8'), '');
    assert.throws(() => loadWorkflowState(runId), /no workflow/);
  }
  assert.equal(parseBuildRunInput({ ...original, clarification_answers: [] }).repo, repo);
});

test('answered Build to Think recovers a reserved Research child before and after initialization', async () => {
  const { loadThinkState, thinkDigest } = await import('../../think/state.ts');
  const { loadResearchState } = await import('../../research/state.ts');
  const { researchStatePath } = await import('../../runtime/storage.ts');
  const { runStageReturn } = await import('../../runtime/stage-return.ts');
  for (const boundary of ['reservation', 'input', 'initialized', 'started']) {
    const { runId, input, countFile, repo, startPoint } = buildFixture(returnPlan);
    const directory = temporaryDirectory('build-reservation-exit-');
    const calls = path.join(directory, 'calls');
    fs.writeFileSync(calls, '');
    const recordCall = (name: string) => fs.appendFileSync(calls, `${name}\n`);
    const question = {
      id: 'policy-before-research',
      prompt: 'Which access policy must the proposal evaluate?',
      choices: [
        { label: 'Public', description: 'Evaluate public access.' },
        { label: 'Private', description: 'Evaluate restricted access.' },
      ],
      recommendation: null,
    };
    let answer: import('../../runtime/clarification.ts').ClarificationAnswer;
    const runtime: WorkflowRuntime = {
      agent: {
        async runActor() {
          recordCall('actor');
          throw new ActorEscalation(
            'think',
            'Which policy is required?',
            'Confirmed a policy decision beyond the captured Plan.',
          );
        },
        async reviewBuild() {
          throw new Error('No Build review.');
        },
      },
      executeAction,
      children: {
        think: {
          async design(i, reports) {
            recordCall('design');
            if (!i.clarification_answers?.length)
              return { status: 'waiting', plan: null, research_questions: [], question };
            assert.deepEqual(i.clarification_answers, [answer]);
            return reports.length
              ? { status: 'ready', plan: returnPlan, research_questions: [] }
              : {
                  status: 'research_required',
                  plan: null,
                  research_questions: ['Investigate the selected policy.'],
                };
          },
          async review() {
            recordCall('review');
            return { summary: 'Supported.', findings: [] };
          },
        },
        research: {
          async investigate(i) {
            recordCall('investigate');
            assert.deepEqual(i.clarification_answers, [answer]);
            return returnResearch.investigate();
          },
          async audit(i) {
            recordCall('audit');
            assert.deepEqual(i.clarification_answers, [answer]);
            return returnResearch.audit();
          },
        },
      },
    };
    const waiting = await runWorkflow(runId, input, runtime);
    assert('status' in waiting.result && waiting.result.status === 'waiting');
    const before = loadWorkflowState(runId).state;
    const original = JSON.parse(fs.readFileSync(input, 'utf8'));
    answer = {
      owner: waiting.result.owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: null,
      selection: 'Private',
      answer: null,
    };
    // Even a structurally valid answer cannot be inherited before root adoption.
    fs.writeFileSync(
      input,
      JSON.stringify({
        ...original,
        clarification_answers: [{ ...answer, owner: { ...answer.owner, task: 'unrelated' } }],
      }),
    );
    await assert.rejects(
      runStageReturn(runId, 'build', runtime.children),
      /journaled waiting-owner adoption/,
    );
    assert.equal(fs.readFileSync(calls, 'utf8'), 'actor\ndesign\nreview\n');
    fs.writeFileSync(input, JSON.stringify({ ...original, clarification_answers: [answer] }));
    const script = path.join(directory, 'run.ts');
    fs.writeFileSync(
      script,
      `
      import fs from 'node:fs'; import {mock} from 'bun:test';
      const rename=fs.renameSync;
      fs.renameSync=(...args)=>{rename(...args);const file=String(args[1]);
        if(file.includes('returns-')){const s=JSON.parse(fs.readFileSync(file,'utf8')).state;
          if(s.entries.length===2 && ${JSON.stringify(boundary)}==='reservation')process.exit(73);
          if(s.entries.length===2 && s.started.includes(s.entries[1].id) && ${JSON.stringify(boundary)}==='started')process.exit(73);
        }
        if(file.endsWith('research-input.json') && ${JSON.stringify(boundary)}==='input')process.exit(73);
        if(file.endsWith('research-state.json') && ${JSON.stringify(boundary)}==='initialized')process.exit(73);
      };
      mock.module('node:fs',()=>({...fs,default:fs}));
      const {runWorkflow}=await import(${JSON.stringify(new URL('../../execution/engine.ts', import.meta.url).pathname)});
      const log=(name)=>fs.appendFileSync(${JSON.stringify(calls)},name+'\\n');
      await runWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)},{
        agent:{async runActor(){throw Error('No actor.');},async reviewBuild(){throw Error('No Build review.');}},
        executeAction(){throw Error('No Git action.');},
        children:{think:{
          async design(i){log('design');if(JSON.stringify(i.clarification_answers)!==${JSON.stringify(JSON.stringify([answer]))})throw Error('Missing bound answer');return {status:'research_required',plan:null,research_questions:['Investigate the selected policy.']};},
          async review(){log('review');return {summary:'Supported.',findings:[]};}
        },research:{async investigate(){throw Error('Exited before investigator dispatch.');},async audit(){throw Error('No audit.');}}}
      });
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    assert.equal(await child.exited, 73, await stderr);
    await stdout;
    const file = path.join(workflowRunDirectory(runId), `returns-${before.invocation_id}.json`);
    await rejectMissingJournal(runId, input, countFile);
    const stored = fs.readFileSync(file, 'utf8');
    const journal = JSON.parse(stored).state;
    const reserved = journal.entries[1];
    assert.equal(journal.entries.length, 2);
    assert.equal(journal.adoption.phase, 'routed');
    assert.equal(journal.started.includes(reserved.id), boundary === 'started');
    assert.equal(
      Boolean(loadResearchState(reserved.id)),
      ['initialized', 'started'].includes(boundary),
    );
    assert.equal(fs.readFileSync(calls, 'utf8'), 'actor\ndesign\nreview\ndesign\nreview\n');
    if (boundary === 'reservation') {
      for (const field of ['key', 'input', 'source', 'inherited']) {
        const changed = JSON.parse(stored);
        if (field === 'input') changed.state.entries[1].input.question += ' edited';
        else if (field === 'inherited') changed.state.entries[1].inherited = [];
        else changed.state.entries[1][field] = 'a'.repeat(64);
        changed.digest = thinkDigest(changed.state);
        fs.writeFileSync(file, JSON.stringify(changed));
        await assert.rejects(
          runWorkflow(runId, input, runtime),
          /reservation changed|history|input changed/,
        );
        assert.equal(fs.readFileSync(calls, 'utf8'), 'actor\ndesign\nreview\ndesign\nreview\n');
      }
      fs.writeFileSync(file, stored);
    }
    if (boundary === 'started') {
      const stateFile = researchStatePath(reserved.id);
      const bytes = fs.readFileSync(stateFile, 'utf8');
      fs.unlinkSync(stateFile);
      await assert.rejects(runWorkflow(runId, input, runtime), /dispatch entry changed/);
      assert.equal(fs.readFileSync(calls, 'utf8'), 'actor\ndesign\nreview\ndesign\nreview\n');
      fs.writeFileSync(stateFile, bytes);
    }
    const result = await runWorkflow(runId, input, runtime);
    const after = loadWorkflowState(runId).state;
    assert.equal(result.exitCode, 2, JSON.stringify(result));
    assert.equal(after.escalation?.next_step, 'issue', JSON.stringify(result));
    assert.equal(after.invocation_id, before.invocation_id);
    assert.equal(after.input_sha256, before.input_sha256);
    assert.deepEqual(after.build_plan, before.build_plan);
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), startPoint);
    assert.equal(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), 'export const value = 1;\n');
    const completed = JSON.parse(fs.readFileSync(file, 'utf8')).state;
    assert.deepEqual(
      completed.entries.map((entry: { id: string }) => entry.id),
      journal.entries.map((entry: { id: string }) => entry.id),
    );
    assert.deepEqual(loadResearchState(reserved.id)!.clarification_history, [answer]);
    assert.deepEqual(loadThinkState(waiting.result.owner.leaf)!.clarification_history, [answer]);
    assert.equal(
      fs.readFileSync(calls, 'utf8'),
      'actor\ndesign\nreview\ndesign\nreview\ninvestigate\naudit\ndesign\nreview\n',
    );
    await runWorkflow(runId, input, runtime);
    assert.equal(
      fs.readFileSync(calls, 'utf8'),
      'actor\ndesign\nreview\ndesign\nreview\ninvestigate\naudit\ndesign\nreview\n',
    );
  }
}, 60000);

for (const route of ['research', 'think', 'think-research'] as const) {
  test(`Build ${route} initialization and reservations cannot replace lost ownership`, async () => {
    const boundaries =
      route === 'research'
        ? ['journal', 'root', 'reserved', 'child-state']
        : ['reserved', 'child-state'];
    for (const boundary of boundaries) {
      const { runId, input, countFile } = buildFixture(returnPlan);
      const question = {
        id: 'reservation-policy',
        prompt: 'Which policy should the decision preserve?',
        choices: [
          { label: 'Public', description: 'Preserve public access.' },
          { label: 'Private', description: 'Preserve private access.' },
        ],
        recommendation: null,
      };
      const script = path.join(temporaryDirectory('build-reservation-'), 'run.ts');
      fs.writeFileSync(
        script,
        `
        import fs from 'node:fs'; import {mock} from 'bun:test';
        const rename=fs.renameSync;
        fs.renameSync=(...args)=>{rename(...args);const file=String(args[1]);
          if(file.includes('returns-')){
            const entries=JSON.parse(fs.readFileSync(file,'utf8')).state.entries;
            if((${JSON.stringify(boundary)}==='journal' && entries.length===0) ||
              (${JSON.stringify(boundary)}==='reserved' && entries.length===${route === 'think-research' ? 2 : 1}))process.exit(73);
          }
          if(${JSON.stringify(boundary)}==='root' && file.endsWith('/state.json'))process.exit(73);
          if(${JSON.stringify(boundary)}==='child-state' && file.endsWith(${JSON.stringify(route === 'think' ? 'think-state.json' : 'research-state.json')}))process.exit(73);
        };
        mock.module('node:fs',()=>({...fs,default:fs}));
        const {runWorkflow}=await import(${JSON.stringify(new URL('../../execution/engine.ts', import.meta.url).pathname)});
        const {ActorEscalation}=await import(${JSON.stringify(new URL('../../execution/agent.ts', import.meta.url).pathname)});
        const {executeAction}=await import(${JSON.stringify(new URL('../../build/git-actions.ts', import.meta.url).pathname)});
        await runWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)}, {
          agent: {async runActor(){throw new ActorEscalation(${JSON.stringify(route === 'research' ? 'research' : 'think')}, 'Which policy applies?', 'Confirmed outside-contract policy decision.');},
            async reviewBuild(){throw Error('No Build review while waiting');}}, executeAction,
          children: {think: {async design(){return ${JSON.stringify(route === 'think-research' ? { status: 'research_required', plan: null, research_questions: ['Investigate the policy.'] } : { status: 'waiting', plan: null, research_questions: [], question })};},
            async review(){return {summary:'Supported decision.',findings:[]};}},
            research: {async investigate(){return {status:'waiting',question:${JSON.stringify(question)}};},
              async audit(){return {summary:'Necessary user decision.',findings:[]};}}}
        });
      `,
      );
      const child = Bun.spawn([process.execPath, script], {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = new Response(child.stderr).text();
      assert.equal(await child.exited, 73, await stderr);
      const directory = workflowRunDirectory(runId);
      const journalName = fs.readdirSync(directory).find((name) => name.startsWith('returns-'))!;
      const journalFile = path.join(directory, journalName);
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')).state;
      if (boundary === 'journal') {
        assert.throws(() => loadWorkflowState(runId), /no workflow/);
        assert.deepEqual(journal.entries, []);
        fs.unlinkSync(journalFile);
      } else await rejectMissingJournal(runId, input, countFile);
      let actors = 0;
      const result = await runWorkflow(runId, input, {
        agent: {
          async runActor() {
            actors++;
            throw new ActorEscalation(
              route === 'research' ? 'research' : 'think',
              'Which policy applies?',
              'Confirmed outside-contract policy decision.',
            );
          },
          async reviewBuild() {
            throw Error('No Build review while waiting');
          },
        },
        executeAction,
        children: {
          think: {
            async design() {
              return route === 'think-research'
                ? {
                    status: 'research_required',
                    plan: null,
                    research_questions: ['Investigate the policy.'],
                  }
                : { status: 'waiting', plan: null, research_questions: [], question };
            },
            async review() {
              return { summary: 'Supported decision.', findings: [] };
            },
          },
          research: {
            async investigate() {
              return { status: 'waiting', question };
            },
            async audit() {
              return { summary: 'Necessary user decision.', findings: [] };
            },
          },
        },
      });
      assert(
        'status' in result.result && result.result.status === 'waiting',
        JSON.stringify(result),
      );
      assert.equal(actors, ['journal', 'root'].includes(boundary) ? 1 : 0);
      const root = loadWorkflowState(runId).state;
      const resumed = JSON.parse(
        fs.readFileSync(path.join(directory, `returns-${root.invocation_id}.json`), 'utf8'),
      ).state;
      assert.equal(resumed.entries.length, route === 'think-research' ? 2 : 1);
      if (journal.entries.length) assert.deepEqual(resumed.entries, journal.entries);
      assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
      await rejectMissingJournal(runId, input, countFile);
    }
  }, 30000);
}

test('a terminal Build proposal permits fresh authorization without recreating its lost journal', async () => {
  const { handle } = await import('../../../hooks/workflow-enforcer.ts');
  const { loadThinkState } = await import('../../think/state.ts');
  const { repo, runId, input, countFile } = buildFixture(returnPlan);
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'OUTCOME.md'), '# Project outcome\nExport value 2.\n');
  let actors = 0;
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor() {
        actors++;
        throw new ActorEscalation(
          'think',
          'Which policy applies?',
          'Confirmed outside-contract policy decision.',
        );
      },
      async reviewBuild() {
        throw Error('No Build review before Issue publication.');
      },
    },
    executeAction,
    children: {
      think: {
        async design() {
          return { status: 'ready', plan: returnPlan, research_questions: [] };
        },
        async review() {
          return { summary: 'Supported proposal.', findings: [] };
        },
      },
    },
  };
  await runWorkflow(runId, input, runtime);
  const terminal = loadWorkflowState(runId).state;
  assert.equal(terminal.escalation?.next_step, 'issue');
  const file = path.join(workflowRunDirectory(runId), `returns-${terminal.invocation_id}.json`);
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')).state;
  const leaf = loadThinkState(journal.entries[0].id);
  fs.unlinkSync(file);
  await assert.rejects(runWorkflow(runId, input, runtime), /missing cross-stage ownership record/);
  assert.equal(actors, 1);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.deepEqual(loadWorkflowState(runId).state, terminal);
  const authorized = handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: runId,
    cwd: repo,
    prompt: '$build 1',
  });
  assert.equal(authorized.decision, undefined, JSON.stringify(authorized));
  assert.match(authorized.hookSpecificOutput!.additionalContext!, /Explicit \$build is armed/);
  fs.writeFileSync(input, JSON.stringify({ repo, issue_number: 1, ship: false }));
  await runWorkflow(runId, input, runtime);
  const fresh = loadWorkflowState(runId).state;
  assert.notEqual(fresh.invocation_id, terminal.invocation_id);
  assert.equal(fresh.escalation?.next_step, 'issue');
  assert.equal(actors, 2);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'xx');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(loadThinkState(journal.entries[0].id), leaf);
  const newJournal = JSON.parse(
    fs.readFileSync(
      path.join(workflowRunDirectory(runId), `returns-${fresh.invocation_id}.json`),
      'utf8',
    ),
  ).state;
  assert.equal(newJournal.entries.length, 1);
  assert.notEqual(newJournal.entries[0].id, journal.entries[0].id);
}, 15000);
