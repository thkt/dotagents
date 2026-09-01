/** @file Outcome: One public GitHub Issue carries an exact human and machine Build contract. */

import { parseBuildPlanAuthoring, renderPlanMarkdown } from '../flow/build/authoring.ts';
import { sha256 } from '../shared/evidence.ts';
import { FlowError } from '../shared/errors.ts';
import type { ConfiguredLanguage } from '../shared/language.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';

const PUBLIC_ISSUE_CONTRACT_PROTOCOL = 'codex-public-build-contract/v1' as const;

const CONTRACT_OPEN = `<!-- ${PUBLIC_ISSUE_CONTRACT_PROTOCOL}\n`;
const CONTRACT_CLOSE = '\n-->';

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
  rawPlan: unknown,
  language: ConfiguredLanguage,
): string {
  if (body.includes(CONTRACT_OPEN)) {
    throw new FlowError('issue body already contains a public build contract', 'decision_error');
  }
  const plan = parseBuildPlanAuthoring(rawPlan);
  const visibleBody = body.trimEnd();
  if (!visibleBody.endsWith(renderPlanMarkdown(plan, language).trimEnd())) {
    throw new FlowError('issue body does not contain its exact canonical Plan', 'decision_error');
  }
  const contract = {
    protocol: PUBLIC_ISSUE_CONTRACT_PROTOCOL,
    body_sha256: sha256(visibleBody),
    plan,
  };
  const encoded = Buffer.from(JSON.stringify(contract)).toString('base64url');
  return `${visibleBody}\n\n${CONTRACT_OPEN}${encoded}${CONTRACT_CLOSE}\n`;
}

/** Validates that the visible Issue body, body digest, and machine Plan are one exact contract. */
export function parsePublicIssueBody(body: string): {
  visibleBody: string;
  plan: ReturnType<typeof parseBuildPlanAuthoring>;
} {
  const start = body.lastIndexOf(CONTRACT_OPEN);
  if (start < 0 || body.indexOf(CONTRACT_OPEN) !== start) {
    throw new FlowError('GitHub Issue has no unique public build contract');
  }
  const suffix = body.slice(start + CONTRACT_OPEN.length).trimEnd();
  if (!suffix.endsWith(CONTRACT_CLOSE)) {
    throw new FlowError('GitHub Issue public build contract is not terminal');
  }
  const visibleBody = body.slice(0, start).trimEnd();
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
  if (sha256(visibleBody) !== digest(raw.body_sha256, 'GitHub Issue contract.body_sha256')) {
    throw new FlowError('GitHub Issue visible body digest is stale');
  }
  const plan = parseBuildPlanAuthoring(raw.plan);
  const exactPlan = (['english', 'japanese'] as const).some((language) =>
    visibleBody.endsWith(renderPlanMarkdown(plan, language).trimEnd()),
  );
  if (!exactPlan) throw new FlowError('GitHub Issue body does not contain its exact Plan');
  return { visibleBody, plan };
}
