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

test('private writers reject unignored, tracked, overlapping and resolved unsafe destinations before creation', async () => {
  const { execFileSync } = await import('node:child_process');
  const { atomicWrite, protectPrivateStorage } = await import('../../runtime/storage.ts');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'private-storage-'));
  onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(
    path.join(repo, '.gitignore'),
    '.codex/workflow-artifacts/\nprivate/\nresearch/\n',
  );
  fs.writeFileSync(path.join(repo, 'tracked'), 'original');
  execFileSync('git', ['-C', repo, 'add', '.gitignore', 'tracked']);
  const good = path.join(repo, '.codex/workflow-artifacts/state.json');
  atomicWrite(good, { private: true });
  assert(fs.existsSync(good));
  for (const relative of [
    'unignored/state.json',
    'tracked',
    'research/records/state.json',
    'research/reports/view.md',
  ]) {
    const file = path.join(repo, relative);
    assert.throws(() => atomicWrite(file, {}), /Private storage/);
    if (relative !== 'tracked') assert.equal(fs.existsSync(file), false);
  }
  fs.mkdirSync(path.join(repo, 'private'));
  fs.symlinkSync(path.join(repo, 'tracked'), path.join(repo, 'private/alias'));
  assert.throws(() => atomicWrite(path.join(repo, 'private/alias'), {}), /Private storage/);
  assert.equal(fs.readFileSync(path.join(repo, 'tracked'), 'utf8'), 'original');
  assert.throws(() => protectPrivateStorage(path.join(repo, 'research')), /Private storage/);
  fs.writeFileSync(path.join(repo, '.gitignore'), '');
  assert.throws(() => atomicWrite(good, {}), /Private storage/);
});

test('directory-only rules protect absent configured roots and reject changed resolved repository ownership', async () => {
  const { execFileSync } = await import('node:child_process');
  const { workflowArtifactDirectory, atomicWrite } = await import('../../runtime/storage.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-owner-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'),
    foreign = path.join(root, 'foreign');
  for (const directory of [repo, foreign]) execFileSync('git', ['init', '-q', directory]);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/private/\n');
  const configured = process.env.CODEX_FLOW_ARTIFACT_DIR;
  try {
    process.env.CODEX_FLOW_ARTIFACT_DIR = path.join(repo, 'private');
    const directory = workflowArtifactDirectory(repo);
    assert.equal(fs.existsSync(path.join(repo, 'private')), false);
    const file = path.join(directory, 'state.json');
    atomicWrite(file, { retained: true });
    fs.renameSync(path.join(repo, 'private'), path.join(root, 'saved'));
    fs.symlinkSync(foreign, path.join(repo, 'private'));
    assert.throws(() => atomicWrite(file, {}), /Private storage/);
    assert.equal(fs.existsSync(path.join(foreign, path.basename(directory))), false);
    assert.match(
      fs.readFileSync(path.join(root, 'saved', path.basename(directory), 'state.json'), 'utf8'),
      /retained/,
    );
  } finally {
    if (configured === undefined) delete process.env.CODEX_FLOW_ARTIFACT_DIR;
    else process.env.CODEX_FLOW_ARTIFACT_DIR = configured;
  }
});

test('file exceptions in an ignored namespace reject before private directory creation', async () => {
  const { execFileSync } = await import('node:child_process');
  const { atomicWrite } = await import('../../runtime/storage.ts');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'private-exception-'));
  onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/private/*\n!/private/state.json\n');
  assert.throws(() => atomicWrite(path.join(repo, 'private/state.json'), {}), /Private storage/);
  assert.equal(fs.existsSync(path.join(repo, 'private')), false);
});

test('a tracked symlink to external storage cannot be replaced by a private record', async () => {
  const { execFileSync } = await import('node:child_process');
  const { atomicWrite } = await import('../../runtime/storage.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-tracked-link-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'),
    target = path.join(root, 'external');
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(target, 'preserved');
  fs.symlinkSync(target, path.join(repo, 'link'));
  execFileSync('git', ['-C', repo, 'add', 'link']);
  assert.throws(() => atomicWrite(path.join(repo, 'link'), {}), /Private storage/);
  assert.equal(fs.readlinkSync(path.join(repo, 'link')), target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserved');
});

test('parent traversal through an alias cannot redirect a validated private write', async () => {
  const { execFileSync } = await import('node:child_process');
  const { atomicWrite } = await import('../../runtime/storage.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-traversal-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/safe/\n/alias\n');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, 'alias'));
  assert.throws(() => atomicWrite(`${repo}/alias/../safe/state.json`, {}), /Private storage/);
  assert.equal(fs.existsSync(path.join(root, 'safe')), false);
  assert.equal(fs.existsSync(path.join(repo, 'safe')), false);
});
