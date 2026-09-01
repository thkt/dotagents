/** @file Outcome: Every workflow validates and seals repository citations with one implementation. */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError } from './errors.ts';
import { normalizeRepoPath, realpathInside } from './repository.ts';

const LINE_LOCATOR = /^L(\d+)(?:-L?(\d+))?$/u;

export interface RepositoryEvidenceSnapshot {
  source: string;
  source_sha256: string;
}

/** Reads only a regular repository file whose declared line range currently exists. */
export function readRepositoryEvidence(
  repo: string,
  source: unknown,
  locator: unknown,
  label: string,
): RepositoryEvidenceSnapshot {
  const relative = normalizeRepoPath(source);
  if (!relative)
    throw new FlowError(`${label}.source must be a repo-relative path`, 'evidence_error');
  const absolute = path.resolve(repo, relative);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !realpathInside(repo, absolute)) {
    throw new FlowError(`${label}.source must name a regular repository file`, 'evidence_error');
  }
  const match = typeof locator === 'string' ? LINE_LOCATOR.exec(locator) : null;
  const start = Number(match?.[1]);
  const end = Number(match?.[2] ?? match?.[1]);
  const content = fs.readFileSync(absolute);
  const text = content.toString('utf8');
  const lineCount =
    text.length === 0 ? 0 : text.split(/\r\n?|\n/u).length - (/(?:\r\n?|\n)$/u.test(text) ? 1 : 0);
  if (!match || start < 1 || end < start || end > lineCount) {
    throw new FlowError(
      `${label}.locator must name existing lines as Lx or Lx-Ly`,
      'evidence_error',
    );
  }
  return {
    source: relative,
    source_sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

/** Hashes the exact bytes carried across an artifact boundary. */
export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
