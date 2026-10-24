import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isRecord } from '../shared/values.ts';

async function optional(path: string) {
  return readFile(path, 'utf8').catch((error: unknown) => {
    assert(
      isRecord(error) && ['ENOENT', 'ENOTDIR'].includes(String(error.code)),
      '復帰履歴を照合できません',
    );
    return undefined;
  });
}

async function containsAncestor(
  run: string,
  selected: string,
  ancestors = new Set<string>(),
): Promise<boolean> {
  assert(!ancestors.has(run), '復帰履歴が循環しています');
  if (run === selected) {
    return true;
  }
  const content = await optional(join(run, 'verification-config.json'));
  assert(content, '復帰履歴の設定原文が欠落しています');
  const config: unknown = JSON.parse(content);
  assert(isRecord(config), '復帰履歴の設定が不正です');
  const lineage = new Set([...ancestors, run]);
  for (const entry of [config.hostReturn, config.reviewReturn, config.humanDecision]) {
    if (entry !== undefined) {
      assert(
        isRecord(entry) && typeof entry.previousRun === 'string' && isAbsolute(entry.previousRun),
        '復帰履歴の対象が不正です',
      );
      if (await containsAncestor(await realpath(entry.previousRun), selected, lineage)) {
        return true;
      }
    }
  }
  return false;
}

// 独立テストの判断待ちを、古い正式停止や通常起動へ読み替える入口も塞ぐ。
export async function rejectDecisionBypass(
  cwd: string,
  selectedRun?: string,
  runDirectory?: string,
) {
  const selected = selectedRun ? await realpath(selectedRun) : undefined;
  const parents = await recoveryParents(cwd, selected, runDirectory);
  for (const parent of parents) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const run = join(parent, entry.name);
      if (run === selected || run === runDirectory) {
        continue;
      }
      await rejectPendingAncestor(run, cwd, selected);
    }
  }
}

async function rejectPendingAncestor(run: string, cwd: string, selected?: string) {
  const content = await optional(join(run, 'result.json'));
  if (content) {
    const result: unknown = JSON.parse(content);
    if (
      isRecord(result) &&
      result.checkout === cwd &&
      result.reasonCode === 'human_decision_required' &&
      result.operation === 'independent test authoring'
    ) {
      assert(
        selected && !(await containsAncestor(run, selected)),
        '直近の独立テスト判断待ちを指定してください。通常起動や古い祖先・別入口から迂回できません',
      );
    }
  }
}

async function recoveryParents(cwd: string, selected?: string, runDirectory?: string) {
  const parents = new Set<string>();
  const owner = await optional(join(dirname(cwd), 'result.json'));
  if (owner) {
    const result: unknown = JSON.parse(owner);
    if (isRecord(result) && result.checkout === cwd) {
      parents.add(dirname(dirname(cwd)));
    }
  }
  if (selected) {
    parents.add(dirname(selected));
  }
  if (runDirectory) {
    parents.add(dirname(runDirectory));
  }
  return parents;
}
