import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { baseEnv, fixture, git, header, recordFile } from './runner-affected.ts';

export { baseEnv, fixture, header, recordFile };
export type Fixture = Parameters<Parameters<typeof fixture>[1]>[0];
export const setup = resolve(import.meta.dir, '../../feedback-loop/setup.ts');
export const config = {
  version: 1,
  runner: 'bun',
  base: 'main',
  collect: [process.execPath, 'scripts/collect.ts'],
  testGlobs: ['test/*.test.ts'],
  assurance: [],
  fullCheck: [process.execPath, 'run', 'check'],
  prepare: [],
  bunArgs: ['--no-env-file'],
  testArgs: ['--timeout', '3000'],
  globalChanges: ['scripts/**'],
  dependencies: [],
};
export const files = {
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: { check: 'bun test ./test' },
  }),
  '.dotagents.json': JSON.stringify({
    repository: 'example/fixture',
    remote: 'origin',
    baseBranch: 'main',
    setup: 'bun install --frozen-lockfile --ignore-scripts',
    check: ['bun', 'run', 'check'],
    ciChecks: ['checks', 'verify'],
    capture: null,
  }),
  '.feedback-loop.json': JSON.stringify(config),
  'scripts/collect.ts':
    "import { readdirSync } from 'node:fs'; console.log(JSON.stringify(readdirSync('test').filter(p => p.endsWith('.test.ts')).map(p => 'test/' + p)));\n",
  'src/input.ts': 'export const value = 1;\n',
  'test/a.test.ts':
    header +
    "import { value } from '../src/input.ts'; test('a', () => expect(value).toBeGreaterThan(0));\n",
  'test/b.test.ts': header + "test('b', () => expect(1).toBe(1));\n",
};

export function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...baseEnv(f), ...env },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    code: result.status,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function installed(f: Fixture) {
  const applied = run(f, [
    setup,
    'apply',
    '--repo',
    f.repo,
    '--feedback-command',
    'bun run test:affected',
  ]);
  expect(applied.code, applied.output).toBe(0);
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-m', 'configured');
}

export async function seed(f: Fixture) {
  await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
  const result = run(f, ['run', 'test:affected']);
  expect(result.code, result.output).toBe(0);
  return readFile(recordFile(f.repo), 'utf8');
}

export async function retainedRecords(f: Fixture) {
  const entries = await readdir(dirname(recordFile(f.repo)), {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  );
}
