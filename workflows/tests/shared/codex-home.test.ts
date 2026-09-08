/** @file Outcome: Nested Codex state stays writable, private, disposable, and independent from host configuration. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';
import { pathToFileURL } from 'node:url';

import { cleanCodexEnvironment, sandboxCodexEnvironment } from '../../shared/codex-home.ts';
import { defaultWorkflowRuntimeDirectory } from '../../runtime/environment.ts';

function fixture(prefix: string): { root: string; home: string; temporaryDirectory: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const temporaryDirectory = path.join(root, 'tmp');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(temporaryDirectory);
  return { root, home, temporaryDirectory };
}

test('removes API billing credentials without changing unrelated environment values', () => {
  assert.deepEqual(
    cleanCodexEnvironment({
      PATH: '/bin',
      EMPTY: '',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
    }),
    { PATH: '/bin', EMPTY: '' },
  );
});

test('gives nested Codex a private writable home without sharing operational state', () => {
  const { home, temporaryDirectory } = fixture('codex-sdk-environment-');
  const sourceHome = path.join(home, '.codex');
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"tokens":"signed-in"}', { mode: 0o600 });
  fs.writeFileSync(path.join(sourceHome, 'state_5.sqlite'), 'source-state');
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), 'hooks = true\n');

  const environment = sandboxCodexEnvironment(
    {
      HOME: home,
      PATH: '/bin',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
    },
    temporaryDirectory,
  );

  assert.equal(environment.HOME, environment.CODEX_HOME);
  assert.notEqual(environment.CODEX_HOME, sourceHome);
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CODEX_API_KEY, undefined);
  assert.deepEqual(fs.readdirSync(environment.CODEX_HOME!).sort(), ['auth.json']);
  assert.equal(
    fs.readFileSync(path.join(environment.CODEX_HOME!, 'auth.json'), 'utf8'),
    '{"tokens":"signed-in"}',
  );
  assert.equal(fs.statSync(environment.CODEX_HOME!).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(environment.CODEX_HOME!, 'auth.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(environment.CODEX_HOME!, 'state_5.sqlite'), 'sandbox-state');
  assert.equal(fs.readFileSync(path.join(sourceHome, 'state_5.sqlite'), 'utf8'), 'source-state');
  assert.equal(fs.readFileSync(path.join(sourceHome, 'config.toml'), 'utf8'), 'hooks = true\n');
});

test('uses an explicit CODEX_HOME as the signed-in credential source', () => {
  const { root, home, temporaryDirectory } = fixture('codex-sdk-configured-home-');
  const configuredHome = path.join(root, 'configured-codex');
  fs.mkdirSync(configuredHome);
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"source":"home"}');
  fs.writeFileSync(path.join(configuredHome, 'auth.json'), '{"source":"configured"}');

  const environment = sandboxCodexEnvironment(
    { HOME: home, CODEX_HOME: configuredHome },
    temporaryDirectory,
  );

  assert.equal(
    fs.readFileSync(path.join(environment.CODEX_HOME!, 'auth.json'), 'utf8'),
    '{"source":"configured"}',
  );
});

test('requires regular signed-in auth before creating nested Codex state', () => {
  const { home, temporaryDirectory } = fixture('codex-sdk-auth-');
  const sourceHome = path.join(home, '.codex');
  const target = path.join(home, 'auth-target.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, path.join(sourceHome, 'auth.json'));
  assert.throws(
    () => sandboxCodexEnvironment({ HOME: home }, temporaryDirectory),
    /auth\.json must be a regular file/u,
  );
  assert.deepEqual(fs.readdirSync(temporaryDirectory), []);
});

test('reaps stale private homes while preserving a fresh concurrent home', () => {
  const { home, temporaryDirectory } = fixture('codex-sdk-stale-');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  const runtimeRoot = defaultWorkflowRuntimeDirectory(temporaryDirectory);
  fs.mkdirSync(runtimeRoot);
  const stale = fs.mkdtempSync(path.join(runtimeRoot, 'sdk-home-'));
  const fresh = fs.mkdtempSync(path.join(runtimeRoot, 'sdk-home-'));
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60_000);
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

  sandboxCodexEnvironment({ HOME: home }, temporaryDirectory, now);

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('removes the private home when its owning workflow process exits', () => {
  const { home, temporaryDirectory } = fixture('codex-sdk-process-');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  const moduleUrl = pathToFileURL(path.resolve('workflows/shared/codex-home.ts')).href;
  const source = [
    `import { sandboxCodexEnvironment } from ${JSON.stringify(moduleUrl)};`,
    `const environment = sandboxCodexEnvironment({ HOME: ${JSON.stringify(home)} }, ${JSON.stringify(temporaryDirectory)});`,
    'process.stdout.write(environment.CODEX_HOME);',
  ].join('\n');

  const child = spawnSync(process.execPath, ['--eval', source], { encoding: 'utf8' });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(child.stdout), false);
});

test('rejects a symlinked runtime root before writing credentials', () => {
  const { root, home, temporaryDirectory } = fixture('codex-sdk-runtime-root-');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  const target = path.join(root, 'runtime-target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, defaultWorkflowRuntimeDirectory(temporaryDirectory));

  assert.throws(
    () => sandboxCodexEnvironment({ HOME: home }, temporaryDirectory),
    /runtime root must be a regular directory/u,
  );
  assert.deepEqual(fs.readdirSync(target), []);
});

test('repository-local SDK storage validates resolved ownership before runtime or credential creation', () => {
  const { root, home } = fixture('codex-sdk-private-policy-');
  fs.writeFileSync(path.join(home, '.codex/auth.json'), '{"tokens":"private"}');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const temp = path.join(repo, 'private');
  const runtime = defaultWorkflowRuntimeDirectory(temp);
  assert.throws(() => sandboxCodexEnvironment({ HOME: home }, temp), /Private storage/);
  assert.equal(fs.existsSync(temp), false);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/private/\n/research/\n');
  const first = sandboxCodexEnvironment({ HOME: home }, temp);
  const second = sandboxCodexEnvironment({ HOME: home }, temp);
  assert.notEqual(first.CODEX_HOME, second.CODEX_HOME);
  assert.equal(fs.statSync(path.join(first.CODEX_HOME!, 'auth.json')).mode & 0o777, 0o600);
  const before = fs.readdirSync(runtime);
  fs.writeFileSync(path.join(repo, '.gitignore'), '');
  assert.throws(() => sandboxCodexEnvironment({ HOME: home }, temp), /Private storage/);
  assert.deepEqual(fs.readdirSync(runtime), before);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/private/\n/research/\n');
  assert.throws(
    () => sandboxCodexEnvironment({ HOME: home }, path.join(repo, 'research/records')),
    /Private storage/,
  );
  assert.equal(fs.existsSync(path.join(repo, 'research')), false);
  const tracked = path.join(runtime, 'tracked');
  fs.writeFileSync(tracked, 'preserved');
  assert.equal(spawnSync('git', ['-C', repo, 'add', '-f', tracked]).status, 0);
  assert.throws(() => sandboxCodexEnvironment({ HOME: home }, temp), /Private storage/);
  assert.equal(fs.readFileSync(tracked, 'utf8'), 'preserved');
  const alias = path.join(repo, 'private/alias');
  const unignored = path.join(repo, 'unignored');
  fs.mkdirSync(unignored);
  fs.symlinkSync(unignored, alias);
  assert.throws(() => sandboxCodexEnvironment({ HOME: home }, alias), /Private storage/);
  assert.deepEqual(fs.readdirSync(unignored), []);
});

test('external workflow runtime does not exempt repository-local TMPDIR credential homes', () => {
  const { root, home } = fixture('codex-sdk-tmpdir-policy-');
  fs.writeFileSync(path.join(home, '.codex/auth.json'), '{}');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const temporaryDirectory = path.join(repo, 'scratch');
  const moduleUrl = pathToFileURL(path.resolve('workflows/shared/codex-home.ts')).href;
  const source = `
    import assert from 'node:assert/strict';
    import { sandboxCodexEnvironment } from ${JSON.stringify(moduleUrl)};
    assert.throws(() => sandboxCodexEnvironment({ HOME: ${JSON.stringify(home)} }), /Private storage/);
  `;
  const child = spawnSync(process.execPath, ['--eval', source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: temporaryDirectory,
      CODEX_FLOW_RUNTIME_DIR: path.join(root, 'external-runtime'),
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(temporaryDirectory), false);
  assert.equal(fs.readFileSync(path.join(home, '.codex/auth.json'), 'utf8'), '{}');
});
