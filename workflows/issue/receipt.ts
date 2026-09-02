/** @file Outcome: Local Issue publication receipts remain verifiable audit and cache records. */

import * as fs from 'node:fs';

import { digest, positiveIssue, repositoryName } from './public-contract.ts';
import { FlowError } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';

export const PUBLISHED_ISSUE_PROTOCOL = 'codex-build-issue' as const;

export interface PublishedIssueReceipt {
  protocol: typeof PUBLISHED_ISSUE_PROTOCOL;
  published_at: string;
  repo: string;
  repository: string;
  publication_id: string;
  draft_sha256: string;
  issue_number: number;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FlowError(`${label} is required`);
  return value;
}

/** Parses a local publication receipt retained only as cache and audit evidence. */
export function parsePublishedIssueReceipt(raw: unknown, repo: string): PublishedIssueReceipt {
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
      'publication_id',
      'draft_sha256',
      'issue_number',
    ],
    'build receipt',
  );
  const publishedAt = requiredString(raw.published_at, 'build receipt.published_at');
  const publishedTime = Date.parse(publishedAt);
  if (!Number.isFinite(publishedTime) || new Date(publishedTime).toISOString() !== publishedAt) {
    throw new FlowError('build receipt.published_at must be an ISO timestamp');
  }
  let receiptRepo = '';
  try {
    receiptRepo = fs.realpathSync(requiredString(raw.repo, 'build receipt.repo'));
  } catch {
    // Invalid audit receipts are ignored by their consumers.
  }
  if (receiptRepo !== fs.realpathSync(repo)) {
    throw new FlowError('build receipt belongs to a different repository');
  }
  const repository = repositoryName(raw.repository, 'build receipt.repository');
  const issueNumber = positiveIssue(raw.issue_number, 'build receipt.issue_number');
  const publicationId = requiredString(raw.publication_id, 'build receipt.publication_id');
  return {
    protocol: raw.protocol,
    published_at: publishedAt,
    repo: receiptRepo,
    repository,
    publication_id: publicationId,
    draft_sha256: digest(raw.draft_sha256, 'build receipt.draft_sha256'),
    issue_number: issueNumber,
  };
}
