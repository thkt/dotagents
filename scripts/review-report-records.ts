import assert from 'node:assert/strict';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertReviewReport, assertState } from './input.ts';
import type { ReviewReport, State } from './input.ts';
import { isArray, isRecord, outside } from './values.ts';
import { parseLogEvents } from './review-report-events.ts';
import type { LogEvent } from './review-report-events.ts';

export interface SavedRecord {
  path: string;
  text: string | null;
  value?: unknown;
  problem?: string;
  events?: LogEvent[];
  additions?: { path: string; content: string | Uint8Array }[];
}

function readAddition(item: unknown) {
  assert(isRecord(item) && typeof item.path === 'string', '追加ファイルのパスが不正です');
  assert(
    typeof item.content === 'string' && typeof item.symlink === 'boolean',
    `${item.path}: 内容・symlinkの保存形式が不正です`,
  );
  if (item.symlink) {
    return { path: item.path, content: item.content };
  }
  const bytes = Buffer.from(item.content, 'base64');
  assert(bytes.toString('base64') === item.content, `${item.path}: base64の保存形式が不正です`);
  return { path: item.path, content: bytes };
}

function inspectAdditions(entry: SavedRecord) {
  if (entry.problem || !entry.path.endsWith('.additions.json')) {
    return;
  }
  if (!isArray(entry.value)) {
    entry.problem = '追加ファイル一覧の保存形式が不正です';
    return;
  }
  const problems: string[] = [];
  entry.additions = entry.value.flatMap((item, index) => {
    try {
      return [readAddition(item)];
    } catch (error) {
      problems.push(`${index + 1}番目: ${String(error)}`);
      return [];
    }
  });
  if (problems.length) {
    entry.problem = problems.join('\n');
  }
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

// References address only records loaded for this case, never arbitrary filesystem paths.
export function trialEvidence(data: ReportRecords) {
  const refs = new Map<string, string>();
  if (data.result.reproduction) {
    refs.set('reproduction', 'reproduction');
  }
  for (const [index, item] of (data.result.review?.items ?? []).entries()) {
    const finding = data.result.adjudication?.findings.find((entry) => entry.id === item.id);
    if (finding?.reason?.trim() && finding.reproduction !== null) {
      refs.set(`finding:${item.id}`, `finding-${index}`);
    }
  }
  for (const [index, target] of data.targets.entries()) {
    if (
      target.path.endsWith('.target.json') &&
      isRecord(target.value) &&
      target.value.targetId === data.result.review?.targetId &&
      target.value.baseCommit === data.result.baseCommit
    ) {
      refs.set(`target:${String(target.value.targetId)}`, `target-${index}`);
    }
  }
  for (const [index, log] of data.logs.entries()) {
    if (!log.problem) {
      refs.set(`log:${log.path.slice(data.root.length + 1)}`, `log-${index}`);
    }
  }
  return refs;
}

async function record(root: string, path: string, json = false): Promise<SavedRecord> {
  let text: string | null = null;
  try {
    const canonical = await realpath(path);
    assert(
      !outside(root, canonical) && canonical === resolve(path),
      '関連記録がsymlinkまたは実行保存先の外を参照しています',
    );
    assert((await lstat(canonical)).isFile(), '通常ファイルではありません');
    text = await readFile(canonical, 'utf8');
    const value: unknown = json ? JSON.parse(text) : undefined;
    return { path, text, value };
  } catch (error) {
    return { path, text, problem: String(error) };
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
  if (timeline && timeline.baseCommit !== result.baseCommit) {
    warnings.push('stateとresultの基準版が不一致です。記録間の対応は未確認です。');
  }
  inspectSavedReview(data);
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

function inspectSavedReview(data: ReportRecords) {
  const { result, timeline, warnings } = data;
  if (timeline && !isDeepStrictEqual(timeline.reviewHistory.at(-1) ?? null, result.review)) {
    warnings.push('stateとresultのレビュー内容が不一致です。記録間の対応は未確認です。');
  }
  if (!isRecord(data.config.value) || data.config.value.baseCommit !== result.baseCommit) {
    warnings.push('configとresultの基準版の対応を確認できません。');
  }
  if (!result.review) {
    return;
  }
  const targets = data.targets.filter(
    (entry) =>
      entry.path.endsWith('.target.json') &&
      isRecord(entry.value) &&
      entry.value.targetId === result.review?.targetId,
  );
  if (!targets.length) {
    warnings.push(
      'レビュー対象IDに一致する保存対象記録がありません。同じ試行の成果物との対応は未確認です。',
    );
  }
  for (const target of targets) {
    const saved = data.targets.find(
      (entry) => entry.path === target.path.replace(/\.target\.json$/, '.json'),
    );
    if (!isRecord(saved?.value) || !isDeepStrictEqual(saved.value.review, result.review)) {
      warnings.push(`${target.path}: 保存レビューとresultの内容が不一致または未確認です。`);
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

function inspectLogs(data: ReportRecords) {
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
    entry.events = parseLogEvents(entry.text ?? '');
    if (!entry.events.length) {
      data.warnings.push(`${entry.path}: JSONLのイベントは未記録です。`);
    }
    for (const row of entry.events) {
      for (const problem of row.problems) {
        data.warnings.push(`${entry.path}:${row.line}: ${problem}`);
      }
    }
  }
  if (data.timeline?.active) {
    data.warnings.push(
      `制御呼出し ${data.timeline.active.role}: 実行中の保存記録があり、完了は未確認です。`,
    );
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

  inspectLogs(data);

  for (const entry of targets) {
    inspectAdditions(entry);
  }

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
