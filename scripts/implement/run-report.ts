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
import { outputSyntax } from './output-syntax.ts';
import { walkthroughSection, walkthroughAssets, walkthroughStyle } from './walkthrough-report.ts';

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

function outputExcerpt(value: string) {
  // Character references retain CRs through HTML parsing; code preserves an initial newline.
  const content = outputSyntax(value.slice(0, 900)).replaceAll('\r', '&#13;');
  const suffix = value.length > 900 ? `\n…画面上の抜粋（全${value.length}文字。原記録を参照）` : '';
  return `<pre><code>${content}${suffix}</code></pre>`;
}

// Translate only these saved CI messages, never substrings or inferred states.
// Unknown (including future) wording stays visible in the original language.
const resultReasons = new Map([
  [
    'All required checks succeeded and no registered check is failing or pending.',
    '必須チェックはすべて成功し、登録されたチェックに失敗や保留はありません。',
  ],
]);
const nextActions = new Map([
  [
    'CI confirmed for the published draft commit. Assigned AI: compare the latest public body with the Issue, commit, accepted assessment and verification, complete any rendered media check, then recheck target, body, evidence, actor, permissions and same-head CI before gh pr ready; read back the result before human review.',
    '公開したdraftのcommitについてCIを確認しました。担当AIは、最新の公開本文をIssue・commit・accepted評価・検証結果と照合し、必要な媒体の実表示確認を完了してください。その後、対象・本文・証拠・実行主体・権限・同じheadのCIを再確認してから gh pr ready を実行し、人のレビュー前に切替結果を読み戻してください。',
  ],
]);
const remainingTasks = new Map([
  ['local_verification', 'ローカル検証'],
  ['publication', '公開'],
  ['ci', 'CI確認'],
  ['attachments', '媒体の添付'],
  ['rendered_media_check', '必要媒体の実表示確認'],
  ['published_body_check', '公開本文の確認'],
  ['mark_ready', 'readyへの切替'],
  ['human_review', '人によるレビュー'],
]);

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
  return `<details><summary><span class="event-title">${escape(label)}</span><span class="event-chevron" aria-hidden="true">›</span></summary><div class="detail-body">${content}</div></details>`;
}

type Tone = 'success' | 'failure' | 'pending' | 'info' | 'neutral';

function exitTone(code: unknown): Tone {
  return typeof code === 'number' && Number.isSafeInteger(code)
    ? code === 0
      ? 'success'
      : 'failure'
    : 'pending';
}

function badge(value: string | undefined, tone: Tone) {
  return `<span class="status-badge tone-${tone}">${shown(value)}</span>`;
}

function eventDetail(
  label: string,
  status: string,
  content: string,
  metadata: { preview?: string; line?: number; source?: 'host'; tone?: Tone } = {},
) {
  const source =
    metadata.line === undefined
      ? ''
      : `<span class="event-source"><span aria-hidden="true">L${metadata.line}</span><span class="visually-hidden">${metadata.source === 'host' ? `原記録 state.events の${metadata.line}番目（JSONの物理行ではありません）` : `原記録 events.jsonl の${metadata.line}行目`}</span></span>`;
  return `<details class="event-disclosure"><summary><span class="event-heading"><span class="event-title">${escape(label)}</span>${source}${metadata.preview ?? ''}</span><span class="event-status tone-${metadata.tone ?? 'neutral'}">${escape(status)}</span><span class="event-chevron" aria-hidden="true">›</span></summary><div class="event-body">${content}</div></details>`;
}

function inputFiles(command: string) {
  const { paths, partial } = commandInputs(command);
  const names = paths.map((path) => basename(path));
  const files = paths.map((path, index) => {
    const name = names[index] ?? path;
    const duplicate = names.indexOf(name) !== names.lastIndexOf(name);
    const temporary = path.startsWith('/tmp/') || path.startsWith('/private/tmp/');
    const location = temporary ? '<span class="input-location">tmp</span>' : '';
    return {
      tag: `<span class="input-file${temporary ? ' input-file-tmp' : ''}" tabindex="0">${quote(name)}${duplicate ? `<span class="input-directory">${escape(dirname(path))}/</span>` : ''}${location}</span>`,
      row: `<li class="input-path"><code class="input-path-value">${escape(path)}</code></li>`,
    };
  });
  const status = files.length
    ? `ファイル候補はcommandから${partial ? '一部のみ' : ''}抽出。`
    : 'ファイル候補を抽出できませんでした。元のcommandと原記録を確認してください。';
  return {
    preview: files.length
      ? `<span class="command-inputs">${files.map((file) => file.tag).join('')}</span>`
      : '',
    body: `<section class="command-paths"><h4>入力ファイル候補 · 保存commandのパス</h4><p>${status}</p>${files.length ? `<ul>${files.map((file) => file.row).join('')}</ul>` : ''}</section>`,
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

const eventTones = new Map<string, Tone>([
  ['item.started', 'pending'],
  ['item.updated', 'pending'],
  ['item.completed', 'pending'],
  ['turn.started', 'pending'],
  ['turn.failed', 'failure'],
  ['error', 'failure'],
  ['thread.started', 'info'],
  ['turn.completed', 'info'],
]);

const eventTitles = new Map([
  ['thread.started', '対話の開始'],
  ['turn.started', '処理の開始'],
  ['turn.completed', '処理の終了'],
]);

const itemTitles = new Map([
  ['mcp_tool_call', 'MCPツール'],
  ['file_change', 'ファイルの変更'],
]);

function commandStatus(kind: string, code: unknown) {
  if (kind === 'item.completed') {
    return {
      label: typeof code === 'number' ? `終了コード ${code}` : '終了コード未記録',
      tone: exitTone(code),
    };
  }
  return {
    label: eventStatuses.get(kind) ?? '種類不明 · 成否未確認',
    tone: eventTones.get(kind) ?? 'neutral',
  };
}

function genericEvent(
  event: unknown,
  item: Record<string, unknown> | undefined,
  index: number,
  raw: string,
) {
  const kind = isRecord(event) && typeof event.type === 'string' ? event.type : '種類不明';
  const itemKind = text(item?.type);
  const operation =
    itemKind === undefined
      ? (eventTitles.get(kind) ?? kind)
      : (itemTitles.get(itemKind) ?? itemKind);
  const status = eventStatuses.get(kind) ?? '記録されたイベント';
  return eventDetail(
    operation,
    status,
    `<p class="report-note">入出力の区分は未確認です。保存された行の抜粋です。</p>${ioPanel('イベント原文 · 抜粋', `<pre>${excerpt(raw)}</pre>`, 'neutral')}`,
    { line: index + 1, tone: eventTones.get(kind) ?? 'neutral' },
  );
}

function actorAction(event: unknown, index: number, raw: string) {
  const item = isRecord(event) && isRecord(event.item) ? event.item : undefined;
  if (isRecord(event) && item?.type === 'command_execution') {
    const command = text(item.command) ?? '未記録';
    const files = inputFiles(command);
    const status = commandStatus(text(event.type) ?? '', item.exit_code);
    return eventDetail(
      'コマンド実行',
      status.label,
      `${files.body}<div class="io-grid">${ioPanel('入力 · command', `<pre>${excerpt(command)}</pre>`, 'input')}${ioPanel('出力 · aggregated_output', outputExcerpt(text(item.aggregated_output) ?? '未記録'), 'output')}</div>`,
      { preview: files.preview, line: index + 1, tone: status.tone },
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
      `<div class="io-grid">${ioPanel('入力', '<p class="muted">このイベントには入力の保存値がありません。</p>', 'input')}${ioPanel('出力 · text', outputExcerpt(item.text), 'output')}</div>`,
      { line: index + 1, tone: 'info' },
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
  const role = name.startsWith('review-codex-') ? 'レビュー担当AI' : '実装・修正担当AI';
  return `<section class="actor-group"><header><h4>${role}</h4><p>${escape(name)}</p><p>${actions.length}/${lines.filter(Boolean).length}行表示（空行を除く、このログ内の順序）。${localLink(root, path, 'イベント原記録を開く')}。画面の長文は抜粋です。</p></header><div class="activity-list">${actions.join('') || '<p>表示対象のイベントは未記録です。</p>'}</div></section>`;
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

function hostStatus(code: number | null, timedOut: boolean): { label: string; tone: Tone } {
  return {
    label: timedOut ? '時間切れ' : `終了コード ${code ?? '未記録'}`,
    tone: timedOut ? 'failure' : exitTone(code),
  };
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
      const status = hostStatus(event.code, event.timedOut);
      const logs = `<dl class="summary-fields">${field('ログ保存先の接頭辞', quote(event.prefix))}${field('終了コード', escape(code))}${field('時間切れ', event.timedOut ? '記録あり' : 'なし')}${field('stdout', stdout ? localLink(root, `${prefix}.stdout`, '保存ログを開く') : '未記録')}${field('stderr', stderr ? localLink(root, `${prefix}.stderr`, '保存ログを開く') : '未記録')}</dl>`;
      return eventDetail(
        hostRoles.get(event.role) ?? event.role,
        status.label,
        ioPanel('ホストの保存記録', logs, 'neutral'),
        {
          line: index + 1,
          source: 'host',
          tone: status.tone,
        },
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
      {
        tone:
          item.disposition === 'open'
            ? 'pending'
            : item.disposition === 'fixed'
              ? 'success'
              : 'neutral',
      },
    ),
  );
  const status = review.status === 'accepted' ? '修正必須の指摘なし' : '修正が必要';
  return `<p class="review-summary"><strong>${status}</strong>（${shown(review.status)}）。${shown(review.findings)}</p>${items.length ? `<div class="actor-group"><div class="activity-list">${items.join('')}</div></div>` : ''}`;
}

const ciTones = new Map<string, Tone>([
  ['passed', 'success'],
  ['failed', 'failure'],
  ['timed_out', 'pending'],
  ['unavailable', 'pending'],
  ['invalid_response', 'pending'],
  ['storage_failed', 'failure'],
  ['target_changed', 'pending'],
]);

function publicationSection(result: RunResult) {
  return `<dl class="summary-fields">${field('公開状態', badge(result.publication, result.publication === 'published' ? 'info' : result.publication === 'unconfirmed' ? 'pending' : 'neutral'))}${field('commit', result.commit ? quote(result.commit) : '未記録')}${field('PR', externalLink(result.url, result.url ?? ''))}${field('CI', badge(result.ci, ciTones.get(result.ci ?? '') ?? 'neutral'))}</dl>${result.ciDetails === undefined ? '' : detail('CIの保存結果', `<pre>${excerpt(JSON.stringify(result.ciDetails, null, 2), 3000)}</pre>`)}`;
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
      : `<pre>${excerpt(summary, 3000)}</pre><p class="summary-source">${localLink(root, join(root, 'implementation-summary.md'), '要約の原記録を開く')}</p>`;
  return `<aside class="report-notes" aria-labelledby="report-notes-title"><h3 id="report-notes-title">読み方</h3><ul><li>順序・L番号：各ログ内の記録順。別ログ間の前後は未確認です。LはAI側がevents.jsonlの物理行、ホスト側がstate.eventsの1始まりの記録順です。</li><li>ファイル：タグは保存commandから静的に抽出した入力ファイル候補。読取り成功・モデルの理解は未確認です。抽出漏れがあり、パスと抽出状態は展開後に確認できます。相対パスは未解決です。</li><li>tmp：/tmp/・/private/tmp/で始まる保存パスの場所の印。用途・削除可否・読了は示さず、実在・リンク先は未確認です。</li><li>状態：色と状態文字列を併記。緑=成功/修正済み、赤=失敗、黄=未確認/要対応、青=記録/応答完了、灰=対象外/不明。完了は内容の検証済みを意味しません。</li></ul></aside><h3>ホストの実行ログ</h3><div class="actor-group"><div class="activity-list">${hostEvents.join('') || '<p class="empty-list">検証イベントは未記録です。</p>'}</div></div><h3 style="margin-top:24px">初回実装担当の要約（最終版の説明ではありません）</h3>${workSummary}<h3 style="margin-top:24px">モデルのツール実行・イベント</h3>${actors.join('') || '<p>表示対象のモデルイベントは未記録です。</p>'}`;
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
  const status = {
    stopped: '停止',
    verified_local: 'ローカル検証済み',
    published_draft: 'Draft公開・CI確認済み',
  }[result.status];
  const walkthrough = await walkthroughSection(
    runDir,
    state,
    result.status === 'stopped',
    warnings,
    (await directoryEntries(runDir, verification, warnings, cache)).map((entry) => entry.name),
    known,
  );
  const recordLinks = await recordRows(runDir, known, warnings, cache, result.details);
  const generatedAt = new Date().toISOString();
  const assets = walkthroughAssets(walkthrough.scripted);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${assets.policy}style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>実装runの記録 · ${escape(status)}</title><style>
:root{color-scheme:light;--report-page:#f6f7f9;--report-surface:#fff;--report-subtle:#f5f7fa;--report-inset:#fafbfc;--report-field:#fcfdff;--report-code:#f6f8fb;--report-text:#23272e;--report-muted:#566170;--report-border:#dce1e7;--report-divider:#e2e6ec;--report-table-border:#e5e8ec;--report-link:#2359a2;--report-focus:#5b78c5;--report-blue-bg:#eef5ff;--report-blue-border:#c7d8f4;--report-blue-text:#215ba4;--report-purple-bg:#f5effb;--report-purple-border:#dacdf0;--report-purple-text:#6d43a0;--report-tmp-bg:#f4f0e8;--report-tmp-border:#d8cdbb;--report-tmp-text:#65543a;--report-success-bg:#e8f5ec;--report-success-text:#216138;--report-success-border:#b7d9c1;--report-failure-bg:#fceced;--report-failure-text:#9d2833;--report-failure-border:#e9bfc4;--report-pending-bg:#fff6dc;--report-pending-text:#795508;--report-pending-border:#e5d49f;--report-info-bg:#edf3ff;--report-info-text:#30558b;--report-neutral-bg:#f0f2f5;--report-syntax-blue:#0550ae;--report-syntax-string:#0a3069;--report-syntax-keyword:#8250df;--report-syntax-comment:#57606a;--report-output-text:#14735a;}

:root{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--report-text);background:var(--report-page);line-height:1.6}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:36px 28px 90px}h1{font-size:30px;line-height:1.25;margin:12px 0}h2{font-size:21px;margin:0 0 14px}h3{font-size:17px;margin:0 0 10px}p{margin:8px 0 12px}.eyebrow{font-size:13px;color:var(--report-muted);font-weight:650;letter-spacing:.05em}.report-note{font-size:13px;color:var(--report-muted)}.pill{display:inline-block;border-radius:999px;padding:4px 12px;font-size:13px;font-weight:700}.section{margin-top:28px}.card{background:var(--report-surface);border:1px solid var(--report-border);border-radius:14px;padding:24px;box-shadow:0 1px 3px #1c26320d}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:0}dt{font-size:12px;color:var(--report-muted);font-weight:650}dd{margin:3px 0 0;overflow-wrap:anywhere;font-size:14px}code,pre{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--report-subtle);border:1px solid var(--report-divider);border-radius:8px;padding:12px;max-height:330px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--report-table-border);vertical-align:top;overflow-wrap:anywhere}th{color:var(--report-muted);font-weight:650}a{color:var(--report-link)}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible{outline:3px solid var(--report-focus);outline-offset:3px}details{border:1px solid var(--report-border);border-radius:10px;background:var(--report-surface);margin-top:10px;overflow:hidden}summary{display:grid;grid-template-columns:minmax(0,1fr) 18px;align-items:center;gap:12px;list-style:none;cursor:pointer;padding:14px 18px;font-weight:650}summary::-webkit-details-marker{display:none}summary:hover .event-title{text-decoration:underline;text-underline-offset:4px}summary:focus-visible{outline-offset:-4px}details[open]>summary>.event-chevron{transform:rotate(90deg)}summary:hover{background:var(--report-subtle)}.detail-body{border-top:1px solid var(--report-border);padding:16px 18px}.detail-body details{margin:10px 0}.io-label{font-size:12px;font-weight:700;margin:12px 0 5px}.input{color:var(--report-blue-text)}.output{color:var(--report-output-text)}.muted{color:var(--report-muted)}.table-wrap{overflow-x:auto}@media(max-width:700px){main{padding:22px 16px 60px}.grid,dl{grid-template-columns:1fr}.card{padding:18px}h1{font-size:25px}}
.actor-group{margin-top:16px;border:1px solid var(--report-border);border-radius:10px;overflow:hidden;background:var(--report-surface)}.actor-group>header{padding:18px 20px;border-bottom:1px solid var(--report-border)}.actor-group>header h4{margin:0;font-size:15px}.actor-group>header p{margin:5px 0 0;font-size:13px;color:var(--report-muted)}.activity-list>.event-disclosure{margin:0;border:0;border-radius:0}.activity-list>.event-disclosure+.event-disclosure{border-top:1px solid var(--report-border)}.event-disclosure>summary{grid-template-columns:minmax(0,1fr) auto 18px;padding:17px 20px;font-size:14px;text-decoration:none}.event-disclosure>summary:hover{background:var(--report-page);text-decoration:none}.event-disclosure[open]>summary{background:var(--report-page)}.event-status,.status-badge{display:inline-block;border:1px solid var(--report-border);border-radius:5px;padding:2px 8px;font-size:12px;font-weight:500}.event-chevron{font-size:20px;line-height:1;justify-self:end;color:var(--report-muted)}.event-body{border-top:1px solid var(--report-border);background:var(--report-inset);padding:20px}.event-body>.report-note:first-child{margin-top:0}.io-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.io-panel{border:1px solid var(--report-border);border-radius:8px;background:var(--report-surface);overflow:hidden}.io-panel>h4{margin:0;padding:10px 14px;font-size:13px;border-bottom:1px solid}.io-panel>div{padding:14px;min-width:0}.io-panel pre{margin:0;background:var(--report-surface);border:0;padding:0}.input-panel{border-color:var(--report-blue-border)}.input-panel>h4{background:var(--report-blue-bg);color:var(--report-blue-text);border-color:var(--report-blue-border)}.output-panel{border-color:var(--report-purple-border)}.output-panel>h4{background:var(--report-purple-bg);color:var(--report-purple-text);border-color:var(--report-purple-border)}.neutral-panel>h4{background:var(--report-page);color:var(--report-muted);border-color:var(--report-border)}@media(max-width:700px){.io-grid{grid-template-columns:1fr}.event-disclosure>summary{grid-template-columns:minmax(0,1fr) 18px}.event-status{grid-column:1;grid-row:2;justify-self:start}.event-chevron{grid-column:2;grid-row:1}}
.empty-list{padding:16px 20px}.finding-fields{display:block}.finding-fields>div+div{border-top:1px solid var(--report-divider);padding-top:12px;margin-top:12px}.finding-fields dt{font-size:12px}.finding-fields dd{font-size:14px;white-space:pre-wrap}.record-list{list-style:none;margin:0;padding:0;border:1px solid var(--report-border);border-radius:10px;overflow:hidden}.record-list li{padding:11px 16px;overflow-wrap:anywhere}.record-list li+li{border-top:1px solid var(--report-table-border)}.record-list .muted{margin-left:12px;font-size:12px}
.command-inputs{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;font-weight:400;min-width:0}.input-file{display:inline-flex;align-items:baseline;gap:8px;min-width:0;max-width:100%;border:1px solid var(--report-blue-border);border-radius:5px;background:var(--report-blue-bg);padding:3px 8px;white-space:nowrap;overflow-x:auto}.input-file-tmp{background:var(--report-tmp-bg);border-color:var(--report-tmp-border)}.input-location{font-size:11px;color:var(--report-tmp-text)}.input-file>*{flex-shrink:0}.input-file:focus-visible{outline:3px solid var(--report-focus);outline-offset:-3px}.input-directory{font-size:11px;color:var(--report-muted)}.command-paths{margin-bottom:18px}.command-paths h4{margin:0}.command-paths p{font-size:13px}.command-paths ul{list-style:none;padding:0;margin:0}.input-path{padding:10px 0}.input-path+.input-path{border-top:1px solid var(--report-border)}.input-path-value{display:block;color:var(--report-muted);white-space:pre-wrap;overflow-wrap:anywhere}.input-file code{white-space:inherit}.event-heading{min-width:0;overflow-wrap:anywhere}
.event-source{display:inline-block;margin-left:8px;white-space:nowrap;font-size:12px;font-weight:400;color:var(--report-muted)}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.report-notes{margin:16px 0;padding:14px 16px;border:1px solid var(--report-border);border-radius:8px;background:var(--report-page);font-size:13px;color:var(--report-muted)}.report-notes h3{font-size:14px}.report-notes ul{margin:0;padding-inline-start:1.2em;list-style-position:outside}.summary-source{text-align:right;font-size:13px}.summary-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.summary-fields>div{min-width:0;padding:12px 14px;border:1px solid var(--report-border);border-radius:8px;background:var(--report-field)}.result-note{border-top:1px solid var(--report-divider);margin-top:18px;padding-top:18px}.review-summary{white-space:pre-wrap}@media(max-width:700px){.summary-fields{grid-template-columns:1fr}}
.tone-success{background:var(--report-success-bg);color:var(--report-success-text);border-color:var(--report-success-border)}.tone-failure{background:var(--report-failure-bg);color:var(--report-failure-text);border-color:var(--report-failure-border)}.tone-pending{background:var(--report-pending-bg);color:var(--report-pending-text);border-color:var(--report-pending-border)}.tone-info{background:var(--report-info-bg);color:var(--report-info-text);border-color:var(--report-blue-border)}.tone-neutral{background:var(--report-neutral-bg);color:var(--report-muted);border-color:var(--report-border)}
.output-panel .hljs-attr,.output-panel .hljs-title,.output-panel .hljs-section{color:var(--report-syntax-blue)}.output-panel .hljs-string,.output-panel .hljs-regexp{color:var(--report-syntax-string)}.output-panel .hljs-number,.output-panel .hljs-literal{color:var(--report-syntax-blue)}.output-panel .hljs-keyword{color:var(--report-syntax-keyword)}.output-panel .hljs-comment,.output-panel .hljs-quote{color:var(--report-syntax-comment)}.output-panel .hljs-section,.output-panel .hljs-strong{font-weight:650}.output-panel .hljs-emphasis{font-style:italic}

${walkthroughStyle}

@media(prefers-color-scheme:dark){:root{color-scheme:dark;--report-page:#141414;--report-surface:#212121;--report-subtle:#292929;--report-inset:#191919;--report-field:#252525;--report-code:#191919;--report-text:#ededed;--report-muted:#b5bdc8;--report-border:#454545;--report-divider:#3d3d3d;--report-table-border:#3d3d3d;--report-link:#93c5fd;--report-focus:#a4bfff;--report-blue-bg:#1c3049;--report-blue-border:#45658b;--report-blue-text:#a5ceff;--report-purple-bg:#30253f;--report-purple-border:#69527f;--report-purple-text:#d8b8ff;--report-tmp-bg:#332b1f;--report-tmp-border:#78664a;--report-tmp-text:#dcc39b;--report-success-bg:#193526;--report-success-text:#a0e8b6;--report-success-border:#3d7752;--report-failure-bg:#3e2227;--report-failure-text:#ffb4bc;--report-failure-border:#87505a;--report-pending-bg:#372d19;--report-pending-text:#f4d88e;--report-pending-border:#806c39;--report-info-bg:#1c3049;--report-info-text:#a5ceff;--report-neutral-bg:#292929;--report-syntax-blue:#93c5fd;--report-syntax-string:#bfdbfe;--report-syntax-keyword:#d8b8ff;--report-syntax-comment:#adb7c2;--report-output-text:#a0e8b6;}.walk-question{--walk-input:oklch(100% 0 0/.15);--walk-foreground:oklch(98.5% 0 0);--walk-muted:oklch(26.9% 0 0);--walk-ring:oklch(55.6% 0 0)}}
</style></head><body><main><header><div class="eyebrow">IMPLEMENT / 1 RUN</div><h1>実装runの記録</h1><span class="pill tone-${result.status === 'stopped' ? 'pending' : 'success'}">${escape(status)}</span></header>
<section class="section card"><h2>今回の結果</h2><dl class="summary-fields">${field('Issue', externalLink(result.issue, result.issue))}${field('対象リポジトリ', shown(result.repository))}${field('開始commit', quote(result.startCommit))}${field('開始日時（UTC）', shown(result.startedAt))}${field('終了日時（UTC）', shown(result.finishedAt))}${field('HTML生成日時（UTC）', shown(generatedAt))}${field('終了状態', badge(status, result.status === 'stopped' ? 'pending' : 'success'))}${field('最終工程', `${shown(result.phase)} / ${shown(result.operation)}`)}</dl><div class="result-note"><h3>実行結果</h3><p>${shown(resultReasons.get(result.reason) ?? result.reason)}</p></div><div class="result-note"><h3>ネクストアクション</h3><p>${shown(nextActions.get(result.nextAction) ?? result.nextAction)}</p><p class="report-note">残る作業: ${result.remaining.length ? result.remaining.map((task) => escape(remainingTasks.get(task) ?? task)).join('、') : '記録なし'}。人の承認・マージは、このrunの結果に含みません。</p></div></section>
${warnings.length ? `<section class="section card"><h2>関連記録の注意</h2><p>読めた結果は保持しました。次の記録は未確認です。原記録を確認してください。</p><ul>${warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul></section>` : ''}
<div class="grid section"><section class="card"><h2>検証と評価</h2><p class="report-note">acceptedは公開後確認や人の承認を意味しません。</p><dl class="summary-fields">${field('ホストcheck', state ? `${state.checks}回記録` : '未記録')}${field('独立評価', badge(review?.status, review ? (review.status === 'accepted' ? 'success' : 'pending') : 'neutral'))}${field('検証終端', state ? shown(state.result ?? undefined) : '未記録')}${field('評価指摘', review ? `${review.items.length}件` : '未記録')}</dl></section><section class="card"><h2>公開の記録</h2><p class="report-note">GitHubの現在状態ではなく、run終了時の保存記録です。</p>${publicationSection(result)}</section></div>
<section class="section card"><h2>変更のウォークスルー</h2>${walkthrough.html}</section>
<section class="section card"><h2>行動ログ</h2>${activitySection(runDir, summary, hostEvents, actors)}</section>
<section class="section card"><h2>独立評価の指摘</h2>${reviewSection(review)}</section>
<section class="section card"><h2>原記録</h2><p class="muted">入力・出力の全文と証拠は保存ファイルで確認してください。画面の抜粋は全コンテキストではありません。</p><ul class="record-list">${recordLinks.join('')}</ul></section>
</main>${assets.script}</body></html>`;
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
