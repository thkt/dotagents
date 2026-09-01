/** @file Outcome: Build consumes only the exact Plan published by the issue workflow. */

import * as fs from 'node:fs';
import path from 'node:path';

import { buildPlanValue, parseBuildPlanAuthoring, renderPlanMarkdown } from './authoring.ts';
import { sha256 } from '../../shared/evidence.ts';
import { FlowError } from '../../shared/errors.ts';
import { realpathInside } from '../../shared/repository.ts';
import { isObject, rejectUnknownKeys } from '../../shared/schema.ts';
import { issueArtifactDirectory } from '../../shared/storage.ts';

export const PUBLISHED_ISSUE_PROTOCOL = 'codex-build-issue/v1' as const;
export const BUILD_SOURCE_PROTOCOL = 'codex-build-source/v1' as const;

export interface PublishedBuildIssue {
  protocol: typeof PUBLISHED_ISSUE_PROTOCOL;
  published_at: string;
  repo: string;
  repository: string;
  remote: string;
  draft_sha256: string;
  issue_number: number;
  url: string;
  title: string;
  body: string;
  body_sha256: string;
  plan: ReturnType<typeof parseBuildPlanAuthoring>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FlowError(`${label} is required`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new FlowError(`${label} must be a SHA-256 digest`);
  return result;
}

export function parsePublishedIssueReceipt(raw: unknown, repo: string): PublishedBuildIssue {
  if (!isObject(raw) || raw.protocol !== PUBLISHED_ISSUE_PROTOCOL) {
    throw new FlowError(`build receipt.protocol must be ${PUBLISHED_ISSUE_PROTOCOL}`);
  }
  rejectUnknownKeys(
    raw,
    [
      'protocol',
      'published_at',
      'repo',
      'repository',
      'remote',
      'draft_sha256',
      'issue_number',
      'url',
      'title',
      'body',
      'body_sha256',
      'plan',
    ],
    'build receipt',
  );
  const publishedAt = requiredString(raw.published_at, 'build receipt.published_at');
  const publishedTime = Date.parse(publishedAt);
  if (!Number.isFinite(publishedTime) || new Date(publishedTime).toISOString() !== publishedAt) {
    throw new FlowError('build receipt.published_at must be an ISO timestamp');
  }
  let receiptRepo: string;
  try {
    receiptRepo = typeof raw.repo === 'string' ? fs.realpathSync(raw.repo) : '';
  } catch {
    receiptRepo = '';
  }
  if (receiptRepo !== fs.realpathSync(repo)) {
    throw new FlowError('build receipt belongs to a different repository');
  }
  const repository = requiredString(raw.repository, 'build receipt.repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new FlowError('build receipt.repository must be owner/name');
  }
  if (!Number.isInteger(raw.issue_number) || Number(raw.issue_number) < 1) {
    throw new FlowError('build receipt.issue_number must be a positive integer');
  }
  const issueNumber = Number(raw.issue_number);
  const url = requiredString(raw.url, 'build receipt.url');
  if (url !== `https://github.com/${repository}/issues/${issueNumber}`) {
    throw new FlowError('build receipt.url does not identify its issue');
  }
  const title = requiredString(raw.title, 'build receipt.title');
  const body = requiredString(raw.body, 'build receipt.body');
  const bodySha256 = digest(raw.body_sha256, 'build receipt.body_sha256');
  if (sha256(body) !== bodySha256) {
    throw new FlowError('build receipt body digest is invalid');
  }
  const plan = parseBuildPlanAuthoring(raw.plan);
  if (!body.trimEnd().endsWith(renderPlanMarkdown(plan).trimEnd())) {
    throw new FlowError('build receipt body does not contain its exact Plan');
  }
  const remote = requiredString(raw.remote, 'build receipt.remote');
  if (!/^[A-Za-z0-9._-]+$/u.test(remote)) {
    throw new FlowError('build receipt.remote has invalid characters');
  }
  return {
    protocol: PUBLISHED_ISSUE_PROTOCOL,
    published_at: publishedAt,
    repo: receiptRepo,
    repository,
    remote,
    draft_sha256: digest(raw.draft_sha256, 'build receipt.draft_sha256'),
    issue_number: issueNumber,
    url,
    title,
    body,
    body_sha256: bodySha256,
    plan,
  };
}

/** Resolves a private published-issue receipt into the untrusted value validated by build gates. */
export function resolveBuildSource(
  raw: unknown,
  repo: string,
): {
  issue: number;
  title: string;
  body: string;
  plan: ReturnType<typeof buildPlanValue>;
} {
  if (!isObject(raw) || raw.protocol !== BUILD_SOURCE_PROTOCOL) {
    throw new FlowError(`build source.protocol must be ${BUILD_SOURCE_PROTOCOL}`);
  }
  rejectUnknownKeys(raw, ['protocol', 'receipt'], 'build source');
  if (typeof raw.receipt !== 'string' || !path.isAbsolute(raw.receipt)) {
    throw new FlowError('build source.receipt must be absolute');
  }
  const file = path.resolve(raw.receipt);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    !file.endsWith('.published.json') ||
    !realpathInside(issueArtifactDirectory(repo), file)
  ) {
    throw new FlowError(
      'build source.receipt must be a published issue artifact for this repository',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new FlowError('build source.receipt must contain valid JSON');
  }
  const receipt = parsePublishedIssueReceipt(value, repo);
  return {
    issue: receipt.issue_number,
    title: receipt.title,
    body: receipt.body,
    plan: buildPlanValue(receipt.plan),
  };
}

export function describeBuildSource() {
  return {
    protocol: BUILD_SOURCE_PROTOCOL,
    receipt: '/absolute/private-issue-draft.json.published.json',
  };
}
