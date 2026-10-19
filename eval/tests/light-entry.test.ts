import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'bun:test';

// #409の削除契約。旧入口を転送として残すことも認めない。
// 動作の接続はlight-plan・light-observation・light-reportの対照で別に確認する。
test('軽量入口を維持し、旧API入口を互換転送やダミーとして残さない', async () => {
  await access(join(import.meta.dir, '../light.ts'));
  await assert.rejects(access(join(import.meta.dir, '../eval.ts')), { code: 'ENOENT' });
});
