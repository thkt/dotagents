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
        items: [
          {
            id: 'R1-1',
            introducedIn: 'fixture-target',
            kind: 'defect',
            area: 'code',
            required: true,
            location: { path: 'src/example.ts', line: 1 },
            disposition: 'fixed',
            condition: `<script>の表示条件。${'長い条件文。'.repeat(16)}全文の末尾`,
            impact: '誤表示',
            evidence: '保存ログ',
            action: '修正する',
            reason: '修正後に確認した',
          },
        ],
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
    expect(html).toContain('href="./verification/check-1.stdout"');
    expect(html).not.toContain('href="./verification/check-1.stderr"');
    expect(html).toContain('1 · ホスト · 検証');
    expect(html).toContain('時間切れ</span>');
    expect(html).toContain('<dt>終了コード</dt><dd>124</dd>');
    expect(html).toContain('<dt>ログ保存先の接頭辞</dt>');
    expect(html).toContain('指摘 R1-1 · &lt;script&gt;の表示条件');
    expect(html).toContain('修正済み');
    expect(html).toContain('全文の末尾');
    for (const detail of ['誤表示', '保存ログ', '修正する', '修正後に確認した']) {
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
    expect(html).toContain('行 5 · constructor');
    expect(html).toContain('行 6 · __proto__');
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
    const path = await writeRunReport(dir);
    const html = await readFile(path, 'utf8');
    expect(html).toContain('Draft公開・CI確認済み');
    expect(html).toContain('https://github.com/team/component/pull/100');
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
    await writeFile(join(dir, 'result.json'), JSON.stringify({ ...result, terminal: undefined }));
    await assert.rejects(
      () => writeRunReport(dir, join(dir, 'report-late.html')),
      /Run result is not terminal/,
    );
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toContain('published_draft');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
