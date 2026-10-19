import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';

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
  const rows = [];
  const pids = new Set<number>();
  for (const line of stdout.split('\n').filter((value) => value.trim())) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        line,
      );
    assert(match, 'プロセス観測にPID・親PID・開始時刻・commandの列がありません');
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    assert(
      Number.isSafeInteger(pid) &&
        pid > 0 &&
        Number.isSafeInteger(parent) &&
        parent >= 0 &&
        pid !== parent &&
        !pids.has(pid),
      'プロセス観測のPID・親PIDが不正または矛盾しています',
    );
    pids.add(pid);
    const started = match[3];
    const command = match[4]?.trim();
    assert(started && command, 'プロセス観測の開始時刻・commandがありません');
    rows.push({ pid, parent, startedAt: processStart(started), command });
  }
  assert(rows.length > 0, 'プロセス一覧が空で照合できません');
  return rows;
}

export async function verifyInterruptedProcesses(
  stdout: string,
  input: { previousRun: string; runDirectory: string; review: string[] },
) {
  const saved = timesShape.parse(
    JSON.parse(await readFile(join(input.previousRun, 'result.json'), 'utf8')),
  );
  const started = Date.parse(saved.startedAt);
  const finished = Date.parse(saved.finishedAt);
  assert(finished >= started, '旧runのプロセス照合期間が不正です');
  const executable = input.review[0];
  assert(executable, '保存された評価コマンドがありません');
  const names = new Set([basename(executable)]);
  if (input.review.some((argument) => argument.endsWith('/codex-actor.ts'))) {
    names.add('codex');
  }
  for (const row of processRows(stdout)) {
    if (row.pid === process.pid) {
      continue;
    }
    // psの開始時刻は秒単位。旧停止後に始まった明示的な新CLIだけを除く。
    const returning =
      row.startedAt >= Math.floor(finished / 1000) * 1000 &&
      cliArgument(row.command, '--interrupted-run', input.previousRun) &&
      cliArgument(row.command, '--run-dir', input.runDirectory) &&
      !cliArgument(row.command, '--run-dir', input.previousRun);
    assert(
      returning ||
        (!row.command.includes(input.previousRun) && !row.command.includes(input.review.join(' '))),
      `旧runまたは旧評価に対応する稼働プロセスがあります: PID=${row.pid}, PPID=${row.parent}, start=${new Date(row.startedAt).toISOString()}`,
    );
    const name = basename((row.command.split(/\s+/)[0] ?? '').replace(/^["']|["']$/g, ''));
    assert(
      returning ||
        !names.has(name) ||
        row.startedAt < Math.floor(started / 1000) * 1000 ||
        row.startedAt > finished,
      `旧実行期間内の同種プロセスを対応付けられません: PID=${row.pid}。追加観測が必要です`,
    );
  }
}

export function cliArgument(argv: string, option: string, path: string) {
  const literal = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${option}(?:=|\\s+)["']?${literal}["']?(?:\\s|$)`).test(argv);
}
