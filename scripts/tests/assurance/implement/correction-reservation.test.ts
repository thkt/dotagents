import { test, expect, afterEach } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { correctionFixture } from '../../support/correction.ts';
const { trial, cleanup } = correctionFixture();
afterEach(cleanup);
test('terminal success still refuses an active reservation or an existing lock', async () => {
  const t = await trial('normal');
  expect(t.execute().status).toBe(0);
  const stateFile = join(t.config.runDir, 'state.json');
  const saved = await readFile(stateFile, 'utf8');
  const active = JSON.stringify({
    ...(await t.state()),
    active: { role: 'review', prefix: join(t.config.runDir, 'review-2') },
  });
  await writeFile(stateFile, active);
  const interrupted = t.execute();
  expect(interrupted.status).toBe(1);
  expect(interrupted.stderr).toContain('Interrupted execution');
  expect(await readFile(stateFile, 'utf8')).toBe(active);

  await writeFile(stateFile, saved);
  const lock = join(t.config.runDir, 'lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner'), 'existing execution');
  const locked = t.execute();
  expect(locked.status).toBe(1);
  expect(locked.stderr).toContain('EEXIST');
  expect(await readFile(join(lock, 'owner'), 'utf8')).toBe('existing execution');
  expect(await readFile(stateFile, 'utf8')).toBe(saved);
});
