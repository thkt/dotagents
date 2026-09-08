/** @file Outcome: Cleanup CLI uses only an explicit task/repository/digest-bound approval. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'bun:test';
import {
  ignoreWorkflowStorage,
  temporaryDirectory,
  useTemporaryWorkflowStorage,
} from '../shared/fixtures.ts';
import { handle } from '../../../hooks/workflow-enforcer.ts';
import { armIntent, loadIntent, parseCleanupInvocation } from '../../runtime/invocation.ts';
import { workflowInputPath } from '../../runtime/storage.ts';
import { captureShipReceipt, type Proof, type EvidenceGateway } from '../../cleanup/evidence.ts';
import { git, gitText } from '../../cleanup/inventory.ts';
import { cleanupCommand, main } from '../../cleanup/runner.ts';

useTemporaryWorkflowStorage('cleanup-runner-');
test('closed CLI and leading invocation reject broad approvals and unknown flags', () => {
  assert.equal(typeof main(['describe']), 'object');
  assert.throws(() => main(['delete', '--input', '/tmp/no', '--run-id', 'run']));
  assert.throws(() => main(['describe', '--force', 'true']));
  for (const prompt of ['$cleanup', '$cleanup approve all', '$cleanup 29 extra', '$cleanup -1'])
    assert.throws(() => parseCleanupInvocation(prompt));
  assert.deepEqual(parseCleanupInvocation('$cleanup #29'), { command: 'prepare', issue: 29 });
  assert.deepEqual(handle({ hook_event_name: 'Stop', prompt: '$cleanup 29' }), {});
});
test('hook preview and exact approval reach production runner; changed input and rearming are denied', () => {
  const repo = temporaryDirectory('cleanup-runner-repo-');
  git(repo, ['init', '-q', '-b', 'topic']);
  ignoreWorkflowStorage(repo);
  fs.mkdirSync(`${repo}/.codex`, { recursive: true });
  fs.writeFileSync(`${repo}/.codex/OUTCOME.md`, '# Outcome\nPreserve local state.\n');
  fs.writeFileSync(`${repo}/.gitignore`, 'secret\n/.codex/workflow-artifacts/\n');
  fs.writeFileSync(`${repo}/secret`, 'fixture-private-value');
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['commit', '--allow-empty', '-qm', 'source']);
  git(repo, ['branch', 'main']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  const head = gitText(repo, ['rev-parse', 'HEAD']);
  const proof: Proof = {
    repository_id: 'R_fixture',
    repository_name: 'fixture/repo',
    head_repository_id: 'R_fixture',
    head_repository_name: 'fixture/repo',
    number: 7,
    url: 'https://github.com/fixture/repo/pull/7',
    base_ref: 'refs/heads/main',
    head_ref: 'refs/heads/topic',
    head_oid: head,
    state: 'OPEN',
    merged_at: null,
  };
  let remote: string | null = head;
  let deletes = 0;
  const gateway: EvidenceGateway = {
    proof: () => ({ ...proof }),
    remote: (_r, _e, ref) => (ref === proof.head_ref ? remote : head),
    deleteRemote: () => {
      remote = null;
      deletes++;
    },
  };
  captureShipReceipt(repo, 29, 'build', 'origin', 'main', 'topic', proof.url, gateway);
  proof.state = 'MERGED';
  proof.merged_at = '2026-09-07T00:00:00Z';
  const runId = 'cleanup-task';
  const input = workflowInputPath(runId, 'cleanup');
  const hook = (prompt: string) =>
    handle({ hook_event_name: 'UserPromptSubmit', cwd: repo, session_id: runId, prompt });
  const initial = hook('$cleanup 29');
  assert.equal(initial.decision, undefined, initial.reason ?? '');
  const preview = cleanupCommand('prepare', runId, input, gateway) as { prepared_digest: string };
  assert.equal(deletes, 0);
  assert.doesNotMatch(
    JSON.stringify(preview),
    /fixture-private-value|Zml4dHVyZS1wcml2YXRlLXZhbHVl|"bytes"|"inventory"/,
  );
  assert.equal(loadIntent(runId), null);
  assert.throws(() => cleanupCommand('run', runId, input, gateway));
  assert.equal(hook(`$cleanup approve ${preview.prepared_digest}`).decision, undefined);
  const original = fs.readFileSync(input, 'utf8');
  fs.writeFileSync(input, original.replace(preview.prepared_digest, 'a'.repeat(64)));
  assert.throws(() => cleanupCommand('run', runId, input, gateway), /differs from explicit/);
  fs.writeFileSync(input, original);
  const stopped = cleanupCommand('run', runId, input, {
    ...gateway,
    deleteRemote: () => {
      throw new Error('unknown result');
    },
  }) as { status: string };
  assert.equal(stopped.status, 'resumable');
  assert.throws(() => armIntent({ runId, workflow: 'code', cwd: repo }), /unfinished cleanup/);
  assert.equal(hook('$cleanup 29').decision, 'block');
  assert.equal(deletes, 0);
  remote = null;
  const result = cleanupCommand('resume', runId, input, gateway) as { status: string };
  assert.equal(result.status, 'cleaned');
  assert.equal(deletes, 0);
  assert.throws(() => cleanupCommand('resume', 'different-task', input, gateway), /hook-supplied/);
  // This production-entrypoint case runs preview, approval, interruption and recovery,
  // including fresh Git-backed storage checks at every durable publication.
}, 30_000);
