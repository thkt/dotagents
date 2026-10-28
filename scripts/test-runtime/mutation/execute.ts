import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  copyFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { command } from '../../shared/process.ts';
import { applyMutant } from './mutants.ts';
import type { Mutant, Plan, Selection } from './mutants.ts';

type Tier = 'quality';
type RunResult = { passed: boolean; ms: number; timedOut: boolean };
type Run = (tier: Tier, timeoutMs: number | null) => Promise<RunResult>;
type Status = 'killed' | 'survived' | 'unstable';
type Outcome = { mutant: Mutant; status: Status };
export type Execution = {
  outcomes: Outcome[];
};
// 基準の品質テストが3回とも成功しない環境では、検出と生き残りを区別できない。
const baselineFailedExitCode = 3;
const baselineRuns = 3;

// 追跡中と未追跡（ignore以外）のファイルを一意の一時ディレクトリへ写し、実checkoutは読むだけにする。
export async function createCopy(repo: string) {
  const listed = await command(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    repo,
    '',
    60000,
  );
  assert(listed.code === 0 && !listed.timedOut, `git ls-files failed: ${listed.stderr}`);
  const copy = await mkdtemp(join(tmpdir(), 'mutate-diff-'));
  try {
    for (const file of new Set(listed.stdout.split('\0').filter(Boolean))) {
      await copyEntry(repo, copy, file);
    }
    if (existsSync(join(repo, 'node_modules')) && !existsSync(join(copy, 'node_modules'))) {
      await symlink(join(repo, 'node_modules'), join(copy, 'node_modules'));
    }
    return copy;
  } catch (error) {
    // 途中まで写した一時ディレクトリを残さない。
    await rm(copy, { recursive: true, force: true });
    throw error;
  }
}

// 通常ファイルとsymlinkだけを写す。作業ツリーで削除済みの追跡ファイルと、
// 未追跡の入れ子のrepoなどのディレクトリ（末尾が/の項目）は写さない。
async function copyEntry(repo: string, copy: string, file: string) {
  const source = join(repo, file);
  const stat = await lstat(source).catch(() => undefined);
  if (!stat || !(stat.isFile() || stat.isSymbolicLink())) {
    return;
  }
  await mkdir(dirname(join(copy, file)), { recursive: true });
  if (stat.isSymbolicLink()) {
    await symlink(await readlink(source), join(copy, file));
  } else {
    await copyFile(source, join(copy, file));
  }
}

// 変異で判定を変えられないよう、一時コピーではなくこのハーネスのrunner.tsで判定する。
export function runnerRun(copy: string): Run {
  const runner = resolve(import.meta.dir, '../runner.ts');
  return async (tier, timeoutMs) => {
    const result = await command(
      [process.execPath, runner, 'bun', `scripts/tests/${tier}`, '--parallel=2'],
      copy,
      '',
      timeoutMs,
    );
    return {
      passed: result.code === 0 && !result.timedOut,
      ms: result.ms,
      timedOut: result.timedOut,
    };
  };
}

// 対象repoのlintと型検査（このrepoではoxlintとbun --check）を一時コピーで実行する。
async function staticChecksPass(copy: string) {
  for (const script of ['lint', 'typecheck']) {
    const result = await command([process.execPath, 'run', script], copy, '', 300000);
    if (result.code !== 0 || result.timedOut) {
      return false;
    }
  }
  return true;
}

// 変異前のコピーが通ることを確かめてから、変異ごとの検査関数を返す。
export async function staticChecks(copy: string) {
  assert(await staticChecksPass(copy), '変異前の一時コピーでlintか型検査が失敗しました');
  return (mutant: Mutant) => withMutant(copy, mutant, () => staticChecksPass(copy));
}

// 失敗は再実行でも失敗した場合だけ検出とし、再実行で成功した場合は不安定として分ける。
async function judge(run: Run, tier: Tier, timeoutMs: number): Promise<Status> {
  if ((await run(tier, timeoutMs)).passed) {
    return 'survived';
  }
  return (await run(tier, timeoutMs)).passed ? 'unstable' : 'killed';
}

async function withMutant<T>(copy: string, mutant: Mutant, action: () => Promise<T>) {
  const path = join(copy, mutant.file);
  const source = await readFile(path, 'utf8');
  await writeFile(path, applyMutant(source, mutant));
  try {
    return await action();
  } finally {
    await writeFile(path, source);
  }
}

// 変異で無限ループになった実行を止める上限。基準の最長時間に余裕を足す。
const limit = (runs: RunResult[]) => Math.max(...runs.map((run) => run.ms)) * 3 + 30000;

export async function executeMutation(input: {
  copy: string;
  run: Run;
  select: () => Promise<Selection>;
  log?: (message: string) => void;
}): Promise<
  | { exitCode: typeof baselineFailedExitCode; baseline: RunResult[] }
  | { exitCode: 0; selection: Selection; execution: Execution }
> {
  const log = input.log ?? (() => {});
  const baseline: RunResult[] = [];
  while (baseline.length < baselineRuns) {
    const result = await input.run('quality', null);
    baseline.push(result);
    log(`基準の品質テスト ${baseline.length}/${baselineRuns}: ${result.passed ? '成功' : '失敗'}`);
    if (!result.passed) {
      return { exitCode: baselineFailedExitCode, baseline };
    }
  }
  const selection = await input.select();
  const outcomes: Outcome[] = [];
  for (const [index, mutant] of selection.selected.entries()) {
    const status = await withMutant(input.copy, mutant, () =>
      judge(input.run, 'quality', limit(baseline)),
    );
    log(`変異 ${index + 1}/${selection.selected.length} ${mutant.id}: ${status}`);
    outcomes.push({ mutant, status });
  }
  const execution: Execution = { outcomes };
  return { exitCode: 0, selection, execution };
}

const counts = (record: Record<string, number>) =>
  Object.entries(record)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => `${key} ${count}`)
    .join(', ');

// 複数行にわたる式は1行に詰め、長い式は末尾を省略して表示する。
function snippet(code: string) {
  const line = code.replace(/\s+/g, ' ');
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

const describe = (mutant: Mutant) =>
  `  - ${mutant.id}: ${snippet(mutant.original)} -> ${snippet(mutant.replacement)}`;

function list(title: string, items: string[]) {
  return items.length ? [`${title}:`, ...items] : [];
}

function executionLines(execution: Execution | undefined) {
  if (!execution) {
    return ['変異の実行: 未実行'];
  }
  const of = (status: Status) =>
    execution.outcomes.filter((outcome) => outcome.status === status).map((o) => o.mutant);
  const lines = [
    `変異の実行: 検出 ${of('killed').length} / 生き残り ${of('survived').length} / 不安定 ${of('unstable').length}（実行 ${execution.outcomes.length} 件）`,
  ];
  if (execution.outcomes.length === 0) {
    lines.push(
      '実行した変異は0件です。生き残り0件を、変更が検出できるという結果として読まないでください。',
    );
  }
  lines.push(...list('生き残った変異', of('survived').map(describe)));
  lines.push(...list('不安定（初回失敗・再実行で成功）', of('unstable').map(describe)));
  return lines;
}

const reasonLabels = {
  'deleted-only': '削除行だけ',
  'deleted-lines': '削除した行（変異を作れないため、消したコードを確認する）',
  'moved-only': '移動・整形だけ',
  'no-operator': '変異の演算子を当てられる箇所なし',
  discarded: '全候補をlint・型検査で破棄',
  cap: '上限で変異しなかった',
};

export function formatReport(plan: Plan, selection: Selection, execution: Execution | undefined) {
  const { discarded } = selection;
  const unmade = [...plan.unmutable, ...selection.unmutated];
  const lines = [
    '差分変異の報告',
    ...(plan.mutants.length + plan.unmutable.length === 0
      ? ['変異の対象（scripts/の製品コードとscripts/tests/runner.ts）に変更行がありません。']
      : []),
    ...executionLines(execution),
    `破棄（lint・型検査で失敗）: ${discarded.total}`,
    ...(discarded.total
      ? [`  演算子別: ${counts(discarded.byOperator)}`, `  ファイル別: ${counts(discarded.byFile)}`]
      : []),
    ...list(
      '変異を作れなかった差分',
      Object.entries(reasonLabels).flatMap(([reason, label]) => {
        const hunks = unmade.filter((item) => item.reason === reason).map((item) => item.hunk);
        return hunks.length ? [`  ${label}: ${hunks.join(', ')}`] : [];
      }),
    ),
  ];
  if (selection.skippedCandidates) {
    lines.push(`上限のため検査しなかった変異候補: ${selection.skippedCandidates}`);
  }
  lines.push(`移動・整形として除いた追加行: ${plan.movedLines}`);
  lines.push(`変異の対象外のファイル: ${plan.ignoredFiles.length}`);
  return `${lines.join('\n')}\n`;
}
