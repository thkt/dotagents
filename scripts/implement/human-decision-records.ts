import assert from 'node:assert/strict';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { hash } from './record-observation.ts';
import { humanDecisionShape } from './human-decision-schema.ts';
import type { HumanDecision, preservedShape } from './human-decision-schema.ts';
import { formalDependencyLocks } from './dependency-locks.ts';
import { observeSupplement, verifySupplement } from './supplement.ts';

// 呼出元が一回の照合境界だけ所有し、各入力の期待値との比較は共有しない。
export class DecisionObservation {
  private readonly trees = new Map<string, ReturnType<typeof preserveDecisionRecords>>();
  private readonly supplements = new Map<string, ReturnType<typeof observeSupplement>>();

  records(roots: string[], cwd: string) {
    const key = JSON.stringify([cwd, roots]);
    let actual = this.trees.get(key);
    if (!actual) {
      actual = preserveDecisionRecords(roots, cwd);
      this.trees.set(key, actual);
    }
    return actual;
  }

  supplement(path: string) {
    let actual = this.supplements.get(path);
    if (!actual) {
      actual = observeSupplement(path);
      this.supplements.set(path, actual);
    }
    return actual;
  }
}

export async function preserveDecisionRecords(roots: string[], cwd: string, excludeSeal = false) {
  const found = new Map<string, (typeof preservedShape)['_output'][number]>();
  async function visit(path: string): Promise<void> {
    if (path === cwd || found.has(path)) {
      return;
    }
    const info = await lstat(path);
    const kind = recordKind(info);
    assert(
      info.isFile() || info.isDirectory() || info.isSymbolicLink(),
      `原記録の種別が不正です: ${path}`,
    );
    const value = await recordValue(path, kind);
    found.set(path, { path, mode: info.mode, kind, value });
    if (kind === 'directory') {
      for (const name of (await readdir(path)).sort()) {
        if (!excludeSeal || name !== 'human-decision-stop.json') {
          await visit(join(path, name));
        }
      }
    }
  }
  for (const root of roots) {
    await visit(root);
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function recordKind(info: Awaited<ReturnType<typeof lstat>>) {
  if (info.isSymbolicLink()) {
    return 'symlink';
  }
  return info.isDirectory() ? 'directory' : 'file';
}
async function recordValue(path: string, kind: string) {
  if (kind === 'symlink') {
    return readlink(path);
  }
  return kind === 'file' ? hash(await readFile(path)) : '';
}

export async function verifyDecisionContents(
  input: HumanDecision,
  cwd: string,
  observation = new DecisionObservation(),
) {
  humanDecisionShape.parse(input);
  assert(input.roots.includes(input.previousRun), '判断待ち原記録の保全範囲が不足しています');
  await verifySupplement(input.supplement, await observation.supplement(input.supplement.path));
  const actual = await observation.records(input.roots, cwd);
  const paths = actual.map((record) => record.path);
  const dependencies = new Set(
    (await Promise.all(input.roots.map((root) => formalDependencyLocks(root, paths)))).flatMap(
      (locks) => [...locks],
    ),
  );
  for (const record of actual) {
    const name = basename(record.path);
    const dependency = record.kind === 'file' && dependencies.has(record.path);
    assert(
      dependency || (name !== 'lock' && !name.endsWith('.lock')),
      `判断待ちrunにlockが残っています: ${record.path}`,
    );
  }
  assert(
    JSON.stringify(actual) === JSON.stringify(input.records),
    '判断待ちの原記録・mode・symlink・内容が変更されました',
  );
}
