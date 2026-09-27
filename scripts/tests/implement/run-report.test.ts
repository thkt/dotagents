import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunReport } from '../../implement/run-report.ts';

async function fixture(status: 'stopped' | 'verified_local' | 'published_draft') {
  const dir = await mkdtemp(join(tmpdir(), 'run-report-'));
  const result = {
    status,
    phase: status === 'stopped' ? 'implementation' : 'ci',
    operation: 'record result',
    details: status === 'stopped' ? join(dir, 'setup-1') : join(dir, 'verification/state.json'),
    reason: status === 'stopped' ? '<script>alert(1)</script>' : 'Recorded result',
    nextAction: 'Inspect saved evidence',
    repository: 'team/component',
    issue: 'https://github.com/team/component/issues/99',
    startCommit: 'a'.repeat(40),
    startedAt: '2026-09-23T01:02:03.000Z',
    finishedAt: '2026-09-23T01:03:04.000Z',
    terminal: true,
    publication: status === 'published_draft' ? 'published' : 'not_attempted',
    ...(status === 'published_draft'
      ? { commit: 'b'.repeat(40), url: 'https://github.com/team/component/pull/100', ci: 'passed' }
      : {}),
    remaining: ['human_review'],
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result));
  if (status !== 'stopped') {
    const verification = join(dir, 'verification');
    await mkdir(verification);
    await writeFile(
      join(verification, 'state.json'),
      JSON.stringify({
        reviewFormat: 4,
        issueFormat: 1,
        baseCommit: result.startCommit,
        reviewHistory: [],
        configHash: 'config',
        issueHash: 'issue',
        repair: 0,
        review: 0,
        checks: 1,
        modelMs: 0,
        active: null,
        events: [
          { role: 'check', code: 0, timedOut: false, prefix: join(verification, 'check-1') },
        ],
        result: 'ready_for_human_review',
      }),
    );
    await writeFile(join(verification, 'check-1.stdout'), 'pass');
  }
  return { dir, result };
}

test('saved outputs highlight recognizable syntax without changing excerpts or trusting file extensions', async () => {
  const { dir } = await fixture('stopped');
  const json =
    '\n{\r\n  "large": 900719925474099312345, "text": "<script>&amp;\\n\\\"",\r\n  "ok": true, "none": null\r\n}\n';
  const mixed =
    '{"name":[{"count":2}], "quoted":"brace }"}\ndiff --git a/a b/a\n-const old = "before";\n+const next = "after";\n';
  const markdown =
    '# Saved output\n[link](javascript:alert(1)) <img src=x onerror=alert(1)>\n```js\nconst text = "<b>not HTML</b>"; // note\n```\n~~~json\nnot JSON <b>\n~~~\n{"next": false}\n';
  const javascript =
    'export const text = "literal \\n & < >"; // comment\n/* multiline\nconst insideComment = "not code";\n*/\nfunction read() {\n  return true;\n}\n';
  const plain = 'unknown <script>alert(1)</script> &quot;\n';
  const incomplete = '{"text": "unfinished\n';
  const unsupported = 'const pattern = /"not a string"/;\n';
  const long = `# Large output\n${'x'.repeat(200_000)}\n{"outsideExcerpt":true}`;
  const truncatedJson = `{"long":"${'x'.repeat(1000)}"}`;
  const partialJson = `{\n  "large": 900719925474099312345,\n  "nested": {\n    "enabled": true,\n    "broken": bare,\n    "long": "${'x'.repeat(1000)}"}}`;
  const outputs = [
    json,
    mixed,
    markdown,
    javascript,
    plain,
    incomplete,
    unsupported,
    long,
    truncatedJson,
    partialJson,
    'const value = `hello ${name}`;\n',
    'const text = "unfinished\n# not a heading\nconst insideString = true;\n',
    '```js\nconst unfinished = true;\n',
  ];
  const actor = join(dir, 'repair-codex-output');
  const command = 'cat data.json README.md source.js';
  try {
    await mkdir(actor);
    const events = outputs
      .map((output, index) =>
        JSON.stringify({
          type: 'item.completed',
          item:
            index === 2
              ? { type: 'agent_message', text: output }
              : { type: 'command_execution', command, aggregated_output: output, exit_code: 0 },
        }),
      )
      .join('\n');
    await writeFile(join(actor, 'events.jsonl'), events);
    const html = await readFile(await writeRunReport(dir), 'utf8');
    const panels = [
      ...html.matchAll(/<section class="io-panel output-panel">([\s\S]*?)<\/section>/g),
    ].map((match) => match[1] ?? '');
    expect(panels).toHaveLength(outputs.length);
    const entities: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      '#x27': "'",
      '#39': "'",
      '#13': '\r',
    };
    panels.forEach((panel, index) => {
      const marked = panel.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
      expect(marked).toBeDefined();
      const escaped = (marked ?? '').replace(/<span class="hljs-[a-z0-9_ -]+">|<\/span>/g, '');
      // Only fixed spans may be markup; decoding once also catches double escaping.
      expect(escaped).not.toMatch(/[<>]/);
      const restored = escaped.replace(
        /&(amp|lt|gt|quot|#39|#x27|#13);/g,
        (_, entity: string) => entities[entity] ?? '',
      );
      const original = outputs[index] ?? '';
      const expected =
        original.length > 900
          ? `${original.slice(0, 900)}\n…画面上の抜粋（全${original.length}文字。原記録を参照）`
          : original;
      expect(restored).toBe(expected);
      expect(panel).not.toMatch(/<(?:script|img|a)\b/);
    });
    expect(panels[0]).toContain('class="hljs-attr"');
    expect(panels[0]).toContain('class="hljs-number"');
    expect(panels[2]).toContain('class="hljs-section"');
    expect(panels[3]).toContain('class="hljs-keyword"');
    expect(panels[3]).toContain('class="hljs-string"');
    expect(panels[3]).toContain('class="hljs-comment"');
    expect(panels[7]).not.toContain('outsideExcerpt');
    expect(html).not.toContain('色分けの候補');
    expect(html).not.toContain('output-format');
    const inputPanels = [
      ...html.matchAll(/<section class="io-panel input-panel">([\s\S]*?)<\/section>/g),
    ];
    expect(inputPanels.some((match) => match[1]?.includes(`<pre>${command}</pre>`))).toBe(true);
    expect(inputPanels.every((match) => !match[1]?.includes('hljs-'))).toBe(true);
    expect(html).toContain(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    expect(html).toContain('href="./repair-codex-output/events.jsonl"');
    expect(await readFile(join(actor, 'events.jsonl'), 'utf8')).toBe(events);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run report distinguishes local verification from publication and links only recorded evidence', async () => {
  const { dir } = await fixture('verified_local');
  try {
    const statePath = join(dir, 'verification/state.json');
    const state: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state && typeof state === 'object');
    const reviewHistory = [
      {
        findings: '保存済みの指摘を確認した。',
        targetId: 'fixture-target',
        assessments: {
          code: '確認した',
          requirements: '確認した',
          tests: '確認した',
          documentation: '確認した',
        },
        documents: [],
        handoff: [],
        status: 'accepted',
        items: ['fixed', 'open', 'not_applicable'].map((disposition, index) => ({
          id: `R1-${index + 1}`,
          introducedIn: 'fixture-target',
          kind: 'defect',
          area: 'code',
          required: false,
          location: { path: 'src/example.ts', line: 1 },
          disposition,
          condition: `<script>の表示条件。${'長い条件文。'.repeat(16)}全文の末尾`,
          impact: '誤表示',
          evidence: '保存ログ',
          action: '修正する',
          reason: '保存された裁定理由',
        })),
      },
    ];
    await writeFile(
      statePath,
      JSON.stringify({
        ...state,
        checks: 2,
        events: [
          {
            role: 'check',
            code: 124,
            timedOut: true,
            prefix: join(dir, 'verification/check-timeout'),
          },
          { role: 'check', code: 0, timedOut: false, prefix: join(dir, 'verification/check-1') },
          {
            role: 'capture',
            code: null,
            timedOut: false,
            prefix: join(dir, 'verification/capture'),
          },
          { role: 'repair', code: 7, timedOut: false, prefix: join(dir, 'verification/repair') },
          { role: 'review', code: 0, timedOut: true, prefix: join(dir, 'verification/review') },
        ],
        reviewHistory,
      }),
    );
    const path = await writeRunReport(dir);
    const html = await readFile(path, 'utf8');
    expect(html).toContain('ローカル検証済み');
    expect(html).toContain('2026-09-23T01:02:03.000Z');
    expect(html).toContain('2026-09-23T01:03:04.000Z');
    for (const label of ['開始日時', '終了日時', 'HTML生成日時']) {
      expect(html).toContain(`<dt>${label}（UTC）</dt>`);
    }
    expect(html).toContain('<dt>対象リポジトリ</dt><dd>team/component</dd>');
    expect(html).toContain('2回記録');
    expect(html).toContain('<h2>今回の結果</h2><dl class="summary-fields">');
    for (const [heading, note] of [
      ['検証と評価', 'acceptedは公開後確認や人の承認を意味しません。'],
      ['公開の記録', 'GitHubの現在状態ではなく、run終了時の保存記録です。'],
    ] as const) {
      expect(html).toContain(
        `<h2>${heading}</h2><p class="report-note">${note}</p><dl class="summary-fields">`,
      );
      expect(html.split(note)).toHaveLength(2);
    }
    expect(html).toMatch(
      /\.summary-fields\{[^}]*display:grid;[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*gap:16px/,
    );
    expect(html).toMatch(
      /\.summary-fields>div\{[^}]*padding:12px 14px;[^}]*border:1px solid #dce1e7;[^}]*border-radius:8px;[^}]*background:#fcfdff/,
    );
    expect(html).toMatch(/@media\(max-width:700px\)\{\.summary-fields\{grid-template-columns:1fr/);
    expect(html).toMatch(/\.result-note\{[^}]*border-top:/);
    expect(html).toContain('<div class="result-note"><h3>実行結果</h3>');
    expect(html).toContain('<div class="result-note"><h3>ネクストアクション</h3>');
    expect(html).toContain(
      '<p class="report-note">残る作業: 人によるレビュー。人の承認・マージは、このrunの結果に含みません。</p>',
    );
    expect(html).toMatch(/\.report-note\{[^}]*font-size:13px;[^}]*color:#566170/);
    const scopeNote =
      '保存された事実と未確認事項を、この実行単位で示します。HTML生成は検証や公開を再実行しません。';
    expect(html).not.toContain(scopeNote);
    expect(html).not.toContain('<footer');
    expect(html).toContain('href="./verification/check-1.stdout"');
    expect(html).not.toContain('href="./verification/check-1.stderr"');
    expect(html).not.toContain('ホスト ·');
    expect(html).toContain(
      '<span class="event-title">検証</span><span class="event-source"><span aria-hidden="true">L1</span><span class="visually-hidden">原記録 state.events の1番目（JSONの物理行ではありません）</span>',
    );
    expect(html).toContain('<span class="event-status tone-failure">時間切れ</span>');
    expect(html).toContain('<span class="event-status tone-success">修正済み</span>');
    expect(html).toContain('<span class="event-status tone-pending">要対応</span>');
    expect(html).toContain('<span class="event-status tone-neutral">対象外</span>');
    const hostSummaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
      .map((match) => match[1] ?? '')
      .filter((summary) => summary.includes('原記録 state.events'));
    const outcomes = [
      ['failure', '時間切れ'],
      ['success', '終了コード 0'],
      ['pending', '終了コード 未記録'],
      ['failure', '終了コード 7'],
      ['failure', '時間切れ'],
    ];
    expect(hostSummaries).toHaveLength(outcomes.length);
    outcomes.forEach(([tone, label], index) => {
      expect(hostSummaries[index]).toContain(`state.events の${index + 1}番目`);
      expect(hostSummaries[index]).not.toContain('events.jsonl');
      expect(hostSummaries[index]).toContain(
        `<span class="event-status tone-${tone}">${label}</span>`,
      );
    });
    expect(html).toContain('時間切れ</span>');
    expect(html).toContain('<dt>終了コード</dt><dd>124</dd>');
    expect(html).toContain('<dt>ログ保存先の接頭辞</dt>');
    expect(html).toContain('指摘 R1-1 · &lt;script&gt;の表示条件');
    expect(html).toContain('修正済み');
    expect(html).toContain('全文の末尾');
    for (const detail of ['誤表示', '保存ログ', '修正する', '保存された裁定理由']) {
      expect(html).toContain(detail);
    }
    expect(html).toContain('href="./verification/state.json">verification/state.json</a>');
    expect(html).not.toContain('<th>verification/state.json</th>');
    expect(html).not.toContain('Draft公開・CI確認済み');
    expect(html).not.toContain('https://github.com/team/component/pull/100');

    await writeFile(
      statePath,
      JSON.stringify({
        ...state,
        reviewHistory: reviewHistory.map((review) => ({ ...review, items: [] })),
      }),
    );
    const empty = await readFile(
      await writeRunReport(dir, join(dir, 'report-no-findings.html')),
      'utf8',
    );
    const reviewSection = empty.match(/<h2>独立評価の指摘<\/h2>(.*?)<\/section>/)?.[1] ?? '';
    expect(reviewSection).toContain(
      '<p class="review-summary"><strong>修正必須の指摘なし</strong>（accepted）。保存済みの指摘を確認した。</p>',
    );
    expect(reviewSection).not.toContain('actor-group');
    expect(reviewSection).not.toContain('activity-list');
    expect(reviewSection).not.toContain('empty-list');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stopped run keeps its reason as escaped text without implying an evaluation', async () => {
  const { dir } = await fixture('stopped');
  try {
    await writeFile(join(dir, 'setup-1.stderr'), 'setup failed');
    await writeFile(join(dir, 'implementation.stderr'), 'diagnostic');
    for (const name of ['review-codex-first', 'review-codex-second']) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'events.jsonl'), '{"type":"turn.completed"}\n');
    }
    const actor = join(dir, 'repair-codex-example');
    await mkdir(actor);
    await writeFile(
      join(actor, 'events.jsonl'),
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: '<img src=x onerror=alert(1)>',
            aggregated_output: '<script>alert(2)</script>',
            exit_code: 0,
          },
        }),
        '',
        '{unfinished',
        JSON.stringify({ type: 'turn.failed', error: 'Synthetic failure' }),
        '{"type":"item.completed","item":{"type":"mcp_tool_call","arguments":{"id":9007199254740993},"result":1e400}}',
        '{"type":"constructor"}',
        '{"type":"__proto__"}',
      ].join('\n') + '\n',
    );
    const html = await readFile(await writeRunReport(dir), 'utf8');
    const actorHeaders = [...html.matchAll(/<section class="actor-group"><header>(.*?)<\/header>/g)]
      .map((match) => match[1])
      .join('\n');
    expect(actorHeaders).toContain('<h4>実装・修正担当AI</h4><p>repair-codex-example</p>');
    expect(actorHeaders).toContain('href="./repair-codex-example/events.jsonl"');
    for (const name of ['review-codex-first', 'review-codex-second']) {
      expect(actorHeaders).toContain(`<h4>レビュー担当AI</h4><p>${name}</p>`);
      expect(actorHeaders).toContain(`href="./${name}/events.jsonl"`);
    }
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('入力 · command');
    expect(html).toContain('出力 · aggregated_output');
    expect(html).toContain('関連記録の注意');
    expect(html).toContain('turn.failed');
    expect(html).toContain('9007199254740993');
    expect(html).toContain('1e400');
    expect(html).toContain('5/6行表示');
    expect(html).toContain(
      'constructor</span><span class="event-source"><span aria-hidden="true">L6</span><span class="visually-hidden">原記録 events.jsonl の6行目</span>',
    );
    expect(html).toContain(
      '__proto__</span><span class="event-source"><span aria-hidden="true">L7</span><span class="visually-hidden">原記録 events.jsonl の7行目</span>',
    );
    expect(html).toContain('repair-codex-example/events.jsonl:3:');
    expect(html).toContain('href="./setup-1.stderr"');
    expect(html).toContain('href="./implementation.stderr"');
    expect(html).toContain('setup-1.stdout');
    expect(html).not.toContain('<script>');
    expect(html).toContain('独立評価');
    expect(html).toContain('未記録');
    expect(html).toContain('<h2>独立評価の指摘</h2><p>未記録</p>');
    expect(html).toContain(
      '<p class="report-note">入出力の区分は未確認です。保存された行の抜粋です。</p>',
    );
    expect(html).toContain("default-src 'none'");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('published draft requires CI evidence, and invalid evidence or existing output is preserved', async () => {
  const { dir, result } = await fixture('published_draft');
  try {
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({ ...result, ciDetails: { status: 'passed' } }),
    );
    const path = await writeRunReport(dir);
    const html = await readFile(path, 'utf8');
    expect(html).toContain(
      '<summary><span class="event-title">CIの保存結果</span><span class="event-chevron" aria-hidden="true">›</span></summary>',
    );
    expect(html).toMatch(
      /summary\{[^}]*display:grid;[^}]*grid-template-columns:minmax\(0,1fr\) 18px;[^}]*list-style:none/,
    );
    expect(html).toMatch(/summary::-webkit-details-marker\{display:none/);
    expect(html).toMatch(/details\[open\]>summary>\.event-chevron\{transform:rotate\(90deg\)/);
    expect(html).toMatch(/summary:focus-visible\{[^}]*outline:3px/);
    expect(html).toContain('Draft公開・CI確認済み');
    expect(html).toContain('https://github.com/team/component/pull/100');
    expect(html).toContain('<span class="status-badge tone-success">passed</span>');
    await assert.rejects(() => writeRunReport(dir), /EEXIST/);
    expect(await readFile(path, 'utf8')).toBe(html);
    await writeFile(join(dir, 'result.json'), JSON.stringify({ ...result, ci: undefined }));
    await assert.rejects(
      () => writeRunReport(dir, join(dir, 'report-new.html')),
      /Incomplete published draft/,
    );
    await writeFile(join(dir, 'result.json'), JSON.stringify(result));
    await writeFile(join(dir, 'verification/state.json'), '{invalid');
    const partial = await readFile(await writeRunReport(dir, join(dir, 'report-new.html')), 'utf8');
    expect(partial).toContain('関連記録の注意');
    expect(partial).toContain('Draft公開・CI確認済み');
    expect(partial).toContain('href="./verification/state.json"');
    await writeFile(join(dir, 'verification/state.json'), JSON.stringify({ reviewFormat: 3 }));
    await assert.rejects(
      () => writeRunReport(dir, join(dir, 'report-old-state.html')),
      /Unsupported verification state format/,
    );
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({
        ...result,
        startedAt: undefined,
        finishedAt: undefined,
        terminal: undefined,
      }),
    );
    await assert.rejects(
      () => writeRunReport(dir, join(dir, 'report-old-result.html')),
      /Invalid result.json/,
    );
    await writeFile(join(dir, 'result.json'), JSON.stringify({ ...result, terminal: undefined }));
    await assert.rejects(
      () => writeRunReport(dir, join(dir, 'report-late.html')),
      /Invalid result.json/,
    );
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toContain('published_draft');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('report translates only exact known result messages and remaining tasks without changing saved evidence', async () => {
  const { dir, result } = await fixture('published_draft');
  const reason = 'All required checks succeeded and no registered check is failing or pending.';
  const nextAction =
    'CI confirmed for the published draft commit. Assigned AI: compare the latest public body with the Issue, commit, accepted assessment and verification, complete any rendered media check, then recheck target, body, evidence, actor, permissions and same-head CI before gh pr ready; read back the result before human review.';
  try {
    const saved = JSON.stringify({
      ...result,
      reason,
      nextAction,
      remaining: [
        'local_verification',
        'publication',
        'ci',
        'attachments',
        'rendered_media_check',
        'published_body_check',
        'mark_ready',
        'human_review',
        '<unknown>',
        'constructor',
      ],
    });
    await writeFile(join(dir, 'result.json'), saved);
    const html = await readFile(await writeRunReport(dir), 'utf8');
    expect(html).toContain(
      '必須チェックはすべて成功し、登録されたチェックに失敗や保留はありません。',
    );
    expect(html).toContain(
      '公開したdraftのcommitについてCIを確認しました。担当AIは、最新の公開本文をIssue・commit・accepted評価・検証結果と照合し、必要な媒体の実表示確認を完了してください。その後、対象・本文・証拠・実行主体・権限・同じheadのCIを再確認してから gh pr ready を実行し、人のレビュー前に切替結果を読み戻してください。',
    );
    expect(html).toContain(
      '残る作業: ローカル検証、公開、CI確認、媒体の添付、必要媒体の実表示確認、公開本文の確認、readyへの切替、人によるレビュー、&lt;unknown&gt;、constructor',
    );
    expect(html).not.toContain(reason);
    expect(html).not.toContain(nextAction);
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe(saved);

    const unknown = JSON.stringify({
      ...result,
      status: 'stopped',
      reason: `${reason} <unconfirmed>`,
      nextAction: `${nextAction} <new condition>`,
    });
    await writeFile(join(dir, 'result.json'), unknown);
    const fallback = await readFile(
      await writeRunReport(dir, join(dir, 'report-unknown.html')),
      'utf8',
    );
    expect(fallback).toContain(`${reason} &lt;unconfirmed&gt;`);
    expect(fallback).toContain(`${nextAction} &lt;new condition&gt;`);
    expect(fallback).not.toContain('必須チェックはすべて成功');
    expect(fallback).not.toContain('Draft公開・CI確認済み');
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe(unknown);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('command input candidates follow literal read operands, excluding patterns, destinations and unsupported syntax', async () => {
  const cases: { command: string; paths: string[] }[] = [
    { command: 'cat README.md docs/policy.md', paths: ['README.md', 'docs/policy.md'] },
    {
      command: `cat 'docs/space name.md' "other file.md" escaped\\ name.md`,
      paths: ['docs/space name.md', 'other file.md', 'escaped name.md'],
    },
    {
      command: `cat docs/'mixed name'.md 'literal$path.md' "literal\\$name.md"`,
      paths: ['docs/mixed name.md', 'literal$path.md', 'literal$name.md'],
    },
    {
      command: `cat -- '-file.md'; sed -n '12,40p' src/one.ts src/two.ts`,
      paths: ['-file.md', 'src/one.ts', 'src/two.ts'],
    },
    {
      command: `pwd && /bin/cat -n README.md | head -n 5; tail -c20 log.txt\nhead -10 next.txt`,
      paths: ['README.md', 'log.txt', 'next.txt'],
    },
    {
      command: `sed -n -e '2,$p' 'space name.md'; tail -n +3 last.txt`,
      paths: ['space name.md', 'last.txt'],
    },
    {
      command: `/bin/zsh -lc 'cat README.md && sed -n "1,20p" docs/policy.md'`,
      paths: ['README.md', 'docs/policy.md'],
    },
    {
      command: `cat in.txt > out.txt 2> errors.txt && head -n 3 other.txt >> combined.txt`,
      paths: ['in.txt', 'other.txt'],
    },
    {
      command: `cat one.md one.md; cat two.md # cat comment.md\ncat three.md`,
      paths: ['one.md', 'two.md', 'three.md'],
    },
    { command: 'cat \\\n continued.md', paths: ['continued.md'] },
    {
      command: `cat 'semi;pipe|and&&.md' || head -c 3 fallback.md`,
      paths: ['semi;pipe|and&amp;&amp;.md', 'fallback.md'],
    },
    {
      command: `rg -n 'cat fake.md' src; rg --files docs; find . -name '*.md'; ls docs`,
      paths: [],
    },
    { command: `printf '%s' 'cat fake.md'; echo cat fake.md`, paths: [] },
    { command: `sed -n '/needle/p' file.txt; sed -n '1p;w out.txt' file.txt`, paths: [] },
    {
      command: `cat --unknown value.txt; head -n invalid count.txt; tail --bytes 5 file.txt`,
      paths: [],
    },
    { command: `cat "$INPUT"; cat static.md`, paths: [] },
    { command: 'cat "/tmp/$FILE"; cat "/private/tmp/$FILE"', paths: [] },
    { command: `cat $(printf 'cat fake.md'); cat static.md`, paths: [] },
    { command: 'cat `echo file.md`', paths: [] },
    { command: `cat *.md; cat ~user/file.md`, paths: [] },
    { command: `cat <(cat process.md)`, paths: [] },
    { command: `cat <<EOF\ncat fake.md\nEOF\ncat static.md`, paths: [] },
    { command: `cat <<< 'cat fake.md'; cat static.md`, paths: [] },
    { command: `for file in one.md; do cat fake.md; done`, paths: [] },
    { command: `cat 'unfinished.md; cat fake.md`, paths: [] },
    { command: 'cat -; head -n 5; cat < redirected.txt', paths: [] },
  ];
  const { dir } = await fixture('stopped');
  try {
    const actor = join(dir, 'repair-codex-inputs');
    await mkdir(actor);
    await writeFile(
      join(actor, 'events.jsonl'),
      cases
        .map(({ command }) =>
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'command_execution', command, aggregated_output: '', exit_code: 0 },
          }),
        )
        .join('\n'),
    );
    const html = await readFile(await writeRunReport(dir), 'utf8');
    const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
      .map((match) => match[1] ?? '')
      .filter((summary) => summary.includes('コマンド実行'));
    const bodies = [...html.matchAll(/<section class="command-paths">([\s\S]*?)<\/section>/g)];
    expect(bodies).toHaveLength(cases.length);
    cases.forEach(({ command, paths }, index) => {
      const body = bodies[index]?.[1] ?? '';
      expect(summaries[index], command).not.toContain('抽出');
      if (!paths.length) {
        expect(summaries[index], command).not.toContain('command-inputs');
      }
      const displayed = [...body.matchAll(/<li class="input-path">([\s\S]*?)<\/li>/g)].map(
        (match) => match[1],
      );
      expect(displayed, command).toEqual(
        paths.map((path) => `<code class="input-path-value">${path}</code>`),
      );
      if (!paths.length) {
        expect(body, command).toContain(
          '<p>ファイル候補を抽出できませんでした。元のcommandと原記録を確認してください。</p>',
        );
        expect(body.match(/<p>/g), command).toHaveLength(1);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collapsed commands show escaped filenames while full paths and original evidence survive alternate report generation', async () => {
  const { dir } = await fixture('verified_local');
  try {
    const original = await writeRunReport(dir);
    const originalHtml = await readFile(original, 'utf8');
    const actor = join(dir, 'repair-codex-inputs');
    await mkdir(actor);
    const longPath = `${'long-directory/'.repeat(90)}same.md`;
    const tmpPaths = [
      ['/tmp/same.md', true],
      [`/private/tmp/${longPath}`, true],
      ['/tmp-other/same.md', false],
      ['/private/tmp-old/same.md', false],
      ['tmp/same.md', false],
      ['./tmp/same.md', false],
      ['/var/tmp/same.md', false],
    ] as const;
    const events = [
      { type: 'item.started', item: { type: 'command_execution', command: 'cat pending.md' } },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: `cat 'one/same.md' '${longPath}' '<img src=x onerror=alert(1)>&".md'; rg --files`,
          aggregated_output: 'permission denied',
          exit_code: 1,
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: `cat ${tmpPaths.map(([path]) => `'${path}'`).join(' ')} '/tmp/<img src=x>&".md'`,
          exit_code: 1,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    await writeFile(join(actor, 'events.jsonl'), events);
    const result = await readFile(join(dir, 'result.json'), 'utf8');
    const state = await readFile(join(dir, 'verification/state.json'), 'utf8');
    await writeFile(join(dir, 'implementation-summary.md'), 'Saved summary <unchanged>');
    const html = await readFile(await writeRunReport(dir, join(dir, 'report-inputs.html')), 'utf8');
    const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(
      (match) => match[1] ?? '',
    );
    const summary = summaries.find((value) => value.includes('原記録 events.jsonl の2行目')) ?? '';
    expect(summary).toContain('<span class="event-title">コマンド実行</span>');
    expect(summary).toContain(
      '<span class="event-source"><span aria-hidden="true">L2</span><span class="visually-hidden">原記録 events.jsonl の2行目</span>',
    );
    expect(summary).not.toContain('行 2 ·');
    expect(summary).not.toContain('抽出');
    expect(summary).not.toContain('入力ファイル候補');
    expect(html).toContain('<p>ファイル候補はcommandから一部のみ抽出。</p>');
    expect(html).toContain('<p>ファイル候補はcommandから抽出。</p>');
    expect(html).toContain(
      '<pre>Saved summary &lt;unchanged&gt;</pre><p class="summary-source"><a href="./implementation-summary.md">要約の原記録を開く</a></p>',
    );
    expect(html).toMatch(/\.summary-source\{[^}]*text-align:right;[^}]*font-size:13px/);
    expect(summary).toContain('<code>same.md</code>');
    expect(summary).toContain('one/');
    expect(summary).toContain('long-directory/'.repeat(90));
    expect(summary).toContain('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;.md');
    expect(summary).toContain('終了コード 1');
    expect(summary).toContain('<span class="input-file" tabindex="0">');
    const tmpSummary =
      summaries.find((value) => value.includes('原記録 events.jsonl の3行目')) ?? '';
    for (const [path, temporary] of tmpPaths) {
      const slash = path.lastIndexOf('/');
      const name = path.slice(slash + 1);
      const parent = path.slice(0, slash + 1);
      expect(tmpSummary).toContain(
        `<span class="input-file${temporary ? ' input-file-tmp' : ''}" tabindex="0"><code>${name}</code><span class="input-directory">${parent}</span>${temporary ? '<span class="input-location">tmp</span>' : ''}</span>`,
      );
      expect(html).toContain(
        `<li class="input-path"><code class="input-path-value">${path}</code></li>`,
      );
    }
    expect(tmpSummary).toContain(
      '<span class="input-file input-file-tmp" tabindex="0"><code>&lt;img src=x&gt;&amp;&quot;.md</code><span class="input-location">tmp</span></span>',
    );
    expect(tmpSummary).not.toContain('抽出');
    expect(tmpSummary).not.toContain('入力ファイル候補');
    expect(html).toMatch(/\.input-file-tmp\{[^}]*background:#f4f0e8/);
    expect(html).toMatch(/\.input-location\{[^}]*font-size:11px/);
    expect(html).toContain(
      '<li class="input-path"><code class="input-path-value">/tmp/&lt;img src=x&gt;&amp;&quot;.md</code></li>',
    );
    expect(html).toMatch(/\.command-paths ul\{[^}]*list-style:none;[^}]*padding:0/);
    expect(html).toMatch(/\.input-path\+\.input-path\{[^}]*border-top:/);
    expect(html).toMatch(
      /\.input-path-value\{[^}]*display:block;[^}]*color:#566170;[^}]*white-space:pre-wrap;[^}]*overflow-wrap:anywhere/,
    );
    expect(html).toMatch(/\.command-inputs\{[^}]*display:flex;[^}]*flex-wrap:wrap/);
    expect(html).toMatch(
      /\.input-file\{[^}]*display:inline-flex;[^}]*max-width:100%;[^}]*white-space:nowrap;[^}]*overflow-x:auto/,
    );
    expect(html).toMatch(/\.input-file>\*\{[^}]*flex-shrink:0/);
    expect(html).toMatch(/\.input-file code\{[^}]*white-space:inherit/);
    expect(html).toMatch(/summary:hover \.event-title\{[^}]*text-decoration:underline/);
    expect(html).not.toMatch(/\.event-disclosure>summary:hover \.event-heading\{/);
    expect(html).toMatch(
      /\.event-source\{[^}]*display:inline-block;[^}]*margin-left:8px;[^}]*white-space:nowrap/,
    );
    expect(html).not.toMatch(/href="[^"]*events\.jsonl#/);
    const notes = html.match(/<aside class="report-notes"[^>]*>([\s\S]*?)<\/aside>/)?.[1] ?? '';
    expect(notes).toContain('<h3 id="report-notes-title">読み方</h3><ul>');
    expect(html).toMatch(
      /\.report-notes ul\{margin:0;padding-inline-start:1.2em;list-style-position:outside\}/,
    );
    expect(notes.match(/<li>/g)).toHaveLength(4);
    expect(notes).not.toContain('<details');
    for (const explanation of [
      '各ログ内の記録順。別ログ間の前後は未確認です。',
      'LはAI側がevents.jsonlの物理行、ホスト側がstate.eventsの1始まりの記録順です。',
      'タグは保存commandから静的に抽出した入力ファイル候補。読取り成功・モデルの理解は未確認です。',
      '抽出漏れがあり、パスと抽出状態は展開後に確認できます。相対パスは未解決です。',
      '/tmp/・/private/tmp/で始まる保存パスの場所の印。用途・削除可否・読了は示さず、実在・リンク先は未確認です。',
      '色と状態文字列を併記。緑=成功/修正済み、赤=失敗、黄=未確認/要対応、青=記録/応答完了、灰=対象外/不明。完了は内容の検証済みを意味しません。',
    ]) {
      expect(notes).toContain(explanation);
      expect(html.split(explanation)).toHaveLength(2);
    }
    expect(html.indexOf('<aside class="report-notes"')).toBeLessThan(
      html.indexOf('<h3>ホストの実行ログ</h3>'),
    );
    for (const body of html.matchAll(/<section class="command-paths">([\s\S]*?)<\/section>/g)) {
      expect(body[1]).not.toContain('静的に抽出');
      expect(body[1]).not.toContain('理解は未確認');
      expect(body[1]).not.toContain('<a ');
    }
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<details class="event-disclosure" open');
    expect(html).toContain(`<code class="input-path-value">${longPath}</code>`);
    expect(html).toContain('permission denied');
    expect(html).toContain('開始 · 結果未確認');
    expect(html).toContain('<code>pending.md</code>');
    expect(html).toContain('入力 · command');
    expect(html).toContain('画面上の抜粋');
    expect(html).toContain('href="./repair-codex-inputs/events.jsonl"');
    expect(html).toContain("default-src 'none'");
    expect(await readFile(original, 'utf8')).toBe(originalHtml);
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe(result);
    expect(await readFile(join(dir, 'verification/state.json'), 'utf8')).toBe(state);
    expect(await readFile(join(actor, 'events.jsonl'), 'utf8')).toBe(events);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('event titles respect event and item kinds while badge tones follow explicit outcomes', async () => {
  const { dir, result } = await fixture('stopped');
  const cases: { event: unknown; title: string; tone: string; label: string }[] = [
    {
      event: { type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } },
      title: 'コマンド実行',
      tone: 'success',
      label: '終了コード 0',
    },
    {
      event: {
        type: 'item.completed',
        item: { type: 'command_execution', exit_code: 2, aggregated_output: 'All checks passed' },
      },
      title: 'コマンド実行',
      tone: 'failure',
      label: '終了コード 2',
    },
    {
      event: {
        type: 'item.completed',
        item: { type: 'command_execution', aggregated_output: 'success' },
      },
      title: 'コマンド実行',
      tone: 'pending',
      label: '終了コード未記録',
    },
    {
      event: { type: 'item.started', item: { type: 'command_execution', exit_code: 0 } },
      title: 'コマンド実行',
      tone: 'pending',
      label: '開始 · 結果未確認',
    },
    {
      event: { type: 'item.updated', item: { type: 'command_execution', exit_code: 0 } },
      title: 'コマンド実行',
      tone: 'pending',
      label: '更新 · 結果未確認',
    },
    { event: { type: 'turn.failed' }, title: 'turn.failed', tone: 'failure', label: '失敗の記録' },
    { event: { type: 'error' }, title: 'error', tone: 'failure', label: '失敗の記録' },
    {
      event: { type: 'item.completed', item: { type: 'agent_message', text: 'success' } },
      title: 'モデルの応答',
      tone: 'info',
      label: '完了イベント',
    },
    {
      event: { type: 'item.completed', item: { type: 'mcp_tool_call' } },
      title: 'MCPツール',
      tone: 'pending',
      label: '完了イベント · 成否未確認',
    },
    {
      event: { type: 'thread.started' },
      title: '対話の開始',
      tone: 'info',
      label: '記録されたイベント',
    },
    {
      event: { type: 'turn.started' },
      title: '処理の開始',
      tone: 'pending',
      label: '記録されたイベント',
    },
    {
      event: { type: 'turn.completed' },
      title: '処理の終了',
      tone: 'info',
      label: '記録されたイベント',
    },
    {
      event: { type: 'item.completed', item: { type: 'file_change' } },
      title: 'ファイルの変更',
      tone: 'pending',
      label: '完了イベント · 成否未確認',
    },
    {
      event: { type: 'file_change' },
      title: 'file_change',
      tone: 'neutral',
      label: '記録されたイベント',
    },
    {
      event: { type: 'item.completed', item: { type: 'thread.started' } },
      title: 'thread.started',
      tone: 'pending',
      label: '完了イベント · 成否未確認',
    },
    {
      event: { type: 'item.completed', item: { type: '<unknown>' } },
      title: '&lt;unknown&gt;',
      tone: 'pending',
      label: '完了イベント · 成否未確認',
    },
    {
      event: { type: 'constructor', item: { type: 'command_execution', exit_code: 0 } },
      title: 'コマンド実行',
      tone: 'neutral',
      label: '種類不明 · 成否未確認',
    },
    {
      event: { type: '<unknown>' },
      title: '&lt;unknown&gt;',
      tone: 'neutral',
      label: '記録されたイベント',
    },
  ];
  try {
    const actor = join(dir, 'repair-codex-tones');
    await mkdir(actor);
    await writeFile(
      join(actor, 'events.jsonl'),
      cases.map(({ event }) => JSON.stringify(event)).join('\n'),
    );
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({ ...result, publication: 'constructor', ci: '<unknown>' }),
    );
    const html = await readFile(await writeRunReport(dir), 'utf8');
    const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(
      (match) => match[1] ?? '',
    );
    cases.forEach(({ title, tone, label }, index) => {
      expect(summaries[index]).toContain(`<span class="event-title">${title}</span>`);
      expect(summaries[index]).toContain(`<span class="event-status tone-${tone}">${label}</span>`);
    });
    for (const kind of ['thread.started', 'turn.started', 'turn.completed', 'file_change']) {
      expect(html).toContain(`&quot;type&quot;:&quot;${kind}&quot;`);
    }
    expect(html).toContain('href="./repair-codex-tones/events.jsonl"');
    expect(html).toContain('<span class="status-badge tone-neutral">constructor</span>');
    expect(html).toContain('<span class="status-badge tone-neutral">&lt;unknown&gt;</span>');
    expect(html).toContain('class="pill tone-pending">停止</span>');
    for (const tone of ['success', 'failure', 'pending', 'info', 'neutral']) {
      expect(html).toMatch(
        new RegExp(`\\.tone-${tone}\\{[^}]*background:#[a-f0-9]+;[^}]*color:#[a-f0-9]+`),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
