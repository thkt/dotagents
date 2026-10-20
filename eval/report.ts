import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { z } from 'zod';
import { lightConfig } from './light-data.ts';
import { isRecord } from '../scripts/shared/values.ts';
import { addTokenUsage, parseTokenUsage } from '../scripts/shared/token-usage.ts';

const reference = z.strictObject({
  file: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
});
const judgment = z.strictObject({
  trial: z.string().regex(/^(before|after)-[a-z0-9-]+$/),
  selection: z.enum(['scoping', 'implement', 'both', 'none', 'unknown']),
  bodyReads: z.array(reference),
  applications: z.array(reference),
  completeTrace: z.array(reference),
  outcome: z.enum(['fulfilled', 'unfulfilled', 'indeterminate']),
  evidence: z.array(reference),
  reason: z.string().min(1),
});
const judgments = z.strictObject({
  evaluationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  conclusion: z.enum(['improved', 'worsened', 'indeterminate']),
  reason: z.string().min(1),
  nextDecision: z.string().min(1),
  conditionDifferences: z.array(z.string().min(1)),
  trials: z.array(judgment),
});
const trial = z.object({
  trial: z.string().regex(/^(before|after)-[a-z0-9-]+$/),
  side: z.enum(['before', 'after']),
  case: z.string().regex(/^[a-z0-9-]+$/),
  expected: z.enum(['scoping', 'implement', 'none', 'boundary']),
  execution: z.enum(['unevaluated', 'completed', 'failed', 'timeout']),
  launched: z.boolean(),
  launchUnknown: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  elapsedMs: z.number().nullable(),
  executionMode: z.literal('native-chatgpt'),
  safety: z
    .object({
      boundaryVerified: z.boolean().optional(),
      processesStopped: z.boolean().optional(),
    })
    .optional(),
});

export function readUsage(lines: string[]) {
  let totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let completedTurns = 0,
    incompleteLines = 0;
  for (const line of lines.filter(Boolean)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      incompleteLines++;
      continue;
    }
    if (!isRecord(value) || value.type !== 'turn.completed') {
      continue;
    }
    const usage = parseTokenUsage(value.usage);
    const next = usage && addTokenUsage(totals, usage);
    if (!next) {
      incompleteLines++;
      continue;
    }
    totals = next;
    completedTurns++;
  }
  return {
    totals: completedTurns ? totals : null,
    completedTurns,
    incompleteLines,
    scope: 'Parent CLI completed turns only; child totals, billing and missing events unknown',
  };
}

function safeTrial(record: z.infer<typeof trial>) {
  return (
    record.executionMode === 'native-chatgpt' &&
    record.safety?.boundaryVerified &&
    record.safety.processesStopped
  );
}

export function assessTrial(record: z.infer<typeof trial>, assessment?: z.infer<typeof judgment>) {
  if (!assessment) {
    return { selection: 'unknown', outcome: 'indeterminate', correct: null };
  }
  const safe = safeTrial(record);
  assert(
    record.launched && !record.launchUnknown && safe,
    'Unsafe or unevaluated trial cannot be scored',
  );
  if (assessment.selection === 'none') {
    assert(assessment.completeTrace.length > 0, 'Non-selection requires complete trace evidence');
  } else if (assessment.selection !== 'unknown') {
    const count = assessment.selection === 'both' ? 2 : 1;
    assert(
      assessment.bodyReads.length >= count && assessment.applications.length >= count,
      'Selection requires skill body retrieval and application evidence',
    );
  }
  if (assessment.outcome !== 'indeterminate') {
    assert(assessment.evidence.length > 0, 'Outcome evidence required');
  }
  assert(
    assessment.outcome !== 'fulfilled' || record.execution === 'completed',
    'Failed execution cannot be a fulfilled outcome',
  );
  const correct =
    record.expected === 'boundary' || assessment.selection === 'unknown'
      ? null
      : record.expected === assessment.selection;
  return { selection: assessment.selection, outcome: assessment.outcome, correct };
}

function evidenceReader(root: string) {
  const observations = new Map<string, { sha256: string; lines: string[] }>();
  return async (trial: string, file: string) => {
    const path = resolve(root, trial, file);
    let observed = observations.get(path);
    if (!observed) {
      assert((await lstat(path)).isFile(), 'Evidence must be a regular file');
      assert(!relative(root, await realpath(path)).startsWith('..'), 'Evidence escapes run');
      const text = await readFile(path, 'utf8');
      observed = {
        sha256: createHash('sha256').update(text).digest('hex'),
        // 終端改行は次の行を作らない。本文中の空行は証拠行として保つ。
        lines: text === '' ? [] : text.replace(/\n$/, '').split('\n'),
      };
      observations.set(path, observed);
    }
    return observed;
  };
}

async function evidence(
  readEvidence: ReturnType<typeof evidenceReader>,
  item: z.infer<typeof judgment>,
) {
  for (const ref of [
    ...item.bodyReads,
    ...item.applications,
    ...item.completeTrace,
    ...item.evidence,
  ]) {
    const observed = await readEvidence(item.trial, ref.file);
    assert(observed.sha256 === ref.sha256, 'Evidence changed since adjudication');
    assert(
      ref.lines[0] <= ref.lines[1] && ref.lines[1] <= observed.lines.length,
      'Evidence lines missing',
    );
  }
}

function stopReason(record: z.infer<typeof trial>) {
  if (record.launchUnknown) {
    return '起動状態・終了記録が不明（詳細は元記録）';
  }
  if (record.execution === 'timeout') {
    return '時間切れ';
  }
  if (record.execution === 'completed') {
    return '裁定対象';
  }
  if (record.execution === 'failed') {
    return '実行失敗・中断（詳細は元記録）';
  }
  if (record.reason?.includes('authentication')) {
    return 'モデル認証未設定';
  }
  if (record.reason?.includes('versions')) {
    return '実効ツール版の不一致';
  }
  if (record.reason?.includes('cleanup')) {
    return '終了確認失敗';
  }
  return '隔離・入力条件を確認できず起動拒否（詳細は元記録）';
}

async function loadJudgments(
  readEvidence: ReturnType<typeof evidenceReader>,
  raw: string,
  records: z.infer<typeof trial>[],
  assessmentFile?: string,
) {
  const assessment = assessmentFile
    ? judgments.parse(JSON.parse(await readFile(assessmentFile, 'utf8')))
    : undefined;
  if (assessment) {
    assert(
      assessment.evaluationSha256 === createHash('sha256').update(raw).digest('hex'),
      'Judgments refer to another run version',
    );
    assert(
      new Set(assessment.trials.map((item) => item.trial)).size === assessment.trials.length,
      'Duplicate trial judgment',
    );
    for (const item of assessment.trials) {
      assert(
        records.some((record) => record.trial === item.trial),
        'Unknown trial judgment',
      );
      await evidence(readEvidence, item);
    }
  }
  if (assessment && assessment.conclusion !== 'indeterminate') {
    assert(
      assessment.conditionDifferences.length === 0 &&
        assessment.trials.length === records.length &&
        records.length > 0,
      'Incomplete or different conditions cannot support an improvement conclusion',
    );
    assert(
      assessment.trials.every(
        (item) => item.outcome !== 'indeterminate' && item.selection !== 'unknown',
      ),
      'Unknown outcomes require an indeterminate comparison',
    );
    assert(
      records.every((record) => record.execution === 'completed'),
      'Failed runs require an indeterminate comparison',
    );
  }
  return assessment;
}

async function summarizeTrial(
  readEvidence: ReturnType<typeof evidenceReader>,
  record: z.infer<typeof trial>,
  item?: z.infer<typeof judgment>,
) {
  const result = assessTrial(record, item);
  let events: string[] = [];
  try {
    events = (await readEvidence(record.trial, 'actor.stdout')).lines;
  } catch {
    /* Missing logs remain unknown. */
  }
  const usage = readUsage(events);
  const tokens = usage.totals
    ? `${usage.totals.input_tokens} / ${usage.totals.cached_input_tokens} / ${usage.totals.output_tokens}${usage.incompleteLines ? '（記録欠落あり）' : ''}`
    : '未取得';
  const line = `| [${record.case}](${record.trial}/actor.stdout) | ${record.side} | ${result.selection} (${result.correct === null ? '採点外・不明' : result.correct ? '正' : '誤'}) | ${result.outcome} | ${record.execution}; ${stopReason(record)} | ${safeTrial(record) ? '終了確認済み' : '未確認'} | ${record.elapsedMs === null ? '未取得' : (record.elapsedMs / 1000).toFixed(1)} | ${tokens} |`;
  return { ...record, ...result, usage, line, decision: item };
}

async function saveComparison(
  directory: string,
  assessment: z.infer<typeof judgments> | undefined,
  text: string,
) {
  // No silent replacement of previous judgments or reports.
  const hash = assessment
    ? createHash('sha256').update(JSON.stringify(assessment)).digest('hex').slice(0, 12)
    : undefined;
  if (assessment) {
    await writeFile(
      resolve(directory, `judgments-${hash}.json`),
      JSON.stringify(assessment, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
  }
  await writeFile(
    resolve(directory, assessment ? `comparison-${hash}.md` : 'comparison.md'),
    text,
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
}

// 固定段階の全予定行と、同じrunの証拠・裁定を照合する。
export async function writeLightComparison(directory: string, assessmentFile?: string) {
  directory = await realpath(directory);
  const raw = await readFile(resolve(directory, 'evaluation.json'), 'utf8');
  const evaluation = z
    .object({
      executionMode: z.literal('native-chatgpt'),
      config: lightConfig,
      commonContext: z.unknown().optional(),
      records: z.array(trial),
      retries: z.literal(0),
      elapsedMs: z.number().nullable(),
      error: z.string().nullable(),
    })
    .parse(JSON.parse(raw));
  const order = evaluation.config.trialOrder;
  assert(
    order &&
      evaluation.records.length === order.length &&
      evaluation.records.every(
        (record, index) =>
          record.trial === order[index] &&
          record.executionMode === 'native-chatgpt' &&
          record.trial === `${record.side}-${record.case}`,
      ),
    '段階の予定試行と記録が一致しません',
  );
  const readEvidence = evidenceReader(directory);
  const assessment = await loadJudgments(readEvidence, raw, evaluation.records, assessmentFile);
  const lines = [
    '# 軽量比較の結果（公開前に内容を確認）',
    '',
    `対象: ${evaluation.config.issue}。第${evaluation.config.stage}段階。予定${order.length}試行、起動確認${evaluation.records.filter((record) => record.launched).length}試行、起動不明${evaluation.records.filter((record) => record.launchUnknown).length}試行。再試行0。`,
    `変更前: ${evaluation.config.before}。変更後: ${evaluation.config.after}。共通入力: ${evaluation.config.corpusCommit}。モデル: ${evaluation.config.model} / ${evaluation.config.reasoning}。`,
    '認証: 普段の保存済みChatGPT認証。環境: macOSネイティブCLIとpermission profile。過去のAPI/Docker結果とは混合しない。金額・内部要求数・残り枠は未取得であり、0や無料を意味しない。',
    `共通条件: ${evaluation.commonContext ? '既知の登録元の要約をローカルcommon-context.jsonとevaluation.jsonへ記録。' : '要約未取得。'} 固定課題入力とCLIが加える共通コンテキストは別。日常環境の共通条件下の少数比較であり、完全な入力隔離・指示だけの純粋な因果効果は保証しない。`,
    '',
    '| ケース | 条件 | 行動 | 成果 | 実行・理由 | 安全 | 秒 | input / cached / output |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- |',
  ];
  const summaries = [];
  for (const record of evaluation.records) {
    const decision = assessment?.trials.find((item) => item.trial === record.trial);
    const summary = await summarizeTrial(readEvidence, record, decision);
    if (decision?.outcome === 'fulfilled') {
      assert(
        summary.usage.completedTurns > 0 && summary.usage.incompleteLines === 0,
        'JSONL欠落・不正usageを軽量比較の要求充足へ変換できません',
      );
    }
    summaries.push(summary);
    lines.push(summary.line);
    if (decision) {
      lines.push(
        '',
        `${record.trial}: ${decision.reason}`,
        ...[
          ...decision.bodyReads,
          ...decision.applications,
          ...decision.completeTrace,
          ...decision.evidence,
        ].map((ref) => `${record.trial}/${ref.file}:${ref.lines.join('-')} SHA-256 ${ref.sha256}`),
        '',
      );
    }
  }
  for (const side of ['before', 'after']) {
    const rows = summaries.filter((item) => item.side === side);
    lines.push(
      '',
      `${side}: 要求充足${rows.filter((item) => item.outcome === 'fulfilled').length}/${evaluation.config.cases.length}、未充足${rows.filter((item) => item.outcome === 'unfulfilled').length}、判定不能${rows.filter((item) => item.outcome === 'indeterminate').length}。失敗・時間切れ・未実行も分母に含む。`,
    );
  }
  lines.push(
    '',
    `全体実時間（準備・終了処理を含む）: ${evaluation.elapsedMs === null ? '未取得' : `${evaluation.elapsedMs}ms`}。事前準備と手動裁定は別途記録する。`,
    `停止: ${evaluation.error ? 'あり。詳細はローカル原記録を参照。' : 'なし。要求充足は別に裁定する。'}`,
    `結論: ${assessment?.conclusion ?? 'indeterminate'}`,
    assessment?.reason ?? '独立した行動・成果の裁定は未実施。',
    `次の判断: ${assessment?.nextDecision ?? '記録と基準で裁定できるかを確認する。第2段階は別の実行指示が必要。'}`,
    ...(assessment?.conditionDifferences ?? []).map((item) => `条件差: ${item}`),
    '各条件1回の合成課題であり、統計的改善・4件それぞれの独立効果・通常フロー全体・費用や速度の改善は結論にしない。第1段階では#385・#387・#388の効果は未評価。',
    '使用量は親CLIの取得済み完了ターンのみ。子処理・未完了ターン・契約枠消費・請求額は未確認。',
    '採点情報と生ログはhost-only。条件名を伏せる既存の採点手順でも、指示内容から推測できるため完全な盲検ではない。自動投稿せず、公開summaryの共有先と内容は人が確認する。',
  );
  await saveComparison(directory, assessment, `${lines.join('\n')}\n`);
}
