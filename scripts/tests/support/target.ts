import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TargetConfig } from '../../target.ts';

export const targetConfig: TargetConfig = {
  repository: 'team/component',
  remote: 'upstream',
  baseBranch: 'release',
  setup: [],
  check: ['sh', '-c', 'test -f result.txt'],
  capture: null,
};
export function git(cwd: string, ...argv: string[]) {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8', timeout: 10000 });
  assert(result.status === 0, result.stderr);
  return result.stdout.trim();
}
export async function initializeTarget(cwd: string, config = targetConfig) {
  git(cwd, 'init', '-b', config.baseBranch);
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'remote', 'add', config.remote, `https://github.com/${config.repository}.git`);
  await writeFile(join(cwd, '.dotagents.json'), JSON.stringify(config));
  await writeFile(join(cwd, 'result.txt'), 'old');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'base');
}
export function githubTarget(argv: string[], config = targetConfig): string | undefined {
  if (argv[1] !== 'api') {
    return undefined;
  }
  if (argv[2] === 'user') {
    return JSON.stringify({ login: 'operator' });
  }
  if (argv[2] === `repos/${config.repository}`) {
    return JSON.stringify({ full_name: config.repository, id: 123, permissions: { push: true } });
  }
  if (argv[2] === `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}`) {
    return JSON.stringify({ name: config.baseBranch });
  }
  throw Error(`Unexpected API request: ${argv[2]}`);
}
