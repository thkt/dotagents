import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { z } from 'zod';
import { evalConfig, type EvalConfig } from './data.ts';
import { budgetSnapshot } from './budget.ts';
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
  requests: z
    .object({
      requests: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      failed: z.boolean(),
    })
    .nullable()
    .optional(),
  elapsedMs: z.number().nullable(),
  executionMode: z.enum(['native-chatgpt', 'api-docker']).optional(),
  safety: z
    .object({
      containersRemoved: z.boolean().optional(),
      networkRemoved: z.boolean().optional(),
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
  return record.executionMode === 'native-chatgpt'
    ? record.safety?.boundaryVerified && record.safety.processesStopped
    : record.safety?.containersRemoved && record.safety.networkRemoved;
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
  const line = `| [${record.case}](${record.trial}/actor.stdout) | ${record.side} | ${result.selection} (${result.correct === null ? '採点外・不明' : result.correct ? '正' : '誤'}) | ${result.outcome} | ${record.execution}; ${stopReason(record)} | ${safeTrial(record) ? '終了確認済み' : '未確認'} | ${record.elapsedMs === null ? '未取得' : (record.elapsedMs / 1000).toFixed(1)} | ${tokens} |`;
  return { ...record, ...result, usage, line, decision: item };
}

async function moneySummary(directory: string, config: EvalConfig) {
  if (!config.budget) {
    return [];
  }
  const state = z
    .object({
      snapshot: budgetSnapshot,
      held: z.number().int().nonnegative(),
      error: z.string().nullable(),
    })
    .parse(JSON.parse(await readFile(resolve(directory, 'budget.json'), 'utf8')));
  const usd = (n: number) => `$${(n / 10_000_000).toFixed(7)}`;
  return [
    '',
    `金額条件（USD・税抜token利用料）: 予算$600 / 停止$500 / 通知$400。profile: ${config.budget.profile} / SHA-256 ${config.budget.profileHash}。`,
    `ホスト回収済み台帳: 精算${usd(state.snapshot.settled)} / 返却不能${usd(state.snapshot.unrecoverable)} / 要求予約${usd(state.snapshot.reserved)}。未回収委譲枠${usd(state.held)}は別枠の保留で、要求予約と二重加算しない。`,
    `通知: ${state.snapshot.notified ? '発行済み' : '回収済み台帳では未発行（未回収時は原記録を確認）'}。金額停止・受渡し異常: ${state.error ?? state.snapshot.reason ?? 'なし（未回収枠があれば未確定）'}。停止後の再開はしない。`,
    '予約込みの保守的見込額でありAPIの請求確定額ではない。未回収時の確認済み状態・通知はローカルbudget-*.jsonへ戻る。実請求・hit率・実API互換性は未確認。',
  ];
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
  assert(
    evaluation.records.every((record) => record.executionMode !== 'native-chatgpt'),
    'ネイティブ結果をAPI方式へ混合できません',
  );
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
  const money = await moneySummary(directory, evaluation.config);
  const lines = [
    '# 指示変更の比較（公開前に内容を確認）',
    ...money,
    `予定${evaluation.config.maxTrials}試行 / 記録${evaluation.records.length}試行。計画・実行全体: ${evaluation.error ? '停止・不成立（詳細はローカルevaluation.json）' : '記録済み、成果判定は別欄'}。`,
    '',
    `対象: ${evaluation.config.issue}`,
    '',
    `変更前: [${evaluation.config.before}](https://github.com/thkt/dotagents/commit/${evaluation.config.before}) / 変更後: [${evaluation.config.after}](https://github.com/thkt/dotagents/commit/${evaluation.config.after})`,
    `ケース版: ${evaluation.config.corpusCommit} / 共通課題版: ${evaluation.config.workspaceCommit}`,
    `モデル: ${evaluation.config.model} / ${evaluation.config.reasoning}; CLI: ${evaluation.config.cliVersion}; image: ${evaluation.config.image}`,
    '',
    '同条件: ケース集合・課題・モデル・設定・コンテナー・ツール。指示・参照と指定時の初回担当入力だけを前後のcommitから配置。実ファイルの版・変更した指示はローカル plan.json、実効ツール版・停止理由は evaluation.json。',
    '初回担当の試行はスキル選択の採点外。行動の発見・適用・見落とし・過剰適用・記録不足は各reasonと同じ試行の証拠で判定し、選択成功や終了0で代替しない。',
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
      `${side}: 記録欠落${missing}（未評価、選択分母の構成は未確認）。 予定${evaluation.config.cases.length}試行、記録${rows.length}、起動${rows.filter((row) => row.launched).length}、実行失敗・時間切れ${rows.filter((row) => ['failed', 'timeout'].includes(row.execution)).length}、未評価${rows.filter((row) => row.execution === 'unevaluated').length}。選択は採点可能${scored.length}/${denominator}（選択採点外${rows.length - denominator}を除く）、正${scored.filter((row) => row.correct).length}、選択漏れ${misses}、誤発動${falseActivations}（採点可能な行だけ）。要求充足${rows.filter((row) => row.outcome === 'fulfilled').length}/${evaluation.config.cases.length}、未充足${rows.filter((row) => row.outcome === 'unfulfilled').length}、判定不能${rows.filter((row) => row.outcome === 'indeterminate').length}。`,
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

// 同じ証拠・裁定処理を使い、実行方式と段階の分母だけを別契約にする。
export async function writeLightComparison(directory: string, assessmentFile?: string) {
  directory = await realpath(directory);
  const raw = await readFile(resolve(directory, 'evaluation.json'), 'utf8');
  const evaluation = z
    .object({
      executionMode: z.literal('native-chatgpt'),
      config: lightConfig,
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
    '認証: 保存済みChatGPT認証。環境: macOSネイティブCLIとpermission profile。API/Docker結果とは混合しない。金額・内部要求数・残り枠は未取得であり、0や無料を意味しない。',
    '',
    '| ケース | 条件 | 行動 | 成果 | 実行・理由 | 安全 | 秒 | input / cached / output |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- |',
  ];
  const summaries = [];
  for (const record of evaluation.records) {
    const decision = assessment?.trials.find((item) => item.trial === record.trial);
    if (decision?.outcome === 'fulfilled') {
      const trace = await readEvidence(record.trial, 'actor.stdout');
      const usage = readUsage(trace.lines);
      assert(
        usage.completedTurns > 0 && usage.incompleteLines === 0,
        'JSONL欠落・不正usageを軽量比較の要求充足へ変換できません',
      );
    }
    const summary = await summarizeTrial(readEvidence, record, decision);
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
