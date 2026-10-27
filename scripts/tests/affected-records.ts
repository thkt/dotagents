import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// 実行したテストファイルの記録を、worktree の git dir の下に保存します。
// 形は { "<テストファイルの絶対パス>": ["<読み込んだモジュールの絶対パス>", ...] } です。

export type LoadedRecords = {
  records: Map<string, Set<string>>;
  warning: string | undefined;
};

export type SaveInput = {
  root: string;
  // 今回実行したテストファイルと、そのファイルが読み込んだモジュールです。
  ran: Map<string, Set<string>>;
  // 今回実行して失敗したテストファイルです。
  failed: string[];
};

export function recordsPath(root: string): string {
  const result = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git rev-parse --git-dir failed: ${result.stderr}`);
  }
  return join(resolve(root, result.stdout.trim()), 'dotagents', 'test-deps.json');
}

function parseRecords(text: string): Map<string, Set<string>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const records = new Map<string, Set<string>>();
  for (const [file, modules] of Object.entries(parsed)) {
    if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string')) {
      return undefined;
    }
    records.set(file, new Set(modules));
  }
  return records;
}

export function loadRecords(root: string): LoadedRecords {
  const path = recordsPath(root);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { records: new Map(), warning: undefined };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { records: new Map(), warning: `${path} を読めないため、記録なしとして扱います: ${reason}` };
  }
  const records = parseRecords(text);
  if (records === undefined) {
    return { records: new Map(), warning: `${path} の形が不正なため、記録なしとして扱います` };
  }
  return { records, warning: undefined };
}

export function saveRecords({ root, ran, failed }: SaveInput): void {
  const path = recordsPath(root);
  const records = loadRecords(root).records;
  for (const [file, modules] of ran) {
    records.set(file, modules);
  }
  for (const file of failed) {
    records.delete(file);
  }
  const body = Object.fromEntries([...records].map(([file, modules]) => [file, [...modules].sort()]));
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
