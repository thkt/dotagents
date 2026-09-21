import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewReport, State } from '../../input.ts';
import type { Review } from '../../review.ts';

// Public, synthetic records. Never copy live prompts, paths, identities or model logs here.
export async function reportFixture(
  root: string,
  mode: 'normal' | 'pending' | 'empty' | 'stopped' = 'normal',
) {
  const id = `case-${mode}`;
  const dir = join(root, id);
  const host = join(root, 'host', id);
  const verification = join(dir, 'verification');
  const actor = join(dir, 'review-codex-fixture');
  for (const path of [host, verification, actor, join(dir, 'checkout')]) {
    await mkdir(path, { recursive: true });
  }
  const baseCommit = 'a'.repeat(40);
  const targetId = 'fixture-target-same-trial';
  const review: Review = {
    status: mode === 'empty' ? 'accepted' : 'needs_changes',
    targetId,
    findings: '## 保存されたレビュー\n\n**模擬データ**です。実モデルの品質は測定していません。',
    assessments: {
      code: 'offset が 2 の場合の範囲を確認。',
      requirements: '要求の「offset から最大 limit 件」と照合。',
      tests: 'offset=0 だけでは今回の欠陥を検出できない。',
      documentation: '要求・条件・未確認事項を省略しない。',
    },
    items:
      mode === 'empty'
        ? []
        : [
            {
              id: 'R1-1',
              introducedIn: targetId,
              kind: 'defect',
              area: 'code',
              required: true,
              location: { path: 'page.ts', line: 3 },
              disposition: 'open',
              condition:
                'offset が 0 より大きく、残りの配列に要素がある場合。\n\n入力 `[10,20,30,40]`, offset=2, limit=2。',
              impact: '期待した `[30,40]` が取得できない。',
              evidence: '同じ試行の独立した再現は `[]` を返した。',
              action: '終了位置を `offset + limit` にする。',
              reason: '対象は修正していない。真偽の裁定と修正状況を区別する。',
            },
            {
              id: 'R1-2',
              introducedIn: targetId,
              kind: 'concern',
              area: 'documentation',
              required: false,
              location: { path: null, line: null },
              disposition: 'fixed',
              condition:
                '長い日本語の要求を確認するとき、境界条件と未計測の事項を省略すると誤解が起こり得る。'.repeat(
                  12,
                ),
              impact: '条件付きの判断が無条件の成功に見える可能性。',
              evidence: 'この懸念に対応する実際の操作・再現は保存されていない。',
              action: '元の条件と限界を照合する。',
              reason: 'fixed は模擬レビューの修正状況であり、真偽の確認完了を示さない。',
            },
          ],
    documents: [{ path: 'README.md', role: 'current', reason: '元の要求に対応する使用説明。' }],
    handoff: ['親子使用量と金額は未確認。'],
  };
  const result = fixtureResult(mode, id, baseCommit, review, dir, host);
  const issue = {
    title: '配列のページ分割 — 公開確認用の模擬記録',
    state: 'OPEN',
    updatedAt: '2026-09-21T00:00:00Z',
    body: '# 要求\n\n`page(items, offset, limit)` は offset から最大 limit 件を返す。\n\n- 元配列を変更しない。\n- 不正な境界は RangeError。\n\n| 条件 | 期待値 |\n| --- | --- |\n| offset=2, limit=2 | [30,40] |\n\n```ts\npage([10,20,30,40], 2, 2)\n```\n\n[参考](https://example.com/reference)\n\n<script>globalThis.REPORT_EXECUTED = true</script>\n\n[実行させない](javascript:alert(1))\n\n![外部画像は取得しない](https://example.com/image.png)',
  };
  const state: State = {
    reviewFormat: 4,
    baseCommit,
    configHash: 'fixture-config',
    issueHash: 'fixture-issue',
    reviewHistory: result.review ? [result.review] : [],
    repair: 0,
    review: 1,
    checks: 1,
    modelMs: 900,
    active: null,
    result: result.stop,
    events: [
      { role: 'check', code: 0, timedOut: false, prefix: join(verification, 'check-1'), ms: 300 },
      {
        role: 'review',
        code: mode === 'stopped' ? 1 : 0,
        timedOut: false,
        prefix: join(verification, 'review-1'),
        ms: 900,
      },
    ],
  };
  const save = async (path: string, value: unknown) =>
    writeFile(path, JSON.stringify(value, null, 2));
  await save(join(host, 'result.json'), result);
  await save(
    join(root, 'host', 'cases.json'),
    ['normal', 'pending', 'empty', 'stopped'].map((name) => ({
      id: `case-${name}`,
      name: name === 'empty' ? 'correct' : 'defective',
    })),
  );

  await save(join(dir, 'issue.json'), issue);
  await save(join(root, 'host', 'environment.json'), {
    model: { model: 'synthetic-no-model', reasoningEffort: 'none' },
    bun: '1.4.2',
    harnessCommit: baseCommit,
  });
  await save(join(dir, 'config.json'), {
    cwd: join(dir, 'checkout'),
    baseCommit,
    check: ['bun', 'test'],
  });
  await save(join(verification, 'state.json'), state);
  if (mode !== 'stopped') {
    await save(join(verification, 'review-1.target.json'), {
      targetId,
      baseCommit,
      source: 'fixture-source',
      issue: { content: JSON.stringify(issue) },
      check: state.events[0],
      model: { settings: 'synthetic-no-model' },
    });
    await save(join(verification, 'review-1.json'), {
      target: join(verification, 'review-1.target.json'),
      review,
      documents: [],
    });
    await save(join(verification, 'review-1.additions.json'), [
      {
        path: 'saved-example.test.ts',
        mode: 33188,
        symlink: false,
        content: Buffer.from(
          '// 保存時点の追加テスト\nexpect(page([10,20,30,40], 2, 2)).toEqual([30,40]);\n// </pre><script>globalThis.ADDITION_EXECUTED = true</script>\n',
        ).toString('base64'),
      },
      { path: 'saved-link', mode: 41471, symlink: true, content: '../checkout/page.ts' },
      { path: 'binary.dat', mode: 33188, symlink: false, content: 'AP8=' },
    ]);
    await writeFile(
      join(verification, 'review-1.diff'),
      '@@ page.ts @@\n+return items.slice(offset, limit);\n',
    );
  }
  for (const event of state.events) {
    await writeFile(
      event.prefix + '.stdout',
      event.role === 'check' ? '1 pass (synthetic)' : 'simulated reviewer output',
    );
    if (mode !== 'pending' && mode !== 'stopped') {
      await writeFile(event.prefix + '.stderr', '');
    }
  }
  await writeFile(
    join(verification, 'review-1.prompt'),
    '模擬要求のみ。実際のモデルは呼び出さない。',
  );
  if (mode !== 'pending' && mode !== 'stopped') {
    await writeFile(
      join(actor, 'events.jsonl'),
      [
        { type: 'item.started', item: { type: 'command_execution', command: 'bun test' } },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            exit_code: 1,
            aggregated_output: '<img src=x onerror=alert(1)> synthetic failure',
          },
        },
        {
          type: 'turn.completed',
          usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 35 },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );
    await writeFile(join(actor, 'stderr.log'), '');
    await save(join(actor, 'final.json'), review);
  }
  await writeFile(join(dir, 'checkout', 'page.ts'), 'CURRENT CHECKOUT IS NOT HISTORICAL EVIDENCE');
  return { input: join(host, 'result.json'), result, dir, issue, state, actor, verification };
}

function fixtureResult(
  mode: string,
  id: string,
  baseCommit: string,
  review: Review,
  dir: string,
  host: string,
): ReviewReport {
  const result: ReviewReport = {
    id,
    name: mode === 'empty' ? 'correct' : 'defective',
    baseCommit,
    elapsedMs: 1234.5,
    modelMs: 900,
    stop:
      mode === 'stopped'
        ? 'review_failed'
        : mode === 'empty'
          ? 'ready_for_human_review'
          : 'human_decision_required',
    review: mode === 'stopped' ? null : review,
    usage:
      mode === 'pending' || mode === 'stopped'
        ? null
        : {
            totals: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 35 },
            completedTurns: 1,
            scope: 'Reviewer CLI completed-turn usage; delegated model totals remain unconfirmed.',
          },
    reproduction:
      mode === 'stopped'
        ? null
        : {
            input: { items: [10, 20, 30, 40], offset: 2, limit: 2 },
            expected: [30, 40],
            actual: mode === 'empty' ? [30, 40] : [],
            source: join(dir, 'checkout', 'page.ts'),
            oracle: join(host, 'oracle.ts'),
          },
    adjudication: fixtureAdjudication(mode, review),
    limitations: [
      '公開可能な模擬データ。実モデルの実測ではありません。',
      '読みやすさや速度の改善効果は未測定。',
    ],
  };
  return result;
}
function fixtureAdjudication(mode: string, review: Review): ReviewReport['adjudication'] {
  if (mode === 'stopped') {
    return null;
  }
  const completed = mode === 'normal';
  return {
    status: completed ? 'completed' : 'pending_host_adjudication',
    knownDefect: mode === 'empty' ? null : 'slice uses limit as end index',
    missedKnownDefect: completed ? false : null,
    findings: review.items.map((item, index) => ({
      id: item.id,
      verdict: completed
        ? (['demonstrated', 'false_positive'][index] ?? 'unconfirmed')
        : 'unconfirmed',
      reproduction: completed
        ? { input: 'offset=2, limit=2', expected: [30, 40], actual: [] }
        : null,
      reason: completed ? '模擬の裁定根拠。一般的な品質の証明ではない。' : null,
    })),
    instruction: '指摘ごとに同じ試行の再現で裁定する。',
  };
}
