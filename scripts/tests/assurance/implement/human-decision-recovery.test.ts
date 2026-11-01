import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { chmod, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hash } from '../../../implement/host-records.ts';
import { command } from '../../../shared/process.ts';
import { object } from '../../support/correction.ts';
import { issue } from '../../support/development.ts';
import type { DevelopmentFixture } from '../../support/development.ts';
import { formalHostFixture, formalTree } from '../../support/formal-host-return.ts';
import { testReviewRecovery } from '../../support/review-recovery.ts';
import publicContract from '../../fixtures/human-decision-recovery/public-contract.json';
import { contractArgs } from '../../support/human-decision-contract.ts';

async function humanStop(f: DevelopmentFixture, testHuman = true) {
  const lineage = await formalHostFixture(f, { producer: '430' });
  await writeFile(
    lineage.control,
    JSON.stringify({ phase: testHuman ? 'accept' : 'test-stop', testHuman }),
  );
  const host = await lineage.intake(lineage.r1, 'historical-human-stop');
  const stopped = await lineage.generateCli(host.args);
  assert.equal(stopped.code, 1, stopped.stderr);
  expect(stopped.timedOut).toBe(false);
  expect(stopped.stderr).toContain(
    testHuman ? 'human_decision_required' : 'host_verification_required',
  );
  expect(object(JSON.parse(await readFile(join(host.dir, 'result.json'), 'utf8')))).toMatchObject({
    terminal: true,
    operation: 'independent test authoring',
    reasonCode: testHuman ? 'human_decision_required' : 'host_verification_required',
    publication: 'not_attempted',
  });
  const input = object(JSON.parse(await readFile(join(host.dir, 'test-1.target.json'), 'utf8')));
  expect(input.stage).toBe('host_return');
  expect(object(JSON.parse(await readFile(join(host.dir, 'test-1.stdout'), 'utf8')))).toMatchObject(
    {
      targetId: input.targetId,
      status: testHuman ? 'needs_human' : 'needs_host',
      files: [],
    },
  );
  expect(
    object(JSON.parse(await readFile(join(host.dir, 'test-1.execution.json'), 'utf8'))),
  ).toMatchObject({
    code: 0,
    timedOut: false,
  });
  const actors = (await readdir(host.dir)).filter((name) => name.startsWith('test-codex-'));
  expect(actors).toHaveLength(1);
  const actorDir = join(host.dir, actors[0] ?? '');
  const actor = object(JSON.parse(await readFile(join(actorDir, 'actor.json'), 'utf8')));
  expect(actor).toMatchObject({ role: 'test', hostPrefix: 'test-1' });
  expect(object(object(object(actor.runtime).harness).codeHash)).toEqual({
    value: 'ad74122959a9d199a51f34c1b2040c22cf63396aea7ae0a7cb2113c29b2b632a',
    reason: null,
  });
  expect(
    object(JSON.parse(await readFile(join(actorDir, 'fixture-invocation.json'), 'utf8'))),
  ).toMatchObject({
    role: 'test',
    cwd: join(host.dir, 'test-1-workspace'),
    prompt: await readFile(join(host.dir, 'test-1.prompt'), 'utf8'),
  });
  expect(await formalTree(f.dir)).toEqual(lineage.savedOrigin);
  return { lineage, host, input };
}

async function decision(f: DevelopmentFixture, stopped: string, cwd: string) {
  const file = join(dirname(f.dir), 'adopted-agreement.json');
  const agreement = {
    format: 1,
    issue: `https://github.com/${f.settings.repository}/issues/99`,
    issueUpdatedAt: '1',
    issueSha256: hash(issue),
    source: '人が採用した模擬合意記録: decision-fixture-425',
    content: 'ADOPTED_SUPPLEMENT_425: 正式停止後は独立判断を行い、初回実装を繰り返さない。',
    decision: 'この補足を対象Issueの版1へ適用する模擬判断。',
  };
  await writeFile(file, JSON.stringify(agreement));
  const dir = join(dirname(f.dir), 'human-return');
  assert.deepEqual(
    Object.keys(agreement).sort(),
    Object.keys(publicContract.supplementWire).sort(),
  );
  const values: Record<string, string> = {
    ISSUE_NUMBER: '99',
    CURRENT_CHECKOUT: cwd,
    LATEST_ELIGIBLE_STOP: stopped,
    EXTERNAL_REGULAR_SUPPLEMENT_JSON: file,
    UNUSED_SIBLING_RUN: dir,
  };
  const args = contractArgs(values);
  return { args, dir, file, agreement };
}

testReviewRecovery(
  '固定producerで真正なhost_returnの変更なし判断待ちを生成する正常対照',
  async (f) => {
    const { lineage, host } = await humanStop(f);
    expect(
      typeof object(JSON.parse(await readFile(join(host.dir, 'test-1.execution.json'), 'utf8'))).ms,
    ).toBe('number');
    expect((await lineage.observations()).filter((call) => call.role === 'repair')).toHaveLength(1);
    const actor = (await readdir(host.dir)).find((name) => name.startsWith('test-codex-'));
    assert(actor);
    expect(await readFile(join(host.dir, actor, 'final.json'), 'utf8')).toBe(
      (await readFile(join(host.dir, 'test-1.stdout'), 'utf8')).trim(),
    );
  },
);

testReviewRecovery('正式復帰fixtureは各担当へ渡した標準入力の全文を記録する', async (f) => {
  const { lineage, host } = await humanStop(f);
  const t = await decision(f, host.dir, lineage.cwd);
  await writeFile(lineage.control, JSON.stringify({ phase: 'accept' }));
  const targetRecord = join(dirname(lineage.control), 'recorder-target.json');
  await writeFile(targetRecord, JSON.stringify({ files: [['result.txt', 0o100644]] }));
  const context = { targetId: 'a'.repeat(64), targetRecord, previous: null };
  const before = (await lineage.observations()).length;
  const prompts = [];
  for (const role of ['test', 'review', 'repair']) {
    const prompt = [
      role === 'test'
        ? await readFile(join(host.dir, 'test-1.prompt'), 'utf8')
        : `ホストコンテキスト: ${JSON.stringify(context)}`,
      t.agreement.content,
      t.agreement.source,
      t.agreement.decision,
      'Show the requested result.',
      '',
    ].join('\n');
    prompts.push({ role, prompt });
    const result = await command(
      [process.execPath, join(dirname(lineage.control), 'formal-producer.js'), role],
      lineage.cwd,
      prompt,
      10000,
    );
    assert.equal(result.code, 0, result.stderr);
    expect(result.timedOut).toBe(false);
    const reply = object(JSON.parse(result.stdout));
    if (role === 'review') {
      expect(reply.targetId).toBe(context.targetId);
    } else {
      expect(reply.status).toBe(role === 'test' ? 'unnecessary' : 'needs_host');
    }
  }
  expect(
    (await lineage.observations()).slice(before).map(({ role, prompt }) => ({ role, prompt })),
  ).toEqual(prompts);
});

for (const outcome of ['accepted', 'stopped', 'repair'] as const) {
  const stopAgain = outcome === 'stopped';
  testReviewRecovery(
    `補足合意の専用復帰は新独立判断後だけ進み初回実装を繰り返さない: ${outcome}`,
    async (f) => {
      const { lineage, host, input } = await humanStop(f);
      const t = await decision(f, host.dir, lineage.cwd);
      const saved = await formalTree(host.dir, true);
      const ancestor = await formalTree(lineage.r1, true);
      const before = (await lineage.observations()).length;
      await writeFile(
        lineage.control,
        JSON.stringify({ phase: outcome === 'repair' ? 'repair' : 'accept', testHuman: stopAgain }),
      );
      const result = await lineage.cli(t.args);
      expect(result.timedOut).toBe(false);
      assert.equal(result.code, outcome === 'accepted' ? 0 : 1, result.stderr);
      const calls = (await lineage.observations()).slice(before);
      expect(calls.map((call) => call.role)).toEqual(
        stopAgain
          ? ['test']
          : outcome === 'repair'
            ? ['test', 'check', 'review', 'test', 'repair']
            : ['test', 'check', 'review'],
      );
      const test = calls[0];
      assert(test);
      expect(object(test.input)).toMatchObject({
        stage: 'host_return',
        baseCommit: input.baseCommit,
      });
      expect(test.result).toBe('old');
      expect(test.oldAsset).toBe(false);
      for (const call of calls.filter(
        (call) => call.role === 'test' || call.role === 'review' || call.role === 'repair',
      )) {
        const prompt = String(call.prompt);
        for (const value of [t.agreement.content, t.agreement.source, t.agreement.decision]) {
          expect(prompt).toContain(value);
        }
        expect(prompt).toContain('Show the requested result.');
      }
      expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject(
        stopAgain
          ? { reasonCode: 'human_decision_required', publication: 'not_attempted' }
          : outcome === 'repair'
            ? { reasonCode: 'host_verification_required', publication: 'not_attempted' }
            : { status: 'verified_local', publication: 'not_attempted' },
      );
      expect(await formalTree(host.dir, true)).toEqual(saved);
      expect(await formalTree(lineage.r1, true)).toEqual(ancestor);
      expect(await formalTree(f.dir)).toEqual(lineage.savedOrigin);
    },
  );
}

for (const field of ['issue', 'issueUpdatedAt', 'issueSha256'] as const) {
  testReviewRecovery(`補足合意の対象Issue・版不一致を後続起動前に拒否する: ${field}`, async (f) => {
    const { lineage, host } = await humanStop(f);
    const t = await decision(f, host.dir, lineage.cwd);
    const wrong = {
      ...t.agreement,
      [field]: {
        issue: `https://github.com/${f.settings.repository}/issues/100`,
        issueUpdatedAt: '2',
        issueSha256: '0'.repeat(64),
      }[field],
    };
    await writeFile(t.file, JSON.stringify(wrong));
    const saved = await formalTree(host.dir);
    const before = await lineage.observations();
    const result = await lineage.cli(t.args);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/supplement|補足|Issue|issue/);
    expect(result.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|ReferenceError|ENOENT/,
    );
    expect(await lineage.observations()).toEqual(before);
    expect(await formalTree(host.dir)).toEqual(saved);
    expect(await formalTree(f.dir)).toEqual(lineage.savedOrigin);
  });
}

for (const defect of ['host-stop', 'response-content', 'response-mode'] as const) {
  testReviewRecovery(
    `専用復帰は正式ホスト停止の流用と旧原応答の変化を拒否する: ${defect}`,
    async (f) => {
      const { lineage, host } = await humanStop(f, defect !== 'host-stop');
      const stopped = host;
      if (defect !== 'host-stop') {
        // 旧producerに保存のないmodeは推定せず、既に保全された祖先の原応答へ注入する。
        const path = join(defect === 'response-mode' ? f.dir : host.dir, 'test-1.stdout');
        if (defect === 'response-content') {
          const reply = object(JSON.parse(await readFile(path, 'utf8')));
          await writeFile(path, JSON.stringify({ ...reply, findings: 'changed after stop' }));
        } else {
          await chmod(path, 0o700);
        }
      }
      const t = await decision(f, stopped.dir, lineage.cwd);
      const saved = await formalTree(stopped.dir);
      const savedOrigin = await formalTree(f.dir);
      const before = await lineage.observations();
      const result = await lineage.cli(t.args);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|ReferenceError|ENOENT/,
      );
      expect(result.stderr).toMatch(
        /human|判断|応答|停止|保全|mode|changed|mismatch|record|integrity/i,
      );
      expect(await lineage.observations()).toEqual(before);
      expect(await formalTree(stopped.dir)).toEqual(saved);
      expect(await formalTree(f.dir)).toEqual(savedOrigin);
    },
  );
}

// #432の受付条件は正式ホスト復帰とは別の公開入口でも必要。
// 正常対照は上のacceptedケースとし、観測不能を安全確認済みへ読み替えない。
for (const observation of ['live', 'unavailable', 'remote', 'pr'] as const) {
  testReviewRecovery(
    `判断待ちからの専用復帰も外部観測で後続を抑止する: ${observation}`,
    async (f) => {
      const { lineage, host } = await humanStop(f);
      const t = await decision(f, host.dir, lineage.cwd);
      const saved = await formalTree(host.dir, true);
      const ancestor = await formalTree(lineage.r1, true);
      const current = await formalTree(lineage.cwd);
      const before = await lineage.observations();
      await writeFile(lineage.control, JSON.stringify({ phase: 'accept', observation }));
      const result = await lineage.cli(t.args);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|ReferenceError|ENOENT/,
      );
      expect(result.stderr).toMatch(
        observation === 'live' || observation === 'unavailable'
          ? /process|プロセス|観測/i
          : /remote|公開|pull|PR|branch/i,
      );
      expect(await lineage.observations()).toEqual(before);
      expect(await formalTree(host.dir, true)).toEqual(saved);
      expect(await formalTree(lineage.r1, true)).toEqual(ancestor);
      expect(await formalTree(lineage.cwd)).toEqual(current);
      expect(await formalTree(f.dir)).toEqual(lineage.savedOrigin);
    },
  );
}

for (const boundary of ['check', 'review'] as const) {
  testReviewRecovery(
    `判断待ちからの復帰でも${boundary}中の祖先mode変化を成功受入前に止める`,
    async (f) => {
      const { lineage, host } = await humanStop(f);
      const t = await decision(f, host.dir, lineage.cwd);
      const path = join(f.dir, 'test-1.stdout');
      const original = await readFile(path);
      expect((await lstat(path)).mode & 0o7777).not.toBe(0o700);
      const before = (await lineage.observations()).length;
      await writeFile(
        lineage.control,
        JSON.stringify({
          phase: 'accept',
          [boundary === 'check' ? 'changeCheck' : 'changeReview']: path,
        }),
      );
      const result = await lineage.cli(t.args);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|ReferenceError|ENOENT/,
      );
      expect((await lineage.observations()).slice(before).map((call) => call.role)).toEqual(
        boundary === 'check' ? ['test', 'check'] : ['test', 'check', 'review'],
      );
      const state = object(
        JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
      );
      expect(state).toMatchObject({
        result: 'host_evidence_changed',
        review: boundary === 'check' ? 0 : 1,
        repair: 0,
      });
      expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
        status: 'stopped',
        terminal: true,
        publication: 'not_attempted',
      });
      expect(String(state.findings)).toMatch(/変更|変化|mode|モード|不一致/i);
      expect(await readFile(path)).toEqual(original);
      expect((await lstat(path)).mode & 0o7777).toBe(0o700);
    },
  );
}
