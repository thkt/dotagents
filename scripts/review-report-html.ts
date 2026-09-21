import { readFile } from 'node:fs/promises';
import { prettyJson, prettyValidatedJson } from './review-report-json.ts';
import { basename, dirname } from 'node:path';
import { hasRecordedOutput, type LogEvent } from './review-report-events.ts';
import type { StopReason } from './input.ts';
import { trialEvidence } from './review-report-records.ts';
import type { ReviewItem } from './review.ts';
import type { ReportRecords, SavedRecord } from './review-report-records.ts';
import { isRecord } from './values.ts';

const escape = (value: unknown) => Bun.escapeHTML(String(value));
const raw = (value: unknown) => `<pre>${escape(JSON.stringify(value, null, 2) ?? '未記録')}</pre>`;
const savedText = (text: string) =>
  `<pre class="saved-text"><code>${escape(text).replaceAll('\r', '&#13;')}</code></pre>`;
const prose = (text: string) =>
  `<div class="markdown">${Bun.markdown.html(text, { noHtmlBlocks: true, noHtmlSpans: true, headings: false })}</div>`;
const panel = (label: string, body: string, tone = '') =>
  `<div class="detail-panel ${tone}"><h4>${escape(label)}</h4><div class="field-content">${body}</div></div>`;
function disclosure(title: string, body: string, meta = '', notice = '') {
  return `<details class="disclosure"><summary><span class="disclosure-title"><span class="disclosure-heading">${escape(title)}</span></span><span class="disclosure-meta">${meta}</span><span class="chevron" aria-hidden="true">›</span>${notice ? `<span class="activity-problems">${notice}</span>` : ''}</summary><div class="disclosure-body">${body}</div></details>`;
}
const details = (title: string, html: string) => disclosure(title, html);
const link = (id: string, label: string) => `<a href="#${id}">${escape(label)}</a>`;
const field = (label: string, value: unknown) =>
  `<dt>${escape(label)}</dt><dd>${value === null || value === undefined ? '未記録・未確認' : escape(value)}</dd>`;
// Present recorded values, without interpreting their meaning or deriving a verdict.
function recordedValue(value: unknown): string {
  if (value === undefined) {
    return '<span class="muted">未記録・未確認</span>';
  }
  if (typeof value === 'string') {
    return `<span class="recorded-text">${escape(value === '' ? '""' : value)}</span>`;
  }
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')) {
    return `<code>${escape(JSON.stringify(value))}</code>`;
  }
  return value !== null && typeof value === 'object'
    ? raw(value)
    : `<code>${escape(JSON.stringify(value))}</code>`;
}
function labeledValues(value: unknown) {
  return isRecord(value) && Object.keys(value).length
    ? `<dl>${Object.entries(value)
        .map(([label, entry]) => `<dt>${escape(label)}</dt><dd>${recordedValue(entry)}</dd>`)
        .join('')}</dl>`
    : recordedValue(value);
}

function additionContent(content: string | Uint8Array) {
  if (typeof content === 'string') {
    return `<p>symlinkの保存参照先（参照先の内容は読み込みません）: ${escape(content)}</p>`;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    if (
      Array.from(text).some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
      })
    ) {
      throw Error('バイナリ・制御文字を含む内容です');
    }
    return `<pre>${escape(text)}</pre>`;
  } catch (error) {
    return `<p class="warning">UTF-8テキストとして本文を表示できません: ${escape(error)}。原記録で確認してください。</p>`;
  }
}

function recordView(entry: SavedRecord, id: string) {
  const additions = (entry.additions ?? [])
    .map((item) => details(`追加ファイル: ${item.path}`, additionContent(item.content)))
    .join('');
  const direction = entry.path.endsWith('.prompt')
    ? '入力'
    : /\.(stdout|stderr)$|\/(stderr\.log|final\.json)$/.test(entry.path)
      ? '出力'
      : '';
  const meta = direction
    ? `<span class="io-label ${direction === '入力' ? 'input-label' : 'output-label'}">${direction}</span>`
    : '';
  const problem = entry.problem ? '記録欠落・読取不能。関連記録の不足を照合してください。' : '';
  const content =
    entry.text === null
      ? ''
      : `${entry.text === '' ? '<p>内容は空です。保存された空の記録です。</p>' : ''}${savedText(prettyJson(entry.text))}`;
  return `<article id="${id}" class="record-entry" tabindex="-1">${disclosure(basename(entry.path), `${additions}${content}<div class="record-source"><span>出所</span><p class="path">${escape(entry.path)}</p></div>`, meta, problem)}</article>`;
}

const conclusions = {
  met: '条件を満たす',
  unmet: '条件未達',
  pending: '判定保留',
  execution_failed: '実行失敗',
};
const stops: Record<StopReason, string> = {
  execution_limit: '実行上限に到達',
  repair_failed: '修正の実行失敗',
  review_failed: 'レビューの実行失敗',
  requirements_changed: '要求の変更で停止',
  source_changed: '対象の変更で停止',
  check_unavailable: '検証を実行できず停止',
  capture_unavailable: '撮影を実行できず停止',
  capture_timeout: '撮影の時間切れ',
  invalid_review: 'レビュー応答が不正',
  review_storage_failed: 'レビュー記録の保存失敗',
  invalid_repair: '修正応答が不正',
  human_decision_required: '人の判断が必要なため終了',
  ready_for_human_review: '人のレビューへ引き継げる制御状態',
  target_changed_after_stop: '停止後の対象変更を検出',
};
const modelStatus = (status: string | undefined) =>
  status === 'accepted'
    ? 'モデルは修正不要と回答'
    : status === 'needs_changes'
      ? 'モデルは変更が必要と回答'
      : '未記録・未確認';

function trialNotices(data: ReportRecords, evidence: ReadonlyMap<string, string>) {
  const { result } = data;
  const trial = result.trial;
  const judgment = trial?.judgment;
  const notices: string[] = [];
  if (!trial) {
    notices.push(
      '由来・実行日時・適用基準・ホストの結論は不明です。旧記録へ現在の基準を適用しません。',
    );
  }
  if (!trial?.startedAt || !trial.finishedAt) {
    notices.push('実行日時は未確認です。ファイル更新・HTML生成・Issue更新日時から推定しません。');
  }
  if (!judgment?.conclusion || !judgment.at || !judgment.reason?.trim()) {
    notices.push(
      'ホストの結論・判断日時・理由に未確認があります。同じ対象の再現と裁定を照合してください。',
    );
  }
  for (const text of judgment?.unmet ?? []) {
    notices.push(`条件未達: ${escape(text)}`);
  }
  for (const text of judgment?.unconfirmed ?? []) {
    notices.push(`確認待ち: ${escape(text)}`);
  }
  if (!judgment?.evidence.length) {
    notices.push('判断に使った証拠の対応は未確認です。');
  }
  for (const ref of judgment?.evidence ?? []) {
    if (!evidence.has(ref)) {
      notices.push(`判断根拠の対応がありません: ${escape(ref)}`);
    }
  }
  return notices;
}

function observationNotices(data: ReportRecords) {
  const { result } = data;
  const notices: string[] = [];
  if (!result.review) {
    notices.push(`${link('review', 'レビュー未記録')}。実行結果とログを確認してください。`);
  }
  if (!result.adjudication || result.adjudication.status === 'pending_host_adjudication') {
    notices.push(`${link('review', '裁定待ち・未判定')}。指摘の真偽を確認してください。`);
  }
  if (result.adjudication?.missedKnownDefect === true) {
    notices.push('既知の欠陥の見落としが記録されています。');
  } else if (result.adjudication?.missedKnownDefect === null) {
    notices.push(
      `${link('results', '既知の欠陥の見落としは未確認')}。裁定記録を照合してください。`,
    );
  }
  notices.push(...findingNotices(data));
  if (!result.reproduction) {
    notices.push(
      `${link('reproduction', '再現記録がありません')}。期待値と実結果の照合は未確認です。`,
    );
  }
  if (result.stop && !['ready_for_human_review', 'human_decision_required'].includes(result.stop)) {
    notices.push(`${link('logs', stops[result.stop])}。原因は記録で確認してください。`);
  }
  return notices;
}

function findingNotices(data: ReportRecords) {
  const notices: string[] = [];
  for (const [index, item] of (data.result.review?.items ?? []).entries()) {
    const finding = data.result.adjudication?.findings.find((entry) => entry.id === item.id);
    const missing = !finding?.reason?.trim() || finding.reproduction === null;
    if (finding?.verdict !== 'demonstrated' || missing) {
      const label =
        finding?.verdict === 'false_positive' ? '誤指摘の裁定あり' : '裁定または根拠が未確認';
      notices.push(
        `${link(`finding-${index}`, item.id)}: ${label}${missing ? '・再現と理由の照合が必要' : ''}（修正状況: ${escape(item.disposition)}）`,
      );
    }
  }
  return notices;
}

function attention(data: ReportRecords, evidence: ReadonlyMap<string, string>) {
  const { warnings } = data;
  const notices = [...trialNotices(data, evidence), ...observationNotices(data)];
  if (!notices.length && !warnings.length) {
    return '';
  }
  return `<section id="attention" class="card attention-panel"><h2>残る確認</h2><ul class="attention">${notices.map((notice) => `<li>${notice}</li>`).join('')}${warnings.length ? `<li>${link('record-warnings', `関連記録の失敗・不足・不整合: ${warnings.length}件`)}。同じ試行の記録を確認してください。</li>` : ''}</ul>${warnings.length ? details('不足している記録と必要な照合', `<ul id="record-warnings">${warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul>`) : ''}</section>`;
}

function requirements(data: ReportRecords) {
  const issue = data.issue.value;
  return `<article id="requirements" tabindex="-1"><h3>元の要求・対象・実行条件</h3>${isRecord(issue) && typeof issue.body === 'string' ? prose(issue.body) : '<p class="warning">元の要求本文は未確認です。</p>'}<dl>${field('ケースID', data.result.id)}${field('ケースの記録名', data.result.name)}${field('基準版', data.result.baseCommit)}${field('レビュー対象ID', data.result.review?.targetId)}${field('制御上の終了理由', data.result.stop ? stops[data.result.stop] : null)}${field('モデルの回答', modelStatus(data.result.review?.status))}</dl>${details('内部コード・裁定状態', raw({ stop: data.result.stop, modelStatus: data.result.review?.status, adjudicationStatus: data.result.adjudication?.status }))}</article>`;
}

function results(data: ReportRecords, evidence: ReadonlyMap<string, string>) {
  const { result } = data;
  return `<section id="results" tabindex="-1"><h2>根拠と再現</h2><div class="card detail-card"><header><h3>判断の根拠</h3></header><div class="evidence-links"><p>${link('criteria', '適用した問い・達成基準')} / ${link('conclusion', '記録された結論と理由')}</p><ul>${result.trial?.judgment.evidence.map((ref) => `<li>${evidence.has(ref) ? link(evidence.get(ref) ?? '', ref) : `${escape(ref)} — 対応する証拠は未確認`}</li>`).join('') || '<li>対応は未記録・未確認</li>'}</ul><p class="muted">ログ全体への参照では、個別行動との対応は未確認です。</p></div></div><article id="reproduction" class="card detail-card" tabindex="-1">${details('対象コードの動作確認', `<p class="muted">解析した値の要約。保存時の字句は${link('result-record', 'result.jsonの原文')}で確認してください。</p><div class="reproduction-layout">${panel('入力 · 条件', labeledValues(result.reproduction?.input), 'input-panel')}<div class="comparison observations">${panel('出力 · 期待値', labeledValues(result.reproduction?.expected), 'output-panel')}${panel('出力 · 実結果', labeledValues(result.reproduction?.actual), 'output-panel')}</div></div><p>${link('reproduction-record', '再現記録の全項目（解析した要約）')} / ${link('review', '指摘の検証')}</p>`)}</article>${knownDefect(data)}<p class="source-links">${link('requirements', '元の要求・対象・条件')} / ${link('targets', '保存されたレビュー対象')}</p></section>`;
}

const verdicts: Record<string, string> = {
  demonstrated: '真の指摘',
  false_positive: '誤指摘',
  unconfirmed: '未確認',
};

function findingView(item: ReviewItem, index: number, data: ReportRecords) {
  const judgment = data.result.adjudication?.findings.find((entry) => entry.id === item.id);
  const verdict = judgment?.verdict ?? 'unconfirmed';
  const model = [
    ['発生条件', item.condition],
    ['モデルが挙げた証拠', item.evidence],
    ['対応案', item.action],
  ]
    .map(([label, text]) => panel(label ?? '', prose(text ?? '')))
    .join('');
  const host =
    panel(
      '確認結果の理由',
      judgment?.reason ? prose(judgment.reason) : '<p>裁定理由は未確認です。</p>',
    ) +
    panel(
      'この指摘の再現（解析した要約）',
      judgment?.reproduction !== null && judgment?.reproduction !== undefined
        ? labeledValues(judgment.reproduction)
        : '<p>この指摘に対する再現は未確認です。</p>',
    ) +
    panel('修正状況', `<p>${escape(item.disposition)}</p>${prose(item.reason)}`);
  const metadata = `<dl>${field('指摘ID', item.id)}${field('修正状況', item.disposition)}${field('真偽の裁定（内部コード）', judgment?.verdict)}${field('観点 / 種別', `${item.area} / ${item.kind}`)}${field('必須対応', item.required)}${field('初出対象ID', item.introducedIn)}</dl>`;
  const body = `<p class="finding-location">${escape(item.location.path ?? '箇所は未記録')}${item.location.line === null ? '' : `:${escape(item.location.line)}`}</p><div class="finding-columns"><section class="finding-party"><h3>モデルの指摘</h3>${model}</section><section class="finding-party"><h3>ホストの確認</h3>${host}</section></div><p>${link('reproduction', 'ケースの再現（指摘との対応は記録で確認）')} / ${link('targets', '対象記録')} / ${link('result-record', 'result.jsonの原文')} / ${link('logs', '呼出し・ツール実行の記録')}</p>${details('指摘の管理情報', metadata)}`;
  return `<article id="finding-${index}" class="card finding-card" tabindex="-1">${disclosure(`${item.id} · ${item.impact}`, body, `<span class="badge ${verdict}" data-variant="outline">真偽の裁定: ${verdicts[verdict]}</span><span class="finding-location">${escape(item.location.path ?? '箇所は未記録')}${item.location.line === null ? '' : `:${escape(item.location.line)}`}</span>`)}</article>`;
}

function reviews(data: ReportRecords) {
  const review = data.result.review;
  return `<section id="review" tabindex="-1"><h2>指摘の検証</h2>${
    review
      ? review.items.length
        ? review.items.map((item, index) => findingView(item, index, data)).join('')
        : '<p>記録された指摘: 0件。指摘なしは欠陥なしの証明ではありません。</p>'
      : '<p class="warning">レビュー未記録。採点できた結果は確認できません。</p>'
  }</section>`;
}

function reviewRecords(data: ReportRecords) {
  const review = data.result.review;
  return `<div class="card record-group"><header><h3>モデルのレビュー記録</h3><p>解析した値です。モデル申告の参照文書は、ログで確認した読取りとは別です。${link('result-record', 'result.jsonの原文')}</p></header>${
    review
      ? `${details('モデルのレビュー本文（解析した値）', prose(review.findings))}${details(
          '評価観点・モデルが申告した参照文書・引き継ぎ',
          `${Object.entries(review.assessments)
            .map(([label, text]) => `<h3>${escape(label)}</h3>${prose(text)}`)
            .join('')}${raw(review.documents)}${review.handoff.map(prose).join('')}`,
        )}`
      : '<p class="record-content warning">モデルのレビューは未記録です。</p>'
  }</div>`;
}

function knownDefect(data: ReportRecords) {
  const missed = data.result.adjudication?.missedKnownDefect;
  const detection =
    missed === false
      ? '見落としなし（ホスト確認済み）'
      : missed === true
        ? '見落としあり（ホスト確認済み）'
        : 'ホストによる確認待ち';
  return `<div class="card detail-card"><header><h3>試験に仕込んだ欠陥</h3><p>レビューが見つけられるかを確かめるための、試験用コードの欠陥です。ハーネス自身の欠陥を示す欄ではありません。</p></header><div class="known-defect"><div>${recordedValue(data.result.adjudication?.knownDefect ?? undefined)}</div><span class="badge" data-variant="outline">${detection}</span></div><footer>${link('result-record', '裁定の原データ（result.json）')}</footer></div>`;
}

function metric(label: string, value: number | null | undefined, unit: string) {
  return `<div class="metric card"><h3>${escape(label)}</h3><p class="metric-value">${value === null || value === undefined ? '<span class="metric-unknown">未計測・未確認</span>' : `${escape(value)} <span class="unit">${escape(unit)}</span>`}</p></div>`;
}

function usage(data: ReportRecords, evidence: ReadonlyMap<string, string>) {
  const { result } = data;
  const totals = result.usage?.totals;
  const judgment = result.trial?.judgment;
  return `<section id="summary" tabindex="-1"><h2>評価の要約</h2><div id="usage" aria-label="結論・時間・使用量"><div class="metrics"><div id="conclusion" class="metric card" data-conclusion="${judgment?.conclusion ?? 'unknown'}"><h3>結論 · ホストの記録</h3><p class="metric-value conclusion">${judgment?.conclusion ? conclusions[judgment.conclusion] : '結論は未確認'}</p></div>${metric('実時間', result.elapsedMs, 'ms')}${metric('入力トークン', totals?.input_tokens, 'tokens')}${metric('出力トークン', totals?.output_tokens, 'tokens')}</div>${attention(data, evidence)}<div class="summary-grid"><div id="criteria" class="card question" tabindex="-1"><h3>問い</h3>${result.trial ? prose(result.trial.question) : '<p>適用した試験の問いは未記録・未確認</p>'}<h3>達成基準</h3>${result.trial ? prose(result.trial.criteria) : '<p>未記録・未確認（現在の基準を遡及適用しません）</p>'}</div><div class="card"><div class="decision-reason"><h3>判断理由</h3>${judgment?.reason ? prose(judgment.reason) : '<p class="muted">判断理由は未記録・未確認です。</p>'}</div><p class="muted">トークンの集計範囲: レビューCLIの完了ターン。子モデルを含む総使用量は未確認、金額は未計測です。</p>${!totals ? '<p class="warning">使用量が未計測・欠落。品質と分けて費用比較を未確認にします。</p>' : ''}${details('時間・使用量の内訳と原記録', `<dl>${field('モデル時間 (ms)', result.modelMs)}${field('キャッシュ入力トークン', totals?.cached_input_tokens)}${field('集計した完了ターン数', result.usage?.completedTurns)}</dl>${result.usage ? prose(result.usage.scope) : '<p>使用量の記録がありません。</p>'}<p>実時間とモデル時間は保存値です。中断したターンや子モデルを含む総量、契約上の課金額を確定するものではありません。トークンを再集計したり金額を推定したりしません。</p>${raw(result.usage)}`)}</div></div></div></section>`;
}

function eventPayload(value: string | undefined) {
  return value === undefined
    ? '<p class="muted">未記録・未確認、または重複キーにより抽出不能。原文を確認してください。</p>'
    : savedText(prettyValidatedJson(value));
}

function eventRow(row: LogEvent, logId: string) {
  const id = `${logId}-line-${row.line}`;
  const outputField =
    row.itemType === 'mcp_tool_call' ? (row.outputJson === undefined ? 'error' : 'result') : '応答';
  const bytes =
    row.outputBytes !== undefined
      ? `<div class="response-size">${row.outputBytes} <span class="unit">B</span>（解析した${outputField}文字列のUTF-8バイト数）</div>`
      : '<div class="muted">サイズ未計測</div>';
  const output =
    row.itemType === 'mcp_tool_call'
      ? `<h4>result</h4>${eventPayload(row.outputJson)}<h4>error</h4>${eventPayload(row.errorJson)}`
      : eventPayload(row.outputJson);
  const body = `<div class="io-grid">${panel('入力 · 保存されたJSON値', `<div class="event-input">${eventPayload(row.inputJson)}</div>`, 'input-panel')}${panel('出力 · 保存されたJSON値', `<div class="event-output">${output}</div>${bytes}`, 'output-panel')}</div><div class="event-meta"><span>${escape(row.timestamp ?? '時刻は未記録・未確認')}</span>${row.itemId ? `<span>ID: ${escape(row.itemId)}</span>` : ''}${row.relatedLine ? link(`${logId}-line-${row.relatedLine}`, `同じIDの対応行 ${row.relatedLine}`) : ''}</div>${details(`行 ${row.line} の原文（JSONの空白のみ整形） · ${row.type || '形式不正'}`, savedText(prettyJson(row.raw)))}`;
  return `<article id="${id}" tabindex="-1">${disclosure(`行 ${row.line} · ${row.operation}`, body, `<span class="badge activity-status" data-variant="outline">${escape(row.result)}</span>`, row.problems.map(escape).join('<br>'))}</article>`;
}

function actorLog(entry: SavedRecord, index: number) {
  if (!entry.events) {
    return '';
  }
  const actor = basename(dirname(entry.path));
  return `<article id="log-${index}" class="card log-group" tabindex="-1"><header><h3>モデル側 · ${escape(actor)}</h3><p>このJSONLの非空行: ${entry.events.length}件。操作数・全実行の総量ではありません。</p></header><div class="activity-list">${entry.events.length ? entry.events.map((row) => eventRow(row, `log-${index}`)).join('') : '<p class="warning">イベント未記録・結果は未確認です。</p>'}</div>${details('JSONLの原文・保存先', `<p class="path">${escape(entry.path)}</p><pre class="saved-text"><code>${escape(entry.text ?? '').replaceAll('\r', '&#13;')}</code></pre>`)}</article>`;
}

function controlLogs(data: ReportRecords) {
  const roles = { check: '検証', review: 'レビュー依頼', repair: '修正依頼', capture: '撮影' };
  const rows = (data.timeline?.events ?? []).map((event, index) => {
    const status = event.timedOut
      ? '時間切れ'
      : event.code === null
        ? '終了結果は未確認'
        : event.code === 0
          ? '正常終了'
          : '実行失敗';
    const refs = data.logs.flatMap((entry, logIndex) =>
      dirname(entry.path) === dirname(data.state.path) &&
      basename(entry.path).startsWith(`${basename(event.prefix)}.`)
        ? [link(`log-${logIndex}`, basename(entry.path))]
        : [],
    );
    const body = `<div class="io-grid">${panel('入力 · 対象', escape(basename(event.prefix)), 'input-panel')}${panel('出力 · 関連記録と実時間', `<div class="numeric">${escape(event.ms ?? '未計測')} <span class="unit">ms</span></div>${refs.join(' / ') || '関連ログは未確認'}`, 'output-panel')}</div>`;
    return disclosure(
      `${index + 1} · ホスト · ${roles[event.role]}`,
      body,
      `<span class="badge activity-status" data-variant="outline">${status} / 終了コード ${escape(event.code ?? '未記録')}</span>`,
    );
  });
  const active = data.timeline?.active;
  return `<div class="card log-group"><header><h3>ホストの制御呼出し</h3><p>state.eventsの保存順。個々の開始・終了時刻は未記録です。${link('state-record', 'stateの原文')}</p></header><div class="activity-list">${rows.join('') || '<p class="warning">呼出し順序は未確認です。</p>'}</div>${active ? `<p class="warning">ホスト · ${roles[active.role]} · ${escape(basename(active.prefix))}: 実行中の保存記録。完了は未確認です。</p>` : ''}</div>`;
}

function logs(data: ReportRecords) {
  return `<section id="logs" tabindex="-1"><h2>行動ログ</h2><p class="context-note">主体ごとの保存順です。別ログ・主体間の全体順序、親子関係、制御呼出しとの対応は未確認です。操作行を開くと保存された入出力と原文を表示します。操作名・状態は解析した要約です。</p>${controlLogs(data)}<h3 class="group-heading">モデルのツール実行・イベント</h3><div class="context-note">開始・完了は同じファイルの一意なID・項目種別が一致する場合だけリンクし、失敗・中断・更新も残します。保存された操作から内容の理解・有効利用や空白時間の原因は判断できません。</div>${data.logs.some((entry) => entry.events) ? '' : '<p class="warning">読み取れるJSONLがなく、モデル側の操作は未確認です。</p>'}${data.logs.map(actorLog).join('')}</section>`;
}

function references(data: ReportRecords) {
  const rows = data.logs.flatMap((entry, index) =>
    (entry.events ?? []).flatMap((row) =>
      row.reference
        ? [
            `<tr><th scope="row"><code>${escape(row.reference.source)}</code></th><td>${escape(row.result)}${!hasRecordedOutput(row) ? ' / 応答は未記録・未確認' : ' / 応答記録あり'}${row.problems.map((problem) => `<p class="warning">${escape(problem)}</p>`).join('')}</td><td>${link(`log-${index}-line-${row.line}`, `${row.reference.tool} · 行 ${row.line}`)}</td></tr>`,
          ]
        : [],
    ),
  );
  const count = data.logs.reduce((total, entry) => total + (entry.events?.length ?? 0), 0);
  return `<article id="references" class="card detail-card" tabindex="-1"><header><h3>ログから確認した参照資料</h3><p>モデルログ${count}行中、参照操作${rows.length}行。開始・更新・完了を行ごとに表示します。</p></header>${rows.length ? `<div class="reference-table-wrap"><table class="table reference-table"><thead><tr><th scope="col">読取り対象</th><th scope="col">記録された状態</th><th scope="col">提供元・ツールと根拠</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="record-content">読取り対象を特定できるログがありません。</p>'}<footer>明示的な読取りイベントだけを抽出します。シェル経由の読取り・検索結果・モデルの申告は対象外です。ログにない初期コンテキスト、応答の全文性、モデルの読了・理解は確認できません。</footer></article>`;
}

function overview(data: ReportRecords, title: string) {
  const trial = data.result.trial;
  const judgment = trial?.judgment;
  const origin =
    trial?.provenance === 'display_sample'
      ? '表示サンプル'
      : trial?.provenance === 'live_model'
        ? '実モデル'
        : '不明';
  return `<header id="top"><p class="eyebrow">レビュー試験 · ${origin}</p><h1>レビュー試験の行動ログと評価</h1><p>評価対象: ${escape(title)}</p><div class="metadata"><span>対象: ${escape(data.result.name === 'defective' ? '既知欠陥例' : '正常例')} · 基準版 ${escape(data.result.baseCommit.slice(0, 12))}</span><span>実行開始（UTC）: ${escape(trial?.startedAt ?? '未記録・未確認')}</span><span>ホスト判断（UTC）: ${escape(judgment?.at ?? '未記録・未確認')}</span></div>${trial?.provenance === 'display_sample' ? '<p class="muted">モデルを呼ばない表示サンプルです。日時・判断・使用量も模擬値です。</p>' : trial?.provenance === 'live_model' ? '<p class="muted">合成課題を実モデルでレビューしたケース単位の記録です。</p>' : ''}</header><nav class="section-nav" aria-label="レポート内の移動">${[
    ['summary', '評価の要約'],
    ['logs', '行動ログ'],
    ['results', '根拠と再現'],
    ['review', '指摘の検証'],
    ['records', '記録詳細'],
  ]
    .map(([id, label]) => link(id ?? '', label ?? ''))
    .join('')}</nav>`;
}

function records(data: ReportRecords) {
  const trial = data.result.trial;
  return `<section id="records" tabindex="-1"><h2>記録詳細</h2><p class="context-note">JSON原文は文字列外の空白だけを整形します。文字列の空白・エスケープ、数値の表記、キー順序と重複キーを保持します。非JSON・空白だけの記録は修復しません。評価欄の解析した要約とは区別してください。</p>${references(data)}<div class="card record-group"><header><h3>実行・判断の情報</h3></header>${details('由来・日時・入力記録', `<dl>${field('由来', trial?.provenance)}${field('実行開始（UTC）', trial?.startedAt)}${field('実行終了（UTC）', trial?.finishedAt)}${field('ホスト判断（UTC）', trial?.judgment.at)}${field('HTML生成日時（評価日時ではありません）', new Date().toISOString())}</dl><p class="path">入力: ${escape(data.input.path)}</p>`)}</div><div class="card detail-card">${details('元の要求・評価対象', requirements(data))}</div><div class="card record-group"><header><h3>呼出しの入出力・関連原記録</h3></header>${data.logs.map((entry, index) => (!entry.events ? recordView(entry, `log-${index}`) : '')).join('')}</div>${reviewRecords(data)}<div class="card record-group"><header><h3>評価・実行条件の原記録</h3></header><article id="reproduction-record" class="record-entry" tabindex="-1">${details('対象コードの再現記録（解析した要約）', `<p>result.jsonのreproductionの全項目です。保存時の正確な字句は${link('result-record', 'result.jsonの原文')}で確認してください。</p>${raw(data.result.reproduction)}`)}</article>${recordView(data.issue, 'issue-record')}${recordView(data.environment, 'environment-record')}${recordView(data.cases, 'cases-record')}${recordView(data.config, 'config-record')}${recordView(data.input, 'result-record')}${recordView(data.state, 'state-record')}</div><article id="targets" class="card record-group" tabindex="-1"><header><h3>レビュー対象の原記録</h3></header>${data.targets.map((entry, index) => recordView(entry, `target-${index}`)).join('') || '<p class="record-content warning">保存対象記録がありません。</p>'}</article><div class="card detail-card">${details('この表示で判断できる範囲', `<p>ハーネス全体の合否ではありません。試験用コードの失敗と、欠陥を正しく指摘するレビュー試験の成功は別です。モデル状態・制御終了・修正状況・真偽の裁定・試験の結論を区別します。表示側で合否・原因・証拠の対応やログ間の因果関係を補いません。現在のcheckout、oracleのパス先、別試行を過去の根拠として読み込まず、記録の真正性・完全性は保証しません。元記録を更新した場合は別名で再生成してください。状態変更・再実行・採点・承認・マージの操作はありません。</p>${data.result.limitations.map(prose).join('')}`)}</div><p>${link('top', '冒頭へ戻る')}</p></section>`;
}

export async function renderReport(data: ReportRecords) {
  const evidence = trialEvidence(data);
  const title =
    isRecord(data.issue.value) && typeof data.issue.value.title === 'string'
      ? data.issue.value.title
      : data.result.id;
  const basecoat = await readFile(
    new URL('./basecoat.cdn.min.css', import.meta.resolve('basecoat-css')),
    'utf8',
  );
  const css = await readFile(new URL('./review-report.css', import.meta.url), 'utf8');
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>レビュー試験 — ${escape(title)}</title><style data-library="basecoat-css@1.0.2">${basecoat}</style><style>${css}</style></head><body><main>${overview(data, title)}${usage(data, evidence)}${logs(data)}${results(data, evidence)}${reviews(data)}${records(data)}</main></body></html>`;
  // HTML is disabled in Markdown; URL filtering also covers entity/control-character
  // spellings after HTML parsing. Images stay textual so opening a report is offline.
  return new HTMLRewriter()
    .on('a', {
      element(element) {
        const href = element.getAttribute('href') ?? '';
        if (
          !/^(https?:\/\/|#[A-Za-z0-9_-]+$)/i.test(href) ||
          Array.from(href).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
        ) {
          element.removeAttribute('href');
        }
        element.setAttribute('rel', 'noreferrer noopener');
      },
    })
    .on('img', {
      element(element) {
        element.replace(
          `[画像: ${element.getAttribute('alt') ?? ''}] ${element.getAttribute('src') ?? ''}`,
        );
      },
    })
    .on('input', {
      element(element) {
        element.setAttribute('disabled', '');
      },
    })
    .transform(new Response(html))
    .text();
}
