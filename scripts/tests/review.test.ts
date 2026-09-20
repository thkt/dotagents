import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  controller,
  correctionFixture,
  events,
  object,
  reviewReplySource,
} from './support/correction.ts';
import { parseReview } from '../review.ts';
import type { ReviewItem } from '../review.ts';
import { prBody } from '../pr-body.ts';
import { git } from './support/target.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

async function reviewer(t: Awaited<ReturnType<typeof trial>>, body: string) {
  const path = join(t.root, 'review.js');
  await writeFile(
    path,
    `import {readFileSync,writeFileSync} from 'node:fs';
const role='review';
${reviewReplySource}
${body}
console.log(JSON.stringify(reply));`,
  );
  t.config.review = [process.execPath, path];
  await writeFile(t.configFile, JSON.stringify(t.config));
}

// Pure response validation needs no repository or external command. Each case
// starts with a valid control, then changes only the rejected condition.
function reviewResponse() {
  return {
    targetId: 'target-1',
    findings: 'Setup instructions are missing',
    assessments: {
      code: 'Source behavior inspected',
      requirements: 'Setup instructions required',
      tests: 'Existing source check retained; setup instructions checked independently',
      documentation: 'README absent',
    },
    updates: [] as Record<string, unknown>[],
    newItems: [
      {
        kind: 'defect',
        area: 'documentation',
        required: true,
        location: { path: null, line: null },
        condition: 'Reader needs setup instructions',
        impact: 'Cannot operate the change',
        evidence: 'Required README is absent',
        action: 'Add current instructions',
        reason: 'Missing documentation confirmed',
      },
    ] as Record<string, unknown>[],
    documents: [],
    handoff: [],
  };
}

test('host assigns stable IDs by attempt and response order, independently of finding content', () => {
  const reply = reviewResponse();
  reply.newItems.push({
    ...object(reply.newItems[0]),
    kind: 'concern',
    required: false,
    condition: 'Setup command has not been exercised on the deployment host',
  });
  const raw = JSON.stringify(reply);
  const review = parseReview(raw, 'target-1', 1);
  expect(review.items).toMatchObject([
    { ...reply.newItems[0], id: 'R1-1', introducedIn: 'target-1', disposition: 'open' },
    { ...reply.newItems[1], id: 'R1-2', introducedIn: 'target-1', disposition: 'open' },
  ]);
  expect(parseReview(raw, 'target-1', 1)).toEqual(review);
});

const invalidInitial: [string, (reply: ReturnType<typeof reviewResponse>) => void, string][] = [
  [
    'target',
    (reply) => {
      reply.targetId = 'different-source';
    },
    'target mismatch',
  ],
  [
    'non-string enum',
    (reply) => {
      object(reply.newItems[0]).kind = ['defect'];
    },
    'Missing or invalid',
  ],
  [
    'required field',
    (reply) => {
      delete object(reply.assessments).tests;
    },
    'Missing or invalid',
  ],
  [
    'unsolicited status',
    (reply) => {
      object(reply).status = 'accepted';
    },
    'Missing or invalid',
  ],
  [
    'model-supplied ID',
    (reply) => {
      object(reply.newItems[0]).id = 'R2-docs';
    },
    'Missing or invalid',
  ],
  [
    'unsolicited disposition',
    (reply) => {
      object(reply.newItems[0]).disposition = 'open';
    },
    'Missing or invalid',
  ],
  [
    'unsolicited introduction',
    (reply) => {
      object(reply.newItems[0]).introducedIn = reply.targetId;
    },
    'Missing or invalid',
  ],
];
for (const [name, mutate, reason] of invalidInitial) {
  test(`parseReview rejects ${name}`, () => {
    const reply = reviewResponse();
    const control = parseReview(JSON.stringify(reply), 'target-1', 1);
    expect(control.status).toBe('needs_changes');
    mutate(reply);
    expect(() => parseReview(JSON.stringify(reply), 'target-1', 1)).toThrow(reason);
  });
}

// Retain orchestration coverage for parser rejection and file-version binding.
for (const [name, mutation, reason] of [
  ['target', "reply.targetId='different-source'", 'target mismatch'],
  [
    'document outside target',
    "reply.documents=[{path:'missing.md',role:'current',reason:'Policy'}]",
    'not in reviewed source',
  ],
] as const) {
  test(`review rejects ${name} and preserves the raw response and target`, async () => {
    const t = await trial('normal');
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await reviewer(
      t,
      `const reply=reviewReply('needs_changes','Concrete documentation defect'); ${mutation};`,
    );
    const result = t.execute();
    expect(result.status).toBe(1);
    const state = await t.state();
    expect(state.result).toBe('invalid_review');
    expect(state.findings).toContain(reason);
    expect(state.reviewHistory).toEqual([]);
    expect([state.repair, state.review]).toEqual([0, 1]);
    const raw = object(
      JSON.parse(await readFile(join(t.config.runDir, 'review-1.stdout'), 'utf8')),
    );
    if (name === 'target') {
      expect(raw.targetId).toBe('different-source');
    }
    if (name === 'document outside target') {
      expect(raw.documents).toEqual([{ path: 'missing.md', role: 'current', reason: 'Policy' }]);
    }
    const target = object(
      JSON.parse(await readFile(join(t.config.runDir, 'review-1.target.json'), 'utf8')),
    );
    expect(target.source).toBe(state.source);
    if (name === 'document outside target') {
      expect(raw.targetId).toBe(target.targetId);
    }
    expect(await Bun.file(join(t.config.runDir, 'review-1.json')).exists()).toBe(false);
    expect(await Bun.file(join(t.config.runDir, 'repair-1.prompt')).exists()).toBe(false);
    expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
  });
}

for (const disposition of ['fixed', 'not_applicable'] as const) {
  test(`re-evaluation adjudicates prior findings: ${disposition}`, async () => {
    const t = await trial('docs');
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    if (disposition === 'not_applicable') {
      await writeFile(join(t.config.cwd, 'README.md'), 'current');
    }
    await reviewer(
      t,
      `writeFileSync(${JSON.stringify(join(t.root, 'reviewed'))},'1');
const reply=reviewReply(reviewContext.previous?'accepted':'needs_changes','Review summary');
if(reviewContext.previous) {
 ${disposition === 'not_applicable' ? "reply.updates[0].disposition='not_applicable'; reply.updates[0].reason='README.md was present in both versions with current instructions; the original missing-file claim was incorrect.';" : ''}
}`,
    );
    const result = t.execute();
    expect(result.status).toBe(0);
    const state = await t.state();
    expect(state.result).toBe('ready_for_human_review');
    const history = events(state.reviewHistory).map(object);
    expect(history.length).toBe(2);
    const first = object(events(history[0]?.items)[0]);
    expect(first.disposition).toBe('open');
    expect([state.repair, state.review]).toEqual([1, 2]);
    expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
    expect(await readFile(join(t.config.cwd, 'README.md'), 'utf8')).toBe('current');
    const latest = object(events(history[1]?.items)[0]);
    expect(latest).toEqual({ ...first, disposition, reason: latest.reason });
    expect(history[0]?.status).toBe('needs_changes');
    expect(history[1]?.status).toBe('accepted');
    expect(latest.introducedIn).toBe(history[0]?.targetId);
    expect(latest.disposition).toBe(disposition);
    expect(state.findings).toContain(latest.reason);
    expect(state.findings).toContain('review-1.json');
    expect(state.findings).toContain('review-2.json');
    const prompt = await readFile(join(t.config.runDir, 'review-2.prompt'), 'utf8');
    const context = object(JSON.parse(prompt.split('Host context: ')[1]?.split('\n')[0] ?? 'null'));
    expect(context.previous).toEqual(history[0]);
    expect(await readFile(join(t.config.runDir, 'repair-1.prompt'), 'utf8')).toContain(
      String(first.id),
    );
  });
}

// Reject deltas that could silently lose or overwrite historical findings.
const invalidUpdates: [string, (reply: ReturnType<typeof reviewResponse>) => void, string][] = [
  [
    'omitted',
    (reply) => {
      reply.updates = [];
    },
    'Prior finding omitted',
  ],
  [
    'duplicate',
    (reply) => {
      reply.updates.push(object(reply.updates[0]));
    },
    'Duplicate finding update ID',
  ],
  [
    'unknown',
    (reply) => {
      object(reply.updates[0]).id = 'R1-unknown';
    },
    'Unknown finding update ID',
  ],
  [
    'rewritten',
    (reply) => {
      object(reply.updates[0]).required = false;
    },
    'Missing or invalid',
  ],
  [
    'empty reason',
    (reply) => {
      object(reply.updates[0]).reason = ' ';
    },
    'Missing or invalid',
  ],
];
for (const [name, mutate, reason] of invalidUpdates) {
  test(`parseReview rejects ${name} judgment`, () => {
    const previous = parseReview(JSON.stringify(reviewResponse()), 'target-1', 1);
    const saved = structuredClone(previous);
    const reply = {
      ...reviewResponse(),
      targetId: 'target-2',
      newItems: [],
      updates: [{ id: 'R1-1', disposition: 'fixed', reason: 'README contains setup instructions' }],
    };
    expect(parseReview(JSON.stringify(reply), 'target-2', 2, previous).status).toBe('accepted');
    mutate(reply);
    expect(() => parseReview(JSON.stringify(reply), 'target-2', 2, previous)).toThrow(reason);
    expect(previous).toEqual(saved);
  });
}

test('invalid re-evaluation retains the last complete review and prevents another repair', async () => {
  const t = await trial('docs');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  await reviewer(
    t,
    `
writeFileSync(${JSON.stringify(join(t.root, 'reviewed'))},'1');
const reply=reviewReply(reviewContext.previous?'accepted':'needs_changes','Review summary');
if(reviewContext.previous) { reply.updates=[]; }`,
  );
  expect(t.execute().status).toBe(1);
  const state = await t.state();
  expect(state.result).toBe('invalid_review');
  expect(state.findings).toContain('Prior finding omitted');
  const record = object(JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8')));
  expect(state.reviewHistory).toEqual([record.review]);
  const first = object(events(object(record.review).items)[0]);
  const target = object(
    JSON.parse(await readFile(join(t.config.runDir, 'review-1.target.json'), 'utf8')),
  );
  expect(first.introducedIn).toBe(target.targetId);
  expect(first.disposition).toBe('open');
  expect([state.repair, state.review]).toEqual([1, 2]);
  const raw = object(JSON.parse(await readFile(join(t.config.runDir, 'review-2.stdout'), 'utf8')));
  expect(raw.updates).toEqual([]);
  const latestTarget = object(
    JSON.parse(await readFile(join(t.config.runDir, 'review-2.target.json'), 'utf8')),
  );
  expect(raw.targetId).toBe(latestTarget.targetId);
  expect(latestTarget.source).toBe(state.source);
  expect(await Bun.file(join(t.config.runDir, 'review-2.json')).exists()).toBe(false);
  expect(await Bun.file(join(t.config.runDir, 'repair-2.prompt')).exists()).toBe(false);
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
  expect(await readFile(join(t.config.cwd, 'README.md'), 'utf8')).toBe('current');
});

test('host combines reordered judgments and new findings, reopens resolved findings and blocks PR text', () => {
  const finding: ReviewItem = {
    id: 'R1-1',
    introducedIn: 'target-1',
    kind: 'defect',
    area: 'code',
    required: true,
    location: { path: 'page.ts', line: 3 },
    condition: 'Nonzero offset',
    impact: 'Wrong page',
    evidence: 'page([10,20,30,40],2,2) returns []',
    action: 'Use offset + limit',
    disposition: 'open',
    reason: 'Incorrect slice end',
  };
  const {
    id: _id,
    introducedIn: _introducedIn,
    disposition: _disposition,
    ...newFinding
  } = finding;
  const response = {
    targetId: 'target-1',
    findings: 'Pagination review',
    assessments: {
      code: 'Bounds inspected',
      requirements: 'Pagination contract',
      tests:
        'Retained nonzero-offset regression: zero-offset cases miss an incorrect slice end. Consolidated duplicate zero-offset cases; no distinct detection lost. Direct checks avoid Git setup; live execution remains unverified.',
      documentation: 'README inspected',
    },
    updates: [],
    newItems: [newFinding],
    documents: [],
    handoff: [],
  };
  const first = parseReview(JSON.stringify(response), 'target-1', 1);
  expect(first.status).toBe('needs_changes');
  const second = parseReview(
    JSON.stringify({
      ...response,
      targetId: 'target-2',
      updates: [{ id: 'R1-1', disposition: 'fixed', reason: 'Nonzero offset now returns [30,40]' }],
      newItems: [
        {
          ...newFinding,
          condition: 'Invalid limit',
          reason: 'Negative limit is accepted',
        },
      ],
    }),
    'target-2',
    2,
    first,
  );
  expect(second.items[1]).toEqual({
    ...finding,
    id: 'R2-1',
    introducedIn: 'target-2',
    condition: 'Invalid limit',
    reason: 'Negative limit is accepted',
  });
  expect(second.status).toBe('needs_changes');
  expect(() =>
    parseReview(
      JSON.stringify({
        ...response,
        targetId: 'target-3',
        newItems: [],
        updates: [{ id: 'R2-1', disposition: 'fixed', reason: 'Negative limit guarded' }],
      }),
      'target-3',
      3,
      second,
    ),
  ).toThrow('Prior finding omitted');
  const third = parseReview(
    JSON.stringify({
      ...response,
      targetId: 'target-3',
      newItems: [],
      updates: [
        {
          id: 'R2-1',
          disposition: 'not_applicable',
          reason: 'Guard already rejects negative limits',
        },
        { id: 'R1-1', disposition: 'open', reason: 'Offset fix regressed' },
      ],
    }),
    'target-3',
    3,
    second,
  );
  expect(third.items).toEqual([
    { ...finding, reason: 'Offset fix regressed' },
    {
      ...finding,
      id: 'R2-1',
      introducedIn: 'target-2',
      condition: 'Invalid limit',
      disposition: 'not_applicable',
      reason: 'Guard already rejects negative limits',
    },
  ]);
  expect(first.items).toEqual([finding]);
  expect(second.items[0]?.disposition).toBe('fixed');
  expect(third.status).toBe('needs_changes');
  const input = {
    review: third,
    repository: 'owner/repo',
    number: '82',
    commit: 'head',
    check: ['check'],
    ciChecks: ['checks'],
    media: [],
    localRoots: [],
  };
  expect(() => prBody(input)).toThrow('requires an accepted review');
  const body = prBody({
    ...input,
    review: parseReview(JSON.stringify({ ...response, newItems: [] }), 'target-1', 1),
  });
  expect(body).toContain(response.assessments.tests);
  expect(body).not.toContain('## 指摘への対応');
});

test('PR descriptions preserve structural Markdown and prose without adding a mandatory view', () => {
  // Examples describe this PR's generator and guide changes. This checks transport,
  // not whether a live reviewer chooses an appropriate explanation.
  const structural = [
    '解決済み指摘は現在の対応を一度だけ説明する。内部の指摘履歴は保持する。',
    '公開するデータの概略（実行コードではない）:',
    '```diff',
    ' open: condition + impact + reason + action',
    '-fixed / not_applicable: condition + impact + reason',
    '+fixed / not_applicable: reason（問題・条件・現在の判断と根拠）',
    '```',
  ].join('\n');
  const prose = '操作の詳細を既存ガイドへまとめる。本文には未完了の作業と担当を残す。';
  for (const code of [structural, prose]) {
    const response = reviewResponse();
    response.assessments.code = code;
    response.newItems = [];
    const body = prBody({
      review: parseReview(JSON.stringify(response), 'target-1', 1),
      repository: 'owner/repo',
      number: '142',
      commit: 'reviewed-head',
      check: ['bun', 'run', 'check'],
      ciChecks: ['checks', 'verify'],
      media: [],
      localRoots: [],
    });
    expect(body).toContain(`\n\n${code}\n\n`);
    if (code === prose) {
      expect(body).not.toContain('```');
    }
  }
});

test('repair after a failed check retains prior review findings and current failure evidence', async () => {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  await reviewer(
    t,
    "const reply=reviewReply(reviewContext.previous?'accepted':'needs_changes','Documentation review');",
  );
  const repair = join(t.root, 'repair.js');
  await writeFile(
    repair,
    `import {readFileSync,writeFileSync} from 'node:fs';
readFileSync(0,'utf8');
const recovering=readFileSync('source.txt','utf8')==='broken';
writeFileSync('source.txt',recovering?'correct':'broken');
writeFileSync('README.md','current');
console.log(JSON.stringify({status:'repaired',findings:'Updated source and documentation'}));`,
  );
  t.config.repair = [process.execPath, repair];
  await writeFile(t.configFile, JSON.stringify(t.config));
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  expect(state.result).toBe('ready_for_human_review');
  expect([state.checks, state.repair, state.review]).toEqual([3, 2, 2]);
  const history = events(state.reviewHistory).map(object);
  const first = object(events(history[0]?.items)[0]);
  const prompt = await readFile(join(t.config.runDir, 'repair-2.prompt'), 'utf8');
  expect(prompt).toContain('check-2.stdout');
  expect(prompt).toContain('check-2.stderr');
  expect(prompt).toContain(String(first.id));
  expect(prompt).toContain(String(first.introducedIn));
  expect(prompt).toContain(String(first.evidence));
  expect(prompt).toContain(String(first.action));
  expect(prompt).toContain('review-1.json');
  expect(object(events(history[1]?.items)[0]).disposition).toBe('fixed');
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
  expect(await readFile(join(t.config.cwd, 'README.md'), 'utf8')).toBe('current');
});

for (const documentsOnly of [false, true]) {
  test(`accepted document versions, diff, check and model remain traceable (documents only: ${documentsOnly})`, async () => {
    const t = await trial('normal', {
      reviewModel: { model: 'fixture-model', reasoningEffort: 'high' },
    });
    await writeFile(join(t.config.cwd, 'README.md'), 'Current operating instructions');
    if (documentsOnly) {
      await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    }
    git(t.config.cwd, 'add', 'source.txt');
    git(t.config.cwd, 'commit', '-m', 'source base');
    const base = git(t.config.cwd, 'rev-parse', 'HEAD');
    const binary = Buffer.from([0, 255, 128, 10]);
    // Git's UTF-8 path order differs from JavaScript sorting for these two names.
    const binaryPath = '\uE000\tfile\n.bin';
    const linkPath = '\u{10000}-link';
    if (!documentsOnly) {
      await writeFile(join(t.config.cwd, binaryPath), binary);
      await chmod(join(t.config.cwd, binaryPath), 0o755);
      await symlink(binaryPath, join(t.config.cwd, linkPath));
    }
    await reviewer(
      t,
      `const reply=reviewReply('needs_changes','Ready with an unverified concern');
reply.newItems[0].kind='concern'; reply.newItems[0].required=false;
reply.documents=[{path:'README.md',role:'current',reason:'Operating instructions for this change'}];`,
    );
    // A file can change and be restored while records are written. The saved body
    // must still describe the bytes that produced the target hash, not a later read.
    const result = documentsOnly
      ? t.execute()
      : await withFileHooks(
          t,
          `
writeFile: async (path,...args)=>{
 await fs.writeFile(path,...args);
 const binaryPath=${JSON.stringify(join(t.config.cwd, binaryPath))};
 if(String(path).endsWith('review-1.target.json')) await fs.writeFile(binaryPath,'transient bytes');
 if(String(path).endsWith('review-1.additions.json')) await fs.writeFile(binaryPath,Buffer.from([0,255,128,10]));
}`,
        );
    expect(result.status).toBe(0);
    const state = await t.state();
    const target = object(
      JSON.parse(await readFile(join(t.config.runDir, 'review-1.target.json'), 'utf8')),
    );
    expect(target.baseCommit).toBe(base);
    expect(object(target.issue).hash).toBe(state.issueHash);
    expect(object(target.issue).content).toContain('Agreed requirement');
    expect(object(target.check).command).toEqual(t.config.check);
    expect(object(target.check).code).toBe(0);
    expect(object(target.check).source).toBe(state.source);
    expect(object(target.model).settings).toEqual(t.config.reviewModel);
    const record = object(
      JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8')),
    );
    expect(object(record.review).targetId).toBe(target.targetId);
    expect(object(record.review).status).toBe('accepted');
    expect(object(events(record.documents)[0]).hash).toBe(
      createHash('sha256').update('Current operating instructions').digest('hex'),
    );
    const diff = await readFile(join(t.config.runDir, 'review-1.diff'), 'utf8');
    expect(state.repair).toBe(documentsOnly ? 0 : 1);
    if (documentsOnly) {
      expect(diff).toBe('');
    } else {
      expect(diff).toContain('+correct');
    }
    const additions = events(
      JSON.parse(await readFile(join(t.config.runDir, 'review-1.additions.json'), 'utf8')),
    ).map(object);
    const expected = [
      { path: 'README.md', bytes: Buffer.from('Current operating instructions'), symlink: false },
      ...(!documentsOnly
        ? [
            { path: binaryPath, bytes: binary, symlink: false },
            { path: linkPath, bytes: Buffer.from(binaryPath), symlink: true },
          ]
        : []),
    ];
    expect(additions.map((file) => file.path)).toEqual(expected.map((file) => file.path));
    for (const file of expected) {
      const mode = (await lstat(join(t.config.cwd, file.path))).mode;
      expect(additions.find((entry) => entry.path === file.path)).toEqual({
        path: file.path,
        mode,
        symlink: file.symlink,
        content: file.bytes.toString(file.symlink ? 'utf8' : 'base64'),
      });
      expect(events(target.files)).toContainEqual([
        file.path,
        mode,
        createHash('sha256').update(file.bytes).digest('hex'),
      ]);
    }
    expect(state.findings).toContain('担当AI: 未計測の実サービス応答時間を報告する');
  });
}

// Inject filesystem changes at real I/O boundaries in an isolated controller process.
async function withFileHooks(t: Awaited<ReturnType<typeof trial>>, hooks: string) {
  const preload = join(t.root, 'file-hooks.js');
  await writeFile(
    preload,
    `
import {mock} from 'bun:test';
import * as filesystem from 'node:fs/promises';
const fs={...filesystem};
mock.module('node:fs/promises',()=>({...fs,${hooks}}));
`,
  );
  return spawnSync(process.execPath, ['--preload', preload, controller, t.configFile], {
    encoding: 'utf8',
    timeout: 20000,
  });
}

for (const [attempt, terminalFailure] of [
  [1, false],
  [2, false],
  [2, true],
] as const) {
  test(`review save failure at attempt ${attempt}, terminal save failure ${terminalFailure}`, async () => {
    const t = await trial('docs');
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await reviewer(
      t,
      `const reply=reviewReply(${attempt}===1 || reviewContext.previous ? 'accepted' : 'needs_changes','Valid review');`,
    );
    const prefix = join(t.config.runDir, `review-${attempt}`);
    const result = await withFileHooks(
      t,
      `
writeFile: async (path,...args)=>{
 if(path===${JSON.stringify(prefix + '.json')}) throw Error('review disk fixture failure');
 if(${terminalFailure} && String(path).endsWith('state.json.tmp') && JSON.parse(args[0]).result==='review_storage_failed') throw Error('terminal disk fixture failure');
 return fs.writeFile(path,...args);
}`,
    );
    expect(result.status).toBe(1);
    const state = await t.state();
    expect([state.review, state.repair]).toEqual([attempt, attempt - 1]);
    expect(events(state.reviewHistory)).toHaveLength(attempt - 1);
    if (attempt === 2) {
      const previous = object(
        JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8')),
      );
      expect(events(state.reviewHistory)[0]).toEqual(previous.review);
      expect(object(previous.review).status).toBe('needs_changes');
    }
    const raw = object(JSON.parse(await readFile(`${prefix}.stdout`, 'utf8')));
    expect(raw.newItems).toEqual([]);
    expect(await Bun.file(`${prefix}.target.json`).exists()).toBe(true);
    if (terminalFailure) {
      expect(state.active).toMatchObject({ role: 'review', prefix });
      expect(result.stderr).toContain('terminal disk fixture failure');
      expect(result.stderr).toContain(join(t.config.runDir, 'state.json'));
    } else {
      expect(state.result).toBe('review_storage_failed');
      expect(state.active).toBeNull();
    }
    const diagnostic = terminalFailure ? result.stderr : String(state.findings);
    expect(diagnostic).toContain('review disk fixture failure');
    expect(diagnostic).toContain(`${prefix}.json`);
    expect(diagnostic).toContain(`${prefix}.stdout`);
    expect(diagnostic).not.toContain('Invalid review');
    const saved = await readFile(join(t.config.runDir, 'state.json'), 'utf8');
    expect(t.execute().status).toBe(1);
    expect(await readFile(join(t.config.runDir, 'state.json'), 'utf8')).toBe(saved);
    expect(await Bun.file(join(t.config.runDir, `repair-${attempt}.prompt`)).exists()).toBe(false);
    expect(await Bun.file(join(t.config.runDir, `review-${attempt + 1}.prompt`)).exists()).toBe(
      false,
    );
  });
}

for (const [change, operation] of Object.entries({
  addition: "await fs.writeFile(cwd+'/new.txt','new')",
  content: "await fs.writeFile(cwd+'/source.txt','changed')",
  mode: "await fs.chmod(cwd+'/source.txt',0o755)",
  symlink: "await fs.unlink(cwd+'/link'); await fs.symlink('missing',cwd+'/link')",
})) {
  test(`review preparation refuses persistent ${change} changes before model launch`, async () => {
    const t = await trial('normal');
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await symlink('source.txt', join(t.config.cwd, 'link'));
    const result = await withFileHooks(
      t,
      `
writeFile: async (path,...args)=>{
 await fs.writeFile(path,...args);
 if(String(path).endsWith('review-1.diff')) {
  const cwd=${JSON.stringify(t.config.cwd)};
  ${operation};
 }
}`,
    );
    expect(result.status).toBe(1);
    expect(await t.state()).toMatchObject({ result: 'source_changed', review: 0, repair: 0 });
    expect(await Bun.file(join(t.config.runDir, 'review-1.additions.json')).exists()).toBe(true);
    expect(await Bun.file(join(t.config.runDir, 'review-1.prompt')).exists()).toBe(false);
  });
}

test('a file disappearing after lstat is not treated as an identified deletion', async () => {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  const path = join(t.config.cwd, 'vanishing.txt');
  await writeFile(path, 'must be read');
  git(t.config.cwd, 'add', 'vanishing.txt');
  const result = await withFileHooks(
    t,
    `
lstat: async (path,...args)=>{
 const stat=await fs.lstat(path,...args);
 if(path===${JSON.stringify(path)}) await fs.unlink(path);
 return stat;
}`,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stderr).toContain('vanishing.txt');
  expect(await t.state()).toMatchObject({ review: 0, repair: 0, checks: 0 });
  expect(await Bun.file(join(t.config.runDir, 'review-1.prompt')).exists()).toBe(false);
});

test('an enumerated untracked file disappearing stops review without a partial success', async () => {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  const path = join(t.config.cwd, 'vanishing.txt');
  await writeFile(path, 'must be recorded');
  const bin = join(t.root, 'bin');
  await mkdir(bin);
  const realGit = Bun.which('git');
  expect(realGit).not.toBeNull();
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env bun
import {spawnSync} from 'node:child_process';
import {unlinkSync} from 'node:fs';
const args=process.argv.slice(2);
const result=spawnSync(${JSON.stringify(realGit)},args);
if(result.status===0 && args.includes('ls-files') && args.includes('--others') && !args.includes('--cached')) {
 unlinkSync(${JSON.stringify(path)});
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status??1);
`,
  );
  await chmod(join(bin, 'git'), 0o755);
  const result = spawnSync(process.execPath, [controller, t.configFile], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 20000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stderr).toContain('vanishing.txt');
  expect(await t.state()).toMatchObject({ review: 0, repair: 0, checks: 1 });
  expect(await Bun.file(join(t.config.runDir, 'review-1.prompt')).exists()).toBe(false);
});

test('selected evidence reaches repair and review with original versions and changed applicability', async () => {
  const t = await trial('normal');
  const path = 'research/reset.md';
  const proposal = 'research/keyboard.md';
  const original =
    'Observed: pointer reset clears filters; keyboard behavior unverified. Source: source.txt at baseline.\n';
  const updated =
    'Observed: pointer reset clears filters; keyboard reset also verified by the new targeted check.\n';
  await mkdir(join(t.config.cwd, 'research'));
  await writeFile(join(t.config.cwd, path), original);
  await writeFile(
    join(t.config.cwd, proposal),
    'Proposal only: move focus to the first result on keyboard reset. No agreement.\n',
  );
  git(t.config.cwd, 'add', 'research');
  git(t.config.cwd, 'commit', '-m', 'selected evidence');
  const base = git(t.config.cwd, 'rev-parse', 'HEAD');
  const reports = [path, proposal].map((path) => ({
    path,
    blob: git(t.config.cwd, 'rev-parse', `HEAD:${path}`),
  }));
  t.config.baseCommit = base;
  t.config.reports = reports;
  const repair = join(t.root, 'repair.js');
  await writeFile(
    repair,
    `import {writeFileSync} from 'node:fs';
writeFileSync('source.txt','correct');
writeFileSync(${JSON.stringify(path)},${JSON.stringify(updated)});
console.log(JSON.stringify({status:'repaired',findings:'Fixture evidence updated; focus proposal remains unagreed'}));`,
  );
  t.config.repair = [process.execPath, repair];
  // The simulated judgment exercises transport only, not model semantic accuracy.
  await reviewer(
    t,
    `const reply=reviewReply('accepted','Scoped evidence assessed');
reply.assessments.requirements='Pointer and keyboard evidence have different applicability; focus movement is an unagreed proposal, not a requirement.';
reply.documents=[
 {path:${JSON.stringify(path)},role:'current',reason:'New keyboard observation supersedes the handoff limitation; compare startCommit before reuse'},
 {path:${JSON.stringify(proposal)},role:'proposal',reason:'Focus movement has no agreement; excluded from implementation scope'}
];`,
  );
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  expect([state.repair, state.review]).toEqual([1, 1]);
  for (const role of ['repair', 'review']) {
    const prompt = await readFile(join(t.config.runDir, `${role}-1.prompt`), 'utf8');
    const references: unknown = JSON.parse(
      prompt.split('Implementation references: ')[1]?.split('\n')[0] ?? 'null',
    );
    expect(references).toEqual({ startCommit: base, reports });
    expect(prompt).not.toContain(original.trim());
    expect(prompt).not.toContain(updated.trim());
  }
  const target = object(
    JSON.parse(await readFile(join(t.config.runDir, 'review-1.target.json'), 'utf8')),
  );
  expect(target.reports).toEqual(reports);
  expect(target.baseCommit).toBe(base);
  const record = object(JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8')));
  expect(object(events(record.documents)[0]).hash).toBe(
    createHash('sha256').update(updated).digest('hex'),
  );
  expect(git(t.config.cwd, 'show', `${base}:${path}`)).toBe(original.trim());
  expect(state.findings).toContain(`${proposal} (proposal)`);
  expect(state.findings).toContain('Focus movement has no agreement');
  // A later evidence-only edit cannot reuse the accepted result.
  await writeFile(join(t.config.cwd, path), 'Keyboard observation withdrawn.\n');
  const stale = t.execute();
  expect(stale.status).toBe(1);
  expect(object(JSON.parse(stale.stdout)).result).toBe('target_changed_after_stop');
});

test('standalone correction rejects a stale report pin before executing verification', async () => {
  const t = await trial('normal');
  const path = 'research/reset.md';
  await mkdir(join(t.config.cwd, 'research'));
  await writeFile(join(t.config.cwd, path), 'Reviewed pointer behavior');
  const blob = git(t.config.cwd, 'hash-object', '--no-filters', '--', path);
  await writeFile(join(t.config.cwd, path), 'Changed pointer behavior');
  git(t.config.cwd, 'add', 'research');
  git(t.config.cwd, 'commit', '-m', 'different evidence');
  t.config.baseCommit = git(t.config.cwd, 'rev-parse', 'HEAD');
  t.config.reports = [{ path, blob }];
  await writeFile(t.configFile, JSON.stringify(t.config));
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Required report differs from reviewed version: ${path}`);
  expect(await Bun.file(join(t.config.runDir, 'check-1.stdout')).exists()).toBe(false);
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
});
