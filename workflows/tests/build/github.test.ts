/** @file Outcome: Draft PR inspection distinguishes a match, explicit absence, mismatch, and inaccessible GitHub. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { inspectDraftPullRequest } from '../../flow/build/github.ts';
import { errorCode } from '../../shared/errors.ts';
import { GITHUB_ACCESS_ERROR, GITHUB_RESPONSE_ERROR } from '../../shared/github.ts';

const expected = {
  repository: 'owner/repo',
  branch: 'codex/example',
  baseBranch: 'main',
  title: 'Title',
  body: 'Body',
};

const pullRequest = {
  url: 'https://github.com/owner/repo/pull/9',
  isDraft: true,
  baseRefName: 'main',
  headRefName: 'codex/example',
  title: 'Title',
  body: 'Body',
};

function fakeGh(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-build-github-'));
  const log = path.join(root, 'args.json');
  const executable = path.join(root, 'gh');
  const previousPath = process.env.PATH;
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env bun
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
${body}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${previousPath || ''}`;
  onTestFinished(() => {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return log;
}

test('accepts one exact draft PR from the registered read command', () => {
  const log = fakeGh(`console.log(${JSON.stringify(JSON.stringify(pullRequest))});`);
  assert.deepEqual(inspectDraftPullRequest(expected), {
    status: 'matched',
    pullRequest,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), [
    'pr',
    'view',
    'codex/example',
    '--repo',
    'owner/repo',
    '--json',
    'url,isDraft,baseRefName,headRefName,title,body',
  ]);
});

test('accepts gh-rewritten screenshot URLs while keeping the rest of the body exact', () => {
  const expectedWithScreenshot = {
    ...expected,
    body: 'Before\n![Home](./home.png)\nAfter',
    screenshots: [{ name: 'home.png', alt: 'Home' }],
  };
  fakeGh(
    `console.log(${JSON.stringify(
      JSON.stringify({
        ...pullRequest,
        body: 'Before\n![Home](https://github.com/user-attachments/assets/123e4567-e89b-12d3-a456-426614174000)\nAfter',
      }),
    )});`,
  );
  assert.equal(inspectDraftPullRequest(expectedWithScreenshot).status, 'matched');
});

test('treats a partially uploaded screenshot set as a body mismatch', () => {
  const expectedWithScreenshots = {
    ...expected,
    body: '![Before](./before.png)\n![After](./after.png)',
    screenshots: [
      { name: 'before.png', alt: 'Before' },
      { name: 'after.png', alt: 'After' },
    ],
  };
  fakeGh(
    `console.log(${JSON.stringify(
      JSON.stringify({
        ...pullRequest,
        body: '![Before](https://github.com/user-attachments/assets/123e4567-e89b-12d3-a456-426614174000)\n![After](./after.png)',
      }),
    )});`,
  );
  const result = inspectDraftPullRequest(expectedWithScreenshots);
  assert.equal(result.status, 'mismatch');
  if (result.status === 'mismatch') assert.match(result.error, /body/u);
});

test('treats only an explicit missing PR as absent', () => {
  fakeGh(`console.error('no pull requests found for branch codex/example'); process.exit(1);`);
  const result = inspectDraftPullRequest(expected);
  assert.equal(result.status, 'absent');
});

test('reports an existing mismatched PR instead of authorizing another create', () => {
  fakeGh(
    `console.log(${JSON.stringify(JSON.stringify({ ...pullRequest, baseRefName: 'wrong' }))});`,
  );
  const result = inspectDraftPullRequest(expected);
  assert.equal(result.status, 'mismatch');
  if (result.status !== 'mismatch') return;
  assert.match(result.error, /baseRefName/u);
});

test('rejects malformed PR output as a GitHub response error', () => {
  fakeGh(`console.log('{broken');`);
  assert.throws(
    () => inspectDraftPullRequest(expected),
    (error) => errorCode(error) === GITHUB_RESPONSE_ERROR,
  );
});

test('propagates GitHub access failures instead of treating the PR as absent', () => {
  fakeGh(`console.error('error connecting to api.github.com'); process.exit(1);`);
  assert.throws(
    () => inspectDraftPullRequest(expected),
    (error) => errorCode(error) === GITHUB_ACCESS_ERROR,
  );
});
