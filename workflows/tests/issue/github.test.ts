/** @file Outcome: The GitHub adapter passes authored values literally and accepts only verified records. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { GhIssueGateway } from '../../issue/github.ts';
import type { GitHubWriteAuthority } from '../../shared/github.ts';

function fakeGh(
  body: string,
  authority: GitHubWriteAuthority | null = null,
): { gateway: GhIssueGateway; invocations(): string[][] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gh-gateway-'));
  const executable = path.join(root, 'gh');
  const log = path.join(root, 'calls.ndjson');
  const previousPath = process.env.PATH;
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
${body}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${previousPath || ''}`;
  onTestFinished(() => {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    gateway: new GhIssueGateway(authority),
    invocations: () =>
      (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

const issue = {
  number: 7,
  title: 'literal $(touch never)',
  body: 'body',
  url: 'https://github.com/owner/repo/issues/7',
};

test('checkAccess verifies the exact repository through a read-only gh command', () => {
  const fake = fakeGh(`
if (args[0] === 'repo' && args[1] === 'view') console.log(JSON.stringify({ nameWithOwner: 'owner/repo' }));
else process.exit(2);
`);
  fake.gateway.checkAccess('owner/repo');
  assert.deepEqual(fake.invocations(), [['repo', 'view', 'owner/repo', '--json', 'nameWithOwner']]);
});

test('create passes title and body path as literal gh arguments, then verifies the created Issue', () => {
  const fake = fakeGh(
    `
if (args[0] === 'issue' && args[1] === 'create') console.log(${JSON.stringify(issue.url)});
else if (args[0] === 'issue' && args[1] === 'view') console.log(${JSON.stringify(JSON.stringify(issue))});
else process.exit(2);
`,
    'issue-publication',
  );
  const created = fake.gateway.create('owner/repo', issue.title, '/tmp/body with spaces.md');

  assert.deepEqual(created, issue);
  assert.deepEqual(fake.invocations(), [
    [
      'issue',
      'create',
      '--repo',
      'owner/repo',
      '--title',
      issue.title,
      '--body-file',
      '/tmp/body with spaces.md',
    ],
    ['issue', 'view', '7', '--repo', 'owner/repo', '--json', 'number,title,body,url'],
  ]);
});

test('write methods reject a read-only gateway before spawning gh', () => {
  const fake = fakeGh(`process.exit(2);`);
  assert.throws(
    () => fake.gateway.create('owner/repo', 'title', '/tmp/body'),
    /requires issue-publication/u,
  );
  assert.equal(fake.invocations().length, 0);
});

test('finds one prior publication by its public id for crash recovery', () => {
  const publicationId = '00000000-0000-4000-8000-000000000004';
  const published = {
    ...issue,
    body: `body\npublication_id:${publicationId}`,
  };
  const fake = fakeGh(`
if (args[0] === 'issue' && args[1] === 'list') console.log(${JSON.stringify(JSON.stringify([published]))});
else process.exit(2);
`);

  assert.deepEqual(fake.gateway.findByPublicationId('owner/repo', publicationId), published);
  assert.deepEqual(fake.invocations()[0], [
    'issue',
    'list',
    '--repo',
    'owner/repo',
    '--state',
    'all',
    '--search',
    `${publicationId} in:body`,
    '--limit',
    '100',
    '--json',
    'number,title,body,url',
  ]);
});

test('view rejects malformed JSON and invalid Issue records from gh', () => {
  const malformed = fakeGh(`console.log('{not-json');`);
  assert.throws(() => malformed.gateway.view('owner/repo', 7), /not valid JSON/u);

  const invalid = fakeGh(
    `console.log(JSON.stringify({ number: 7, title: '', body: '', url: 'x', labels: [] }));`,
  );
  assert.throws(() => invalid.gateway.view('owner/repo', 7), /invalid issue record/u);
});
