import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { command, withInterrupts } from '../../shared/process.ts';
import { planMutants, readChanges, selectMutants } from './mutants.ts';
import { createCopy, executeMutation, formatReport, runnerRun, staticChecks } from './execute.ts';

const usage = 'Usage: bun scripts/test-runtime/mutation/cli.ts [--base REF] [--max N] [--quality]';
const usageExitCode = 2;

async function git(cwd: string, ...args: string[]) {
  const result = await command(['git', ...args], cwd, '', 60000);
  assert(result.code === 0 && !result.timedOut, `git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function options() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'main' },
      max: { type: 'string', default: '30' },
      quality: { type: 'boolean', default: false },
    },
  });
  assert(/^[1-9]\d*$/.test(values.max), '--max must be a positive integer');
  return { base: values.base, max: Number(values.max), quality: values.quality };
}

async function main() {
  const started = performance.now();
  let parsed: ReturnType<typeof options>;
  try {
    parsed = options();
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return usageExitCode;
  }
  if (parsed.quality) {
    console.error('--qualityは互換指定です。品質全件を通常実行するため、追加の追試はしません。');
  }
  const repo = await git(process.cwd(), 'rev-parse', '--show-toplevel');
  const base = await git(repo, 'merge-base', parsed.base, 'HEAD');
  const plan = planMutants(await readChanges(repo, base));
  let copy: string | undefined;
  try {
    copy = await createCopy(repo);
    const result = await executeMutation({
      copy,
      run: runnerRun(copy),
      select: async () => selectMutants(plan, parsed.max, await staticChecks(copy ?? '')),
      log: (message) => console.error(message),
    });
    if (result.exitCode !== 0) {
      console.error(
        `基準の品質テストが${result.baseline.length}回目に失敗しました。検出と生き残りを区別できないため、変異の報告は出しません。`,
      );
      return result.exitCode;
    }
    process.stdout.write(formatReport(plan, result.selection, result.execution));
    console.log(`基準commit: ${base}`);
    console.log(`所要時間: ${((performance.now() - started) / 1000).toFixed(1)}秒`);
    return 0;
  } finally {
    if (copy) {
      await rm(copy, { recursive: true, force: true });
    }
  }
}

// SIGINT・SIGTERMで子のプロセスグループを止め、finallyで一時コピーを消してから終わる。
export async function runCli() {
  try {
    process.exitCode = await withInterrupts(main);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runCli();
}
