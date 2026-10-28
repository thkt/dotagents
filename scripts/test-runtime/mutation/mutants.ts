import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../../shared/process.ts';

type Operator = 'condition-negation' | 'boundary-flip' | 'boolean-flip' | 'assert-negation';
type Hunk = {
  file: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  added: { line: number; text: string }[];
  deleted: string[];
};
export type Changes = { hunks: Hunk[]; sources: Map<string, string>; ignoredFiles: string[] };
export type Mutant = {
  id: string;
  file: string;
  hunk: string;
  line: number;
  operator: Operator;
  start: number;
  end: number;
  original: string;
  replacement: string;
};
type Unmutable = {
  hunk: string;
  reason: 'deleted-only' | 'deleted-lines' | 'moved-only' | 'no-operator';
};
export type Plan = {
  mutants: Mutant[];
  unmutable: Unmutable[];
  movedLines: number;
  ignoredFiles: string[];
};
export type Selection = {
  selected: Mutant[];
  discarded: { total: number; byOperator: Record<string, number>; byFile: Record<string, number> };
  unmutated: { hunk: string; reason: 'discarded' | 'cap' }[];
  skippedCandidates: number;
};

// 製品コードと、判定を担うrunner.tsだけを変異させる。ほかのテスト資産は検出する側に置く。
function isTarget(path: string) {
  return (
    path.startsWith('scripts/') &&
    path.endsWith('.ts') &&
    (!path.startsWith('scripts/tests/') || path === 'scripts/tests/runner.ts')
  );
}

async function git(repo: string, ...args: string[]) {
  const result = await command(['git', '-c', 'core.quotePath=false', ...args], repo, '', 60000);
  assert(result.code === 0 && !result.timedOut, `git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

function hunkHeader(file: string, line: string): Hunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  assert(match, `Unexpected hunk header: ${line}`);
  return {
    file,
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
    added: [],
    deleted: [],
  };
}

// 空白を含むパスの末尾のTABを除き、引用されたパスは戻してから接頭辞を外す。
function diffPath(line: string, prefix: string) {
  const raw = line.slice(4).replace(/\t$/, '');
  const unquoted: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw;
  assert(typeof unquoted === 'string', `Unexpected diff path: ${line}`);
  const path = unquoted;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

type DiffState = { oldFile: string; file: string; current?: Hunk; hunks: Hunk[] };

function readDiffLine(state: DiffState, line: string) {
  if (line.startsWith('diff --git ')) {
    state.current = undefined;
    return;
  }
  if (line.startsWith('--- ')) {
    state.oldFile = diffPath(line, 'a/');
    return;
  }
  if (line.startsWith('+++ ')) {
    const path = diffPath(line, 'b/');
    // ファイル全体の削除は旧パスの削除行として扱う。
    state.file = path === '/dev/null' ? state.oldFile : path;
    return;
  }
  if (line.startsWith('@@ ')) {
    state.current = hunkHeader(state.file, line);
    state.hunks.push(state.current);
    return;
  }
  const hunk = state.current;
  if (hunk && line.startsWith('+')) {
    hunk.added.push({ line: hunk.newStart + hunk.added.length, text: line.slice(1) });
  } else if (hunk && line.startsWith('-')) {
    hunk.deleted.push(line.slice(1));
  }
}

function parseDiff(text: string) {
  const state: DiffState = { oldFile: '', file: '', hunks: [] };
  for (const line of text.split('\n')) {
    readDiffLine(state, line);
  }
  return state.hunks;
}

// 作業ツリー（未コミットと未追跡のファイルを含む）を基準commitと比べる。実checkoutは読むだけにする。
export async function readChanges(repo: string, base: string): Promise<Changes> {
  const diff = await git(
    repo,
    // 利用者のgit設定で接頭辞や変換が変わらないよう、出力の形を固定する。
    '-c',
    'diff.noprefix=false',
    '-c',
    'diff.mnemonicPrefix=false',
    'diff',
    '-M',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--ignore-space-change',
    base,
    '--',
  );
  const hunks = parseDiff(diff);
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z'))
    .split('\0')
    .filter(Boolean);
  const sources = new Map<string, string>();
  const ignoredUntracked: string[] = [];
  for (const file of untracked) {
    // 対象外や、通常ファイルでない未追跡の項目（node_modulesへのsymlinkなど）は読まない。
    if (!isTarget(file) || !(await lstat(join(repo, file))).isFile()) {
      ignoredUntracked.push(file);
      continue;
    }
    const text = await readFile(join(repo, file), 'utf8');
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    hunks.push({
      file,
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: lines.length,
      added: lines.map((line, index) => ({ line: index + 1, text: line })),
      deleted: [],
    });
  }
  const files = [...new Set(hunks.map((hunk) => hunk.file))];
  for (const file of files.filter(isTarget)) {
    if (hunks.some((hunk) => hunk.file === file && hunk.newCount > 0)) {
      sources.set(file, await readFile(join(repo, file), 'utf8'));
    }
  }
  const ignoredFiles = [...files.filter((file) => !isTarget(file)), ...ignoredUntracked].sort();
  return { hunks, sources, ignoredFiles };
}

function commentEnd(text: string, index: number) {
  if (text.startsWith('//', index)) {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end;
  }
  if (text.startsWith('/*', index)) {
    const end = text.indexOf('*/', index + 2);
    return end < 0 ? text.length : end + 2;
  }
  return undefined;
}

// 位置indexから始まる文字列・正規表現の終わりを返す。どちらでもなければundefinedを返す。
function literalEnd(text: string, index: number, previous: string) {
  const char = text[index] ?? '';
  if (char === "'" || char === '"') {
    return quotedEnd(text, index, char);
  }
  // 直前が値で終わらない位置や、値をとるキーワードの後の/は、除算ではなく正規表現の開始とみなす。
  if (
    char === '/' &&
    (/^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(previous) || regexKeywords.has(wordBefore(text, index)))
  ) {
    return regexEnd(text, index);
  }
  return undefined;
}

const regexKeywords = new Set([
  'return',
  'typeof',
  'case',
  'await',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'else',
  'do',
  'instanceof',
]);

// 空白を飛ばした直前の語を返す。プロパティ名（.returnなど）は語として扱わない。
function wordBefore(text: string, index: number) {
  let end = index;
  while (end > 0 && /\s/.test(text[end - 1] ?? '')) {
    end--;
  }
  let start = end;
  while (start > 0 && /[\w$]/.test(text[start - 1] ?? '')) {
    start--;
  }
  return text[start - 1] === '.' ? '' : text.slice(start, end);
}

type Scan = {
  mask: boolean[];
  templates: number[];
  depth: number;
  previous: string;
  index: number;
};

// テンプレートの文字部分を飛ばし、埋め込み式の${に入るときは閉じる}の深さを覚える。
function scanTemplate(text: string, scan: Scan) {
  if (text[scan.index] === '}') {
    scan.templates.pop();
  }
  const end = templateEnd(text, scan.index + 1);
  const embedded = text.startsWith('${', end);
  if (embedded) {
    scan.templates.push(scan.depth);
  }
  scan.index = end + (embedded ? 2 : 1);
  scan.previous = 'a';
}

function scanCode(text: string, scan: Scan) {
  const char = text[scan.index] ?? '';
  scan.mask[scan.index] = true;
  if (char === '{') {
    scan.depth++;
  } else if (char === '}') {
    scan.depth--;
  }
  if (/\S/.test(char)) {
    scan.previous = /[\w$]/.test(char) ? 'a' : char;
  }
  scan.index++;
}

// 文字列・テンプレート・コメント・正規表現の内側を除き、コードの位置だけをtrueにする。
function codeMask(text: string) {
  const scan: Scan = {
    mask: Array.from({ length: text.length }, () => false),
    templates: [],
    depth: 0,
    previous: '',
    index: 0,
  };
  while (scan.index < text.length) {
    const char = text[scan.index];
    if (char === '`' || (char === '}' && scan.templates.at(-1) === scan.depth)) {
      scanTemplate(text, scan);
      continue;
    }
    const comment = commentEnd(text, scan.index);
    const literal = comment === undefined ? literalEnd(text, scan.index, scan.previous) : undefined;
    if (comment !== undefined) {
      scan.index = comment;
    } else if (literal !== undefined) {
      scan.index = literal;
      scan.previous = 'a';
    } else {
      scanCode(text, scan);
    }
  }
  return scan.mask;
}

function quotedEnd(text: string, start: number, quote: string) {
  let index = start + 1;
  while (index < text.length && text[index] !== quote && text[index] !== '\n') {
    index += text[index] === '\\' ? 2 : 1;
  }
  return index + 1;
}

// 閉じる`か、埋め込み式の${の位置を返す。
function templateEnd(text: string, start: number) {
  let index = start;
  while (index < text.length && text[index] !== '`' && !text.startsWith('${', index)) {
    index += text[index] === '\\' ? 2 : 1;
  }
  return index;
}

function regexEnd(text: string, start: number) {
  let index = start + 1;
  let inClass = false;
  while (index < text.length && text[index] !== '\n') {
    const char = text[index];
    if (char === '\\') {
      index++;
    } else if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      break;
    }
    index++;
  }
  while (/[a-z]/.test(text[index + 1] ?? '')) {
    index++;
  }
  return index + 1;
}

// 開き括弧の直後から、深さ0の区切り（stopが,なら,か閉じ括弧）までの位置を返す。
function argumentEnd(text: string, mask: boolean[], start: number, stopAtComma: boolean) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (!mask[index]) {
      continue;
    }
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (depth > 0 && (char === ')' || char === ']' || char === '}')) {
      depth--;
    } else if (depth === 0 && (char === ')' || (stopAtComma && char === ','))) {
      return index;
    }
  }
  return -1;
}

// 既に否定した式は否定を外し、それ以外は全体を括弧で囲んで否定する。
function negate(expression: string) {
  const wrapped = /^!\((.*)\)$/s.exec(expression)?.[1];
  if (wrapped !== undefined && argumentEnd(wrapped, codeMask(wrapped), 0, false) < 0) {
    return wrapped;
  }
  if (/^![\w$.]+$/.test(expression)) {
    return expression.slice(1);
  }
  return /^[\w$.]+$/.test(expression) ? `!${expression}` : `!(${expression})`;
}

type Candidate = Pick<Mutant, 'operator' | 'start' | 'end' | 'original' | 'replacement'>;

const flips: Record<string, string> = {
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
  '<=': '<',
  '<': '<=',
  '>=': '>',
  '>': '>=',
  true: 'false',
  false: 'true',
};

function tokenCandidates(text: string, mask: boolean[]) {
  const found: Candidate[] = [];
  const patterns: [Operator, RegExp][] = [
    ['condition-negation', /(?<= )(?:===|!==|==|!=)(?= )/g],
    ['boundary-flip', /(?<= )(?:<=|>=|<|>)(?= )/g],
    ['boolean-flip', /(?<![\w$.])(?:true|false)(?![\w$])/g],
  ];
  for (const [operator, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const original = match[0];
      if (mask[match.index]) {
        const end = match.index + original.length;
        found.push({
          operator,
          start: match.index,
          end,
          original,
          replacement: flips[original] ?? '',
        });
      }
    }
  }
  return found;
}

// if・whileの条件とassertの第1引数を否定する。
function wrapCandidates(text: string, mask: boolean[]) {
  const found: Candidate[] = [];
  const patterns: [Operator, RegExp, boolean][] = [
    ['condition-negation', /\b(?:if|while) \(/g, false],
    ['assert-negation', /(?<![\w$.])assert\(/g, true],
  ];
  for (const [operator, pattern, stopAtComma] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const open = match.index + match[0].length;
      const close = argumentEnd(text, mask, open, stopAtComma);
      const inner = close > open ? text.slice(open, close) : '';
      // 引数の前後の改行・空白は変えず、式の部分だけを置き換える。
      const start = open + (inner.length - inner.trimStart().length);
      const end = start + inner.trim().length;
      if (mask[match.index] && end > start) {
        const original = text.slice(start, end);
        found.push({ operator, start, end, original, replacement: negate(original) });
      }
    }
  }
  return found;
}

function lineStarts(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineOf(starts: number[], offset: number) {
  let line = 1;
  while (line < starts.length && (starts[line] ?? Infinity) <= offset) {
    line++;
  }
  return line;
}

const squash = (lines: string[]) => lines.join('').replace(/\s+/g, '');

function hunkLabel(hunk: Hunk) {
  return hunk.newCount === 0
    ? `${hunk.file}:-${hunk.oldStart},${hunk.oldCount}`
    : `${hunk.file}:${hunk.newStart}`;
}

// 連続する最大5行を空白なしで連結した文字列。行の分割・結合だけの整形を見つけるために使う。
const windowSize = 5;
function windows(lines: string[]) {
  const found: { from: number; to: number; text: string }[] = [];
  for (let from = 0; from < lines.length; from++) {
    for (let to = from; to < Math.min(lines.length, from + windowSize); to++) {
      const text = squash(lines.slice(from, to + 1));
      if (text) {
        found.push({ from, to, text });
      }
    }
  }
  return found;
}

// 対象ファイルの他の場所で削除された行と同じ内容（前後の空白を除く）の追加行は移動とみなす。
// 同じhunkの連続する削除行と、空白を除いて完全に一致する連続する追加行は整形とみなす。
function eligibleLines(hunks: Hunk[]) {
  const targets = hunks.filter((hunk) => isTarget(hunk.file));
  const deleted = new Set(
    targets.flatMap((hunk) => hunk.deleted.map((line) => line.trim())).filter(Boolean),
  );
  const eligible = new Map<Hunk, number[]>();
  let moved = 0;
  for (const hunk of targets) {
    const before = new Set(windows(hunk.deleted).map((window) => window.text));
    const reformatted = new Set<number>();
    for (const window of windows(hunk.added.map((added) => added.text))) {
      if (before.has(window.text)) {
        for (let index = window.from; index <= window.to; index++) {
          reformatted.add(index);
        }
      }
    }
    const lines = hunk.added.filter(
      ({ text }, index) => !deleted.has(text.trim()) && !reformatted.has(index),
    );
    moved += hunk.added.length - lines.length;
    eligible.set(
      hunk,
      lines.map((added) => added.line),
    );
  }
  return { eligible, moved };
}

type Parsed = { starts: number[]; candidates: Candidate[] };

function parse(source: string): Parsed {
  const mask = codeMask(source);
  return {
    starts: lineStarts(source),
    candidates: [...tokenCandidates(source, mask), ...wrapCandidates(source, mask)],
  };
}

// 置き換える範囲が変更行に重なる候補だけを、そのhunkの変異にする。
function hunkMutants(hunk: Hunk, label: string, lines: Set<number>, parsed: Parsed): Mutant[] {
  const { starts } = parsed;
  return parsed.candidates
    .map((candidate) => ({
      candidate,
      line: lineOf(starts, candidate.start),
      last: lineOf(starts, candidate.end),
    }))
    .filter(({ line, last }) => [...lines].some((changed) => changed >= line && changed <= last))
    .sort((a, b) => a.candidate.start - b.candidate.start)
    .map(({ candidate, line }) => ({
      ...candidate,
      id: `${hunk.file}:${line}:${candidate.start - (starts[line - 1] ?? 0) + 1} ${candidate.operator}`,
      file: hunk.file,
      hunk: label,
      line,
    }));
}

// 1つのhunkに偏らないよう、各hunkから順に1件ずつ取り出す。複数hunkにまたがる変異は1回だけ数える。
function roundRobin(perHunk: Mutant[][]) {
  const ordered: Mutant[] = [];
  const seen = new Set<string>();
  for (let round = 0; perHunk.some((mutants) => mutants.length > round); round++) {
    for (const mutant of perHunk.flatMap((mutants) => mutants[round] ?? [])) {
      if (!seen.has(mutant.id)) {
        seen.add(mutant.id);
        ordered.push(mutant);
      }
    }
  }
  return ordered;
}

export function planMutants(changes: Changes): Plan {
  const { eligible, moved } = eligibleLines(changes.hunks);
  const targets = changes.hunks
    .filter((hunk) => isTarget(hunk.file))
    .sort((a, b) => (a.file === b.file ? a.newStart - b.newStart : a.file < b.file ? -1 : 1));
  const perHunk: Mutant[][] = [];
  const unmutable: Unmutable[] = [];
  const parsedFiles = new Map<string, Parsed>();
  for (const hunk of targets) {
    const label = hunkLabel(hunk);
    const lines = new Set(eligible.get(hunk));
    if (hunk.newCount > 0 && hunk.deleted.length > 0) {
      unmutable.push({
        hunk: `${hunk.file}:-${hunk.oldStart},${hunk.oldCount}`,
        reason: 'deleted-lines',
      });
    }
    if (hunk.newCount === 0 || lines.size === 0) {
      unmutable.push({ hunk: label, reason: hunk.newCount === 0 ? 'deleted-only' : 'moved-only' });
      continue;
    }
    const source = changes.sources.get(hunk.file);
    assert(source !== undefined, `Missing source: ${hunk.file}`);
    const parsed = parsedFiles.get(hunk.file) ?? parse(source);
    parsedFiles.set(hunk.file, parsed);
    const mutants = hunkMutants(hunk, label, lines, parsed);
    if (mutants.length === 0) {
      unmutable.push({ hunk: label, reason: 'no-operator' });
    } else {
      perHunk.push(mutants);
    }
  }
  return {
    mutants: roundRobin(perHunk),
    unmutable,
    movedLines: moved,
    ignoredFiles: changes.ignoredFiles,
  };
}

export function applyMutant(source: string, mutant: Mutant) {
  assert.equal(
    source.slice(mutant.start, mutant.end),
    mutant.original,
    `Stale mutant: ${mutant.id}`,
  );
  return `${source.slice(0, mutant.start)}${mutant.replacement}${source.slice(mutant.end)}`;
}

// 決定的な順で検査し、lint・型検査を通った変異だけを上限まで選ぶ。
export async function selectMutants(
  plan: Plan,
  max: number,
  compiles: (mutant: Mutant) => Promise<boolean>,
): Promise<Selection> {
  const selected: Mutant[] = [];
  const discarded: Selection['discarded'] = { total: 0, byOperator: {}, byFile: {} };
  let examined = 0;
  for (const mutant of plan.mutants) {
    if (selected.length >= max) {
      break;
    }
    examined++;
    if (await compiles(mutant)) {
      selected.push(mutant);
    } else {
      discarded.total++;
      discarded.byOperator[mutant.operator] = (discarded.byOperator[mutant.operator] ?? 0) + 1;
      discarded.byFile[mutant.file] = (discarded.byFile[mutant.file] ?? 0) + 1;
    }
  }
  const mutated = new Set(selected.map((mutant) => mutant.hunk));
  // 全候補を検査して破棄したhunkだけを破棄とし、未検査の候補が残るhunkは上限による未変異とする。
  const unchecked = new Set(plan.mutants.slice(examined).map((mutant) => mutant.hunk));
  const unmutated = [...new Set(plan.mutants.map((mutant) => mutant.hunk))]
    .filter((hunk) => !mutated.has(hunk))
    .map((hunk) => ({
      hunk,
      reason: unchecked.has(hunk) ? ('cap' as const) : ('discarded' as const),
    }));
  return { selected, discarded, unmutated, skippedCandidates: plan.mutants.length - examined };
}
