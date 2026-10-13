import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Issueの接続契約を検査する。配置名や指示全文、モデルの判断品質は固定しない。
function referencePaths(prompt: string, topic: string) {
  const instructions = prompt.split(/要求:|ホストコンテキスト:/)[0] ?? '';
  const paths = instructions
    .split('\n')
    .filter((line) => line.includes(topic))
    .flatMap((line) => [...line.matchAll(/\/[^\r\n`「」<>"、。]+\.md/gu)])
    .map((match) => match[0]);
  assert(paths.length > 0, `${topic}の手順を渡す絶対パスの参照がありません`);
  return paths;
}

async function inspectReferences(prompts: string[], topic: string) {
  const pathsByPrompt = prompts.map((prompt) => referencePaths(prompt, topic));
  const trusted = await realpath(resolve(import.meta.dir, '../../../skills'));
  const resolved = new Map<string, string>();
  const inspected = new Set<string>();
  for (const path of new Set(pathsByPrompt.flat())) {
    const actual = await realpath(path);
    resolved.set(path, actual);
    if (inspected.has(actual)) {
      continue;
    }
    assert(actual.startsWith(`${trusted}${sep}`), '参照は信頼するハーネスのskills内に必要です');
    assert((await stat(actual)).isFile(), '参照先は通常ファイルである必要があります');
    assert((await readFile(actual, 'utf8')).trim(), '空の参照では手順を渡せません');
    inspected.add(actual);
  }
  return pathsByPrompt.map(
    (paths) =>
      new Set(
        paths.map((path) => {
          const actual = resolved.get(path);
          assert(actual);
          return actual;
        }),
      ),
  );
}

export async function premiseReferences(prompt: string, topic = '前提') {
  const [references] = await inspectReferences([prompt], topic);
  assert(references);
  return references;
}

export async function expectSharedPremiseReferences(prompts: string[], topic = '前提') {
  // 保存済み入力を同じ時点で照合する間だけ検査を共有し、次の呼出しへ結果を持ち越さない。
  const references = await inspectReferences(prompts, topic);
  const first = references[0];
  assert(first, '担当入力が必要です');
  assert(
    [...first].some((path) => references.every((paths) => paths.has(path))),
    '実装・修正・独立評価へ同じ前提検証の手順が届く必要があります',
  );
}
