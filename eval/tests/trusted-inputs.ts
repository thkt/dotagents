import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
export async function installTrustedInputs(repo: string) {
  const manifest: unknown = JSON.parse(
    await readFile(join(import.meta.dir, 'fixtures/trusted-inputs.json'), 'utf8'),
  );
  assert(isRecord(manifest) && typeof manifest.packBase64 === 'string');
  const pack = Buffer.from(manifest.packBase64, 'base64');
  assert.equal(
    createHash('sha256').update(pack).digest('hex'),
    '8d85a6c4676599a510098b1e753bf3143cd9045476b01199ffc6b9d60a24a067',
  );
  const result = spawnSync('git', ['index-pack', '--stdin'], { cwd: repo, input: pack });
  assert.equal(result.status, 0, result.stderr.toString());
  assert(Array.isArray(manifest.entries));
  for (const entry of manifest.entries) {
    verifyEntry(repo, entry);
  }
  return {
    before: 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092',
    after: '6181233d17a29c711a84f20549f78507c5c3e5fb',
  };
}

function verifyEntry(repo: string, entry: unknown) {
  assert(isRecord(entry) && typeof entry.commit === 'string' && typeof entry.path === 'string');
  const tree = git(repo, 'ls-tree', entry.commit, '--', entry.path);
  if (entry.absent === true) {
    assert.equal(tree, '', `Aに存在しない新設資料: ${entry.path}`);
    return;
  }
  assert.equal(tree, `${String(entry.mode)} blob ${String(entry.gitBlob)}\t${entry.path}`);
  const blob = spawnSync('git', ['show', `${entry.commit}:${entry.path}`], { cwd: repo });
  assert.equal(blob.status, 0, blob.stderr.toString());
  assert.equal(createHash('sha256').update(blob.stdout).digest('hex'), entry.sha256);
}
