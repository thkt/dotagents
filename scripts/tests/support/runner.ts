import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const entry = resolve(import.meta.dir, '../../test.ts');

async function runnerFixture(
  cwd: string,
  scenario: 'normal' | 'only' | 'skip' | 'failure' | 'empty',
) {
  const temporaryReports = join(cwd, 'temporary-reports');
  await mkdir(temporaryReports);
  const dir = join(cwd, 'scripts/tests');
  await mkdir(dir, { recursive: true });
  const bodies = {
    normal: "test('second', () => expect(1).toBe(1));",
    only: "test.only('second', () => expect(1).toBe(1));",
    skip: "test.skip('second', () => expect(1).toBe(2));",
    failure: "test('second', () => expect(1).toBe(2));",
    empty: '',
  };
  const source =
    scenario === 'empty'
      ? ''
      : `import {test,expect} from 'bun:test';
    test('first', () => expect(1).toBe(1)); ${bodies[scenario]}`;
  await writeFile(join(dir, 'probe.test.js'), source);
  return temporaryReports;
}

export function runnerTests() {
  for (const scenario of ['normal', 'only', 'skip', 'failure', 'empty'] as const) {
    test(`bun runner: ${scenario}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'test-completion-'));
      try {
        const temporaryReports = await runnerFixture(cwd, scenario);
        const result = spawnSync(process.execPath, [entry, 'bun'], {
          cwd,
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, CI: 'false', TMPDIR: temporaryReports },
        });
        if (scenario === 'normal' || scenario === 'failure') {
          expect(await readdir(temporaryReports)).toEqual([]);
        }
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(scenario === 'normal' ? 0 : 1);
        if (scenario === 'skip') {
          expect(result.stderr).toContain('Unexecuted tests');
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 20000);
  }
}
