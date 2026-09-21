import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewReport, State } from '../../input.ts';
import { reviewTrial } from '../../review-trial.ts';
import type { Review } from '../../review.ts';

// Public, synthetic records. Never copy live prompts, paths, identities or model logs here.
export async function reportFixture(
  root: string,
  mode: 'normal' | 'pending' | 'empty' | 'stopped' | 'unmet' | 'missed' = 'normal',
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
  const noFindings = ['empty', 'missed'].includes(mode);
  const hasLogs = !['pending', 'stopped'].includes(mode);
  const testInput = mode === 'empty' ? '2, 2)).toEqual([30,40])' : '0, 2)).toEqual([10,20])';
  const sliceEnd = mode === 'empty' ? 'offset + limit' : 'limit';
  const review: Review = {
    status: noFindings ? 'accepted' : 'needs_changes',
    targetId,
    findings: '## 保存されたレビュー\n\n**模擬データ**です。実モデルの品質は測定していません。',
    assessments: {
      code: 'offset が 2 の場合の範囲を確認。',
      requirements: '要求の「offset から最大 limit 件」と照合。',
      tests: 'offset=0 だけでは今回の欠陥を検出できない。',
      documentation: '要求・条件・未確認事項を省略しない。',
    },
    items: noFindings
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
            kind: 'defect',
            area: 'tests',
            required: false,
            location: { path: null, line: null },
            disposition: 'fixed',
            condition:
              '長い日本語の要求を確認するとき、境界条件と未計測の事項を省略すると誤解が起こり得る。'.repeat(
                12,
              ),
            impact: '正のoffsetで非空結果を期待するテスト不足により、同じ機能不具合を見逃す。',
            evidence:
              'R1-1と同じ入力で機能不具合が再現する。テスト不足の裁定はホストの記録で確認する。',
            action: '元の条件と限界を照合する。',
            reason: 'fixed は模擬レビューの修正状況であり、真偽の確認完了を示さない。',
          },
        ],
    documents: [{ path: 'README.md', role: 'current', reason: '元の要求に対応する使用説明。' }],
    handoff: ['親子使用量と金額は未確認。'],
  };
  configureFinding(review, mode);
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
    ['normal', 'pending', 'empty', 'stopped', 'unmet', 'missed'].map((name) => ({
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
          `// 保存時点の追加テスト\nexpect(page([10,20,30,40], ${testInput};\n// </pre><script>globalThis.ADDITION_EXECUTED = true</script>\n`,
        ).toString('base64'),
      },
      { path: 'saved-link', mode: 41471, symlink: true, content: '../checkout/page.ts' },
      { path: 'binary.dat', mode: 33188, symlink: false, content: 'AP8=' },
    ]);
    await writeFile(
      join(verification, 'review-1.diff'),
      `@@ page.ts @@\n+return items.slice(offset, ${sliceEnd});\n`,
    );
  }
  for (const event of state.events) {
    await writeFile(
      event.prefix + '.stdout',
      event.role === 'check' ? '1 pass (synthetic)' : 'simulated reviewer output',
    );
    if (hasLogs) {
      await writeFile(event.prefix + '.stderr', '');
    }
  }
  await writeFile(
    join(verification, 'review-1.prompt'),
    '模擬要求のみ。実際のモデルは呼び出さない。',
  );
  const commandExit = mode === 'unmet' ? 1 : 0;
  if (hasLogs) {
    await writeFile(
      join(actor, 'events.jsonl'),
      [
        { type: 'item.started', item: { type: 'command_execution', command: 'bun test' } },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            exit_code: commandExit,
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

function configureFinding(review: Review, mode: string) {
  const item = review.items[1];
  if (!item) {
    return;
  }
  if (mode === 'normal') {
    item.disposition = 'open';
  }
  if (mode === 'unmet') {
    item.area = 'code';
    item.condition = 'offset=0, limit=2の場合も件数が不足する、という模擬の誤指摘。';
    item.impact = '先頭ページの2要素を取得できない、という主張。';
    item.evidence = 'レビューの主張は[]。同じ対象の独立観測とは異なる。';
    item.action = '先頭ページの取得を修正する、という対応案。';
  } else {
    item.condition =
      '保存したテストはoffset=0のみで、正のoffsetで非空結果を期待する条件がない。' + item.condition;
    item.action = 'offset=2, limit=2で[30,40]を期待するテストを追加する。';
    item.reason = '対象は修正せず保存。修正状況の値だけで真偽を裁定しない。';
  }
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
    trial: fixtureTrial(mode, id, review),
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
function fixtureTrial(mode: string, id: string, review: Review) {
  const trial = reviewTrial('display_sample', mode !== 'empty');
  trial.startedAt = '2026-09-21T01:00:00Z';
  trial.finishedAt = '2026-09-21T01:00:01.234Z';
  if (mode === 'pending') {
    return trial;
  }
  trial.judgment = {
    at: '2026-09-21T02:00:00Z',
    conclusion: 'met',
    reason:
      '同一原因の機能不具合とテスト不足を確認。誤指摘なく既知欠陥を検出したという表示サンプル。',
    evidence: [
      'reproduction',
      `target:${review.targetId}`,
      ...review.items.map((item) => `finding:${item.id}`),
    ],
    unmet: [],
    unconfirmed: [],
  };
  switch (mode) {
    case 'stopped':
      trial.judgment.conclusion = 'execution_failed';
      trial.judgment.reason = '模擬レビューの実行が失敗し、裁定できなかった。';
      trial.judgment.evidence = [`log:${id}/verification/review-1.stdout`];
      trial.judgment.unconfirmed = ['レビュー・再現・関連ログが不足。'];
      break;
    case 'unmet':
      trial.judgment.conclusion = 'unmet';
      trial.judgment.reason =
        '既知欠陥は検出したが、R1-2を誤指摘と裁定した。補足観測も不足している。';
      trial.judgment.unmet = ['R1-2は誤指摘。'];
      trial.judgment.unconfirmed = ['補足観測が未保存。条件未達と別に確認待ちを残す。'];
      break;
    case 'missed':
      trial.judgment.conclusion = 'unmet';
      trial.judgment.reason = '既知欠陥を再現したが、モデルは指摘しなかった。';
      trial.judgment.unmet = ['既知欠陥の見落とし。'];
      break;
    case 'empty':
      trial.judgment.reason =
        '独立確認で指定の要求を満たし、誤指摘なく必要な証拠が揃ったという表示サンプル。';
      break;
  }
  return trial;
}

function fixtureAdjudication(mode: string, review: Review): ReviewReport['adjudication'] {
  if (mode === 'stopped') {
    return null;
  }
  const completed = ['normal', 'unmet', 'empty', 'missed'].includes(mode);
  return {
    status: completed ? 'completed' : 'pending_host_adjudication',
    knownDefect: mode === 'empty' ? null : 'slice uses limit as end index',
    missedKnownDefect: completed ? mode === 'missed' : null,
    findings: review.items.map((item, index) =>
      fixtureFindingJudgment(item.id, index, mode, completed),
    ),
    instruction: '指摘ごとに同じ試行の再現で裁定する。',
  };
}

function fixtureFindingJudgment(id: string, index: number, mode: string, completed: boolean) {
  if (!completed) {
    return { id, verdict: 'unconfirmed', reproduction: null, reason: null };
  }
  if (mode === 'unmet' && index === 1) {
    return {
      id,
      verdict: 'false_positive',
      reproduction: {
        input: { items: [10, 20, 30, 40], offset: 0, limit: 2 },
        expected: [10, 20],
        actual: [10, 20],
      },
      reason:
        'offset=0では期待どおり[10,20]を返すため、先頭ページも不足するという指摘は誤り。模擬の裁定記録。',
    };
  }
  return {
    id,
    verdict: 'demonstrated',
    reproduction: {
      input: { items: [10, 20, 30, 40], offset: 2, limit: 2 },
      expected: [30, 40],
      actual: [],
    },
    reason:
      index === 0
        ? 'offset=2, limit=2の同じ対象の再現で、期待[30,40]に対し[]を確認した模擬記録。'
        : '保存した追加テストはoffset=0のみ。offset=2の欠陥を検出できない条件を照合した模擬記録。',
  };
}
