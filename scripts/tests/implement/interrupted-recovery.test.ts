import { expect } from 'bun:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { object, events } from '../support/correction.ts';
import { snapshot } from '../../implement/correction.ts';
import {
  authorTests,
  readPreparedTestRecord,
  verifyTestArtifacts,
} from '../../implement/test-author.ts';
import { command } from '../../shared/process.ts';
import { saveActorRecord } from '../support/actor-records.ts';
import { verifySavedRuntime, verifyReviewedRuntime } from '../../implement/runtime-records.ts';
import { RecordObservation } from '../../implement/record-observation.ts';
import { gitOutput, issue } from '../support/development.ts';
import {
  recoveryFixture,
  recoveryCli,
  records,
  testReviewRecovery as testDevelopment,
} from '../support/review-recovery.ts';

// 入力の合意済みIssueを要求の正本とする。引数名だけは新入口を接続するための仮選択であり、
// 実装で別名を選んだ場合は独立テスト工程で機械的な接続だけを変更する。
async function fixture(
  f: Parameters<Parameters<typeof testDevelopment>[1]>[0],
  origin: 'initial' | 'host_return' = 'initial',
) {
  const t = await recoveryFixture(f, true, 'interrupted', origin);
  t.dir = join(dirname(f.dir), 'interrupted-return');
  t.args = ['99', '--repo', t.cwd, '--interrupted-run', f.dir, '--run-dir', t.dir, '--no-publish'];
  expect(await readFile(join(f.dir, 'verification/review-1.stdout'), 'utf8')).toBe('');
  expect(await Bun.file(join(f.dir, 'verification/lock')).exists()).toBe(false);
  const result = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
  expect(result).toMatchObject({
    terminal: true,
    phase: 'verification',
    publication: 'not_attempted',
  });
  return t;
}

async function modes(dir: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const name of await readdir(dir, { withFileTypes: true })) {
    if (name.name === 'checkout') {
      continue;
    }
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      Object.assign(result, await modes(path));
    } else {
      result[path] = (await stat(path)).mode;
    }
  }
  return result;
}

async function actorExecutions(path: string) {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((role) => !role.startsWith('observe-'))
    .join('\n');
}

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

for (const response of ['accepted', 'invalid', 'needs_changes', 'check_repair'] as const) {
  testDevelopment(`中断予約から公開CLIで新しいcheck・評価へ復帰する: ${response}`, async (f) => {
    const t = await fixture(f);
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const testContent = await readFile(join(t.cwd, 'result.test.js'));
    const testMode = (await stat(join(t.cwd, 'result.test.js'))).mode;
    const head = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
    const branch = await gitOutput(t.cwd, 'branch', '--show-current');
    const executed = await actorExecutions(t.executions);
    await writeFile(
      t.control,
      JSON.stringify({ response, failCheck: response === 'check_repair' }),
    );
    const outcome = await recoveryCli(f, t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(outcome.code).toBe(response === 'invalid' ? 1 : 0);
    const state = object(
      JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
    );
    expect(state.result).toBe(response === 'invalid' ? 'invalid_review' : 'ready_for_human_review');
    expect(events(state.reviewHistory)).toHaveLength(
      response === 'invalid' ? 0 : response === 'needs_changes' ? 2 : 1,
    );
    const roles = (await actorExecutions(t.executions)).slice(executed.length).trim().split('\n');
    expect(roles[0]).toBe('check');
    expect(roles.filter((role) => role === 'check')).toHaveLength(
      response === 'check_repair' || response === 'needs_changes' ? 2 : 1,
    );
    expect(roles.filter((role) => role === 'review')).toHaveLength(
      response === 'needs_changes' ? 2 : 1,
    );
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
    expect(await readFile(join(t.cwd, 'result.test.js'))).toEqual(testContent);
    expect((await stat(join(t.cwd, 'result.test.js'))).mode).toBe(testMode);
    expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD')).toBe(head);
    expect(await gitOutput(t.cwd, 'branch', '--show-current')).toBe(branch);
    const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
    expect(saved).toMatchObject({
      publication: 'not_attempted',
      status: response === 'invalid' ? 'stopped' : 'verified_local',
    });
    // 保存Schemaを固定せず、旧予約・履歴・計上済み時間を原stateまで辿れることを守る。
    const newRecords = await records(t.dir);
    const json = (
      await Promise.all(
        Object.keys(newRecords)
          .filter((path) => path.endsWith('.json'))
          .map((path) => readFile(path, 'utf8')),
      )
    ).join('\n');
    expect(json).toContain(f.dir);
    expect(json).toContain(original[join(f.dir, 'verification/state.json')] ?? 'missing-old-state');
    const raw = (
      await Promise.all(Object.keys(newRecords).map((path) => readFile(path, 'utf8')))
    ).join('\n');
    expect(raw).toContain('/usr/bin/unrelated-fixture');
    const observed = await readFile(t.executions, 'utf8');
    expect(observed).toContain('observe-process');
    expect(observed).toContain('observe-remote');
    expect(observed).toContain('observe-github');
    expect(json).toMatch(/unknown|unrecorded|不明|未記録/i);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.publications).toBe(0);
    expect(f.calls.pushes).toBe(0);
  });
}

// 正常な保存済み中断を使い、旧stateのactiveを消すことでfixtureを成立させない。
for (const explicit of [false, true]) {
  testDevelopment(`中断予約は既定入口と既存不正評価入口では復帰しない: ${explicit}`, async (f) => {
    const t = await fixture(f);
    const index = t.args.indexOf('--interrupted-run');
    if (explicit) {
      t.args[index] = '--review-run';
    } else {
      t.args.splice(index, 2);
    }
    const original = await records(f.dir);
    const executed = await actorExecutions(t.executions);
    const outcome = await recoveryCli(f, t);
    expect(outcome.code).toBe(1);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.stderr).toMatch(
      /unfinished|active|中断|初回invalid_review|照合|reconciliation|branch.*already exists/i,
    );
    expect(await records(f.dir)).toEqual(original);
    expect(await actorExecutions(t.executions)).toBe(executed);
  });
}

const reasons = {
  lock: /lock|active|稼働/i,
  published: /publish|公開/i,
  uncertain: /publish|公開|不明|unconfirmed/i,
  nonterminal: /terminal|終端|中断/i,
  history: /history|履歴|初回/i,
  repair: /repair|修正|初回/i,
  missing_response: /stdout|原応答|記録|ENOENT/i,
  test_content: /test|テスト|成果物/i,
  test_mode: /test|テスト|mode|モード|成果物/i,
  issue: /Issue|要求/i,
  actor: /actor|主体/i,
  repository: /repository|対象|リポジトリ/i,
  authority: /authority|権限|公開/i,
  setting: /config|設定/i,
  head: /HEAD|対象/i,
  branch: /branch|対象/i,
  other_active: /unfinished|active|未完了|中断|reconciliation/i,
  outside_parent: /sibling|兄弟|親/i,
};

for (const defect of [
  'lock',
  'published',
  'uncertain',
  'nonterminal',
  'history',
  'repair',
  'missing_response',
  'test_content',
  'test_mode',
  'issue',
  'actor',
  'repository',
  'authority',
  'setting',
  'head',
  'branch',
  'other_active',
  'outside_parent',
] as const) {
  testDevelopment(`中断復帰の不一致で起動と公開を抑止する: ${defect}`, async (f) => {
    const t = await fixture(f);
    const patch = async (name: string, values: Record<string, unknown>) => {
      const path = join(f.dir, name);
      await writeFile(
        path,
        JSON.stringify({ ...object(JSON.parse(await readFile(path, 'utf8'))), ...values }),
      );
    };
    const operations: Partial<Record<typeof defect, () => Promise<unknown>>> = {
      lock: () => mkdir(join(f.dir, 'verification/lock')),
      published: () => patch('result.json', { publication: 'published' }),
      uncertain: () => patch('result.json', { publication: 'unconfirmed' }),
      nonterminal: () => patch('result.json', { terminal: false }),
      history: () => patch('verification/state.json', { reviewHistory: f.history }),
      repair: () => patch('verification/state.json', { repair: 1 }),
      missing_response: () => rm(join(f.dir, 'verification/review-1.stdout')),
      test_content: () => writeFile(join(t.cwd, 'result.test.js'), 'process.exit(0);'),
      test_mode: () => chmod(join(t.cwd, 'result.test.js'), 0o644),
      authority: async () => {
        t.args.pop();
      },
      setting: () => writeFile(join(t.cwd, '.dotagents.json'), JSON.stringify(f.settings) + '\n'),
      head: () => gitOutput(t.cwd, 'commit', '--allow-empty', '-m', '別HEAD'),
      branch: () => gitOutput(t.cwd, 'branch', '-m', 'another-branch'),
      other_active: async () => {
        const dir = join(dirname(f.dir), 'another-run');
        await mkdir(join(dir, 'verification'), { recursive: true });
        await writeFile(join(dir, 'result.json'), await readFile(join(f.dir, 'result.json')));
        await writeFile(join(dir, 'verification/state.json'), await readFile(t.statePath));
      },
      outside_parent: async () => {
        const dir = join(dirname(f.dir), 'different-parent');
        await mkdir(dir);
        t.args[t.args.indexOf('--run-dir') + 1] = join(dir, 'return');
      },
    };
    await operations[defect]?.();
    const replies: Record<string, string> = {};
    if (defect === 'issue') {
      replies.issue = issue.replace('Show the requested result.', 'Changed requirement.');
    }
    if (defect === 'actor') {
      replies.user = JSON.stringify({ login: 'another-actor' });
    }
    if (defect === 'repository') {
      const key = `repos/${f.settings.repository}`;
      const reply = await f.github(['gh', 'api', key], t.cwd, null);
      replies[key] = reply.stdout.replace('"id":123', '"id":456');
    }
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const executed = await actorExecutions(t.executions);
    const outcome = await recoveryCli(f, t, replies);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(outcome.stderr).toMatch(reasons[defect]);
    expect(await actorExecutions(t.executions)).toBe(executed);
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  });
}

for (const boundary of ['check', 'review'] as const) {
  testDevelopment(`中断復帰中の原記録変更を${boundary}後に受け入れない`, async (f) => {
    const t = await fixture(f);
    const path = join(f.dir, 'verification/review-1.stdout');
    const content = 'changed during recovery';
    const original = await records(f.dir);
    await writeFile(
      t.control,
      JSON.stringify({
        response: 'accepted',
        [boundary === 'check' ? 'changeCheck' : 'change']: { path, content },
      }),
    );
    const outcome = await recoveryCli(f, t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(outcome.stderr).toMatch(/chang|hash|変更|変化|不一致/i);
    const state = object(
      JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
    );
    expect(state.result).not.toBe('ready_for_human_review');
    expect(events(state.reviewHistory)).toHaveLength(0);
    const retained = await records(f.dir);
    expect(retained[path]).toBe(hash(content));
    delete original[path];
    delete retained[path];
    expect(retained).toEqual(original);
    expect(f.calls.publications).toBe(0);
    expect(f.calls.pushes).toBe(0);
  });
}

// 拒否した新runも残し、毎回同じ親の未使用保存先を使う。兄弟runガードを
// 後片付けで迂回せず、前条件の残留は次の拒否理由と最後の正常復帰で検出する。
function recoveryDestination(t: Awaited<ReturnType<typeof fixture>>, name: string) {
  t.dir = join(dirname(t.dir), `interrupted-return-${name}`);
  t.args[t.args.indexOf('--run-dir') + 1] = t.dir;
}

async function recoveredControl(
  f: Parameters<typeof fixture>[0],
  t: Awaited<ReturnType<typeof fixture>>,
) {
  recoveryDestination(t, 'restored');
  await writeFile(t.control, JSON.stringify({ response: 'accepted' }));
  const executed = await actorExecutions(t.executions);
  const outcome = await recoveryCli(f, t);
  expect(outcome.timedOut).toBe(false);
  expect(outcome.code, outcome.stderr).toBe(0);
  expect(await actorExecutions(t.executions)).toBe(executed + 'check\nreview\n');
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state.result).toBe('ready_for_human_review');
  expect(events(state.reviewHistory)).toHaveLength(1);
  const result = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
  expect(result).toMatchObject({ status: 'verified_local', publication: 'not_attempted' });
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
}

testDevelopment('中断復帰の外部観測拒否を同じ予約で照合し正常復帰する', async (f) => {
  const t = await fixture(f);
  const original = await records(f.dir);
  const originalModes = await modes(f.dir);
  for (const observation of [
    'live',
    'process_failed',
    'process_incomplete',
    'process_partial',
    'process_unsupported',
    'process_ambiguous',
    'process_empty',
    'remote_present',
    'remote_failed',
    'github_failed',
    'closed_pr',
  ] as const) {
    recoveryDestination(t, observation);
    await writeFile(t.control, JSON.stringify({ response: 'accepted', observation }));
    const observed = await readFile(t.executions, 'utf8');
    const executed = await actorExecutions(t.executions);
    const outcome = await recoveryCli(f, t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr, observation).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(outcome.stderr, observation).toMatch(
      observation.startsWith('remote')
        ? /remote|ref|公開|リモート/i
        : observation === 'github_failed' || observation === 'closed_pr'
          ? /GitHub|gh|PR|pull|公開|取得|観測/i
          : /process|プロセス|稼働/i,
    );
    expect((await readFile(t.executions, 'utf8')).slice(observed.length), observation).toContain(
      observation.startsWith('remote')
        ? 'observe-remote'
        : observation === 'github_failed' || observation === 'closed_pr'
          ? 'observe-github'
          : 'observe-process',
    );
    expect(await actorExecutions(t.executions)).toBe(executed);
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  }
  await recoveredControl(f, t);
  expect(await records(f.dir)).toEqual(original);
  expect(await modes(f.dir)).toEqual(originalModes);
});

testDevelopment('中断復帰の必須原記録欠落を個別に照合し復元後に正常復帰する', async (f) => {
  const t = await fixture(f);
  const complete = await records(f.dir);
  const completeModes = await modes(f.dir);
  for (const missing of [
    'issue.json',
    'target.json',
    'verification-config.json',
    'test-records.json',
    'test-1.stdout',
    'test-1.target.json',
    'verification/review-1.target.json',
    'verification/review-1.prompt',
    'verification/state.json',
    'result.json',
  ]) {
    recoveryDestination(t, missing.replaceAll('/', '-'));
    const path = join(f.dir, missing);
    const content = await readFile(path);
    const mode = (await stat(path)).mode;
    await rm(path);
    const original = await records(f.dir);
    const executed = await actorExecutions(t.executions);
    try {
      const outcome = await recoveryCli(f, t);
      expect(outcome.code).toBe(1);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.stderr, missing).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
      );
      expect(outcome.stderr, missing).toMatch(/missing|record|ENOENT|原記録|記録|欠落|ありません/i);
      expect(await records(f.dir)).toEqual(original);
      expect(await actorExecutions(t.executions)).toBe(executed);
      const remainingModes = { ...completeModes };
      delete remainingModes[path];
      expect(await modes(f.dir)).toEqual(remainingModes);
      expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
      expect(f.calls.pushes).toBe(0);
      expect(f.calls.publications).toBe(0);
    } finally {
      // 隔離fixtureの故障注入だけを戻す。製品の復帰手順でstateを修復する意味ではない。
      await writeFile(path, content);
      await chmod(path, mode & 0o777);
    }
    expect(await records(f.dir)).toEqual(complete);
    expect(await modes(f.dir)).toEqual(completeModes);
  }
  await recoveredControl(f, t);
  expect(await records(f.dir)).toEqual(complete);
  expect(await modes(f.dir)).toEqual(completeModes);
});

testDevelopment('ホスト復帰で中断した初回評価の引継ぎと証拠を保持する', async (f) => {
  const t = await fixture(f, 'host_return');
  const original = await records(f.dir);
  const root = dirname(f.dir);
  const hostStop = await records(join(root, 'run'));
  const log = join(root, 'origin-host.stdout');
  const evidence = join(root, 'origin-host.json');
  const evidenceHash = hash(await readFile(evidence));
  const outcome = await recoveryCli(f, t);
  expect(outcome.timedOut).toBe(false);
  expect(outcome.stderr).not.toMatch(
    /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
  );
  expect(outcome.code).toBe(0);
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state.result).toBe('ready_for_human_review');
  expect(await records(f.dir)).toEqual(original);
  expect(await records(join(root, 'run'))).toEqual(hostStop);
  expect(hash(await readFile(evidence))).toBe(evidenceHash);
  const newRecords = await records(t.dir);
  const json = (
    await Promise.all(
      Object.keys(newRecords)
        .filter((path) => path.endsWith('.json'))
        .map((path) => readFile(path, 'utf8')),
    )
  ).join('\n');
  expect(json).toContain(evidence);
  expect(json).toContain(hash(await readFile(log)));
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
});

for (const current of [false, true]) {
  testDevelopment(
    `ホスト復帰後の修正には現在sourceに対応した追加証拠を要求する: ${current}`,
    async (f) => {
      const t = await fixture(f, 'host_return');
      const original = await records(f.dir);
      const root = dirname(f.dir);
      const oldSource = t.state.source;
      await writeFile(join(t.cwd, 'README.md'), 'ホスト観測後に更新した説明');
      const source = await snapshot(t.cwd);
      expect(source).not.toBe(oldSource);
      const log = join(root, 'current-host.stdout');
      await writeFile(log, 'fixture: current source inspected');
      const evidence = join(root, 'current-host.json');
      await writeFile(
        evidence,
        JSON.stringify({
          status: 'passed',
          source: current ? source : oldSource,
          findings: '説明更新後の対象を模擬観測。実サービスは未確認。',
          logs: [{ path: log, sha256: hash(await readFile(log)) }],
        }),
      );
      t.args.push('--host-evidence', evidence);
      const executed = await actorExecutions(t.executions);
      const outcome = await recoveryCli(f, t);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.stderr).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
      );
      expect(outcome.code).toBe(current ? 0 : 1);
      if (current) {
        const state = object(
          JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
        );
        expect(state.result).toBe('ready_for_human_review');
        expect(state.source).toBe(source);
        const target = object(
          JSON.parse(await readFile(join(t.dir, 'verification/review-1.target.json'), 'utf8')),
        );
        expect(target.source).toBe(source);
        expect(await actorExecutions(t.executions)).toBe(executed + 'check\nreview\n');
      } else {
        expect(outcome.stderr).toMatch(/source|成果物|対象|証拠/i);
        expect(await actorExecutions(t.executions)).toBe(executed);
      }
      expect(await records(f.dir)).toEqual(original);
      expect(f.calls.implementations).toBe(1);
      expect(f.calls.pushes).toBe(0);
      expect(f.calls.publications).toBe(0);
    },
  );
}

for (const limit of ['modelTimeMs', 'reviewLimit'] as const) {
  testDevelopment(`中断前の消費と不明量で有限上限を回避できない: ${limit}`, async (f) => {
    const t = await fixture(f);
    // 保存済み旧形式に存在する有限上限を、他の識別値と整合するfixtureとして与える。
    // 壁時計の閾値は測らない。中断分が不明なら有限上限の適否を認定できない（要求5）。
    const configPath = join(f.dir, 'verification-config.json');
    const config = object(JSON.parse(await readFile(configPath, 'utf8')));
    config.repairLimit = null;
    config.reviewLimit = null;
    config.modelTimeMs = limit === 'modelTimeMs' ? 1000000 : null;
    config.reviewLimit = limit === 'reviewLimit' ? 1 : null;
    await writeFile(configPath, JSON.stringify(config));
    const configHash = hash(JSON.stringify(config));
    const state = object(JSON.parse(await readFile(t.statePath, 'utf8')));
    state.configHash = configHash;
    await writeFile(t.statePath, JSON.stringify(state));
    const path = join(f.dir, 'verification/review-1.target.json');
    const target = object(JSON.parse(await readFile(path, 'utf8')));
    const { targetId: _targetId, ...payload } = target;
    payload.configHash = configHash;
    await writeFile(path, JSON.stringify({ ...payload, targetId: hash(JSON.stringify(payload)) }));
    const original = await records(f.dir);
    const executed = await actorExecutions(t.executions);
    const outcome = await recoveryCli(f, t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(outcome.stderr).toMatch(/limit|上限|不明|未記録/i);
    expect(await actorExecutions(t.executions)).toBe(executed);
    expect(await records(f.dir)).toEqual(original);
  });
}

// 要求6: 停止時のテストを手修正せず、別の独立工程が更新した同じ資産を記録付きで渡す。
// #373のhost-run境界テストは維持し、中断予約と現行記録の取込みの組合せだけを補う。
async function currentTestFixture(f: Parameters<typeof fixture>[0]) {
  const t = await fixture(f, 'host_return');
  const config = object(
    JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
  );
  assert(typeof config.testBaseline === 'string' && typeof config.baseCommit === 'string');
  const external = join(dirname(f.dir), 'current-independent-tests');
  await mkdir(external);
  const prefix = join(external, 'test-1');
  const source =
    "import {readFileSync} from 'node:fs'; const result=readFileSync('result.txt','utf8'); if(result!=='implemented')throw Error('要求した結果がありません');\n";
  const prepared = await authorTests(
    {
      cwd: t.cwd,
      baseline: config.testBaseline,
      prefix,
      issue,
      baseCommit: config.baseCommit,
      check: f.settings.check,
      setup: f.settings.setup,
      stage: 'host_return',
      actor: ['current-independent-test-fixture'],
      previous: [],
    },
    async (argv, cwd, prompt, timeout, output) => {
      if (argv[0] !== 'current-independent-test-fixture') {
        return command(argv, cwd, prompt, timeout, output);
      }
      const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
      await writeFile(join(cwd, 'result.test.js'), source, { mode: 0o700 });
      assert(output);
      const stdout = JSON.stringify({
        targetId: input.targetId,
        status: 'prepared',
        findings: '要求したresultの保持を現在の独立工程で確認する。',
        files: ['result.test.js'],
      });
      await writeFile(`${output}.stdout`, stdout);
      await writeFile(`${output}.stderr`, '');
      return { code: 0, stdout, stderr: '', timedOut: false, ms: 1 };
    },
  );
  assert(prepared.record);
  const recordPath = `${prefix}.json`;
  const ref = { path: recordPath, sha256: hash(await readFile(recordPath)) };
  const evidence = {
    status: 'passed',
    source: await snapshot(t.cwd),
    findings: '停止後の独立テスト更新を含む現在sourceの模擬観測。実サービスは未確認。',
    logs: [ref],
    testRecords: [ref],
  };
  const evidencePath = join(external, 'host-evidence.json');
  t.args.push('--host-evidence', evidencePath);
  return {
    t,
    source,
    prefix,
    external,
    recordPath,
    evidence,
    evidencePath,
    record: prepared.record,
  };
}

const originalTestReasons = {
  stdout: /テスト応答|stdout|response/i,
  'target.json': /テスト入力|入力.*変更|target|input/i,
  prompt: /テスト指示|指示.*変更|prompt/i,
};

// 要求2・6・7: 追加証拠が採用した外部記録も、工程中の内容変更を見逃さない。
// 原.jsonとモードは固定し、既存のモード検査・証拠.json検査で代用しない。
for (const suffix of ['stdout', 'target.json', 'prompt'] as const) {
  for (const boundary of ['check', 'review'] as const) {
    testDevelopment(
      `中断復帰は採用済み原${suffix}の内容変更を${boundary}後に拒否する`,
      async (f) => {
        const c = await currentTestFixture(f);
        await writeFile(c.evidencePath, JSON.stringify(c.evidence));
        await verifyTestArtifacts(c.t.cwd, [c.record]);
        const path = `${c.prefix}.${suffix}`;
        const content = await readFile(path, 'utf8');
        const mode = (await stat(path)).mode;
        const external = await records(c.external);
        const externalModes = await modes(c.external);
        const original = await records(f.dir);
        const originalModes = await modes(f.dir);
        const source = await snapshot(c.t.cwd);
        const executed = await actorExecutions(c.t.executions);
        await writeFile(
          c.t.control,
          JSON.stringify({
            response: 'accepted',
            [boundary === 'check' ? 'changeCheck' : 'change']: { path, content: content + '\n' },
          }),
        );
        const outcome = await recoveryCli(f, c.t);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.stderr).not.toMatch(/Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError/);
        const state = object(
          JSON.parse(await readFile(join(c.t.dir, 'verification/state.json'), 'utf8')),
        );
        expect(await actorExecutions(c.t.executions)).toBe(
          executed + (boundary === 'check' ? 'check\n' : 'check\nreview\n'),
        );
        expect(await readFile(path, 'utf8')).toBe(content + '\n');
        expect((await stat(path)).mode).toBe(mode);
        await assert.rejects(verifyTestArtifacts(c.t.cwd, [c.record]), originalTestReasons[suffix]);
        expect(outcome.code).toBe(1);
        expect(outcome.stderr + String(state.findings)).toMatch(originalTestReasons[suffix]);
        expect(state.result).not.toBe('ready_for_human_review');
        expect(state.reviewHistory).toEqual([]);
        expect(await Bun.file(join(c.t.dir, 'verification/review-1.json')).exists()).toBe(false);
        const retained = await records(c.external);
        delete external[path];
        delete retained[path];
        expect(retained).toEqual(external);
        expect(await modes(c.external)).toEqual(externalModes);
        expect(await records(f.dir)).toEqual(original);
        expect(await modes(f.dir)).toEqual(originalModes);
        expect(await snapshot(c.t.cwd)).toBe(source);
        const result = object(JSON.parse(await readFile(join(c.t.dir, 'result.json'), 'utf8')));
        expect(result.publication).toBe('not_attempted');
        expect(f.calls.implementations).toBe(1);
        expect(f.calls.pushes).toBe(0);
        expect(f.calls.publications).toBe(0);
      },
    );
  }
}

// 実際の復帰入口が保存するConfigを使い、終端成功の早期returnでも照合する。
// 公開前の呼出しは隔離fixture内の検証済みcommitを指定し、pushやPRは作らない。
for (const phase of ['reuse', 'publication'] as const) {
  testDevelopment(`中断復帰の終端成功を原記録照合なしで流用しない: ${phase}`, async (f) => {
    const c = await currentTestFixture(f);
    await writeFile(c.evidencePath, JSON.stringify(c.evidence));
    const first = await recoveryCli(f, c.t);
    expect(first.code, first.stderr).toBe(0);
    const statePath = join(c.t.dir, 'verification/state.json');
    const state = await readFile(statePath, 'utf8');
    expect(object(JSON.parse(state)).result).toBe('ready_for_human_review');
    const configPath = join(c.t.dir, 'verification-config.json');
    const config = await readFile(configPath, 'utf8');
    expect(object(JSON.parse(state)).configHash).toBe(hash(JSON.stringify(JSON.parse(config))));
    const executed = await actorExecutions(c.t.executions);
    let publicationHead: string | undefined;
    if (phase === 'publication') {
      await gitOutput(c.t.cwd, 'add', '--all');
      await gitOutput(c.t.cwd, 'commit', '-m', '検証済みfixture');
      publicationHead = await gitOutput(c.t.cwd, 'rev-parse', 'HEAD');
    }
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const external = await records(c.external);
    const externalModes = await modes(c.external);
    // state不変の再呼出しだけを共有する。各改変を復元・照合してから次へ進み、
    // 狙った拒否の前後に正常対照を置く。工程中に停止するケースとは共有しない。
    for (const suffix of ['none', 'stdout', 'target.json', 'prompt', 'none'] as const) {
      const path = suffix === 'none' ? null : `${c.prefix}.${suffix}`;
      const content = path ? await readFile(path) : null;
      if (suffix !== 'none') {
        assert(path && content);
        await writeFile(path, Buffer.concat([content, Buffer.from('\n')]));
        const expectedMode = externalModes[path];
        assert(expectedMode !== undefined);
        expect((await stat(path)).mode).toBe(expectedMode);
        await assert.rejects(verifyTestArtifacts(c.t.cwd, [c.record]), originalTestReasons[suffix]);
      }
      const changed = await records(c.external);
      try {
        const executedAgain = await command(
          [
            process.execPath,
            '--preload',
            join(dirname(f.dir), 'recovery-cli.ts'),
            '--eval',
            `import {run} from ${JSON.stringify(new URL('../../implement/correction.ts', import.meta.url).pathname)};
const config=await Bun.file(${JSON.stringify(configPath)}).json();
const result=await run(config,${JSON.stringify(publicationHead)}).then(
 value=>({accepted:value.result==='ready_for_human_review',reason:String(value.findings)}),
 error=>({accepted:false,reason:String(error)}));
console.log(JSON.stringify(result));`,
          ],
          c.t.cwd,
          '',
          10000,
        );
        expect(executedAgain.timedOut, `${phase}/${suffix}`).toBe(false);
        expect(executedAgain.code, executedAgain.stderr).toBe(0);
        const result = object(JSON.parse(executedAgain.stdout));
        expect(result.accepted, `${phase}/${suffix}: ${String(result.reason)}`).toBe(
          suffix === 'none',
        );
        if (suffix !== 'none') {
          expect(String(result.reason)).toMatch(originalTestReasons[suffix]);
        }
        expect(await readFile(statePath, 'utf8')).toBe(state);
        expect(await readFile(configPath, 'utf8')).toBe(config);
        expect(await actorExecutions(c.t.executions)).toBe(executed);
        expect(await records(f.dir)).toEqual(original);
        expect(await modes(f.dir)).toEqual(originalModes);
        expect(await records(c.external)).toEqual(changed);
        expect(await modes(c.external)).toEqual(externalModes);
        expect(f.calls.pushes).toBe(0);
        expect(f.calls.publications).toBe(0);
      } finally {
        if (path && content) {
          await writeFile(path, content);
        }
      }
      expect(await records(c.external)).toEqual(external);
      expect(await modes(c.external)).toEqual(externalModes);
      await verifyTestArtifacts(c.t.cwd, [c.record]);
    }
  });
}

testDevelopment('現行独立テスト記録と旧保護記録の不一致を区別する正常対照', async (f) => {
  const c = await currentTestFixture(f);
  const old = z
    .array(
      z.object({
        prefix: z.string(),
        targetId: z.string(),
        stdoutHash: z.string(),
        files: z.record(z.string(), z.string()),
      }),
    )
    .parse(JSON.parse(await readFile(join(f.dir, 'test-records.json'), 'utf8')));
  await assert.rejects(verifyTestArtifacts(c.t.cwd, old), /実装側でテスト成果物が変更/);
  const record = await readPreparedTestRecord(await readFile(c.recordPath, 'utf8'), issue, c.t.cwd);
  await verifyTestArtifacts(c.t.cwd, [record]);
  expect(await readFile(join(c.t.cwd, 'result.test.js'), 'utf8')).toBe(c.source);
  expect((await stat(join(c.t.cwd, 'result.test.js'))).mode & 0o777).toBe(0o700);
  const valid = await command([process.execPath, 'result.test.js'], c.t.cwd, '', 10000);
  expect(valid.code).toBe(0);
  await writeFile(join(c.t.cwd, 'result.txt'), 'old');
  const invalid = await command([process.execPath, 'result.test.js'], c.t.cwd, '', 10000);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('要求した結果がありません');
});

for (const defect of ['none', 'missing', 'content', 'mode', 'response'] as const) {
  testDevelopment(`中断復帰は現在の独立テスト記録を照合する: ${defect}`, async (f) => {
    const c = await currentTestFixture(f);
    if (defect === 'missing') {
      // logsの原記録は残し、採用するtestRecords参照の欠落だけを与える。
      c.evidence.testRecords = [];
    } else if (defect === 'content') {
      await writeFile(join(c.t.cwd, 'result.test.js'), 'process.exit(0);\n');
    } else if (defect === 'mode') {
      await chmod(join(c.t.cwd, 'result.test.js'), 0o644);
    } else if (defect === 'response') {
      await writeFile(`${c.prefix}.stdout`, '改変された独立応答');
    }
    // source不一致で先に拒否させず、現行記録との照合を観測する。
    c.evidence.source = await snapshot(c.t.cwd);
    await writeFile(c.evidencePath, JSON.stringify(c.evidence));
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const external = await records(c.external);
    const externalModes = await modes(c.external);
    const currentSource = await snapshot(c.t.cwd);
    const executed = await actorExecutions(c.t.executions);
    const outcome = await recoveryCli(f, c.t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(outcome.code).toBe(defect === 'none' ? 0 : 1);
    if (defect === 'none') {
      const state = object(
        JSON.parse(await readFile(join(c.t.dir, 'verification/state.json'), 'utf8')),
      );
      expect(state.result).toBe('ready_for_human_review');
      expect(state.source).toBe(currentSource);
      const roles = (await actorExecutions(c.t.executions))
        .slice(executed.length)
        .trim()
        .split('\n');
      expect(roles.filter((role) => role === 'check' || role === 'review')).toEqual([
        'check',
        'review',
      ]);
      expect(roles).not.toContain('repair');
      const target = object(
        JSON.parse(await readFile(join(c.t.dir, 'verification/review-1.target.json'), 'utf8')),
      );
      expect(target.source).toBe(currentSource);
      const tests = JSON.stringify(target.tests);
      expect(tests).toContain(c.record.stdoutHash);
      expect(tests).toContain(c.record.files['result.test.js'] ?? 'missing-current-test');
      await verifyTestArtifacts(c.t.cwd, [c.record]);
    } else {
      expect(outcome.stderr).toMatch(/test|テスト|成果物|応答|stdout|モード|mode/i);
      expect(await actorExecutions(c.t.executions)).toBe(executed);
      expect(await Bun.file(join(c.t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    }
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
    expect(await records(c.external)).toEqual(external);
    expect(await modes(c.external)).toEqual(externalModes);
    expect(await snapshot(c.t.cwd)).toBe(currentSource);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  });
}

// 要求2・3・7: 有効な評価履歴がないactive対象も、保存済みの既知hashを照合する。
// run再帰一覧に入らない原記録を参照し、単なる旧run全体のhash照合と区別する。
async function activeRuntimeFixture(f: Parameters<typeof fixture>[0]) {
  const t = await fixture(f);
  const path = await saveActorRecord(
    dirname(f.dir),
    join(f.dir, 'implementation'),
    'repair',
    'active-known',
  );
  const content = await readFile(path, 'utf8');
  const targetPath = join(f.dir, 'verification/review-1.target.json');
  const target = object(JSON.parse(await readFile(targetPath, 'utf8')));
  const { targetId: _targetId, ...payload } = target;
  payload.runtimeRecords = [
    ...z.array(z.unknown()).parse(target.runtimeRecords ?? []),
    {
      run: f.dir,
      prefix: join(f.dir, 'implementation'),
      role: 'repair',
      path,
      sha256: hash(content),
      reason: null,
    },
  ];
  await writeFile(
    targetPath,
    JSON.stringify({ ...payload, targetId: hash(JSON.stringify(payload)) }),
  );
  expect(t.state.reviewHistory).toEqual([]);
  expect(object(t.state.active).role).toBe('review');
  return { t, path, content, mode: (await stat(path)).mode };
}

for (const defect of ['none', 'changed', 'missing'] as const) {
  testDevelopment(`active評価対象の既知runtime参照を取込み前に照合する: ${defect}`, async (f) => {
    const { t, path, content, mode } = await activeRuntimeFixture(f);
    if (defect === 'changed') {
      await writeFile(path, content + '\n');
    }
    if (defect === 'missing') {
      await rm(path);
    }
    const original = await records(f.dir);
    const originalModes = await modes(f.dir);
    const executed = await actorExecutions(t.executions);
    const outcome = await recoveryCli(f, t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(outcome.code).toBe(defect === 'none' ? 0 : 1);
    if (defect === 'none') {
      expect(await actorExecutions(t.executions)).toBe(executed + 'check\nreview\n');
    } else {
      expect(outcome.stderr).toMatch(/runtime|actor|原記録/i);
      expect(outcome.stderr).toMatch(/hash|変更|取得不能|欠落|ENOENT/i);
      expect(await actorExecutions(t.executions)).toBe(executed);
      expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    }
    expect(await records(f.dir)).toEqual(original);
    expect(await modes(f.dir)).toEqual(originalModes);
    expect(await Bun.file(path).exists()).toBe(defect !== 'missing');
    if (defect !== 'missing') {
      expect(await readFile(path, 'utf8')).toBe(content + (defect === 'changed' ? '\n' : ''));
      expect((await stat(path)).mode).toBe(mode);
    }
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  });
}

for (const boundary of ['check', 'review'] as const) {
  for (const defect of ['changed', 'missing'] as const) {
    testDevelopment(
      `active対象から辿る既知runtimeの${defect}を${boundary}後に受け入れない`,
      async (f) => {
        const { t, path, content, mode } = await activeRuntimeFixture(f);
        const original = await records(f.dir);
        const executed = await actorExecutions(t.executions);
        await writeFile(
          t.control,
          JSON.stringify({
            response: 'accepted',
            [boundary === 'check' ? 'changeCheck' : 'change']: {
              path,
              content: content + '\n',
              remove: defect === 'missing',
            },
          }),
        );
        const outcome = await recoveryCli(f, t);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.code).toBe(1);
        expect(outcome.stderr).not.toMatch(
          /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
        );
        expect(outcome.stderr).toMatch(/runtime|actor|原記録/i);
        const state = object(
          JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
        );
        expect(state.result).not.toBe('ready_for_human_review');
        expect(state.reviewHistory).toEqual([]);
        expect(await actorExecutions(t.executions)).toBe(
          executed + (boundary === 'check' ? 'check\n' : 'check\nreview\n'),
        );
        expect(await records(f.dir)).toEqual(original);
        expect(await Bun.file(path).exists()).toBe(defect !== 'missing');
        if (defect !== 'missing') {
          expect(await readFile(path, 'utf8')).toBe(content + '\n');
          expect((await stat(path)).mode).toBe(mode);
        }
        expect(f.calls.pushes).toBe(0);
        expect(f.calls.publications).toBe(0);
      },
    );
  }
}

// 既存exportで修正前の失敗を最小層で確認する。CLI新入口の未実装とは区別する。
for (const defect of ['none', 'changed', 'missing'] as const) {
  testDevelopment(`保存runtime照合は履歴のないactive対象も検査する: ${defect}`, async (f) => {
    const { path, content } = await activeRuntimeFixture(f);
    const saved = new Map([
      [
        join(f.dir, 'verification/state.json'),
        await readFile(join(f.dir, 'verification/state.json'), 'utf8'),
      ],
    ]);
    const known = [{ path, sha256: hash(content) }];
    await verifyReviewedRuntime({ events: [] }, new RecordObservation(), known);
    await verifySavedRuntime(f.dir, saved, new RecordObservation());
    if (defect === 'changed') {
      await writeFile(path, content + '\n');
    }
    if (defect === 'missing') {
      await rm(path);
    }
    const check = () => verifySavedRuntime(f.dir, saved, new RecordObservation());
    if (defect === 'none') {
      await check();
    } else {
      await assert.rejects(
        () => verifyReviewedRuntime({ events: [] }, new RecordObservation(), known),
        /actor runtime.*(?:変更|取得不能)/,
      );
      await assert.rejects(check, /actor runtime.*(?:変更|取得不能)/);
    }
  });
}

async function modeRecordFixture(
  f: Parameters<typeof fixture>[0],
  record: 'response' | 'external_actor' | 'ancestor',
) {
  const active = record === 'external_actor' ? await activeRuntimeFixture(f) : undefined;
  const t = active?.t ?? (await fixture(f, record === 'ancestor' ? 'host_return' : 'initial'));
  const ancestor = join(dirname(f.dir), 'run');
  const path =
    active?.path ??
    join(
      record === 'ancestor' ? ancestor : f.dir,
      record === 'ancestor' ? 'implementation.stdout' : 'verification/review-1.stdout',
    );
  return { t, ancestor, path };
}

// 要求2・7: 内容hashが同じでも取込み時の権限を失えば停止する。
// 旧run内、一覧外の既知参照、必須の祖先記録を分け、周辺全体の監査は要求しない。
for (const record of ['response', 'external_actor', 'ancestor'] as const) {
  for (const boundary of ['none', 'check', 'review'] as const) {
    testDevelopment(
      `中断復帰は原記録のモードだけの変更も検出する: ${record}/${boundary}`,
      async (f) => {
        const { t, ancestor, path } = await modeRecordFixture(f, record);
        // 祖先は元のホスト取込み時からのモードを維持する。読み取りと内容は変えず、
        // Gitの実行ビットだけの照合では検出できない権限の変化を与える。
        const originalMode = (await stat(path)).mode & 0o777;
        const changedMode = originalMode ^ 0o020;
        const content = await readFile(path);
        const original = await records(f.dir);
        const originalModes = await modes(f.dir);
        const ancestorRecords = record === 'ancestor' ? await records(ancestor) : {};
        const ancestorModes = record === 'ancestor' ? await modes(ancestor) : {};
        const source = await snapshot(t.cwd);
        const testPath = join(t.cwd, 'result.test.js');
        const testContent = await readFile(testPath);
        const testMode = (await stat(testPath)).mode;
        const executed = await actorExecutions(t.executions);
        await writeFile(
          t.control,
          JSON.stringify({
            response: 'accepted',
            ...(boundary === 'none'
              ? {}
              : {
                  [boundary === 'check' ? 'changeCheck' : 'change']: { path, mode: changedMode },
                }),
          }),
        );
        const outcome = await recoveryCli(f, t);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.stderr).not.toMatch(
          /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
        );
        expect(outcome.code).toBe(boundary === 'none' ? 0 : 1);
        const state = object(
          JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
        );
        if (boundary === 'none') {
          expect(state.result).toBe('ready_for_human_review');
          expect(events(state.reviewHistory)).toHaveLength(1);
        } else {
          expect(outcome.stderr).toMatch(/mode|モード|権限|変更|変わ|不一致/i);
          expect(state.result).not.toBe('ready_for_human_review');
          expect(state.reviewHistory).toEqual([]);
        }
        expect(await actorExecutions(t.executions)).toBe(
          executed + (boundary === 'check' ? 'check\n' : 'check\nreview\n'),
        );
        expect(await readFile(path)).toEqual(content);
        const expectedMode = boundary === 'none' ? originalMode : changedMode;
        expect((await stat(path)).mode & 0o777).toBe(expectedMode);
        // 注入した変更は巻き戻さず、それ以外の原記録・モードを保持する。
        const retainedModes = await modes(f.dir);
        const retainedAncestorModes = record === 'ancestor' ? await modes(ancestor) : {};
        delete originalModes[path];
        delete retainedModes[path];
        delete ancestorModes[path];
        delete retainedAncestorModes[path];
        expect(await records(f.dir)).toEqual(original);
        expect(retainedModes).toEqual(originalModes);
        if (record === 'ancestor') {
          expect(await records(ancestor)).toEqual(ancestorRecords);
          expect(retainedAncestorModes).toEqual(ancestorModes);
        }
        expect(await snapshot(t.cwd)).toBe(source);
        expect(await readFile(testPath)).toEqual(testContent);
        expect((await stat(testPath)).mode).toBe(testMode);
        const result = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
        expect(result.publication).toBe('not_attempted');
        expect(f.calls.implementations).toBe(1);
        expect(f.calls.pushes).toBe(0);
        expect(f.calls.publications).toBe(0);
      },
    );
  }
}
