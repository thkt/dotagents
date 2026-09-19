import { test, expect, afterEach } from 'bun:test';
import { mkdir, symlink, writeFile, readFile, rm, rename, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  correctionConfig,
  correctionFixture,
  controller,
  object,
  events,
} from './support/correction.ts';
import { parseRepairReply, repairInstructions } from '../repair.ts';
import { assertConfig } from '../input.ts';
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
    // Transport only; instruction meaning is assessed by independent review.
    expect(prompt).toContain(repairInstructions(null));
    for (const instruction of [
      'Repair only within these agreed requirements',
      'Run only targeted checks needed to diagnose or validate your repair',
      'Do not commit, push or publish',
      'Leave configured full verification to the host after your changes',
      'do not launch browsers or servers in your sandbox',
      'Requirements:\nAgreed requirement: correct source and docs',
      'Failure evidence:',
    ]) {
      expect(prompt).toContain(instruction);
    }
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
  for (const change of [{ repairLimit: 10 }, { modelTimeMs: null }]) {
    await writeFile(t.configFile, JSON.stringify({ ...t.config, ...change }));
    const result = t.execute();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('configuration changed');
    expect(await readFile(stateFile, 'utf8')).toBe(before);
  }
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
  const t = await trial('docs', { reviewLimit: 1, modelTimeMs: null });
  t.execute();
  const state = await t.state();
  expect(state.result).toBe('execution_limit');
  expect(state.review).toBe(1);
  expect(state.repair).toBe(2);
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
  ['empty command', { repair: [] }, 'Invalid repair command'],
  ['invalid limit', { reviewLimit: -1 }, 'Invalid reviewLimit'],
  ['missing model time', { modelTimeMs: undefined }, 'Invalid modelTimeMs'],
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
  test(`invalid config: ${name}`, async () => {
    const t = await trial('normal');
    await writeFile(t.configFile, JSON.stringify({ ...t.config, ...change }));
    const result = t.execute();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(await Bun.file(join(t.config.runDir, 'check-1.stdout')).exists()).toBe(false);
    expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
  });
}

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
  for (const [change, reason] of [
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
      { unexpected: true },
    ].map(
      (change) =>
        [
          { reviewHistory: [{ ...review, items: [{ ...item, ...change }] }] },
          'Invalid saved review history',
        ] as const,
    ),
  ] as const) {
    const invalid = JSON.stringify({ ...saved, ...change });
    await writeFile(stateFile, invalid);
    const result = t.execute();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(await readFile(stateFile, 'utf8')).toBe(invalid);
  }
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

test('retired writing input is rejected before execution and preserves prior evidence', async () => {
  const t = await trial('normal');
  await mkdir(t.config.runDir);
  const prior = '{"result":"writing_failed","active":{"role":"writing"}}';
  const stateFile = join(t.config.runDir, 'state.json');
  await writeFile(stateFile, prior);
  for (const writing of [[process.execPath, 'old-writing.js'], null]) {
    await writeFile(t.configFile, JSON.stringify({ ...t.config, writing }));
    const result = t.execute();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'writing is no longer supported; remove writing from correction input',
    );
    expect(await readFile(stateFile, 'utf8')).toBe(prior);
    expect(await Bun.file(join(t.config.runDir, 'check-1.stdout')).exists()).toBe(false);
    expect(await Bun.file(join(t.config.runDir, 'repair-1.stdout')).exists()).toBe(false);
    expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
  }
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
