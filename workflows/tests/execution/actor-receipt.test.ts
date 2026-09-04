/** @file Outcome: Durable actor publications resume idempotently and reject third-value state. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import {
  completeActorPublication,
  runRecoverableActor,
} from '../../execution/repository-isolation.ts';
import { actorPublicationPayloadDirectory } from '../../runtime/storage.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-publication-tests-');

function repository(): string {
  const repo = temporaryDirectory('codex-publication-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'one.txt'), 'before one\n');
  fs.writeFileSync(path.join(repo, 'two.txt'), 'before two\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'],
    { cwd: repo },
  );
  return repo;
}

test('a completed or partially reverted publication resumes without rerunning the actor', async () => {
  const repo = repository();
  const runId = `publication-${crypto.randomUUID()}`;
  let calls = 0;
  const run = async (sandbox: string) => {
    calls += 1;
    fs.writeFileSync(path.join(sandbox, 'one.txt'), 'after one\n');
    fs.writeFileSync(path.join(sandbox, 'two.txt'), 'after two\n');
    return { accepted: true };
  };
  assert.deepEqual(await runRecoverableActor(runId, 'implementation', repo, ['.'], run), {
    accepted: true,
  });
  fs.writeFileSync(path.join(repo, 'one.txt'), 'before one\n');
  assert.deepEqual(await runRecoverableActor(runId, 'implementation', repo, ['.'], run), {
    accepted: true,
  });
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8'), 'after one\n');
  completeActorPublication(runId);
});

test('a changed staged payload or third live value fails closed', async () => {
  const repo = repository();
  const runId = `publication-${crypto.randomUUID()}`;
  await runRecoverableActor(runId, 'implementation', repo, ['one.txt'], async (sandbox) => {
    fs.writeFileSync(path.join(sandbox, 'one.txt'), 'after\n');
    return { accepted: true };
  });
  fs.writeFileSync(path.join(repo, 'one.txt'), 'third\n');
  await assert.rejects(
    runRecoverableActor(runId, 'implementation', repo, ['one.txt'], async () => ({
      accepted: false,
    })),
    /unexpected publication state/u,
  );
  fs.writeFileSync(path.join(repo, 'one.txt'), 'before one\n');
  fs.writeFileSync(path.join(actorPublicationPayloadDirectory(runId), 'one.txt'), 'tampered\n');
  await assert.rejects(
    runRecoverableActor(runId, 'implementation', repo, ['one.txt'], async () => ({
      accepted: false,
    })),
    /staged payload changed/u,
  );
});
