import { basename } from 'node:path';
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
  return `<section id="results" tabindex="-1"><h2>期待したこと / 実際に起きたこと</h2><div class="comparison"><div><h3>レビュー試験の基準</h3>${result.trial ? prose(result.trial.criteria) : '<p>未記録・未確認（現在の基準を遡及適用しません）</p>'}</div><div><h3>ホストの判断根拠</h3><p>${link('conclusion', '記録された結論と理由')}</p>${details('同じ試行の再現・裁定・対象・ログとの対応', `<ul>${result.trial?.judgment.evidence.map((ref) => `<li>${evidence.has(ref) ? link(evidence.get(ref) ?? '', ref) : `${escape(ref)} — 対応する証拠は未確認`}</li>`).join('') || '<li>対応は未記録・未確認</li>'}</ul>`)}</div></div><article id="reproduction" tabindex="-1"><h3>同じ対象の独立した再現</h3><div class="reproduction-input"><h4>入力</h4>${labeledValues(result.reproduction?.input)}</div><div class="comparison observations"><div><h4>期待値</h4>${labeledValues(result.reproduction?.expected)}</div><div><h4>実結果</h4>${labeledValues(result.reproduction?.actual)}</div></div>${details('再現記録の原JSON・全項目', raw(result.reproduction))}</article>${details('既知の欠陥・裁定記録', `<dl>${field('既知の欠陥', result.adjudication?.knownDefect)}${field('既知の欠陥の見落とし', result.adjudication?.missedKnownDefect)}</dl>${raw(result.adjudication)}`)}<p class="source-links">${link('requirements', '元の要求・対象・条件')} / ${link('targets', '保存されたレビュー対象')}</p></section>`;
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
  return `<article id="finding-${index}" class="finding" tabindex="-1"><div class="finding-summary"><h3>${escape(item.impact)}</h3><span class="badge ${verdict}">真偽の裁定: ${verdicts[verdict]}</span></div><p class="finding-location">${escape(item.location.path ?? '箇所は未記録')}${item.location.line === null ? '' : `:${escape(item.location.line)}`}</p>${details('条件・証拠・対応と裁定理由', `<dl>${field('指摘ID', item.id)}${field('修正状況', item.disposition)}${field('真偽の裁定（内部コード）', judgment?.verdict)}${field('観点 / 種別', `${item.area} / ${item.kind}`)}${field('必須対応', item.required)}${field('初出対象ID', item.introducedIn)}</dl>${bodies}${judgment ? `<h4>裁定の再現</h4>${labeledValues(judgment.reproduction)}<h4>裁定理由</h4>${judgment.reason ? prose(judgment.reason) : '<p>裁定理由は未記録です。</p>'}` : '<p>対応する裁定・再現は未記録です。</p>'}<p>${link('reproduction', 'ケースの再現（指摘との対応は記録で確認）')} / ${link('targets', '対象記録')} / ${link('logs', '呼出し・ツール実行の記録')}</p>`)}</article>`;
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

function usage(data: ReportRecords) {
  const { result } = data;
  const totals = result.usage?.totals;
  return `<section id="usage" tabindex="-1"><h2>時間・使用量</h2>${!totals ? '<p class="warning">使用量が未計測・欠落。品質と分けて費用比較を未確認にします。</p>' : ''}<dl>${field('実時間 (ms)', result.elapsedMs)}${field('モデル時間 (ms)', result.modelMs)}${field('入力トークン', totals?.input_tokens)}${field('キャッシュ入力トークン', totals?.cached_input_tokens)}${field('出力トークン', totals?.output_tokens)}${field('集計した完了ターン数', result.usage?.completedTurns)}${field('子モデルを含む総使用量', null)}${field('金額（未計測）', null)}</dl>${details('集計範囲・使用量の原記録', `${result.usage ? prose(result.usage.scope) : '<p>使用量の記録がありません。</p>'}<p>実時間とモデル時間は保存値です。使用量はレビューCLIの完了ターンを対象とし、中断したターンや子モデルを含む総量、契約上の課金額を確定するものではありません。トークンを再集計したり金額を推定したりしません。</p>${raw(result.usage)}`)}</section>`;
}

function logs(data: ReportRecords) {
  const events = data.timeline?.events ?? [];
  return `<section id="logs" tabindex="-1"><h2>実行ログ</h2>${details(
    '呼出し順と保存されたログを開く',
    `<p>制御呼出しはstate.eventsの保存順です。各JSONLはファイルの行順を保ちます。ランダム名のactorディレクトリ同士の実行順や、制御呼出しとの対応・因果関係は推測しません。全文検索は詳細を開いてから使ってください。</p>${
      events.length
        ? `<ol>${events
            .map(
              (event) =>
                `<li>${escape(event.role)} — code: ${escape(event.code ?? '未記録')}, timeout: ${escape(event.timedOut)}, ms: ${escape(event.ms ?? '未計測')}<p class="path">${escape(event.prefix)}</p>${data.logs
                  .map((entry, index) => ({ entry, index }))
                  .filter(({ entry }) =>
                    basename(entry.path).startsWith(`${basename(event.prefix)}.`),
                  )
                  .map(({ entry, index }) => link(`log-${index}`, basename(entry.path)))
                  .join(' / ')}</li>`,
            )
            .join('')}</ol>`
        : '<p class="warning">呼出し順序は未確認です。</p>'
    }${data.logs.map((entry, index) => recordView(entry, `log-${index}`)).join('')}`,
  )}</section>`;
}

const css = `
:root{color-scheme:light;font-family:system-ui,-apple-system,"Noto Sans JP",sans-serif;color:#252a30;background:#f7f8fa;line-height:1.75}
*{box-sizing:border-box;min-width:0}body{margin:0}main{max-width:1060px;margin:auto;padding:3rem 2rem 5rem}
header{padding-bottom:2rem}section{padding:2rem 0;border-top:1px solid #d9dde3}h1{font-size:1.8rem;line-height:1.45;letter-spacing:.01em;margin:.8rem 0}h2{font-size:1.25rem;margin:0 0 1.2rem}h3{font-size:1rem;margin:0 0 .8rem}h4{font-size:.9rem;color:#525b66;margin:0 0 .6rem}p{margin:.7rem 0}a{color:#275d92;text-underline-offset:.25em}a:focus-visible,summary:focus-visible{outline:3px solid #a04d0c;outline-offset:4px}nav{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;margin-top:1.4rem;font-size:.9rem}
.badge{display:inline-block;border:1px solid #c8ced6;border-radius:5px;background:#eef0f3;padding:.12rem .6rem;font-size:.82rem;font-weight:600;align-self:start}.demonstrated{color:#175b4a;background:#edf7f2;border-color:#b7d7c9}.false_positive{color:#8b312b;background:#fff0ef;border-color:#e1b9b5}.unconfirmed{color:#78501c;background:#fff6e7;border-color:#dfcaa7}
.question{max-width:52rem}.decision{margin:1.3rem 0;padding:1.2rem 1.5rem;background:#fff;border:1px solid #d9dde3;border-left:4px solid #657487;border-radius:5px}.decision[data-conclusion="met"]{border-left-color:#23715a}.decision[data-conclusion="unmet"],.decision[data-conclusion="execution_failed"]{border-left-color:#a04138}.decision[data-conclusion="pending"],.decision[data-conclusion="unknown"]{border-left-color:#916224}.eyebrow{font-size:.82rem;color:#525b66;margin:0}.conclusion{font-size:1.65rem;font-weight:700;line-height:1.45;margin:.35rem 0 .65rem}.decision .markdown p{margin:.4rem 0}.metadata{display:flex;flex-wrap:wrap;gap:.25rem 1.4rem;font-size:.82rem;color:#525b66}.muted,.source-links{font-size:.88rem;color:#525b66}
.attention-panel{padding:1rem 1.3rem;margin-bottom:1.5rem;background:#fff8ec;border:1px solid #e0cfae;border-radius:5px}.attention-panel h2{font-size:1rem;margin:0}.attention{padding-left:1.3rem;margin:.5rem 0}.attention li{margin:.4rem 0}.warning{color:#814415;font-weight:600}
.comparison{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:2rem}.comparison>div+div{border-left:1px solid #d9dde3;padding-left:2rem}.observations{background:#fff;border:1px solid #d9dde3;border-radius:5px;padding:1.1rem 1.3rem}.observations code{font-size:1.1rem}.reproduction-input{margin-bottom:1.2rem}.reproduction-input dl{margin:.5rem 0}.finding{padding:1.3rem 0;border-top:1px solid #d9dde3}.finding-summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem}.finding-summary h3{font-weight:600;margin:0}.finding-location{font-family:ui-monospace,monospace;font-size:.85rem;color:#525b66;margin:.4rem 0}.finding details{margin:.65rem 0 0}article{scroll-margin-top:1rem}#reproduction{border-top:1px solid #d9dde3;margin-top:1.4rem;padding-top:1.4rem}
details{margin:.9rem 0}summary{cursor:pointer;color:#3c4c5e;font-size:.9rem;font-weight:600;padding:.4rem 0}details[open]>summary{margin-bottom:.7rem}details details{margin-left:.8rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef0f3;padding:1rem;border-radius:4px;font-size:.82rem;line-height:1.6}p,li,dd,dt,h1,h2,h3,h4,summary,.path,span{overflow-wrap:anywhere}.recorded-text{white-space:pre-wrap}dl{display:grid;grid-template-columns:minmax(8rem,1fr) minmax(0,3fr);gap:0 1rem;margin:.6rem 0 1rem}dt,dd{border-bottom:1px solid #e5e7eb;padding:.55rem 0}dt{font-size:.88rem;color:#525b66;font-weight:500}dd{margin:0}dd pre{margin:0}.path{font-size:.8rem;color:#525b66}table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}th,td{border:1px solid #c8ced6;padding:.5rem}blockquote{border-left:3px solid #a2abb7;padding-left:1rem}code{overflow-wrap:anywhere}section{scroll-margin-top:1rem}li input{pointer-events:none}
@media(max-width:640px){main{padding:1.5rem 1rem 3rem}header{padding-bottom:1.5rem}section{padding:1.5rem 0}.comparison,.finding-summary{grid-template-columns:1fr;gap:1rem}.comparison>div+div{border-left:0;border-top:1px solid #d9dde3;padding:1rem 0 0}.finding-summary .badge{justify-self:start}.decision{padding:1rem}.attention-panel{padding:1rem}dl{grid-template-columns:minmax(5rem,1fr) minmax(0,2fr);gap:0 .7rem}h1{font-size:1.4rem}.conclusion{font-size:1.4rem}.metadata{display:block}.metadata span{display:block}}`;

function overview(data: ReportRecords, title: string) {
  const trial = data.result.trial;
  const judgment = trial?.judgment;
  const origin =
    trial?.provenance === 'display_sample'
      ? '表示サンプル'
      : trial?.provenance === 'live_model'
        ? '実モデル'
        : '不明';
  return `<header id="top"><p class="eyebrow">レビュー試験 · ${origin}</p><h1>${escape(title)}</h1><div class="question">${trial ? prose(trial.question) : '<p>何を確かめたか: 適用した試験の問いは未記録・未確認</p>'}</div><div id="conclusion" class="decision" data-conclusion="${judgment?.conclusion ?? 'unknown'}"><p class="eyebrow">このケースの結論 · ホストの記録</p><p class="conclusion">${judgment?.conclusion ? conclusions[judgment.conclusion] : '結論は未確認'}</p>${judgment?.reason ? prose(judgment.reason) : '<p class="muted">判断理由は未記録・未確認です。</p>'}</div><div class="metadata"><span>対象: ${escape(data.result.name === 'defective' ? '既知欠陥例' : '正常例')} · 基準版 ${escape(data.result.baseCommit.slice(0, 12))}</span><span>実行開始（UTC）: ${escape(trial?.startedAt ?? '未記録・未確認')}</span><span>ホスト判断（UTC）: ${escape(judgment?.at ?? '未記録・未確認')}</span></div>${trial?.provenance === 'display_sample' ? '<p class="muted">モデルを呼ばない表示サンプルです。日時・判断・使用量も模擬値です。</p>' : trial?.provenance === 'live_model' ? '<p class="muted">合成課題を実モデルでレビューしたケース単位の記録です。</p>' : ''}<nav aria-label="レポート内の移動">${[
    ['results', '期待・実結果'],
    ['review', '指摘'],
    ['usage', '時間・使用量'],
    ['logs', '実行ログ'],
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
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>レビュー試験 — ${escape(title)}</title><style>${css}</style></head><body><main>${overview(data, title)}${attention(data, evidence)}${results(data, evidence)}${reviews(data)}${usage(data)}${logs(data)}<section id="records" tabindex="-1"><h2>記録詳細</h2>${details('由来・日時・入力記録', `<dl>${field('由来', trial?.provenance)}${field('実行開始（UTC）', trial?.startedAt)}${field('実行終了（UTC）', trial?.finishedAt)}${field('ホスト判断（UTC）', trial?.judgment.at)}${field('HTML生成日時（評価日時ではありません）', new Date().toISOString())}</dl><p class="path">入力: ${escape(data.input.path)}</p>`)}${details('元の要求・対象・環境', requirements(data))}${recordView(data.input, 'result-record')}${recordView(data.state, 'state-record')}<article id="targets" tabindex="-1">${details('保存されたレビュー対象と関連記録', data.targets.map((entry, index) => recordView(entry, `target-${index}`)).join('') || '<p class="warning">保存対象記録がありません。</p>')}</article>${details('この表示で判断できる範囲', `<p>ハーネス全体の合否ではありません。試験用コードの失敗と、欠陥を正しく指摘するレビュー試験の成功は別です。モデル状態・制御終了・修正状況・真偽の裁定・試験の結論を区別します。表示側で合否・原因・証拠の対応やログ間の因果関係を補いません。現在のcheckout、oracleのパス先、別試行を過去の根拠として読み込まず、記録の真正性・完全性は保証しません。元記録を更新した場合は別名で再生成してください。状態変更・再実行・採点・承認・マージの操作はありません。</p>${data.result.limitations.map(prose).join('')}`)}<p>${link('top', '冒頭へ戻る')}</p></section></main></body></html>`;
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
