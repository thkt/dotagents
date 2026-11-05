import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeRecords } from '../../../implement/runtime-records.ts';
import { correctionConfig } from '../../support/correction.ts';
import { saveActorRecord } from '../../support/actor-records.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// 収集層だけのfixture。保存設定の全体妥当性・公開CLIとの接続は結合テストが担う。
async function history(shared: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-history-'));
  roots.push(root);
  const ancestor = join(root, 'ancestor');
  const revision = join(root, 'revision');
  const current = join(root, 'current');
  const paths = [];
  for (const dir of [ancestor, revision, current]) {
    await mkdir(dir);
    await writeFile(join(dir, 'implementation.stdout'), '保存済み修正応答');
    paths.push(await saveActorRecord(dir, join(dir, 'implementation'), 'repair', 'saved'));
  }
  await writeFile(join(ancestor, 'verification-config.json'), '{}');
  await writeFile(
    join(revision, 'verification-config.json'),
    JSON.stringify({
      reviewReturn: { previousRun: ancestor },
    }),
  );
  await writeFile(
    join(current, 'verification-config.json'),
    JSON.stringify({
      hostReturn: { previousRun: revision },
      ...(shared ? { reviewReturn: { previousRun: ancestor } } : {}),
    }),
  );
  return {
    config: { ...correctionConfig(root), runDir: join(current, 'verification') },
    paths,
    ancestor,
    revision,
    current,
  };
}

// #406 保証2・5・7: 同じ既知祖先への参照合流は循環ではなく、同じ工程を二重計上しない。
for (const shared of [false, true]) {
  test(`復帰履歴のactor原記録は${shared ? '共有祖先でも' : '直線の正常対照で'}各工程を一度だけ保持する`, async () => {
    const t = await history(shared);
    const records = await runtimeRecords(t.config);
    expect(records).toHaveLength(3);
    for (const path of t.paths) {
      const expectedHash = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      const matching = records.filter((record) => record.path === path);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({ sha256: expectedHash, role: 'repair', reason: null });
    }
  });
}

for (const self of [true, false]) {
  test(`復帰履歴の${self ? '自己参照' : '祖先への逆辺'}は真の循環として拒否する`, async () => {
    const t = await history(false);
    await writeFile(
      join(t.ancestor, 'verification-config.json'),
      JSON.stringify({
        hostReturn: { previousRun: self ? t.ancestor : t.current },
      }),
    );
    await assert.rejects(() => runtimeRecords(t.config), /循環|cycl/i);
    // 拒否時にも注入した履歴と原記録を収集側が変更しない。
    expect(
      JSON.parse(await readFile(join(t.ancestor, 'verification-config.json'), 'utf8')),
    ).toEqual({
      hostReturn: { previousRun: self ? t.ancestor : t.current },
    });
    for (const path of t.paths) {
      expect(await readFile(path, 'utf8')).toContain('fixture-model');
    }
  });
}
