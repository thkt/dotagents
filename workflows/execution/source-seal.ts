/** @file Outcome: Workflow consumers bind to one canonical visible repository source. */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError } from '../shared/errors.ts';
import { gitOptionalText, gitOutput, normalizeRepoPath, nulPaths } from '../shared/repository.ts';

const SOURCE_SEAL_PROTOCOL = 'codex-flow-source-seal' as const;

interface SourceRecord {
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'missing';
  executable?: boolean;
  content?: string;
}

interface ScopeSeal {
  scope: string;
  digest: string;
}

export interface SourceSeal {
  protocol: typeof SOURCE_SEAL_PROTOCOL;
  content_digest: string;
  source_digest: string;
  head: string | null;
  branch: string | null;
  index: string[];
  base_commit: string | null;
  scopes: ScopeSeal[];
}

export interface SourceSealOptions {
  scopes?: readonly string[];
  baseRef?: string | null;
  logical?: {
    head: string | null;
    branch: string | null;
    base_commit: string | null;
  };
}

const text = new TextEncoder();

function framed(domain: string, fields: readonly Uint8Array[]): string {
  const hash = crypto.createHash('sha256');
  hash.update(text.encode(`${domain}\0`));
  for (const field of fields) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.byteLength));
    hash.update(length);
    hash.update(field);
  }
  return hash.digest('hex');
}

function encodedRecord(record: SourceRecord): Uint8Array {
  return text.encode(
    JSON.stringify([record.path, record.kind, record.executable ?? null, record.content ?? null]),
  );
}

function ignoredRoots(repo: string): Set<string> {
  return new Set(
    nulPaths(
      gitOutput(
        repo,
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        'ignored source scan',
      ),
    ).map((entry) => entry.replace(/\/$/u, '')),
  );
}

function visibleRecords(repo: string): SourceRecord[] {
  const ignored = ignoredRoots(repo);
  const records: SourceRecord[] = [];
  const walk = (absolute: string, relative: string): void => {
    const entries = fs
      .readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === '.git' || ignored.has(child)) continue;
      const target = path.join(absolute, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        records.push({ path: child, kind: 'directory' });
        walk(target, child);
      } else if (stat.isFile()) {
        records.push({
          path: child,
          kind: 'file',
          executable: Boolean(stat.mode & 0o111),
          content: fs.readFileSync(target).toString('base64'),
        });
      } else if (stat.isSymbolicLink()) {
        records.push({ path: child, kind: 'symlink', content: fs.readlinkSync(target) });
      } else {
        throw new FlowError(`${child} has an unsupported filesystem type`, 'state_error');
      }
    }
  };
  walk(repo, '');
  return records.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
}

function canonicalIndex(repo: string): string[] {
  return nulPaths(gitOutput(repo, ['ls-files', '--stage', '-z'], 'index source scan')).map(
    (entry) => {
      const tab = entry.indexOf('\t');
      const prefix = tab >= 0 ? entry.slice(0, tab) : '';
      const rawPath = tab >= 0 ? entry.slice(tab + 1) : '';
      const relative = normalizeRepoPath(rawPath);
      if (!relative || !/^\d{6} [0-9a-f]{40,64} [0-3]$/u.test(prefix)) {
        throw new FlowError('Git index contains an invalid entry', 'state_error');
      }
      return `${prefix}\t${relative}`;
    },
  );
}

function selectedRecords(records: readonly SourceRecord[], scope: string): SourceRecord[] {
  const selected = records.filter(
    (record) => scope === '.' || record.path === scope || record.path.startsWith(`${scope}/`),
  );
  return selected.length ? selected : [{ path: scope, kind: 'missing' }];
}

/** Seals visible content, logical Git identity, and every declared component scope. */
export function sealRepository(repo: string, options: SourceSealOptions = {}): SourceSeal {
  const records = visibleRecords(repo);
  const contentDigest = framed('codex-flow-source-content', records.map(encodedRecord));
  const head = options.logical?.head ?? gitOptionalText(repo, ['rev-parse', 'HEAD']);
  const branch = options.logical?.branch ?? gitOptionalText(repo, ['branch', '--show-current']);
  const baseCommit =
    options.logical?.base_commit ??
    (options.baseRef ? gitOptionalText(repo, ['rev-parse', '--verify', options.baseRef]) : null);
  const index = canonicalIndex(repo);
  const sourceDigest = framed('codex-flow-source', [
    text.encode(contentDigest),
    text.encode(head ?? ''),
    text.encode(branch ?? ''),
    text.encode(JSON.stringify(index)),
    text.encode(baseCommit ?? ''),
  ]);
  const scopes = [...new Set(options.scopes ?? [])]
    .map((value) => (value === '.' ? value : normalizeRepoPath(value)))
    .map((value) => {
      if (!value) throw new FlowError('source seal contains an unsafe scope', 'scope_error');
      return value;
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((scope) => ({
      scope,
      digest: framed('codex-flow-source-scope', [
        text.encode(scope),
        ...selectedRecords(records, scope).map(encodedRecord),
      ]),
    }));
  return {
    protocol: SOURCE_SEAL_PROTOCOL,
    content_digest: contentDigest,
    source_digest: sourceDigest,
    head,
    branch,
    index,
    base_commit: baseCommit,
    scopes,
  };
}
