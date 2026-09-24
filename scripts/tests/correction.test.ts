import { test, expect, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile, readFile, rm, rename, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  correctionConfig,
  correctionFixture,
  controller,
  object,
  events,
  reviewReplySource,
} from './support/correction.ts';
import { parseRepairReply } from '../repair.ts';
import { assertConfig, assertState } from '../input.ts';
import { snapshot } from '../correction.ts';
import { git } from './support/target.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

for (const mutation of ['delete', 'rename'] as const) {
  test(`verified ${mutation} survives staging and commit but rejects later artifacts`, async () => {
    const t = await trial('normal');
    const cwd = t.config.cwd;
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'Test');
    await writeFile(join(cwd, 'obsolete.txt'), 'old');
    git(cwd, 'add', '--all');
    git(cwd, 'commit', '-m', 'base');
    if (mutation === 'delete') {
      await rm(join(cwd, 'obsolete.txt'));
    } else {
      await rename(join(cwd, 'obsolete.txt'), join(cwd, 'renamed.txt'));
    }
    expect(t.execute().status).toBe(0);
    const verified = await t.state();
    expect(verified.checks).toBe(2);
    git(cwd, 'add', '--all');
    expect(t.execute().status).toBe(0);
    git(cwd, 'commit', '-m', 'verified artifacts');
    expect(t.execute().status).toBe(0);
    expect(await t.state()).toEqual(verified);
    if (mutation === 'delete') {
      await writeFile(join(cwd, 'obsolete.txt'), 'restored after acceptance');
    } else {
      await chmod(join(cwd, 'renamed.txt'), 0o755);
    }
    const stale = t.execute();
    expect(stale.status).toBe(1);
    expect(object(JSON.parse(stale.stdout)).result).toBe('target_changed_after_stop');
    expect(await t.state()).toEqual(verified);
  });
}

async function checkRepairEvidence(mode: string, runDir: string, findings: unknown) {
  if (mode === 'invalid_repair' || mode === 'human') {
    expect(findings).toBe(mode === 'human' ? 'Need changed requirements' : 'Unrecognized outcome');
    expect(await readFile(join(runDir, 'repair-1.stdout'), 'utf8')).toContain(String(findings));
  }
  if (mode === 'normal') {
    const prompt = await readFile(join(runDir, 'repair-1.prompt'), 'utf8');
    expect(prompt).toContain('Agreed requirement: correct source and docs');
  }
}

for (const [mode, result, repairs, reviews] of [
  ['normal', 'ready_for_human_review', 1, 1],
  ['invalid_repair', 'invalid_repair', 1, 0],
  ['null_review', 'invalid_review', 1, 1],
  ['human', 'human_decision_required', 1, 0],
  ['issue_changed', 'requirements_changed', 1, 1],
  ['review_failed', 'review_failed', 1, 1],
  ['malformed', 'invalid_review', 1, 1],
  ['changed', 'source_changed', 1, 1],
  ['exhaust', 'execution_limit', 2, 0],
] as const) {
  test(mode, async () => {
    const t = await trial(mode, { modelTimeMs: null });
    expect(t.execute().status).toBe(result === 'ready_for_human_review' ? 0 : 1);
    const state = await t.state();
    expect(state.result).toBe(result);
    expect(state.repair).toBe(repairs);
    expect(state.review).toBe(reviews);
    await checkRepairEvidence(mode, t.config.runDir, state.findings);
    if (reviews && result !== 'ready_for_human_review') {
      expect(state.reviewHistory).toEqual([]);
      expect(await Bun.file(join(t.config.runDir, 'review-1.stdout')).exists()).toBe(true);
      expect(await Bun.file(join(t.config.runDir, 'review-1.target.json')).exists()).toBe(true);
      expect(await Bun.file(join(t.config.runDir, 'review-1.json')).exists()).toBe(false);
    }
    if (result === 'ready_for_human_review') {
      expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
      const models = events(state.events)
        .map(object)
        .filter((event) => event.role !== 'check');
      expect(models.map((event) => event.role)).toEqual(['repair', 'review']);
      let total = 0;
      for (const event of models) {
        expect(event.timedOut).toBe(false);
        expect(typeof event.ms).toBe('number');
        if (typeof event.ms !== 'number') {
          throw Error('Missing model elapsed time');
        }
        expect(event.ms).toBeGreaterThan(0);
        total += event.ms;
      }
      expect(state.modelMs).toBe(total);
    }
    if (mode === 'normal' || mode === 'exhaust') {
      const before = await t.state();
      const repeated = t.execute();
      expect(repeated.status).toBe(mode === 'normal' ? 0 : 1);
      expect(object(JSON.parse(repeated.stdout))).toEqual(before);
      expect(await t.state()).toEqual(before);
    }
  });
}

test('unlimited attempts check and accept the latest repair after recurring findings', async () => {
  const t = await trial('docs', { repairLimit: null, reviewLimit: null, modelTimeMs: null });
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct-0');
  await writeFile(
    join(t.root, 'helper.js'),
    `
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
const stage=existsSync('README.md')?Number(readFileSync('README.md','utf8')):0;
if(role==='issue') console.log('Agreed requirement: complete source and instructions through stage 3');
if(role==='check') {
 console.log(readFileSync('source.txt','utf8'));
 process.exit(readFileSync('source.txt','utf8')==='correct-'+stage?0:1);
}
if(role==='repair') {
 writeFileSync('README.md',String(stage+1));
 writeFileSync('source.txt','correct-'+(stage+1));
 console.log(JSON.stringify({status:'repaired',findings:'Completed stage '+(stage+1)}));
}
if(role==='review') console.log(JSON.stringify(reviewReply(stage===3?'accepted':'needs_changes',stage===3?'Instructions complete':'Instructions incomplete')));
`,
  );
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  expect(state).toMatchObject({
    result: 'ready_for_human_review',
    repair: 3,
    review: 4,
    checks: 4,
    active: null,
  });
  const history = events(state.reviewHistory).map(object);
  expect(history.map((review) => review.status)).toEqual([
    'needs_changes',
    'needs_changes',
    'needs_changes',
    'accepted',
  ]);
  expect(new Set(history.map((review) => review.targetId)).size).toBe(4);
  expect(history.at(-1)).toMatchObject({ items: [{ id: 'R1-1', disposition: 'fixed' }] });
  const recorded = events(state.events).map(object);
  const source = await snapshot(t.config.cwd);
  expect(state.source).toBe(source);
  expect(recorded.slice(-2)).toMatchObject([
    { role: 'check', code: 0, source },
    { role: 'review', code: 0, source },
  ]);
  expect(await readFile(join(t.config.runDir, 'check-4.stdout'), 'utf8')).toBe('correct-3\n');
  const prompt = await readFile(join(t.config.runDir, 'repair-3.prompt'), 'utf8');
  for (const review of [1, 2, 3]) {
    expect(prompt).toContain(join(t.config.runDir, `review-${review}.json`));
  }
  expect(prompt).toContain('R1-1');
});

test('blank human findings stop repair and preserve work and prior review evidence', async () => {
  const t = await trial('blank_human');
  expect(t.execute().status).toBe(1);
  const state = await t.state();
  expect(state).toMatchObject({
    result: 'invalid_repair',
    findings: '',
    repair: 2,
    review: 1,
    checks: 2,
  });
  expect(await readFile(join(t.config.cwd, 'README.md'), 'utf8')).toBe('current');
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
  expect(state.reviewHistory).toEqual([
    object(JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8'))).review,
  ]);
  expect(state.reviewHistory).toMatchObject([
    { status: 'needs_changes', findings: 'README missing' },
  ]);
  expect(JSON.parse(await readFile(join(t.config.runDir, 'repair-2.stdout'), 'utf8'))).toEqual({
    status: 'needs_human',
    findings: '',
  });
  const paths = [
    'state.json',
    'check-1.stdout',
    'check-1.stderr',
    'check-2.stdout',
    'repair-1.stdout',
    'repair-2.stdout',
    'review-1.stdout',
    'review-1.json',
  ].map((path) => join(t.config.runDir, path));
  const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  expect(t.execute().status).toBe(1);
  expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before);
  for (const path of ['check-3.stdout', 'repair-3.stdout', 'review-2.stdout']) {
    expect(await Bun.file(join(t.config.runDir, path)).exists()).toBe(false);
  }
});

test('Issue retrieval failure after repair preserves reservation and refuses reexecution', async () => {
  const t = await trial('normal');
  const helper = join(t.root, 'helper.js');
  await writeFile(
    helper,
    (await readFile(helper, 'utf8')) +
      "\nif(role==='issue' && readFileSync('source.txt','utf8')==='correct') process.exit(1);\n",
  );
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Issue unavailable');
  expect(await t.state()).toMatchObject({
    active: { role: 'repair', prefix: join(t.config.runDir, 'repair-1') },
    repair: 1,
    review: 0,
    checks: 1,
    reviewHistory: [],
  });
  const paths = ['state.json', 'repair-1.stdout', 'repair-1.stderr'].map((path) =>
    join(t.config.runDir, path),
  );
  paths.push(join(t.config.cwd, 'source.txt'));
  const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  expect(JSON.parse(before[1] ?? '')).toEqual({ status: 'repaired', findings: 'fixed' });
  expect(before[3]).toBe('correct');
  const retry = t.execute();
  expect(retry.status).toBe(1);
  expect(retry.stderr).toContain('Interrupted execution');
  expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before);
});

test('changed limits cannot reset an existing finite trial', async () => {
  const t = await trial('exhaust');
  expect(t.execute().status).toBe(1);
  const stateFile = join(t.config.runDir, 'state.json');
  const before = await readFile(stateFile, 'utf8');
  expect(await t.state()).toMatchObject({ repair: 2, result: 'execution_limit' });
  await writeFile(t.configFile, JSON.stringify({ ...t.config, repairLimit: null }));
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('configuration changed');
  expect(await readFile(stateFile, 'utf8')).toBe(before);
});

test('terminal success still refuses an active reservation or an existing lock', async () => {
  const t = await trial('normal');
  expect(t.execute().status).toBe(0);
  const stateFile = join(t.config.runDir, 'state.json');
  const saved = await readFile(stateFile, 'utf8');
  const active = JSON.stringify({
    ...(await t.state()),
    active: { role: 'review', prefix: join(t.config.runDir, 'review-2') },
  });
  await writeFile(stateFile, active);
  const interrupted = t.execute();
  expect(interrupted.status).toBe(1);
  expect(interrupted.stderr).toContain('Interrupted execution');
  expect(await readFile(stateFile, 'utf8')).toBe(active);

  await writeFile(stateFile, saved);
  const lock = join(t.config.runDir, 'lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner'), 'existing execution');
  const locked = t.execute();
  expect(locked.status).toBe(1);
  expect(locked.stderr).toContain('EEXIST');
  expect(await readFile(join(lock, 'owner'), 'utf8')).toBe('existing execution');
  expect(await readFile(stateFile, 'utf8')).toBe(saved);
});

test('review limit prevents a third-party evaluator from being called again', async () => {
  const t = await trial('docs', { repairLimit: null, reviewLimit: 1, modelTimeMs: null });
  t.execute();
  const state = await t.state();
  expect(state.result).toBe('execution_limit');
  expect(state.review).toBe(1);
  expect(state.repair).toBe(2);
  expect(state.checks).toBe(3);
  expect(await Bun.file(join(t.config.runDir, 'review-2.target.json')).exists()).toBe(false);
  expect(await Bun.file(join(t.config.runDir, 'review-2.prompt')).exists()).toBe(false);
});

for (const [target, path, content] of [
  ['documentation', 'work/README.md', 'new documentation'],
  ['Issue', 'helper.js', "console.log('Updated requirements');"],
] as const) {
  test(`terminal success is not reused for changed ${target}`, async () => {
    const t = await trial('normal');
    expect(t.execute().status).toBe(0);
    const before = await t.state();
    await writeFile(join(t.root, path), content);
    const result = t.execute();
    expect(result.status).toBe(1);
    expect(object(JSON.parse(result.stdout)).result).toBe('target_changed_after_stop');
    expect(await t.state()).toEqual(before);
  });
}

for (const [name, change, reason] of [
  ['missing cwd', { cwd: undefined }, 'Invalid cwd'],
  [
    'report without base',
    { reports: [{ path: 'research/reset.md', blob: 'a'.repeat(40) }] },
    'Required reports need baseCommit',
  ],
  [
    'ambiguous report versions',
    {
      baseCommit: 'a'.repeat(40),
      reports: [
        { path: 'research/reset.md', blob: 'a'.repeat(40) },
        { path: 'research/reset.md', blob: 'b'.repeat(40) },
      ],
    },
    'Duplicate required report',
  ],
] as const) {
  test(`invalid config: ${name}`, () => {
    expect(() => assertConfig({ ...correctionConfig('/correction-config'), ...change })).toThrow(
      reason,
    );
  });
}

test('correction command arrays preserve executable whitespace and every argument', () => {
  const base = correctionConfig('/correction-config');
  for (const key of ['issue', 'check', 'repair', 'review', 'capture']) {
    for (const command of [null, 'tool', [], [''], [1], ['tool', 1]]) {
      expect(() => assertConfig({ ...base, [key]: command })).toThrow(`Invalid ${key} command`);
    }
    if (key !== 'capture') {
      expect(() => assertConfig({ ...base, [key]: undefined })).toThrow(`Invalid ${key} command`);
    }
    for (const executable of ['tool', ' tool ', ' \t\n']) {
      const config = { ...base, [key]: [executable, '', ' \t ', 'last', 'first'] };
      const original = structuredClone(config);
      expect(() => assertConfig(config)).not.toThrow();
      expect(config).toEqual(original);
    }
  }
});

test('correction capture remains optional unless required and needs explicit metadata', () => {
  const config = correctionConfig('/correction-config');
  expect(() => assertConfig(config)).not.toThrow();
  expect(() => assertConfig({ ...config, captureRequired: true })).toThrow(
    'Required capture command missing',
  );
  const capture = { ...config, capture: ['tool'], captureRequired: true };
  expect(() => assertConfig(capture)).not.toThrow();
  expect(() => assertConfig({ ...capture, captureDestination: undefined })).toThrow(
    'Invalid capture destination',
  );
  expect(() => assertConfig({ ...capture, captureRequired: undefined })).toThrow(
    'Explicit capture requirement required',
  );
});

test('CLI rejects invalid config before commands or evidence writes', async () => {
  const t = await trial('normal');
  const executed = join(t.root, 'unexpected-execution');
  await writeFile(
    join(t.root, 'helper.js'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(executed)}, 'executed');`,
  );
  await writeFile(t.configFile, JSON.stringify({ ...t.config, repair: [] }));
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Invalid repair command');
  expect(existsSync(executed)).toBe(false);
  expect(existsSync(t.config.runDir)).toBe(false);
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
});

test('attempt limits require explicit null or positive integers', () => {
  const config = correctionConfig('/correction-config');
  for (const key of ['repairLimit', 'reviewLimit']) {
    for (const limit of [null, 1, 3]) {
      expect(() => assertConfig({ ...config, [key]: limit })).not.toThrow();
    }
    for (const limit of [undefined, 0, -1, 1.5, NaN, Infinity, '2', 'unlimited', false, {}, []]) {
      expect(() => assertConfig({ ...config, [key]: limit })).toThrow(`Invalid ${key}`);
    }
  }
  expect(() => assertConfig({ ...config, repairLimit: null, reviewLimit: null })).not.toThrow();
});

test('model time requires explicit null or a positive finite number; check time stays finite', () => {
  const config = correctionConfig('/correction-config');
  for (const modelTimeMs of [undefined, 0, -1, NaN, Infinity, 'unlimited', '1200000', false]) {
    expect(() => assertConfig({ ...config, modelTimeMs })).toThrow('Invalid modelTimeMs');
  }
  expect(() => assertConfig({ ...config, modelTimeMs: null })).not.toThrow();
  expect(() => assertConfig({ ...config, modelTimeMs: 1200000 })).not.toThrow();
  for (const checkTimeMs of [null, undefined, 0, -1, NaN, Infinity]) {
    expect(() => assertConfig({ ...config, checkTimeMs })).toThrow('Invalid checkTimeMs');
  }
});
test('invalid saved state is retained and rejected before execution', async () => {
  const t = await trial('docs');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  expect(t.execute().status).toBe(0);
  const stateFile = join(t.config.runDir, 'state.json');
  const saved = await t.state();
  const review = object(events(saved.reviewHistory)[0]);
  const item = object(events(review.items)[0]);
  expect(saved.reviewFormat).toBe(4);
  expect(() => assertState(saved)).not.toThrow();
  expect(() => assertState({ ...saved, reviewHistory: [] })).not.toThrow();
  for (const [change, reason] of [
    [{ reviewFormat: 3 }, 'Historical review format cannot be converted or resumed'],
    ...[null, 0, 5, '4'].map(
      (reviewFormat) => [{ reviewFormat }, 'Invalid review format'] as const,
    ),
    ...[undefined, '', 42].map(
      (baseCommit) => [{ baseCommit }, 'Invalid saved base commit'] as const,
    ),
    ...[undefined, null].map(
      (reviewHistory) => [{ reviewHistory }, 'Invalid saved review history'] as const,
    ),
    [{ repair: -1 }, 'Invalid saved usage'],
    [{ active: { role: 'repair' } }, 'Invalid active reservation'],
    [{ events: [{}] }, 'Invalid saved events'],
    [{ result: 'unrecognized_success' }, 'Invalid saved result'],
    [{ captureSource: 42 }, 'Invalid saved capture source'],
    [
      { reviewHistory: [{ ...review, status: 'unrecognized_success' }] },
      'Invalid saved review history',
    ],
    ...[
      { id: undefined },
      { id: ' ' },
      { introducedIn: undefined },
      { introducedIn: ' ' },
      { disposition: undefined },
      { disposition: 'accepted' },
      { condition: undefined },
      { location: { path: null, line: 1 } },
      { unexpected: true },
    ].map(
      (change) =>
        [
          { reviewHistory: [{ ...review, items: [{ ...item, ...change }] }] },
          'Invalid saved review history',
        ] as const,
    ),
  ] as const) {
    expect(() => assertState({ ...saved, ...change })).toThrow(reason);
  }
  const executed = join(t.root, 'unexpected-execution');
  await writeFile(
    join(t.root, 'helper.js'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(executed)}, 'executed');`,
  );
  const invalid = JSON.stringify({ ...saved, baseCommit: undefined });
  await writeFile(stateFile, invalid);
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Invalid saved base commit');
  expect(await readFile(stateFile, 'utf8')).toBe(invalid);
  expect(await Bun.file(executed).exists()).toBe(false);
});
test('missing CLI configuration argument fails with usage', () => {
  const result = spawnSync(process.execPath, [controller], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Usage:');
});

for (const path of ['.', 'evidence', '..evidence', '../..external']) {
  test(`evidence directory boundary: ${path}`, async () => {
    const t = await trial('boundary');
    const runDir = resolve(t.config.cwd, path);
    await writeFile(t.configFile, JSON.stringify({ ...t.config, runDir }));
    const result = t.execute();
    if (path === '../..external') {
      expect(result.status).toBe(0);
    } else {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Evidence must be outside the worktree');
      expect(await Bun.file(join(runDir, 'state.json')).exists()).toBe(false);
      expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
    }
  });
}

test('evidence directory boundary: symlink resolving into the worktree', async () => {
  const t = await trial('boundary');
  const inside = join(t.config.cwd, 'inside');
  await mkdir(inside);
  const runDir = join(t.root, 'linked-evidence');
  await symlink(inside, runDir);
  await writeFile(t.configFile, JSON.stringify({ ...t.config, runDir }));
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Evidence must not resolve inside the worktree');
  expect(await Bun.file(join(inside, 'state.json')).exists()).toBe(false);
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
});

// Response boundaries run without another repository or actor process per malformed value.
test('repair reply contract rejects malformed values and preserves diagnostic findings', () => {
  for (const stdout of [
    'not JSON',
    'null',
    '[]',
    '{}',
    '{"status":1,"findings":"detail"}',
    '{"status":"repaired"}',
    '{"status":"repaired","findings":1}',
  ]) {
    expect(parseRepairReply(stdout)).toEqual({ status: 'invalid' });
  }
  expect(parseRepairReply('{"status":"accepted","findings":"detail"}')).toEqual({
    status: 'invalid',
    findings: 'detail',
  });
  for (const findings of ['', ' \t\r\n\u3000']) {
    expect(parseRepairReply(JSON.stringify({ status: 'needs_human', findings }))).toEqual({
      status: 'invalid',
      findings,
    });
  }
  for (const findings of ['', ' \t\n', 'Implemented agreed change']) {
    expect(parseRepairReply(JSON.stringify({ status: 'repaired', findings, extra: true }))).toEqual(
      {
        status: 'repaired',
        findings,
      },
    );
  }
  const findings = ' \n問い: 対象範囲を広げますか。追加機能を含める場合は検証範囲も増えます。\n ';
  expect(parseRepairReply(JSON.stringify({ status: 'needs_human', findings }))).toEqual({
    status: 'needs_human',
    findings,
  });
});
