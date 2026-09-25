import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { z } from 'zod';
import { evalConfig } from './data.ts';
import { isRecord } from '../values.ts';

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
  reason: z.string().optional(),
  requests: z
    .object({
      requests: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      failed: z.boolean(),
    })
    .nullable()
    .optional(),
  elapsedMs: z.number().nullable(),
  safety: z.object({ containersRemoved: z.boolean(), networkRemoved: z.boolean() }).optional(),
});

export function readUsage(lines: string[]) {
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
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
    const usage = value.usage;
    if (
      !isRecord(usage) ||
      !Object.keys(totals).every(
        (key) =>
          typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && usage[key] >= 0,
      )
    ) {
      incompleteLines++;
      continue;
    }
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) {
      const count = usage[key];
      if (typeof count === 'number') {
        totals[key] += count;
      }
    }
    completedTurns++;
  }
  return {
    totals: completedTurns ? totals : null,
    completedTurns,
    incompleteLines,
    scope: 'Parent CLI completed turns only; child totals, billing and missing events unknown',
  };
}

export function assessTrial(record: z.infer<typeof trial>, assessment?: z.infer<typeof judgment>) {
  if (!assessment) {
    return { selection: 'unknown', outcome: 'indeterminate', correct: null };
  }
  const safe = record.safety?.containersRemoved && record.safety.networkRemoved;
  assert(record.launched && safe, 'Unsafe or unevaluated trial cannot be scored');
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
        lines: text.split('\n'),
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
  if (record.execution === 'timeout') {
    return '時間切れ';
  }
  if (record.execution === 'completed') {
    return '裁定対象';
  }
  if (record.execution === 'failed') {
    return '実行失敗・中断（詳細は元記録）';
  }
  if (record.reason?.includes('budget')) {
    return '時間上限';
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
  const line = `| [${record.case}](${record.trial}/actor.stdout) | ${record.side} | ${result.selection} (${result.correct === null ? '採点外・不明' : result.correct ? '正' : '誤'}) | ${result.outcome} | ${record.execution}; ${stopReason(record)} | ${record.safety?.containersRemoved && record.safety.networkRemoved ? '終了確認済み' : '未確認'} | ${record.elapsedMs === null ? '未取得' : (record.elapsedMs / 1000).toFixed(1)} | ${tokens} |`;
  return { ...record, ...result, usage, line, decision: item };
}

export async function writeComparison(directory: string, assessmentFile?: string) {
  directory = await realpath(directory);
  const raw = await readFile(resolve(directory, 'evaluation.json'), 'utf8');
  const evaluation = z
    .object({
      config: evalConfig,
      records: z.array(trial),
      retries: z.literal(0),
      elapsedMs: z.number(),
      error: z.string().nullable(),
    })
    .parse(JSON.parse(raw));
  const readEvidence = evidenceReader(directory);
  const assessment = await loadJudgments(readEvidence, raw, evaluation.records, assessmentFile);
  const expectedTrials = evaluation.config.cases.flatMap((id) => [`before-${id}`, `after-${id}`]);
  assert(
    new Set(evaluation.records.map((record) => record.trial)).size === evaluation.records.length,
    'Duplicate saved trial',
  );
  assert(
    evaluation.records.every(
      (record) =>
        record.trial === `${record.side}-${record.case}` && expectedTrials.includes(record.trial),
    ),
    'Trial does not match the plan',
  );
  if (assessment && assessment.conclusion !== 'indeterminate') {
    assert(
      !evaluation.error &&
        evaluation.records.length === expectedTrials.length &&
        evaluation.records.length === evaluation.config.maxTrials,
      'Missing planned pairs require an indeterminate comparison',
    );
  }
  const lines = [
    '# 指示変更の比較（公開前に内容を確認）',
    `予定${evaluation.config.maxTrials}試行 / 記録${evaluation.records.length}試行。計画・実行全体: ${evaluation.error ? '停止・不成立（詳細はローカルevaluation.json）' : '記録済み、成果判定は別欄'}。`,
    '',
    `対象: ${evaluation.config.issue}`,
    '',
    `変更前: [${evaluation.config.before}](https://github.com/thkt/dotagents/commit/${evaluation.config.before}) / 変更後: [${evaluation.config.after}](https://github.com/thkt/dotagents/commit/${evaluation.config.after})`,
    `ケース版: ${evaluation.config.corpusCommit} / 共通課題版: ${evaluation.config.workspaceCommit}`,
    `モデル: ${evaluation.config.model} / ${evaluation.config.reasoning}; CLI: ${evaluation.config.cliVersion}; image: ${evaluation.config.image}`,
    '',
    '同条件: ケース集合・課題・モデル・設定・コンテナー・ツール。指示ファイルだけを前後のcommitから配置。実ファイルの版・変更した指示はローカル plan.json、実効ツール版・停止理由は evaluation.json。',
    '本比較と#183のmacOS登録環境は異なる。GitHub・外部依存へのアクセスは遮断。単回差・ケース変更を改善率に換算しない。',
    '',
    '| ケース | 条件 | 選択（正誤） | 成果 | 実行・理由 | 安全 | 秒 | input / cached / output |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- |',
  ];
  const summaries = [];
  for (const record of evaluation.records) {
    const item = assessment?.trials.find((item) => item.trial === record.trial);
    const summary = await summarizeTrial(readEvidence, record, item);
    lines.push(summary.line);
    summaries.push(summary);
  }
  for (const summary of summaries) {
    const decision = summary.decision;
    const references = decision
      ? [
          ...decision.bodyReads,
          ...decision.applications,
          ...decision.completeTrace,
          ...decision.evidence,
        ]
      : [];
    const refs = references.map(
      (ref) => `${summary.trial}/${ref.file}:${ref.lines.join('-')} (SHA-256 ${ref.sha256})`,
    );
    lines.push(
      '',
      `${summary.trial}: ${summary.decision?.reason ?? '行動と成果の独立判定は未実施。'} 中継の取得済み要求数: ${summary.requests?.requests ?? '未取得'}。`,
      ...refs,
    );
  }
  for (const side of ['before', 'after']) {
    const rows = summaries.filter((row) => row.side === side);
    const scored = rows.filter((row) => row.correct !== null);
    const denominator = rows.filter((row) => row.expected !== 'boundary').length;
    const misses = scored.filter(
      (row) =>
        ['scoping', 'implement'].includes(row.expected) &&
        row.selection !== row.expected &&
        row.selection !== 'both',
    ).length;
    const falseActivations = scored.filter(
      (row) =>
        row.selection === 'both' ||
        (row.expected === 'none' && row.selection !== 'none') ||
        (['scoping', 'implement'].includes(row.expected) &&
          ['scoping', 'implement'].includes(row.selection) &&
          row.selection !== row.expected),
    ).length;
    const missing = evaluation.config.cases.length - rows.length;
    lines.push(
      '',
      `${side}: 記録欠落${missing}（未評価、選択分母の構成は未確認）。 予定${evaluation.config.cases.length}試行、記録${rows.length}、起動${rows.filter((row) => row.launched).length}、実行失敗・時間切れ${rows.filter((row) => ['failed', 'timeout'].includes(row.execution)).length}、未評価${rows.filter((row) => row.execution === 'unevaluated').length}。選択は採点可能${scored.length}/${denominator}（境界${rows.length - denominator}を除く）、正${scored.filter((row) => row.correct).length}、選択漏れ${misses}、誤発動${falseActivations}（採点可能な行だけ）。要求充足${rows.filter((row) => row.outcome === 'fulfilled').length}/${evaluation.config.cases.length}、未充足${rows.filter((row) => row.outcome === 'unfulfilled').length}、判定不能${rows.filter((row) => row.outcome === 'indeterminate').length}。`,
    );
  }
  lines.push(
    '',
    `全体実時間（準備・終了処理を含む）: ${(evaluation.elapsedMs / 1000).toFixed(1)}秒。再試行0。各行も準備・隔離検査・モデル・終了処理を含む実時間。使用量は親CLIの取得済み完了ターンのみ。子モデル・未完了ターン・請求額は未確認、cachedはinputの内数。採点の時間・使用量は別途記録する。`,
    '',
    `結論: ${assessment?.conclusion ?? 'indeterminate'}`,
    assessment?.reason ?? '独立した行動・成果の判定が未実施。',
    `次の判断: ${assessment?.nextDecision ?? '同じ試行の本文取得・用途に沿う行動・成果・安全記録を照合する。採用・マージは人が判断する。'}`,
    ...(assessment?.conditionDifferences ?? []).map((difference) => `条件差: ${difference}`),
    '',
    '元記録（ローカル限定）: plan.json、evaluation.json、各行の before/after-ケースID/actor.stdout・actor.stderr・probe.stdout・safety.json。裁定は同じ試行のファイルhashと行を参照する。通常implementの記録が別に存在する場合のみ、そのrunのreport.htmlへリンクする。選択evalをresult.jsonへ変換しない。',
    '公開時はこの表・結論と公開可能な根拠への参照だけを既存Issue/PRへ転記する。ローカルの生ログ・個人パス・認証情報・コンテナー成果物を添付しない。公開可能な根拠の保存先がなければ、共有範囲を決めてからリンクを用意する。',
  );
  await saveComparison(directory, assessment, lines.join('\n') + '\n');
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
