import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { withInterrupts } from '../process.ts';
import { createHash } from 'node:crypto';
import { isRecord } from '../values.ts';
import { expect, test } from 'bun:test';
import { evalConfig, validatePlan } from '../eval/data.ts';

const config = evalConfig.parse({
  repository: 'thkt/dotagents',
  issue: 'https://github.com/thkt/dotagents/issues/191',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  corpusCommit: 'c'.repeat(40),
  workspaceCommit: 'a'.repeat(40),
  workspaceFiles: ['README.md'],
  instructionFiles: ['AGENTS.md', 'skills/scoping/SKILL.md', 'skills/implement/SKILL.md'],
  cases: ['positive'],
  image: `local/eval@sha256:${'d'.repeat(64)}`,
  imageReview: 'Reviewed image contains only public tools and no authentication or user settings.',
  model: 'example-model',
  reasoning: 'high',
  cliVersion: 'codex-cli 0.156.1',
  bunVersion: '1.4.2',
  gitVersion: 'git version 2.50.1',
  caseTimeMs: 10000,
  totalTimeMs: 30000,
  maxModelRequestsPerCase: 5,
  maxOutputTokens: 4000,
  maxTrials: 2,
  outputDirectory: '/tmp/eval-new',
  disclosure: {
    inputs: 'reviewed-public-committed-files-only',
    raw: 'local-only',
    summary: 'manual-issue-or-pr',
  },
});
const caseContext = {
  source: 'https://github.com/thkt/dotagents/issues/187',
  body: 'PUBLIC_ISSUE_BODY_CANARY',
  title: 'Public issue title',
  updatedAt: '2026-09-23T09:23:48Z',
};

const cases = [
  {
    id: 'positive',
    source: 'https://github.com/thkt/dotagents/issues/183',
    prompt: 'Review requirements',
    expected: 'scoping' as const,
    criteria: ['Identify unresolved requirements'],
  },
];

test('planning rejects unknown cases, insufficient budgets and hidden answer files before execution', () => {
  expect(validatePlan(config, cases)).toEqual(cases);
  expect(() => validatePlan({ ...config, cases: ['missing'] }, cases)).toThrow('case');
  expect(() => validatePlan({ ...config, maxTrials: 1 }, cases)).toThrow('trial');
  expect(() =>
    validatePlan({ ...config, workspaceFiles: ['scripts/eval/corpus/cases.json'] }, cases),
  ).toThrow('host-only');
  expect(() => validatePlan({ ...config, instructionFiles: ['docs/README.md'] }, cases)).toThrow(
    'instruction',
  );
  expect(() => evalConfig.parse({ ...config, totalTimeMs: 0 })).toThrow();
});

test('evaluation targets accept only this repository on the exact GitHub host', () => {
  for (const kind of ['issues', 'pull']) {
    expect(
      evalConfig.shape.issue.safeParse(`https://github.com/thkt/dotagents/${kind}/191`).success,
    ).toBe(true);
  }
  for (const issue of [
    'https://githubXcom/thkt/dotagents/issues/191',
    'https://github.com.example/thkt/dotagents/pull/191',
    'https://github.com/other/dotagents/issues/191',
  ]) {
    expect(evalConfig.shape.issue.safeParse(issue).success).toBe(false);
  }
});

import { providerGateway, providerBody } from '../eval/container.ts';
import { assessTrial, readUsage } from '../eval/report.ts';
import { containerArgs, verifyImage, verifyNetwork } from '../eval/sandbox.ts';

const limits = {
  model: 'example-model',
  reasoning: 'high',
  maxRequests: 1,
  maxOutputTokens: 100,
};
const body = {
  model: limits.model,
  reasoning: { effort: limits.reasoning },
  input: 'public task',
  tools: [],
};
const request = (input: unknown = body, path = '/v1/responses') =>
  new Request(`http://gateway:8080${path}`, { method: 'POST', body: JSON.stringify(input) });

test('canonical paths cannot smuggle answer files or collide with effective instructions', () => {
  for (const path of [
    './scripts/eval/corpus/cases.json',
    'docs/../scripts/eval/corpus/cases.json',
    './README.md',
  ]) {
    expect(() => evalConfig.parse({ ...config, workspaceFiles: [path] })).toThrow();
  }
  expect(() => validatePlan({ ...config, workspaceFiles: ['AGENTS.md'] }, cases)).toThrow(
    'overlap',
  );
});

test('gateway enforces the shared request budget under concurrent child requests without exposing authentication', async () => {
  const sent: { url: unknown; init: unknown }[] = [];
  const gateway = providerGateway(limits, 'private-provider-key', async (url, init) => {
    sent.push({ url, init });
    return new Response('data: {"type":"response.completed"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  const responses = await Promise.all(
    [1, 2, 3].map((n) => gateway.handle(request({ ...body, input: String(n) }))),
  );
  expect(sent).toHaveLength(1);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  expect(gateway.stats().requests).toBe(1);
  expect(await responses[0]?.text()).not.toContain('private-provider-key');
  expect(sent[0]?.url).toBe('https://api.openai.com/v1/responses');
  expect(providerBody(body, limits)).toMatchObject({ store: false, max_output_tokens: 100 });
});

test('gateway accepts inline conversation and local tool results but never sends stored references or input controls', async () => {
  const sent: unknown[] = [];
  const gateway = providerGateway(limits, 'private-provider-key', async (_url, init) => {
    assert(typeof init.body === 'string');
    sent.push(JSON.parse(init.body));
    return new Response('data: {"type":"response.completed"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  for (const item of [
    { type: 'item_reference', id: 'msg_from_another_run' },
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'web_search' }] },
    { type: 'configuration_update', reasoning: { effort: 'low' } },
    { type: 'tool_search_output', call_id: 'search', tools: [{ type: 'web_search' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'private-file' }] },
  ]) {
    expect((await gateway.handle(request({ ...body, input: [item] }))).status).toBe(403);
  }
  expect(sent).toHaveLength(0);
  expect(gateway.stats().requests).toBe(0);
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review README' }] },
    { type: 'reasoning', summary: [], encrypted_content: 'inline-reasoning' },
    {
      type: 'function_call',
      call_id: 'read',
      name: 'exec_command',
      arguments: '{"cmd":"cat README.md"}',
    },
    { type: 'function_call_output', call_id: 'read', output: 'Public README text' },
    { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: 'local patch' },
    {
      type: 'custom_tool_call_output',
      call_id: 'patch',
      output: [{ type: 'input_text', text: 'Done' }],
    },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'No findings' }] },
  ];
  const response = await gateway.handle(request({ ...body, input }));
  expect(response.status).toBe(200);
  await response.text();
  expect(sent).toEqual([
    { ...body, input, store: false, max_output_tokens: limits.maxOutputTokens },
  ]);
});

test('gateway refuses publication endpoints, remote tools, other models and retries after provider failure', async () => {
  let calls = 0;
  const gateway = providerGateway(
    { ...limits, maxRequests: 3 },
    'private-provider-key',
    async () => {
      calls++;
      return new Response('authentication: private-provider-key', { status: 401 });
    },
  );
  expect((await gateway.handle(request(body, '/github'))).status).toBe(403);
  expect((await gateway.handle(request({ ...body, tools: [{ type: 'web_search' }] }))).status).toBe(
    403,
  );
  expect((await gateway.handle(request({ ...body, model: 'other' }))).status).toBe(403);
  const failed = await gateway.handle(request());
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('private-provider-key');
  expect((await gateway.handle(request({ ...body, input: 'retry' }))).status).toBe(403);
  expect(calls).toBe(1);
});

test('container boundary rejects host gateways, credentials and volumes and keeps mounts read-only', () => {
  const valid = [
    {
      Driver: 'bridge',
      Internal: true,
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    },
  ];
  expect(() => verifyNetwork(valid)).not.toThrow();
  expect(() => verifyNetwork([{ ...valid[0], Internal: false }])).toThrow('isolated');
  expect(() => verifyNetwork([{ ...valid[0], Options: {} }])).toThrow('gateway');
  expect(() => verifyImage([{ Config: { Env: ['PATH=/usr/bin'], Volumes: null } }])).not.toThrow();
  expect(() => verifyImage([{ Config: { Env: ['GH_TOKEN=private'], Volumes: null } }])).toThrow(
    'environment',
  );
  expect(() => verifyImage([{ Config: { Env: [], Volumes: { '/private': {} } } }])).toThrow(
    'volumes',
  );
  const args = containerArgs(
    'actor',
    config.image,
    'isolated',
    '/tmp/runtime',
    'actor',
    '/tmp/input',
  );
  expect(args).toContain('--read-only');
  expect(args).toContain('no-new-privileges');
  expect(args.filter((arg) => arg.startsWith('type=bind'))).toEqual([
    'type=bind,src=/tmp/runtime,dst=/runtime,readonly',
    'type=bind,src=/tmp/input,dst=/input,readonly',
  ]);
  expect(args).not.toContain('OPENAI_API_KEY');
});

test('selection and outcome stay separate and missing usage is not zero', () => {
  const record = {
    trial: 'before-positive',
    side: 'before' as const,
    case: 'positive',
    expected: 'scoping' as const,
    execution: 'failed' as const,
    launched: true,
    elapsedMs: 12,
    safety: { containersRemoved: true, networkRemoved: true },
  };
  const reference = {
    file: 'actor.stdout',
    sha256: 'a'.repeat(64),
    lines: [1, 2] as [number, number],
  };
  const judgment = {
    trial: record.trial,
    selection: 'scoping' as const,
    bodyReads: [reference],
    applications: [reference],
    completeTrace: [],
    outcome: 'indeterminate' as const,
    evidence: [],
    reason: 'Read and applied; process failed before outcome verification',
  };
  expect(assessTrial(record, judgment)).toEqual({
    selection: 'scoping',
    outcome: 'indeterminate',
    correct: true,
  });
  expect(() =>
    assessTrial(record, { ...judgment, outcome: 'fulfilled', evidence: [reference] }),
  ).toThrow('Failed execution');
  expect(() => assessTrial({ ...record, launched: false }, judgment)).toThrow('unevaluated');
  expect(() => assessTrial(record, { ...judgment, applications: [] })).toThrow('application');
  expect(assessTrial({ ...record, expected: 'boundary' }, judgment).correct).toBeNull();
  expect(readUsage(['broken json']).totals).toBeNull();
  expect(
    readUsage([
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}',
      'partial',
    ]),
  ).toMatchObject({
    totals: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
    incompleteLines: 1,
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeTarget, git, targetConfig } from './support/target.ts';
import { preparePlan, runEvaluation } from '../eval/eval.ts';
import { writeComparison } from '../eval/report.ts';

async function fixture(root: string) {
  const repo = join(root, 'repo');
  await mkdir(repo);
  await initializeTarget(repo, { ...targetConfig, repository: 'thkt/dotagents', remote: 'origin' });
  for (const path of ['scripts/eval/corpus', 'skills/scoping', 'skills/implement']) {
    await mkdir(join(repo, path), { recursive: true });
  }
  await writeFile(join(repo, 'README.md'), 'Public task context');
  await writeFile(join(repo, 'AGENTS.md'), 'Before instructions');
  await writeFile(join(repo, 'skills/scoping/SKILL.md'), 'Public scoping body');
  await writeFile(join(repo, 'skills/implement/SKILL.md'), 'Public implement body');
  await writeFile(
    join(repo, 'scripts/eval/corpus/cases.json'),
    JSON.stringify([
      { ...cases[0], criteria: ['HOST_ONLY_EXPECTED_CANARY'], context: caseContext },
    ]),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'public inputs');
  const before = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'AGENTS.md'), 'After instructions');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'instruction candidate');
  const after = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'PRIVATE_UNCOMMITTED_CANARY');
  const plan = {
    ...config,
    before,
    after,
    corpusCommit: before,
    workspaceCommit: before,
    outputDirectory: join(root, 'run'),
  };
  return { root, repo, plan };
}

const fakeDocker = `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2), root=process.env.EVAL_TEST_ROOT;
appendFileSync(join(root,'calls.jsonl'),JSON.stringify(args)+'\\n');
const net=[{Driver:'bridge',Internal:process.env.EVAL_TEST_FAILURE!=='network',EnableIPv6:false,Options:{'com.docker.network.bridge.gateway_mode_ipv4':'isolated'}}];
if(args[0]==='image') console.log(JSON.stringify([{Config:{Env:['PATH=/usr/local/bin:/usr/bin:/bin'],Volumes:null}}]));
if(args[0]==='network'&&args[1]==='inspect') console.log(JSON.stringify(net));
if(args[0]==='create') {
 const name=args[args.indexOf('--name')+1];
 const runtime=args.find(a=>a.startsWith('type=bind')&&a.includes('dst=/runtime')).split(',')[1].slice(4);
 writeFileSync(join(root,name+'.json'),JSON.stringify({runtime,args}));
}
if(args[0]==='inspect') {
 if(args.includes('--format')) console.log(args.includes('{{.State.Running}} {{.State.Pid}} {{.State.ExitCode}}')?'false 0 0':'172.28.0.2');
 else {
  const saved=JSON.parse(readFileSync(join(root,args.at(-1)+'.json'))), a=saved.args;
  const network=a[a.indexOf('--network')+1];
  const Mounts=a.filter(x=>x.startsWith('type=bind')).map(x=>({Type:'bind',RW:false,Source:x.split(',')[1].slice(4),Destination:x.split(',')[2].slice(4)}));
  console.log(JSON.stringify([{Config:{User:'1000:1000'},HostConfig:{ReadonlyRootfs:true,Privileged:false,NetworkMode:network,PidMode:'',CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges']},Mounts,NetworkSettings:{Networks:{[network]:{}}}}]));
 }
}
if(args[0]==='start'&&args.at(-1).endsWith('-probe')) console.log(JSON.stringify({cli:'codex-cli 0.156.1',bun:'1.4.2',git:'git version 2.50.1',safety:'probe-passed'}));
if(args[0]==='start'&&args.at(-1).endsWith('-actor')) {
 const saved=JSON.parse(readFileSync(join(root,args.at(-1)+'.json')));
 const settings=JSON.parse(readFileSync(join(saved.runtime,'settings.json')));
 const input=saved.args.find(a=>a.startsWith('type=bind')&&a.includes('dst=/input')).split(',')[1].slice(4);
 appendFileSync(join(root,'actor-input.jsonl'),JSON.stringify({settings,readme:readFileSync(join(input,'README.md'),'utf8'),issue:readFileSync(join(input,'evaluation-issue.json'),'utf8')})+'\\n');
 if(process.env.EVAL_TEST_FAILURE==='timeout') process.exit(124);
 if(process.env.EVAL_TEST_FAILURE==='interrupt') {writeFileSync(join(root,'interrupt-ready'),'ready');await Bun.sleep(5000);}
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:5,output_tokens:3}}));
}
if(args[0]==='exec') console.log(JSON.stringify({requests:1,rejected:1,failed:false}));
if(args[0]==='rm'&&process.env.EVAL_TEST_FAILURE==='cleanup') process.exit(1);
`;

// These tests own process.env and the process-wide interrupt scope; keep them serial.
async function withEvaluationFixture(
  action: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'skill-eval-test-'));
  const original = {
    PATH: process.env.PATH,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    EVAL_TEST_ROOT: process.env.EVAL_TEST_ROOT,
    EVAL_TEST_FAILURE: process.env.EVAL_TEST_FAILURE,
  };
  try {
    const context = await fixture(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), fakeDocker, { mode: 0o755 });
    process.env.PATH = `${bin}:${original.PATH}`;
    process.env.OPENAI_API_KEY = 'SIMULATED_PROVIDER_AUTH';
    process.env.EVAL_TEST_ROOT = root;
    delete process.env.EVAL_TEST_FAILURE;
    await action(context);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      await withInterrupts(async () => {});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function assessment(rawEvaluation: string, trace: string) {
  const reference = {
    file: 'actor.stdout',
    sha256: createHash('sha256').update(trace).digest('hex'),
    lines: [1, 1],
  };
  return {
    evaluationSha256: createHash('sha256').update(rawEvaluation).digest('hex'),
    conclusion: 'indeterminate',
    reason: 'Simulated trace only',
    nextDecision: 'Review actual behavior',
    conditionDifferences: [],
    trials: [
      {
        trial: 'before-positive',
        selection: 'none',
        bodyReads: [],
        applications: [],
        completeTrace: [reference],
        outcome: 'indeterminate',
        evidence: [reference],
        reason: 'No skill action in this simulated trace; outcome not adjudicated',
      },
    ],
  };
}

async function actorStarts(root: string) {
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
  return calls.filter(
    (call) => Array.isArray(call) && call[0] === 'start' && String(call.at(-1)).endsWith('-actor'),
  );
}

async function savedExecutions(directory: string) {
  const saved: unknown = JSON.parse(await readFile(join(directory, 'evaluation.json'), 'utf8'));
  assert(isRecord(saved) && Array.isArray(saved.records));
  return saved.records.map((record) => (isRecord(record) ? record.execution : 'invalid'));
}

test.serial(
  'committed paired inputs conceal labels, local changes and credentials and feed reports',
  async () => {
    await withEvaluationFixture(async ({ root, repo, plan }) => {
      const prepared = await preparePlan(repo, plan);
      expect(prepared.changedInstructions).toEqual(['AGENTS.md']);
      expect(prepared.variants[0]?.files['README.md']).toBe('Public task context');
      const result = await runEvaluation(repo, plan);
      expect(
        result.records.map((record) => (isRecord(record) ? record.execution : 'invalid')),
      ).toEqual(['completed', 'completed']);
      expect(await savedExecutions(plan.outputDirectory)).toEqual(['completed', 'completed']);
      const input = await readFile(join(root, 'actor-input.jsonl'), 'utf8');
      expect(input).toContain('PUBLIC_ISSUE_BODY_CANARY');
      expect(input).not.toContain('HOST_ONLY_EXPECTED_CANARY');
      expect(
        JSON.parse(
          await readFile(
            join(plan.outputDirectory, 'before-positive', 'input', 'evaluation-issue.json'),
            'utf8',
          ),
        ),
      ).toEqual(caseContext);
      expect(input).not.toContain('PRIVATE_UNCOMMITTED_CANARY');
      expect(input).not.toContain('SIMULATED_PROVIDER_AUTH');
      await writeComparison(plan.outputDirectory);
      const report = await readFile(join(plan.outputDirectory, 'comparison.md'), 'utf8');
      expect(report).toContain('要求充足0/1');
      expect(report).toContain('indeterminate');
      const rawEvaluation = await readFile(join(plan.outputDirectory, 'evaluation.json'), 'utf8');
      const trace = await readFile(
        join(plan.outputDirectory, 'before-positive', 'actor.stdout'),
        'utf8',
      );
      const adjudication = join(root, 'judgment.json');
      await writeFile(adjudication, JSON.stringify(assessment(rawEvaluation, trace)));
      await writeComparison(plan.outputDirectory, adjudication);
      await assert.rejects(() => writeComparison(plan.outputDirectory), /EEXIST/);
      await assert.rejects(() => runEvaluation(repo, plan), /EEXIST/);
      expect(await readFile(join(plan.outputDirectory, 'comparison.md'), 'utf8')).toBe(report);
      expect(await readFile(join(plan.outputDirectory, 'evaluation.json'), 'utf8')).toBe(
        rawEvaluation,
      );
      expect(await actorStarts(root)).toHaveLength(2);
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('PRIVATE_UNCOMMITTED_CANARY');
    });
  },
  10000,
);

for (const [failure, expectedStarts, executions, counts] of [
  [
    'network',
    0,
    ['unevaluated', 'unevaluated'],
    [
      [0, 0, 1],
      [0, 0, 1],
    ],
  ],
  [
    'cleanup',
    1,
    ['completed', 'unevaluated'],
    [
      [1, 0, 0],
      [0, 0, 1],
    ],
  ],
  [
    'timeout',
    2,
    ['timeout', 'timeout'],
    [
      [1, 1, 0],
      [1, 1, 0],
    ],
  ],
] as const) {
  test.serial(
    `${failure} preserves stop records, actor start limits and the planned denominator`,
    async () => {
      await withEvaluationFixture(async ({ root, repo, plan }) => {
        process.env.EVAL_TEST_FAILURE = failure;
        const result = await runEvaluation(repo, plan);
        if (failure === 'cleanup') {
          expect(result.error).toContain('Isolation cleanup unconfirmed');
        } else {
          expect(result.records[0]).toMatchObject({
            reason:
              failure === 'network'
                ? 'Network is not isolated'
                : 'Wall time exhausted; container terminated',
          });
        }
        expect(await actorStarts(root)).toHaveLength(expectedStarts);
        expect(await savedExecutions(plan.outputDirectory)).toEqual([...executions]);
        await writeComparison(plan.outputDirectory);
        const report = await readFile(join(plan.outputDirectory, 'comparison.md'), 'utf8');
        for (const [index, [launched, failed, unevaluated]] of counts.entries()) {
          const side = index === 0 ? 'before' : 'after';
          expect(report).toContain(
            `| [positive](${side}-positive/actor.stdout) | ${side} | unknown (採点外・不明) | indeterminate | ${executions[index]};`,
          );
          const summary = report.split('\n').find((line) => line.startsWith(`${side}:`));
          expect(summary).toContain(
            `予定1試行、記録1、起動${launched}、実行失敗・時間切れ${failed}、未評価${unevaluated}。`,
          );
          expect(summary).toContain('要求充足0/1、未充足0、判定不能1');
        }
        expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('PRIVATE_UNCOMMITTED_CANARY');
      });
    },
    10000,
  );
}

test.serial(
  'interrupt stops later actors and saves cleanup while preserving local work',
  async () => {
    await withEvaluationFixture(async ({ root, repo, plan }) => {
      process.env.EVAL_TEST_FAILURE = 'interrupt';
      const watcher = setInterval(() => {
        if (existsSync(join(root, 'interrupt-ready'))) {
          clearInterval(watcher);
          process.emit('SIGINT');
        }
      }, 10);
      try {
        await assert.rejects(
          () => withInterrupts(() => runEvaluation(repo, plan)),
          /Interrupted execution/,
        );
      } finally {
        clearInterval(watcher);
      }
      expect(await savedExecutions(plan.outputDirectory)).toEqual(['failed', 'unevaluated']);
      expect(await actorStarts(root)).toHaveLength(1);
      const safety: unknown = JSON.parse(
        await readFile(join(plan.outputDirectory, 'before-positive', 'safety.json'), 'utf8'),
      );
      expect(safety).toEqual({ containersRemoved: true, networkRemoved: true });
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('PRIVATE_UNCOMMITTED_CANARY');
    });
  },
  10000,
);

// Report validation needs saved records and trace bytes, not Git or Docker execution.
async function withReportFixture(
  action: (context: {
    root: string;
    evaluation: ReturnType<typeof savedEvaluation>;
    judgment: ReturnType<typeof assessment>;
    adjudication: string;
    logPath: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'skill-eval-report-test-'));
  try {
    const evaluation = savedEvaluation(root);
    const raw = JSON.stringify(evaluation);
    const trace =
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":5,"output_tokens":3}}\n';
    const logPath = join(root, 'before-positive', 'actor.stdout');
    await mkdir(join(root, 'before-positive'));
    await writeFile(logPath, trace);
    await writeFile(join(root, 'evaluation.json'), raw);
    const judgment = assessment(raw, trace);
    const adjudication = join(root, 'judgment.json');
    await writeFile(adjudication, JSON.stringify(judgment));
    await action({ root, evaluation, judgment, adjudication, logPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function savedEvaluation(root: string) {
  return {
    config: { ...config, outputDirectory: root },
    records: ['before', 'after'].map((side) => ({
      trial: `${side}-positive`,
      side,
      case: 'positive',
      expected: 'scoping',
      execution: 'completed',
      launched: true,
      elapsedMs: 12,
      safety: { containersRemoved: true, networkRemoved: true },
    })),
    retries: 0,
    elapsedMs: 24,
    error: null,
  };
}

for (const [invalid, reason] of [
  [{ sha256: '0'.repeat(64) }, /Evidence changed/],
  [{ lines: [1, 999] }, /Evidence lines missing/],
] as const) {
  test(`report rejects ${reason.source} independently of evaluation execution`, async () => {
    await withReportFixture(async ({ root, judgment, adjudication }) => {
      await writeFile(
        adjudication,
        JSON.stringify({
          ...judgment,
          trials: judgment.trials.map((trial) => ({
            ...trial,
            evidence: trial.evidence.map((ref) => ({ ...ref, ...invalid })),
          })),
        }),
      );
      await assert.rejects(() => writeComparison(root, adjudication), reason);
    });
  });
}

test('report rechecks evidence changed after a successful adjudication', async () => {
  await withReportFixture(async ({ root, adjudication, logPath }) => {
    await writeComparison(root, adjudication);
    const trace = await readFile(logPath, 'utf8');
    await writeFile(logPath, trace + 'changed after adjudication');
    await assert.rejects(() => writeComparison(root, adjudication), /Evidence changed/);
  });
});

test('report refuses an improvement conclusion with a missing planned pair', async () => {
  await withReportFixture(async ({ root, evaluation, judgment, adjudication }) => {
    const partial = JSON.stringify({ ...evaluation, records: evaluation.records.slice(0, 1) });
    await writeFile(join(root, 'evaluation.json'), partial);
    await writeFile(
      adjudication,
      JSON.stringify({
        ...judgment,
        evaluationSha256: createHash('sha256').update(partial).digest('hex'),
        conclusion: 'improved',
        reason: 'Unsupported partial comparison',
        nextDecision: 'Adopt',
        trials: judgment.trials.map((trial) => ({ ...trial, outcome: 'fulfilled' })),
      }),
    );
    await assert.rejects(() => writeComparison(root, adjudication), /Missing planned pairs/);
  });
});

test('provider stream failure or missing completion seals the gateway while a completed response allows the next turn', async () => {
  for (const mode of ['complete', 'truncated', 'broken']) {
    let calls = 0;
    const gateway = providerGateway(
      { ...limits, maxRequests: 3 },
      'private-provider-key',
      async () => {
        calls++;
        const stream =
          mode === 'broken'
            ? new ReadableStream({
                start(controller) {
                  controller.error(new Error('transport failed'));
                },
              })
            : `data: {"type":"${mode === 'complete' ? 'response.completed' : 'response.output_text.delta'}"}\n\n`;
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    );
    const first = await gateway.handle(request());
    if (mode === 'broken') {
      await assert.rejects(() => first.text(), /transport failed/);
    } else {
      await first.text();
    }
    expect((await gateway.handle(request({ ...body, input: 'next turn' }))).status).toBe(
      mode === 'complete' ? 200 : 403,
    );
    expect(calls).toBe(mode === 'complete' ? 2 : 1);
  }
});
