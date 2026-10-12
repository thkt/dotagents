import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { expect } from 'bun:test';
import { isRecord } from '../../shared/values.ts';

// 当時の記録を表す合成値。現在のCLI・ハーネスを観測して期待値を作りません。
export function actorRecord(role: string, hostPrefix: string | null, invocationId: string) {
  return {
    recordFormat: 2,
    invocationId,
    role,
    hostPrefix,
    model: 'fixture-model',
    reasoningEffort: role === 'review' ? 'high' : 'medium',
    sandbox: role === 'review' ? 'read-only' : 'workspace-write',
    ignoreUserConfig: true,
    runtime: {
      cli: {
        entry: { value: '/fixture/bin/codex', reason: null },
        realpath: { value: '/fixture/releases/codex', reason: null },
        version: { value: null, reason: 'fixture version observation timed out' },
      },
      harness: {
        commit: { value: 'a'.repeat(40), reason: null },
        trackedDirty: { value: true, reason: null },
        codeHash: { value: 'b'.repeat(64), reason: null },
        scope:
          'implement/shared direct *.ts + package.json + bun.lock; sorted path/mode/content SHA-256; regular files only',
      },
    },
  };
}

export async function saveActorRecord(root: string, prefix: string, role: string, name: string) {
  const dir = join(root, `${role}-codex-${name}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'actor.json');
  await writeFile(path, JSON.stringify(actorRecord(role, relative(root, prefix), randomUUID())));
  return path;
}

export function references(value: unknown): { path: string; sha256: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap(references);
  }
  if (!isRecord(value)) {
    return [];
  }
  const record = value;
  const found =
    typeof record.path === 'string' && typeof record.sha256 === 'string'
      ? [{ path: record.path, sha256: record.sha256 }]
      : [];
  return [...found, ...Object.values(record).flatMap(references)];
}

export async function expectActorReference(target: unknown, path: string) {
  const content = await readFile(path);
  const sha256 = createHash('sha256').update(content).digest('hex');
  expect(references(target)).toContainEqual({ path, sha256 });
  // hashは同一性の判定。nullの理由や入口/実体などの意味は原記録で保持します。
  const record: unknown = JSON.parse(content.toString('utf8'));
  return record;
}

// 保存された参照の工程対応を確認します。actor.json自身の値だけでは判定しません。
export function expectActorAssociation(
  target: unknown,
  path: string,
  root: string,
  prefix: string,
  role: string,
) {
  const associations = actorAssociations(target);
  const matches = associations.filter((ref) => ref.path === path && typeof ref.sha256 === 'string');
  expect(matches.length).toBeGreaterThan(0);
  // 初回実装の工程名implementationとactorのrole repairは同じ起動に属します。
  const roles = prefix === 'implementation' ? ['implementation', 'repair'] : [role];
  for (const ref of matches) {
    expect(roles).toContain(String(ref.role));
    expect(typeof ref.run).toBe('string');
    expect(resolve(root, String(ref.run))).toBe(root);
    expect(typeof ref.prefix).toBe('string');
    expect(resolve(root, String(ref.prefix))).toBe(join(root, prefix));
    expect(ref.reason).toBeNull();
  }
  // path/hashを持たない欠落参照も、同じrun・工程なら正常な対照と矛盾します。
  for (const ref of associations) {
    if (
      typeof ref.run === 'string' &&
      resolve(root, ref.run) === root &&
      typeof ref.prefix === 'string' &&
      resolve(root, ref.prefix) === join(root, prefix)
    ) {
      expect(roles).toContain(String(ref.role));
      expect(ref.reason).toBeNull();
      expect(typeof ref.path).toBe('string');
      expect(typeof ref.sha256).toBe('string');
    }
  }
}

function actorAssociations(target: unknown) {
  const matches: Record<string, unknown>[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isRecord(value)) {
      if ('role' in value) {
        matches.push(value);
      }
      Object.values(value).forEach(visit);
    }
  }
  visit(target);
  return matches;
}

export function expectActorProblem(target: unknown, path: string, reason: RegExp) {
  const matches = actorAssociations(target).filter(
    (ref) => ref.path === path && typeof ref.sha256 === 'string',
  );
  expect(matches.length).toBeGreaterThan(0);
  for (const ref of matches) {
    expect(typeof ref.reason).toBe('string');
    expect(String(ref.reason)).toMatch(reason);
  }
}

export function expectActorUnavailable(
  target: unknown,
  root: string,
  prefix: string,
  reason: RegExp,
) {
  const matches = actorAssociations(target).filter(
    (ref) =>
      typeof ref.run === 'string' &&
      resolve(root, ref.run) === root &&
      typeof ref.prefix === 'string' &&
      resolve(root, ref.prefix) === join(root, prefix),
  );
  expect(matches.length).toBeGreaterThan(0);
  for (const ref of matches) {
    expect(['implementation', 'repair']).toContain(String(ref.role));
    expect(typeof ref.reason).toBe('string');
    expect(String(ref.reason)).toMatch(reason);
    // 読めない・存在しない内容に同一性の成功を与えません。
    expect(ref.sha256 ?? null).toBeNull();
  }
}
