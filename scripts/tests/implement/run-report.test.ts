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
    expect(html).toContain('2回記録');
    for (const heading of ['今回の結果', '検証と評価', '公開の記録']) {
      expect(html).toContain(`<h2>${heading}</h2><dl class="summary-fields">`);
    }
    expect(html).toMatch(
      /\.summary-fields\{[^}]*display:grid;[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*gap:16px/,
    );
    expect(html).toMatch(
      /\.summary-fields>div\{[^}]*padding:12px 14px;[^}]*border:1px solid #dce1e7;[^}]*border-radius:8px;[^}]*background:#fcfdff/,
    );
    expect(html).toMatch(/@media\(max-width:700px\)\{\.summary-fields\{grid-template-columns:1fr/);
    expect(html).toMatch(/\.result-note\{[^}]*border-top:/);
    expect(html).toContain('<div class="result-note"><h3>停止理由・結果</h3>');
    expect(html).toContain('<div class="result-note"><h3>次の対応</h3>');
    for (const note of [
      'acceptedは公開後確認や人の承認を意味しません。',
      'GitHubの現在状態ではなく、run終了時の保存記録です。',
      '残る作業: 人によるレビュー。人の承認・マージは、このrunの結果に含みません。',
    ]) {
      expect(html).toContain(`<p class="report-note">${note}</p>`);
    }
    expect(html).toMatch(/\.report-note\{[^}]*font-size:13px;[^}]*color:#566170/);
    const scopeNote =
      '保存された事実と未確認事項を、この実行単位で示します。HTML生成は検証や公開を再実行しません。';
    expect(html.split(scopeNote)).toHaveLength(2);
    expect(html).toContain(`<footer class="section report-note"><p>${scopeNote}</p></footer>`);
    expect(html.indexOf('<footer')).toBeGreaterThan(html.indexOf('<h2>原記録</h2>'));
    expect(html).toContain('href="./verification/check-1.stdout"');
    expect(html).not.toContain('href="./verification/check-1.stderr"');
    expect(html).not.toContain('1 · ホスト · 検証');
    expect(html).toContain(
      'ホスト · 検証</span><span class="event-source"><span aria-hidden="true">L1</span><span class="visually-hidden">原記録 state.events の1番目（JSONの物理行ではありません）</span>',
    );
    expect(html).toContain('<span class="event-status tone-failure">時間切れ</span>');
    expect(html).toContain('<span class="event-status tone-success">修正済み</span>');
    expect(html).toContain('<span class="event-status tone-pending">要対応</span>');
    expect(html).toContain('<span class="event-status tone-neutral">対象外</span>');
    const hostSummaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
      .map((match) => match[1] ?? '')
      .filter((summary) => summary.includes('ホスト ·'));
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stopped run keeps its reason as escaped text without implying an evaluation', async () => {
  const { dir } = await fixture('stopped');
  try {
    await writeFile(join(dir, 'setup-1.stderr'), 'setup failed');
    await writeFile(join(dir, 'implementation.stderr'), 'diagnostic');
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
      const displayed = [...body.matchAll(/<li><code>([\s\S]*?)<\/code><\/li>/g)].map(
        (match) => match[1],
      );
      expect(displayed, command).toEqual(paths);
      if (!paths.length) {
        expect(body, command).toContain('抽出状態: 抽出できず');
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
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    await writeFile(join(actor, 'events.jsonl'), events);
    const result = await readFile(join(dir, 'result.json'), 'utf8');
    const state = await readFile(join(dir, 'verification/state.json'), 'utf8');
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
    expect(html).toContain('<p>抽出状態: 一部のみ抽出</p>');
    expect(html).toContain('<p>抽出状態: commandから抽出</p>');
    expect(summary).toContain('<code>same.md</code>');
    expect(summary).toContain('one/');
    expect(summary).toContain('long-directory/'.repeat(90));
    expect(summary).toContain('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;.md');
    expect(summary).toContain('終了コード 1');
    expect(summary).toContain('<span class="input-file" tabindex="0">');
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
    for (const explanation of [
      'モデル側のL番号は各events.jsonlの物理行位置です。空行や不正な行も数え、ソースコードの行番号とは区別します。',
      'ホスト側のL番号はverification/state.jsonのstate.events内の1始まりの記録順で、JSONの物理行ではありません。',
      'ホストの保存イベントを順に示します。モデル内の操作は各イベントログ内の順序のみを示し、別ログ間の全体順序は推定しません。',
      '保存commandから静的に抽出した候補です。',
      '実際の読み込み成功やモデルの理解は未確認です。',
      '未対応の構文や標準入力などは抽出できず、入力ファイルがないとは限りません。',
      '相対パスは解決していません。',
    ]) {
      expect(notes).toContain(explanation);
      expect(html.split(explanation)).toHaveLength(2);
    }
    expect(html.indexOf('<aside class="report-notes"')).toBeLessThan(
      html.indexOf('<h3>ホスト工程</h3>'),
    );
    for (const body of html.matchAll(/<section class="command-paths">([\s\S]*?)<\/section>/g)) {
      expect(body[1]).not.toContain('静的に抽出');
      expect(body[1]).not.toContain('理解は未確認');
    }
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<details class="event-disclosure" open');
    expect(html).toContain(`<li><code>${longPath}</code></li>`);
    expect(html).toContain('permission denied');
    expect(html).toContain('開始 · 結果未確認');
    expect(html).toContain('<code>pending.md</code>');
    expect(html).toContain('実際の読み込み成功やモデルの理解は未確認');
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

test('badge tones follow explicit outcomes, never successful-looking output or completion alone', async () => {
  const { dir, result } = await fixture('stopped');
  const cases: { event: unknown; tone: string; label: string }[] = [
    {
      event: { type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } },
      tone: 'success',
      label: '終了コード 0',
    },
    {
      event: {
        type: 'item.completed',
        item: { type: 'command_execution', exit_code: 2, aggregated_output: 'All checks passed' },
      },
      tone: 'failure',
      label: '終了コード 2',
    },
    {
      event: {
        type: 'item.completed',
        item: { type: 'command_execution', aggregated_output: 'success' },
      },
      tone: 'pending',
      label: '終了コード未記録',
    },
    {
      event: { type: 'item.started', item: { type: 'command_execution', exit_code: 0 } },
      tone: 'pending',
      label: '開始 · 結果未確認',
    },
    {
      event: { type: 'item.updated', item: { type: 'command_execution', exit_code: 0 } },
      tone: 'pending',
      label: '更新 · 結果未確認',
    },
    { event: { type: 'turn.failed' }, tone: 'failure', label: '失敗の記録' },
    { event: { type: 'error' }, tone: 'failure', label: '失敗の記録' },
    {
      event: { type: 'item.completed', item: { type: 'agent_message', text: 'success' } },
      tone: 'info',
      label: '完了イベント',
    },
    {
      event: { type: 'item.completed', item: { type: 'mcp_tool_call' } },
      tone: 'pending',
      label: '完了イベント · 成否未確認',
    },
    { event: { type: 'thread.started' }, tone: 'info', label: '記録されたイベント' },
    {
      event: { type: 'constructor', item: { type: 'command_execution', exit_code: 0 } },
      tone: 'neutral',
      label: '種類不明 · 成否未確認',
    },
    { event: { type: '<unknown>' }, tone: 'neutral', label: '記録されたイベント' },
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
    cases.forEach(({ tone, label }, index) => {
      expect(summaries[index]).toContain(`<span class="event-status tone-${tone}">${label}</span>`);
    });
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
