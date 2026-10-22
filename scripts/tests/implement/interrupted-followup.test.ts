import { expect } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { snapshot } from '../../implement/correction.ts';
import { object } from '../support/correction.ts';
import {
  records,
  recordPaths,
  recoveryCli,
  recoveryFixture,
  testReviewRecovery as testDevelopment,
} from '../support/review-recovery.ts';

const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

async function savedModes(dir: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const path of await recordPaths(dir)) {
    result[path] = (await stat(path)).mode;
  }
  return result;
}

async function roles(path: string) {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((role) => role && !role.startsWith('observe-'));
}

type Fixture = Parameters<Parameters<typeof testDevelopment>[1]>[0];
type Recovery = Awaited<ReturnType<typeof recoveryFixture>>;
type Route = 'host' | 'revision';
type Defect = 'content' | 'mode' | 'missing' | 'other_active' | 'uncertain';

async function firstRecovery(f: Fixture, route: Route) {
  const t = await recoveryFixture(f, route === 'host', 'interrupted');
  const root = dirname(f.dir);
  const original = await records(f.dir);
  const originalModes = await savedModes(f.dir);
  t.dir = join(root, `interrupted-${route}`);
  t.args = ['99', '--repo', t.cwd, '--interrupted-run', f.dir, '--run-dir', t.dir];
  if (route === 'host') {
    t.args.push('--no-publish');
  }
  await writeFile(
    t.control,
    JSON.stringify({
      response: route === 'host' ? 'needs_changes' : 'accepted',
      hostRequired: route === 'host',
    }),
  );
  const first = await recoveryCli(f, t, {}, { publication: route === 'revision' });
  expect(first.timedOut).toBe(false);
  expect(first.stderr).not.toMatch(
    /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
  );
  expect(first.code, first.stderr).toBe(route === 'host' ? 1 : 0);
  const firstResult = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
  const firstState = object(
    JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
  );
  expect(firstState.active).toBeNull();
  if (route === 'host') {
    expect(first.stderr).toMatch(/Host verification required/);
    expect(firstState.result).toBe('host_verification_required');
    expect(firstResult.publication).toBe('not_attempted');
  } else {
    expect(firstState.result).toBe('ready_for_human_review');
    expect(firstResult.publication).toBe('published');
    expect(await roles(t.executions)).toContain('publish');
  }
  expect(await records(f.dir)).toEqual(original);
  expect(await savedModes(f.dir)).toEqual(originalModes);
  return t;
}

async function followupArgs(t: Recovery, root: string, route: Route) {
  const prior = t.dir;
  const args = ['99', '--repo', t.cwd];
  if (route === 'host') {
    const log = join(root, 'followup-host.stdout');
    await writeFile(log, '模擬ホスト検証: 現在sourceを観測済み');
    const evidence = join(root, 'followup-host.json');
    await writeFile(
      evidence,
      JSON.stringify({
        status: 'passed',
        source: await snapshot(t.cwd),
        findings: '現在sourceの模擬観測。実サービスは未確認。',
        logs: [{ path: log, sha256: hash(await readFile(log)) }],
      }),
    );
    args.push('--host-run', prior, '--host-evidence', evidence, '--no-publish');
  } else {
    const request = join(root, 'followup-request.md');
    await writeFile(request, '採用済み修正要求: 要求した結果の操作説明をREADME.mdへ追加する。');
    args.push('--previous-run', prior, '--request-file', request);
  }
  return args;
}

async function injectFault(
  f: Fixture,
  t: Recovery,
  other: string,
  defect: Defect,
  raw: string,
  rawMode: number,
) {
  if (defect === 'content') {
    await writeFile(raw, '原応答の改変');
  }
  if (defect === 'mode') {
    await chmod(raw, (rawMode & 0o777) ^ 0o100);
  }
  if (defect === 'missing') {
    await rm(raw);
  }
  if (defect === 'other_active' || defect === 'uncertain') {
    await mkdir(join(other, 'verification'), { recursive: true });
    const result = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
    await writeFile(
      join(other, 'result.json'),
      JSON.stringify({
        ...result,
        evidence: other,
        ...(defect === 'uncertain' ? { publication: 'unconfirmed' } : {}),
      }),
    );
    const state = object(
      JSON.parse(await readFile(join(f.dir, 'verification/state.json'), 'utf8')),
    );
    await writeFile(
      join(other, 'verification/state.json'),
      JSON.stringify({
        ...state,
        ...(defect === 'uncertain' ? { active: null } : {}),
      }),
    );
  }
}

async function rejectedFollowups(
  f: Fixture,
  t: Recovery,
  route: Route,
  args: string[],
  prior: string,
  priorRecords: Record<string, string>,
  priorModes: Record<string, number>,
  publication = route === 'revision',
) {
  const root = dirname(f.dir);
  const raw = join(f.dir, 'verification/review-1.stdout');
  const rawContent = await readFile(raw);
  const rawMode = (await stat(raw)).mode;
  // 同じ祖先・同じ復帰先に各故障を一つずつ注入する。拒否runも保全する。
  for (const defect of ['content', 'mode', 'missing', 'other_active', 'uncertain'] as const) {
    const other = join(root, `other-${route}-${defect}`);
    await injectFault(f, t, other, defect, raw, rawMode);
    const before = await records(f.dir);
    const beforeModes = await savedModes(f.dir);
    const executed = await roles(t.executions);
    t.dir = join(root, `followup-${route}-${defect}`);
    t.args = [...args, '--run-dir', t.dir];
    try {
      const rejected = await recoveryCli(f, t, {}, { observe: true, publication });
      expect(rejected.timedOut).toBe(false);
      expect(rejected.code, rejected.stderr).toBe(1);
      expect(rejected.stderr).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
      );
      expect(rejected.stderr).toMatch(
        defect === 'other_active'
          ? /unfinished|active|未完了|reconciliation|照合/i
          : defect === 'uncertain'
            ? /uncertain|unconfirmed|公開|不明|reconciliation|照合/i
            : /changed|hash|mode|missing|ENOENT|変更|変化|不一致|原記録|記録|保全/i,
      );
      expect(await roles(t.executions)).toEqual(executed);
      expect(await records(f.dir)).toEqual(before);
      expect(await savedModes(f.dir)).toEqual(beforeModes);
      expect(await records(prior)).toEqual(priorRecords);
      expect(await savedModes(prior)).toEqual(priorModes);
    } finally {
      if (defect === 'other_active' || defect === 'uncertain') {
        await rm(other, { recursive: true });
      } else {
        // 隔離fixtureに注入した故障だけを戻す。製品の旧記録修復を許可するものではない。
        await writeFile(raw, rawContent);
        await chmod(raw, rawMode & 0o777);
      }
    }
  }
}

// #406 保証2・6・7: 公開済み復帰先の修正がホスト待ちになっても、
// 中断した祖先を保全したまま通常のホスト復帰で現在sourceを検証する。
testDevelopment('中断復帰の公開後にPR修正からホスト復帰して新しいcheck・評価へ進む', async (f) => {
  const t = await firstRecovery(f, 'revision');
  const root = dirname(f.dir);
  const published = t.dir;
  const retained = await Promise.all(
    [f.dir, published].map(async (dir) => ({
      dir,
      records: await records(dir),
      modes: await savedModes(dir),
    })),
  );
  const testPath = join(t.cwd, 'result.test.js');
  const testContent = await readFile(testPath);
  const testMode = (await stat(testPath)).mode;
  const revision = await followupArgs(t, root, 'revision');
  const executed = await roles(t.executions);
  await writeFile(t.control, JSON.stringify({ response: 'accepted', hostRequired: true }));
  t.dir = join(root, 'published-revision-host-stop');
  t.args = [...revision, '--run-dir', t.dir];
  const stopped = await recoveryCli(f, t, {}, { observe: true, publication: true });
  expect(stopped.timedOut).toBe(false);
  expect(stopped.code, stopped.stderr).toBe(1);
  expect(stopped.stderr).toMatch(/Host verification required/);
  expect((await roles(t.executions)).slice(executed.length)).toEqual(['test', 'repair']);
  expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
    terminal: true,
    reasonCode: 'host_verification_required',
    publication: 'not_attempted',
  });
  const prior = t.dir;
  const priorRecords = await records(prior);
  const priorModes = await savedModes(prior);
  // 公開許可は元のPR修正から維持する。初回ローカル専用の指定を加えない。
  const host = (await followupArgs(t, root, 'host')).filter((arg) => arg !== '--no-publish');
  await writeFile(t.control, JSON.stringify({ response: 'accepted' }));
  await rejectedFollowups(f, t, 'host', host, prior, priorRecords, priorModes, true);
  const beforeReturn = await roles(t.executions);
  t.dir = join(root, 'published-revision-host-return');
  t.args = [...host, '--run-dir', t.dir];
  const returned = await recoveryCli(f, t, {}, { observe: true, publication: true });
  expect(returned.timedOut).toBe(false);
  expect(returned.code, returned.stderr).toBe(0);
  expect((await roles(t.executions)).slice(beforeReturn.length)).toEqual([
    'test',
    'check',
    'review',
    'push',
    'publish',
  ]);
  expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
    publication: 'published',
  });
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state.result).toBe('ready_for_human_review');
  expect(state.active).toBeNull();
  const target = await readFile(join(t.dir, 'verification/review-1.target.json'), 'utf8');
  expect(target).toContain(prior);
  for (const saved of [...retained, { dir: prior, records: priorRecords, modes: priorModes }]) {
    expect(await records(saved.dir)).toEqual(saved.records);
    expect(await savedModes(saved.dir)).toEqual(saved.modes);
  }
  expect(await readFile(testPath)).toEqual(testContent);
  expect((await stat(testPath)).mode).toBe(testMode);
  expect(
    object(JSON.parse(await readFile(join(f.dir, 'verification/state.json'), 'utf8'))),
  ).toMatchObject({
    result: 'interrupted',
    active: { role: 'review' },
    checks: 1,
    review: 1,
    repair: 0,
  });
});

// #406 保証2・6・7: 祖先の実装済み記録を今回のPR修正へ流用しない。
testDevelopment('中断復帰公開後のPR修正テスト停止から未実施の修正へ復帰する', async (f) => {
  const t = await firstRecovery(f, 'revision');
  const root = dirname(f.dir);
  const published = t.dir;
  const retained = await Promise.all(
    [f.dir, published].map(async (dir) => ({
      dir,
      records: await records(dir),
      modes: await savedModes(dir),
    })),
  );
  const testPath = join(t.cwd, 'result.test.js');
  const testContent = await readFile(testPath);
  const testMode = (await stat(testPath)).mode;
  const revision = await followupArgs(t, root, 'revision');
  const executed = await roles(t.executions);
  await writeFile(t.control, JSON.stringify({ response: 'accepted', testHostRequired: true }));
  t.dir = join(root, 'published-revision-test-host-stop');
  t.args = [...revision, '--run-dir', t.dir];
  const stopped = await recoveryCli(f, t, {}, { observe: true, publication: true });
  expect(stopped.timedOut).toBe(false);
  expect(stopped.code, stopped.stderr).toBe(1);
  expect(stopped.stderr).toMatch(/Host verification required/);
  expect((await roles(t.executions)).slice(executed.length)).toEqual(['test']);
  await assert.rejects(readFile(join(t.cwd, 'README.md')), { code: 'ENOENT' });
  expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
    terminal: true,
    reasonCode: 'host_verification_required',
    publication: 'not_attempted',
  });
  const prior = t.dir;
  retained.push({ dir: prior, records: await records(prior), modes: await savedModes(prior) });
  const host = (await followupArgs(t, root, 'host')).filter((arg) => arg !== '--no-publish');
  await writeFile(
    t.control,
    JSON.stringify({
      response: 'accepted',
      requiredArtifact: { path: 'README.md', content: '要求した操作説明' },
    }),
  );
  const beforeReturn = await roles(t.executions);
  t.dir = join(root, 'published-revision-test-host-return');
  t.args = [...host, '--run-dir', t.dir];
  const returned = await recoveryCli(
    f,
    t,
    {},
    { observe: true, publication: true, allowImplementation: true },
  );
  expect(returned.timedOut).toBe(false);
  expect((await roles(t.executions)).slice(beforeReturn.length)).toEqual([
    'test',
    'repair',
    'check',
    'review',
    'push',
    'publish',
  ]);
  expect(returned.code, returned.stderr).toBe(0);
  expect(await readFile(join(t.cwd, 'README.md'), 'utf8')).toBe('要求した操作説明');
  expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
    publication: 'published',
  });
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state.result).toBe('ready_for_human_review');
  expect(state.active).toBeNull();
  for (const saved of retained) {
    expect(await records(saved.dir)).toEqual(saved.records);
    expect(await savedModes(saved.dir)).toEqual(saved.modes);
  }
  expect(await readFile(testPath)).toEqual(testContent);
  expect((await stat(testPath)).mode).toBe(testMode);
});

// #406 保証6・7: 照合済みの一件を通常の後続入口へ渡す。
for (const route of ['host', 'revision'] as const) {
  testDevelopment(
    `中断復帰後の通常${route}入口は保全履歴と他runの停止条件を維持する`,
    async (f) => {
      const t = await firstRecovery(f, route);
      const root = dirname(f.dir);
      const original = await records(f.dir);
      const originalModes = await savedModes(f.dir);
      const prior = t.dir;
      const priorRecords = await records(prior);
      const priorModes = await savedModes(prior);
      const args = await followupArgs(t, root, route);
      await writeFile(t.control, JSON.stringify({ response: 'accepted' }));
      await rejectedFollowups(f, t, route, args, prior, priorRecords, priorModes);
      const executed = await roles(t.executions);
      t.dir = join(root, `followup-${route}-normal`);
      t.args = [...args, '--run-dir', t.dir];
      const normal = await recoveryCli(
        f,
        t,
        {},
        { observe: true, publication: route === 'revision' },
      );
      expect(normal.timedOut).toBe(false);
      expect(normal.code, normal.stderr).toBe(0);
      const result = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
      expect(result.publication).toBe(route === 'host' ? 'not_attempted' : 'published');
      const state = object(
        JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
      );
      expect(state.result).toBe('ready_for_human_review');
      expect(state.active).toBeNull();
      const subsequent = (await roles(t.executions)).slice(executed.length);
      expect(subsequent).toEqual(
        route === 'host'
          ? ['test', 'check', 'review']
          : ['test', 'repair', 'check', 'review', 'push', 'publish'],
      );
      expect(await records(f.dir)).toEqual(original);
      expect(await savedModes(f.dir)).toEqual(originalModes);
      expect(await records(prior)).toEqual(priorRecords);
      expect(await savedModes(prior)).toEqual(priorModes);
      expect(
        object(JSON.parse(await readFile(join(f.dir, 'verification/state.json'), 'utf8'))),
      ).toMatchObject({
        result: 'interrupted',
        active: { role: 'review' },
        checks: 1,
        review: 1,
        repair: 0,
      });
    },
  );
}
