/** @file Outcome: Only exact Ship provenance can justify cleanup preparation. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { temporaryDirectory } from '../shared/fixtures.ts';
import { git, gitText } from '../../cleanup/inventory.ts';
import {
  captureShipReceipt,
  endpointRepository,
  pushEndpoint,
  selectSource,
  verifySource,
  type EvidenceGateway,
  type Proof,
} from '../../cleanup/evidence.ts';

function fixture() {
  const repo = temporaryDirectory('cleanup-evidence-');
  git(repo, ['init', '-q', '-b', 'topic']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'source',
  ]);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  const proof: Proof = {
    repository_id: 'R_fixture',
    repository_name: 'fixture/repo',
    head_repository_id: 'R_fixture',
    head_repository_name: 'fixture/repo',
    number: 7,
    url: 'https://github.com/fixture/repo/pull/7',
    base_ref: 'refs/heads/main',
    head_ref: 'refs/heads/topic',
    head_oid: gitText(repo, ['rev-parse', 'HEAD']),
    state: 'OPEN',
    merged_at: null,
  };
  const gateway: EvidenceGateway = {
    proof() {
      return { ...proof };
    },
    remote() {
      return proof.head_oid;
    },
    deleteRemote() {
      throw new Error('no deletion authorized');
    },
  };
  return { repo, proof, gateway };
}
test('Ship receipt is immutable and exact merged proof works regardless of merge strategy', () => {
  const { repo, proof, gateway } = fixture();
  captureShipReceipt(repo, 29, 'run', 'origin', 'main', 'topic', proof.url, gateway);
  captureShipReceipt(repo, 29, 'run', 'origin', 'main', 'topic', proof.url, gateway);
  const receipt = selectSource(repo, 29);
  assert.equal(receipt.proof.head_oid, proof.head_oid);
  assert.throws(() => verifySource(repo, receipt, gateway, true), /not proven MERGED/);
  for (const state of ['CLOSED', 'OPEN'] as const) {
    proof.state = state;
    assert.throws(() => verifySource(repo, receipt, gateway, true), /not proven MERGED/);
  }
  proof.state = 'MERGED';
  proof.merged_at = '2026-09-07T00:00:00Z';
  assert.equal(verifySource(repo, receipt, gateway, true).state, 'MERGED');
  proof.repository_id = 'R_transferred';
  assert.throws(() => verifySource(repo, receipt, gateway, true), /identity changed/);
});
test('changed publication and ambiguous endpoints cannot create or justify a receipt', () => {
  const { repo, proof, gateway } = fixture();
  assert.throws(() => selectSource(repo, 29), /exactly one/);
  assert.throws(
    () => captureShipReceipt(repo, 29, 'run', 'origin', 'other-base', 'topic', proof.url, gateway),
    /does not match/,
  );
  proof.head_oid = 'a'.repeat(40);
  assert.throws(
    () => captureShipReceipt(repo, 29, 'run', 'origin', 'main', 'topic', proof.url, gateway),
    /does not match/,
  );
  git(repo, ['config', '--add', 'remote.origin.pushurl', 'https://github.com/fixture/repo.git']);
  git(repo, ['config', '--add', 'remote.origin.pushurl', 'https://github.com/fixture/other.git']);
  assert.throws(() => pushEndpoint(repo, 'origin'), /exactly one/);
  assert.throws(
    () => endpointRepository('https://user:password@github.com/fixture/repo'),
    /literal GitHub/,
  );
  assert.equal(endpointRepository('git@github.com:fixture/repo.git'), 'fixture/repo');
});

test('every stable publication binding and unavailable merged proof fails closed', () => {
  const { repo, proof, gateway } = fixture();
  captureShipReceipt(repo, 29, 'run', 'origin', 'main', 'topic', proof.url, gateway);
  const source = selectSource(repo, 29);
  proof.state = 'MERGED';
  proof.merged_at = '2026-09-07T00:00:00Z';
  for (const changed of [
    { repository_name: 'fixture/renamed' },
    { head_repository_id: 'R_other' },
    { head_repository_name: 'other/repo' },
    { base_ref: 'refs/heads/other' },
    { head_ref: 'refs/heads/other' },
    { head_oid: 'a'.repeat(40) },
    { url: 'https://github.com/fixture/repo/pull/8' },
    { number: 8 },
  ]) {
    assert.throws(
      () =>
        verifySource(repo, source, { ...gateway, proof: () => ({ ...proof, ...changed }) }, true),
      /identity changed/,
    );
  }
  assert.throws(
    () =>
      verifySource(
        repo,
        source,
        {
          ...gateway,
          proof: () => {
            throw new Error('API unavailable');
          },
        },
        true,
      ),
    /API unavailable/,
  );
  git(repo, ['config', 'remote.origin.url', 'https://github.com/fixture/changed.git']);
  assert.throws(() => verifySource(repo, source, gateway, true), /endpoint drift/);
});
