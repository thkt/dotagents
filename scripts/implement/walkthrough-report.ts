import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isRecord } from '../shared/values.ts';
import type { State } from './input.ts';
import { savedWalkthrough, validateWalkthrough, walkthroughSteps } from './walkthrough.ts';
import type { SavedWalkthrough, WalkthroughSteps } from './walkthrough.ts';

const escape = (value: string) =>
  value.replace(
    /[&<>"'\r]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;' })[
        character
      ] ?? character,
  );

// 実行するのはこの固定文字列だけです。保存文章はHTMLの文字として扱います。
const helper = `document.querySelectorAll('[data-copy-question]').forEach((button) => {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const article = button.closest('article');
    const question = article.querySelector('textarea');
    const status = article.querySelector('[role="status"]');
    try {
      await navigator.clipboard.writeText(question.value);
      status.textContent = '質問文をコピーしました。送信はしていません。';
    } catch {
      question.focus();
      question.select();
      status.textContent = 'コピーできませんでした。選択した質問文を手動でコピーしてください。';
    }
  });
});`;
const helperHash = createHash('sha256').update(helper).digest('base64');
const walkthroughScriptPolicy = `script-src 'sha256-${helperHash}'`;
const walkthroughScript = `<script>${helper}</script>`;
// Basecoat 1.0.2のtextarea・outline buttonの値を質問欄へ限定して適用します。
// 参照: https://basecoatui.com/components/textarea/ と https://basecoatui.com/components/button/
export const walkthroughStyle = `.walk-disclosure{margin-top:12px}.walk-disclosure>summary{grid-template-columns:32px minmax(0,1fr) 18px;padding:16px 18px}.walk-number{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--report-info-bg);color:var(--report-info-text);font-size:13px}.walk-step{padding:20px;scroll-margin-top:16px;min-width:0;border-top:1px solid var(--report-border)}.walk-step:focus{outline:3px solid var(--report-focus);outline-offset:-3px}.walk-intent{font-size:16px;margin:0 0 20px}.walk-question{--walk-input:oklch(92.2% 0 0);--walk-foreground:oklch(14.5% 0 0);--walk-muted:oklch(97% 0 0);--walk-ring:oklch(70.8% 0 0);--walk-radius:6px}.walk-question label{display:block;font-size:14px;font-weight:500;margin-bottom:8px}.walk-question .textarea{display:block;width:100%;min-height:160px;resize:vertical;font:inherit;font-size:14px;line-height:1.5;padding:8px 10px;border:1px solid var(--walk-input);border-radius:var(--walk-radius);background:transparent;color:var(--walk-foreground);box-shadow:0 1px 2px #0000000d;white-space:pre-wrap;overflow-wrap:anywhere;transition:box-shadow .15s,border-color .15s}.walk-question .btn{display:inline-flex;align-items:center;justify-content:center;height:36px;margin-top:12px;padding:0 10px;border:1px solid var(--walk-input);border-radius:var(--walk-radius);background:var(--report-surface);color:var(--walk-foreground);box-shadow:0 1px 2px #0000000d;font:inherit;font-size:14px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,box-shadow .15s}.walk-question .btn[hidden]{display:none}.walk-question .btn:hover{background:var(--walk-muted)}.walk-question :is(.btn,.textarea):focus-visible{outline:2px solid var(--walk-ring);outline-offset:2px;box-shadow:0 0 0 3px color-mix(in oklab,var(--walk-ring) 50%,transparent)}.walk-question [role=status]{font-size:13px;color:var(--report-muted)}.walk-question [role=status]:empty{margin:0}.walk-step h4{font-size:13px;margin:20px 0 8px}.walk-step pre{max-height:none;overflow:visible;background:var(--report-code);margin:0 0 16px}.walk-code-label{overflow-wrap:anywhere;margin:16px 0 8px;color:var(--report-muted);font-size:12px}.walk-evidence{border-top:1px solid var(--report-divider);margin-top:20px;padding-top:4px}.walk-evidence ul{padding-left:20px;font-size:13px}.walk-metadata{margin-top:16px}.walk-metadata .detail-body{font-size:13px;overflow-wrap:anywhere}.walk-question summary{font-size:13px}.walk-question .detail-body{padding:16px}.walk-scope{color:var(--report-muted);font-size:13px;margin-bottom:18px}@media(max-width:700px){.walk-step{padding:16px}.walk-disclosure>summary{padding:14px 16px}}`;
const recordSchema = z.object({
  review: z.object({ targetId: z.string(), walkthrough: walkthroughSteps }),
  walkthrough: savedWalkthrough,
});
const targetSchema = z.object({
  targetId: z.string(),
  source: z.string(),
  files: z.array(z.tuple([z.string(), z.number(), z.string()])),
});
async function jsonFile(path: string, known: Map<string, boolean>): Promise<unknown> {
  known.set(path, false);
  const regular = (await lstat(path)).isFile();
  known.set(path, regular);
  assert(regular, 'ウォークスルーの記録は通常ファイルである必要があります');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function savedRecord(
  directory: string,
  entries: string[],
  targetId: string,
  warnings: string[],
  known: Map<string, boolean>,
) {
  const matches = [];
  for (const name of entries.filter((name) => /^review-\d+\.json$/.test(name))) {
    let raw: unknown;
    try {
      raw = await jsonFile(join(directory, name), known);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`verification/${name}: ${message}`);
      continue;
    }
    const record = recordSchema.safeParse(raw);
    if (record.success && record.data.review.targetId === targetId) {
      matches.push({ name, record: record.data });
    }
  }
  assert(matches.length === 1, 'ウォークスルーの評価記録が欠落または重複しています');
  const match = matches[0];
  assert(match);
  const rawTarget = await jsonFile(
    join(directory, match.name.replace(/\.json$/, '.target.json')),
    known,
  );
  const target = targetSchema.parse(rawTarget);
  assert(isRecord(rawTarget), 'ウォークスルーの評価対象記録が不正です');
  const { targetId: recordedId, ...identityFields } = rawTarget;
  assert(
    recordedId === createHash('sha256').update(JSON.stringify(identityFields)).digest('hex'),
    'ウォークスルーの評価対象識別値が一致しません',
  );
  assert(
    target.source === createHash('sha256').update(JSON.stringify(target.files)).digest('hex'),
    'ウォークスルーのソース識別値が一致しません',
  );
  assert(
    target.targetId === targetId &&
      match.record.walkthrough.targetId === targetId &&
      target.source === match.record.walkthrough.source,
    'ウォークスルーの対象不一致',
  );
  const linesByPath = validateWalkthrough(
    match.record.review.walkthrough,
    match.record.walkthrough,
    target.files,
  );
  return { ...match, linesByPath };
}

function stepHtml(
  step: WalkthroughSteps[number],
  index: number,
  saved: SavedWalkthrough,
  linesByPath: ReadonlyMap<string, readonly string[]>,
) {
  const locations = step.code.map((ref) => `${ref.path}:${ref.start}-${ref.end}`);
  const question = `変更のウォークスルーのステップ${index + 1}「${step.title}」について質問します。\n評価対象: ${saved.targetId}\nソース: ${saved.source}\nコード位置: ${locations.join('、')}\n質問: `;
  const code = step.code
    .map((ref) => {
      const savedLines = linesByPath.get(ref.path);
      assert(savedLines);
      const lines = savedLines
        .slice(ref.start - 1, ref.end)
        .map((line, offset) => `${ref.start + offset}: ${line}`)
        .join('\n');
      return `<div class="walk-code-label"><code>${escape(`${ref.path}:${ref.start}-${ref.end}`)}</code></div><pre><code>${escape(lines)}</code></pre>`;
    })
    .join('');
  return `<details class="walk-disclosure"><summary><span class="walk-number">${index + 1}</span><span class="event-title">${escape(step.title)}</span><span class="event-chevron" aria-hidden="true">›</span></summary><article class="walk-step" id="walk-step-${index + 1}" tabindex="-1"><p class="walk-intent">${escape(step.intent)}</p>${code}<h4>この実装を選んだ理由</h4><p>${escape(step.rationale)}</p><div class="walk-evidence"><h4>確認結果と証拠</h4><ul>${step.evidence.map((item) => `<li>${escape(item)}</li>`).join('')}</ul><h4>未確認事項</h4>${step.limitations.length ? `<ul>${step.limitations.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : '<p>この説明には未確認事項の記載がありません。承認を意味しません。</p>'}</div><details class="walk-question"><summary><span class="event-title">この箇所について質問する</span><span class="event-chevron" aria-hidden="true">›</span></summary><div class="detail-body"><label for="walk-question-${index + 1}">チャットに貼る質問文</label><textarea class="textarea" id="walk-question-${index + 1}" readonly>${escape(question)}</textarea><button class="btn" data-variant="outline" type="button" data-copy-question hidden>質問文をコピー</button><p role="status" aria-live="polite"></p></div></details></article></details>`;
}

export async function walkthroughSection(
  root: string,
  state: State | undefined,
  stopped: boolean,
  warnings: string[],
  entries: string[],
  known: Map<string, boolean>,
) {
  const review = state?.reviewHistory.at(-1);
  if (!review?.walkthrough) {
    return {
      html: '<p>未記録。初回実装の要約を最終版の説明として補完しません。</p>',
      scripted: false,
    };
  }
  try {
    const { name, record, linesByPath } = await savedRecord(
      join(root, 'verification'),
      entries,
      review.targetId,
      warnings,
      known,
    );
    assert(record.walkthrough.source === state?.source, 'ウォークスルーの対象不一致');
    assert(
      JSON.stringify(record.review.walkthrough) === JSON.stringify(review.walkthrough),
      'ウォークスルーの説明が一致しません',
    );
    const confirmed =
      !stopped && review.status === 'accepted' && state.result === 'ready_for_human_review';
    const scope = confirmed
      ? '最終評価対象の説明。acceptedは人の承認ではありません。'
      : '停止・評価未完了の記録です。この評価対象だけの説明で、最終確認済みではありません。';
    const steps = review.walkthrough
      .map((step, index) => stepHtml(step, index, record.walkthrough, linesByPath))
      .join('');
    return {
      html: `<p class="walk-scope">${scope}</p>${steps}<details class="walk-metadata"><summary><span class="event-title">対象版と原記録</span><span class="event-chevron" aria-hidden="true">›</span></summary><div class="detail-body"><p>評価対象: <code>${record.walkthrough.targetId}</code><br>ソース: <code>${record.walkthrough.source}</code></p><p>識別値の一致は説明内容の正しさを保証しません。説明の意味は既存の独立評価で確認します。</p><p><a href="./verification/${name}">説明・保存コードの原記録</a> / <a href="./verification/${name.replace(/\.json$/, '.target.json')}">評価対象の原記録</a> / <a href="./verification/${name.replace(/\.json$/, '.diff')}">保存差分</a></p><ul>${record.walkthrough.files.map((file) => `<li><code>${escape(file.path)}</code> · SHA-256: <code>${file.sha256}</code></li>`).join('')}</ul></div></details>`,
      scripted: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`変更のウォークスルー: ${message}`);
    return {
      html: `<p>記録を確認できません。${escape(message)}。読めた結果と原記録は保持しています。</p>`,
      scripted: false,
    };
  }
}

export function walkthroughAssets(enabled: boolean) {
  return {
    policy: enabled ? `${walkthroughScriptPolicy}; ` : '',
    script: enabled ? walkthroughScript : '',
  };
}
