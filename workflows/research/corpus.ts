/** @file Outcome: Shared Research has immutable content identities and deterministic generated views. */
import crypto from 'node:crypto';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { FlowError } from '../shared/errors.ts';
import { parseResearchReport, type ResearchReport } from './contracts.ts';
import { protectPrivateStorage } from '../runtime/storage.ts';

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, sort(value)]),
      );
    return item;
  };
  return `${JSON.stringify(sort(value))}\n`;
}
export function sha256(bytes: string): string {
  return crypto.createHash('sha256').update(bytes, 'utf8').digest('hex');
}
export function canonicalReport(value: ResearchReport): ResearchReport & { research_id: string } {
  const { research_id: _id, ...report } = parseResearchReport(value);
  return { ...report, research_id: sha256(canonicalJson(report)) };
}
export function corpusDirectory(repo: string): string {
  return path.join(fs.realpathSync(repo), 'research', 'records');
}
export function corpusPaths(repo: string, id: string): { json: string; markdown: string } {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new FlowError('Invalid corpus identity', 'state_error');
  return {
    json: path.join(corpusDirectory(repo), `${id}.json`),
    markdown: path.join(fs.realpathSync(repo), 'research', 'reports', `${id}.md`),
  };
}
/** Every string has one stable RFC 6901 JSON Pointer, including metadata. */
export function reportStrings(value: unknown, pointer = ''): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path: pointer, value }];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([key, item]) =>
      reportStrings(item, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`),
    );
}
function escapeMarkdown(value: string): string {
  return value.replace(/[^\p{L}\p{N} ]/gu, (char) => `&#${char.codePointAt(0)};`);
}
/** Field paths preserve structure; entity encoding prevents values becoming active presentation. */
export function renderCorpusMarkdown(report: ResearchReport): string {
  const parsed = parseResearchReport(report);
  const rows: string[] = [];
  const visit = (value: unknown, pointer: string): void => {
    if (value !== null && typeof value === 'object' && Object.keys(value).length) {
      for (const [key, item] of Object.entries(value).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ))
        visit(item, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    } else
      rows.push(
        `| ${escapeMarkdown(pointer)} | ${escapeMarkdown(typeof value === 'string' ? value : JSON.stringify(value))} |`,
      );
  };
  visit(parsed, '');
  return [
    '# Research',
    '',
    'Generated from canonical JSON. Do not edit this view directly.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
function fail(): never {
  throw new FlowError('Research corpus integrity check failed', 'state_error');
}
/** Reject symlinks at every existing component; missing final entries are allowed for publication. */
function safeCorpusPath(repo: string, file: string): void {
  const root = fs.realpathSync(repo);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail();
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      stat &&
      (stat.isSymbolicLink() || (current === file ? !stat.isFile() : !stat.isDirectory()))
    )
      fail();
  }
}
export function readCorpusReport(
  repo: string,
  file: string,
): ResearchReport & { research_id: string } {
  const absolute = path.resolve(file);
  const id = path.basename(absolute, '.json');
  const paths = corpusPaths(repo, id);
  if (absolute !== paths.json) fail();
  safeCorpusPath(repo, paths.json);
  safeCorpusPath(repo, paths.markdown);
  const bytes = fs.readFileSync(paths.json);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail();
  }
  const parsed = parseResearchReport(JSON.parse(text));
  const canonical = canonicalReport(parsed);
  if (
    parsed.research_id !== id ||
    canonical.research_id !== id ||
    !bytes.equals(Buffer.from(canonicalJson(canonical), 'utf8')) ||
    !fs.readFileSync(paths.markdown).equals(Buffer.from(renderCorpusMarkdown(canonical), 'utf8'))
  )
    fail();
  return canonical;
}
/** Empty/missing corpus directories are valid; all existing entries are closed and paired. */
export function verifyResearchCorpus(repo: string): ResearchReport[] {
  const root = path.join(fs.realpathSync(repo), 'research');
  if (!fs.existsSync(root)) {
    if (fs.lstatSync(root, { throwIfNoEntry: false })) fail();
    return [];
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail();
    if (
      ['records', 'reports'].includes(entry.name)
        ? !entry.isDirectory()
        : entry.name !== 'README.md' || !entry.isFile()
    )
      fail();
  }
  const ids = new Set<string>();
  for (const [directory, extension] of [
    ['records', '.json'],
    ['reports', '.md'],
  ] as const) {
    const base = path.join(root, directory);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) fail();
      if (entry.name === '.gitkeep') {
        if (fs.statSync(path.join(base, entry.name)).size !== 0) fail();
        continue;
      }
      if (!new RegExp(`^[a-f0-9]{64}\\${extension}$`, 'u').test(entry.name)) fail();
      ids.add(entry.name.slice(0, -extension.length));
    }
  }
  return [...ids].sort().map((id) => readCorpusReport(repo, corpusPaths(repo, id).json));
}

/** Creation-only hard links retain attempt ownership across a process interruption. */
export async function publishCorpusPair(
  repo: string,
  report: ResearchReport,
  staging: string,
  completed = false,
): Promise<{ json: string; markdown: string }> {
  const canonical = canonicalReport(report);
  if (canonical.research_id !== report.research_id) fail();
  const paths = corpusPaths(repo, canonical.research_id);
  const bytes = { json: canonicalJson(canonical), markdown: renderCorpusMarkdown(canonical) };
  safeCorpusPath(repo, paths.json);
  safeCorpusPath(repo, paths.markdown);
  if (completed && fs.existsSync(paths.json) && fs.existsSync(paths.markdown)) {
    if (canonicalJson(readCorpusReport(repo, paths.json)) !== bytes.json) fail();
    return paths;
  }
  // A fixed repository namespace coordinates publishers independently of TMPDIR and user.
  // Separate private directories avoid one account owning every repository's lock parent.
  const repositoryKey = sha256(fs.realpathSync(repo));
  const lockRoot = path.join('/tmp', `codex-research-publication-locks-${repositoryKey}`);
  protectPrivateStorage(lockRoot, 'directory');
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(
    lockRoot,
    `${sha256(`${fs.realpathSync(repo)}\0${canonical.research_id}`)}.sqlite`,
  );
  const lockStat = fs.lstatSync(lock, { throwIfNoEntry: false });
  if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) fail();
  for (const file of [lock, `${lock}-journal`, `${lock}-wal`, `${lock}-shm`])
    protectPrivateStorage(file);
  const database = new Database(lock, { create: true });
  fs.chmodSync(lock, 0o600);
  // As with task ownership, the OS releases the SQLite lock on process death.
  // Never delete the database inode or guess ownership from PID liveness.
  for (let attempt = 0; ; attempt++) {
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
      break;
    } catch (error) {
      if (
        !['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as { code?: string }).code)) ||
        attempt >= 100
      ) {
        database.close();
        throw new FlowError(
          'Research publication is busy or unavailable; resume this invocation',
          'state_error',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const owned = (key: 'json' | 'markdown'): boolean => {
    const source = fs.lstatSync(path.join(staging, key), { throwIfNoEntry: false });
    const target = fs.lstatSync(paths[key], { throwIfNoEntry: false });
    return Boolean(
      source?.isFile() &&
      target?.isFile() &&
      source.dev === target.dev &&
      source.ino === target.ino,
    );
  };
  const created: ('json' | 'markdown')[] = [];
  try {
    for (const key of ['json', 'markdown'] as const) {
      safeCorpusPath(repo, paths[key]);
      if (
        fs.existsSync(paths[key]) &&
        !fs.readFileSync(paths[key]).equals(Buffer.from(bytes[key], 'utf8'))
      )
        fail();
    }
    const hasJson = fs.existsSync(paths.json),
      hasMarkdown = fs.existsSync(paths.markdown);
    if (hasJson && hasMarkdown) return paths;
    if (completed && !hasJson) fail();
    if ((hasJson && !owned('json') && !completed) || (hasMarkdown && !owned('markdown'))) fail();
    protectPrivateStorage(staging, 'directory');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const key of ['json', 'markdown'] as const) {
      const source = path.join(staging, key);
      protectPrivateStorage(source);
      if (fs.existsSync(source)) {
        if (
          !fs.lstatSync(source).isFile() ||
          fs.lstatSync(source).isSymbolicLink() ||
          !fs.readFileSync(source).equals(Buffer.from(bytes[key], 'utf8'))
        )
          fail();
      } else fs.writeFileSync(source, bytes[key], { flag: 'wx', mode: 0o600 });
      if (!fs.existsSync(paths[key])) {
        fs.mkdirSync(path.dirname(paths[key]), { recursive: true });
        safeCorpusPath(repo, paths[key]);
        fs.linkSync(source, paths[key]);
        created.push(key);
      }
    }
    readCorpusReport(repo, paths.json);
    return paths;
  } catch (error) {
    for (const key of created.reverse()) if (owned(key)) fs.unlinkSync(paths[key]);
    throw error;
  } finally {
    database.exec('ROLLBACK');
    database.close();
  }
}
