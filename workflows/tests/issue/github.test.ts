/** @file Outcome: The GitHub adapter passes authored values literally and accepts only verified records. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { GhIssueGateway } from '../../issue/github.ts';

function fakeGh(body: string): { gateway: GhIssueGateway; invocations(): string[][] } {
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
    gateway: new GhIssueGateway(),
    invocations: () =>
      fs
        .readFileSync(log, 'utf8')
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
  labels: [{ name: 'priority:medium' }],
};

test('create passes title and body path as literal gh arguments, then verifies the created Issue', () => {
  const fake = fakeGh(`
if (args[0] === 'issue' && args[1] === 'create') console.log(${JSON.stringify(issue.url)});
else if (args[0] === 'issue' && args[1] === 'view') console.log(${JSON.stringify(JSON.stringify(issue))});
else process.exit(2);
`);
  const created = fake.gateway.create(
    'owner/repo',
    issue.title,
    '/tmp/body with spaces.md',
    'priority:medium',
  );

  assert.deepEqual(created, { ...issue, labels: ['priority:medium'] });
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
      '--label',
      'priority:medium',
    ],
    ['issue', 'view', '7', '--repo', 'owner/repo', '--json', 'number,title,body,url,labels'],
  ]);
});

test('ensureLabel creates a missing supported priority and refuses unsupported labels', () => {
  const fake = fakeGh(`
if (args[0] === 'label' && args[1] === 'list') console.log('[]');
else if (args[0] === 'label' && args[1] === 'create') process.exit(0);
else process.exit(2);
`);
  fake.gateway.ensureLabel('owner/repo', 'priority:high');
  assert.deepEqual(fake.invocations()[1], [
    'label',
    'create',
    'priority:high',
    '--repo',
    'owner/repo',
    '--color',
    'd93f0b',
    '--description',
    'Work that should be addressed soon.',
  ]);

  assert.throws(
    () => fake.gateway.ensureLabel('owner/repo', 'arbitrary'),
    /Unsupported issue label/u,
  );
  assert.equal(fake.invocations().filter((args) => args[1] === 'create').length, 1);
});

test('view rejects malformed JSON and invalid Issue records from gh', () => {
  const malformed = fakeGh(`console.log('{not-json');`);
  assert.throws(() => malformed.gateway.view('owner/repo', 7), /not valid JSON/u);

  const invalid = fakeGh(
    `console.log(JSON.stringify({ number: 7, title: '', body: '', url: 'x', labels: [] }));`,
  );
  assert.throws(() => invalid.gateway.view('owner/repo', 7), /invalid issue record/u);
});
