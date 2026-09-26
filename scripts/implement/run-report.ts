import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { parseRunResult } from './run-result.ts';
import type { RunResult } from './run-result.ts';
import { assertState } from './input.ts';
import type { State } from './input.ts';
import { isRecord } from '../shared/values.ts';
import type { Review } from './review.ts';
import { commandInputs } from './command-inputs.ts';

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
const shown = (value: string | undefined) => escape(value?.trim() || '未記録');
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const quote = (value: string) => `<code>${escape(value)}</code>`;
const excerpt = (value: string, limit = 900) =>
  value.length > limit
    ? `${escape(value.slice(0, limit))}\n…画面上の抜粋（全${value.length}文字。原記録を参照）`
    : escape(value);

async function file(path: string) {
  return (await availableFile(path)) ? readFile(path, 'utf8') : undefined;
}

async function availableFile(path: string) {
  try {
    const info = await lstat(path);
    assert(info.isFile(), `Expected regular file: ${path}`);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function localLink(root: string, path: string, label: string) {
  const rel = relative(root, path);
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
  return `<a href="./${rel.split(sep).map(encodeURIComponent).join('/')}">${escape(label)}</a>`;
}

function externalLink(url: string | undefined, label: string) {
  if (!url) {
    return shown(undefined);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      return `<a href="${escape(parsed.href)}" rel="noreferrer">${escape(label)}</a>`;
    }
  } catch {
    // Saved text is shown without making an unsafe link.
  }
  return shown(url);
}

function detail(label: string, content: string) {
  return `<details><summary>${escape(label)}</summary><div class="detail-body">${content}</div></details>`;
}

function eventDetail(
  label: string,
  status: string,
  content: string,
  metadata: { preview?: string; line?: number } = {},
) {
  const source =
    metadata.line === undefined
      ? ''
      : `<span class="event-source">原記録：${metadata.line}行目</span>`;
  return `<details class="event-disclosure"><summary><span class="event-heading"><span class="event-title">${escape(label)}</span>${source}${metadata.preview ?? ''}</span><span class="event-status">${escape(status)}</span><span class="event-chevron" aria-hidden="true">›</span></summary><div class="event-body">${content}</div></details>`;
}

function inputFiles(command: string) {
  const { paths, partial } = commandInputs(command);
  const names = paths.map((path) => basename(path));
  const labels = paths.map((path, index) => {
    const name = names[index] ?? path;
    const duplicate = names.indexOf(name) !== names.lastIndexOf(name);
    return `<span class="input-file" tabindex="0">${quote(name)}${duplicate ? `<span class="input-directory">${escape(dirname(path))}/</span>` : ''}</span>`;
  });
  const status = paths.length ? (partial ? '一部のみ抽出' : 'commandから抽出') : '抽出できず';
  return {
    preview: `<span class="command-inputs"><span class="input-caption">入力ファイル候補 · ${status}</span>${labels.join('')}</span>`,
    body: `<section class="command-paths"><h4>入力ファイル候補 · 保存commandのパス</h4><p class="muted">静的に抽出した候補です。実際の読み込み成功やモデルの理解は未確認です。未対応の構文や標準入力などは抽出できず、入力ファイルがないとは限りません。相対パスは解決していません。</p>${paths.length ? `<ul>${paths.map((path) => `<li>${quote(path)}</li>`).join('')}</ul>` : '<p>抽出できず。元のcommandと原記録を確認してください。</p>'}</section>`,
  };
}

function ioPanel(label: string, content: string, kind: 'input' | 'output' | 'neutral') {
  return `<section class="io-panel ${kind}-panel"><h4>${escape(label)}</h4><div>${content}</div></section>`;
}

function field(label: string, value: string) {
  return `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function optionalEvidence(root: string, path: string, warnings: string[]) {
  try {
    return await file(path);
  } catch (error) {
    warnings.push(`${relative(root, path)}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function safeAvailable(root: string, path: string, warnings: string[]) {
  try {
    return await availableFile(path);
  } catch (error) {
    warnings.push(`${relative(root, path)}: ${errorMessage(error)}`);
    return false;
  }
}

const eventStatuses = new Map([
  ['item.started', '開始 · 結果未確認'],
  ['item.updated', '更新 · 結果未確認'],
  ['item.completed', '完了イベント · 成否未確認'],
  ['turn.failed', '失敗の記録'],
  ['error', '失敗の記録'],
]);

function genericEvent(
  event: unknown,
  item: Record<string, unknown> | undefined,
  index: number,
  raw: string,
) {
  const kind = isRecord(event) && typeof event.type === 'string' ? event.type : '種類不明';
  const operation = item?.type === 'mcp_tool_call' ? 'MCPツール' : (text(item?.type) ?? kind);
  const status = eventStatuses.get(kind) ?? '記録されたイベント';
  return eventDetail(
    operation,
    status,
    `<p class="muted">入出力の区分は未確認です。保存された行の抜粋です。</p>${ioPanel('イベント原文 · 抜粋', `<pre>${excerpt(raw)}</pre>`, 'neutral')}`,
    { line: index + 1 },
  );
}

function actorAction(event: unknown, index: number, raw: string) {
  const item = isRecord(event) && isRecord(event.item) ? event.item : undefined;
  if (isRecord(event) && item?.type === 'command_execution') {
    const command = text(item.command) ?? '未記録';
    const files = inputFiles(command);
    const exit =
      typeof item.exit_code === 'number' ? `終了コード ${item.exit_code}` : '終了コード未記録';
    return eventDetail(
      'コマンド実行',
      event.type === 'item.completed' ? exit : (eventStatuses.get(text(event.type) ?? '') ?? exit),
      `${files.body}<div class="io-grid">${ioPanel('入力 · command', `<pre>${excerpt(command)}</pre>`, 'input')}${ioPanel('出力 · aggregated_output', `<pre>${excerpt(text(item.aggregated_output) ?? '未記録')}</pre>`, 'output')}</div>`,
      { preview: files.preview, line: index + 1 },
    );
  }
  if (
    isRecord(event) &&
    event.type === 'item.completed' &&
    item?.type === 'agent_message' &&
    typeof item.text === 'string'
  ) {
    return eventDetail(
      'モデルの応答',
      '完了イベント',
      `<div class="io-grid">${ioPanel('入力', '<p class="muted">このイベントには入力の保存値がありません。</p>', 'input')}${ioPanel('出力 · text', `<pre>${excerpt(item.text)}</pre>`, 'output')}</div>`,
      { line: index + 1 },
    );
  }
  return genericEvent(event, item, index, raw);
}

async function actorLogGroup(root: string, path: string, name: string, warnings: string[]) {
  const raw = await optionalEvidence(root, path, warnings);
  if (raw === undefined) {
    return undefined;
  }
  const lines = raw.split('\n');
  const actions = lines.flatMap((line, index) => {
    if (!line) {
      return [];
    }
    try {
      return [actorAction(JSON.parse(line) as unknown, index, line)];
    } catch (error) {
      warnings.push(`${relative(root, path)}:${index + 1}: ${errorMessage(error)}`);
      return [];
    }
  });
  return `<section class="actor-group"><header><h4>モデル側 · ${escape(name)}</h4><p>${actions.length}/${lines.filter(Boolean).length}行表示（空行を除く、このログ内の順序）。${localLink(root, path, 'イベント原記録を開く')}。「原記録」はこの保存イベントログの行位置です。画面の長文は抜粋です。</p></header><div class="activity-list">${actions.join('') || '<p>表示対象のイベントは未記録です。</p>'}</div></section>`;
}

type EntryCache = Map<string, Promise<Dirent<string>[]>>;

function directoryEntries(root: string, directory: string, warnings: string[], cache: EntryCache) {
  let pending = cache.get(directory);
  if (!pending) {
    pending = readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        warnings.push(`${relative(root, directory) || '.'}: ${errorMessage(error)}`);
      }
      return [];
    });
    cache.set(directory, pending);
  }
  return pending;
}

async function actorEvents(root: string, directory: string, warnings: string[], cache: EntryCache) {
  const entries = await directoryEntries(root, directory, warnings, cache);
  const groups = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && /^(repair|review)-codex-[A-Za-z0-9]+$/.test(entry.name),
      )
      .map((entry) =>
        actorLogGroup(root, join(directory, entry.name, 'events.jsonl'), entry.name, warnings),
      ),
  );
  return groups.filter((group) => group !== undefined);
}

const hostRoles = new Map([
  ['check', '検証'],
  ['review', 'レビュー依頼'],
  ['repair', '修正依頼'],
  ['capture', '撮影'],
]);

function hostStatus(code: number | null, timedOut: boolean) {
  return timedOut ? '時間切れ' : `終了コード ${code ?? '未記録'}`;
}

async function hostEventRows(
  root: string,
  events: { role: string; code: number | null; timedOut: boolean; prefix: string }[],
  warnings: string[],
  known: Map<string, boolean>,
) {
  return Promise.all(
    events.map(async (event, index) => {
      const prefix = resolve(event.prefix);
      const output = relative(root, `${prefix}.stdout`);
      const within = output && output !== '..' && !output.startsWith(`..${sep}`);
      const stdout = within && (await safeAvailable(root, `${prefix}.stdout`, warnings));
      const stderr = within && (await safeAvailable(root, `${prefix}.stderr`, warnings));
      if (within) {
        known.set(`${prefix}.stdout`, Boolean(stdout));
        known.set(`${prefix}.stderr`, Boolean(stderr));
      }
      const code = event.code === null ? '未記録' : String(event.code);
      const logs = `<dl>${field('ログ保存先の接頭辞', quote(event.prefix))}${field('終了コード', escape(code))}${field('時間切れ', event.timedOut ? '記録あり' : 'なし')}${field('stdout', stdout ? localLink(root, `${prefix}.stdout`, '保存ログを開く') : '未記録')}${field('stderr', stderr ? localLink(root, `${prefix}.stderr`, '保存ログを開く') : '未記録')}</dl>`;
      return eventDetail(
        `${index + 1} · ホスト · ${hostRoles.get(event.role) ?? event.role}`,
        hostStatus(event.code, event.timedOut),
        ioPanel('ホストの保存記録', logs, 'neutral'),
      );
    }),
  );
}

async function recordRows(
  root: string,
  known: Map<string, boolean>,
  warnings: string[],
  cache: EntryCache,
  details?: string,
) {
  const records = await Promise.all(
    ['', 'verification'].map(async (part) => {
      const directory = join(root, part);
      return (await directoryEntries(root, directory, warnings, cache))
        .filter((entry) => entry.isFile() && entry.name !== 'report.html')
        .map((entry) => join(directory, entry.name));
    }),
  );
  const fixed = [
    'result.json',
    'target.json',
    'issue.json',
    'implementation-summary.md',
    'verification/state.json',
  ].map((name) => join(root, name));
  const detailPath = details ? resolve(details) : '';
  const rel = relative(root, detailPath);
  const inside = rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
  const detailFiles =
    inside && /^(setup-\d+|implementation|push|pr-publication|pr-draft)$/.test(basename(detailPath))
      ? [`${detailPath}.stdout`, `${detailPath}.stderr`]
      : [];
  const paths = new Set([...fixed, ...detailFiles, ...records.flat()]);
  return Promise.all(
    [...paths].map(async (path) => {
      const exists = known.get(path) ?? (await safeAvailable(root, path, warnings));
      const name = relative(root, path);
      return `<li>${exists ? localLink(root, path, name) : `<code>${escape(name)}</code><span class="muted">未記録</span>`}</li>`;
    }),
  );
}

function reviewSection(review: Review | undefined) {
  if (!review) {
    return '<p>未記録</p>';
  }
  const items = review.items.map((item) =>
    eventDetail(
      `指摘 ${item.id} · ${item.condition.slice(0, 72)}${item.condition.length > 72 ? '…' : ''}`,
      { open: '要対応', fixed: '修正済み', not_applicable: '対象外' }[item.disposition],
      `<dl class="finding-fields">${field('条件', shown(item.condition))}${field('影響', shown(item.impact))}${field('根拠', shown(item.evidence))}${field('対応', shown(item.action))}${field('裁定理由', shown(item.reason))}</dl>`,
    ),
  );
  const status = review.status === 'accepted' ? '修正必須の指摘なし' : '修正が必要';
  return `<p class="review-summary">評価結果: <strong>${status}</strong>（${shown(review.status)}）。${shown(review.findings)}</p><div class="actor-group"><div class="activity-list">${items.join('') || '<p class="empty-list">指摘なし</p>'}</div></div>`;
}

function publicationSection(result: RunResult) {
  return `<dl class="summary-fields">${field('公開状態', shown(result.publication))}${field('commit', result.commit ? quote(result.commit) : '未記録')}${field('PR', externalLink(result.url, result.url ?? ''))}${field('CI', shown(result.ci))}</dl>${result.ciDetails === undefined ? '' : detail('CIの保存結果', `<pre>${excerpt(JSON.stringify(result.ciDetails, null, 2), 3000)}</pre>`)}<p class="muted">GitHubの現在状態ではなく、run終了時の保存記録です。</p>`;
}

function activitySection(
  root: string,
  summary: string | undefined,
  hostEvents: string[],
  actors: string[],
) {
  const workSummary =
    summary === undefined
      ? '<p>未記録</p>'
      : `<pre>${excerpt(summary, 3000)}</pre>${localLink(root, join(root, 'implementation-summary.md'), '要約の原記録を開く')}`;
  return `<p class="muted">ホストの保存イベントを順に示します。モデル内の操作は各イベントログ内の順序のみを示し、別ログ間の全体順序は推定しません。</p><h3>ホスト工程</h3><div class="actor-group"><div class="activity-list">${hostEvents.join('') || '<p class="empty-list">検証イベントは未記録です。</p>'}</div></div><h3 style="margin-top:24px">実装担当の要約</h3>${workSummary}<h3 style="margin-top:24px">モデルのツール実行・イベント</h3>${actors.join('') || '<p>表示対象のモデルイベントは未記録です。</p>'}`;
}

function reportState(rawState: string | undefined, warnings: string[]) {
  let state: State | undefined;
  if (rawState !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawState) as unknown;
    } catch (error) {
      warnings.push(`verification/state.json: ${errorMessage(error)}`);
    }
    if (parsed !== undefined) {
      assert(
        isRecord(parsed) && parsed.reviewFormat === 4 && parsed.issueFormat === 1,
        'Unsupported verification state format',
      );
      try {
        assertState(parsed);
        state = parsed;
      } catch (error) {
        warnings.push(`verification/state.json: ${errorMessage(error)}`);
      }
    }
  }
  return state;
}

async function render(runDir: string) {
  const rawResult = await file(join(runDir, 'result.json'));
  assert(rawResult !== undefined, 'Missing result.json');
  const result = parseRunResult(JSON.parse(rawResult) as unknown);
  const verification = join(runDir, 'verification');
  const warnings: string[] = [];
  const statePath = join(verification, 'state.json');
  const rawState = await optionalEvidence(runDir, statePath, warnings);
  const state = reportState(rawState, warnings);
  const summaryPath = join(runDir, 'implementation-summary.md');
  const summary = await optionalEvidence(runDir, summaryPath, warnings);
  const known = new Map([
    [join(runDir, 'result.json'), true],
    [statePath, rawState !== undefined],
    [summaryPath, summary !== undefined],
  ]);
  const cache: EntryCache = new Map();
  const hostEvents = await hostEventRows(runDir, state?.events ?? [], warnings, known);
  const review = state?.reviewHistory.at(-1);
  const actors = [
    ...(await actorEvents(runDir, runDir, warnings, cache)),
    ...(rawState === undefined ? [] : await actorEvents(runDir, verification, warnings, cache)),
  ];
  const recordLinks = await recordRows(runDir, known, warnings, cache, result.details);
  const status = {
    stopped: '停止',
    verified_local: 'ローカル検証済み',
    published_draft: 'Draft公開・CI確認済み',
  }[result.status];
  const generatedAt = new Date().toISOString();
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>実装runの記録 · ${escape(status)}</title><style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#23272e;background:#f6f7f9;line-height:1.6}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:36px 28px 90px}h1{font-size:30px;line-height:1.25;margin:12px 0}h2{font-size:21px;margin:0 0 14px}h3{font-size:17px;margin:0 0 10px}p{margin:8px 0 12px}.eyebrow{font-size:13px;color:#636e7d;font-weight:650;letter-spacing:.05em}.lead{font-size:16px;color:#566170}.pill{display:inline-block;background:#e8edf8;color:#263f75;border-radius:999px;padding:4px 12px;font-size:13px;font-weight:700}.pill.stopped{background:#fff0e5;color:#93480f}.section{margin-top:28px}.card{background:#fff;border:1px solid #dce1e7;border-radius:14px;padding:24px;box-shadow:0 1px 3px #1c26320d}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:0}dt{font-size:12px;color:#647080;font-weight:650}dd{margin:3px 0 0;overflow-wrap:anywhere;font-size:14px}code,pre{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7fa;border:1px solid #e2e6ec;border-radius:8px;padding:12px;max-height:330px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #e5e8ec;vertical-align:top;overflow-wrap:anywhere}th{color:#596474;font-weight:650}a{color:#2359a2}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible{outline:3px solid #5b78c5;outline-offset:3px}details{border:1px solid #dce1e7;border-radius:10px;background:#fff;margin-top:10px;overflow:hidden}summary{cursor:pointer;padding:14px 18px;font-weight:650}summary:hover{background:#f5f7fa}.detail-body{border-top:1px solid #dce1e7;padding:16px 18px}.detail-body details{margin:10px 0}.io-label{font-size:12px;font-weight:700;margin:12px 0 5px}.input{color:#305fa4}.output{color:#14735a}.muted{color:#687484}.table-wrap{overflow-x:auto}@media(max-width:700px){main{padding:22px 16px 60px}.grid,dl{grid-template-columns:1fr}.card{padding:18px}h1{font-size:25px}}
.actor-group{margin-top:16px;border:1px solid #dce1e7;border-radius:10px;overflow:hidden;background:#fff}.actor-group>header{padding:18px 20px;border-bottom:1px solid #dce1e7}.actor-group>header h4{margin:0;font-size:15px}.actor-group>header p{margin:5px 0 0;font-size:13px;color:#687484}.activity-list>.event-disclosure{margin:0;border:0;border-radius:0}.activity-list>.event-disclosure+.event-disclosure{border-top:1px solid #dce1e7}.event-disclosure>summary{display:grid;grid-template-columns:minmax(0,1fr) auto 18px;align-items:center;gap:12px;padding:17px 20px;list-style:none;font-size:14px;text-decoration:none}.event-disclosure>summary::-webkit-details-marker{display:none}.event-disclosure>summary:hover{background:#f6f7f9;text-decoration:none}.event-disclosure>summary:hover .event-title{text-decoration:underline;text-underline-offset:4px}.event-disclosure>summary:focus-visible{outline-offset:-4px}.event-disclosure[open]>summary{background:#f6f7f9}.event-status{border:1px solid #dce1e7;border-radius:5px;padding:2px 8px;background:#fff;color:#596474;font-size:12px;font-weight:500}.event-chevron{font-size:20px;line-height:1;justify-self:end;color:#687484}.event-disclosure[open] .event-chevron{transform:rotate(90deg)}.event-body{border-top:1px solid #dce1e7;background:#fafbfc;padding:20px}.event-body>.muted:first-child{margin-top:0}.io-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.io-panel{border:1px solid #dce1e7;border-radius:8px;background:#fff;overflow:hidden}.io-panel>h4{margin:0;padding:10px 14px;font-size:13px;border-bottom:1px solid}.io-panel>div{padding:14px;min-width:0}.io-panel pre{margin:0;background:#fff;border:0;padding:0}.input-panel{border-color:#c7d8f4}.input-panel>h4{background:#eef5ff;color:#215ba4;border-color:#c7d8f4}.output-panel{border-color:#dacdf0}.output-panel>h4{background:#f5effb;color:#6d43a0;border-color:#dacdf0}.neutral-panel>h4{background:#f6f7f9;color:#596474;border-color:#dce1e7}@media(max-width:700px){.io-grid{grid-template-columns:1fr}.event-disclosure>summary{grid-template-columns:minmax(0,1fr) 18px}.event-status{grid-column:1;grid-row:2;justify-self:start}.event-chevron{grid-column:2;grid-row:1}}
.empty-list{padding:16px 20px}.finding-fields{display:block}.finding-fields>div+div{border-top:1px solid #e2e6ec;padding-top:12px;margin-top:12px}.finding-fields dt{font-size:12px}.finding-fields dd{font-size:14px;white-space:pre-wrap}.record-list{list-style:none;margin:0;padding:0;border:1px solid #dce1e7;border-radius:10px;overflow:hidden}.record-list li{padding:11px 16px;overflow-wrap:anywhere}.record-list li+li{border-top:1px solid #e5e8ec}.record-list .muted{margin-left:12px;font-size:12px}
.command-inputs{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;font-weight:400;min-width:0}.input-caption{flex-basis:100%;font-size:12px;color:#596474}.input-file{display:inline-flex;align-items:baseline;gap:8px;min-width:0;max-width:100%;border:1px solid #c7d8f4;border-radius:5px;background:#eef5ff;padding:3px 8px;white-space:nowrap;overflow-x:auto}.input-file>*{flex-shrink:0}.input-file:focus-visible{outline:3px solid #5b78c5;outline-offset:-3px}.input-directory{font-size:11px;color:#596474}.command-paths{margin-bottom:18px}.command-paths h4{margin:0}.command-paths p{font-size:13px}.command-paths ul{padding-left:22px}.command-paths code{white-space:pre-wrap}.input-file code{white-space:inherit}.event-heading{min-width:0;overflow-wrap:anywhere}
.event-source{display:block;margin-top:3px;font-size:12px;font-weight:400;color:#687484}.summary-fields{display:block}.summary-fields>div{padding:12px 0}.summary-fields>div:first-child{padding-top:0}.summary-fields>div:last-child{padding-bottom:0}.summary-fields>div+div,.result-note{border-top:1px solid #e2e6ec}.result-note{margin-top:18px;padding-top:18px}.review-summary{white-space:pre-wrap}
</style></head><body><main><header><div class="eyebrow">IMPLEMENT / 1 RUN</div><h1>実装runの記録</h1><span class="pill ${escape(result.status)}">${escape(status)}</span><p class="lead">保存された事実と未確認事項を、この実行単位で示します。HTML生成は検証や公開を再実行しません。</p></header>
<section class="section card"><h2>今回の結果</h2><dl class="summary-fields">${field('Issue', externalLink(result.issue, result.issue))}${field('対象repo', shown(result.repository))}${field('開始commit', quote(result.startCommit))}${field('開始日時 · UTC', shown(result.startedAt))}${field('終了日時 · UTC', shown(result.finishedAt))}${field('HTML生成日時 · UTC', shown(generatedAt))}${field('終了状態', escape(status))}${field('最終工程', `${shown(result.phase)} / ${shown(result.operation)}`)}</dl><div class="result-note"><h3>停止理由・結果</h3><p>${shown(result.reason)}</p></div><div class="result-note"><h3>次の対応</h3><p>${shown(result.nextAction)}</p><p class="muted">残る作業: ${result.remaining.length ? result.remaining.map(escape).join('、') : '記録なし'}。人の承認・マージは、このrunの結果に含みません。</p></div></section>
${warnings.length ? `<section class="section card"><h2>関連記録の注意</h2><p>読めた結果は保持しました。次の記録は未確認です。原記録を確認してください。</p><ul>${warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul></section>` : ''}
<div class="grid section"><section class="card"><h2>検証と評価</h2><dl class="summary-fields">${field('ホストcheck', state ? `${state.checks}回記録` : '未記録')}${field('独立評価', review ? shown(review.status) : '未記録')}${field('検証終端', state ? shown(state.result ?? undefined) : '未記録')}${field('評価指摘', review ? `${review.items.length}件` : '未記録')}</dl><p class="muted">acceptedは公開後確認や人の承認を意味しません。</p></section><section class="card"><h2>公開の記録</h2>${publicationSection(result)}</section></div>
<section class="section card"><h2>行動ログ</h2>${activitySection(runDir, summary, hostEvents, actors)}</section>
<section class="section card"><h2>独立評価の指摘</h2>${reviewSection(review)}</section>
<section class="section card"><h2>原記録</h2><p class="muted">入力・出力の全文と証拠は保存ファイルで確認してください。画面の抜粋は全コンテキストではありません。</p><ul class="record-list">${recordLinks.join('')}</ul></section>
</main></body></html>`;
}

export async function writeRunReport(runDir: string, output = join(runDir, 'report.html')) {
  const root = resolve(runDir);
  const destination = resolve(output);
  assert(
    dirname(destination) === root && destination.endsWith('.html'),
    'Report output must be an HTML file directly in the run directory',
  );
  const html = await render(root);
  await writeFile(destination, html, { flag: 'wx' });
  return destination;
}

if (import.meta.main) {
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: { output: { type: 'string' } },
    });
    assert(
      parsed.positionals.length === 1,
      'Usage: bun scripts/implement/run-report.ts RUN_DIR [--output RUN_DIR/NAME.html]',
    );
    console.log(await writeRunReport(parsed.positionals[0] ?? '', parsed.values.output));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
