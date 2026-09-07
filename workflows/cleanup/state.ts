/** @file Outcome: Cleanup evidence is immutable, repository-bound and durably published before effects. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Database } from 'bun:sqlite';
import { cleanupArtifactDirectory, cleanupRepository } from '../runtime/storage.ts';
import { FlowError, errorCode } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';

export type ObjectFormat = 'sha1' | 'sha256';
export type RecordKind = 'source' | 'prepared' | 'approval' | 'recovery' | 'journal' | 'report';
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  throw new FlowError('cleanup record contains an unsupported value', 'cleanup_record_invalid');
}
export function digest(domain: string, value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(`codex-cleanup:${domain}\0`)
    .update(canonical(value))
    .digest('hex');
}
export function oid(value: unknown, format: ObjectFormat): string {
  if (
    typeof value !== 'string' ||
    !(format === 'sha1' ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u).test(value)
  )
    throw new FlowError(
      `cleanup requires a full lowercase ${format} OID`,
      'cleanup_record_invalid',
    );
  return value;
}
export function closed(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(value)) throw new FlowError(`${label} must be an object`, 'cleanup_record_invalid');
  rejectUnknownKeys(value, keys, label, 'cleanup_record_invalid');
  for (const key of keys)
    if (!(key in value))
      throw new FlowError(`${label}.${key} is missing`, 'cleanup_record_invalid');
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new FlowError(`${label} must be nonempty text`, 'cleanup_record_invalid');
  return value;
}
export function counter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new FlowError(`${label} must be a nonnegative integer`, 'cleanup_record_invalid');
  return Number(value);
}
export function flush(file: string): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** New directories and their parent entries must also reach stable storage. */
export function durableDirectory(directory: string): void {
  const found = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (found) {
    if (!found.isDirectory() || found.isSymbolicLink())
      throw new FlowError(`unsafe cleanup directory: ${directory}`, 'cleanup_storage_error');
    return;
  }
  const parent = path.dirname(directory);
  durableDirectory(parent);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  flush(directory);
  flush(parent);
}
/** A failed fsync never authorizes a caller to proceed, even if the name is already visible. */
export function publishBytes(file: string, bytes: string): void {
  durableDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.pending-${crypto.randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const found = fs.lstatSync(file);
    if (!found.isFile() || found.isSymbolicLink() || fs.readFileSync(file, 'utf8') !== bytes)
      throw new FlowError(`conflicting cleanup record: ${file}`, 'cleanup_record_conflict');
    flush(file);
    flush(path.dirname(file));
  } finally {
    fs.rmSync(temporary, { force: true });
    flush(path.dirname(file));
  }
}
function recordPath(repo: string, kind: RecordKind, identity: string): string {
  if (!/^[0-9a-f]{64}$/u.test(identity))
    throw new FlowError('invalid cleanup identity', 'cleanup_record_invalid');
  return path.join(cleanupArtifactDirectory(repo), kind, `${identity}.json`);
}
export function publishRecord<T>(repo: string, kind: RecordKind, identity: string, value: T): void {
  const data = {
    protocol: 'codex-cleanup-record',
    kind,
    repository: cleanupRepository(repo),
    identity,
    value,
  };
  publishBytes(
    recordPath(repo, kind, identity),
    canonical({ ...data, digest: digest('record', data) }) + '\n',
  );
}
export function readRecord<T>(
  repo: string,
  kind: RecordKind,
  identity: string,
  parse: (v: unknown) => T,
): T {
  const file = recordPath(repo, kind, identity);
  const bytes = fs.readFileSync(file, 'utf8');
  const r = closed(
    JSON.parse(bytes),
    ['protocol', 'kind', 'repository', 'identity', 'value', 'digest'],
    'cleanup record',
  );
  const { digest: hash, ...data } = r;
  if (
    r.protocol !== 'codex-cleanup-record' ||
    r.kind !== kind ||
    r.repository !== cleanupRepository(repo) ||
    r.identity !== identity ||
    digest('record', data) !== hash ||
    canonical(r) + '\n' !== bytes
  )
    throw new FlowError(`invalid cleanup record: ${file}`, 'cleanup_record_invalid');
  const result = parse(r.value);
  // Reconcile a visible record left by a process that failed before its durability confirmation.
  flush(file);
  flush(path.dirname(file));
  return result;
}
export function recordExists(repo: string, kind: RecordKind, identity: string): boolean {
  return fs.existsSync(recordPath(repo, kind, identity));
}
export function recordIdentities(repo: string, kind: RecordKind): string[] {
  const directory = path.join(cleanupArtifactDirectory(repo), kind);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((f) => /^[0-9a-f]{64}\.json$/u.test(f))
    .map((f) => f.slice(0, -5))
    .sort();
}
/** Unknown contents cannot silently disappear from the protected inventory. */
export function validateCleanupNamespace(repo: string, reapTemporary = false): void {
  const root = cleanupArtifactDirectory(repo);
  if (!fs.existsSync(root)) return;
  const folders = [
    'source',
    'prepared',
    'approval',
    'recovery',
    'journal',
    'report',
    'journal-tip',
    'implementation',
  ];
  const visit = (directory: string, nested: boolean): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (/^\.(?:pending|probe)-[0-9a-f-]{36}$/u.test(entry.name)) {
        if (!entry.isFile())
          throw new FlowError('invalid cleanup temporary file', 'cleanup_storage_error');
        if (reapTemporary) {
          fs.unlinkSync(file);
          flush(directory);
        }
        continue;
      }
      if (!nested && folders.includes(entry.name) && entry.isDirectory()) {
        visit(file, true);
        continue;
      }
      if (
        !nested &&
        reapTemporary &&
        [
          'restore-index',
          'restore-index.lock',
          'restore-file',
          'config-preview',
          'config-preview.lock',
        ].includes(entry.name)
      ) {
        if (!entry.isFile() && !(entry.name === 'restore-file' && entry.isSymbolicLink()))
          throw new FlowError('invalid owned staging entry', 'cleanup_storage_error');
        fs.unlinkSync(file);
        flush(directory);
        continue;
      }
      const known = nested
        ? /^[0-9a-f]{64}\.json$/u.test(entry.name)
        : [
            'ownership.sqlite',
            'ownership.sqlite-journal',
            'restore-index',
            'restore-index.lock',
            'restore-file',
            'config-preview',
            'config-preview.lock',
          ].includes(entry.name);
      if (!known || (!entry.isFile() && !(entry.name === 'restore-file' && entry.isSymbolicLink())))
        throw new FlowError(`unsupported cleanup namespace entry: ${file}`, 'cleanup_unsupported');
    }
  };
  visit(root, false);
}
/** Repository-wide cooperating writer lock; arbitrary external Git writers are detected by inventory. */
export function ownCleanup(repo: string): Disposable {
  const root = cleanupArtifactDirectory(repo);
  durableDirectory(root);
  const file = path.join(root, 'ownership.sqlite');
  const found = fs.lstatSync(file, { throwIfNoEntry: false });
  if (found && (!found.isFile() || found.isSymbolicLink()))
    throw new FlowError('unsafe cleanup ownership file', 'cleanup_storage_error');
  const db = new Database(file, { create: true });
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw new FlowError('repository has an active cleanup owner', 'cleanup_busy');
  }
  try {
    fs.chmodSync(file, 0o600);
    validateCleanupNamespace(repo, true);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    [Symbol.dispose]() {
      db.close();
    },
  };
}
/** Probe before repository effects; no assumption that all filesystems support this protocol. */
export function probeDurability(repo: string): void {
  const root = cleanupArtifactDirectory(repo);
  durableDirectory(root);
  const file = path.join(root, `.probe-${crypto.randomUUID()}`);
  try {
    publishBytes(file, 'cleanup durability probe\n');
  } catch (error) {
    throw new FlowError(
      `cleanup durability unavailable at ${root}: ${String(error)}`,
      'cleanup_durability_unsupported',
    );
  } finally {
    fs.rmSync(file, { force: true });
    flush(root);
  }
}

/** Mutable journal watermark; immutable revisions remain the replay authority. */
export function replaceDurable(file: string, bytes: string): void {
  durableDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.pending-${crypto.randomUUID()}`);
  try {
    const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode ?? 0o600;
    const fd = fs.openSync(temporary, 'wx', mode & 0o777);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    flush(path.dirname(file));
  } finally {
    fs.rmSync(temporary, { force: true });
    flush(path.dirname(file));
  }
}
function assertWorktreeNoCleanup(repo: string): void {
  const ids = new Set(recordIdentities(repo, 'approval'));
  for (const key of recordIdentities(repo, 'journal')) {
    const journal = readRecord(repo, 'journal', key, (v) =>
      closed(v, ['approval', 'sequence', 'previous', 'step', 'phase'], 'journal'),
    );
    ids.add(text(journal.approval, 'approval'));
  }
  for (const id of ids) {
    if (recordExists(repo, 'report', id)) {
      const report = readRecord(repo, 'report', id, parseCleanupResult);
      if (report.status === 'cleaned' && report.prepared_digest === id) continue;
    }
    throw new FlowError(
      `unfinished cleanup ${id}; resume it before starting another workflow`,
      'cleanup_busy',
    );
  }
}
export interface CleanupResult {
  protocol: 'codex-cleanup-result';
  status: 'cleaned' | 'resumable' | 'blocked';
  prepared_digest: string;
  base_ref: string;
  topic_ref: string;
  tracking_ref: string | null;
  endpoint: string;
  base_oid: string;
  completed: string[];
  pending: string | null;
  unattempted: string[];
  recovery_oid: string | null;
  recovery_ref: string | null;
  reason: string | null;
}
export function parseCleanupResult(raw: unknown): CleanupResult {
  const r = closed(
    raw,
    [
      'protocol',
      'status',
      'prepared_digest',
      'base_ref',
      'topic_ref',
      'tracking_ref',
      'endpoint',
      'base_oid',
      'completed',
      'pending',
      'unattempted',
      'recovery_oid',
      'recovery_ref',
      'reason',
    ],
    'cleanup result',
  );
  if (
    r.protocol !== 'codex-cleanup-result' ||
    !['cleaned', 'resumable', 'blocked'].includes(String(r.status)) ||
    !Array.isArray(r.completed) ||
    !r.completed.every((v) => typeof v === 'string') ||
    !Array.isArray(r.unattempted) ||
    !r.unattempted.every((v) => typeof v === 'string') ||
    ['pending', 'recovery_oid', 'recovery_ref', 'tracking_ref', 'reason'].some(
      (k) => r[k] !== null && typeof r[k] !== 'string',
    ) ||
    (r.status === 'cleaned' &&
      (r.pending !== null || r.reason !== null || r.unattempted.length !== 0))
  )
    throw new FlowError('invalid cleanup result', 'cleanup_record_invalid');
  for (const k of ['prepared_digest', 'base_ref', 'topic_ref', 'endpoint', 'base_oid'])
    text(r[k], k);
  return r as unknown as CleanupResult;
}
/** Implementation runs advertise their existing controller state under the repository lock. */
export function registerImplementation(repo: string, runId: string, stateFile: string): void {
  using _owner = ownCleanup(repo);
  assertNoCleanup(repo);
  publishBytes(
    path.join(
      cleanupArtifactDirectory(repo),
      'implementation',
      `${digest('implementation', runId)}.json`,
    ),
    canonical({
      repository: cleanupRepository(repo),
      worktree: fs.realpathSync(repo),
      run_id: runId,
      state_file: stateFile,
    }) + '\n',
  );
}
function assertWorktreeNoImplementation(repo: string): void {
  const directory = path.join(cleanupArtifactDirectory(repo), 'implementation');
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory)) {
    const marker = closed(
      JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')),
      ['repository', 'worktree', 'run_id', 'state_file'],
      'implementation marker',
    );
    let state: unknown;
    try {
      state = JSON.parse(fs.readFileSync(text(marker.state_file, 'state file'), 'utf8'));
    } catch {
      throw new FlowError(
        `implementation ${text(marker.run_id, 'run id')} has unresolved state`,
        'cleanup_busy',
      );
    }
    if (
      !isObject(state) ||
      state.run_id !== marker.run_id ||
      !isObject(state.manifest) ||
      typeof marker.worktree !== 'string' ||
      !path.isAbsolute(marker.worktree) ||
      state.manifest.repo !== marker.worktree ||
      marker.repository !== cleanupRepository(repo) ||
      !['completed', 'cancelled'].includes(String(state.status))
    )
      throw new FlowError(
        `implementation ${text(marker.run_id, 'run id')} must finish or be cancelled before cleanup`,
        'cleanup_busy',
      );
  }
}

export function assertNoCleanup(repo: string): void {
  assertWorktreeNoCleanup(repo);
}
export function assertNoImplementation(repo: string): void {
  assertWorktreeNoImplementation(repo);
}
