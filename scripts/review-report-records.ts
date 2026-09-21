import assert from 'node:assert/strict';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assertReviewReport, assertState } from './input.ts';
import type { ReviewReport, State } from './input.ts';
import { isArray, isRecord, outside } from './values.ts';

export interface SavedRecord {
  path: string;
  text: string | null;
  value?: unknown;
  problem?: string;
}
export interface ReportRecords {
  result: ReviewReport;
  input: SavedRecord;
  root: string;
  caseDir: string;
  issue: SavedRecord;
  environment: SavedRecord;
  cases: SavedRecord;
  config: SavedRecord;
  state: SavedRecord;
  timeline: State | null;
  targets: SavedRecord[];
  logs: SavedRecord[];
  warnings: string[];
}

async function record(root: string, path: string, json = false): Promise<SavedRecord> {
  try {
    const canonical = await realpath(path);
    assert(
      !outside(root, canonical) && canonical === resolve(path),
      '関連記録がsymlinkまたは実行保存先の外を参照しています',
    );
    assert((await lstat(canonical)).isFile(), '通常ファイルではありません');
    const text = await readFile(canonical, 'utf8');
    const value: unknown = json ? JSON.parse(text) : undefined;
    return { path, text, value };
  } catch (error) {
    return { path, text: null, problem: String(error) };
  }
}

async function entries(root: string, path: string, warnings: string[]) {
  try {
    assert(
      !outside(root, await realpath(path)),
      '関連ディレクトリが実行保存先の外を参照しています',
    );
    return (await readdir(path)).sort();
  } catch (error) {
    warnings.push(`${path}: ${String(error)}`);
    return [];
  }
}

async function relatedLogs(root: string, caseDir: string, names: string[], warnings: string[]) {
  const logs: SavedRecord[] = [];
  const verification = join(caseDir, 'verification');
  for (const name of names.filter((name) =>
    /^(check|review|repair|capture)-\d+\.(stdout|stderr|prompt)$/.test(name),
  )) {
    logs.push(await record(root, join(verification, name)));
  }
  const actors = (await entries(root, caseDir, warnings)).filter((name) =>
    /^(review|repair)-codex-[A-Za-z0-9_-]+$/.test(name),
  );
  if (!actors.length) {
    warnings.push(
      'モデル呼出しの生ログがありません。ツール実行・失敗・参照コンテキストは未確認です。',
    );
  }
  for (const actor of actors) {
    for (const file of ['events.jsonl', 'stderr.log', 'final.json']) {
      logs.push(await record(root, join(caseDir, actor, file), file.endsWith('.json')));
    }
  }
  return logs;
}

function checkTimeline(state: SavedRecord, warnings: string[]) {
  if (!state.text) {
    return null;
  }
  try {
    assertState(state.value);
    return state.value;
  } catch (error) {
    warnings.push(`${state.path}: ${String(error)}。呼出し順序は未確認です。`);
    return null;
  }
}

function inspectCorrespondence(data: ReportRecords) {
  const { result, warnings, timeline } = data;
  const targets = data.targets.filter((entry) => entry.path.endsWith('.target.json'));
  if (
    result.review &&
    !targets.some(
      (entry) => isRecord(entry.value) && entry.value.targetId === result.review?.targetId,
    )
  ) {
    warnings.push(
      'レビュー対象IDに一致する保存対象記録がありません。同じ試行の成果物との対応は未確認です。',
    );
  }
  if (timeline && timeline.baseCommit !== result.baseCommit) {
    warnings.push('stateとresultの基準版が不一致です。記録間の対応は未確認です。');
  }
  for (const entry of targets) {
    inspectTarget(entry, data);
    if (isRecord(entry.value) && entry.value.baseCommit !== result.baseCommit) {
      warnings.push(`${entry.path}: 基準版がresultと一致しません。`);
    }
  }
  const reviewedIds = new Set(result.review?.items.map((item) => item.id));
  for (const finding of result.adjudication?.findings ?? []) {
    if (!reviewedIds.has(finding.id)) {
      warnings.push(`裁定 ${finding.id} に対応するレビュー指摘がありません。`);
    }
  }
}

function inspectTarget(entry: SavedRecord, data: ReportRecords) {
  if (
    !isRecord(entry.value) ||
    !isRecord(entry.value.issue) ||
    typeof entry.value.issue.content !== 'string'
  ) {
    data.warnings.push(`${entry.path}: レビュー時点の要求記録がありません。`);
    return;
  }
  try {
    const original: unknown = JSON.parse(entry.value.issue.content);
    const current = data.issue.value;
    assert(isRecord(original) && isRecord(current), '要求記録の形式が未対応です');
    if (['body', 'title', 'state', 'updatedAt'].some((key) => original[key] !== current[key])) {
      data.warnings.push(
        `${entry.path}: issue.jsonとレビュー時点の要求が不一致です。過去の判定との対応は未確認です。`,
      );
    }
  } catch (error) {
    data.warnings.push(`${entry.path}: レビュー時点の要求との照合不能: ${String(error)}`);
  }
}

function inspectLogFailures(data: ReportRecords) {
  for (const event of data.timeline?.events ?? []) {
    if (event.code !== 0 || event.timedOut) {
      data.warnings.push(
        `制御呼出し ${event.role} (${basename(event.prefix)}): code=${event.code}, timedOut=${event.timedOut}。原因・採点への影響は未確認です。`,
      );
    }
  }
  for (const entry of data.logs.filter(
    (log) => log.path.endsWith('events.jsonl') && log.text !== null,
  )) {
    inspectJsonLines(entry, data.warnings);
  }
}

function inspectJsonLines(entry: SavedRecord, warnings: string[]) {
  for (const [index, line] of (entry.text ?? '').split('\n').entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event: unknown = JSON.parse(line);
      assert(isRecord(event) && typeof event.type === 'string', 'Invalid event');
      const item = isRecord(event.item) ? event.item : {};
      const failed =
        event.type === 'error' ||
        event.type.endsWith('.failed') ||
        item.status === 'failed' ||
        (typeof item.exit_code === 'number' && item.exit_code !== 0);
      if (failed) {
        warnings.push(
          `${entry.path}:${index + 1}: ${event.type} に失敗の記録があります。原因・採点への影響は未確認です。`,
        );
      }
    } catch (error) {
      warnings.push(`${entry.path}:${index + 1}: JSONL不正・未完の記録: ${String(error)}`);
    }
  }
}

async function includeMissingLogs(
  root: string,
  verification: string,
  timeline: State | null,
  logs: SavedRecord[],
) {
  for (const event of timeline?.events ?? []) {
    for (const suffix of event.role === 'review' || event.role === 'repair'
      ? ['.stdout', '.stderr', '.prompt']
      : ['.stdout', '.stderr']) {
      const expected = join(verification, basename(event.prefix) + suffix);
      if (!logs.some((log) => log.path === expected)) {
        logs.push(await record(root, expected));
      }
    }
  }
}

export async function readReport(inputPath: string): Promise<ReportRecords> {
  const path = await realpath(inputPath);
  assert(
    basename(path) === 'result.json' && basename(dirname(dirname(path))) === 'host',
    `${inputPath}: 対応形式は RUN/host/CASE/result.json です`,
  );
  const root = dirname(dirname(dirname(path)));
  const input = await record(root, path, true);
  try {
    assert(!input.problem, input.problem ?? 'Unreadable result');
    assertReviewReport(input.value);
    assert(input.value.id === basename(dirname(path)), 'Case directory and result id mismatch');
  } catch (error) {
    throw Error(`${inputPath}: ${String(error)}`);
  }
  const result = input.value;
  const caseDir = join(root, result.id);
  const warnings: string[] = [];
  const [issue, environment, config, state, cases] = await Promise.all([
    record(root, join(caseDir, 'issue.json'), true),
    record(root, join(root, 'host', 'environment.json'), true),
    record(root, join(caseDir, 'config.json'), true),
    record(root, join(caseDir, 'verification', 'state.json'), true),
    record(root, join(root, 'host', 'cases.json'), true),
  ]);
  const timeline = checkTimeline(state, warnings);
  const verification = join(caseDir, 'verification');
  const targets: SavedRecord[] = [];
  const names = await entries(root, verification, warnings);
  const prefixes = new Set(
    names
      .filter((name) => /^review-\d+\.(target\.json|diff|additions\.json|json)$/.test(name))
      .map((name) => name.split('.')[0]),
  );
  for (const name of prefixes) {
    assert(name);
    const prefix = join(verification, name);
    for (const suffix of ['.target.json', '.diff', '.additions.json', '.json']) {
      targets.push(await record(root, `${prefix}${suffix}`, suffix.endsWith('.json')));
    }
  }
  const logs = await relatedLogs(root, caseDir, names, warnings);
  await includeMissingLogs(root, verification, timeline, logs);
  const data = {
    result,
    input,
    root,
    caseDir,
    issue,
    environment,
    cases,
    config,
    state,
    timeline,
    targets,
    logs,
    warnings,
  };
  inspectCorrespondence(data);
  const mapping = isArray(cases.value)
    ? cases.value.filter((entry) => isRecord(entry) && entry.id === result.id)
    : [];
  if (mapping.length !== 1 || !isRecord(mapping[0]) || mapping[0].name !== result.name) {
    warnings.push('host/cases.jsonとケースID・記録名の対応を確認できません。');
  }

  inspectLogFailures(data);

  for (const entry of [issue, environment, cases, config, state, ...targets, ...logs]) {
    if (entry.problem) {
      warnings.push(`${entry.path}: ${entry.problem}`);
    }
  }
  if (!isRecord(issue.value) || typeof issue.value.body !== 'string') {
    warnings.push('要求本文が欠落または未対応形式です。要求との対応は未確認です。');
  }
  return data;
}

// Refuse outputs in the source run, this harness, or any Git checkout (including worktrees).
// Require an existing parent so canonicalization also detects directory symlinks.
export async function reportDestination(output: string, root: string) {
  const parent = await realpath(dirname(resolve(output)));
  const destination = join(parent, basename(output));
  assert(outside(root, destination), `${output}: 出力先は入力記録の保存先外にしてください`);
  assert(
    outside(await realpath(resolve(import.meta.dir, '..')), destination),
    `${output}: 出力先はcheckout外にしてください`,
  );
  let cursor = parent;
  while (true) {
    const git = await lstat(join(cursor, '.git')).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    assert(!git, `${output}: 出力先はcheckout外にしてください`);
    const next = dirname(cursor);
    if (next === cursor) {
      break;
    }
    cursor = next;
  }
  return destination;
}
