import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { isArray, isRecord } from './input.ts';

function record(value: unknown) {
  assert(isRecord(value), 'Expected an evidence object');
  return value;
}

function text(value: unknown) {
  assert(typeof value === 'string' && value.trim(), 'Expected nonempty evidence text');
  return value;
}

function count(value: unknown) {
  assert(typeof value === 'number' && Number.isInteger(value) && value >= 0, 'Invalid count');
  return value;
}

function records(value: unknown) {
  assert(isArray(value) && value.length > 0, 'Expected evidence records');
  return value.map(record);
}

function texts(value: unknown) {
  assert(isArray(value) && value.length > 0, 'Expected evidence text entries');
  return value.map(text);
}

function table(headers: string[], rows: (string | number)[][]) {
  const row = (cells: (string | number)[]) =>
    `| ${cells.map((cell) => String(cell).replaceAll('|', '&#124;').replaceAll('\n', '<br>')).join(' | ')} |`;
  return [row(headers), row(headers.map(() => '---')), ...rows.map(row)].join('\n');
}

function controlResult(value: unknown) {
  const result = record(value);
  return `${count(result.passed)}件成功、${count(result.failed)}件失敗、終了コード${count(result.exit_code)}`;
}

function captureReport(value: unknown) {
  const capture = record(value);
  const scenarios = records(capture.scenarios);
  return [
    `コマンド: \`${text(capture.command)}\``,
    `TARGET_REPO: ${text(capture.target_parameter)}`,
    `実撮影の検証: ${text(capture.result)}（${scenarios.length}シナリオ）。集計は依存projectを含みます。`,
    table(
      [
        'シナリオ',
        '期待終了コード',
        '終了コード照合',
        'checkout不変',
        'expected / skipped / unexpected / flaky',
      ],
      scenarios.map((scenario) => {
        const stats = record(scenario.playwright_stats);
        return [
          text(scenario.name),
          count(scenario.expected_exit_code),
          text(scenario.exit_code_assertion),
          text(scenario.checkout_unchanged_assertion),
          ['expected', 'skipped', 'unexpected', 'flaky']
            .map((key) => count(stats[key]))
            .join(' / '),
        ];
      }),
    ),
  ].join('\n\n');
}

function mutationReport(value: unknown) {
  const mutation = record(value);
  const replacement = record(mutation.replace);
  const control = record(mutation.control);
  const integration = record(mutation.integration);
  return [
    `対象: \`${text(mutation.file)}\`。範囲: ${text(mutation.scope)}。`,
    `\`${text(replacement.before)}\` を \`${text(replacement.after)}\` に置き換えました。`,
    `制御テスト: ${controlResult(control)}。コマンド: \`${text(control.command)}\`。`,
    table(
      ['検出ケース', '期待するadapter終了コード', '実際のadapter終了コード'],
      records(control.failures).map((failure) => [
        text(failure.scenario),
        count(failure.expected_adapter_exit_code),
        count(failure.actual_adapter_exit_code),
      ]),
    ),
    `実撮影: \`${text(integration.command)}\` は終了コード${count(integration.exit_code)}となり、\`${text(integration.stopped_at)}\` で停止しました。診断: \`${text(integration.diagnostic)}\`。`,
    text(integration.zero_scenario),
  ].join('\n\n');
}

function priorReport(value: unknown, repository: string) {
  const prior = record(value);
  const check = record(prior.common_check);
  const capture = record(prior.capture);
  const writing = record(prior.writing);
  const commit = text(prior.commit);
  return [
    `対象: [\`${commit}\`](${repository}/tree/${commit})。この版の評価を別の版へ流用しません。`,
    table(
      ['確認', '記録'],
      [
        [
          '共通check',
          `\`${text(check.command)}\`: ${count(check.passed)}件成功、${count(check.failed)}件失敗`,
        ],
        [
          '実撮影',
          `Playwright ${text(capture.playwright)} / ${text(capture.browser)}: ${count(capture.scenarios_passed)}シナリオ成功`,
        ],
        ['独立評価', text(record(prior.review).status)],
        ['文書の日本語確認', text(writing.documents)],
        ['PR本文の日本語確認', text(writing.pr_body)],
        ['候補の意味照合', text(writing.candidate_fidelity)],
        ...records(prior.ci).map((ci) => [
          `CI ${text(ci.name)}`,
          `[${text(ci.conclusion)}](${text(ci.url)})`,
        ]),
      ],
    ),
    text(capture.limitation),
  ].join('\n\n');
}

export function renderEvidence(value: unknown, sourceName: string) {
  const evidence = record(value);
  assert(evidence.schema_version === 1, 'Unsupported evidence schema_version');
  const report = record(evidence.report);
  const environment = record(evidence.environment);
  const issue = text(evidence.issue);
  const repository = issue.split('/issues/')[0];
  assert(repository && issue.startsWith('https://github.com/'), 'Expected a GitHub Issue URL');
  const commit = text(evidence.measured_commit);
  assert(/^[0-9a-f]{40}$/.test(commit), 'Expected a measured commit SHA');
  const hashes = Object.entries(record(evidence.source_sha256));
  assert(hashes.length > 0, 'Missing measured source hashes');
  for (const [, hash] of hashes) {
    assert(/^[0-9a-f]{64}$/.test(text(hash)), 'Invalid source SHA-256');
  }
  return (
    [
      `# ${text(report.title)}`,
      `[Issue](${issue}) / [PR](${text(evidence.pull_request)}) / [操作手順](../../scripts/README.md)`,
      `${text(report.maintenance)} [正本JSON](${sourceName})`,
      '再生成: `bun run evidence:generate`。一致確認: `bun run evidence:check`（`bun run check`にも含まれます）。',
      text(report.render_check_scope),
      '## 対象版と実測',
      `対象版: [\`${commit}\`](${repository}/tree/${commit})。修正前: \`${text(evidence.base_commit)}\`。`,
      text(report.version_note),
      text(evidence.provenance),
      text(report.latest_verification),
      `制御テスト: ${controlResult(evidence.control)}。コマンド: \`${text(record(evidence.control).command)}\`。`,
      text(report.control_scope),
      `環境: Bun ${text(environment.bun)} / Playwright ${text(environment.playwright)} / ${text(environment.browser)} / PLAYWRIGHT_BROWSERS_PATH=${text(environment.PLAYWRIGHT_BROWSERS_PATH)}。${text(environment.target_dependency)}`,
      text(report.capture_scope),
      captureReport(evidence.capture),
      '## 不具合注入による検出確認',
      mutationReport(evidence.mutation),
      '## 回帰確認で守る条件',
      texts(report.verification_conditions)
        .map((condition) => `- ${condition}`)
        .join('\n'),
      '## テスト整理の判断',
      table(
        ['整理した対象', '省いた検出条件・負担', '残した検証'],
        records(report.test_cleanup).map((entry) => [
          text(entry.target),
          text(entry.removed),
          text(entry.retained),
        ]),
      ),
      ...texts(report.test_notes),
      '## プロセス実装を維持した理由',
      text(report.process_rationale),
      '## 修正前の検証と過去の実行',
      priorReport(evidence.prior_commit, repository),
      ...texts(report.history),
      '## 未確認範囲',
      texts(evidence.unverified)
        .map((item) => `- ${item}`)
        .join('\n'),
      text(report.authority),
    ].join('\n\n') + '\n'
  );
}

export async function generateEvidence(source: string, check: boolean) {
  assert(source.endsWith('.json'), 'Expected an evidence JSON file');
  const value: unknown = JSON.parse(await readFile(source, 'utf8'));
  const markdown = renderEvidence(value, basename(source));
  const destination = source.slice(0, -5) + '.md';
  if (check) {
    assert(
      (await readFile(destination, 'utf8')) === markdown,
      'Evidence Markdown is stale; run bun run evidence:generate',
    );
  } else {
    await writeFile(destination, markdown);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    assert(
      args.length === 0 || (args.length === 1 && args[0] === '--check'),
      'Usage: evidence.ts [--check]',
    );
    await generateEvidence(
      resolve(import.meta.dir, '../docs/evidence/harness-review-2026-09-14.json'),
      args[0] === '--check',
    );
    console.log(
      args[0] === '--check' ? 'Evidence Markdown matches JSON.' : 'Evidence Markdown generated.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
