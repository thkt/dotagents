import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { runtimeShape } from './actor-runtime.ts';
import { hash, RecordObservation } from './record-observation.ts';
import type { ReviewConfig } from './input.ts';
import { isRecord } from '../shared/values.ts';

const actorShape = z.object({
  recordFormat: z.literal(2),
  invocationId: z.string().min(1),
  role: z.enum(['repair', 'review', 'test']),
  hostPrefix: z.string().nullable(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  sandbox: z.string().min(1),
  ignoreUserConfig: z.boolean(),
  runtime: runtimeShape,
});
type RuntimeRecord = {
  run: string;
  prefix: string | null;
  role: string | null;
  path?: string;
  sha256?: string;
  reason: string | null;
};
async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function actorReason(raw: unknown, role: string | null, name: string) {
  if (!isRecord(raw) || raw.recordFormat !== 2) {
    return 'actor runtimeの非対応形式';
  }
  if (!raw.runtime) {
    return 'actor runtimeが欠落';
  }
  const parsed = actorShape.safeParse(raw);
  if (!parsed.success) {
    return 'actor runtimeまたは設定の非対応形式';
  }
  if (!role) {
    return 'actor工程対応が未確認（hostPrefixなし、または過去工程に対応しません）';
  }
  if (parsed.data.role !== role || !name.startsWith(`${role}-codex-`)) {
    return 'actor工程対応の矛盾・不一致';
  }
  if (parsed.data.sandbox !== (role === 'review' ? 'read-only' : 'workspace-write')) {
    return 'actor工程とsandbox設定の矛盾・不一致';
  }
  return null;
}
export function verifyRuntimeActor(raw: unknown, role: string, name: string) {
  const reason = actorReason(raw, role, name);
  assert(reason === null, `actor runtime原記録の対応を照合できません: ${reason}`);
}

async function actorReference(
  root: string,
  run: string,
  name: string,
  expected: Map<string, string>,
): Promise<RuntimeRecord> {
  const path = join(root, name, 'actor.json');
  try {
    assert(
      (await lstat(join(root, name))).isDirectory() && (await lstat(path)).isFile(),
      '取得不能: 通常ファイルではありません',
    );
    const content = await readFile(path);
    const sha256 = hash(content);
    let raw: unknown;
    try {
      raw = JSON.parse(content.toString('utf8'));
    } catch {
      return {
        run,
        prefix: null,
        role: null,
        path,
        sha256,
        reason: 'actor runtimeの非対応形式（JSON解析不能）',
      };
    }
    const prefix =
      isRecord(raw) && typeof raw.hostPrefix === 'string' ? resolve(root, raw.hostPrefix) : null;
    const role = prefix ? (expected.get(prefix) ?? null) : null;
    return { run, prefix, role, path, sha256, reason: actorReason(raw, role, name) };
  } catch (error) {
    return {
      run,
      prefix: null,
      role: null,
      path,
      reason: `actor runtime取得不能: ${String(error)}`,
    };
  }
}

// run直下とverification直下だけを探す。周辺のrunや作業checkoutへは降りない。
function stageMap(locations: { root: string; listing: Awaited<ReturnType<typeof entries>> }[]) {
  const expected = new Map<string, string>();
  for (const { root, listing } of locations) {
    for (const entry of listing) {
      const match =
        /^(implementation|(?:repair|review|test)-\d+)\.stdout$|^(test-\d+)\.target\.json$/.exec(
          entry.name,
        );
      const name = match?.[1] ?? match?.[2];
      if (entry.isFile() && name) {
        const role = name === 'implementation' ? 'repair' : name.split('-')[0];
        assert(role);
        expected.set(join(root, name), role);
      }
    }
  }
  return expected;
}

async function stages(
  run: string,
  locations: { root: string; listing: Awaited<ReturnType<typeof entries>> }[],
) {
  const expected = stageMap(locations);
  const records: RuntimeRecord[] = [];
  const matched = new Set<string>();
  for (const { root, listing } of locations) {
    for (const entry of listing.filter((entry) =>
      /^(repair|review|test)-codex-/.test(entry.name),
    )) {
      const record = await actorReference(root, run, entry.name, expected);
      records.push(record);
      if (record.prefix && record.role) {
        matched.add(record.prefix);
      }
    }
  }
  const unavailable = records.filter((record) => !record.prefix && record.sha256 === undefined);
  const uncertainty =
    unavailable.length > 0
      ? `付属actor runtime原記録の工程対応を確認できません。工程対応が未確認の取得不能記録があります: ${unavailable.map((record) => record.path).join(', ')}`
      : '付属actor runtime原記録なし（外部actorまたは欠落）';
  for (const [prefix, role] of expected) {
    if (!matched.has(prefix)) {
      records.push({
        run,
        prefix,
        role,
        reason: `${uncertainty}。現在の環境で補完しません`,
      });
    }
  }
  return records;
}

async function collectRun(
  run: string,
  collected: Set<string>,
  listing?: Awaited<ReturnType<typeof entries>>,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<RuntimeRecord[]> {
  assert(!ancestors.has(run), 'actor runtime復帰履歴の循環');
  if (collected.has(run)) {
    return [];
  }
  const lineage = new Set([...ancestors, run]);
  const runListing = listing ?? (await entries(run));
  const verification = join(run, 'verification');
  const records = await stages(run, [
    { root: run, listing: runListing },
    { root: verification, listing: await entries(verification) },
  ]);
  const configuration = join(run, 'verification-config.json');
  if (runListing.some((entry) => entry.name === 'verification-config.json')) {
    const config: unknown = JSON.parse(await readFile(configuration, 'utf8'));
    assert(isRecord(config), 'actor runtime復帰設定の非対応形式');
    for (const input of [
      config.initialTestReturn,
      config.hostReturn,
      config.testInterruption,
      config.humanDecision,
      config.reviewReturn,
      ...(isRecord(config.revision) ? [config.revision.reviewReturn] : []),
    ]) {
      if (isRecord(input) && typeof input.previousRun === 'string') {
        records.push(...(await collectRun(input.previousRun, collected, undefined, lineage)));
      }
    }
  }
  collected.add(run);
  return records;
}

export async function runtimeRecords(config: ReviewConfig) {
  const dir = resolve(config.runDir);
  const parent = dirname(dir);
  const parentListing = basename(dir) === 'verification' ? await entries(parent) : [];
  const isRun = parentListing.some((entry) => entry.name === 'verification-config.json');
  const visited = new Set<string>();
  const records = isRun
    ? await collectRun(parent, visited, parentListing)
    : await stages(dir, [{ root: dir, listing: await entries(dir) }]);
  if (!isRun) {
    for (const input of [
      config.initialTestReturn,
      config.hostReturn,
      config.reviewReturn,
      config.testInterruption,
      config.humanDecision,
      config.revision?.reviewReturn,
    ]) {
      if (input) {
        records.push(...(await collectRun(input.previousRun, visited)));
      }
    }
  }
  return records;
}

async function verifyRuntimeRecords(records: unknown, observation = new RecordObservation()) {
  assert(Array.isArray(records), 'actor runtime参照の非対応形式');
  const paths = new Set<string>();
  for (const ref of records) {
    if (isRecord(ref) && typeof ref.path === 'string' && typeof ref.sha256 === 'string') {
      try {
        const actual = await observation.read(ref.path, true);
        assert(actual.sha256 === ref.sha256, `actor runtime内容hash不一致: ${ref.path}`);
        paths.add(ref.path);
      } catch (error) {
        throw new Error(`actor runtime原記録の変更・取得不能: ${ref.path}: ${String(error)}`);
      }
    }
  }
  return [...paths];
}

export async function verifyReviewedRuntime(
  state: {
    events: { role: string; prefix: string }[];
    active?: { role: string; prefix: string } | null;
  },
  observation = new RecordObservation(),
  current: unknown[] = [],
) {
  const records: unknown[] = [...current];
  const prefixes = new Set(
    state.events.filter((event) => event.role === 'review').map((event) => event.prefix),
  );
  if (state.active?.role === 'review') {
    prefixes.add(state.active.prefix);
  }
  for (const prefix of prefixes) {
    const { content } = await observation.read(`${prefix}.target.json`);
    const target: unknown = JSON.parse(content.toString('utf8'));
    assert(isRecord(target), 'actor runtime評価対象の非対応形式');
    if (target.runtimeRecords !== undefined) {
      assert(Array.isArray(target.runtimeRecords), 'actor runtime参照の非対応形式');
      records.push(...(target.runtimeRecords as unknown[]));
    }
  }
  return verifyRuntimeRecords(records, observation);
}

export async function verifySavedRuntime(
  run: string,
  records: Map<string, string>,
  observation: RecordObservation,
) {
  const content = records.get(join(run, 'verification/state.json'));
  if (content !== undefined) {
    const state = z
      .object({
        events: z.array(z.object({ role: z.string(), prefix: z.string() })),
        active: z.object({ role: z.string(), prefix: z.string() }).nullable().optional(),
      })
      .parse(JSON.parse(content));
    return verifyReviewedRuntime(state, observation);
  }
  return [];
}

export const runtimeInstructions =
  '評価対象のruntimeRecordsから当時のactor.jsonを読み、path・内容hash・run・工程を照合してください。CLIの起動入口とrealpath、対象repoのbaseCommitとハーネスcommit、モデル・推論設定・sandboxを区別してください。nullの観測理由と欠落・取得不能・非対応形式・対応未確認を保持し、現在の環境や自己申告で補わないでください。記録された設定と限定コードhashは完全再現の保証ではありません。要約の提出や参照の到達を受入・評価の正しさと扱わず、限界をassessmentsとhandoffへ残してください。';
