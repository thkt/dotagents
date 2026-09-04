/** @file Outcome: Shared artifact paths remain deterministic and collision-safe. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';
import { artifactPaths } from '../../runtime/storage.ts';

test('generates paired paths and skips existing collisions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = artifactPaths(
    directory,
    'Hello World',
    new Date('2026-01-02T03:04:05.000Z'),
    'fallback',
  );
  fs.writeFileSync(first.json, '{}');
  const second = artifactPaths(
    directory,
    'Hello World',
    new Date('2026-01-02T03:04:05.000Z'),
    'fallback',
  );
  assert.match(second.json, /-2\.json$/);
  assert.match(second.markdown, /-2\.md$/);
  const fallback = artifactPaths(
    directory,
    '日本語のみ',
    new Date('2026-01-02T03:04:05.000Z'),
    'fallback',
  );
  assert.match(fallback.json, /-fallback-[0-9a-f]{8}\.json$/);
});
