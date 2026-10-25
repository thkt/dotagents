import assert from 'node:assert/strict';
import { readdir, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { command } from '../shared/process.ts';

async function noGitLocks(path: string, inspected?: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert(
      entry.name !== 'lock' && !entry.name.endsWith('.lock'),
      `Git lockが残っています: ${join(path, entry.name)}`,
    );
    const child = join(path, entry.name);
    if (entry.isDirectory() && child !== inspected) {
      await noGitLocks(child, inspected);
    }
  }
}

export async function verifyGitLocks(cwd: string) {
  const output = await command(
    ['git', 'rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'],
    cwd,
    '',
    10000,
  );
  assert(output.code === 0 && !output.timedOut, '旧Git管理領域を照合できません');
  const paths = output.stdout.trim().split(/\r?\n/);
  const git = paths[0],
    common = paths[1];
  assert(
    git && common && paths.length === 2 && isAbsolute(git) && isAbsolute(common),
    '旧Git管理領域の出力が不正です',
  );
  const canonicalGit = await realpath(git),
    canonicalCommon = await realpath(common);
  await noGitLocks(canonicalGit);
  if (canonicalCommon !== canonicalGit) {
    await noGitLocks(canonicalCommon, canonicalGit);
  }
}
