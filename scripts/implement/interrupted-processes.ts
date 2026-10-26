import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { issueNumber } from '../shared/target.ts';
import type { TestInterruption } from './test-interruption-schema.ts';
import { z } from 'zod';

export type InterruptedEntry =
  | '--adopt-local-run'
  | '--interrupted-run'
  | '--check-timeout-run'
  | '--test-run'
  | '--test-interrupted-run';

export type InitialTestHost = TestInterruption['host'] & { common: string; repository: string };
export interface InitialTestOwner {
  entry: '--test-run' | '--test-interrupted-run' | '--host-run' | '--human-decision-run';
  previousRun: string;
  cwd: string;
  common: string;
  previousRuns?: string[];
}

export type InitialProcessTarget = Omit<InitialTestHost, 'common'> & {
  owner?: Omit<InitialTestOwner, 'common'>;
};

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const timesShape = z.object({ startedAt: z.iso.datetime(), finishedAt: z.iso.datetime() });

function processStart(text: string) {
  const [weekday, month, day, time, year] = text.trim().split(/\s+/);
  const value = Date.parse(text);
  assert(Number.isFinite(value), 'プロセス開始時刻を解釈できません');
  const date = new Date(value);
  const actual = `${weekdays[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()} ${date.toTimeString().slice(0, 8)} ${date.getFullYear()}`;
  assert(
    actual === `${weekday} ${month} ${Number(day)} ${time} ${year}` && value <= Date.now(),
    'プロセス開始時刻の形式・暦・観測時点が不正です',
  );
  return value;
}

function processRows(stdout: string) {
  return initialProcessRows(stdout).map((row) => {
    const match =
      /^((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        row.command,
      );
    assert(match, 'プロセス観測にPID・親PID・開始時刻・commandの列がありません');
    const started = match[1];
    const command = match[2]?.trim();
    assert(started && command, 'プロセス観測の開始時刻・commandがありません');
    return { ...row, startedAt: processStart(started), command };
  });
}

export async function verifyInterruptedProcesses(
  stdout: string,
  input: {
    previousRun: string;
    runDirectory: string;
    review: string[];
    entry?: InterruptedEntry;
    check?: string[];
    host?: InitialTestHost;
    owner?: InitialTestOwner;
    commonDirectory?: (cwd: string) => Promise<string>;
  },
) {
  if (input.entry === '--test-interrupted-run' || input.entry === '--test-run') {
    assert(input.host, '旧ホストの対象root・Issueがありません');
    await verifyInitialTestProcesses(stdout, input);
    return;
  }
  const saved = timesShape.parse(
    JSON.parse(await readFile(join(input.previousRun, 'result.json'), 'utf8')),
  );
  const started = Date.parse(saved.startedAt);
  const finished = Date.parse(saved.finishedAt);
  assert(finished >= started, '旧runのプロセス照合期間が不正です');
  const executable = input.review[0];
  assert(executable, '保存された評価コマンドがありません');
  const names = new Set([basename(executable)]);
  if (input.check?.[0]) {
    names.add(basename(input.check[0]));
  }
  if (input.review.some((argument) => argument.endsWith('/codex-actor.ts'))) {
    names.add('codex');
  }
  for (const row of processRows(stdout)) {
    if (row.pid === process.pid) {
      continue;
    }
    // psの開始時刻は秒単位。旧停止後に始まった明示的な新CLIだけを除く。
    const returning: boolean =
      row.startedAt >= Math.floor(finished / 1000) * 1000 &&
      cliArgument(row.command, input.entry ?? '--interrupted-run', input.previousRun) &&
      cliArgument(row.command, '--run-dir', input.runDirectory) &&
      !cliArgument(row.command, '--run-dir', input.previousRun);
    assert(
      returning ||
        (!row.command.includes(input.previousRun) && !row.command.includes(input.review.join(' '))),
      `旧runまたは旧評価に対応する稼働プロセスがあります: PID=${row.pid}, PPID=${row.parent}, start=${new Date(row.startedAt).toISOString()}`,
    );
    const name = basename((row.command.split(/\s+/)[0] ?? '').replace(/^["']|["']$/g, ''));
    const sameCheck = input.check && row.command.includes(input.check.join(' '));
    assert(
      returning ||
        (!names.has(name) && !sameCheck) ||
        row.startedAt < Math.floor(started / 1000) * 1000 ||
        row.startedAt > finished,
      `旧実行期間内の同種プロセスを対応付けられません: PID=${row.pid}。追加観測が必要です`,
    );
  }
}

export function cliArgument(argv: string, option: string, path: string) {
  const literal = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${option}(?:=|\\s+)["']?${literal}["']?(?:\\s|$)`).test(argv);
}

function initialProcessRows(stdout: string) {
  const rows = [];
  const pids = new Set<number>();
  for (const line of stdout.split('\n').filter((value) => value.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    assert(match, 'プロセス観測のPID・親PID・commandを照合できません');
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    assert(
      Number.isSafeInteger(pid) &&
        pid > 0 &&
        Number.isSafeInteger(parent) &&
        parent >= 0 &&
        pid !== parent &&
        !pids.has(pid),
      'プロセス一覧のPID対応が不正です',
    );
    pids.add(pid);
    rows.push({ pid, parent, command: match[3] ?? '' });
  }
  assert(rows.length > 0, 'プロセス一覧が空で照合できません');
  return rows;
}

function processAncestors(rows: ReturnType<typeof initialProcessRows>) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestors = new Set<number>();
  let parent = process.ppid;
  while (parent > 0) {
    assert(!ancestors.has(parent), 'プロセスの親PID対応が循環しています');
    const row = byPid.get(parent);
    if (!row) {
      break;
    }
    ancestors.add(parent);
    parent = row.parent;
  }
  return ancestors;
}

function developmentArgs(command: string) {
  const entry =
    /(?:^|\s)(?:"(?:[^"]*\/)?development\.ts"|'(?:[^']*\/)?development\.ts'|(?:[^\s"']*\/)?development\.ts)(?=\s|$)/.exec(
      command,
    );
  if (!entry) {
    return undefined;
  }
  const tail = command.slice(entry.index + entry[0].length);
  const args = [];
  let end = 0;
  // psの表示から単純なCLI引数だけを識別する。shell構文や曖昧な境界は解釈しない。
  for (const token of tail.matchAll(/"[^"]*"|'[^']*'|[^\s"']+/g)) {
    assert(tail.slice(end, token.index).trim() === '', 'ホストCLIの引数境界を照合できません');
    args.push(token[0].replace(/^["']|["']$/g, ''));
    end = token.index + token[0].length;
  }
  assert(tail.slice(end).trim() === '', 'ホストCLIの引数境界を照合できません');
  return args;
}

function differentIssue(input: string | undefined, host: InitialTestHost) {
  if (!input) {
    return false;
  }
  const repository =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\//.exec(input)?.[1] ?? host.repository;
  try {
    const number = issueNumber(input, repository);
    return repository !== host.repository || number !== host.issue;
  } catch {
    return false;
  }
}

async function verifyDevelopmentHost(
  argv: string,
  input: Parameters<typeof verifyInterruptedProcesses>[1],
) {
  const invocation = developmentArgs(argv);
  if (!invocation) {
    return;
  }
  const host = input.host;
  assert(host, '元ホストの対象root・Issueを照合できません');
  // psはパス内の空白を引用しないため、先頭のIssueだけで別対象を判定する。
  if (differentIssue(invocation[0], host)) {
    return;
  }
  const repo = parseArgs({
    args: invocation,
    allowPositionals: true,
    strict: false,
    options: { repo: { type: 'string' }, 'no-publish': { type: 'boolean' } },
  }).values.repo;
  assert(
    typeof repo === 'string' && isAbsolute(repo),
    '同じIssueのホスト対象を照合できません。絶対--repoと追加観測が必要です',
  );
  const cwd = await realpath(repo);
  assert(
    cwd !== host.cwd && cwd !== join(input.previousRun, 'checkout') && cwd !== input.owner?.cwd,
    '同じIssue・対象の旧ホストプロセスが稼働しています',
  );
  assert(input.commonDirectory, '別repoのGit領域を照合できません');
  const common = await realpath(await input.commonDirectory(cwd));
  assert(
    common !== host.common && common !== input.owner?.common,
    '同じIssue・Git領域のホストが稼働しています',
  );
}

function processPathReference(command: string, path: string) {
  const literal = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s="'(])${literal}(?=[/\\s"';,)]|$)`).test(command);
}

async function verifyInitialTestProcesses(
  stdout: string,
  input: Parameters<typeof verifyInterruptedProcesses>[1],
) {
  const rows =
    input.entry === '--test-interrupted-run' ? initialProcessRows(stdout) : processRows(stdout);
  const ancestors = processAncestors(rows);
  assert(
    !input.owner || (isAbsolute(input.owner.cwd) && isAbsolute(input.owner.common)),
    'ホスト復帰の対象root・Git領域を照合できません',
  );
  const owner = input.owner ?? {
    entry: input.entry === '--test-run' ? '--test-run' : '--test-interrupted-run',
    previousRun: input.previousRun,
    cwd: join(input.previousRun, 'checkout'),
  };
  const protectedRuns = new Set([
    input.previousRun,
    owner.previousRun,
    ...(input.owner?.previousRuns ?? []),
  ]);
  for (const row of rows) {
    if (row.pid === process.pid) {
      continue;
    }
    const returning =
      ancestors.has(row.pid) &&
      cliArgument(row.command, owner.entry, owner.previousRun) &&
      cliArgument(row.command, '--run-dir', input.runDirectory) &&
      cliArgument(row.command, '--repo', owner.cwd) &&
      !cliArgument(row.command, '--run-dir', owner.previousRun);
    // 付属actorも旧runをargvに含む。兄弟runの名前の前方一致で対応を補わない。
    const live = [...protectedRuns].some((path) => processPathReference(row.command, path));
    assert(
      returning || !live,
      `旧テストまたはホスト停止runの稼働プロセスがあります: PID=${row.pid}`,
    );
    if (!returning) {
      await verifyDevelopmentHost(row.command, input);
    }
  }
}
