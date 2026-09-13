import assert from 'node:assert/strict';
import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { withInterrupts } from '../correction.ts';
import { publish, keyJwt } from '../publish.ts';
import { initializeTarget, githubTarget, git, testApp } from './support/target.ts';

afterEach(async () => {
  await withInterrupts(async () => {});
});

function option(args: string[], name: string) {
  expect(args).toContain(name);
  return args[args.indexOf(name) + 1];
}

function publicationResponses(mode: string): Record<string, unknown> {
  return {
    '/app': { id: mode === 'wrong_app' ? 0 : 42, slug: 'workflow-app' },
    '/repos/team/component/pulls/1': {
      user: {
        type: mode === 'personal_pr' ? 'User' : 'Bot',
        login: mode === 'personal_pr' ? 'operator' : 'workflow-app[bot]',
      },
    },
    '/repos/team/component': {
      id: mode === 'wrong_token_repo' ? 456 : 123,
      full_name: 'team/component',
    },
    '/app/installations/89/access_tokens': { token: 'installation-secret' },
    '/repos/team/component/installation': {
      id: mode === 'wrong_installation' ? 90 : 89,
      app_id: 42,
      permissions: { pull_requests: mode === 'denied_app' ? 'read' : 'write' },
    },
  };
}
function publicationReply(args: string[], mode: string) {
  if (mode === `${args[2]}_failed`) {
    throw Error(mode);
  }
  if (args[2] === 'list') {
    return ['existing', 'personal_pr'].includes(mode)
      ? 'https://github.com/team/component/pull/1\n'
      : '';
  }
  return 'https://github.com/team/component/pull/2\n';
}
function checkPublicationCommand(args: string[], token: string | undefined, body: string) {
  expect(args.slice(0, 2)).toEqual(['gh', 'pr']);
  expect(token).toBe('installation-secret');
  expect(args.join(' ')).not.toContain('secret');
  expect(option(args, '--repo')).toBe('team/component');
  expect(option(args, '--base')).toBe('release');
  expect(option(args, '--head')).toBe('codex/test');
  if (args[2] === 'create') {
    expect(option(args, '--body-file')).toBe(body);
    expect(option(args, '--title')).toBe('Title with spaces');
  }
}

function checkSuccessfulPublication(mode: string, result: string) {
  if (mode === 'preflight') {
    expect(JSON.parse(result)).toEqual({
      repository: 'team/component',
      base: 'release',
      app: 42,
      installation: 89,
      actor: 'operator',
    });
  } else {
    expect(result).toBe(`https://github.com/team/component/pull/${mode === 'existing' ? 1 : 2}`);
  }
}

for (const mode of [
  'create',
  'existing',
  'personal_pr',
  'preflight',
  'create_failed',
  'list_failed',
  'empty',
  'revoke_failed',
  'wrong_app',
  'wrong_installation',
  'denied_app',
  'wrong_token_repo',
  'denied_operator',
  'app_interrupted',
  'token_interrupted',
] as const) {
  test(`publisher: ${mode}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'publisher-test-'));
    try {
      const repo = join(dir, 'checkout');
      await mkdir(repo);
      await initializeTarget(repo);
      const config = join(dir, 'app.json');
      await writeFile(config, JSON.stringify(testApp));
      const body = join(dir, 'body with spaces.md');
      await writeFile(body, mode === 'empty' ? '' : 'Reviewable body');
      const commands: { args: string[]; token: string | undefined }[] = [];
      const requests: { path: string; method: string; input: object | undefined }[] = [];
      let authenticated = false;
      const io = {
        authenticate: async (value: typeof testApp) => {
          expect(value).toEqual(testApp);
          authenticated = true;
          return 'jwt-secret';
        },
        api: async (
          path: string,
          token: string,
          method = 'GET',
          input?: object,
        ): Promise<unknown> => {
          requests.push({ path, method, input });
          if (
            (mode === 'app_interrupted' && path === '/app') ||
            (mode === 'token_interrupted' && path.endsWith('access_tokens'))
          ) {
            process.emit('SIGINT');
          }
          if (path === '/installation/token') {
            expect(token).toBe('installation-secret');
            if (mode === 'revoke_failed') {
              throw Error('revoke_failed');
            }
            return null;
          }
          const responses = publicationResponses(mode);
          expect(token).toBe(
            ['/repos/team/component', '/repos/team/component/pulls/1'].includes(path)
              ? 'installation-secret'
              : 'jwt-secret',
          );
          assert(path in responses, `Unexpected API request: ${path}`);
          return responses[path];
        },
        command: async (args: string[], token?: string, cwd?: string) => {
          if (args[0] === 'git') {
            assert(cwd);
            return git(cwd, ...args.slice(1));
          }
          const targetReply = githubTarget(args);
          if (targetReply !== undefined) {
            return mode === 'denied_operator'
              ? targetReply.replace('"push":true', '"push":false')
              : targetReply;
          }
          commands.push({ args, token });
          return publicationReply(args, mode);
        },
      };
      const args = [
        '--repo',
        repo,
        '--app-config',
        config,
        ...(mode === 'preflight'
          ? ['--preflight']
          : ['--head', 'codex/test', '--title', 'Title with spaces', '--body-file', body]),
      ];
      if (['create', 'existing', 'preflight'].includes(mode)) {
        const result = await withInterrupts(() => publish(args, io));
        checkSuccessfulPublication(mode, result);
      } else {
        const reasons = {
          app_interrupted: /Interrupted execution/,
          token_interrupted: /Interrupted execution/,
          personal_pr: /Existing PR was not created by the configured App/,
          create_failed: /create_failed/,
          list_failed: /list_failed/,
          empty: /body must not be empty/,
          revoke_failed: /revoke_failed/,
          wrong_app: /Unexpected App/,
          wrong_installation: /App installation lacks target access/,
          denied_app: /App installation lacks target access/,
          wrong_token_repo: /Installation token cannot access target repository/,
          denied_operator: /push permission required/,
        };
        assert(mode !== 'create' && mode !== 'existing' && mode !== 'preflight');
        await assert.rejects(() => withInterrupts(() => publish(args, io)), reasons[mode]);
      }
      expect(authenticated).toBe(!['empty', 'denied_operator'].includes(mode));
      const issued = ![
        'empty',
        'denied_operator',
        'wrong_app',
        'app_interrupted',
        'wrong_installation',
        'denied_app',
      ].includes(mode);
      expect(requests.filter(({ path }) => path.endsWith('access_tokens'))).toEqual(
        issued
          ? [
              {
                path: '/app/installations/89/access_tokens',
                method: 'POST',
                input: {
                  repository_ids: [123],
                  permissions: { pull_requests: 'write', contents: 'read', metadata: 'read' },
                },
              },
            ]
          : [],
      );
      expect(requests.filter(({ path }) => path === '/installation/token')).toEqual(
        issued ? [{ path: '/installation/token', method: 'DELETE', input: undefined }] : [],
      );
      const listed =
        issued && !['preflight', 'wrong_token_repo', 'token_interrupted'].includes(mode);
      expect(commands.map(({ args }) => args[2])).toEqual([
        ...(listed ? ['list'] : []),
        ...(['create', 'create_failed', 'revoke_failed'].includes(mode) ? ['create'] : []),
      ]);
      for (const { args, token } of commands) {
        checkPublicationCommand(args, token, body);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('publisher CLI rejects missing target before touching credentials', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../publish.ts')], {
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Publish failed: Required: --repo CHECKOUT');
});

test('publisher binds its signing key and issuer to the configured App', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  expect(() => keyJwt(pem, testApp)).toThrow('Unexpected key fingerprint');
  const keyFingerprint = createHash('sha256')
    .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const payload = keyJwt(pem, { ...testApp, keyFingerprint }).split('.')[1];
  assert(payload);
  const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
  expect(value).toMatchObject({ iss: 'configured-client' });
});
