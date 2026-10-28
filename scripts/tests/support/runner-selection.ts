import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const entry = resolve(import.meta.dir, '../../test-runtime/runner.ts');

export async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'runner-selection-'));
  try {
    await mkdir(join(cwd, 'selected'));
    await mkdir(join(cwd, 'reports'));
    await writeFile(
      join(cwd, 'observe-report.js'),
      `
import { mock } from 'bun:test';
import * as filesystem from 'node:fs/promises';
const fs = { ...filesystem };
mock.module('node:fs/promises', () => ({ ...fs, async readFile(path, encoding) {
  const text = await fs.readFile(path, encoding);
  if (String(path).endsWith('results.xml')) await fs.writeFile('observed.xml', text);
  return text;
} }));`,
    );
    await writeProbe(cwd, 'first', "test('first', () => console.log('FIRST_COMPLETED'));");
    await writeProbe(cwd, 'second', "test('second', () => console.log('SECOND_COMPLETED'));");
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function writeProbe(cwd: string, name: string, body: string) {
  await writeFile(
    join(cwd, 'selected', `${name}.test.js`),
    `import { test, expect } from 'bun:test';\n${body}`,
  );
}

export function run(cwd: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--preload', join(cwd, 'observe-report.js'), entry, 'bun', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CI: 'false', TMPDIR: join(cwd, 'reports') },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, output: result.stdout + result.stderr };
}

export const paths = ['selected/first.test.js', 'selected/second.test.js'];
