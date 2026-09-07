/** @file Outcome: Cleanup acts only on the exact publication proven by a durable Ship receipt. */
import { cleanupRepository } from '../runtime/storage.ts';
import { spawnSync } from 'node:child_process';
import { FlowError } from '../shared/errors.ts';
import { isObject } from '../shared/schema.ts';
import {
  githubPrEvidence,
  githubRepoIdentity,
  parseGitHubJson,
  runGitHub,
} from '../shared/github.ts';
import {
  closed,
  counter,
  digest,
  oid,
  ownCleanup,
  probeDurability,
  publishRecord,
  readRecord,
  recordIdentities,
  text,
  type ObjectFormat,
} from './state.ts';
import { git, gitText, objectFormat } from './inventory.ts';

export interface Proof {
  repository_id: string;
  repository_name: string;
  head_repository_id: string;
  head_repository_name: string;
  number: number;
  url: string;
  base_ref: string;
  head_ref: string;
  head_oid: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged_at: string | null;
}
export interface SourceReceipt {
  repository: string;
  format: ObjectFormat;
  issue: number;
  run_id: string;
  remote: string;
  endpoint: string;
  proof: Proof;
}
export interface EvidenceGateway {
  proof(repository: string, selector: string): Proof;
  remote(repo: string, endpoint: string, ref: string): string | null;
  deleteRemote(repo: string, endpoint: string, ref: string, expected: string): void;
}
export function parseProof(raw: unknown): Proof {
  const p = closed(
    raw,
    [
      'repository_id',
      'repository_name',
      'head_repository_id',
      'head_repository_name',
      'number',
      'url',
      'base_ref',
      'head_ref',
      'head_oid',
      'state',
      'merged_at',
    ],
    'PR proof',
  );
  if (
    !['OPEN', 'CLOSED', 'MERGED'].includes(String(p.state)) ||
    !(
      p.merged_at === null ||
      (typeof p.merged_at === 'string' && Number.isFinite(Date.parse(p.merged_at)))
    )
  )
    throw new FlowError('invalid PR state/time', 'cleanup_evidence_invalid');
  if (p.base_ref === p.head_ref)
    throw new FlowError('PR base and topic must differ', 'cleanup_evidence_invalid');
  const number = counter(p.number, 'PR number');
  if (!number) throw new FlowError('invalid PR number', 'cleanup_evidence_invalid');
  const repository_name = text(p.repository_name, 'repository name');
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository_name) ||
    p.url !== `https://github.com/${repository_name}/pull/${number}`
  )
    throw new FlowError('PR URL/repository mismatch', 'cleanup_evidence_invalid');
  for (const field of ['base_ref', 'head_ref'])
    if (!String(p[field]).startsWith('refs/heads/'))
      throw new FlowError('expected fully qualified branch ref', 'cleanup_evidence_invalid');
  return {
    repository_id: text(p.repository_id, 'repository id'),
    repository_name,
    head_repository_id: text(p.head_repository_id, 'head repository id'),
    head_repository_name: text(p.head_repository_name, 'head repository name'),
    number,
    url: String(p.url),
    base_ref: String(p.base_ref),
    head_ref: String(p.head_ref),
    head_oid: text(p.head_oid, 'head OID'),
    state: p.state as Proof['state'],
    merged_at: p.merged_at as string | null,
  };
}
export function parseSource(raw: unknown): SourceReceipt {
  const r = closed(
    raw,
    ['repository', 'format', 'issue', 'run_id', 'remote', 'endpoint', 'proof'],
    'source receipt',
  );
  if (r.format !== 'sha1' && r.format !== 'sha256')
    throw new FlowError('invalid object format', 'cleanup_evidence_invalid');
  const proof = parseProof(r.proof);
  oid(proof.head_oid, r.format);
  const issue = counter(r.issue, 'Issue');
  if (!issue) throw new FlowError('Issue must be positive', 'cleanup_evidence_invalid');
  return {
    repository: text(r.repository, 'repository'),
    format: r.format,
    issue,
    run_id: text(r.run_id, 'run id'),
    remote: text(r.remote, 'remote'),
    endpoint: text(r.endpoint, 'endpoint'),
    proof,
  };
}
export function endpointRepository(endpoint: string): string {
  const m =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
      endpoint,
    );
  if (!m)
    throw new FlowError(
      'cleanup requires one literal GitHub HTTPS/SSH endpoint',
      'cleanup_endpoint_invalid',
    );
  return m[1]!;
}
export function pushEndpoint(repo: string, remote: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(remote))
    throw new FlowError('invalid remote name', 'cleanup_endpoint_invalid');
  const config = (key: string) => {
    const r = spawnSync('git', ['-C', repo, 'config', '--get-all', key], { encoding: 'utf8' });
    if (r.status === 1) return [];
    if (r.status !== 0) throw new FlowError(`cannot read ${key}`, 'cleanup_endpoint_invalid');
    return r.stdout.trim().split('\n').filter(Boolean);
  };
  const endpoints = config(`remote.${remote}.pushurl`);
  if (!endpoints.length) endpoints.push(...config(`remote.${remote}.url`));
  if (endpoints.length !== 1)
    throw new FlowError('cleanup requires exactly one push endpoint', 'cleanup_endpoint_invalid');
  const literal = endpoints[0]!;
  endpointRepository(literal);
  const resolved = gitText(repo, ['remote', 'get-url', '--push', '--all', remote]);
  if (resolved !== literal)
    throw new FlowError('rewritten or ambiguous push endpoint', 'cleanup_endpoint_invalid');
  return literal;
}
export const githubEvidence: EvidenceGateway = {
  proof(repository, selector) {
    const raw = parseGitHubJson(runGitHub(githubPrEvidence(repository, selector)), 'cleanup PR');
    const base = parseGitHubJson(runGitHub(githubRepoIdentity(repository)), 'cleanup repository');
    if (!isObject(raw) || !isObject(base) || !isObject(raw.headRepository))
      throw new FlowError('missing repository proof', 'cleanup_evidence_invalid');
    return parseProof({
      repository_id: base.id,
      repository_name: base.nameWithOwner,
      head_repository_id: raw.headRepository.id,
      head_repository_name: raw.headRepository.nameWithOwner,
      number: raw.number,
      url: raw.url,
      base_ref: `refs/heads/${text(raw.baseRefName, 'base ref')}`,
      head_ref: `refs/heads/${text(raw.headRefName, 'head ref')}`,
      head_oid: raw.headRefOid,
      state: raw.state,
      merged_at: raw.mergedAt,
    });
  },
  remote(repo, endpoint, ref) {
    const lines = gitText(repo, ['ls-remote', '--refs', endpoint, ref]).split('\n').filter(Boolean);
    if (!lines.length) return null;
    if (lines.length !== 1 || lines[0]!.split('\t')[1] !== ref)
      throw new FlowError('ambiguous remote reference', 'cleanup_evidence_invalid');
    return oid(lines[0]!.split('\t')[0], objectFormat(repo));
  },
  deleteRemote(repo, endpoint, ref, expected) {
    git(repo, ['push', endpoint, `--force-with-lease=${ref}:${expected}`, `:${ref}`]);
  },
};
export function verifySource(
  repo: string,
  source: SourceReceipt,
  gateway: EvidenceGateway,
  merged: boolean,
): Proof {
  if (
    source.repository !== cleanupRepository(repo) ||
    source.format !== objectFormat(repo) ||
    pushEndpoint(repo, source.remote) !== source.endpoint
  )
    throw new FlowError('source repository/endpoint drift', 'cleanup_evidence_invalid');
  const current = gateway.proof(endpointRepository(source.endpoint), String(source.proof.number));
  const bind = (p: Proof) => ({ ...p, state: 'OPEN', merged_at: null });
  if (
    digest('proof', bind(current)) !== digest('proof', bind(source.proof)) ||
    current.repository_name !== endpointRepository(source.endpoint) ||
    current.repository_id !== current.head_repository_id ||
    current.repository_name !== current.head_repository_name
  )
    throw new FlowError('PR publication identity changed', 'cleanup_evidence_invalid');
  if (merged && (current.state !== 'MERGED' || !current.merged_at))
    throw new FlowError('the exact shipped PR is not proven MERGED', 'cleanup_evidence_invalid');
  return current;
}
export function sourceIdentity(
  source: Pick<SourceReceipt, 'repository' | 'run_id' | 'issue'>,
): string {
  return digest('source', {
    repository: source.repository,
    run_id: source.run_id,
    issue: source.issue,
  });
}
export function captureShipReceipt(
  repo: string,
  issue: number,
  run_id: string,
  remote: string,
  base: string,
  head: string,
  exactPrUrl: string,
  gateway: EvidenceGateway = githubEvidence,
): void {
  using _owner = ownCleanup(repo);
  const endpoint = pushEndpoint(repo, remote);
  const proof = gateway.proof(endpointRepository(endpoint), head);
  const source = parseSource({
    repository: cleanupRepository(repo),
    format: objectFormat(repo),
    issue,
    run_id,
    remote,
    endpoint,
    proof,
  });
  if (
    proof.url !== exactPrUrl ||
    proof.state !== 'OPEN' ||
    proof.base_ref !== `refs/heads/${base}` ||
    proof.head_ref !== `refs/heads/${head}` ||
    proof.head_oid !== gitText(repo, ['rev-parse', 'HEAD']) ||
    gateway.remote(repo, endpoint, proof.head_ref) !== proof.head_oid
  )
    throw new FlowError('Ship source/remote/PR does not match', 'cleanup_evidence_invalid');
  verifySource(repo, source, gateway, false);
  try {
    probeDurability(repo);
    publishRecord(repo, 'source', sourceIdentity(source), source);
  } catch (error) {
    if (error instanceof FlowError && error.code === 'cleanup_record_conflict') throw error;
    throw new FlowError(
      `matched Ship receipt persistence failed: ${String(error)}`,
      'ship_receipt_persistence_failed',
    );
  }
}
export function selectSource(repo: string, issue: number): SourceReceipt {
  const matches = recordIdentities(repo, 'source')
    .map((id) => readRecord(repo, 'source', id, parseSource))
    .filter((s) => s.issue === issue);
  if (matches.length !== 1)
    throw new FlowError(
      'cleanup requires exactly one recorded Ship source receipt; historical receipts cannot be inferred',
      'cleanup_evidence_invalid',
    );
  return matches[0]!;
}
