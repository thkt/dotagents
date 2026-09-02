/** @file Outcome: One public GitHub Issue carries an exact human and machine Build contract. */

import {
  compileBuildPlan,
  parseBuildPlanAuthoring,
  type CompiledBuildPlan,
} from '../flow/build/authoring.ts';
import { sha256 } from '../shared/evidence.ts';
import { FlowError, errorMessage } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';

// Public Issues outlive any one harness release. The semantic name is stable while the schema is
// validated exactly; stale publications are recreated instead of being guessed across releases.
const PUBLIC_ISSUE_CONTRACT_PROTOCOL = 'codex-public-build-contract' as const;

const CONTRACT_OPEN = `<!-- ${PUBLIC_ISSUE_CONTRACT_PROTOCOL}\n`;
const PUBLICATION_METADATA_OPEN = '<!-- codex-issue-publication\n';
const CONTRACT_CLOSE = '\n-->';
const PUBLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FlowError(`${label} is required`);
  return value;
}

export function digest(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new FlowError(`${label} must be a SHA-256 digest`);
  return result;
}

export function repositoryName(value: unknown, label: string): string {
  const repository = requiredString(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new FlowError(`${label} must be owner/name`);
  }
  return repository;
}

export function positiveIssue(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new FlowError(`${label} must be a positive integer`);
  }
  return Number(value);
}

/** Seals the human-readable body and canonical Plan into one publicly portable Issue contract. */
export function renderPublicIssueBody(
  body: string,
  plan: CompiledBuildPlan,
  publicationId: string,
): string {
  if (/<!-- codex-public-build-contract\/v\d+\n/u.test(body)) {
    throw new FlowError(
      'issue body uses an obsolete public build contract; recreate it with the current $issue workflow',
      'decision_error',
    );
  }
  if (body.includes(CONTRACT_OPEN) || body.includes(PUBLICATION_METADATA_OPEN)) {
    throw new FlowError('issue body already contains a public build contract', 'decision_error');
  }
  if (!PUBLICATION_ID.test(publicationId)) {
    throw new FlowError('issue publication_id must be a UUIDv4', 'decision_error');
  }
  const visibleBody = body.trimEnd();
  const canonicalPlan = plan.markdown.trimEnd();
  if (!visibleBody.endsWith(canonicalPlan)) {
    throw new FlowError('issue body does not contain its exact canonical Plan', 'decision_error');
  }
  const prose = visibleBody.slice(0, -canonicalPlan.length).trimEnd();
  const portableVisibleBody = [
    ...(prose ? [prose] : []),
    `${PUBLICATION_METADATA_OPEN}publication_id:${publicationId}${CONTRACT_CLOSE}`,
    canonicalPlan,
  ].join('\n\n');
  const contract = {
    protocol: PUBLIC_ISSUE_CONTRACT_PROTOCOL,
    body_sha256: sha256(portableVisibleBody),
    plan: plan.authoring,
  };
  const encoded = Buffer.from(JSON.stringify(contract)).toString('base64url');
  return `${portableVisibleBody}\n\n${CONTRACT_OPEN}${encoded}${CONTRACT_CLOSE}\n`;
}

function publicationMetadata(body: string): {
  publicationId: string | null;
  visibleBody: string;
} {
  const starts = [...body.matchAll(/<!-- codex-issue-publication\n/gu)].map((match) => match.index);
  if (starts.length === 0) return { publicationId: null, visibleBody: body };
  if (starts.length !== 1) {
    throw new FlowError('GitHub Issue has no unique publication metadata');
  }
  const start = starts[0]! + PUBLICATION_METADATA_OPEN.length;
  const end = body.indexOf(CONTRACT_CLOSE, start);
  if (end < 0) throw new FlowError('GitHub Issue publication metadata is incomplete');
  const content = body.slice(start, end);
  const publicationId = content.startsWith('publication_id:')
    ? content.slice('publication_id:'.length)
    : '';
  if (!PUBLICATION_ID.test(publicationId)) {
    throw new FlowError('GitHub Issue publication metadata has an invalid publication id');
  }
  const commentStart = starts[0]!;
  const commentEnd = end + CONTRACT_CLOSE.length;
  const before = body.slice(0, commentStart).trimEnd();
  const after = body.slice(commentEnd).trimStart();
  return {
    publicationId,
    visibleBody: [before, after].filter(Boolean).join('\n\n'),
  };
}

/** Validates that the visible Issue body, body digest, and machine Plan are one exact contract. */
export function parsePublicIssueBody(body: string): {
  visibleBody: string;
  publication_id: string;
  plan: CompiledBuildPlan;
} {
  if (/<!-- codex-public-build-contract\/v\d+\n/u.test(body)) {
    throw new FlowError(
      'GitHub Issue uses an obsolete public build contract; recreate it with the current $issue workflow',
    );
  }
  const start = body.indexOf(CONTRACT_OPEN);
  if (start < 0 || body.indexOf(CONTRACT_OPEN, start + CONTRACT_OPEN.length) >= 0) {
    throw new FlowError('GitHub Issue has no unique public build contract');
  }
  const suffix = body.slice(start + CONTRACT_OPEN.length).trimEnd();
  if (!suffix.endsWith(CONTRACT_CLOSE)) {
    throw new FlowError('GitHub Issue public build contract is not terminal');
  }
  const sealedVisibleBody = body.slice(0, start).trimEnd();
  let raw: unknown;
  try {
    const encoded = suffix.slice(0, -CONTRACT_CLOSE.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('invalid base64url');
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new FlowError('GitHub Issue public build contract is not valid JSON');
  }
  if (!isObject(raw) || raw.protocol !== PUBLIC_ISSUE_CONTRACT_PROTOCOL) {
    throw new FlowError(`GitHub Issue contract.protocol must be ${PUBLIC_ISSUE_CONTRACT_PROTOCOL}`);
  }
  rejectUnknownKeys(raw, ['protocol', 'body_sha256', 'plan'], 'GitHub Issue contract');
  if (sha256(sealedVisibleBody) !== digest(raw.body_sha256, 'GitHub Issue contract.body_sha256')) {
    throw new FlowError('GitHub Issue visible body digest is stale');
  }
  let authoring: ReturnType<typeof parseBuildPlanAuthoring>;
  try {
    authoring = parseBuildPlanAuthoring(raw.plan);
  } catch (error) {
    throw new FlowError(
      `GitHub Issue Plan is not current; recreate it with the current $issue workflow: ${errorMessage(error)}`,
    );
  }
  const plan = (['english', 'japanese'] as const)
    .map((language) => compileBuildPlan(authoring, language))
    .find((candidate) => sealedVisibleBody.endsWith(candidate.markdown.trimEnd()));
  if (!plan) throw new FlowError('GitHub Issue body does not contain its exact Plan');
  const metadata = publicationMetadata(sealedVisibleBody);
  if (metadata.publicationId === null) {
    throw new FlowError(
      'GitHub Issue uses an incomplete public build contract; recreate it with the current $issue workflow',
    );
  }
  return {
    visibleBody: metadata.visibleBody,
    publication_id: metadata.publicationId,
    plan,
  };
}
