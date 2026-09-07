/** @file Outcome: Cleanup detects drift across working files, Git metadata and every linked worktree. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupArtifactDirectory } from '../runtime/storage.ts';
import { FlowError } from '../shared/errors.ts';
import {
  canonical,
  closed,
  counter,
  digest,
  oid,
  text,
  validateCleanupNamespace,
  type ObjectFormat,
} from './state.ts';
import { isObject } from '../shared/schema.ts';

export interface Entry {
  kind: 'file' | 'symlink' | 'directory';
  mode: number;
  bytes: string;
}
export type Entries = Record<string, Entry>;
export interface IndexEntry {
  mode: string;
  oid: string;
}
export interface Inventory {
  repository: string;
  format: ObjectFormat;
  head: string;
  branch: string;
  files: Entries;
  index: Record<string, IndexEntry>;
  refs: Record<string, string>;
  symrefs: Record<string, string>;
  metadata: Entries;
  worktrees: Record<string, { branch: string; files: Entries }>;
}
export function git(
  repo: string,
  args: string[],
  input?: string | Buffer,
  environment?: NodeJS.ProcessEnv,
): Buffer {
  const r = spawnSync(
    'git',
    ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
    {
      input,
      env: { ...process.env, ...environment },
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (r.status !== 0)
    throw new FlowError(
      `cleanup git ${args[0]} failed: ${(r.stderr ?? Buffer.alloc(0)).toString().trim() || r.error?.message || r.status}`,
      'cleanup_git_error',
    );
  return r.stdout;
}
export const gitText = (repo: string, args: string[]) => git(repo, args).toString('utf8').trim();
export function objectFormat(repo: string): ObjectFormat {
  const f = gitText(repo, ['rev-parse', '--show-object-format']);
  if (f !== 'sha1' && f !== 'sha256')
    throw new FlowError(`unsupported Git object format: ${f}`, 'cleanup_unsupported');
  return f;
}
export function gitDirectory(repo: string): string {
  return fs.realpathSync(gitText(repo, ['rev-parse', '--absolute-git-dir']));
}
export function commonDirectory(repo: string): string {
  return fs.realpathSync(path.resolve(repo, gitText(repo, ['rev-parse', '--git-common-dir'])));
}
function pathKey(value: unknown): string {
  const s = text(value, 'inventory path');
  if (path.isAbsolute(s) || s.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new FlowError(`unsafe inventory path: ${s}`, 'cleanup_record_invalid');
  return s;
}
function strings(raw: unknown): Record<string, string> {
  if (!isObject(raw)) throw new FlowError('expected string map', 'cleanup_record_invalid');
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [text(k, 'map key'), text(v, 'map value')]),
  );
}
function parseEntries(raw: unknown): Entries {
  if (!isObject(raw)) throw new FlowError('invalid inventory entries', 'cleanup_record_invalid');
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => {
      pathKey(k);
      const r = closed(v, ['kind', 'mode', 'bytes'], 'entry');
      if (
        !['file', 'symlink', 'directory'].includes(String(r.kind)) ||
        typeof r.bytes !== 'string' ||
        Buffer.from(r.bytes, 'base64').toString('base64') !== r.bytes
      )
        throw new FlowError(`invalid inventory entry: ${k}`, 'cleanup_record_invalid');
      const mode = counter(r.mode, 'entry mode');
      if (mode > 0o7777) throw new FlowError('invalid mode', 'cleanup_record_invalid');
      return [k, { kind: r.kind as Entry['kind'], mode, bytes: r.bytes }];
    }),
  );
}
export function parseInventory(raw: unknown): Inventory {
  const r = closed(
    raw,
    [
      'repository',
      'format',
      'head',
      'branch',
      'files',
      'index',
      'refs',
      'symrefs',
      'metadata',
      'worktrees',
    ],
    'inventory',
  );
  const format = r.format;
  if (format !== 'sha1' && format !== 'sha256')
    throw new FlowError('invalid inventory format', 'cleanup_record_invalid');
  if (!isObject(r.index) || !isObject(r.worktrees))
    throw new FlowError('invalid inventory index/worktrees', 'cleanup_record_invalid');
  const index = Object.fromEntries(
    Object.entries(r.index).map(([k, v]) => {
      pathKey(k);
      const e = closed(v, ['mode', 'oid'], 'index entry');
      if (!['100644', '100755', '120000'].includes(String(e.mode)))
        throw new FlowError(`unsupported index mode: ${String(e.mode)}`, 'cleanup_unsupported');
      return [k, { mode: String(e.mode), oid: oid(e.oid, format) }];
    }),
  );
  const worktrees = Object.fromEntries(
    Object.entries(r.worktrees).map(([k, v]) => {
      const w = closed(v, ['branch', 'files'], 'worktree');
      if (!path.isAbsolute(k))
        throw new FlowError('worktree must be absolute', 'cleanup_record_invalid');
      return [
        k,
        {
          branch: typeof w.branch === 'string' ? w.branch : text(w.branch, 'branch'),
          files: parseEntries(w.files),
        },
      ];
    }),
  );
  const refs = strings(r.refs);
  for (const v of Object.values(refs)) oid(v, format);
  return {
    repository: text(r.repository, 'repository'),
    format,
    head: oid(r.head, format),
    branch: text(r.branch, 'branch'),
    files: parseEntries(r.files),
    index,
    refs,
    symrefs: strings(r.symrefs),
    metadata: parseEntries(r.metadata),
    worktrees,
  };
}
function scan(root: string, excluded: (relative: string) => boolean): Entries {
  const entries: Entries = {};
  const walk = (relative: string) => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      if (relative) entries[relative] = { kind: 'directory', mode: stat.mode & 0o7777, bytes: '' };
      for (const name of fs.readdirSync(file).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        if (!excluded(child)) walk(child);
      }
    } else if (stat.isSymbolicLink())
      entries[relative] = {
        kind: 'symlink',
        mode: stat.mode & 0o7777,
        bytes: Buffer.from(fs.readlinkSync(file)).toString('base64'),
      };
    else if (stat.isFile() && stat.nlink === 1)
      entries[relative] = {
        kind: 'file',
        mode: stat.mode & 0o7777,
        bytes: fs.readFileSync(file).toString('base64'),
      };
    else throw new FlowError(`unsupported inventory entry: ${file}`, 'cleanup_unsupported');
  };
  walk('');
  return entries;
}
function workingFiles(repo: string): Entries {
  validateCleanupNamespace(repo);
  const own = path.relative(repo, cleanupArtifactDirectory(repo));
  return scan(repo, (p) => p === '.git' || p === own || p.startsWith(`${own}/`));
}
function readIndex(repo: string): Record<string, IndexEntry> {
  const stagedNames = (visibility: string) =>
    git(repo, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      visibility,
    ]).toString();
  if (stagedNames('--ita-visible-in-index') !== stagedNames('--ita-invisible-in-index'))
    throw new FlowError(
      'intent-to-add index entries are not supported; preserve or stage them before preparation',
      'cleanup_unsupported',
    );
  for (const row of git(repo, ['ls-files', '-v', '-z']).toString().split('\0').filter(Boolean))
    if (!row.startsWith('H '))
      throw new FlowError(
        `unsupported index flags or unmerged entry: ${row}`,
        'cleanup_unsupported',
      );
  return Object.fromEntries(
    git(repo, ['ls-files', '--stage', '-z'])
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((row) => {
        const m = /^(100644|100755|120000) ([0-9a-f]+) 0\t([\s\S]+)$/u.exec(row);
        if (!m) throw new FlowError(`unsupported index entry: ${row}`, 'cleanup_unsupported');
        return [pathKey(m[3]), { mode: m[1]!, oid: m[2]! }];
      }),
  );
}
export function treeEntries(repo: string, commit: string): Record<string, IndexEntry> {
  return Object.fromEntries(
    git(repo, ['ls-tree', '-r', '-z', commit])
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((row) => {
        const m = /^(100644|100755|120000) blob ([0-9a-f]+)\t([\s\S]+)$/u.exec(row);
        if (!m) throw new FlowError(`unsupported base tree entry: ${row}`, 'cleanup_unsupported');
        return [pathKey(m[3]), { mode: m[1]!, oid: m[2]! }];
      }),
  );
}
export function inventoryRepository(repo: string): Inventory {
  repo = fs.realpathSync(repo);
  const format = objectFormat(repo);
  const gd = gitDirectory(repo),
    common = commonDirectory(repo);
  const branch = gitText(repo, ['symbolic-ref', 'HEAD']);
  const refs: Record<string, string> = {},
    symrefs: Record<string, string> = {};
  for (const line of gitText(repo, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)'])
    .split('\n')
    .filter(Boolean)) {
    const [ref, object, ...symbolic] = line.split(' ');
    refs[ref!] = oid(object, format);
    if (symbolic.join(' ')) symrefs[ref!] = symbolic.join(' ');
  }
  const worktrees: Inventory['worktrees'] = {};
  for (const block of gitText(repo, ['worktree', 'list', '--porcelain']).split('\n\n')) {
    const lines = block.split('\n');
    const where = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!where || lines.includes('bare'))
      throw new FlowError('unsupported worktree inventory', 'cleanup_unsupported');
    const real = fs.realpathSync(where);
    if (real !== repo)
      worktrees[real] = {
        branch: lines.find((l) => l.startsWith('branch '))?.slice(7) ?? '',
        files: workingFiles(real),
      };
  }
  const metadata: Entries = {};
  // Logical refs are recorded above; their storage may be loose or packed. Reflogs remain byte-exact.
  const omit = (p: string) => p === 'objects' || p === 'refs' || p === 'packed-refs';
  for (const [prefix, dir] of [
    ['common', common],
    ...(gd === common ? [] : [['worktree', gd]]),
  ] as [string, string][]) {
    const currentAlias = prefix === 'common' && gd !== common ? path.relative(common, gd) : null;
    for (const [key, value] of Object.entries(scan(dir, (p) => omit(p) || p === currentAlias))) {
      if (key.endsWith('.lock'))
        throw new FlowError(`Git writer or stale lock present: ${dir}/${key}`, 'cleanup_busy');
      metadata[`${prefix}/${key}`] = value;
    }
  }
  return {
    repository: repo,
    format,
    head: oid(gitText(repo, ['rev-parse', 'HEAD']), format),
    branch,
    files: workingFiles(repo),
    index: readIndex(repo),
    refs,
    symrefs,
    metadata,
    worktrees,
  };
}
export function requireSame(expected: unknown, actual: unknown, label: string): void {
  if (canonical(expected) !== canonical(actual))
    throw new FlowError(`cleanup inventory drift: ${label}`, 'cleanup_drift');
}
export function inventoryDigest(inventory: Inventory): string {
  return digest('inventory', inventory);
}
