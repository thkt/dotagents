import assert from 'node:assert/strict';
import { resolve } from 'node:path';

function elements(node: Bun.XML.Node, name: string): Bun.XML.Node[] {
  return node.children.filter(
    (child): child is Bun.XML.Node =>
      typeof child !== 'string' && 'name' in child && child.name === name,
  );
}

function count(node: Bun.XML.Node, name: string, fallback?: string): number {
  const value = node.attributes[name] ?? fallback;
  assert(value !== undefined && /^\d+$/.test(value), `JUnitの${name}が不正です`);
  const result = Number(value);
  assert(Number.isSafeInteger(result), `JUnitの${name}が不正です`);
  return result;
}

function counts(node: Bun.XML.Node, allowSkipped: boolean) {
  const tests = count(node, 'tests');
  const skipped = count(node, 'skipped');
  assert(tests > 0 && skipped <= tests, 'JUnitの完了件数が不正または0件です');
  assert(allowSkipped || skipped === 0, '許可されていないskipがあります');
  assert(
    count(node, 'failures') === 0 && count(node, 'errors', '0') === 0,
    'JUnitに失敗が記録されています',
  );
  return { tests, skipped };
}

// Bunの分岐でだけ呼びます。Node/Vitestの実行にはBunやXML依存を要求しません。
export function readBunReport(
  text: string,
  root: string,
  candidates: Set<string>,
  allowSkipped: boolean,
): Map<string, number> {
  const report = Bun.XML.parse(text, { compact: false });
  assert(report.name === 'testsuites', 'Bun JUnitのrootがありません');
  const total = counts(report, allowSkipped);
  const completed = new Map<string, number>();
  let tests = 0;
  let skipped = 0;
  for (const suite of elements(report, 'testsuite')) {
    const file = suite.attributes.file;
    assert(file && file.trim(), 'JUnitのテストファイルがありません');
    const owner = resolve(root, file);
    assert(candidates.has(owner), `JUnitに候補外のファイルがあります: ${file}`);
    assert(!completed.has(owner), `JUnitのファイルが重複しています: ${file}`);
    const summary = counts(suite, allowSkipped);
    const cases = elements(suite, 'testcase');
    assert(cases.length === summary.tests, `JUnitのファイル別件数が一致しません: ${file}`);
    let skippedCases = 0;
    for (const item of cases) {
      assert(
        item.attributes.file && resolve(root, item.attributes.file) === owner,
        `JUnitのtestcaseのファイルが一致しません: ${file}`,
      );
      assert(
        elements(item, 'failure').length === 0 && elements(item, 'error').length === 0,
        `JUnitのtestcaseが失敗しています: ${file}`,
      );
      if (elements(item, 'skipped').length > 0) {
        skippedCases++;
      }
    }
    assert(skippedCases === summary.skipped, `JUnitのskip件数が一致しません: ${file}`);
    tests += summary.tests;
    skipped += summary.skipped;
    completed.set(owner, summary.tests - summary.skipped);
  }
  assert(
    tests === total.tests && skipped === total.skipped,
    'JUnitのファイル別件数と全体件数が一致しません',
  );
  return completed;
}
