/** @file Outcome: OS process lifetime, not stale PID deletion, controls run ownership. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { acquireWorkflowOwnership } from '../../runtime/ownership.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('ownership-tests-');
const modulePath = path.resolve(import.meta.dir, '../../runtime/ownership.ts');

test('a live process excludes contenders and a killed owner releases ownership', async () => {
  const runId = crypto.randomUUID();
  const script = path.join(temporaryDirectory('ownership-child-'), 'child.ts');
  fs.writeFileSync(
    script,
    `import { acquireWorkflowOwnership } from ${JSON.stringify(modulePath)};
    using lock = acquireWorkflowOwnership(${JSON.stringify(runId)});
    console.log('owned');
    await new Promise(() => setInterval(() => {}, 1000));`,
  );
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /owned/);
    reader.releaseLock();
    assert.throws(() => acquireWorkflowOwnership(runId), /active runtime owner/);
    assert.throws(() => acquireWorkflowOwnership(runId), /active runtime owner/);
    child.kill('SIGKILL');
    await child.exited;
    using recovered = acquireWorkflowOwnership(runId);
    assert.throws(() => acquireWorkflowOwnership(runId), /active runtime owner/);
    assert.ok(recovered);
  } finally {
    child.kill();
    await child.exited;
  }
});

test('different runs can execute concurrently and released ownership can be reacquired', () => {
  const runId = crypto.randomUUID();
  {
    using first = acquireWorkflowOwnership(runId);
    using second = acquireWorkflowOwnership(crypto.randomUUID());
    assert.ok(first && second);
  }
  using next = acquireWorkflowOwnership(runId);
  assert.ok(next);
});
