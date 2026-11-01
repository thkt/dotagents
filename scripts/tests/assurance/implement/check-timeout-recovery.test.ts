import assert from 'node:assert/strict';
import { expect, spyOn } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { develop } from '../../../implement/orchestrator.ts';
import * as processModule from '../../../shared/process.ts';
import { events, object } from '../../support/correction.ts';
import { gitOutput, issue } from '../../support/development.ts';
import {
  recoveryFixture,
  recoveryCli,
  records,
  recordPaths,
  testReviewRecovery as testDevelopment,
} from '../../support/review-recovery.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(f: Parameters<Parameters<typeof testDevelopment>[1]>[0], localOnly = true) {
  // 旧runの準備だけは現在版の予算assertを経由せず、旧契約で実行する。
  f.io.verify = (config, head) => f.verify(config, head);
  const t = await recoveryFixture(f, localOnly, 'timeout');
  t.dir = join(dirname(f.dir), 'timeout-return');
  // 引数名は接続上の仮選択。別名なら独立テスト工程で接続だけを更新する。
  t.args = [
    '99',
    '--repo',
    t.cwd,
    '--check-timeout-run',
    f.dir,
    '--run-dir',
    t.dir,
    '--no-publish',
  ];
  if (!localOnly) {
    t.args.pop();
  }
  expect(t.state).toMatchObject({
    result: 'check_unavailable',
    checks: 1,
    review: 0,
    repair: 0,
    active: null,
  });
  expect(events(t.state.events).filter((event) => object(event).role === 'check')).toEqual([
    expect.objectContaining({ code: null, timedOut: true, ms: 540000 }),
  ]);
  return t;
}

async function modes(dir: string) {
  const result: Record<string, number> = {};
  for (const path of await recordPaths(dir)) {
    result[path] = (await stat(path)).mode;
  }
  return result;
}

async function patch(path: string, values: Record<string, unknown>) {
  await writeFile(
    path,
    JSON.stringify({ ...object(JSON.parse(await readFile(path, 'utf8'))), ...values }),
  );
}

function validEntry(stderr: string) {
  expect(stderr).not.toMatch(
    /Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError|TypeError|ReferenceError/,
  );
}

for (const response of ['accepted', 'invalid', 'needs_changes', 'check_repair'] as const) {
  testDevelopment(
    `初回check時間切れから新しい検証へ進み旧証拠を保全する: ${response}`,
    async (f) => {
      const t = await fixture(f);
      const original = await records(f.dir);
      const originalModes = await modes(f.dir);
      const head = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
      const branch = await gitOutput(t.cwd, 'branch', '--show-current');
      const content = await readFile(join(t.cwd, 'result.test.js'));
      const mode = (await stat(join(t.cwd, 'result.test.js'))).mode;
      const oldConfig = object(
        JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
      );
      await writeFile(
        t.control,
        JSON.stringify({
          response,
          expectedBudget: null,
          traceSetup: true,
          failCheck: response === 'check_repair',
        }),
      );
      const before = await readFile(t.executions, 'utf8');
      const returned = await recoveryCli(f, t, {}, { observe: true });
      expect(returned.timedOut).toBe(false);
      validEntry(returned.stderr);
      expect(returned.code).toBe(response === 'invalid' ? 1 : 0);
      const roles = (await readFile(t.executions, 'utf8'))
        .slice(before.length)
        .split('\n')
        .filter((role) => role && !role.startsWith('observe-'));
      expect(roles.slice(0, 2)).toEqual(['setup', 'check']);
      expect(roles).not.toContain('implementation');
      const config = object(
        JSON.parse(await readFile(join(t.dir, 'verification-config.json'), 'utf8')),
      );
      expect(config.checkTimeMs).toBeNull();
      for (const key of [
        'cwd',
        'baseCommit',
        'targetText',
        'check',
        'setup',
        'capture',
        'captureRequired',
        'captureDestination',
      ]) {
        expect(config[key]).toEqual(oldConfig[key]);
      }
      const state = object(
        JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
      );
      expect(state.result).toBe(
        response === 'invalid' ? 'invalid_review' : 'ready_for_human_review',
      );
      expect(state.checks).toBe(
        response === 'needs_changes' || response === 'check_repair' ? 2 : 1,
      );
      expect(state.review).toBe(response === 'needs_changes' ? 2 : 1);
      expect(state.repair).toBe(
        response === 'needs_changes' || response === 'check_repair' ? 1 : 0,
      );
      expect(events(state.reviewHistory)).toHaveLength(
        response === 'invalid' ? 0 : response === 'needs_changes' ? 2 : 1,
      );
      const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
      expect(saved).toMatchObject({
        publication: 'not_attempted',
        status: response === 'invalid' ? 'stopped' : 'verified_local',
      });
      expect(await records(f.dir)).toEqual(original);
      expect(await modes(f.dir)).toEqual(originalModes);
      expect(await readFile(join(t.cwd, 'result.test.js'))).toEqual(content);
      expect((await stat(join(t.cwd, 'result.test.js'))).mode).toBe(mode);
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD')).toBe(head);
      expect(await gitOutput(t.cwd, 'branch', '--show-current')).toBe(branch);
      expect(f.calls.implementations).toBe(1);
      expect(f.calls.pushes).toBe(0);
      expect(f.calls.publications).toBe(0);
      const text = (
        await Promise.all(
          (await recordPaths(t.dir))
            .filter((path) => path.endsWith('.json'))
            .map((path) => readFile(path, 'utf8')),
        )
      ).join('\n');
      expect(text).toContain(f.dir);
      expect(text).toContain(
        original[join(f.dir, 'verification/check-1.stdout')] ?? 'missing-check-log',
      );
    },
  );
}

for (const field of ['source', 'prefix'] as const) {
  testDevelopment(`初回checkイベントの不一致だけで復帰を拒否する: ${field}`, async (f) => {
    const t = await fixture(f, false);
    const check = object(events(t.state.events).find((event) => object(event).role === 'check'));
    const prefix = join(f.dir, 'verification/check-alternate');
    if (field === 'prefix') {
      // 参照先のログも揃え、ログ欠落による拒否と区別する。
      for (const extension of ['stdout', 'stderr']) {
        await writeFile(
          `${prefix}.${extension}`,
          await readFile(join(f.dir, `verification/check-1.${extension}`)),
        );
      }
    }
    const value = field === 'source' ? '0'.repeat(64) : prefix;
    expect(check[field]).not.toBe(value);
    await patch(join(f.dir, 'verification/state.json'), {
      events: events(t.state.events).map((event) =>
        object(event).role === 'check' ? { ...object(event), [field]: value } : event,
      ),
    });
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const before = await readFile(t.executions, 'utf8');
    await writeFile(t.control, JSON.stringify({ response: 'accepted', traceSetup: true }));
    const returned = await recoveryCli(f, t, {}, { observe: true, publication: true });
    expect(returned.timedOut).toBe(false);
    validEntry(returned.stderr);
    expect(returned.stderr).toContain('初回check時間切れの実行記録が一致しません');
    expect(returned.code).toBe(1);
    const roles = (await readFile(t.executions, 'utf8'))
      .slice(before.length)
      .split('\n')
      .filter((role) => role && !role.startsWith('observe-'));
    expect(roles).toEqual([]);
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
  });
}

for (const change of [
  'spawn',
  'failed',
  'review',
  'repair',
  'history',
  'active',
  'lock',
  'published',
  'unknown_publication',
  'missing_log',
  'test_response',
  'test_baseline',
  'source',
  'test_content',
  'test_mode',
  'setting',
  'head',
  'branch',
  'issue',
  'actor',
  'remote_present',
  'closed_pr',
  'remote_failed',
  'github_failed',
  'live',
  'process_failed',
  'process_empty',
  'budget',
  'review_entry',
  'interrupted_entry',
  'missing_state',
  'missing_result',
  'missing_config',
  'nonterminal',
  'check_count',
  'missing_records',
  'base',
  'checkout',
  'repository',
  'expanded_authority',
  'different_parent',
] as const) {
  testDevelopment(`初回check時間切れの条件不一致は後続を起動しない: ${change}`, async (f) => {
    const t = await fixture(f);
    const statePath = join(f.dir, 'verification/state.json');
    const resultPath = join(f.dir, 'result.json');
    const operations: Partial<Record<typeof change, () => Promise<unknown>>> = {
      base: async () => {
        const path = join(f.dir, 'verification-config.json');
        await patch(path, { baseCommit: await gitOutput(t.cwd, 'rev-parse', 'HEAD^') });
        await patch(statePath, { configHash: hash(await readFile(path, 'utf8')) });
      },
      checkout: async () => {
        const path = join(f.dir, 'verification-config.json');
        await patch(path, { cwd: f.repo });
        await patch(statePath, { configHash: hash(await readFile(path, 'utf8')) });
      },
      expanded_authority: async () => {
        t.args.pop();
      },
      different_parent: async () => {
        t.dir = join(dirname(f.dir), 'another-parent', 'new-run');
        await mkdir(dirname(t.dir));
        t.args[t.args.indexOf('--run-dir') + 1] = t.dir;
      },
      missing_state: () => rm(statePath),
      missing_result: () => rm(resultPath),
      missing_config: () => rm(join(f.dir, 'verification-config.json')),
      missing_records: () => rm(join(f.dir, 'test-records.json')),
      nonterminal: () => patch(resultPath, { terminal: false }),
      check_count: () => patch(statePath, { checks: 2 }),
      spawn: () =>
        patch(statePath, {
          events: events(t.state.events).map((event) =>
            object(event).role === 'check' ? { ...object(event), timedOut: false } : event,
          ),
        }),
      failed: () =>
        patch(statePath, {
          events: events(t.state.events).map((event) =>
            object(event).role === 'check' ? { ...object(event), timedOut: false, code: 1 } : event,
          ),
        }),
      review: () => patch(statePath, { review: 1 }),
      repair: () => patch(statePath, { repair: 1 }),
      history: () => patch(statePath, { reviewHistory: f.history }),
      active: () =>
        patch(statePath, {
          active: { role: 'check', prefix: join(f.dir, 'verification/check-1') },
        }),
      lock: () => mkdir(join(f.dir, 'verification/lock')),
      published: () => patch(resultPath, { publication: 'published' }),
      unknown_publication: () => patch(resultPath, { publication: 'unknown' }),
      missing_log: () => rm(join(f.dir, 'verification/check-1.stdout')),
      test_response: () => writeFile(join(f.dir, 'test-1.stdout'), '{}'),
      test_baseline: () => rm(join(f.dir, 'test-baseline.json')),
      source: () => writeFile(join(t.cwd, 'result.txt'), 'changed'),
      test_content: () => writeFile(join(t.cwd, 'result.test.js'), 'process.exit(0);'),
      test_mode: () => chmod(join(t.cwd, 'result.test.js'), 0o644),
      setting: () => writeFile(join(t.cwd, '.dotagents.json'), JSON.stringify(f.settings) + '\n'),
      head: () => gitOutput(t.cwd, 'commit', '--allow-empty', '-m', 'different HEAD'),
      branch: () => gitOutput(t.cwd, 'branch', '-m', 'different-branch'),
      budget: async () => {
        const path = join(f.dir, 'verification-config.json');
        await patch(path, { checkTimeMs: 540001 });
        await patch(statePath, { configHash: hash(await readFile(path, 'utf8')) });
      },
    };
    await operations[change]?.();
    if (change === 'review_entry' || change === 'interrupted_entry') {
      t.args[t.args.indexOf('--check-timeout-run')] =
        change === 'review_entry' ? '--review-run' : '--interrupted-run';
    }
    await writeFile(t.control, JSON.stringify({ response: 'accepted', observation: change }));
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const before = await readFile(t.executions, 'utf8');
    const replies: Record<string, string> = {};
    if (change === 'issue') {
      replies.issue = issue.replace('Show the requested result.', 'Changed requirement.');
    }
    if (change === 'repository') {
      const key = `repos/${f.settings.repository}`;
      const response = await f.github(['gh', 'api', key], t.cwd, null);
      replies[key] = response.stdout.replace('"id":123', '"id":456');
    }
    if (change === 'actor') {
      replies.user = JSON.stringify({ login: 'different-actor' });
    }
    const result = await recoveryCli(f, t, replies, { observe: true });
    expect(result.timedOut).toBe(false);
    validEntry(result.stderr);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).not.toBe('');
    const roles = (await readFile(t.executions, 'utf8'))
      .slice(before.length)
      .split('\n')
      .filter((role) => role && !role.startsWith('observe-'));
    expect(roles).toEqual([]);
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
  });
}

for (const period of ['during_old_run', 'after_stop'] as const) {
  testDevelopment(`初回check復帰CLIが同じcheckの開始時刻を照合する: ${period}`, async (f) => {
    const t = await fixture(f);
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const saved = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
    assert(typeof saved.startedAt === 'string' && typeof saved.finishedAt === 'string');
    if (period === 'after_stop') {
      // ps start times are whole seconds and cannot be in the future, so wait for the second after finishedAt.
      const nextSecond = Math.floor(Date.parse(saved.finishedAt) / 1000) * 1000 + 1000;
      await Bun.sleep(Math.max(0, nextSecond - Date.now()) + 10);
    }
    const processStartedAt = new Date(
      period === 'during_old_run' ? saved.startedAt : Date.now(),
    ).toISOString();
    const check = t.actors.check;
    assert(Array.isArray(check) && check.every((part) => typeof part === 'string'));
    await writeFile(
      t.control,
      JSON.stringify({
        response: 'accepted',
        processStartedAt,
        processCommand: check.join(' '),
        traceSetup: true,
      }),
    );
    const before = await readFile(t.executions, 'utf8');
    const returned = await recoveryCli(f, t, {}, { observe: true });
    expect(returned.timedOut).toBe(false);
    validEntry(returned.stderr);
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
    const roles = (await readFile(t.executions, 'utf8'))
      .slice(before.length)
      .split('\n')
      .filter((role) => role && !role.startsWith('observe-'));
    if (period === 'during_old_run') {
      expect(returned.code).toBe(1);
      expect(returned.stderr).toMatch(/プロセス|process/i);
      expect(roles).toEqual([]);
      expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    } else {
      expect(returned.code).toBe(0);
      expect(roles.slice(0, 2)).toEqual(['setup', 'check']);
      expect(roles).toContain('review');
      expect(roles).not.toContain('implementation');
      expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
        status: 'verified_local',
        publication: 'not_attempted',
      });
    }
  });
}

for (const phase of ['changeCheck', 'change'] as const) {
  testDevelopment(`初回check復帰中の旧ログ変化を検出する: ${phase}`, async (f) => {
    const t = await fixture(f);
    const path = join(f.dir, 'verification/check-1.stdout');
    const original = await records(f.dir);
    const content = (await readFile(path, 'utf8')) + '\nchanged';
    await writeFile(
      t.control,
      JSON.stringify({ response: 'accepted', [phase]: { path, content } }),
    );
    const returned = await recoveryCli(f, t, {}, { observe: true });
    validEntry(returned.stderr);
    expect(returned.code).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(content);
    const state = object(
      JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
    );
    expect(state.result).not.toBe('ready_for_human_review');
    expect(events(state.reviewHistory)).toEqual([]);
    const remaining = await records(f.dir);
    delete remaining[path];
    delete original[path];
    expect(remaining).toEqual(original);
    if (phase === 'changeCheck') {
      expect(await Bun.file(join(t.dir, 'verification/review-1.stdout')).exists()).toBe(false);
    }
  });
}

for (const capture of [false, true]) {
  testDevelopment(`通常check・撮影の上限なし設定が実行コマンドへ届く: ${capture}`, async (f) => {
    f.io.verify = (config, head) => f.verify(config, head);
    const captureCommand = [
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'desktop.png'), 'fixture media')",
    ];
    if (capture) {
      f.settings.capture = { command: captureCommand, destination: 'review/media', required: true };
    }
    const execute = f.observationCommand;
    const budgets: { role: string; budget: number | null }[] = [];
    const observer = spyOn(processModule, 'command').mockImplementation(async (...args) => {
      if (args[0][2] === 'check' || args[0][2] === captureCommand[2]) {
        budgets.push({ role: args[0][2] === 'check' ? 'check' : 'capture', budget: args[3] });
      }
      return execute(...args);
    });
    try {
      await recoveryFixture(f, true, 'invalid', 'initial', undefined, true);
      const config = object(
        JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
      );
      expect(config.checkTimeMs).toBeNull();
      const state = object(
        JSON.parse(await readFile(join(f.dir, 'verification/state.json'), 'utf8')),
      );
      expect(state.result).toBe('invalid_review');
      expect(
        events(state.events).filter(
          (event) =>
            ['check', 'capture'].includes(String(object(event).role)) && object(event).code === 0,
        ),
      ).toHaveLength(capture ? 2 : 1);
    } finally {
      observer.mockImplementation(execute);
    }
    expect(budgets).toEqual(
      capture
        ? [
            { role: 'capture', budget: null },
            { role: 'check', budget: null },
          ]
        : [{ role: 'check', budget: null }],
    );
  });
}

testDevelopment('新runの不完全な終了報告を成功にせず自動連鎖しない', async (f) => {
  const t = await fixture(f);
  const original = await records(f.dir);
  await writeFile(
    t.control,
    JSON.stringify({ response: 'accepted', timeoutCheck: true, expectedBudget: null }),
  );
  const before = await readFile(t.executions, 'utf8');
  const returned = await recoveryCli(f, t, {}, { observe: true });
  validEntry(returned.stderr);
  expect(returned.code).toBe(1);
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    result: 'check_unavailable',
    checks: 1,
    review: 0,
    repair: 0,
    active: null,
  });
  expect(events(state.events).filter((event) => object(event).role === 'check')).toEqual([
    expect.objectContaining({ timedOut: true, ms: 900000 }),
  ]);
  const roles = (await readFile(t.executions, 'utf8'))
    .slice(before.length)
    .split('\n')
    .filter((role) => role && !role.startsWith('observe-'));
  expect(roles).toEqual(['check']);
  expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
    terminal: true,
    status: 'stopped',
    publication: 'not_attempted',
  });
  expect(await records(f.dir)).toEqual(original);
});

for (const origin of ['initial', 'host_return'] as const) {
  for (const stop of ['invalid', 'interrupted'] as const) {
    for (const budget of [540000, 900000, 540001]) {
      testDevelopment(
        `既存復帰の正規予算だけを受理する: ${origin}/${stop}/${budget}`,
        async (f) => {
          f.io.verify = (config, head) => f.verify(config, head);
          const t = await recoveryFixture(f, true, stop, origin, budget);
          if (stop === 'interrupted') {
            t.args[t.args.indexOf('--review-run')] = '--interrupted-run';
          }
          const original = await records(f.dir);
          const before = await readFile(t.executions, 'utf8');
          const returned = await recoveryCli(f, t, {}, { observe: true });
          validEntry(returned.stderr);
          expect(returned.timedOut).toBe(false);
          expect(returned.code).toBe(budget === 540001 ? 1 : 0);
          expect(await records(f.dir)).toEqual(original);
          const roles = (await readFile(t.executions, 'utf8'))
            .slice(before.length)
            .split('\n')
            .filter((role) => role && !role.startsWith('observe-'));
          if (budget === 540001) {
            expect(roles).toEqual([]);
          } else {
            expect(roles).toEqual(['check', 'review']);
          }
        },
      );
    }
  }
}

testDevelopment('時間切れ復帰もcommit後の同じheadを模擬公開・CIへ渡す', async (f) => {
  const t = await fixture(f, false);
  const original = await records(f.dir);
  const head = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
  await writeFile(t.control, JSON.stringify({ response: 'accepted', expectedBudget: null }));
  const returned = await recoveryCli(f, t, {}, { observe: true, publication: true });
  validEntry(returned.stderr);
  expect(returned.code).toBe(0);
  const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
  expect(saved).toMatchObject({
    status: 'published_draft',
    publication: 'published',
    ci: 'passed',
  });
  const publicationHead = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
  expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD^')).toBe(head);
  expect(await gitOutput(t.cwd, 'status', '--porcelain')).toBe('');
  const pr = object(
    JSON.parse(await readFile(join(dirname(f.dir), 'recovery-published.json'), 'utf8')),
  );
  expect(pr.headRefOid).toBe(publicationHead);
  expect(await records(f.dir)).toEqual(original);
  expect(f.calls.implementations).toBe(1);
});

for (const change of ['none', 'content', 'mode'] as const) {
  testDevelopment(`時間切れ復帰の祖先証拠を現在hashへ置換しない: ${change}`, async (f) => {
    const t = await fixture(f);
    await writeFile(
      t.control,
      JSON.stringify({ response: 'accepted', timeoutCheck: true, expectedBudget: null }),
    );
    const first = await recoveryCli(f, t, {}, { observe: true });
    validEntry(first.stderr);
    expect(first.code).toBe(1);
    expect(
      object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8'))).result,
    ).toBe('check_unavailable');
    const prior = t.dir;
    t.dir = join(dirname(prior), 'timeout-second-return');
    t.args[t.args.indexOf('--check-timeout-run') + 1] = prior;
    t.args[t.args.indexOf('--run-dir') + 1] = t.dir;
    const path = join(f.dir, 'verification/check-1.stdout');
    if (change === 'content') {
      await writeFile(path, 'changed ancestor output');
    } else if (change === 'mode') {
      await chmod(path, 0o700);
    }
    const ancestor = await records(f.dir);
    const ancestorModes = await modes(f.dir);
    const immediate = await records(prior);
    const before = await readFile(t.executions, 'utf8');
    await writeFile(t.control, JSON.stringify({ response: 'accepted' }));
    const returned = await recoveryCli(f, t, {}, { observe: true });
    validEntry(returned.stderr);
    expect(returned.code).toBe(change === 'none' ? 0 : 1);
    const roles = (await readFile(t.executions, 'utf8'))
      .slice(before.length)
      .split('\n')
      .filter((role) => role && !role.startsWith('observe-'));
    expect(roles).toEqual(change === 'none' ? ['check', 'review'] : []);
    expect(await records(f.dir)).toEqual(ancestor);
    expect(await modes(f.dir)).toEqual(ancestorModes);
    expect(await records(prior)).toEqual(immediate);
  });
}

testDevelopment('復帰入口の全組合せを後続処理の起動前に拒否する', async (f) => {
  const entries = [
    'previous-run',
    'host-run',
    'review-run',
    'interrupted-run',
    'check-timeout-run',
  ];
  let commands = 0;
  f.io.command = async () => {
    commands++;
    throw Error('fixture: unexpected downstream command');
  };
  for (const [index, first] of entries.entries()) {
    for (const second of entries.slice(index + 1)) {
      const args = [
        '99',
        '--repo',
        f.repo,
        '--run-dir',
        f.dir,
        `--${first}`,
        join(dirname(f.dir), first),
        `--${second}`,
        join(dirname(f.dir), second),
      ];
      if (first === 'previous-run' || second === 'previous-run') {
        args.push('--request-file', join(dirname(f.dir), 'request.json'));
      }
      if (first === 'host-run' || second === 'host-run') {
        args.push('--host-evidence', join(dirname(f.dir), 'evidence.json'));
      }
      await assert.rejects(
        () => develop(args, f.io),
        /併用|混在|Host return requires a new --run-dir/,
      );
      expect(commands).toBe(0);
      expect(f.calls.implementations).toBe(0);
      expect(f.calls.verificationEntries).toBe(0);
      expect(f.calls.publications).toBe(0);
      expect(f.calls.pushes).toBe(0);
    }
  }
});
