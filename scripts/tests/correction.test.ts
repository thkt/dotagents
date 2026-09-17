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

for (const [mode, result, repairs, reviews] of [
  ['normal', 'ready_for_human_review', 1, 1],
  ['null_repair', 'invalid_repair', 1, 0],
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
for (const change of [
  { repair: -1 },
  { active: { role: 'repair' } },
  { events: [{}] },
  { result: 'unrecognized_success' },
  { captureSource: 42 },
]) {
  test(`invalid saved state is retained and rejected: ${JSON.stringify(change)}`, async () => {
    const t = await trial('normal');
    expect(t.execute().status).toBe(0);
    const stateFile = join(t.config.runDir, 'state.json');
    const invalid = JSON.stringify({ ...(await t.state()), ...change });
    await writeFile(stateFile, invalid);
    const result = t.execute();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid');
    expect(await readFile(stateFile, 'utf8')).toBe(invalid);
  });
}
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
