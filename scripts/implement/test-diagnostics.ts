import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { parseReview } from './review.ts';
import type { Review } from './review.ts';
import type { State } from './input.ts';
import { isRecord } from '../shared/values.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const targetShape = z
  .object({
    targetId: z.string(),
    source: z.string(),
    issue: z.object({ hash: z.string(), content: z.string() }),
    files: z.array(z.tuple([z.string(), z.number(), z.string()])),
    tests: z.array(z.object({ files: z.record(z.string(), z.string()) })),
  })
  .passthrough();

export type TestDiagnostic = {
  id: string;
  introducedIn: string;
  evaluatedIn: string;
  source: string;
  location: { path: string; line: number | null };
  evaluatedFile: [string, number, string] | null;
  protectedBy: string;
  condition: string;
  evidence: string;
  requirement: { issueHash: string; basis: string };
};

// 全文はホストで照合するだけにし、テスト入力には診断に必要な部分だけを渡します。
async function verifiedReviews(state: State) {
  const events = state.events.filter((event) => event.role === 'review');
  assert(events.length === state.reviewHistory.length, '評価診断の履歴が一致しません');
  let previous: Review | undefined;
  let latest: z.infer<typeof targetShape> | undefined;
  for (const [index, expected] of state.reviewHistory.entries()) {
    const event = events[index];
    assert(event && event.code === 0 && !event.timedOut, '評価診断の実行が不正です');
    const raw: unknown = JSON.parse(await readFile(`${event.prefix}.target.json`, 'utf8'));
    const target = targetShape.parse(raw);
    assert(isRecord(raw), '評価対象の形式が不正です');
    const { targetId, ...content } = raw;
    assert(targetId === hash(JSON.stringify(content)), '評価対象のhashが一致しません');
    assert(target.source === event.source, '評価対象の版が一致しません');
    assert(
      hash(JSON.stringify(target.files)) === target.source,
      '評価対象manifestのhashが一致しません',
    );
    assert(
      hash(target.issue.content) === target.issue.hash && target.issue.hash === state.issueHash,
      '評価診断の要求が一致しません',
    );
    const saved = z
      .object({ target: z.string(), review: z.unknown() })
      .parse(JSON.parse(await readFile(`${event.prefix}.json`, 'utf8')));
    assert(saved.target === `${event.prefix}.target.json`, '評価対象の参照が一致しません');
    const reconstructed = parseReview(
      await readFile(`${event.prefix}.stdout`, 'utf8'),
      target.targetId,
      index + 1,
      previous,
    );
    assert.deepStrictEqual(saved.review, reconstructed, '評価指摘の由来・保存内容が一致しません');
    assert.deepStrictEqual(expected, reconstructed, '評価診断の履歴が変更されました');
    previous = reconstructed;
    latest = target;
  }
  return { review: previous, target: latest };
}

function protection(path: string | null, protectedFiles: Record<string, string>) {
  if (!path) {
    return null;
  }
  if (path in protectedFiles) {
    return '独立テスト成果物・接続定義';
  }
  return /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/)|\.(?:test|spec)\./.test(path)
    ? '既存テスト・fixture'
    : null;
}

export async function testDiagnostics(
  state: State,
  observeFiles: () => Promise<[string, number, string][]>,
  prefix: string,
) {
  const { review, target } = await verifiedReviews(state);
  if (!review || !target) {
    await writeFile(`${prefix}.routing.json`, JSON.stringify({ targetId: null, routing: [] }), {
      flag: 'wx',
    });
    return [];
  }
  const fresh = target.source === state.source;
  if (fresh) {
    assert.deepStrictEqual(
      target.files,
      await observeFiles(),
      '評価対象のテスト・内容・権限が一致しません',
    );
  }
  const protectedFiles = Object.fromEntries(
    target.tests.flatMap((record) => Object.entries(record.files)),
  );
  const diagnostics: TestDiagnostic[] = [];
  const routing = [];
  for (const item of review.items.filter((finding) => finding.disposition === 'open')) {
    const path = item.location.path;
    const protectedBy = protection(path, protectedFiles);
    const file = target.files.find(([name]) => name === path);
    if (fresh && path && protectedBy && (file || path in protectedFiles)) {
      diagnostics.push({
        id: item.id,
        introducedIn: item.introducedIn,
        evaluatedIn: review.targetId,
        source: target.source,
        location: { path, line: item.location.line },
        evaluatedFile: file ?? null,
        protectedBy,
        condition: item.condition,
        evidence: item.evidence,
        requirement: {
          issueHash: target.issue.hash,
          basis:
            '固定Issue・仕様へテスト担当が対応と適用性を照合する。診断は期待値や修正案の正本ではない。',
        },
      });
    } else if (item.required) {
      routing.push({
        id: item.id,
        evaluatedIn: review.targetId,
        route: 'repair',
        reason: !fresh
          ? '評価後に対象版が変わったため診断は渡さず、通常修正と次の独立評価で再照合する。'
          : '保護対象との対応を確認できないためテスト診断に混入させず、通常修正で対応を調べ、必要なら既存のホスト・人への引き継ぎへ戻す。',
      });
    }
  }
  await writeFile(
    `${prefix}.routing.json`,
    JSON.stringify({ targetId: review.targetId, routing }, null, 2),
    { flag: 'wx' },
  );
  return diagnostics;
}
