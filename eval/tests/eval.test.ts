import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { instructionFiles, installTrustedInputs } from './trusted-inputs.ts';
import { providerGateway, providerBody } from '../container.ts';
import { evalConfig, validatePlan } from '../data.ts';
import { preparePlan, runEvaluation } from '../eval.ts';
import { assessTrial, readUsage, writeComparison } from '../report.ts';
import { containerArgs, verifyImage, verifyNetwork } from '../sandbox.ts';
import { command, withInterrupts } from '../../scripts/shared/process.ts';
import { isRecord } from '../../scripts/shared/values.ts';
import { initializeTarget, git, targetConfig } from '../../scripts/tests/support/target.ts';

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
  body: 'PUBLIC_ISSUE_BODY_CANARY',
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
    validatePlan({ ...config, workspaceFiles: ['eval/corpus/cases.json'] }, cases),
  ).toThrow('host-only');
  expect(
    validatePlan(
      { ...config, workspaceFiles: ['docs/research/issue-comparison-evaluation.md'] },
      cases,
    ),
  ).toEqual(cases);
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

test('共通指示の許可は文書に限定し、課題・評価情報・秘密情報を混ぜない', () => {
  const instructions = (path: string) => ({
    ...config,
    workspaceFiles: ['result.txt'],
    instructionFiles: [...config.instructionFiles, path],
  });
  for (const path of [
    'skills/references/documents.md',
    'skills/references/natural-japanese.md',
    'docs/wiki/development-policy.md',
    'README.md',
    'scripts/README.md',
  ]) {
    expect(validatePlan(instructions(path), cases)).toEqual(cases);
  }
  for (const path of [
    'eval/eval.ts',
    'eval/corpus/cases.json',
    'scripts/eval/eval.ts',
    'scripts/eval/corpus/cases.json',
    'evals/answers.md',
    '.agents/AGENTS.md',
  ]) {
    expect(() => validatePlan(instructions(path), cases)).toThrow('host-only');
  }
  for (const path of [
    'skills/references/.env',
    'skills/references/auth.json',
    'skills/references/credentials/guide.md',
    'skills/references/config.toml',
  ]) {
    expect(() => validatePlan(instructions(path), cases)).toThrow('credentials');
  }
  for (const path of [
    'scripts/implement/review.ts',
    'scripts/tests/eval/eval.test.ts',
    'skills/references/helper.ts',
    'docs/research/expected.md',
    'docs/wiki/arbitrary.md',
  ]) {
    expect(() => validatePlan(instructions(path), cases)).toThrow('Unsupported instruction');
  }
  expect(() =>
    validatePlan({ ...instructions('README.md'), workspaceFiles: ['README.md'] }, cases),
  ).toThrow('overlap');
});

for (const path of [
  'scripts/implement/orchestrator.ts',
  'scripts/implement/repair.ts',
  'scripts/implement/codex-actor.ts',
]) {
  test(`初回担当の信頼版コード${path}を共通workspaceへ移して指示比較を迂回できない`, () => {
    // 課題側の通常コードは引き続き許可する。
    expect(validatePlan({ ...config, workspaceFiles: ['src/messages.ts'] }, cases)).toEqual(cases);
    expect(() => validatePlan({ ...config, workspaceFiles: [path] }, cases)).toThrow();
  });
}

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

test('8課題の追加集合を既存5課題と分離し、採点指示を通常依頼へ混ぜない', async () => {
  const corpus: unknown = JSON.parse(
    await readFile(resolve(import.meta.dir, '../corpus/cases.json'), 'utf8'),
  );
  assert(Array.isArray(corpus));
  const oldIds = ['requirements', 'implementation', 'question', 'review', 'ambiguous'];
  const added = corpus.filter(
    (item): item is Record<string, unknown> => isRecord(item) && !oldIds.includes(String(item.id)),
  );
  expect(added).toHaveLength(8);
  expect(new Set(added.map((item) => item.id)).size).toBe(8);
  expect(corpus.filter((item) => isRecord(item) && oldIds.includes(String(item.id)))).toHaveLength(
    5,
  );
  for (const item of added) {
    assert(isRecord(item) && typeof item.prompt === 'string');
    expect(item.prompt).not.toMatch(
      /前提を検証して|理由の確度を調べて|利用例から設計して|機械化・lint化を考えて/,
    );
    expect(String(item.id)).not.toMatch(
      /positive|negative|correct|incorrect|necessary|unnecessary/,
    );
    expect(Array.isArray(item.criteria) && item.criteria.length > 0).toBe(true);
  }
});

test('新配置でも課題の通常入力だけを許可し、ホスト用コード・採点情報を拒否する', () => {
  expect(
    validatePlan(
      { ...config, workspaceFiles: ['eval/fixtures/workspace/tests/work-areas.test.ts'] },
      cases,
    ),
  ).toEqual(cases);
  for (const path of [
    'eval/eval.ts',
    'eval/README.md',
    'eval/corpus/cases.json',
    'eval/tests/task-fixtures.test.ts',
    'eval/tests/fixtures/trusted-inputs.json',
    'scripts/tests/eval/task-fixtures.test.ts',
  ]) {
    expect(() => validatePlan({ ...config, workspaceFiles: [path] }, cases)).toThrow('host-only');
    expect(() =>
      validatePlan({ ...config, instructionFiles: [...config.instructionFiles, path] }, cases),
    ).toThrow('host-only');
  }
  // 課題用の通常資料でも指示側へ移してA/Bの差に混ぜない。
  expect(() =>
    validatePlan(
      {
        ...config,
        instructionFiles: [...config.instructionFiles, 'eval/fixtures/workspace/specs.md'],
      },
      cases,
    ),
  ).toThrow();
});

test('20要求を共通中継で数え、21番目を拒否し、要求ごとの出力上限を渡す', async () => {
  const sent: unknown[] = [];
  const gateway = providerGateway(
    { ...limits, maxRequests: 20, maxOutputTokens: 8000 },
    'TEST_AUTH',
    async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      assert(typeof init.body === 'string');
      sent.push(JSON.parse(init.body));
      return new Response('data: {"type":"response.completed"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  );
  try {
    for (let index = 0; index < 20; index++) {
      const response = await gateway.handle(request({ ...body, input: `通常入力${index}` }));
      expect(response.status).toBe(200);
      await response.text();
    }
    expect((await gateway.handle(request({ ...body, input: '21番目' }))).status).toBe(403);
    expect(sent).toHaveLength(20);
    for (const input of sent) {
      expect(input).toMatchObject({ max_output_tokens: 8000, model: limits.model });
    }
    expect(gateway.stats()).toEqual({ requests: 20, rejected: 1, failed: false });
  } finally {
    gateway.stop();
  }
});

test('canonical paths cannot smuggle answer files or collide with effective instructions', () => {
  for (const path of [
    './eval/corpus/cases.json',
    'docs/../eval/corpus/cases.json',
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

test('usage leaves fractional and overflowing token counts unaccounted', () => {
  const event = (input_tokens: number) =>
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens, cached_input_tokens: 0, output_tokens: 0 },
    });
  expect(readUsage([event(10), event(0.5), event(Number.MAX_SAFE_INTEGER)])).toMatchObject({
    totals: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0 },
    completedTurns: 1,
    incompleteLines: 2,
  });
});

async function fixture(
  root: string,
  instructionVersions: Record<string, [string | null, string]> = {
    'AGENTS.md': ['Before instructions', 'After instructions'],
  },
) {
  const repo = join(root, 'repo');
  await mkdir(repo);
  await initializeTarget(repo, { ...targetConfig, repository: 'thkt/dotagents', remote: 'origin' });
  for (const path of ['eval/corpus', 'skills/scoping', 'skills/implement']) {
    await mkdir(join(repo, path), { recursive: true });
  }
  await writeFile(join(repo, 'README.md'), 'Public task context');
  await writeFile(join(repo, 'AGENTS.md'), 'Before instructions');
  await writeFile(join(repo, 'skills/scoping/SKILL.md'), 'Public scoping body');
  await writeFile(join(repo, 'skills/implement/SKILL.md'), 'Public implement body');
  for (const [path, [before]] of Object.entries(instructionVersions)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    if (before !== null) {
      await writeFile(join(repo, path), before);
    }
  }
  await writeFile(
    join(repo, 'eval/corpus/cases.json'),
    JSON.stringify([
      { ...cases[0], criteria: ['HOST_ONLY_EXPECTED_CANARY'], context: caseContext },
    ]),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'public inputs');
  const before = git(repo, 'rev-parse', 'HEAD');
  for (const [path, [, after]] of Object.entries(instructionVersions)) {
    await writeFile(join(repo, path), after);
  }
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

test('共通参照だけの変更を両版の内容・hash・変更一覧へ反映し、課題と参照不足を区別する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-eval-plan-'));
  try {
    const common = 'skills/references/documents.md';
    const policy = 'docs/wiki/development-policy.md';
    const guide = '[文書](skills/references/documents.md) [方針](docs/wiki/development-policy.md)';
    const oldBody = '[課題](../../README.md) [旧参照](old.md#読む)';
    const newBody =
      '[課題](../../README.md) [新参照](new.md) [節](#読む) [外部](https://example.com)';
    const { repo, plan } = await fixture(root, {
      'AGENTS.md': [guide, guide],
      [common]: [oldBody, newBody],
      [policy]: ['変更前の方針', '変更後の方針'],
      'README.md': ['固定した課題', '比較へ混ぜない課題変更'],
    });
    const input = { ...plan, instructionFiles: [...plan.instructionFiles, common, policy] };
    const prepared = await preparePlan(repo, input);
    expect(prepared.changedInstructions).toEqual([common, policy]);
    for (const [index, body, missing] of [
      [0, oldBody, 'old.md'],
      [1, newBody, 'new.md'],
    ] as const) {
      const variant = prepared.variants[index];
      assert(variant);
      expect(variant.files[common]).toBe(body);
      expect(variant.versions[common]).toBe(createHash('sha256').update(body).digest('hex'));
      expect(variant.files[policy]).toBe(index === 0 ? '変更前の方針' : '変更後の方針');
      expect(variant.files['README.md']).toBe('固定した課題');
      expect(variant.versions['README.md']).toBe(
        createHash('sha256').update('固定した課題').digest('hex'),
      );
      expect(variant.missingReferences).toEqual([
        { source: common, target: `skills/references/${missing}` },
      ]);
      expect(Object.keys(variant.files).sort()).toEqual(
        [...input.workspaceFiles, ...input.instructionFiles].sort(),
      );
    }
    expect(prepared.variants[0]?.versions[policy]).not.toBe(prepared.variants[1]?.versions[policy]);
    await assert.rejects(() => preparePlan(repo, plan), /No relevant instruction changes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('共通参照も通常の追跡済みUTF-8 blobだけを使い、作業差分・symlink・未追跡入力を読まない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-eval-plan-'));
  try {
    const path = 'skills/references/documents.md';
    const link = 'skills/references/link.md';
    const { repo, plan } = await fixture(root, {
      [path]: ['変更前', '変更後'],
      [link]: ['通常の参照文書', '通常の参照文書'],
    });
    await writeFile(join(repo, path), 'PRIVATE_LOCAL_CANARY');
    // 比較先にも同じパスを残し、欠落による拒否でsymlink検査の回帰を隠さない。
    await rm(join(repo, link));
    await symlink('documents.md', join(repo, link));
    await writeFile(join(repo, 'skills/references/binary.md'), Buffer.from([0, 255]));
    git(repo, 'add', 'skills/references/link.md', 'skills/references/binary.md');
    git(repo, 'commit', '-qm', 'invalid input fixtures');
    const after = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'skills/references/untracked.md'), 'PRIVATE_UNTRACKED_CANARY');
    const input = { ...plan, after, instructionFiles: [...plan.instructionFiles, path] };
    const prepared = await preparePlan(repo, input);
    expect(prepared.variants.map((variant) => variant.files[path])).toEqual(['変更前', '変更後']);
    for (const [name, reason] of [
      ['link.md', /Expected regular committed file/],
      ['untracked.md', /Expected regular committed file/],
      ['binary.md', /Evaluation input must be UTF-8 text/],
    ] as const) {
      await assert.rejects(
        () =>
          preparePlan(repo, {
            ...input,
            before: after,
            after: plan.before,
            instructionFiles: [...input.instructionFiles, `skills/references/${name}`],
          }),
        reason,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('新設3資料はAの不存在とBの通常blobを保持し、空補完やBからのコピーをしない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'instruction-presence-'));
  try {
    const paths = [
      'skills/references/premise-validation.md',
      'skills/references/caller-first-design.md',
      'skills/references/mechanization.md',
    ];
    const versions: Record<string, [string | null, string]> = {
      'AGENTS.md': ['既存の指示を維持する', '既存の指示を維持する'],
    };
    for (const path of paths) {
      versions[path] = [null, `新設した公開資料: ${path}`];
    }
    const { repo, plan } = await fixture(root, versions);
    const input = { ...plan, instructionFiles: [...plan.instructionFiles, ...paths] };
    const prepared = await preparePlan(repo, input);
    expect(prepared.changedInstructions).toEqual(paths);
    const [before, after] = prepared.variants;
    assert(before && after);
    expect(before.commit).toBe(plan.before);
    expect(after.commit).toBe(plan.after);
    expect(before.files['AGENTS.md']).toBe('既存の指示を維持する');
    expect(before.files['README.md']).toBe(after.files['README.md']);
    for (const path of paths) {
      expect(Object.hasOwn(before.files, path)).toBe(false);
      expect(Object.hasOwn(before.versions, path)).toBe(false);
      expect(after.files[path]).toBe(`新設した公開資料: ${path}`);
      expect(after.versions[path]).toBe(
        createHash('sha256').update(`新設した公開資料: ${path}`).digest('hex'),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('新設扱いは必須資料の欠落・B側の不存在・取得不能・symlinkを許可しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'instruction-presence-'));
  try {
    const path = 'skills/references/mechanization.md';
    const { repo, plan } = await fixture(root, { [path]: [null, '公開資料'] });
    const input = { ...plan, instructionFiles: [...plan.instructionFiles, path] };
    // 先にBの正常blobへ到達できる対照を確認する。Aの欠落は今回の新設資料だけ。
    expect(git(repo, 'show', `${plan.after}:${path}`)).toBe('公開資料');
    for (const absent of ['AGENTS.md', path]) {
      // 各反例のindexも正常なBへ戻す。作業ファイルだけの復元では欠落が混在する。
      git(repo, 'checkout', plan.after, '--', 'AGENTS.md', path);
      await rm(join(repo, absent));
      git(repo, 'add', absent);
      git(repo, 'commit', '-qm', 'missing required input');
      const after = git(repo, 'rev-parse', 'HEAD');
      const retained = absent === path ? 'AGENTS.md' : path;
      expect(git(repo, 'ls-tree', after, '--', absent)).toBe('');
      expect(git(repo, 'ls-tree', after, '--', retained)).toMatch(/^100644 blob /);
      await assert.rejects(
        () => preparePlan(repo, { ...input, before: plan.after, after }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`Expected regular committed file: ${absent}`),
      );
    }
    git(repo, 'checkout', plan.after, '--', 'AGENTS.md', path);
    await assert.rejects(() => preparePlan(repo, { ...input, after: '0'.repeat(40) }));
    await writeFile(join(repo, 'AGENTS.md'), '既存指示');
    await rm(join(repo, path));
    await symlink('../../../README.md', join(repo, path));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'symlink is not an absent document');
    await assert.rejects(
      () =>
        preparePlan(repo, { ...input, before: plan.after, after: git(repo, 'rev-parse', 'HEAD') }),
      /Expected regular committed file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fakeDocker = `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,posix} from 'node:path';
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
if(args[0]==='start'&&args.at(-1).endsWith('-probe')) console.log(JSON.stringify({cli:'codex-cli 0.156.1',bun:process.env.EVAL_TEST_BUN||'1.4.2',git:'git version 2.50.1',safety:'probe-passed'}));
if(args[0]==='start'&&args.at(-1).endsWith('-actor')) {
 const saved=JSON.parse(readFileSync(join(root,args.at(-1)+'.json')));
 const settings=JSON.parse(readFileSync(join(saved.runtime,'settings.json')));
 const input=saved.args.find(a=>a.startsWith('type=bind')&&a.includes('dst=/input')).split(',')[1].slice(4);
 const issue=join(input,'evaluation-issue.json');
 // 実際のpromptが指す記録を、actorに見えるread-only mountから読む。
 // ホスト上に生成済みでもmountへ転送されていなければbodyはnullになる。
 const recordPath=settings.prompt.match(/独立テストの記録: ([^\\s。]+\\.json)/)?.[1];
 // /work/repoは既存containerのprepareが/inputをコピーする配置。
 const mount=recordPath&&['/input','/runtime','/work/repo'].find(path=>recordPath.startsWith(path+'/')&&posix.normalize(recordPath)===recordPath);
 const recordFile=mount?join(mount==='/runtime'?saved.runtime:input,recordPath.slice(mount.length+1)):null;
 const testRecord={path:recordPath??null,body:recordFile&&existsSync(recordFile)?readFileSync(recordFile,'utf8'):null};
 appendFileSync(join(root,'actor-input.jsonl'),JSON.stringify({settings,testRecord,readme:readFileSync(join(input,'README.md'),'utf8'),issue:existsSync(issue)?readFileSync(issue,'utf8'):null})+'\\n');
 if(process.env.EVAL_TEST_FAILURE==='provider') process.exit(1);
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
    EVAL_TEST_BUN: process.env.EVAL_TEST_BUN,
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
    delete process.env.EVAL_TEST_BUN;
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

async function orderedFixture(context: Awaited<ReturnType<typeof fixture>>) {
  const ids = Array.from({ length: 8 }, (_, index) => `sample-${index + 1}`);
  const trialOrder = ids.flatMap((id, index) =>
    (index % 2 === 0 ? ['before', 'after'] : ['after', 'before']).map((side) => `${side}-${id}`),
  );
  await writeFile(
    join(context.repo, 'eval/corpus/cases.json'),
    JSON.stringify(ids.map((id) => ({ ...cases[0], id, context: caseContext }))),
  );
  git(context.repo, 'add', 'eval/corpus/cases.json');
  git(context.repo, 'commit', '-qm', 'eight public control inputs');
  const input = {
    ...context.plan,
    corpusCommit: git(context.repo, 'rev-parse', 'HEAD'),
    cases: ids,
    trialOrder,
    maxTrials: 16,
    caseTimeMs: 600000,
    totalTimeMs: 9600000,
    maxModelRequestsPerCase: 20,
    maxOutputTokens: 8000,
  };
  return { input, trialOrder };
}

test.serial(
  '固定公開A/Bの実SHA・本文hash・新設資料の不存在を照合し、既存入口へ接続する',
  async () => {
    await withEvaluationFixture(async (context) => {
      const versions = await installTrustedInputs(context.repo);
      const prepared = await preparePlan(context.repo, {
        ...context.plan,
        ...versions,
        workspaceFiles: ['result.txt'],
      });
      expect(prepared.variants.map((variant) => variant.commit)).toEqual([
        versions.before,
        versions.after,
      ]);
      expect(prepared.selected).toHaveLength(1);
      expect(prepared.changedInstructions).toContain('skills/implement/SKILL.md');
    });
  },
);

async function initialActorFixture(context: Awaited<ReturnType<typeof fixture>>) {
  const source = resolve(import.meta.dir, '../..');
  const corpus: unknown = JSON.parse(
    await readFile(join(source, 'eval/corpus/cases.json'), 'utf8'),
  );
  assert(Array.isArray(corpus));
  const oldIds = new Set(['requirements', 'implementation', 'question', 'review', 'ambiguous']);
  const behaviorCases = corpus.filter(
    (item): item is Record<string, unknown> => isRecord(item) && !oldIds.has(String(item.id)),
  );
  expect(behaviorCases).toHaveLength(8);
  const selected = behaviorCases.filter((item) => item.expected === 'implement');
  // 固定Issueの初回担当4課題をそのまま使う。actor指定・入力契約を手書きで代用しない。
  expect(selected).toHaveLength(4);
  // A/Bは公開固定版。runnerとcorpus/workspaceは同じ共有commitへ固定する。
  const { before, after } = await installTrustedInputs(context.repo);
  for (const path of ['scripts', 'eval', 'package.json', 'bun.lock']) {
    await cp(join(source, path), join(context.repo, path), { recursive: true });
  }
  await writeFile(
    join(context.repo, 'eval/corpus/cases.json'),
    JSON.stringify(
      corpus.map((item) => {
        assert(isRecord(item));
        return { ...item, criteria: ['HOST_ONLY_EXPECTED_CANARY'] };
      }),
    ),
  );
  git(context.repo, 'add', '.');
  git(context.repo, 'commit', '-qm', 'shared runner corpus and workspace');
  const common = git(context.repo, 'rev-parse', 'HEAD');
  // 実行コードは共有commitの実体から起動する。依存リンクは公開入力へ含めない。
  await writeFile(join(context.repo, '.git/info/exclude'), 'node_modules\n');
  await symlink(join(source, 'node_modules'), join(context.repo, 'node_modules'), 'dir');
  const workspaceFiles = (
    await readdir(join(source, 'eval/fixtures/workspace'), { recursive: true })
  )
    .filter((path) => /\.(?:ts|js|json|md)$/.test(path))
    .map((path) => `eval/fixtures/workspace/${path}`);
  process.env.EVAL_TEST_BUN = '1.4.3';
  // Issueの8課題を旧5課題と分離して選び、A→BとB→Aを4組ずつ固定する。
  // 初回担当4課題だけへの切出しでは、比較計画の正常な対照にならない。
  const trialOrder = behaviorCases.flatMap((item, index) =>
    (index % 2 === 0 ? ['before', 'after'] : ['after', 'before']).map(
      (side) => `${side}-${String(item.id)}`,
    ),
  );
  return {
    selected,
    trialOrder,
    plan: evalConfig.parse({
      ...context.plan,
      before,
      after,
      corpusCommit: common,
      workspaceCommit: common,
      workspaceFiles,
      cases: behaviorCases.map((item) => item.id),
      trialOrder,
      maxTrials: 16,
      caseTimeMs: 600000,
      totalTimeMs: 9600000,
      maxModelRequestsPerCase: 20,
      maxOutputTokens: 8000,
      bunVersion: '1.4.3',
      instructionFiles,
    }),
  };
}

// 公開契約は同じIssue本文を渡すこと。旧contextファイルと担当入力内の本文を区別する。
function assertIssueInput(prompt: string, issue: unknown, context: unknown) {
  assert(isRecord(context) && typeof context.body === 'string');
  if (typeof issue === 'string') {
    expect(JSON.parse(issue)).toEqual(context);
  } else {
    const body = context.body;
    expect(prompt.includes(body) || prompt.includes(JSON.stringify(body).slice(1, -1))).toBe(true);
  }
}

// 通常の独立テスト記録の契約を確認する。案内文やファイル名だけを成功にしない。
function assertTransferredTestRecord(prompt: string, value: unknown) {
  assert(isRecord(value), '独立テスト記録の観測がない');
  assert(typeof value.path === 'string' && prompt.includes(value.path));
  assert(typeof value.body === 'string', '独立テスト記録がactorのmountにない');
  const record: unknown = JSON.parse(value.body);
  assert(isRecord(record) && isRecord(record.files), '独立テスト記録の成果物対応がない');
  assert(typeof record.findings === 'string' && record.findings.trim().length > 0);
  assert(typeof record.status === 'string');
  expect(['prepared', 'unnecessary']).toContain(record.status);
  return record;
}

// Issueの入力充足条件: 転送できただけでは足りず、当該checkと固定workspaceへ対応する。
// filesは通常の独立テスト記録のmode込みhashと、公開blobの内容hashを扱う。
function assertTaskTestRecord(
  prompt: string,
  value: unknown,
  check: unknown,
  workspace: Record<string, unknown>,
) {
  const record = assertTransferredTestRecord(prompt, value);
  assert(Array.isArray(check) && check.length > 0, '課題のcheckがない');
  expect(record.check, '独立テスト記録が当該課題のcheckと一致しない').toEqual(check);
  assert(isRecord(record.files) && Object.keys(record.files).length > 0, '検証資産の版対応がない');
  for (const [path, digest] of Object.entries(record.files)) {
    assert(typeof digest === 'string', `記録の資産hashが不正: ${path}`);
    const body = workspace[path];
    assert(typeof body === 'string', `記録の資産が固定workspaceにない: ${path}`);
    const hashes = [body, `33188:${body}`, `33261:${body}`].map((text) =>
      createHash('sha256').update(text).digest('hex'),
    );
    expect(hashes, `記録の資産が固定workspaceの版と一致しない: ${path}`).toContain(digest);
  }
  return record;
}

test('独立テスト記録を同じ計画内の別課題・別版と取り違えない', () => {
  const path = '/runtime/test-1.json';
  const prompt = `独立テストの記録: ${path}。`;
  const guide = 'eval/fixtures/workspace/tests/guide.test.ts';
  const messages = 'eval/fixtures/workspace/tests/messages.test.ts';
  const workspace = { [guide]: '現在のリンクを検証', [messages]: '完了メッセージを検証' };
  const check = ['bun', 'test', guide];
  const files = { [guide]: createHash('sha256').update(workspace[guide]).digest('hex') };
  const record = { status: 'prepared', findings: '固定仕様に対応する検証', check, files };
  const transfer = (record: unknown) => ({ path, body: JSON.stringify(record) });
  expect(assertTaskTestRecord(prompt, transfer(record), check, workspace)).toEqual(record);
  // 形も版も正常で同じ計画に存在する他課題の記録。check対応だけが違う。
  const other = {
    ...record,
    check: ['bun', 'test', messages],
    files: { [messages]: createHash('sha256').update(workspace[messages]).digest('hex') },
  };
  expect(() => assertTaskTestRecord(prompt, transfer(other), check, workspace)).toThrow(
    '当該課題のcheck',
  );
  // checkは同じまま、資産の旧版だけを渡す。
  const stale = {
    ...record,
    files: { [guide]: createHash('sha256').update('旧版').digest('hex') },
  };
  expect(() => assertTaskTestRecord(prompt, transfer(stale), check, workspace)).toThrow(
    '固定workspaceの版',
  );
});

test('独立テスト記録は本文の転送を必要とし、案内だけ・別のJSONを受け入れない', () => {
  const path = '/runtime/test-1.json';
  const prompt = `独立テストの記録: ${path}。findingsと成果物を読んでください。`;
  const record = { status: 'prepared', findings: '合意済み仕様に対応する検証を準備', files: {} };
  expect(assertTransferredTestRecord(prompt, { path, body: JSON.stringify(record) })).toEqual(
    record,
  );
  expect(() => assertTransferredTestRecord(prompt, { path, body: null })).toThrow(
    '独立テスト記録がactorのmountにない',
  );
  expect(() => assertTransferredTestRecord(prompt, { path, body: '{}' })).toThrow(
    '独立テスト記録の成果物対応がない',
  );
});

test.serial('模擬起動は同じ案内でも記録ファイルの転送あり・なしを区別する', async () => {
  await withEvaluationFixture(async (context) => {
    const runtime = join(context.root, 'record-runtime');
    await mkdir(runtime);
    const path = '/runtime/test-1.json';
    const prompt = `独立テストの記録: ${path}。findingsと成果物を読んでください。`;
    const record = { status: 'unnecessary', findings: '既存検証で十分な対照入力', files: {} };
    await writeFile(join(runtime, 'settings.json'), JSON.stringify({ prompt }));
    await writeFile(join(runtime, 'test-1.json'), JSON.stringify(record));
    const name = 'record-transfer-actor';
    await writeFile(
      join(context.root, `${name}.json`),
      JSON.stringify({ runtime, args: [`type=bind,src=${context.repo},dst=/input,readonly`] }),
    );
    for (const present of [true, false]) {
      if (!present) {
        await rm(join(runtime, 'test-1.json'));
      }
      const execution = await command(
        [join(context.root, 'bin/docker'), 'start', name],
        context.repo,
        '',
        10000,
      );
      expect(execution.code, execution.stdout + execution.stderr).toBe(0);
      const lines = (await readFile(join(context.root, 'actor-input.jsonl'), 'utf8'))
        .trim()
        .split('\n');
      const launch: unknown = JSON.parse(lines.at(-1) ?? 'null');
      assert(isRecord(launch));
      if (present) {
        expect(assertTransferredTestRecord(prompt, launch.testRecord)).toEqual(record);
      } else {
        expect(() => assertTransferredTestRecord(prompt, launch.testRecord)).toThrow(
          '独立テスト記録がactorのmountにない',
        );
      }
    }
  });
});

// repoと隔離環境で同じ相対配置を使い、両条件へ共通blobの本文とhashを渡す。
async function assertCommonWorkspace(repo: string, paths: string[], variants: unknown[]) {
  for (const path of paths) {
    const expected = await readFile(join(repo, path), 'utf8');
    const expectedSha256 = createHash('sha256').update(expected).digest('hex');
    for (const variant of variants) {
      assert(isRecord(variant) && isRecord(variant.files) && isRecord(variant.versions));
      const content = variant.files[path];
      expect(content, `共通workspaceの入力が異なる: ${path}`).toBe(expected);
      expect(variant.versions[path]).toBe(expectedSha256);
    }
  }
}

test.serial(
  '初回4課題の信頼版担当入力と応答契約をplanから実行設定へ転送する',
  async () => {
    await withEvaluationFixture(async (context) => {
      const { plan, selected, trialOrder } = await initialActorFixture(context);
      const configPath = join(context.root, 'initial-eval-config.json');
      await writeFile(configPath, JSON.stringify(plan));
      const execution = await command(
        [process.execPath, 'eval/eval.ts', 'run', configPath],
        context.repo,
        '',
        25000,
      );
      expect(execution.code, execution.stdout + execution.stderr).toBe(0);
      expect(execution.timedOut).toBe(false);
      const result: unknown = JSON.parse(
        await readFile(join(plan.outputDirectory, 'evaluation.json'), 'utf8'),
      );
      assert(isRecord(result) && Array.isArray(result.records));
      expect(result.error).toBeNull();
      expect(
        result.records.map((record) => (isRecord(record) ? record.execution : 'invalid')),
      ).toEqual(Array(16).fill('completed'));
      expect(result.records.map((record) => (isRecord(record) ? record.trial : null))).toEqual(
        trialOrder,
      );
      const launches = (await readFile(join(context.root, 'actor-input.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
      expect(launches).toHaveLength(16);
      const savedPlan = await readFile(join(plan.outputDirectory, 'plan.json'), 'utf8');
      const parsedPlan: unknown = JSON.parse(savedPlan);
      assert(isRecord(parsedPlan) && Array.isArray(parsedPlan.variants));
      const variants: unknown[] = parsedPlan.variants;
      await assertCommonWorkspace(context.repo, plan.workspaceFiles, variants);
      const compactPlan = JSON.stringify(parsedPlan);
      let initialLaunches = 0;
      for (const [index, launch] of launches.entries()) {
        assert(isRecord(launch) && isRecord(launch.settings));
        const settings = launch.settings;
        const trial = trialOrder[index];
        assert(trial);
        expect(JSON.stringify(launch)).not.toMatch(
          /PRIVATE_ACTOR_CANARY|HOST_ONLY_EXPECTED_CANARY/,
        );
        const item = selected.find(
          (item) => trial === `before-${String(item.id)}` || trial === `after-${String(item.id)}`,
        );
        if (!item) {
          expect(settings.responseSchema).toBeUndefined();
          continue;
        }
        initialLaunches++;
        expect(settings.responseSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
          required: ['status', 'findings'],
          properties: {
            status: { type: 'string', enum: ['repaired', 'needs_host', 'needs_human'] },
            findings: { type: 'string' },
          },
        });
        assert(typeof settings.prompt === 'string');
        expect(savedPlan).toContain(JSON.stringify(settings.prompt));
        expect(settings.prompt).not.toContain(context.root);
        // #385〜#388でBに加わった実指示。配置だけの差やcanaryを正解にしない。
        for (const instruction of [
          '信頼するハーネスの機械化の共通手順:',
          '信頼するハーネスの利用例から設計する手順:',
          '信頼するハーネスの設計理由の手順:',
          '信頼するハーネスの前提検証手順:',
        ]) {
          expect(settings.prompt.includes(instruction)).toBe(trial.startsWith('after-'));
        }
        expect(settings.prompt).toContain('合意済みIssue全体を実装してください');
        expect(settings.prompt).toContain('独立テストの記録:');
        const variant = variants.find(
          (value) =>
            isRecord(value) && value.side === (trial.startsWith('before-') ? 'before' : 'after'),
        );
        assert(isRecord(variant) && isRecord(variant.files));
        const testRecord = assertTaskTestRecord(
          settings.prompt,
          launch.testRecord,
          item.check,
          variant.files,
        );
        // 本文の計画への固定も維持する。課題・資産版の対応は上の検査で別に照合する。
        expect(
          compactPlan.includes(JSON.stringify(testRecord)) ||
            (isRecord(launch.testRecord) &&
              compactPlan.includes(JSON.stringify(launch.testRecord.body))),
        ).toBe(true);
        expect(settings.prompt).toContain('対象のsetup/check/capture契約');
        expect(settings.prompt).toContain('commit・push・公開をしないでください');
        assertIssueInput(settings.prompt, launch.issue, item.context);
      }
      expect(initialLaunches).toBe(8);
    });
  },
  30000,
);

test.serial(
  '明示した16試行は4組ずつの順序と有限上限をplan・実行へ渡す',
  async () => {
    await withEvaluationFixture(async (context) => {
      const { input, trialOrder } = await orderedFixture(context);
      const plan = evalConfig.parse(input);
      const prepared = await preparePlan(context.repo, plan);
      expect(prepared.config).toMatchObject({ trialOrder });
      const result = await runEvaluation(context.repo, plan);
      expect(result.error).toBeNull();
      expect(result.retries).toBe(0);
      expect(result.records.map((record) => (isRecord(record) ? record.trial : null))).toEqual(
        trialOrder,
      );
      expect(await savedExecutions(plan.outputDirectory)).toEqual(Array(16).fill('completed'));
      expect(await actorStarts(context.root)).toHaveLength(16);
      const launches = (await readFile(join(context.root, 'actor-input.jsonl'), 'utf8'))
        .trim()
        .split('\n');
      for (const line of launches) {
        const value: unknown = JSON.parse(line);
        expect(value).toMatchObject({ settings: { maxRequests: 20, maxOutputTokens: 8000 } });
      }
      for (const order of [
        trialOrder.slice(1),
        [...trialOrder.slice(1), trialOrder[1]],
        [...trialOrder.slice(0, -1), 'after-unknown'],
      ]) {
        expect(() =>
          validatePlan(evalConfig.parse({ ...input, trialOrder: order }), prepared.selected),
        ).toThrow();
      }
    });
  },
  30000,
);

for (const failure of ['provider', 'timeout', 'cleanup']) {
  test.serial(
    `明示した16試行は${failure}を成功に変換せず、終了不明で後続を止め原記録を保つ`,
    async () => {
      await withEvaluationFixture(async (context) => {
        const { input, trialOrder } = await orderedFixture(context);
        const plan = evalConfig.parse(input);
        process.env.EVAL_TEST_FAILURE = failure;
        const result = await runEvaluation(context.repo, plan);
        const starts = await actorStarts(context.root);
        expect(starts.length).toBeGreaterThan(0);
        expect(starts.length).toBeLessThanOrEqual(16);
        const executions = await savedExecutions(plan.outputDirectory);
        expect(executions).toHaveLength(16);
        expect(executions[0]).toBe(
          failure === 'provider' ? 'failed' : failure === 'timeout' ? 'timeout' : 'completed',
        );
        if (failure === 'cleanup') {
          expect(starts).toHaveLength(1);
          expect(executions.slice(1)).toEqual(Array(15).fill('unevaluated'));
        } else {
          expect(executions.filter((execution) => execution !== 'unevaluated')).toHaveLength(
            starts.length,
          );
          expect(
            executions.every(
              (execution) => execution === executions[0] || execution === 'unevaluated',
            ),
          ).toBe(true);
        }
        expect(result.retries).toBe(0);
        expect(result.records.map((record) => (isRecord(record) ? record.trial : null))).toEqual(
          trialOrder,
        );
        const original = await readFile(join(plan.outputDirectory, 'evaluation.json'), 'utf8');
        await assert.rejects(() => runEvaluation(context.repo, plan), /EEXIST/);
        expect(await readFile(join(plan.outputDirectory, 'evaluation.json'), 'utf8')).toBe(
          original,
        );
      });
    },
    15000,
  );
}

test.serial('contextファイルのないscoping入力も模擬actorへ渡せる', async () => {
  await withEvaluationFixture(async (context) => {
    await writeFile(join(context.repo, 'eval/corpus/cases.json'), JSON.stringify(cases));
    git(context.repo, 'add', 'eval/corpus/cases.json');
    git(context.repo, 'commit', '-qm', 'public scoping input without issue context');
    const plan = { ...context.plan, corpusCommit: git(context.repo, 'rev-parse', 'HEAD') };
    const result = await runEvaluation(context.repo, plan);
    expect(result.error).toBeNull();
    expect(await savedExecutions(plan.outputDirectory)).toEqual(['completed', 'completed']);
    const launches = (await readFile(join(context.root, 'actor-input.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      expect(launch).toMatchObject({ settings: { prompt: cases[0]?.prompt }, issue: null });
    }
  });
});

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
