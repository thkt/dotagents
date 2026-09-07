/** @file Outcome: Saved dirty state has one immutable recovery commit and is restored before deletion. */
import fs from 'node:fs';
import path from 'node:path';
import { cleanupArtifactDirectory } from '../runtime/storage.ts';
import { FlowError } from '../shared/errors.ts';
import {
  canonical,
  closed,
  digest,
  durableDirectory,
  flush,
  oid,
  publishRecord,
  readRecord,
  recordExists,
  text,
  type ObjectFormat,
} from './state.ts';
import {
  commonDirectory,
  git,
  gitDirectory,
  gitText,
  parseInventory,
  requireSame,
  treeEntries,
  type Entries,
  type Entry,
  type IndexEntry,
  type Inventory,
} from './inventory.ts';

export interface Recovery {
  ownership_id: string;
  source: string;
  creation_base: string;
  preimage: string;
  purpose: 'dirty-state';
  disposition: 'restore-then-delete';
  recovery_oid: string;
}
export function recoveryIdentity(source: string, before: Inventory): string {
  return digest('recovery-owner', {
    source,
    creation_base: before.head,
    preimage: digest('inventory', before),
    purpose: 'dirty-state',
    disposition: 'restore-then-delete',
  });
}
function parseRecovery(raw: unknown, format: ObjectFormat): Recovery {
  const r = closed(
    raw,
    [
      'ownership_id',
      'source',
      'creation_base',
      'preimage',
      'purpose',
      'disposition',
      'recovery_oid',
    ],
    'recovery',
  );
  if (r.purpose !== 'dirty-state' || r.disposition !== 'restore-then-delete')
    throw new FlowError('invalid recovery disposition', 'cleanup_record_invalid');
  const value = {
    ownership_id: text(r.ownership_id, 'ownership'),
    source: text(r.source, 'source'),
    creation_base: oid(r.creation_base, format),
    preimage: text(r.preimage, 'preimage'),
    purpose: 'dirty-state' as const,
    disposition: 'restore-then-delete' as const,
    recovery_oid: oid(r.recovery_oid, format),
  };
  const { ownership_id, recovery_oid, ...identity } = value;
  if (ownership_id !== digest('recovery-owner', identity))
    throw new FlowError('recovery ownership mismatch', 'cleanup_record_invalid');
  return { ...identity, ownership_id, recovery_oid };
}
export function readRecovery(repo: string, id: string, format: ObjectFormat): Recovery {
  const r = readRecord(repo, 'recovery', id, (v) => parseRecovery(v, format));
  if (r.ownership_id !== id || gitText(repo, ['cat-file', '-t', r.recovery_oid]) !== 'commit')
    throw new FlowError('recovery OID is not the owned commit', 'cleanup_record_invalid');
  const bytes = git(repo, ['show', `${r.recovery_oid}:preimage.json`]).toString();
  const before = parseInventory(JSON.parse(bytes));
  if (
    bytes !== canonical(before) ||
    r.preimage !== digest('inventory', before) ||
    r.creation_base !== before.head ||
    recoveryIdentity(r.source, before) !== id ||
    gitText(repo, ['rev-parse', `${r.recovery_oid}^`]) !== r.creation_base
  )
    throw new FlowError(
      'recovery commit does not match its owned preimage',
      'cleanup_record_invalid',
    );
  return r;
}
/** The commit identity is deterministic even if interruption precedes the ownership record. */
export function captureRecovery(repo: string, source: string, before: Inventory): Recovery {
  const id = recoveryIdentity(source, before);
  if (recordExists(repo, 'recovery', id)) return readRecovery(repo, id, before.format);
  const blob = git(
    repo,
    ['-c', 'core.fsync=loose-object', 'hash-object', '-w', '--stdin'],
    canonical(before),
  )
    .toString()
    .trim();
  const tree = git(
    repo,
    ['-c', 'core.fsync=loose-object', 'mktree'],
    `100644 blob ${blob}\tpreimage.json\n`,
  )
    .toString()
    .trim();
  const commit = `tree ${tree}\nparent ${before.head}\nauthor Codex Cleanup <cleanup@localhost> 946684800 +0000\ncommitter Codex Cleanup <cleanup@localhost> 946684800 +0000\n\nRecovery ${id}\n`;
  const recovery_oid = git(
    repo,
    ['-c', 'core.fsync=loose-object', 'hash-object', '-t', 'commit', '-w', '--stdin'],
    commit,
  )
    .toString()
    .trim();
  // Git writes loose objects here; flush both their bytes and directory entries before publishing ownership.
  for (const object of [blob, tree, recovery_oid]) {
    const file = path.join(commonDirectory(repo), 'objects', object.slice(0, 2), object.slice(2));
    flush(file);
    flush(path.dirname(file));
  }
  flush(path.join(commonDirectory(repo), 'objects'));
  const record: Recovery = {
    ownership_id: id,
    source,
    creation_base: before.head,
    preimage: digest('inventory', before),
    purpose: 'dirty-state',
    disposition: 'restore-then-delete',
    recovery_oid,
  };
  publishRecord(repo, 'recovery', id, record);
  return readRecovery(repo, id, before.format);
}
function treeFiles(repo: string, entries: Record<string, IndexEntry>): Entries {
  return Object.fromEntries(
    Object.entries(entries).map(([p, e]) => [
      p,
      {
        kind: e.mode === '120000' ? 'symlink' : 'file',
        mode: e.mode === '120000' ? 0o777 : e.mode === '100755' ? 0o755 : 0o644,
        bytes: git(repo, ['cat-file', 'blob', e.oid]).toString('base64'),
      } satisfies Entry,
    ]),
  );
}
function parents(files: Entries): Entries {
  for (const name of Object.keys(files)) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (files[parent] && files[parent]!.kind !== 'directory')
        throw new FlowError(
          `restore has a path/type conflict: ${parent}`,
          'cleanup_restore_conflict',
        );
      files[parent] ??= { kind: 'directory', mode: 0o755, bytes: '' };
      parent = path.posix.dirname(parent);
    }
  }
  return files;
}
export interface RestorePlan {
  materialized: Entries;
  restored: Entries;
  base_index: Record<string, IndexEntry>;
  restored_index: Record<string, IndexEntry>;
}
export function restoration(repo: string, before: Inventory, base: string): RestorePlan {
  const oldIndex = treeEntries(repo, before.head),
    baseIndex = treeEntries(repo, base);
  const oldFiles = treeFiles(repo, oldIndex),
    baseFiles = treeFiles(repo, baseIndex);
  const materialized: Entries = structuredClone(before.files),
    restoredIndex = { ...baseIndex };
  for (const p of Object.keys(oldFiles)) delete materialized[p];
  for (const [p, e] of Object.entries(baseFiles)) {
    if (!(p in oldFiles) && before.files[p])
      throw new FlowError(`new base conflicts with saved path: ${p}`, 'cleanup_restore_conflict');
    materialized[p] = e;
  }
  const restored: Entries = structuredClone(materialized);
  for (const p of new Set([...Object.keys(oldFiles), ...Object.keys(before.index)])) {
    const staged = canonical(before.index[p] ?? null) !== canonical(oldIndex[p] ?? null);
    const dirty = staged || canonical(before.files[p] ?? null) !== canonical(oldFiles[p] ?? null);
    if (!dirty) continue;
    if (canonical(baseIndex[p] ?? null) !== canonical(oldIndex[p] ?? null))
      throw new FlowError(
        `saved dirty path conflicts with verified base: ${p}`,
        'cleanup_restore_conflict',
      );
    if (before.files[p]) restored[p] = before.files[p]!;
    else delete restored[p];
    if (staged) {
      if (before.index[p]) restoredIndex[p] = before.index[p]!;
      else delete restoredIndex[p];
    }
  }
  // Every originally untracked/ignored entry, including empty directories, survives unchanged.
  return {
    materialized: parents(materialized),
    restored: parents(restored),
    base_index: baseIndex,
    restored_index: restoredIndex,
  };
}
export function requireFileTransition(actual: Entries, before: Entries, after: Entries): void {
  for (const key of new Set([
    ...Object.keys(actual),
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    const v = canonical(actual[key] ?? null);
    if (v !== canonical(before[key] ?? null) && v !== canonical(after[key] ?? null))
      throw new FlowError(`unexpected working file during cleanup: ${key}`, 'cleanup_drift');
  }
}
/** Writes only an approved before/after transition; no Git reset or stash mutation is used. */
export function writeFiles(repo: string, before: Entries, after: Entries): void {
  for (const key of Object.keys(before).sort((a, b) => b.length - a.length)) {
    if (after[key] || before[key]!.kind === 'directory') continue;
    fs.rmSync(path.join(repo, key), { force: true });
    flush(path.dirname(path.join(repo, key)));
  }
  for (const [key, e] of Object.entries(after).sort(([a], [b]) => a.length - b.length)) {
    const file = path.join(repo, key);
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (e.kind === 'directory') {
      if (current && !current.isDirectory())
        throw new FlowError(`directory conflict: ${key}`, 'cleanup_restore_conflict');
      if (!current) fs.mkdirSync(file, { mode: e.mode });
      fs.chmodSync(file, e.mode);
      flush(path.dirname(file));
      continue;
    }
    if (current?.isDirectory())
      throw new FlowError(`file conflict: ${key}`, 'cleanup_restore_conflict');
    // Stage inside the excluded owned namespace, then atomically replace the destination.
    const temporary = path.join(cleanupArtifactDirectory(repo), 'restore-file');
    fs.rmSync(temporary, { force: true });
    if (e.kind === 'symlink') {
      fs.symlinkSync(Buffer.from(e.bytes, 'base64').toString(), temporary);
    } else {
      fs.writeFileSync(temporary, Buffer.from(e.bytes, 'base64'), { mode: e.mode });
      fs.chmodSync(temporary, e.mode);
      flush(temporary);
    }
    fs.renameSync(temporary, file);
    flush(cleanupArtifactDirectory(repo));
    flush(path.dirname(file));
  }
}
export function writeIndex(repo: string, entries: Record<string, IndexEntry>): void {
  const root = cleanupArtifactDirectory(repo);
  durableDirectory(root);
  const temporary = path.join(root, 'restore-index');
  fs.rmSync(temporary, { force: true });
  const env = { GIT_INDEX_FILE: temporary };
  git(repo, ['read-tree', '--empty'], undefined, env);
  const input = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, e]) => `${e.mode} ${e.oid}\t${p}\0`)
    .join('');
  git(repo, ['update-index', '-z', '--index-info'], input, env);
  flush(temporary);
  fs.renameSync(temporary, path.join(gitDirectory(repo), 'index'));
  flush(gitDirectory(repo));
}
export function verifyRecoveryPreimage(repo: string, recovery: Recovery, before: Inventory): void {
  requireSame(
    git(repo, ['show', `${recovery.recovery_oid}:preimage.json`]).toString(),
    canonical(before),
    'recovery preimage',
  );
}
