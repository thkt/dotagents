import { basename, dirname } from 'node:path';
import type { LogEvent } from './review-report-events.ts';
import type { StopReason } from './input.ts';
import { trialEvidence } from './review-report-records.ts';
import type { ReviewItem } from './review.ts';
import type { ReportRecords, SavedRecord } from './review-report-records.ts';
import { isRecord } from './values.ts';

const escape = (value: unknown) => Bun.escapeHTML(String(value));
const raw = (value: unknown) => `<pre>${escape(JSON.stringify(value, null, 2) ?? '未記録')}</pre>`;
const prose = (text: string) =>
  `<div class="markdown">${Bun.markdown.html(text, { noHtmlBlocks: true, noHtmlSpans: true, headings: false })}</div>`;
const details = (title: string, html: string) =>
  `<details><summary>${escape(title)}</summary>${html}</details>`;
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
  return `<article id="${id}" tabindex="-1">${details(basename(entry.path), `<p class="path">${escape(entry.path)}</p>${entry.problem ? `<p class="warning">記録欠落・読取不能。${link('record-warnings', '不足の詳細と必要な照合')}</p>` : ''}${additions}${entry.text !== null ? `<pre>${escape(entry.text)}</pre>` : ''}`)}</article>`;
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
  return `<section id="attention" class="attention-panel"><h2>残る確認</h2><ul class="attention">${notices.map((notice) => `<li>${notice}</li>`).join('')}${warnings.length ? `<li>${link('record-warnings', `関連記録の失敗・不足・不整合: ${warnings.length}件`)}。同じ試行の記録を確認してください。</li>` : ''}</ul>${warnings.length ? details('不足している記録と必要な照合', `<ul id="record-warnings">${warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul>`) : ''}</section>`;
}

function requirements(data: ReportRecords) {
  const issue = data.issue.value;
  return `<article id="requirements" tabindex="-1"><h3>元の要求・対象・実行条件</h3>${isRecord(issue) && typeof issue.body === 'string' ? prose(issue.body) : '<p class="warning">元の要求本文は未確認です。</p>'}<dl>${field('ケースID', data.result.id)}${field('ケースの記録名', data.result.name)}${field('基準版', data.result.baseCommit)}${field('レビュー対象ID', data.result.review?.targetId)}${field('制御上の終了理由', data.result.stop ? stops[data.result.stop] : null)}${field('モデルの回答', modelStatus(data.result.review?.status))}</dl>${details('内部コード・裁定状態', raw({ stop: data.result.stop, modelStatus: data.result.review?.status, adjudicationStatus: data.result.adjudication?.status }))}${recordView(data.issue, 'issue-record')}${recordView(data.environment, 'environment-record')}${recordView(data.cases, 'cases-record')}${recordView(data.config, 'config-record')}</article>`;
}

function results(data: ReportRecords, evidence: ReadonlyMap<string, string>) {
  const { result } = data;
  return `<section id="results" tabindex="-1"><h2>評価</h2><p>期待値・実結果と適用基準を照合します。試験用コードの失敗と、レビューによる欠陥検出の成功は別です。</p><div class="panel"><h3>判断の根拠</h3><p>${link('criteria', '適用した問い・達成基準')} / ${link('conclusion', '記録された結論と理由')}</p><ul>${result.trial?.judgment.evidence.map((ref) => `<li>${evidence.has(ref) ? link(evidence.get(ref) ?? '', ref) : `${escape(ref)} — 対応する証拠は未確認`}</li>`).join('') || '<li>対応は未記録・未確認</li>'}</ul><p class="muted">ログ全体への参照では、個別行動との対応は未確認です。</p></div><article id="reproduction" class="panel" tabindex="-1"><h3>同じ対象の独立した再現</h3><div class="reproduction-input"><h4>入力</h4>${labeledValues(result.reproduction?.input)}</div><div class="comparison observations"><div><h4>期待値</h4>${labeledValues(result.reproduction?.expected)}</div><div><h4>実結果</h4>${labeledValues(result.reproduction?.actual)}</div></div>${details('再現記録の原JSON・全項目', raw(result.reproduction))}</article>${details('既知の欠陥・裁定記録', `<dl>${field('既知の欠陥', result.adjudication?.knownDefect)}${field('既知の欠陥の見落とし', result.adjudication?.missedKnownDefect)}</dl>${raw(result.adjudication)}`)}<p class="source-links">${link('requirements', '元の要求・対象・条件')} / ${link('targets', '保存されたレビュー対象')}</p></section>`;
}

const verdicts: Record<string, string> = {
  demonstrated: '真の指摘',
  false_positive: '誤指摘',
  unconfirmed: '未確認',
};

function findingView(item: ReviewItem, index: number, data: ReportRecords) {
  const judgment = data.result.adjudication?.findings.find((entry) => entry.id === item.id);
  const bodies = [
    ['発生条件', item.condition],
    ['証拠', item.evidence],
    ['対応案', item.action],
    ['修正状況の理由・未確認事項', item.reason],
  ]
    .map(([label, text]) => `<h4>${escape(label)}</h4>${prose(text ?? '')}`)
    .join('');
  const verdict = judgment?.verdict ?? 'unconfirmed';
  return `<article id="finding-${index}" class="finding panel" tabindex="-1"><div class="finding-summary"><h3>${escape(item.impact)}</h3><span class="badge ${verdict}">真偽の裁定: ${verdicts[verdict]}</span></div><p class="finding-location">${escape(item.location.path ?? '箇所は未記録')}${item.location.line === null ? '' : `:${escape(item.location.line)}`}</p>${details('条件・証拠・対応と裁定理由', `<dl>${field('指摘ID', item.id)}${field('修正状況', item.disposition)}${field('真偽の裁定（内部コード）', judgment?.verdict)}${field('観点 / 種別', `${item.area} / ${item.kind}`)}${field('必須対応', item.required)}${field('初出対象ID', item.introducedIn)}</dl>${bodies}${judgment ? `<h4>裁定の再現</h4>${labeledValues(judgment.reproduction)}<h4>裁定理由</h4>${judgment.reason ? prose(judgment.reason) : '<p>裁定理由は未記録です。</p>'}` : '<p>対応する裁定・再現は未記録です。</p>'}<p>${link('reproduction', 'ケースの再現（指摘との対応は記録で確認）')} / ${link('targets', '対象記録')} / ${link('logs', '呼出し・ツール実行の記録')}</p>`)}</article>`;
}

function reviews(data: ReportRecords) {
  const review = data.result.review;
  return `<section id="review" tabindex="-1"><h2>指摘と裁定</h2>${
    review
      ? `${review.items.length ? review.items.map((item, index) => findingView(item, index, data)).join('') : '<p>記録された指摘: 0件。指摘なしは欠陥なしの証明ではありません。</p>'}${details('モデルのレビュー原文', prose(review.findings))}${details(
          '評価観点・参照文書・引き継ぎ',
          `${Object.entries(review.assessments)
            .map(([label, text]) => `<h3>${escape(label)}</h3>${prose(text)}`)
            .join('')}${raw(review.documents)}${review.handoff.map(prose).join('')}`,
        )}`
      : '<p class="warning">レビュー未記録。採点できた結果は確認できません。</p>'
  }</section>`;
}

function metric(label: string, value: number | null | undefined, unit: string) {
  return `<div class="metric panel"><h3>${escape(label)}</h3><p class="metric-value">${value === null || value === undefined ? '<span class="metric-unknown">未計測・未確認</span>' : `${escape(value)} <span class="unit">${escape(unit)}</span>`}</p></div>`;
}

function usage(data: ReportRecords) {
  const { result } = data;
  const totals = result.usage?.totals;
  const judgment = result.trial?.judgment;
  return `<section id="usage" aria-label="結論・時間・使用量"><div class="metrics"><div id="conclusion" class="metric panel" data-conclusion="${judgment?.conclusion ?? 'unknown'}"><h3>結論 · ホストの記録</h3><p class="metric-value conclusion">${judgment?.conclusion ? conclusions[judgment.conclusion] : '結論は未確認'}</p></div>${metric('実時間', result.elapsedMs, 'ms')}${metric('入力トークン', totals?.input_tokens, 'tokens')}${metric('出力トークン', totals?.output_tokens, 'tokens')}</div><div class="decision-reason"><h3>判断理由</h3>${judgment?.reason ? prose(judgment.reason) : '<p class="muted">判断理由は未記録・未確認です。</p>'}</div><p class="muted">トークンの集計範囲: レビューCLIの完了ターン。子モデルを含む総使用量は未確認、金額は未計測です。</p>${!totals ? '<p class="warning">使用量が未計測・欠落。品質と分けて費用比較を未確認にします。</p>' : ''}${details('時間・使用量の内訳と原記録', `<dl>${field('モデル時間 (ms)', result.modelMs)}${field('キャッシュ入力トークン', totals?.cached_input_tokens)}${field('集計した完了ターン数', result.usage?.completedTurns)}</dl>${result.usage ? prose(result.usage.scope) : '<p>使用量の記録がありません。</p>'}<p>実時間とモデル時間は保存値です。中断したターンや子モデルを含む総量、契約上の課金額を確定するものではありません。トークンを再集計したり金額を推定したりしません。</p>${raw(result.usage)}`)}</section>`;
}

function shortValue(value: unknown) {
  if (value === undefined || value === null) {
    return '未記録・未確認';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return escape(text.length > 180 ? `${text.slice(0, 180)}…（全文は原文）` : text);
}

function logTable(caption: string, columns: string[], rows: string[]) {
  return `<table class="log-table"><caption>${escape(caption)}</caption><thead><tr>${columns.map((column) => `<th scope="col">${escape(column)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function cell(label: string, html: string, className = '') {
  return `<td data-label="${escape(label)}" class="${className}">${html}</td>`;
}

function eventRow(row: LogEvent, logId: string) {
  const id = `${logId}-line-${row.line}`;
  const bytes =
    typeof row.output === 'string'
      ? `<div class="response-size">${Buffer.byteLength(row.output, 'utf8')} <span class="unit">B</span></div>`
      : '<div class="muted">サイズ未計測</div>';
  return `<tr id="${id}" tabindex="-1">${cell('行 / 時刻', `<strong>行 ${row.line}</strong><div class="event-time">${escape(row.timestamp ?? '時刻は未記録・未確認')}</div>`)}${cell('操作・ツール', `<strong>${escape(row.operation)}</strong>${row.itemId ? `<div class="muted">ID: ${escape(row.itemId)}</div>` : ''}${row.relatedLine ? `<div>${link(`${logId}-line-${row.relatedLine}`, `同じIDの対応行 ${row.relatedLine}`)}（このファイル内）</div>` : ''}`)}${cell('入力・対象', shortValue(row.input), 'event-input')}${cell('応答・サイズ', `<div class="event-output">${shortValue(row.output)}</div>${bytes}${details(`行 ${row.line} の原文 · ${row.type || '形式不正'}`, `<pre>${escape(row.raw)}</pre>`)}`)}${cell('状態', `<div>${escape(row.result)}</div>${row.problems.map((problem) => `<p class="warning">${escape(problem)}</p>`).join('')}`)}</tr>`;
}

function actorLog(entry: SavedRecord, index: number) {
  if (!entry.events) {
    return '';
  }
  const actor = basename(dirname(entry.path));
  return `<article id="log-${index}" tabindex="-1"><h3>モデル側 · ${escape(actor)}</h3><p>このJSONLの非空行: ${entry.events.length}件。操作数・全実行の総量ではありません。</p>${
    entry.events.length
      ? logTable(
          'モデルの保存行（応答サイズは文字列応答のUTF-8バイト数）',
          ['行 / 時刻', '操作・ツール', '入力・対象', '応答・サイズ', '状態'],
          entry.events.map((row) => eventRow(row, `log-${index}`)),
        )
      : '<p class="warning">イベント未記録・結果は未確認です。</p>'
  }${details('ログの保存先', `<p class="path">${escape(entry.path)}</p>`)}</article>`;
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
    return `<tr>${cell('保存順', String(index + 1))}${cell('操作', `ホスト · ${roles[event.role]}`)}${cell('対象', escape(basename(event.prefix)))}${cell('実時間 / 記録', `<div class="numeric">${escape(event.ms ?? '未計測')} <span class="unit">ms</span></div>${refs.join(' / ') || '関連ログは未確認'}`)}${cell('状態', `${status} / 終了コード ${escape(event.code ?? '未記録')}`)}</tr>`;
  });
  const active = data.timeline?.active;
  return `<h3>ホストの制御呼出し</h3><p>state.eventsの保存順。個々の開始・終了時刻は未記録です。${link('state-record', 'stateの原文')}</p>${rows.length ? logTable('ホストの保存された制御呼出し', ['保存順', '操作', '対象', '実時間 / 記録', '状態'], rows) : '<p class="warning">呼出し順序は未確認です。</p>'}${active ? `<p class="warning">ホスト · ${roles[active.role]} · ${escape(basename(active.prefix))}: 実行中の保存記録。完了は未確認です。</p>` : ''}`;
}

function logs(data: ReportRecords) {
  return `<section id="logs" tabindex="-1"><h2>行動ログ</h2><p>ホストの制御呼出しとモデル側の操作を分けて表示します。各JSONLはファイル内の行順です。別ログ・主体間の全体順序、親子関係、制御呼出しとの対応は未確認です。</p>${controlLogs(data)}<h3>モデルのツール実行・イベント</h3><p>開始と完了は同じファイルの一意なID・項目種別が一致する場合だけリンクします。失敗・中断・更新も元の行に残します。時刻・入力・応答は保存値だけを示し、操作から内容の理解・有効利用、空白時間の原因は判断しません。</p>${data.logs.filter((entry) => entry.events).length ? '' : '<p class="warning">読み取れるJSONLがなく、モデル側の操作は未確認です。</p>'}${data.logs.map(actorLog).join('')}<h3>呼出しの入出力・関連原記録</h3>${data.logs.map((entry, index) => (!entry.events ? recordView(entry, `log-${index}`) : '')).join('')}</section>`;
}

const css = `
:root{color-scheme:light;font-size:16px;font-family:system-ui,-apple-system,"Noto Sans JP",sans-serif;color:#252a30;background:#f4f6f8;line-height:1.7}
*{box-sizing:border-box;min-width:0}body{margin:0}main{max-width:1280px;margin:auto;padding:2rem 2rem 4rem}
header{padding-bottom:1rem}section{padding:1.5rem 0;scroll-margin-top:1rem}h1{font-size:1.7rem;line-height:1.4;margin:.4rem 0}h2{font-size:1.3rem;margin:0 0 1rem}h3,h4{font-size:1rem;margin:0 0 .6rem}h4{color:#525b66}p{margin:.6rem 0}a{color:#275d92;text-underline-offset:.25em}a:focus-visible,summary:focus-visible{outline:3px solid #a04d0c;outline-offset:4px}nav{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;margin-top:1rem}
.panel{background:#fff;border:1px solid #dce1e7;border-radius:10px;padding:1.2rem;margin:.8rem 0}.eyebrow,.muted,.source-links{color:#525b66}.eyebrow{margin:0}.metadata{display:flex;flex-wrap:wrap;gap:.25rem 1.4rem;color:#525b66}.question .markdown>:first-child{margin-top:0}.question .markdown>:last-child{margin-bottom:0}.question h3:not(:first-child){margin-top:1rem}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}.metric{margin:0;border-top:3px solid #c8ced6}.metric h3{color:#525b66;font-weight:500}.metric-value{font-size:1.9rem;font-weight:650;line-height:1.4;font-variant-numeric:tabular-nums;margin:.5rem 0 0}.metric-unknown,.unit{font-size:1rem;font-weight:400;color:#525b66}.conclusion{font-size:1.5rem}.metric[data-conclusion="met"]{border-top-color:#23715a}.metric[data-conclusion="met"] .conclusion{color:#175b4a}.metric[data-conclusion="unmet"],.metric[data-conclusion="execution_failed"]{border-top-color:#a04138}.metric[data-conclusion="unmet"] .conclusion,.metric[data-conclusion="execution_failed"] .conclusion{color:#8b312b}.metric[data-conclusion="pending"],.metric[data-conclusion="unknown"]{border-top-color:#916224}.metric[data-conclusion="pending"] .conclusion,.metric[data-conclusion="unknown"] .conclusion{color:#78501c}.decision-reason{margin:1rem 0}.decision-reason h3{margin-bottom:.25rem}#usage{padding:.4rem 0 0}
.badge{display:inline-block;border:1px solid #c8ced6;border-radius:6px;background:#eef0f3;padding:.15rem .6rem;font-size:1rem;font-weight:600;align-self:start}.demonstrated{color:#175b4a;background:#edf7f2;border-color:#b7d7c9}.false_positive{color:#8b312b;background:#fff0ef;border-color:#e1b9b5}.unconfirmed{color:#78501c;background:#fff6e7;border-color:#dfcaa7}.attention-panel{padding:1rem 1.2rem;margin:.8rem 0;background:#fff8ec;border:1px solid #e0cfae;border-radius:10px}.attention-panel h2{font-size:1rem;margin:0}.attention{padding-left:1.3rem;margin:.5rem 0}.attention li{margin:.4rem 0}.warning{color:#814415;font-weight:600}
.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5rem}.comparison>div+div{border-left:1px solid #dce1e7;padding-left:1.5rem}.reproduction-input{margin-bottom:1rem}.finding-summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem}.finding-summary h3{font-weight:600;margin:0}.finding-location{font-family:ui-monospace,monospace;color:#525b66;margin:.4rem 0}.finding details{margin:.6rem 0 0}article{scroll-margin-top:1rem}
details{margin:.8rem 0}summary{cursor:pointer;color:#3c4c5e;font-size:1rem;font-weight:600;padding:.25rem 0}details[open]>summary{margin-bottom:.6rem}details details{margin-left:.8rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef0f3;padding:1rem;border-radius:5px;font-size:1rem;line-height:1.6}p,li,dd,dt,h1,h2,h3,h4,summary,.path,span,td,th{overflow-wrap:anywhere}.recorded-text{white-space:pre-wrap}dl{display:grid;grid-template-columns:minmax(8rem,1fr) minmax(0,3fr);gap:0 1rem;margin:.6rem 0 1rem}dt,dd{border-bottom:1px solid #e5e7eb;padding:.5rem 0}dt{color:#525b66;font-weight:500}dd{margin:0}dd pre{margin:0}.path{color:#525b66}.markdown table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}.markdown th,.markdown td{border:1px solid #c8ced6;padding:.5rem}blockquote{border-left:3px solid #a2abb7;padding-left:1rem}code{overflow-wrap:anywhere}li input{pointer-events:none}
.log-table{width:100%;table-layout:fixed;border-spacing:0;background:#fff;border:1px solid #dce1e7;border-radius:10px;margin:.6rem 0 1.5rem;text-align:left}.log-table caption{text-align:left;color:#525b66;margin:.4rem 0}.log-table th,.log-table td{padding:.65rem .75rem;vertical-align:top;border-bottom:1px solid #e5e7eb}.log-table th{color:#525b66;font-weight:500}.log-table th:nth-child(1){width:13%}.log-table th:nth-child(2){width:20%}.log-table th:nth-child(3){width:23%}.log-table th:nth-child(4){width:27%}.log-table th:nth-child(5){width:17%}.log-table tbody tr:last-child td{border-bottom:0}.log-table p{margin:.4rem 0}.log-table details{margin:.4rem 0 0}.event-time{font-variant-numeric:tabular-nums;color:#525b66}.event-input,.event-output{white-space:pre-wrap}.response-size,.numeric{font-variant-numeric:tabular-nums}.response-size{text-align:right;color:#525b66;margin:.35rem 0}#logs>article{margin:1.5rem 0}
@media(max-width:960px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.log-table,.log-table tbody,.log-table tr,.log-table td{display:block}.log-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.log-table tr{padding:.6rem 0}.log-table tr+tr{border-top:1px solid #c8ced6}.log-table td,.log-table tbody tr:last-child td{display:grid;grid-template-columns:7rem minmax(0,1fr);column-gap:1rem;border:0;padding:.35rem .75rem}.log-table td::before{content:attr(data-label);color:#525b66;grid-column:1;grid-row:1 / span 20}.log-table td>*{grid-column:2}.response-size{text-align:left}.log-table caption{display:block}}
@media(max-width:640px){main{padding:1.2rem 1rem 3rem}.metrics,.comparison,.finding-summary{grid-template-columns:1fr;gap:.75rem}.comparison>div+div{border-left:0;border-top:1px solid #dce1e7;padding:1rem 0 0}.finding-summary .badge{justify-self:start}dl{grid-template-columns:minmax(5rem,1fr) minmax(0,2fr);gap:0 .7rem}h1{font-size:1.4rem}.metadata{display:block}.metadata span{display:block}.log-table td{grid-template-columns:5.5rem minmax(0,1fr);column-gap:.65rem}}`;

function overview(data: ReportRecords, title: string) {
  const trial = data.result.trial;
  const judgment = trial?.judgment;
  const origin =
    trial?.provenance === 'display_sample'
      ? '表示サンプル'
      : trial?.provenance === 'live_model'
        ? '実モデル'
        : '不明';
  return `<header id="top"><p class="eyebrow">レビュー試験 · ${origin}</p><h1>レビュー試験の行動ログと評価</h1><p>評価対象: ${escape(title)}</p><div class="metadata"><span>対象: ${escape(data.result.name === 'defective' ? '既知欠陥例' : '正常例')} · 基準版 ${escape(data.result.baseCommit.slice(0, 12))}</span><span>実行開始（UTC）: ${escape(trial?.startedAt ?? '未記録・未確認')}</span><span>ホスト判断（UTC）: ${escape(judgment?.at ?? '未記録・未確認')}</span></div>${trial?.provenance === 'display_sample' ? '<p class="muted">モデルを呼ばない表示サンプルです。日時・判断・使用量も模擬値です。</p>' : trial?.provenance === 'live_model' ? '<p class="muted">合成課題を実モデルでレビューしたケース単位の記録です。</p>' : ''}<div id="criteria" class="question panel" tabindex="-1"><h3>問い</h3>${trial ? prose(trial.question) : '<p>適用した試験の問いは未記録・未確認</p>'}<h3>達成基準</h3>${trial ? prose(trial.criteria) : '<p>未記録・未確認（現在の基準を遡及適用しません）</p>'}</div>${usage(data)}<nav aria-label="レポート内の移動">${[
    ['results', '評価'],
    ['review', '指摘'],
    ['usage', '時間・使用量'],
    ['logs', '行動ログ'],
    ['records', '記録詳細'],
  ]
    .map(([id, label]) => link(id ?? '', label ?? ''))
    .join('')}</nav></header>`;
}

export async function renderReport(data: ReportRecords) {
  const evidence = trialEvidence(data);
  const title =
    isRecord(data.issue.value) && typeof data.issue.value.title === 'string'
      ? data.issue.value.title
      : data.result.id;
  const trial = data.result.trial;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>レビュー試験 — ${escape(title)}</title><style>${css}</style></head><body><main>${overview(data, title)}${attention(data, evidence)}${results(data, evidence)}${reviews(data)}${logs(data)}<section id="records" tabindex="-1"><h2>記録詳細</h2>${details('由来・日時・入力記録', `<dl>${field('由来', trial?.provenance)}${field('実行開始（UTC）', trial?.startedAt)}${field('実行終了（UTC）', trial?.finishedAt)}${field('ホスト判断（UTC）', trial?.judgment.at)}${field('HTML生成日時（評価日時ではありません）', new Date().toISOString())}</dl><p class="path">入力: ${escape(data.input.path)}</p>`)}${details('元の要求・対象・環境', requirements(data))}${recordView(data.input, 'result-record')}${recordView(data.state, 'state-record')}<article id="targets" tabindex="-1">${details('保存されたレビュー対象と関連記録', data.targets.map((entry, index) => recordView(entry, `target-${index}`)).join('') || '<p class="warning">保存対象記録がありません。</p>')}</article>${details('この表示で判断できる範囲', `<p>ハーネス全体の合否ではありません。試験用コードの失敗と、欠陥を正しく指摘するレビュー試験の成功は別です。モデル状態・制御終了・修正状況・真偽の裁定・試験の結論を区別します。表示側で合否・原因・証拠の対応やログ間の因果関係を補いません。現在のcheckout、oracleのパス先、別試行を過去の根拠として読み込まず、記録の真正性・完全性は保証しません。元記録を更新した場合は別名で再生成してください。状態変更・再実行・採点・承認・マージの操作はありません。</p>${data.result.limitations.map(prose).join('')}`)}<p>${link('top', '冒頭へ戻る')}</p></section></main></body></html>`;
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
