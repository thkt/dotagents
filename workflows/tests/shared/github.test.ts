/** @file Outcome: The GitHub command registry keeps reads open and writes authority-bound. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import {
  GITHUB_ACCESS_ERROR,
  GITHUB_COMMAND_ERROR,
  GITHUB_OPERATION_POLICIES,
  githubIssueCreate,
  githubIssueView,
  githubPrCreate,
  runGitHub,
  type GitHubInvocation,
  withoutGitHubCredentials,
} from '../../shared/github.ts';
import { errorCode } from '../../shared/errors.ts';

function fakeGh(): { root: string; log: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-github-'));
  const log = path.join(root, 'calls.json');
  fs.writeFileSync(
    path.join(root, 'gh'),
    `#!/bin/sh
printf '%s' "$*" > '${log}'
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath || ''}`;
  onTestFinished(() => {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, log };
}

test('declares one closed policy for every GitHub operation', () => {
  assert.deepEqual(GITHUB_OPERATION_POLICIES, {
    'repo:view': { access: 'read', authority: null },
    'issue:view': { access: 'read', authority: null },
    'issue:publication-search': { access: 'read', authority: null },
    'label:list': { access: 'read', authority: null },
    'label:create': { access: 'write', authority: 'issue-publication' },
    'issue:create': { access: 'write', authority: 'issue-publication' },
    'issue:edit': { access: 'write', authority: 'issue-publication' },
    'pr:create': { access: 'write', authority: 'build-ship' },
    'pr:view': { access: 'read', authority: null },
  });
});

test('executes reads without write authority and rejects mismatched writes before spawning', () => {
  const fake = fakeGh();
  runGitHub(githubIssueView('owner/repo', 7));
  assert.match(fs.readFileSync(fake.log, 'utf8'), /^issue view 7 --repo owner\/repo/u);

  fs.unlinkSync(fake.log);
  assert.throws(
    () => runGitHub(githubIssueCreate('owner/repo', 'title', '/tmp/body', 'priority:low')),
    /requires issue-publication/u,
  );
  assert.equal(fs.existsSync(fake.log), false);
  assert.throws(
    () =>
      runGitHub(
        githubPrCreate('owner/repo', 'head', 'main', 'title', '/tmp/body'),
        'issue-publication',
      ),
    /requires build-ship/u,
  );
});

test('rejects an invocation not issued by a registry builder', () => {
  const fake = fakeGh();
  assert.throws(
    () =>
      runGitHub({
        executable: 'gh',
        operation: 'issue:view',
        args: ['issue', 'edit', '7'],
      } as unknown as GitHubInvocation),
    /must come from the closed registry/u,
  );
  assert.equal(fs.existsSync(fake.log), false);
});

test('freezes registered operations and their literal arguments', () => {
  const request = githubIssueView('owner/repo', 7);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.args), true);
});

test('removes GitHub tokens and isolates gh configuration for shell gates', () => {
  const environment = withoutGitHubCredentials(
    {
      PATH: '/bin',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      GH_ENTERPRISE_TOKEN: 'secret',
      GITHUB_ENTERPRISE_TOKEN: 'secret',
    },
    '/tmp/isolated-gh',
  );
  assert.deepEqual(environment, {
    PATH: '/bin',
    GH_CONFIG_DIR: '/tmp/isolated-gh',
    GH_PROMPT_DISABLED: 'true',
  });
});

test.each([
  ['error connecting to api.github.com', GITHUB_ACCESS_ERROR],
  ['HTTP 401: Bad credentials', GITHUB_ACCESS_ERROR],
  ['The token in default is invalid', GITHUB_ACCESS_ERROR],
  ['issue not found', GITHUB_COMMAND_ERROR],
] as const)('classifies GitHub command failure %s as %s', (message, expectedCode) => {
  const fake = fakeGh();
  fs.writeFileSync(
    path.join(fake.root, 'gh'),
    `#!/bin/sh
printf '%s' '${message}' >&2
exit 1
`,
    { mode: 0o755 },
  );
  assert.throws(
    () => runGitHub(githubIssueView('owner/repo', 7)),
    (error) => errorCode(error) === expectedCode,
  );
});
