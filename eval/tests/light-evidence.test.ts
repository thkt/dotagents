import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { lightEvidenceWorker } from './light-evidence.worker.ts';
import { isRecord } from '../../scripts/shared/values.ts';

for (const mode of ['stable', 'replace']) {
  test(`境界証拠は検査した本文と同じ観測版のhashを記録する: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'light-evidence-'));
    try {
      const child = Bun.spawn([process.execPath, lightEvidenceWorker, root, mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, stdout + stderr);
      const result: unknown = JSON.parse(stdout);
      assert(isRecord(result));
      if (mode === 'stable') {
        expect(result.accepted).toBe(true);
      } else {
        expect(result.replaced).toBe(true);
      }
      // 検査済みsnapshotの採用、または版変化の拒否を許す。
      // 未検査の不合格本文のhashをpassed証拠として返してはいけない。
      if (result.accepted) {
        expect(result.hash).toBe(result.originalHash);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
