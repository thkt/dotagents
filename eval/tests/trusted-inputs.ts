import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../scripts/shared/values.ts';
import { git } from '../../scripts/tests/support/target.ts';

export const instructionFiles = [
  'AGENTS.md',
  'README.md',
  'scripts/README.md',
  'docs/wiki/development-policy.md',
  'skills/scoping/SKILL.md',
  'skills/implement/SKILL.md',
  'skills/scoping/references/sufficiency.md',
  'skills/scoping/references/experiment.md',
  'skills/scoping/references/session.md',
  'skills/scoping/references/issue.md',
  'skills/implement/references/testing.md',
  'skills/references/documents.md',
  'skills/references/natural-japanese.md',
  'skills/references/premise-validation.md',
  'skills/references/caller-first-design.md',
  'skills/references/mechanization.md',
  'skills/templates/wiki.md',
  'skills/templates/decision.md',
];

// Issue #393の公開固定版。採点情報や新実装を含まないGit packをホストだけで展開する。
async function installTrustedInputs(repo: string) {
  await installPack(
    repo,
    'trusted-inputs.json',
    '8d85a6c4676599a510098b1e753bf3143cd9045476b01199ffc6b9d60a24a067',
  );
  return {
    before: 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092',
    after: '6181233d17a29c711a84f20549f78507c5c3e5fb',
  };
}

// 親checkoutの履歴・alternates・fetchを使わず、公開固定入力だけで検証する。
export async function lightInputRepository(repo: string) {
  await mkdir(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/thkt/dotagents.git');
  await installTrustedInputs(repo);
  await installPack(
    repo,
    'light-common-inputs.json',
    'e6e5fb3983d3fe53017b64053c21d23c98e1471c8b921cc169fe9ae1b90216eb',
  );
}

async function installPack(repo: string, file: string, expectedHash: string) {
  const manifest: unknown = JSON.parse(
    await readFile(join(import.meta.dir, 'fixtures', file), 'utf8'),
  );
  assert(isRecord(manifest) && typeof manifest.packBase64 === 'string');
  const pack = Buffer.from(manifest.packBase64, 'base64');
  assert.equal(createHash('sha256').update(pack).digest('hex'), expectedHash);
  const result = spawnSync('git', ['index-pack', '--stdin'], { cwd: repo, input: pack });
  assert.equal(result.status, 0, result.stderr.toString());
  assert(Array.isArray(manifest.entries));
  verifyEntries(repo, manifest.entries);
}

type TrustedEntry = Record<string, unknown> & { commit: string; path: string };
type TreeEntry = { mode: string; type: string; id: string };
type TrustedBlob = { entry: TrustedEntry; id: string };

function readTree(repo: string, commit: string, entries: TrustedEntry[]) {
  const result = spawnSync(
    'git',
    ['ls-tree', '-z', commit, '--', ...entries.map((entry) => entry.path)],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const tree = new Map<string, TreeEntry>();
  for (const line of result.stdout.split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    assert(tab > 0);
    const [mode, type, id] = line.slice(0, tab).split(' ');
    assert(mode && type && id);
    tree.set(line.slice(tab + 1), { mode, type, id });
  }
  return tree;
}

function verifyEntries(repo: string, entries: unknown[]) {
  const commits = new Map<string, TrustedEntry[]>();
  for (const entry of entries) {
    assert(isRecord(entry) && typeof entry.commit === 'string' && typeof entry.path === 'string');
    const group = commits.get(entry.commit) ?? [];
    group.push({ ...entry, commit: entry.commit, path: entry.path });
    commits.set(entry.commit, group);
  }
  const blobs: TrustedBlob[] = [];
  for (const [commit, group] of commits) {
    const tree = readTree(repo, commit, group);
    for (const entry of group) {
      const actual = tree.get(entry.path);
      if (entry.absent === true) {
        assert.equal(actual, undefined, `Aに存在しない新設資料: ${entry.path}`);
      } else {
        assert(actual, entry.path);
        assert.equal(actual.type, 'blob', entry.path);
        assert.equal(actual.mode, entry.mode, entry.path);
        assert.equal(actual.id, entry.gitBlob, entry.path);
        blobs.push({ entry, id: actual.id });
      }
    }
  }
  verifyBlobs(repo, blobs);
}

function verifyBlobs(repo: string, blobs: TrustedBlob[]) {
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: repo,
    input: blobs.map((blob) => `${blob.id}\n`).join(''),
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  let offset = 0;
  for (const { entry, id } of blobs) {
    const end = result.stdout.indexOf('\n', offset);
    assert(end >= offset);
    const [actualId, type, size] = result.stdout.subarray(offset, end).toString().split(' ');
    assert.equal(actualId, id);
    assert.equal(type, 'blob');
    const length = Number(size);
    assert(Number.isSafeInteger(length) && length >= 0);
    offset = end + 1;
    const body = result.stdout.subarray(offset, offset + length);
    assert.equal(body.length, length);
    assert.equal(createHash('sha256').update(body).digest('hex'), entry.sha256);
    offset += length;
    assert.equal(result.stdout[offset], 10);
    offset += 1;
  }
  assert.equal(offset, result.stdout.length);
}
