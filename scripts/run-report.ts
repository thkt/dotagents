import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { assertState } from './input.ts';
import type { State } from './input.ts';
import { isRecord } from './values.ts';
import type { Review } from './review.ts';

const resultShape = z.object({
  status: z.enum(['stopped', 'verified_local', 'published_draft']),
  phase: z.string(),
  operation: z.string(),
  reason: z.string(),
  nextAction: z.string(),
  repository: z.string(),
  issue: z.string(),
  startCommit: z.string(),
  details: z.string().optional(),
  remaining: z.array(z.string()),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  terminal: z.literal(true).optional(),
  publication: z.string().optional(),
  commit: z.string().optional(),
  url: z.string().optional(),
  ci: z.string().optional(),
  ciDetails: z.unknown().optional(),
});
type RunResult = z.infer<typeof resultShape>;

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

function parseResult(value: unknown) {
  const parsed = resultShape.safeParse(value);
  assert(parsed.success, 'Invalid result.json');
  assert(!parsed.data.startedAt || parsed.data.terminal === true, 'Run result is not terminal');
  if (parsed.data.status === 'published_draft') {
    assert(
      parsed.data.publication === 'published' &&
        parsed.data.commit &&
        parsed.data.url &&
        parsed.data.ci === 'passed',
      'Incomplete published draft record',
    );
  }
  return parsed.data;
}

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

function actorAction(event: unknown, index: number, raw: string) {
  const item = isRecord(event) && isRecord(event.item) ? event.item : undefined;
  if (isRecord(event) && event.type === 'item.completed' && item?.type === 'command_execution') {
    return detail(
      `ログ行 ${index + 1} · ツール実行`,
      `<p class="io-label input">入力 · command</p><pre>${excerpt(text(item.command) ?? '未記録')}</pre>` +
        `<p class="io-label output">出力 · aggregated_output（exit ${shown(typeof item.exit_code === 'number' ? String(item.exit_code) : undefined)}）</p><pre>${excerpt(text(item.aggregated_output) ?? '未記録')}</pre>`,
    );
  }
  if (
    isRecord(event) &&
    event.type === 'item.completed' &&
    item?.type === 'agent_message' &&
    typeof item.text === 'string'
  ) {
    return detail(
      `ログ行 ${index + 1} · モデルの発話`,
      `<p class="io-label output">出力 · text</p><pre>${excerpt(item.text)}</pre>`,
    );
  }
  const kind = isRecord(event) && typeof event.type === 'string' ? event.type : '種類不明';
  return detail(
    `ログ行 ${index + 1} · ${kind}`,
    `<p class="muted">入出力の区分は未確認です。保存された行の抜粋です。</p><pre>${excerpt(raw)}</pre>`,
  );
}

async function actorLogGroup(root: string, path: string, name: string, warnings: string[]) {
  const raw = await optionalEvidence(root, path, warnings);
  if (raw === undefined) {
    return undefined;
  }
  const lines = raw.split('\n').filter(Boolean);
  const actions = lines.flatMap((line, index) => {
    try {
      return [actorAction(JSON.parse(line) as unknown, index, line)];
    } catch (error) {
      warnings.push(`${relative(root, path)}:${index + 1}: ${errorMessage(error)}`);
      return [];
    }
  });
  return detail(
    `${name} · ${actions.length}/${lines.length}行表示（このログ内の順序）`,
    `<p>${localLink(root, path, 'イベント原記録を開く')}。画面の長文は抜粋です。別ログとの前後関係は示しません。</p>${actions.join('') || '<p>表示対象のイベントは未記録です。</p>'}`,
  );
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
      return `<tr><td>${index + 1}</td><td>${shown(event.role)}</td><td>${event.code === null ? '未記録' : escape(String(event.code))}</td><td>${event.timedOut ? '時間切れ' : '—'}</td><td>${stdout ? localLink(root, `${prefix}.stdout`, 'stdout') : '未記録'} / ${stderr ? localLink(root, `${prefix}.stderr`, 'stderr') : '未記録'}</td></tr>`;
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
      return `<tr><th>${escape(relative(root, path))}</th><td>${exists ? localLink(root, path, basename(path)) : '未記録'}</td></tr>`;
    }),
  );
}

function reviewSection(review: Review | undefined) {
  if (!review) {
    return '<p>未記録</p>';
  }
  const items = review.items.map(
    (item) =>
      `<tr><td>${shown(item.id)}</td><td>${shown(item.disposition)}</td><td>${shown(item.condition)}</td><td>${shown(item.reason)}</td></tr>`,
  );
  return `<p>評価結果: <strong>${shown(review.status)}</strong>。${shown(review.findings)}</p><div class="table-wrap"><table><thead><tr><th>ID</th><th>状態</th><th>条件</th><th>理由</th></tr></thead><tbody>${items.join('') || '<tr><td colspan="4">指摘なし</td></tr>'}</tbody></table></div>`;
}

function publicationSection(result: RunResult) {
  return `<dl>${field('公開状態', shown(result.publication))}${field('commit', result.commit ? quote(result.commit) : '未記録')}${field('PR', externalLink(result.url, result.url ?? ''))}${field('CI', shown(result.ci))}</dl>${result.ciDetails === undefined ? '' : detail('CIの保存結果', `<pre>${excerpt(JSON.stringify(result.ciDetails, null, 2), 3000)}</pre>`)}<p class="muted">GitHubの現在状態ではなく、run終了時の保存記録です。</p>`;
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
  return `<p class="muted">ホストの保存イベントを順に示します。モデル内の操作は各イベントログ内の順序のみを示し、別ログ間の全体順序は推定しません。</p><h3>ホスト工程</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>工程</th><th>終了コード</th><th>時間切れ</th><th>原記録</th></tr></thead><tbody>${hostEvents.join('') || '<tr><td colspan="5">検証イベントは未記録です。</td></tr>'}</tbody></table></div><h3 style="margin-top:24px">実装担当の要約</h3>${workSummary}<h3 style="margin-top:24px">モデルのツール実行・発話</h3>${actors.join('') || '<p>表示対象のモデルイベントは未記録です。</p>'}`;
}

async function render(runDir: string) {
  const rawResult = await file(join(runDir, 'result.json'));
  assert(rawResult !== undefined, 'Missing result.json');
  const result = parseResult(JSON.parse(rawResult) as unknown);
  const verification = join(runDir, 'verification');
  const warnings: string[] = [];
  const statePath = join(verification, 'state.json');
  const rawState = await optionalEvidence(runDir, statePath, warnings);
  let state: State | undefined;
  if (rawState !== undefined) {
    try {
      const parsed: unknown = JSON.parse(rawState);
      assertState(parsed);
      state = parsed;
    } catch (error) {
      warnings.push(`verification/state.json: ${errorMessage(error)}`);
    }
  }
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
</style></head><body><main><header><div class="eyebrow">IMPLEMENT / 1 RUN</div><h1>実装runの記録</h1><span class="pill ${escape(result.status)}">${escape(status)}</span><p class="lead">保存された事実と未確認事項を、この実行単位で示します。HTML生成は検証や公開を再実行しません。</p></header>
<section class="section card"><h2>今回の結果</h2><dl>${field('Issue', externalLink(result.issue, result.issue))}${field('対象repo', shown(result.repository))}${field('開始commit', quote(result.startCommit))}${field('開始日時 · UTC', shown(result.startedAt))}${field('終了日時 · UTC', shown(result.finishedAt))}${field('HTML生成日時 · UTC', shown(generatedAt))}${field('終了状態', escape(status))}${field('最終工程', `${shown(result.phase)} / ${shown(result.operation)}`)}</dl><h3 style="margin-top:22px">停止理由・結果</h3><p>${shown(result.reason)}</p><h3 style="margin-top:18px">次の対応</h3><p>${shown(result.nextAction)}</p><p class="muted">残る作業: ${result.remaining.length ? result.remaining.map(escape).join('、') : '記録なし'}。人の承認・マージは、このrunの結果に含みません。</p></section>
${warnings.length ? `<section class="section card"><h2>関連記録の注意</h2><p>読めた結果は保持しました。次の記録は未確認です。原記録を確認してください。</p><ul>${warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul></section>` : ''}
<div class="grid section"><section class="card"><h2>検証と評価</h2><dl>${field('ホストcheck', state ? `${state.checks}回記録` : '未記録')}${field('独立評価', review ? shown(review.status) : '未記録')}${field('検証終端', state ? shown(state.result ?? undefined) : '未記録')}${field('評価指摘', review ? `${review.items.length}件` : '未記録')}</dl><p class="muted">acceptedは公開後確認や人の承認を意味しません。</p></section><section class="card"><h2>公開の記録</h2>${publicationSection(result)}</section></div>
<section class="section card"><h2>行動ログ</h2>${activitySection(runDir, summary, hostEvents, actors)}</section>
<section class="section card"><h2>独立評価の指摘</h2>${reviewSection(review)}</section>
<section class="section card"><h2>原記録</h2><p class="muted">入力・出力の全文と証拠は保存ファイルで確認してください。画面の抜粋は全コンテキストではありません。</p><div class="table-wrap"><table><tbody>${recordLinks.join('')}</tbody></table></div></section>
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
      'Usage: bun scripts/run-report.ts RUN_DIR [--output RUN_DIR/NAME.html]',
    );
    console.log(await writeRunReport(parsed.positionals[0] ?? '', parsed.values.output));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
