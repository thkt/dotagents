import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isCommandArray, isRecord, relativeDirectory } from './values.ts';

export type Reader = (argv: string[], cwd: string) => Promise<string>;
export interface TargetConfig {
  repository: string;
  remote: string;
  baseBranch: string;
  setup: string[][];
  check: string[];
  ciChecks: string[];
  capture: null | { command: string[]; destination: string; required: boolean };
}
type TargetSettings = Omit<TargetConfig, 'setup' | 'check'> & {
  setup: string[][] | string;
  check: string[] | string;
};
function argv(value: unknown): value is string[] {
  return isCommandArray(value) && value[0].trim().length > 0;
}
function shellCommand(command: string) {
  return ['/bin/sh', '-c', command];
}
function assertTarget(value: unknown): asserts value is TargetSettings {
  assert(isRecord(value), 'Missing target configuration');
  assert(
    !('writing' in value),
    'writing is no longer supported; remove writing from .dotagents.json and review the target documentation policy before starting a new run. Preserve existing runs.',
  );
  assert(
    typeof value.repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value.repository),
    'Invalid repository',
  );
  assert(typeof value.remote === 'string' && /^[\w.-]+$/.test(value.remote), 'Invalid remote');
  assert(typeof value.baseBranch === 'string' && value.baseBranch.trim(), 'Missing base branch');
  assert(
    typeof value.setup === 'string'
      ? value.setup.trim().length > 0
      : Array.isArray(value.setup) && value.setup.every(argv),
    'Explicit setup commands required (empty array allowed)',
  );
  assert(
    typeof value.check === 'string' ? value.check.trim().length > 0 : argv(value.check),
    'Verification command is required',
  );
  assert(
    Array.isArray(value.ciChecks) &&
      value.ciChecks.every((name) => typeof name === 'string' && name.trim()) &&
      new Set(value.ciChecks).size === value.ciChecks.length,
    'Explicit unique CI check names required (empty array allowed)',
  );
  if (value.capture !== null) {
    assert(
      isRecord(value.capture) &&
        argv(value.capture.command) &&
        relativeDirectory(value.capture.destination) &&
        typeof value.capture.required === 'boolean',
      'Explicit capture configuration or null required',
    );
  }
}
function remoteRepository(url: string) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
      url,
    );
  assert(match?.[1], 'Remote must identify a GitHub repository without credentials');
  return match[1];
}
export function issueNumber(input: string, repository: string) {
  const prefix = `https://github.com/${repository}/issues/`;
  const raw = input.startsWith(prefix) ? input.slice(prefix.length) : input.replace(/^#/, '');
  assert(
    /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)),
    'Issue does not match target repository',
  );
  return raw;
}
export async function readTarget(checkout: string, read: Reader, writable = false) {
  assert(
    !process.env.GH_HOST || process.env.GH_HOST === 'github.com',
    'GH_HOST must be github.com',
  );
  const cwd = await realpath(checkout);
  assert(
    (await realpath(await read(['git', 'rev-parse', '--show-toplevel'], cwd))) === cwd,
    'Target must be the checkout root',
  );
  const text = await readFile(resolve(cwd, '.dotagents.json'), 'utf8');
  const settings: unknown = JSON.parse(text);
  assertTarget(settings);
  const config: TargetConfig = {
    ...settings,
    setup: typeof settings.setup === 'string' ? [shellCommand(settings.setup)] : settings.setup,
    check: typeof settings.check === 'string' ? shellCommand(settings.check) : settings.check,
  };
  for (const direction of [[], ['--push']]) {
    const urls = await read(
      ['git', 'remote', 'get-url', ...direction, '--all', config.remote],
      cwd,
    );
    assert(
      urls.split('\n').every((url) => remoteRepository(url) === config.repository),
      'Remote/repository mismatch',
    );
  }
  await read(['git', 'check-ref-format', '--branch', config.baseBranch], cwd);
  const identity: unknown = JSON.parse(
    await read(['gh', 'api', `repos/${config.repository}`], cwd),
  );
  assert(
    isRecord(identity) &&
      identity.full_name === config.repository &&
      typeof identity.id === 'number' &&
      Number.isSafeInteger(identity.id),
    'GitHub repository mismatch',
  );
  if (writable) {
    assert(
      isRecord(identity.permissions) && identity.permissions.push === true,
      'GitHub push permission required',
    );
  }
  const branch: unknown = JSON.parse(
    await read(
      ['gh', 'api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}`],
      cwd,
    ),
  );
  assert(isRecord(branch) && branch.name === config.baseBranch, 'Base branch mismatch');
  const actor: unknown = JSON.parse(await read(['gh', 'api', 'user'], cwd));
  assert(
    isRecord(actor) && typeof actor.login === 'string' && actor.login,
    'GitHub actor unavailable',
  );
  return { cwd, config, text, repositoryId: identity.id, actor: actor.login };
}
// A command-scoped pushurl bypasses pushInsteadOf. Check insteadOf expansion too.
export async function pushArguments(repository: string, branch: string, cwd: string, read: Reader) {
  const url = `https://github.com/${repository}.git`;
  const remote = 'dotagents-publish';
  const options = [
    '-c',
    `remote.${remote}.url=${url}`,
    '-c',
    `remote.${remote}.pushurl=${url}`,
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!gh auth git-credential',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
  ];
  const pushUrls = await read(
    ['git', ...options, 'config', '--get-all', `remote.${remote}.pushurl`],
    cwd,
  );
  assert(pushUrls === url, 'Effective push URL differs from verified HTTPS target');
  const effective = await read(['git', ...options, 'ls-remote', '--get-url', remote], cwd);
  assert(effective === url, 'Effective push URL differs from verified HTTPS target');
  return ['git', ...options, 'push', '--no-follow-tags', remote, `${branch}:refs/heads/${branch}`];
}

export function targetCommand(command: string[]) {
  return command.map((part) => part.replaceAll('{harness}', resolve(import.meta.dir, '..')));
}

if (import.meta.main) {
  try {
    const { command } = await import('./process.ts');
    const { positionals, values } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: { write: { type: 'boolean' } },
      strict: true,
    });
    const checkout = positionals[0];
    assert(checkout && positionals.length <= 2, 'Usage: target.ts CHECKOUT [ISSUE] [--write]');
    const target = await readTarget(
      checkout,
      async (argv, cwd) => {
        const result = await command(argv, cwd, '', 30000);
        assert(result.code === 0 && !result.timedOut, `Target check failed: ${argv[0]}`);
        return result.stdout.trim();
      },
      values.write ?? false,
    );
    if (positionals[1]) {
      issueNumber(positionals[1], target.config.repository);
    }
    console.log(JSON.stringify(target, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
