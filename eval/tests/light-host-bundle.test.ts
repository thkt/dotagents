import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { prepareLightHostBundle } from './light-host-bundle.fixture.ts';
import { nativeFixedResponses } from './light-native-responses.fixture.ts';
import { lightBoundaryFixture } from './light-boundary.fixture.ts';

test('新しい保存先へ既存固定応答を再生成し、境界fixtureの本文とhashを保ち上書きを拒否する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'light-host-bundle-'));
  try {
    const input = {
      bunExecutable: process.execPath,
      bunVersion: Bun.version,
      workspace: join(root, "workspace's directory"),
      targets: [{ kind: 'read', path: join(root, "canary's file") }],
      readTools: [{ name: 'synthetic_read', args: { path: join(root, 'public-input') } }],
    };
    for (const name of ['first', 'second']) {
      const destination = join(root, name);
      const hashes = await prepareLightHostBundle(destination, input);
      for (const [file, expected] of Object.entries(hashes)) {
        expect(
          createHash('sha256')
            .update(await readFile(join(destination, file)))
            .digest('hex'),
        ).toBe(expected);
      }
      expect(await readFile(join(destination, 'light-boundary.fixture.ts'))).toEqual(
        await readFile(lightBoundaryFixture),
      );
      const fixed: unknown = JSON.parse(
        await readFile(join(destination, 'fixed-responses.json'), 'utf8'),
      );
      expect(fixed).toEqual(nativeFixedResponses(process.execPath, Bun.version));
      const original = await readFile(join(destination, 'manifest.json'));
      await assert.rejects(prepareLightHostBundle(destination, input), { code: 'EEXIST' });
      expect(await readFile(join(destination, 'manifest.json'))).toEqual(original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
