import assert from 'node:assert/strict';
import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isRecord } from '../shared/values.ts';
import { assertReportReferences } from './input.ts';
import type { ReportReference } from './input.ts';

type Git = (...args: string[]) => Promise<string>;
function reportReferences(inputs: string[]): ReportReference[] {
  const reports = inputs.map((input) => {
    const [path, blob, extra] = input.split('=');
    assert(extra === undefined, `Expected reviewed Git blob ID: ${path}`);
    return { path, blob };
  });
  assertReportReferences(reports);
  return reports;
}

export async function verifyReportBase(base: string, reports: ReportReference[], git: Git) {
  for (const { path, blob } of reports) {
    const tree = await git('ls-tree', base, '--', path);
    assert(tree, `Required report is missing from start commit (not committed): ${path}`);
    assert(/^100(?:644|755) blob /.test(tree), `Required report must be a regular file: ${path}`);
    assert(tree.split(/\s/)[2] === blob, `Required report differs from reviewed version: ${path}`);
  }
}

export async function verifyReports(
  repo: string,
  base: string,
  reports: ReportReference[],
  git: Git,
) {
  await verifyReportBase(base, reports, git);
  for (const { path, blob } of reports) {
    const local = resolve(repo, path);
    const stat = await lstat(local).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    assert(
      stat?.isFile() && (await realpath(local)) === local,
      `Required report is missing or not a regular checkout file: ${path}`,
    );
    assert(
      (await git('hash-object', '--no-filters', '--', path)) === blob,
      `Required report has uncommitted content: ${path}`,
    );
  }
}

export function researchContext(startCommit: string, reports: ReportReference[] = []) {
  return [
    `実装の参照資料: ${JSON.stringify({ startCommit, reports })}`,
    '要求と合意記録を正本としてください。報告は根拠を提供するもので、追加の許可ではありません。選んだ報告とIssueからリンクされた関連資料を読み、リポジトリの全文書を読む必要はありません。報告のblobはstartCommit時点の引き継ぎ版を特定します。現在のファイルと比較し、根拠の変化を説明してから利用してください。',
    '既存のIssue・報告参照を使い、判断に関係する各規則や所見を、その出典・版・適用条件・合意状態まで辿ってください。観測した事実、合意した規則、仮説を区別してください。仮説の採用は効果の確認ではありません。別の範囲の根拠を適用したり、未合意の提案を要求へ昇格させたりしないでください。',
    '参照の欠落・古さ・矛盾が判断に影響する場合は、出典、影響する判断、再調査や再合意が必要な事項を特定してください。事実不足は調査で解消し、要求・範囲・権限の変更は人へ戻してください。確認済みの参照を黙って新しいIDへ置き換えないでください。機械的な参照検査は、意味の正しさ、人の合意、公開を証明しません。',
    '既存のfindings・assessmentsとhandoffを使い、適用した根拠、前提の変化、未解決の限界を、次の評価担当とPR説明に向けて説明してください。報告全文のコピーや別の要求記録を作らず、出典へリンクしてください。',
  ].join('\n');
}

export function researchHandoff(base: string, startCommit: string | undefined, inputs: string[]) {
  assert(inputs.length === 0 || startCommit, 'Required reports need --start-commit');
  if (startCommit !== undefined) {
    assert(
      startCommit === base,
      'Start commit differs from handoff; reconcile the reviewed references',
    );
  }
  const reports = reportReferences(inputs);
  return reports;
}
