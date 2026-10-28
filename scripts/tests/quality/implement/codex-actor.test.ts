import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { object } from '../../support/correction.ts';
import {
  modes,
  assuranceModes,
  registerMode,
  mockCodex,
  testResponse,
} from '../../support/codex-actor.ts';

for (const mode of modes.filter((mode) => !assuranceModes.includes(mode))) {
  registerMode(mode);
}

for (const targetId of ['a1'.repeat(32), 'f09c'.repeat(16)]) {
  test(`独立テストactorは入力IDを生成schemaで固定する: ${targetId}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'test-schema-')));
    try {
      await mockCodex(root, 'test', 64, targetId);
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/implement/codex-actor.ts'), 'test', root],
        {
          cwd: root,
          env: { PATH: root },
          input: `入力: ${JSON.stringify({ targetId })}\n要求: 固定した要求`,
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const invocation = object(JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')));
      const field = object(object(object(invocation.schema).properties).targetId);
      // singleton enumとconstは同じ生成制約として許容する。ホストの拒否は別テストで守る。
      expect(field.enum ?? (field.const === undefined ? [] : [field.const])).toEqual([targetId]);
      expect(JSON.parse(result.stdout)).toEqual({ ...testResponse, targetId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
