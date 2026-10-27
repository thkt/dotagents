import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { object, events } from '../../support/correction.ts';
import { formalTree } from '../../support/formal-host-return.ts';
import { localPublicationFixture } from '../../support/local-publication.ts';

type Fixture = Awaited<ReturnType<typeof localPublicationFixture>>;
const executionReason =
  /execution|implementation|process|check|review|実行|実装|終了|受入|検証|評価/i;
async function json(path: string) {
  return object(JSON.parse(await readFile(path, 'utf8')));
}
async function acceptance(f: Fixture) {
  expect(await json(join(f.prior, 'result.json'))).toMatchObject({
    status: 'verified_local',
    terminal: true,
    localOnly: true,
    publication: 'not_attempted',
  });
  const state = await json(join(f.prior, 'verification/state.json'));
  expect(state).toMatchObject({
    checks: 1,
    review: 1,
    active: null,
    result: 'ready_for_human_review',
  });
  expect(events(state.reviewHistory).map(object).at(-1)?.status).toBe('accepted');
  return state;
}
async function retained(f: Fixture) {
  return Promise.all([formalTree(f.prior, true), formalTree(f.checkout), formalTree(f.published)]);
}
async function rejected(f: Fixture) {
  const before = await retained(f);
  const result = await f.cli(f.args);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.doesNotMatch(
    result.stderr,
    /Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError|ReferenceError/,
  );
  assert.match(result.stderr, executionReason);
  // 終了だけでなく、新しい担当・check・公開の未起動と原本保全を要求する。
  const calls = await f.observations();
  expect(calls.filter((call) => call.role !== 'github')).toEqual([]);
  expect(
    calls.some(
      (call) =>
        Array.isArray(call.argv) && ['create', 'edit', 'ready'].includes(String(call.argv[2])),
    ),
  ).toBe(false);
  expect(await retained(f)).toEqual(before);
}

// #434の合意済み追加要求: 終端・accepted・checkの成功や採用時hashだけでは、
// events外の初回実装の失敗・不明を成功へ変換できない。ms=0は成否の代用にしない。
for (const [name, execution] of [
  ['非zero終了', { code: 1, timedOut: false, ms: 0 }],
  ['終了code不明', { code: null, timedOut: false, ms: 0 }],
  ['終了0とtimeoutの矛盾', { code: 0, timedOut: true, ms: 0 }],
  ['実行結果欠落', null],
] as const) {
  test(`単独公開の実行整合 初回実装の${name}は旧成功へ固定しない`, async () => {
    const f = await localPublicationFixture();
    try {
      const state = await acceptance(f);
      expect(
        events(state.events)
          .map(object)
          .map((event) => event.role),
      ).toEqual(['check', 'review']);
      const path = join(f.prior, 'implementation.json');
      expect(await json(path)).toMatchObject({ code: 0, timedOut: false });
      const originalState = await readFile(join(f.prior, 'verification/state.json'));
      if (execution === null) {
        await rm(path);
      } else {
        await writeFile(path, JSON.stringify(execution));
      }
      expect(await readFile(join(f.prior, 'verification/state.json'))).toEqual(originalState);
      await acceptance(f);
      await rejected(f);
    } finally {
      await f.dispose();
    }
  }, 60000);
}

// stateの受入要約と、その成功を支える実行結果の矛盾も別の境界で確認する。
for (const [role, code] of [
  ['check', 1],
  ['review', null],
] as const) {
  test(`単独公開の実行整合 ${role}の終了${String(code)}とacceptedの矛盾を拒否する`, async () => {
    const f = await localPublicationFixture();
    try {
      const state = await acceptance(f);
      const entries = events(state.events).map(object);
      const event = entries.find((entry) => entry.role === role);
      assert(event);
      expect(event).toMatchObject({ code: 0, timedOut: false });
      event.code = code;
      await writeFile(
        join(f.prior, 'verification/state.json'),
        JSON.stringify({ ...state, events: entries }),
      );
      await acceptance(f);
      await rejected(f);
    } finally {
      await f.dispose();
    }
  }, 60000);
}

async function accepted(f: Fixture) {
  const before = await retained(f);
  const result = await f.cli(f.args);
  assert.equal(result.code, 0, result.stderr);
  expect(object(JSON.parse(result.stdout))).toMatchObject({
    status: 'published_draft',
    url: f.pr.url,
  });
  const calls = await f.observations();
  expect(
    calls
      .filter((call) => ['test', 'repair', 'review'].includes(String(call.role)))
      .map((call) => call.role),
  ).toEqual(['test', 'repair', 'review']);
  expect(calls.some((call) => call.role === 'check')).toBe(true);
  // 新しい修正で公開checkoutは変わるが、元runと旧checkoutは変えない。
  expect((await retained(f)).slice(0, 2)).toEqual(before.slice(0, 2));
}

test('単独公開の実行整合 終了0・非timeoutなら実装時間0でも新しい検証へ進む', async () => {
  const f = await localPublicationFixture();
  try {
    await writeFile(
      join(f.prior, 'implementation.json'),
      JSON.stringify({ code: 0, timedOut: false, ms: 0 }),
    );
    await acceptance(f);
    await accepted(f);
  } finally {
    await f.dispose();
  }
}, 60000);

test('単独公開の実行整合 過去の中断予約と不明量を保持して復帰後の成功を採用する', async () => {
  const f = await localPublicationFixture(undefined, true);
  try {
    const path = join(f.initial, 'verification/state.json');
    const original = await readFile(path, 'utf8');
    const state = object(JSON.parse(original));
    expect(state).toMatchObject({
      result: 'interrupted',
      review: 1,
      reviewHistory: [],
      active: { role: 'review' },
    });
    expect(
      events(state.events)
        .map(object)
        .some((event) => event.role === 'review'),
    ).toBe(false);
    const config = await json(join(f.prior, 'verification-config.json'));
    const history = object(config.reviewReturn);
    const interruption = object(history.interruption);
    expect(interruption.state).toBe(original);
    expect(interruption.unknown).toBe('中断区間の時間・usageは未記録。累計は記録済み量の下限');
    expect(await json(join(f.initial, 'implementation.json'))).toMatchObject({
      code: 0,
      timedOut: false,
    });
    await acceptance(f);
    const before = await formalTree(f.initial, true);
    await accepted(f);
    expect(await formalTree(f.initial, true)).toEqual(before);
    // 採用来歴から成功前の中断と未記録量を引き続き辿れることを要求する。
    expect(await readFile(join(f.dir, 'verification-config.json'), 'utf8')).toContain(f.prior);
  } finally {
    await f.dispose();
  }
}, 60000);
