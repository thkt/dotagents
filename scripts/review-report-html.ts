import { basename } from 'node:path';
import type { ReviewItem } from './review.ts';
import type { ReportRecords, SavedRecord } from './review-report-records.ts';
import { isArray, isRecord } from './values.ts';

const escape = (value: unknown) => Bun.escapeHTML(String(value));
const raw = (value: unknown) => `<pre>${escape(JSON.stringify(value, null, 2) ?? '未記録')}</pre>`;
const prose = (text: string) =>
  `<div class="markdown">${Bun.markdown.html(text, { noHtmlBlocks: true, noHtmlSpans: true, headings: false })}</div>`;
const details = (title: string, html: string) =>
  `<details><summary>${escape(title)}</summary>${html}</details>`;
const link = (id: string, label: string) => `<a href="#${id}">${escape(label)}</a>`;
const field = (label: string, value: unknown) =>
  `<dt>${escape(label)}</dt><dd>${value === null || value === undefined ? '未記録・未確認' : escape(value)}</dd>`;
const jsonField = (label: string, value: unknown) =>
  `<h4>${escape(label)}</h4>${value === undefined ? '<p>未記録・未確認</p>' : raw(value)}`;

function additionContent(value: Record<string, unknown>) {
  if (typeof value.content !== 'string' || typeof value.symlink !== 'boolean') {
    return '<p class="warning">内容・symlinkの保存形式が不正で本文を表示できません。</p>';
  }
  if (value.symlink) {
    return `<p>symlinkの保存参照先（参照先の内容は読み込みません）: ${escape(value.content)}</p>`;
  }
  try {
    const bytes = Buffer.from(value.content, 'base64');
    if (bytes.toString('base64') !== value.content) {
      throw Error('base64の保存形式が不正です');
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
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

function additionsView(value: unknown) {
  if (!isArray(value)) {
    return '<p class="warning">追加ファイル一覧の形式が不正で本文を表示できません。</p>';
  }
  return value
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== 'string') {
        return '<p class="warning">追加ファイルのパスが不正で本文を表示できません。</p>';
      }
      return details(`追加ファイル: ${entry.path}`, additionContent(entry));
    })
    .join('');
}

function recordView(entry: SavedRecord, id: string) {
  const additions =
    !entry.problem && entry.path.endsWith('.additions.json') ? additionsView(entry.value) : '';
  return `<article id="${id}" tabindex="-1"><h3>${escape(basename(entry.path))}</h3><p class="path">${escape(entry.path)}</p>${entry.problem ? `<p class="warning">記録欠落・読取不能: ${escape(entry.problem)}</p>` : `${additions}${details('保存内容を開く', `<pre>${escape(entry.text)}</pre>`)}`}</article>`;
}

function attention(data: ReportRecords) {
  const { result, warnings } = data;
  const notices: string[] = [];
  if (result.stop !== 'ready_for_human_review') {
    notices.push(
      `${link('results', '制御上の停止・未完了')}: ${escape(result.stop ?? '終了理由未記録')}。原因は保存記録で確認してください。`,
    );
  }
  if (!result.review) {
    notices.push(`${link('review', 'レビュー未記録')}。判定・採点は確認できません。`);
  }
  if (!result.adjudication || result.adjudication.status === 'pending_host_adjudication') {
    notices.push(
      `${link('results', '裁定待ち・未判定')}。レビュー状態だけでは検出成功・欠陥なしを判断できません。`,
    );
  }
  if (!result.reproduction) {
    notices.push(
      `${link('reproduction', '再現記録がありません')}。期待値と実結果の照合は未確認です。`,
    );
  }
  if (!result.usage?.totals) {
    notices.push(`${link('usage', '使用量が未計測・欠落')}。ゼロとは扱いません。`);
  }
  for (const [index, item] of (result.review?.items ?? []).entries()) {
    const adjudication = result.adjudication?.findings.find((finding) => finding.id === item.id);
    notices.push(
      `${link(`finding-${index}`, item.id)} — 修正状況: ${escape(item.disposition)} / 真偽の裁定: ${escape(adjudication?.verdict ?? '未記録・未確認')} / 必須対応: ${item.required ? 'はい' : 'いいえ'}`,
    );
  }
  for (const warning of warnings) {
    notices.push(
      `${link('records', '記録の失敗・不足・対応の未確認')}: ${escape(warning.replaceAll(`${data.root}/`, ''))}`,
    );
  }
  return `<section aria-labelledby="attention-heading"><h2 id="attention-heading">人が確認する点</h2>${notices.length ? `<ul class="attention">${notices.map((notice) => `<li>${notice}</li>`).join('')}</ul>` : '<p>記録された指摘はありません。要求充足や欠陥なしを保証する表示ではありません。</p>'}<p>${link('reproduction', '再現入力・期待値・実結果')} → ${link('review', '指摘と判定理由')} → ${link('logs', '行動ログ')}</p><p>子モデルを含む総使用量は未確認、金額は未計測です。この記録形式には、要求・合格条件と個別の再現を結ぶ構造化された対応表はありません。要求本文と再現・指摘IDの裁定を照合し、明示のない対応は未確認としてください。表示側では合否・原因・対応関係を補いません。</p></section>`;
}

function requirements(data: ReportRecords) {
  const issue = data.issue.value;
  return `<section id="requirements" tabindex="-1"><h2>1. 課題・対象・実行条件</h2>${isRecord(issue) && typeof issue.body === 'string' ? prose(issue.body) : '<p class="warning">元の要求本文は未確認です。</p>'}<dl>${field('ケースID', data.result.id)}${field('ケースの記録名（採点ではありません）', data.result.name)}${field('基準版', data.result.baseCommit)}${field('レビュー対象ID', data.result.review?.targetId)}</dl>${recordView(data.issue, 'issue-record')}${recordView(data.environment, 'environment-record')}${recordView(data.cases, 'cases-record')}${recordView(data.config, 'config-record')}<p>${link('targets', '保存されたレビュー対象・差分・追加ファイルへ')}</p><p>現在のcheckoutや再生成した成果物を過去の判定の証拠として読み込みません。対象記録のID・hashと保存差分は参照できますが、元の全ファイル内容や個々の要求への対応表が揃っていることは保証しません。</p></section>`;
}

function results(data: ReportRecords) {
  const { result } = data;
  const adjudication = result.adjudication;
  return `<section id="results" tabindex="-1"><h2>2. 結果と根拠</h2><dl>${field('制御上の終了理由', result.stop)}${field('モデルのレビュー状態', result.review?.status)}${field('ホストの裁定状態', adjudication?.status)}${field('既知の欠陥（記録値）', adjudication?.knownDefect)}${field('既知の欠陥の見落とし（記録値）', adjudication?.missedKnownDefect)}</dl><p>accepted は「欠陥なし」、needs_changes は「検出成功」を意味しません。fixed / not_applicable は修正状況であり、demonstrated / false_positive / unconfirmed の真偽の裁定とは別です。</p><article id="reproduction" tabindex="-1"><h3>独立した再現</h3>${jsonField('入力', result.reproduction?.input)}${jsonField('期待値', result.reproduction?.expected)}${jsonField('実結果', result.reproduction?.actual)}${details('再現記録の全項目', raw(result.reproduction))}<p>このケースに保存された観測です。各指摘との対応は下のID別裁定で確認し、対応がなければ未確認とします。oracleや対象ソースのパスは記録値であり、そこにある現在のファイルで過去の判定を裏づけません。</p></article>${details('裁定記録の全項目・指示', raw(adjudication))}<p>${link('review', '指摘別の裁定と根拠へ')} / ${link('targets', '同じ対象IDの保存記録へ')}</p></section>`;
}

function findingView(item: ReviewItem, index: number, data: ReportRecords) {
  const judgment = data.result.adjudication?.findings.find((entry) => entry.id === item.id);
  const bodies = [
    ['発生条件', item.condition],
    ['影響', item.impact],
    ['証拠', item.evidence],
    ['対応案', item.action],
    ['修正状況の理由・未確認事項', item.reason],
  ]
    .map(([label, text]) => `<h4>${escape(label)}</h4>${prose(text ?? '')}`)
    .join('');
  return `<article id="finding-${index}" tabindex="-1"><h3>${escape(item.id)}</h3><dl>${field('修正状況', item.disposition)}${field('真偽の裁定', judgment?.verdict)}${field('観点 / 種別', `${item.area} / ${item.kind}`)}${field('必須対応', item.required)}${field('箇所', item.location.path)}${field('行', item.location.line)}${field('初出対象ID', item.introducedIn)}</dl>${details('指摘の条件・影響・証拠・対応案を開く', bodies)}${judgment ? details('この指摘の裁定根拠を開く', `${jsonField('再現', judgment.reproduction)}${judgment.reason ? prose(judgment.reason) : '<p>裁定理由は未記録です。</p>'}`) : '<p class="warning">対応する裁定・再現は未記録です。</p>'}<p>${link('reproduction', 'ケースの再現（指摘との対応は記録で確認）')} / ${link('targets', '対象記録')} / ${link('logs', '呼出し・ツール実行の記録')}</p></article>`;
}

function reviews(data: ReportRecords) {
  const review = data.result.review;
  return `<section id="review" tabindex="-1"><h2>3. レビューの詳細</h2>${
    review
      ? `${prose(review.findings)}${review.items.length ? review.items.map((item, index) => findingView(item, index, data)).join('') : '<p>記録された指摘: 0件。指摘なしは欠陥なしの証明ではありません。</p>'}${details(
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
  return `<section id="usage" tabindex="-1"><h2>4. 時間・使用量・費用</h2><dl>${field('実時間 (ms)', result.elapsedMs)}${field('モデル時間 (ms)', result.modelMs)}${field('入力トークン', totals?.input_tokens)}${field('キャッシュ入力トークン', totals?.cached_input_tokens)}${field('出力トークン', totals?.output_tokens)}${field('集計した完了ターン数', result.usage?.completedTurns)}${field('子モデルを含む総使用量', null)}${field('金額（未計測）', null)}</dl><h3>記録された集計範囲</h3>${result.usage ? prose(result.usage.scope) : '<p>使用量の記録がありません。</p>'}<p>実時間とモデル時間は保存値です。使用量はレビューCLIの完了ターンを対象とし、中断したターンや子モデルを含む総量、契約上の課金額を確定するものではありません。トークンを再集計したり金額を推定したりしません。</p>${details('使用量の全記録', raw(result.usage))}</section>`;
}

function logs(data: ReportRecords) {
  const events = data.timeline?.events ?? [];
  return `<section id="logs" tabindex="-1"><h2>5. 行動ログ</h2><p>制御呼出しはstate.eventsの保存順です。各JSONLはファイルの行順を保ちます。ランダム名のactorディレクトリ同士の実行順や、制御呼出しとの対応・因果関係は推測しません。全文検索は詳細を開いてから使ってください。</p>${
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
  }${data.logs.map((entry, index) => recordView(entry, `log-${index}`)).join('')}</section>`;
}

const css = `
:root{color-scheme:light;font-family:system-ui,-apple-system,sans-serif;color:#172b3a;background:#eef2f5;line-height:1.7}
*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:2rem 1.2rem 5rem}header,section{background:#fff;border:1px solid #c9d3dc;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
header{border-top:6px solid #245778}h1{font-size:1.85rem;line-height:1.4}h2{font-size:1.4rem}h3{font-size:1.1rem}h4{margin-bottom:.4rem}a{color:#164c83;text-underline-offset:.2em}a:focus-visible,summary:focus-visible{outline:3px solid #ae4700;outline-offset:4px}nav{display:flex;flex-wrap:wrap;gap:1rem}article{border-top:1px solid #d4dce3;margin-top:1.5rem;padding-top:1rem}details{margin:1rem 0;border:1px solid #c9d3dc;border-radius:6px;padding:.7rem 1rem}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f4f6;padding:1rem;border-radius:4px;font-size:.88rem}p,li,dd,.path{overflow-wrap:anywhere}dt{font-weight:600}dd{margin:0 0 .6rem}dl{display:grid;grid-template-columns:minmax(10rem,1fr) 3fr;gap:.4rem 1rem}.attention{border-left:4px solid #a24a08;padding-left:1.6rem}.attention li{margin:.6rem 0}.warning{color:#7c3300;font-weight:600}.path{font-size:.85rem;color:#465c6d}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #c9d3dc;padding:.5rem}blockquote{border-left:3px solid #839baa;padding-left:1rem}code{overflow-wrap:anywhere}section,article{scroll-margin-top:1rem}li input{pointer-events:none}@media(max-width:640px){main{padding:.8rem}header,section{padding:1rem}dl{display:block}dd{margin-bottom:1rem}h1{font-size:1.5rem}}`;

export async function renderReport(data: ReportRecords) {
  const title =
    isRecord(data.issue.value) && typeof data.issue.value.title === 'string'
      ? data.issue.value.title
      : data.result.id;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escape(title)} — 評価記録</title><style>${css}</style></head><body><main><header id="top"><p>保存済みの評価記録 / 読み取り専用</p><h1>${escape(title)}</h1><p>ケース: ${escape(data.result.id)} / 制御: <strong>${escape(data.result.stop ?? '未記録')}</strong> / レビュー: <strong>${escape(data.result.review?.status ?? '未記録')}</strong> / 裁定: <strong>${escape(data.result.adjudication?.status ?? '未記録')}</strong></p><p class="path">入力: ${escape(data.input.path)}<br>生成時刻: ${escape(new Date().toISOString())}</p><p>生成時点の表示です。元記録を更新した場合は別の出力名で再生成してください。状態変更・再実行・承認・マージの操作はありません。</p><nav aria-label="レポート内の移動">${[
    ['requirements', '要求・対象'],
    ['results', '結果・再現'],
    ['review', '指摘'],
    ['usage', '時間・使用量'],
    ['logs', '行動ログ'],
  ]
    .map(([id, label]) => link(id ?? '', label ?? ''))
    .join(
      '',
    )}</nav></header>${attention(data)}${requirements(data)}${results(data)}${reviews(data)}${usage(data)}${logs(data)}<section id="records" tabindex="-1"><h2>入力記録と不足</h2>${data.warnings.length ? `<ul>${data.warnings.map((warning) => `<li class="warning">${escape(warning)}</li>`).join('')}</ul>` : '<p>読取時に関連記録の欠落は検出されませんでした。記録の真正性・完全性の証明ではありません。</p>'}${recordView(data.input, 'result-record')}${recordView(data.state, 'state-record')}<article id="targets" tabindex="-1"><h3>保存されたレビュー対象と関連記録</h3>${data.targets.map((entry, index) => recordView(entry, `target-${index}`)).join('') || '<p class="warning">保存対象記録がありません。</p>'}</article><h3>記録された限界</h3>${data.result.limitations.map(prose).join('')}<p>${link('top', '冒頭へ戻る')}</p></section></main></body></html>`;
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
