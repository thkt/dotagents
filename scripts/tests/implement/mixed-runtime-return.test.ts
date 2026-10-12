import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expect } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { develop } from '../../implement/orchestrator.ts';
import { snapshot } from '../../implement/correction.ts';
import { object } from '../support/correction.ts';
import type { DevelopmentFixture } from '../support/development.ts';
import { records, recoveryFixture, testReviewRecovery } from '../support/review-recovery.ts';
import {
  expectActorAssociation,
  expectActorReference,
  saveActorRecord,
} from '../support/actor-records.ts';

const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

async function mixedReturn(f: DevelopmentFixture) {
  const implementation = f.implement;
  const test = f.test;
  let ancestor = '';
  f.implement = async (...args) => {
    const response = await implementation(...args);
    assert(args[4]);
    if (args[4] === join(f.dir, 'implementation')) {
      ancestor = await saveActorRecord(f.dir, args[4], 'repair', 'mixed-ancestor');
    }
    return response;
  };
  const t = await recoveryFixture(f);
  // 復帰では転送済みテストを維持し、変更なしをfiles: []で申告します。
  f.test = test;
  const ancestorContent = await readFile(ancestor, 'utf8');
  const before = await records(f.dir);
  await writeFile(t.control, JSON.stringify({ response: 'needs_changes', hostRequired: true }));
  const verify = f.verify;
  let intermediate = '';
  f.verify = async (config, publicationHead) => {
    const state = await verify(config, publicationHead);
    if (config.runDir === join(t.dir, 'verification')) {
      expect(state.result).toBe('host_verification_required');
      intermediate = await saveActorRecord(
        config.runDir,
        join(config.runDir, 'repair-1'),
        'repair',
        'mixed-intermediate',
      );
    }
    return state;
  };
  await assert.rejects(() => develop(t.args, f.io), /Host verification required/);
  expect(await records(f.dir)).toEqual(before);
  expect(ancestor).not.toBe('');
  expect(intermediate).not.toBe('');
  expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
    status: 'stopped',
    reasonCode: 'host_verification_required',
    publication: 'not_attempted',
  });
  const config = object(
    JSON.parse(await readFile(join(t.dir, 'verification-config.json'), 'utf8')),
  );
  expect(object(config.reviewReturn).previousRun).toBe(f.dir);
  await writeFile(t.control, JSON.stringify({ response: 'accepted' }));
  const log = join(dirname(f.dir), 'mixed-measurement.stdout');
  const logContent = '合成ホスト証拠。実環境の検証結果ではありません。';
  await writeFile(log, logContent);
  const evidence = join(dirname(f.dir), 'mixed-measurement.json');
  await writeFile(
    evidence,
    JSON.stringify({
      status: 'passed',
      source: await snapshot(t.cwd),
      findings: '固定fixtureのホスト復帰入力。runtimeを要約せず原記録を参照します。',
      logs: [{ path: log, sha256: sha256(logContent) }],
    }),
  );
  const dir = join(dirname(f.dir), 'mixed-host-return');
  const args = [
    '99',
    '--repo',
    t.cwd,
    '--host-run',
    t.dir,
    '--host-evidence',
    evidence,
    '--run-dir',
    dir,
    '--no-publish',
  ];
  return { t, ancestor, ancestorContent, intermediate, dir, args };
}

testReviewRecovery(
  '混在復帰は新checkと評価へ進み旧runと原記録のhash・工程対応を保つ',
  async (f) => {
    const m = await mixedReturn(f);
    const ancestorBefore = await records(f.dir);
    const intermediateBefore = await records(m.t.dir);
    const executionsBefore = await readFile(m.t.executions, 'utf8');
    expect((await develop(m.args, f.io)).status).toBe('verified_local');
    expect(await readFile(m.t.executions, 'utf8')).toBe(executionsBefore + 'check\nreview\n');
    expect(await records(f.dir)).toEqual(ancestorBefore);
    expect(await records(m.t.dir)).toEqual(intermediateBefore);
    const prefix = join(m.dir, 'verification/review-1');
    const target: unknown = JSON.parse(await readFile(`${prefix}.target.json`, 'utf8'));
    await expectActorReference(target, m.ancestor);
    expectActorAssociation(target, m.ancestor, f.dir, 'implementation', 'repair');
    await expectActorReference(target, m.intermediate);
    expectActorAssociation(target, m.intermediate, m.t.dir, 'verification/repair-1', 'repair');
    expect(await readFile(`${prefix}.prompt`, 'utf8')).toContain(`${prefix}.target.json`);
    expect(await readFile(m.ancestor, 'utf8')).toBe(m.ancestorContent);
    expect(f.calls.publications).toBe(0);
    expect(f.calls.pushes).toBe(0);
  },
);

testReviewRecovery('混在復帰はホスト停止後の祖先actorだけの改変で後続起動を止める', async (f) => {
  const m = await mixedReturn(f);
  const record = object(JSON.parse(m.ancestorContent));
  object(object(record.runtime).cli).version = { value: 'changed-after-mixed-stop', reason: null };
  const changed = JSON.stringify(record);
  expect(sha256(changed)).not.toBe(sha256(m.ancestorContent));
  await writeFile(m.ancestor, changed);
  // 形式・工程対応・成果物・証拠を固定し、祖先の内容だけを変えます。
  const ancestorBefore = await records(f.dir);
  const intermediateBefore = await records(m.t.dir);
  const executionsBefore = await readFile(m.t.executions, 'utf8');
  const callsBefore = { ...f.calls };
  const outcome: unknown = await develop(m.args, f.io).catch((error: unknown) => error);
  expect(await readFile(m.t.executions, 'utf8')).toBe(executionsBefore);
  expect(f.calls.verificationEntries).toBe(callsBefore.verificationEntries);
  expect(f.calls.tests).toBe(callsBefore.tests);
  expect(f.calls.implementations).toBe(callsBefore.implementations);
  expect(await records(f.dir)).toEqual(ancestorBefore);
  expect(await records(m.t.dir)).toEqual(intermediateBefore);
  expect(await readFile(m.ancestor, 'utf8')).toBe(changed);
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toMatch(/chang|hash|変更|変化|不一致|変わ/i);
  expect(String(outcome)).toMatch(/runtime|actor|原記録|旧.*run|記録/i);
  expect(f.calls.publications).toBe(0);
  expect(f.calls.pushes).toBe(0);
});
