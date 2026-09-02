/** @file Outcome: A repository snapshot mirrors the entry state of any repository and leaves nothing behind. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { withRepositorySnapshot } from '../../../workflows/flow/isolation.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function commitlessRepo(): string {
  const repo = temporaryDirectory('codex-isolation-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
  execFileSync('git', ['add', 'staged.txt'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
  return repo;
}

test('a repository without commits yields a snapshot carrying its staged and untracked files', async () => {
  const repo = commitlessRepo();
  let snapshotDirectory = '';
  await withRepositorySnapshot(repo, async (snapshotRepo) => {
    snapshotDirectory = snapshotRepo;
    assert.notEqual(fs.realpathSync(snapshotRepo), fs.realpathSync(repo));
    assert.equal(fs.readFileSync(path.join(snapshotRepo, 'staged.txt'), 'utf8'), 'staged\n');
    assert.equal(fs.readFileSync(path.join(snapshotRepo, 'untracked.txt'), 'utf8'), 'untracked\n');
    const index = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: snapshotRepo,
      encoding: 'utf8',
    });
    assert.equal(index.trim(), 'staged.txt');
  });
  assert.equal(fs.existsSync(snapshotDirectory), false);
});

test('a throwing run still removes its snapshot directory', async () => {
  const repo = commitlessRepo();
  let snapshotDirectory = '';
  await assert.rejects(
    withRepositorySnapshot(repo, async (snapshotRepo) => {
      snapshotDirectory = snapshotRepo;
      throw new Error('run failed');
    }),
    /run failed/u,
  );
  assert.ok(snapshotDirectory);
  assert.equal(fs.existsSync(snapshotDirectory), false);
});

test('a nested .git entry such as a submodule pointer is not copied into the snapshot', async () => {
  const repo = commitlessRepo();
  fs.mkdirSync(path.join(repo, 'vendor', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'vendor', 'lib', '.git'), 'gitdir: ../../.git/modules/lib\n');
  fs.writeFileSync(path.join(repo, 'vendor', 'lib', 'index.js'), 'x\n');
  await withRepositorySnapshot(repo, async (snapshotRepo) => {
    assert.equal(fs.existsSync(path.join(snapshotRepo, 'vendor', 'lib', 'index.js')), true);
    assert.equal(fs.existsSync(path.join(snapshotRepo, 'vendor', 'lib', '.git')), false);
  });
});

test('a snapshot omits ignored files and directories while keeping the ignore rules', async () => {
  const repo = commitlessRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'x\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'x\n');
  await withRepositorySnapshot(repo, async (snapshotRepo) => {
    assert.equal(fs.existsSync(path.join(snapshotRepo, '.gitignore')), true);
    assert.equal(fs.existsSync(path.join(snapshotRepo, 'untracked.txt')), true);
    assert.equal(fs.existsSync(path.join(snapshotRepo, 'ignored.txt')), false);
    assert.equal(fs.existsSync(path.join(snapshotRepo, 'node_modules')), false);
  });
});

/**
 * Runs one snapshot attempt in a child process with a private PATH and TMPDIR, so a hanging
 * fake git and the leftover-root check cannot leak into test files running in parallel.
 */
function snapshotInChild(options: { repo: string; timeoutMs?: number; gitBin?: string }): {
  code?: string;
  message?: string;
  resolved?: boolean;
  roots: string[];
} {
  const tmp = temporaryDirectory('codex-isolation-tmp-');
  const script = path.join(tmp, 'attempt.ts');
  fs.writeFileSync(
    script,
    [
      `import * as fs from 'node:fs';`,
      `import os from 'node:os';`,
      `import { withRepositorySnapshot } from ${JSON.stringify(
        path.resolve(import.meta.dir, '../../flow/isolation.ts'),
      )};`,
      `const [repo, timeout] = process.argv.slice(2);`,
      `let outcome;`,
      `try {`,
      `  await withRepositorySnapshot(repo, async () => 'resolved', timeout ? { timeoutMs: Number(timeout) } : {});`,
      `  outcome = { resolved: true };`,
      `} catch (error) {`,
      `  outcome = { code: error.code, message: error.message };`,
      `}`,
      `const roots = fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith('codex-repository-sandbox-'));`,
      `console.log(JSON.stringify({ ...outcome, roots }));`,
    ].join('\n'),
  );
  const result = execFileSync(
    process.execPath,
    [script, options.repo, ...(options.timeoutMs ? [String(options.timeoutMs)] : [])],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TMPDIR: tmp,
        ...(options.gitBin
          ? { PATH: `${options.gitBin}${path.delimiter}${process.env.PATH ?? ''}` }
          : {}),
      },
    },
  );
  return JSON.parse(result.trim().split('\n').at(-1) ?? '{}');
}

test('a directory that is not a repository fails as a state error and leaves no sandbox', () => {
  const notRepo = temporaryDirectory('codex-isolation-plain-');
  const outcome = snapshotInChild({ repo: notRepo });
  assert.equal(outcome.code, 'state_error');
  assert.deepEqual(outcome.roots, []);
});

test('a git command exceeding the timeout fails as a state error and leaves no sandbox', () => {
  const repo = commitlessRepo();
  const bin = temporaryDirectory('codex-isolation-bin-');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = "clone" ]; then exec sleep 5; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  const outcome = snapshotInChild({ repo, timeoutMs: 200, gitBin: bin });
  assert.equal(outcome.code, 'state_error');
  assert.match(outcome.message ?? '', /exceeded 200ms/u);
  assert.deepEqual(outcome.roots, []);
}, 10_000);

test('entering a snapshot removes sandbox roots older than a day and keeps younger ones', async () => {
  const repo = commitlessRepo();
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repository-sandbox-'));
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repository-sandbox-'));
  onTestFinished(() => fs.rmSync(fresh, { recursive: true, force: true }));
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  await withRepositorySnapshot(repo, async () => undefined);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});
