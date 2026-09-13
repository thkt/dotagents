import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from './input.ts';
import { readTarget } from './target.ts';
import { command as runCommand, assertRunning, withInterrupts } from './correction.ts';

export interface AppConfig {
  id: number;
  clientId: string;
  installationId: number;
  keychainService: string;
  keychainAccount: string;
  keyFingerprint: string;
}
async function appConfig(path: string | undefined): Promise<AppConfig> {
  assert(path && path.startsWith('/'), 'Absolute --app-config or DOTAGENTS_APP_CONFIG required');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(isRecord(value), 'Invalid App configuration');
  const { id, clientId, installationId, keychainService, keychainAccount, keyFingerprint } = value;
  assert(
    typeof id === 'number' &&
      Number.isSafeInteger(id) &&
      id > 0 &&
      typeof installationId === 'number' &&
      Number.isSafeInteger(installationId) &&
      installationId > 0,
    'Invalid App or installation ID',
  );
  assert(
    typeof clientId === 'string' &&
      clientId &&
      typeof keychainService === 'string' &&
      keychainService &&
      typeof keychainAccount === 'string' &&
      keychainAccount &&
      typeof keyFingerprint === 'string' &&
      keyFingerprint,
    'Invalid App identity or Keychain configuration',
  );
  return { id, clientId, installationId, keychainService, keychainAccount, keyFingerprint };
}
async function command(argv: string[], token?: string, cwd?: string) {
  const executable = argv[0];
  assert(executable);
  const env = { ...process.env };
  delete env.GH_DEBUG;
  if (token) {
    env.GH_TOKEN = token;
  }
  const result = await runCommand(argv, cwd ?? process.cwd(), '', 120000, undefined, env);
  assert(result.code === 0 && !result.timedOut, `Command failed: ${executable}`);
  return result.stdout;
}

export function keyJwt(pem: string, config: AppConfig) {
  const key = createPrivateKey(pem);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(publicKey).digest('base64');
  assert(fingerprint === config.keyFingerprint, 'Unexpected key fingerprint');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 300, iss: config.clientId })}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`;
}
async function authenticate(config: AppConfig) {
  const stored = (
    await command([
      '/usr/bin/security',
      'find-generic-password',
      '-s',
      config.keychainService,
      '-a',
      config.keychainAccount,
      '-w',
      join(homedir(), 'Library/Keychains/login.keychain-db'),
    ])
  ).trim();
  return keyJwt(
    stored.startsWith('-----BEGIN') ? stored : Buffer.from(stored, 'hex').toString(),
    config,
  );
}
async function api(path: string, token: string, method = 'GET', body?: object): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `GitHub ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const runtime = { command, authenticate, api };

async function checkExisting(
  io: typeof runtime,
  repo: string,
  existing: string,
  slug: string,
  token: string,
) {
  const prefix = `https://github.com/${repo}/pull/`;
  const number = existing.startsWith(prefix) ? existing.slice(prefix.length) : '';
  assert(/^[1-9]\d*$/.test(number), 'Unexpected existing PR URL');
  const prior = await io.api(`/repos/${repo}/pulls/${number}`, token);
  assert(
    isRecord(prior) &&
      isRecord(prior.user) &&
      prior.user.type === 'Bot' &&
      prior.user.login === `${slug}[bot]`,
    'Existing PR was not created by the configured App',
  );
}

export async function publish(args: string[], io = runtime) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      'app-config': { type: 'string' },
      preflight: { type: 'boolean' },
      head: { type: 'string' },
      title: { type: 'string' },
      'body-file': { type: 'string' },
    },
    strict: true,
  });
  const { head, title, 'body-file': bodyPath } = values;
  assert(
    values.repo && (values.preflight || (head && title?.trim() && bodyPath)),
    'Required: --repo CHECKOUT and --preflight or --head BRANCH --title TITLE --body-file PATH',
  );
  const bodyFile = bodyPath ? resolve(bodyPath) : '';
  if (!values.preflight) {
    assert((await readFile(bodyFile, 'utf8')).trim(), 'PR body must not be empty');
  }
  const target = await readTarget(
    values.repo,
    async (argv, cwd) => (await io.command(argv, undefined, cwd)).trim(),
    true,
  );
  const { repository: repo, baseBranch: base } = target.config;
  assert(values.preflight || head !== base, 'Head must differ from base');
  const config = await appConfig(values['app-config'] ?? process.env.DOTAGENTS_APP_CONFIG);
  const jwt = await io.authenticate(config);
  assertRunning();
  const app = await io.api('/app', jwt);
  assert(
    isRecord(app) && app.id === config.id && typeof app.slug === 'string' && app.slug,
    'Unexpected App',
  );
  assertRunning();
  const installation = await io.api(`/repos/${repo}/installation`, jwt);
  assert(
    isRecord(installation) &&
      installation.id === config.installationId &&
      installation.app_id === config.id &&
      !installation.suspended_at &&
      isRecord(installation.permissions) &&
      installation.permissions.pull_requests === 'write',
    'App installation lacks target access',
  );
  assertRunning();
  const issued = await io.api(
    `/app/installations/${config.installationId}/access_tokens`,
    jwt,
    'POST',
    {
      repository_ids: [target.repositoryId],
      permissions: { pull_requests: 'write', contents: 'read', metadata: 'read' },
    },
  );
  assert(
    isRecord(issued) && typeof issued.token === 'string' && issued.token.length > 0,
    'Missing installation token',
  );
  const token = issued.token;
  try {
    assertRunning();
    const accessible = await io.api(`/repos/${repo}`, token);
    assert(
      isRecord(accessible) &&
        accessible.id === target.repositoryId &&
        accessible.full_name === repo,
      'Installation token cannot access target repository',
    );
    assertRunning();
    if (values.preflight) {
      return JSON.stringify({
        repository: repo,
        base,
        app: config.id,
        installation: config.installationId,
        actor: target.actor,
      });
    }
    assert(head && title);
    const existing = (
      await io.command(
        [
          'gh',
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--head',
          head,
          '--base',
          base,
          '--limit',
          '1',
          '--json',
          'url',
          '--jq',
          '.[0].url // empty',
        ],
        token,
      )
    ).trim();
    assertRunning();
    if (existing) {
      await checkExisting(io, repo, existing, app.slug, token);
      return existing;
    }
    return (
      await io.command(
        [
          'gh',
          'pr',
          'create',
          '--repo',
          repo,
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body-file',
          bodyFile,
        ],
        token,
      )
    ).trim();
  } finally {
    await io.api('/installation/token', token, 'DELETE');
  }
}

if (import.meta.main) {
  try {
    console.log(await withInterrupts(() => publish(process.argv.slice(2))));
    console.log('Temporary installation token revoked.');
  } catch (error) {
    // Stop reasons name the failed step, never the JWT or the installation token.
    console.error(
      `Publish failed: ${error instanceof Error ? error.message : String(error)}. Check arguments, App access and the PR state before retrying.`,
    );
    process.exitCode = 1;
  }
}
