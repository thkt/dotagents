import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { chmod, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../../implement/host-records.ts';
import { object, events } from '../../support/correction.ts';
import { testDevelopment } from '../../support/development.ts';
import type { DevelopmentFixture } from '../../support/development.ts';
import { formalTree } from '../../support/formal-host-return.ts';
import { localPublicationOrigin } from '../../support/local-publication-origin.ts';
import { git } from '../../support/target.ts';

type Origin = Awaited<ReturnType<typeof localPublicationOrigin>>;
const json = async (path: string) => object(JSON.parse(await readFile(path, 'utf8')));
function scenario(name: string, human: boolean, run: (t: Origin) => Promise<void>) {
  testDevelopment(
    `単独公開の正式来歴 ${name}`,
    async (f: DevelopmentFixture) => {
      const t = await localPublicationOrigin(f, human);
      await run(t);
    },
    {},
    60000,
  );
}

for (const human of [false, true]) {
  const name = human ? '人の補足判断' : '正式ホスト復帰';
  scenario(`来歴準備 ${name}は原応答と実行成功を対応させて受け入れる`, human, async (t) => {
    const before = await t.retained();
    const run = t.lineage.r1;
    const actorName = (await readdir(run)).find((name) => name.startsWith('repair-codex-'));
    assert(actorName);
    const actorDir = join(run, actorName);
    const actor = await json(join(actorDir, 'actor.json'));
    expect(actor).toMatchObject({ role: 'repair', hostPrefix: 'implementation' });
    const reply = await readFile(join(actorDir, 'final.json'), 'utf8');
    expect(reply).toBe((await readFile(join(run, 'implementation.stdout'), 'utf8')).trim());
    expect(object(JSON.parse(reply)).status).toBe('needs_host');
    expect(await readFile(join(actorDir, 'events.jsonl'), 'utf8')).toContain('turn.completed');
    expect(await json(t.implementation)).toMatchObject({ code: 0, timedOut: false });
    expect((await json(t.implementation)).ms).toBeGreaterThanOrEqual(0);
    const config = await json(join(t.prior, 'verification-config.json'));
    const interruption = object(object(config.hostReturn).testInterruption);
    expect(object(interruption.record).execution).toEqual({
      code: null,
      ms: null,
      usage: 'unknown',
    });
    if (t.decision) {
      assert(Array.isArray(t.decision.records));
      for (const name of ['test-1.target.json', 'test-1-workspace.json', 'implementation.json']) {
        expect(t.decision.roots).toContain(join(t.lineage.r1, name));
      }
      expect(t.decision.roots).toContain(t.host.evidenceFile);
    }
    expect(git(t.published, 'show', 'HEAD:result.txt')).toBe('implemented');
    expect(git(t.published, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(await t.observations()).toEqual([]);
    expect(await t.retained()).toEqual(before);
  });

  scenario(`${name}を採用し同じPRの新しい修正と検証へ進む`, human, async (t) => {
    const before = await t.retained();
    const original = await json(t.implementation);
    const result = await t.cli(t.args);
    assert.equal(result.code, 0, result.stderr);
    expect(result.timedOut).toBe(false);
    expect(object(JSON.parse(result.stdout))).toMatchObject({
      status: 'published_draft',
      url: t.pr.url,
      branch: t.pr.headRefName,
    });
    const calls = await t.observations();
    const actors = calls.filter((call) => ['test', 'repair', 'review'].includes(String(call.role)));
    expect(actors.map((call) => call.role)).toEqual(['test', 'repair', 'review']);
    const input = object(
      JSON.parse(String(actors[0]?.prompt).split('入力: ')[1]?.split('\n')[0] ?? ''),
    );
    expect(input.stage).toBe('revision');
    expect(String(actors[1]?.prompt)).toContain(await readFile(t.request, 'utf8'));
    expect(actors[1]?.cwd).toBe(t.published);
    expect(await readFile(join(t.published, 'revision.txt'), 'utf8')).toBe('new correction');
    expect(calls.some((call) => call.role === 'check')).toBe(true);
    expect(calls.filter((call) => call.role === 'push')).toHaveLength(1);
    expect(calls.findIndex((call) => call.role === 'push')).toBeGreaterThan(
      calls.findIndex((call) => call.role === 'review'),
    );
    const mutations = calls.filter(
      (call) =>
        Array.isArray(call.argv) && ['create', 'edit', 'ready'].includes(String(call.argv[2])),
    );
    expect(mutations.length).toBeGreaterThan(0);
    for (const call of mutations) {
      expect(call.argv).toContain('edit');
      expect(call.argv).toContain(t.pr.url);
      expect(calls.indexOf(call)).toBeGreaterThan(
        calls.findIndex((call) => call.role === 'review'),
      );
    }
    const config = await readFile(join(t.dir, 'verification-config.json'), 'utf8');
    expect(config).toContain(t.prior);
    expect(config).toContain(t.lineage.cwd);
    expect(config).toContain(t.published);
    // 新しい修正の成功で、旧初回実装の時間や旧中断の不明値を置換しない。
    expect(await json(t.implementation)).toEqual(original);
    expect(await t.retained()).toEqual(before);
  });
}

async function rejected(t: Origin, reason: RegExp) {
  const before = await t.retained();
  const publicBefore = await formalTree(t.published);
  const result = await t.cli(t.args);
  expect(result.timedOut).toBe(false);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.doesNotMatch(
    result.stderr,
    /Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError|ReferenceError/,
  );
  assert.match(result.stderr, reason);
  const calls = await t.observations();
  expect(calls.filter((call) => call.role !== 'github')).toEqual([]);
  expect(
    calls.some(
      (call) =>
        Array.isArray(call.argv) && ['create', 'edit', 'ready'].includes(String(call.argv[2])),
    ),
  ).toBe(false);
  expect(await t.retained()).toEqual(before);
  expect(await formalTree(t.published)).toEqual(publicBefore);
}

for (const defect of ['content', 'mode', 'missing'] as const) {
  scenario(`保全済み通常証拠ファイルの${defect}不一致では後続を起動しない`, true, async (t) => {
    assert(t.decision && Array.isArray(t.decision.records));
    const path = join(t.lineage.r1, 'test-1.stdout');
    const record = t.decision.records.map(object).find((record) => record.path === path);
    assert(record);
    expect(record).toMatchObject({
      kind: 'file',
      mode: (await lstat(path)).mode,
      value: hash(await readFile(path)),
    });
    if (defect === 'mode') {
      await chmod(path, ((await lstat(path)).mode & 0o7777) ^ 0o100);
    } else if (defect === 'missing') {
      await rm(path);
    } else {
      const reply = await json(path);
      await writeFile(path, JSON.stringify({ ...reply, findings: 'changed after acceptance' }));
    }
    await rejected(t, /原記録|証拠|変更|不一致|欠落|保全|hash|record|mode|integrity|ENOENT/i);
  });
}

for (const [name, execution] of [
  ['欠落', null],
  ['非zero終了', { code: 1, timedOut: false, ms: 1 }],
  ['終了不明', { code: null, timedOut: false, ms: null }],
  ['時間切れ', { code: 0, timedOut: true, ms: 1 }],
] as const) {
  scenario(`祖先の真正な初回実装が${name}なら受入要約から成功を推定しない`, true, async (t) => {
    const state = await json(join(t.prior, 'verification/state.json'));
    expect(
      events(state.events)
        .map(object)
        .some((event) => event.role === 'repair'),
    ).toBe(false);
    expect(await json(t.implementation)).toMatchObject({ code: 0, timedOut: false });
    if (execution === null) {
      await rm(t.implementation);
    } else {
      await writeFile(t.implementation, JSON.stringify(execution));
    }
    await rejected(
      t,
      /実装|実行|受入|原記録|変更|不一致|欠落|保全|implementation|execution|hash|record|integrity|ENOENT/i,
    );
  });
}
