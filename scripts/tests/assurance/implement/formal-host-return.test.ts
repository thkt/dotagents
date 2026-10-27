import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../../implement/host-records.ts';
import { command } from '../../../shared/process.ts';
import { object } from '../../support/correction.ts';
import { formalHostFixture, formalTree } from '../../support/formal-host-return.ts';
import { testReviewRecovery } from '../../support/review-recovery.ts';

// #430の正式停止を重ねる境界だけを追加する。通常のhost-return・外部準備記録、
// 旧check予算、応答schema、時間・回数上限の既存ケースは維持する。
// #428の成功を#430の成功へ移さず、独立した新check・評価と祖先保全を観測する。
type Fixture = Awaited<ReturnType<typeof formalHostFixture>>;
async function secondStop(t: Fixture) {
  await writeFile(t.control, JSON.stringify({ phase: 'repair' }));
  const intake = await t.intake(t.r1, 'formal-r2');
  const result = await t.generateCli(intake.args);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Host verification required/);
  const saved = object(JSON.parse(await readFile(join(intake.dir, 'result.json'), 'utf8')));
  expect(saved).toMatchObject({
    terminal: true,
    reasonCode: 'host_verification_required',
    publication: 'not_attempted',
  });
  const config = object(
    JSON.parse(await readFile(join(intake.dir, 'verification-config.json'), 'utf8')),
  );
  // #430の新しい直列化形式は固定しない。旧形式はR1の入力として照合し、
  // 新しい履歴は到達・原記録保全・現在版への照合で判定する。
  const state = object(
    JSON.parse(await readFile(join(intake.dir, 'verification/state.json'), 'utf8')),
  );
  expect(state).toMatchObject({
    checks: 1,
    review: 1,
    repair: 1,
    active: null,
    result: 'host_verification_required',
  });
  expect(state.reviewHistory).toHaveLength(1);
  expect(Number(state.modelMs)).toBeGreaterThanOrEqual(0);
  return { ...intake, config, state };
}

async function pendingSecondStop(t: Fixture) {
  await writeFile(t.control, JSON.stringify({ phase: 'test-stop' }));
  const intake = await t.intake(t.r1, 'formal-pending-r2');
  const result = await t.generateCli(intake.args);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Host verification required/);
  expect(await Bun.file(join(intake.dir, 'implementation.prompt')).exists()).toBe(false);
  const config = object(
    JSON.parse(await readFile(join(intake.dir, 'verification-config.json'), 'utf8')),
  );
  expect(object(config.hostReturn).testInterruption).toMatchObject({ record: t.origin });
  return intake;
}

// 生成器の到達と旧契約を、未実装の#430消費経路から独立して確認する正常対照。
testReviewRecovery('固定した受理済み依存から二つの正式停止を生成する', async (f) => {
  const t = await formalHostFixture(f);
  const r2 = await secondStop(t);
  expect(object(r2.config.hostReturn).testInterruption).toMatchObject({ record: t.origin });
  expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
});

testReviewRecovery('正式停止fixtureの稼働行は要求したpsの列を満たす', async (f) => {
  const t = await formalHostFixture(f);
  await writeFile(t.control, JSON.stringify({ observation: 'live' }));
  const processPath = new URL('../../../shared/process.ts', import.meta.url).pathname;
  for (const columns of ['pid=,ppid=,command=', 'pid=,ppid=,lstart=,command=']) {
    const result = await command(
      [
        process.execPath,
        '--preload',
        t.preload,
        '--eval',
        `import {command} from ${JSON.stringify(processPath)};
const result=await command(['ps','-ww','-axo',${JSON.stringify(columns)}],process.cwd(),'',1000);
if(result.code!==0) throw Error(result.stderr);
process.stdout.write(result.stdout);`,
      ],
      f.repo,
      '',
      10000,
    );
    assert.equal(result.code, 0, result.stderr);
    const rows = result.stdout.trim().split('\n');
    const start = columns.includes('lstart') ? 'Thu Jan 1 00:00:00 2026 ' : '';
    expect(rows).toEqual([
      `1 0 ${start}/sbin/launchd`,
      `424242 1 ${start}bun codex-actor.ts test ${f.dir}`,
    ]);
  }
});

testReviewRecovery('初回中断と二つの正式停止を保持して現在版を再評価する', async (f) => {
  const t = await formalHostFixture(f, { dependencyLock: true });
  for (const name of ['test-baseline', 'test-1-workspace']) {
    expect(await readFile(join(t.r1, name, 'bun.lock'), 'utf8')).toBe('dependency');
  }
  const r1 = await formalTree(t.r1, true);
  const r2 = await secondStop(t);
  const savedR2 = await formalTree(r2.dir);
  // 直前の現在checkoutだけを更新する。初回中断checkoutとは別であることも確認する。
  expect(t.cwd).not.toBe(object(t.origin.config).cwd);
  await writeFile(join(t.cwd, 'application-evidence.txt'), '模擬適用後の新しい版');
  await writeFile(t.control, JSON.stringify({ phase: 'accept' }));
  await writeFile(t.calls, '');
  const r3 = await t.intake(r2.dir, 'formal-r3');
  const result = await t.cli(r3.args);
  assert.equal(result.code, 0, result.stderr);
  expect(object(JSON.parse(result.stdout))).toMatchObject({
    status: 'verified_local',
    publication: 'not_attempted',
  });
  const calls = await t.observations();
  expect(calls.map((entry) => entry.role)).toEqual(['test', 'check', 'review']);
  const independent = calls[0];
  assert(independent);
  expect(independent).toMatchObject({ result: 'old', oldAsset: false });
  const input = object(independent.input);
  const initial = object(JSON.parse(await readFile(join(f.dir, 'test-1.target.json'), 'utf8')));
  expect(input.stage).toBe('host_return');
  expect(input.baseCommit).toBe(initial.baseCommit);
  expect(input.baseline).toEqual(initial.baseline);
  expect(String(independent.prompt)).not.toContain('OLD_PRIVATE_JUDGMENT');
  const current = object(
    JSON.parse(await readFile(join(r3.dir, 'verification/state.json'), 'utf8')),
  );
  expect(current).toMatchObject({
    checks: 1,
    review: 1,
    repair: 0,
    active: null,
    result: 'ready_for_human_review',
  });
  expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
  expect(await formalTree(t.r1, true)).toEqual(r1);
  expect(await formalTree(r2.dir)).toEqual(savedR2);
});

async function manifestDependency(t: Fixture) {
  const workspace = join(t.r1, 'test-1-workspace');
  const path = join(workspace, 'evaluation/uv.lock');
  const manifest = `${workspace}.json`;
  const stop = object(JSON.parse(await readFile(join(t.r1, 'host-stop.json'), 'utf8')));
  assert(Array.isArray(stop.records));
  const paths = stop.records.map((ref) => object(ref).path);
  expect(paths).toContain(join(t.r1, 'test-1.target.json'));
  expect(paths).toContain(manifest);
  expect(paths).not.toContain(path);
  const input = object(JSON.parse(await readFile(manifest, 'utf8')));
  const info = await lstat(path);
  expect(info.isFile()).toBe(true);
  expect(info.mode).toBe(0o100644);
  expect(object(input.files)['evaluation/uv.lock']).toBe(
    hash(Buffer.concat([Buffer.from(`${info.mode}:`), await readFile(path)])),
  );
  return { path, manifest, input };
}

testReviewRecovery('正式復帰は制御記録に本体を列挙しないmanifest依存lockを受理する', async (f) => {
  const t = await formalHostFixture(f, { nestedDependency: true });
  await manifestDependency(t);
  const before = await formalTree(t.r1, true);
  const intake = await t.intake(t.r1, 'manifest-dependency-return');
  await writeFile(t.control, JSON.stringify({ phase: 'accept' }));
  await writeFile(t.calls, '');
  const result = await t.cli(intake.args);
  expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
  expect(await formalTree(t.r1, true)).toEqual(before);
  assert.equal(result.code, 0, result.stderr);
  expect(object(JSON.parse(result.stdout))).toMatchObject({
    status: 'verified_local',
    publication: 'not_attempted',
  });
  const calls = await t.observations();
  expect(calls.map((entry) => entry.role)).toEqual(['test', 'check', 'review']);
  expect(object(calls[0]?.input).stage).toBe('host_return');
});

for (const fault of [
  'content',
  'mode',
  'symlink',
  'manifest',
  'binding',
  'undeclared',
  'management',
] as const) {
  testReviewRecovery(`正式復帰はmanifest依存の不一致で後続を起動しない: ${fault}`, async (f) => {
    const t = await formalHostFixture(f, { nestedDependency: true });
    const dependency = await manifestDependency(t);
    if (fault === 'content') {
      await writeFile(dependency.path, 'changed dependency');
    } else if (fault === 'mode') {
      await chmod(dependency.path, 0o700);
      expect((await lstat(dependency.path)).mode).toBe(0o100700);
    } else if (fault === 'symlink') {
      const target = `${t.r1}-dependency.txt`;
      await writeFile(target, await readFile(dependency.path));
      await rm(dependency.path);
      await symlink(target, dependency.path);
    } else if (fault === 'manifest') {
      const files = object(dependency.input.files);
      files['evaluation/uv.lock'] = '0'.repeat(64);
      await writeFile(dependency.manifest, JSON.stringify({ files }));
    } else if (fault === 'binding') {
      const path = join(t.r1, 'host-stop.json');
      const stop = object(JSON.parse(await readFile(path, 'utf8')));
      assert(Array.isArray(stop.records));
      stop.records = stop.records.filter((ref) => object(ref).path !== dependency.manifest);
      await writeFile(path, JSON.stringify(stop));
    } else if (fault === 'undeclared') {
      await writeFile(join(t.r1, 'test-1-workspace/evaluation/bun.lock'), 'undeclared');
    } else {
      await mkdir(join(t.r1, 'lock'));
    }
    const before = await formalTree(t.r1, true);
    const intake = await t.intake(t.r1, `manifest-reject-${fault}`);
    await writeFile(t.control, JSON.stringify({ phase: 'accept' }));
    await writeFile(t.calls, '');
    const result = await t.cli(intake.args);
    assert.equal(result.code, 1, result.stderr);
    expect(result.stderr).not.toMatch(/Unknown option|SyntaxError|Unexpected GitHub/i);
    expect(await t.observations()).toEqual([]);
    expect(await formalTree(t.r1, true)).toEqual(before);
    expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
    expect(result.stderr).not.toContain(join(t.r1, 'test-baseline/evaluation/uv.lock'));
  });
}

// 旧host-stopにはmode欄がない。受付前の不明なmodeを0644と決めつけず、
// 新しい受付後の既知のmodeからの変化を検査する。
for (const boundary of ['check', 'review'] as const) {
  for (const ancestor of ['r1', 'r2'] as const) {
    testReviewRecovery(
      `${boundary}中の正式停止${ancestor}原記録のmode変化を成功受入前に拒否する`,
      async (f) => {
        const t = await formalHostFixture(f);
        const r2 = await secondStop(t);
        const path = join(ancestor === 'r1' ? t.r1 : r2.dir, 'issue.json');
        const content = await readFile(path);
        expect((await lstat(path)).mode & 0o7777).not.toBe(0o700);
        const r3 = await t.intake(r2.dir, 'formal-record-mode-boundary');
        await writeFile(
          t.control,
          JSON.stringify({
            phase: 'accept',
            [boundary === 'check' ? 'changeCheck' : 'changeReview']: path,
          }),
        );
        await writeFile(t.calls, '');
        const result = await t.cli(r3.args);
        assert.equal(result.code, 1, result.stderr);
        expect((await t.observations()).map((entry) => entry.role)).toEqual(
          boundary === 'check' ? ['test', 'check'] : ['test', 'check', 'review'],
        );
        expect(await readFile(path)).toEqual(content);
        expect((await lstat(path)).mode & 0o7777).toBe(0o700);
        const state = object(
          JSON.parse(await readFile(join(r3.dir, 'verification/state.json'), 'utf8')),
        );
        expect(state).toMatchObject({
          result: 'host_evidence_changed',
          review: boundary === 'check' ? 0 : 1,
          repair: 0,
        });
        const saved = object(JSON.parse(await readFile(join(r3.dir, 'result.json'), 'utf8')));
        expect(saved).toMatchObject({
          status: 'stopped',
          terminal: true,
          publication: 'not_attempted',
        });
        expect(String(state.findings)).toMatch(/変更|変化|mode|モード|不一致/i);
      },
    );
  }
}

testReviewRecovery('固定生成器は初回実装前の正式停止も保存する', async (f) => {
  const t = await formalHostFixture(f, { pendingImplementation: true });
  expect(await Bun.file(join(t.r1, 'implementation.prompt')).exists()).toBe(false);
  expect((await t.observations()).map((entry) => entry.role)).toEqual(['test']);
  expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
  await writeFile(t.calls, '');
  await pendingSecondStop(t);
  expect((await t.observations()).map((entry) => entry.role)).toEqual(['test']);
  expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
});

for (const mutation of ['none', 'r0', 'r1'] as const) {
  testReviewRecovery(
    `未実行の初回実装がneeds_hostを返す境界で祖先を再照合する: ${mutation}`,
    async (f) => {
      const t = await formalHostFixture(f, { pendingImplementation: true });
      expect(await Bun.file(join(t.r1, 'implementation.prompt')).exists()).toBe(false);
      const pending = await pendingSecondStop(t);
      const path =
        mutation === 'r0'
          ? join(f.dir, 'test-1-workspace/unadopted.test.js')
          : join(t.r1, 'issue.json');
      const content = await readFile(path);
      expect((await lstat(path)).mode & 0o7777).not.toBe(0o700);
      const previous = await formalTree(t.r1, true);
      const savedPending = await formalTree(pending.dir);
      const r2 = await t.intake(pending.dir, 'formal-pending-implementation');
      await writeFile(
        t.control,
        JSON.stringify({
          phase: 'implementation',
          ...(mutation === 'none' ? {} : { changeImplementation: path }),
        }),
      );
      await writeFile(t.calls, '');
      const result = await t.cli(r2.args);
      assert.equal(result.code, 1, result.stderr);
      const calls = await t.observations();
      expect(calls.map((entry) => entry.role)).toEqual(['test', 'repair']);
      expect(object(calls[0]?.input).stage).toBe('host_return');
      const saved = object(JSON.parse(await readFile(join(r2.dir, 'result.json'), 'utf8')));
      expect(await readFile(path)).toEqual(content);
      if (mutation === 'none') {
        expect(saved.reasonCode).toBe('host_verification_required');
        expect(await Bun.file(join(r2.dir, 'host-stop.json')).exists()).toBe(true);
        expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
        expect(await formalTree(t.r1, true)).toEqual(previous);
        expect(await formalTree(pending.dir)).toEqual(savedPending);
      } else {
        expect((await lstat(path)).mode & 0o7777).toBe(0o700);
        expect(result.stderr).toMatch(/変更|変化|mode|モード|不一致/i);
        expect(saved.reasonCode).not.toBe('host_verification_required');
        expect(await Bun.file(join(r2.dir, 'host-stop.json')).exists()).toBe(false);
      }
    },
  );
}

const failures = [
  {
    name: '祖先原応答の内容変化',
    reason: /changed|変更|変化|hash|不一致/i,
    change: async (t: Fixture) => {
      await writeFile(join(String(t.origin.previousRun), 'test-1.stdout'), 'changed');
    },
  },
  {
    name: '祖先workspaceの全mode変化',
    reason: /changed|変更|変化|mode|モード|不一致/i,
    change: async (t: Fixture) => {
      await chmod(join(String(t.origin.previousRun), 'test-1-workspace/unadopted.test.js'), 0o700);
    },
  },
  {
    name: '祖先管理lock',
    reason: /lock/i,
    change: async (t: Fixture) => {
      // 管理lockは初回中断run直下に作り、削除による復旧を試みない。
      await mkdir(join(String(t.origin.previousRun), 'lock'));
    },
  },
] as const;

for (const failure of failures) {
  testReviewRecovery(`正式停止の再帰受付は後続を抑止する: ${failure.name}`, async (f) => {
    const t = await formalHostFixture(f);
    const r2 = await secondStop(t);
    await failure.change(t);
    const origin = await formalTree(f.dir);
    const previous = await formalTree(r2.dir);
    const r3 = await t.intake(r2.dir, 'formal-rejected');
    await writeFile(t.control, JSON.stringify({ phase: 'accept' }));
    await writeFile(t.calls, '');
    const result = await t.cli(r3.args);
    assert.equal(result.code, 1, result.stderr);
    expect(result.stderr).toMatch(failure.reason);
    expect(result.stderr).not.toMatch(
      /Unknown option|Unknown configuration field|Unrecognized key|SyntaxError|Unexpected GitHub/i,
    );
    expect(await t.observations()).toEqual([]);
    expect(await formalTree(f.dir)).toEqual(origin);
    expect(await formalTree(r2.dir)).toEqual(previous);
  });
}

for (const observation of ['live', 'unavailable', 'remote', 'pr']) {
  testReviewRecovery(`正式停止の再評価は外部観測で拒否する: ${observation}`, async (f) => {
    const t = await formalHostFixture(f);
    const r2 = await secondStop(t);
    const r3 = await t.intake(r2.dir, 'formal-observation-rejected');
    await writeFile(t.control, JSON.stringify({ phase: 'accept', observation }));
    await writeFile(t.calls, '');
    const result = await t.cli(r3.args);
    assert.equal(result.code, 1, result.stderr);
    expect(result.stderr).toMatch(
      observation === 'live' ? /PID=424242\b/ : /process|プロセス|観測|remote|公開|PR/i,
    );
    expect(result.stderr).not.toMatch(/Unknown option|Unknown configuration field|SyntaxError/i);
    expect(await t.observations()).toEqual([]);
    expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
  });
}

for (const observation of ['returning', 'other-entry', 'other-directory', 'other-repo']) {
  testReviewRecovery(
    `正式停止の公開CLIは復帰ホストの別名オプションを除外しない: ${observation}`,
    async (f) => {
      const t = await formalHostFixture(f);
      const r2 = await secondStop(t);
      const r3 = await t.intake(r2.dir, 'formal-option-boundary');
      await writeFile(t.control, JSON.stringify({ phase: 'accept', observation }));
      await writeFile(t.calls, '');
      const result = await t.cli(r3.args);
      if (observation === 'returning') {
        assert.equal(result.code, 0, result.stderr);
        expect((await t.observations()).map((entry) => entry.role)).toEqual([
          'test',
          'check',
          'review',
        ]);
      } else {
        assert.equal(result.code, 1, result.stderr);
        expect(result.stderr).toMatch(/稼働プロセス.*PID=/);
        expect(result.stderr).not.toMatch(
          /Unknown option|Unknown configuration field|SyntaxError/i,
        );
        expect(await t.observations()).toEqual([]);
      }
      expect(await formalTree(f.dir)).toEqual(t.savedOrigin);
    },
  );
}

testReviewRecovery('再停止後も過去版のホスト成功を現在版の証拠にしない', async (f) => {
  const t = await formalHostFixture(f);
  const r2 = await secondStop(t);
  const r3 = await t.intake(r2.dir, 'formal-stale-evidence');
  await writeFile(join(t.cwd, 'changed-after-measurement.txt'), 'new source');
  await writeFile(t.control, JSON.stringify({ phase: 'accept' }));
  await writeFile(t.calls, '');
  const result = await t.cli(r3.args);
  assert.equal(result.code, 1, result.stderr);
  expect(result.stderr).toMatch(/source|current|成果物|現在|証拠/i);
  expect(await t.observations()).toEqual([]);
});

testReviewRecovery('ローカル限定の再停止から公開権限を拡張しない', async (f) => {
  const t = await formalHostFixture(f);
  const r2 = await secondStop(t);
  const r3 = await t.intake(r2.dir, 'formal-authority-rejected');
  await writeFile(t.calls, '');
  const result = await t.cli(r3.args.filter((arg) => arg !== '--no-publish'));
  assert.equal(result.code, 1, result.stderr);
  expect(result.stderr).toMatch(/authority|権限|local|公開/i);
  expect(await t.observations()).toEqual([]);
  expect(hash(JSON.stringify(await formalTree(f.dir)))).toBe(String(t.origin.retained));
});

for (const fault of ['nonformal', 'missing-stop', 'conflicting-hash'] as const) {
  testReviewRecovery(`直前の正式停止との対応を拒否する: ${fault}`, async (f) => {
    const t = await formalHostFixture(f);
    const r2 = await secondStop(t);
    const stopPath = join(r2.dir, 'host-stop.json');
    if (fault === 'nonformal') {
      const path = join(r2.dir, 'result.json');
      const result = object(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(path, JSON.stringify({ ...result, reasonCode: 'invalid_review' }));
    } else if (fault === 'missing-stop') {
      await rm(stopPath);
    } else {
      const stop = object(JSON.parse(await readFile(stopPath, 'utf8')));
      assert(Array.isArray(stop.records));
      const first = object(stop.records[0]);
      stop.records.push({ ...first, sha256: '0'.repeat(64) });
      await writeFile(stopPath, JSON.stringify(stop));
    }
    const original = await formalTree(r2.dir);
    const r3 = await t.intake(r2.dir, 'formal-record-rejected');
    await writeFile(t.calls, '');
    const result = await t.cli(r3.args);
    assert.equal(result.code, 1, result.stderr);
    expect(result.stderr).toMatch(
      fault === 'nonformal'
        ? /handoff|host|正式|停止/i
        : fault === 'missing-stop'
          ? /ENOENT|欠落|missing/i
          : /hash|changed|期待|不一致/i,
    );
    expect(result.stderr).not.toMatch(/Unknown option|Unknown configuration field|SyntaxError/i);
    expect(await t.observations()).toEqual([]);
    expect(await formalTree(r2.dir)).toEqual(original);
  });
}

testReviewRecovery('再受付後check中の祖先mode変化を評価前に検出する', async (f) => {
  const t = await formalHostFixture(f);
  const r2 = await secondStop(t);
  const r3 = await t.intake(r2.dir, 'formal-boundary-rejected');
  await writeFile(
    t.control,
    JSON.stringify({
      phase: 'accept',
      changeCheck: join(String(t.origin.previousRun), 'test-1-workspace/unadopted.test.js'),
    }),
  );
  await writeFile(t.calls, '');
  const result = await t.cli(r3.args);
  assert.equal(result.code, 1, result.stderr);
  expect((await t.observations()).map((entry) => entry.role)).toEqual(['test', 'check']);
  const state = object(JSON.parse(await readFile(join(r3.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({ result: 'host_evidence_changed', review: 0, repair: 0 });
  expect(String(state.findings)).toMatch(/変更|変化|mode|モード|不一致/i);
});
