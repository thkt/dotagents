import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../../implement/host-records.ts';
import { snapshot } from '../../../implement/correction.ts';
import { object } from '../../support/correction.ts';
import { asset, assetSource, hostTestFixture } from '../../support/host-test-records.ts';
import { issue } from '../../support/development.ts';
import { records, testReviewRecovery } from '../../support/review-recovery.ts';
import { expectTestStage } from '../../support/test-stage.ts';

// Issue #373 要求2～4と採用済み修正要求: 外部準備記録の境界は旧run内の保全では代替できない。
// 正常なprepared/unnecessaryを対照とし、状態・要求・対象・由来・hash・資産を個別に壊す。
// CLI・後続抑止・原記録保全まで必要なため結合層を採用し、同じ比較の単体テストは増やさない。
// 末尾境界、稼働と終了後対照、停止・上限・保護は既存テストを維持する。
for (const status of ['prepared', 'unnecessary']) {
  testReviewRecovery(`公開host-runは外部準備記録を独立再判定へ渡す: ${status}`, async (f) => {
    const t = await hostTestFixture(f, status);
    const prior = await records(f.dir);
    const original = await records(t.external);
    const mode = status === 'prepared' ? (await stat(join(t.cwd, asset))).mode : null;
    await writeFile(t.evidenceFile, JSON.stringify(t.evidence));
    const outcome = await t.cli(t.args);
    expect(outcome.timedOut).toBe(false);
    assert.equal(outcome.code, 0, outcome.stderr);
    expect(object(JSON.parse(outcome.stdout))).toMatchObject({
      status: 'verified_local',
      publication: 'not_attempted',
    });
    const observations = (await readFile(t.observations, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
    expect(observations.map((entry) => entry.role)).toEqual(['test', 'repair', 'review']);
    expect(observations[0]).toMatchObject({
      result: 'old',
      asset: status === 'prepared' ? assetSource : null,
    });
    expect(observations[0]?.prompt).not.toContain('EXTERNAL_PRIVATE_SENTINEL');
    expect(observations[0]?.prompt).not.toContain('IMPLEMENTATION_PRIVATE_SENTINEL');
    assert(typeof observations[0]?.prompt === 'string');
    await expectTestStage(observations[0].prompt, join(t.dir, 'test-1'), 'host_return');
    const state = object(
      JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
    );
    expect(state).toMatchObject({
      checks: 1,
      review: 1,
      repair: 0,
      result: 'ready_for_human_review',
    });
    if (mode !== null) {
      expect(await readFile(join(t.cwd, asset), 'utf8')).toBe(assetSource);
      expect((await stat(join(t.cwd, asset))).mode).toBe(mode);
    }
    expect(await records(f.dir)).toEqual(prior);
    expect(await records(t.external)).toEqual(original);
  });
}

type Fixture = Awaited<ReturnType<typeof hostTestFixture>>;
async function saveRecord(t: Fixture) {
  await writeFile(t.recordPath, JSON.stringify(t.record));
  t.ref.sha256 = hash(await readFile(t.recordPath));
}
async function saveRaw(
  t: Fixture,
  suffix: string,
  update: (value: Record<string, unknown>) => void,
) {
  const path = `${t.prefix}.${suffix}`;
  const value = object(JSON.parse(await readFile(path, 'utf8')));
  update(value);
  await writeFile(path, JSON.stringify(value));
  const key = suffix === 'stdout' ? 'stdoutHash' : 'inputHash';
  t.record[key] = hash(await readFile(path));
  await saveRecord(t);
}

// 拒否理由を区別し、別の不正条件による停止は成功にしない。
// 欠落ではlogs/testRecordsを同じ欠落pathに揃え、参照不一致を混ぜない。
const failures: { name: string; reason: RegExp; change: (t: Fixture) => Promise<void> }[] = [
  {
    name: '準備未完了',
    reason: /prepared|unnecessary|status|準備|完了/i,
    change: async (t) => {
      t.record.status = 'needs_host';
      await saveRaw(t, 'stdout', (value) => {
        value.status = 'needs_host';
      });
    },
  },
  {
    name: '保留原応答の昇格',
    reason: /status|応答|prepared|needs_host|準備/i,
    change: async (t) => {
      await saveRaw(t, 'stdout', (value) => {
        value.status = 'needs_host';
      });
    },
  },
  {
    name: '固定Issue違い',
    reason: /issue|要求/i,
    change: async (t) => {
      // hashや対象IDの不正で先に止めず、別の固定要求に整合した原記録を与える。
      const originalTargetId = String(t.record.targetId);
      const otherIssue = JSON.stringify({
        title: 'Different agreed result',
        body: 'Keep old result.',
        state: 'OPEN',
        updatedAt: '1',
      });
      await saveRaw(t, 'target.json', (value) => {
        value.issue = otherIssue;
        const { targetId: _id, ...target } = value;
        value.targetId = hash(JSON.stringify(target));
        t.record.targetId = value.targetId;
      });
      await saveRaw(t, 'stdout', (value) => {
        value.targetId = t.record.targetId;
      });
      const promptPath = `${t.prefix}.prompt`;
      const prompt = await readFile(promptPath, 'utf8');
      assert(prompt.includes(issue));
      await writeFile(
        promptPath,
        prompt.replace(issue, otherIssue).replaceAll(originalTargetId, String(t.record.targetId)),
      );
      t.record.promptHash = hash(await readFile(promptPath));
      await saveRecord(t);
    },
  },
  {
    name: '対象ID違い',
    reason: /target|入力|対象/i,
    change: async (t) => {
      t.record.targetId = 'different-test-target';
      await saveRecord(t);
    },
  },
  {
    name: 'logs参照違い',
    reason: /logs|log|参照/i,
    change: async (t) => {
      t.evidence.logs = [
        { path: `${t.prefix}.stdout`, sha256: hash(await readFile(`${t.prefix}.stdout`)) },
      ];
    },
  },
  {
    name: '原記録欠落',
    reason: /ENOENT|missing|欠落/i,
    change: async (t) => {
      t.ref.path = join(t.external, 'missing-test.json');
    },
  },
  ...(['stdoutHash', 'inputHash', 'promptHash'] as const).map((key) => ({
    name: `${key}不一致`,
    reason:
      key === 'stdoutHash'
        ? /stdout|応答|response/i
        : key === 'inputHash'
          ? /input|入力|target/i
          : /prompt|指示/i,
    change: async (t: Fixture) => {
      t.record[key] = '0'.repeat(64);
      await saveRecord(t);
    },
  })),
  {
    name: '原応答と成果物申告の由来違い',
    reason: /files|成果物|応答|record|由来/i,
    change: async (t) => {
      // 原応答のhashは正しくするが、採用記録のfilesとは異なる原申告を与える。
      await saveRaw(t, 'stdout', (value) => {
        value.files = [];
      });
    },
  },
  {
    name: '現在のテスト内容違い',
    reason: /artifact|成果物|内容|テスト.*変更/i,
    change: async (t) => {
      await writeFile(join(t.cwd, asset), 'process.exit(0);\n');
    },
  },
  {
    name: '現在のテストモード違い',
    reason: /artifact|成果物|mode|モード|テスト.*変更/i,
    change: async (t) => {
      await chmod(join(t.cwd, asset), 0o644);
    },
  },
];

for (const failure of failures) {
  testReviewRecovery(`公開host-runは外部準備記録を拒否して保全する: ${failure.name}`, async (f) => {
    const t = await hostTestFixture(f);
    await failure.change(t);
    // ホスト証拠のsourceを現在版へ合わせ、資産の拒否をsnapshot違いで代替しない。
    t.evidence.source = await snapshot(t.cwd);
    await writeFile(t.evidenceFile, JSON.stringify(t.evidence));
    const prior = await records(f.dir);
    const original = await records(t.external);
    const source = await snapshot(t.cwd);
    const outcome = await t.cli(t.args);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|Unrecognized key.*testRecords|Unexpected publication/i,
    );
    expect(outcome.stderr).toMatch(failure.reason);
    expect(await readFile(t.observations, 'utf8')).toBe('');
    expect(await Bun.file(join(t.dir, 'implementation.prompt')).exists()).toBe(false);
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    expect(await Bun.file(join(t.dir, 'verification/review-1.stdout')).exists()).toBe(false);
    // 保存先の安全確認前の拒否は新runを作らない。保存済みなら停止・未公開を照合する。
    const resultPath = join(t.dir, 'result.json');
    if (await Bun.file(resultPath).exists()) {
      const result = object(JSON.parse(await readFile(resultPath, 'utf8')));
      expect(result).toMatchObject({ status: 'stopped', publication: 'not_attempted' });
    }
    expect(await snapshot(t.cwd)).toBe(source);
    expect(await records(f.dir)).toEqual(prior);
    expect(await records(t.external)).toEqual(original);
  });
}
