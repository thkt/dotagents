import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { premiseReferences as inspectReferences } from '../support/premise-reference.ts';
import type { expectSharedPremiseReferences as inspectSharedReferences } from '../support/premise-reference.ts';

function isReferenceModule(value: unknown): value is {
  premiseReferences: typeof inspectReferences;
  expectSharedPremiseReferences: typeof inspectSharedReferences;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'premiseReferences' in value &&
    typeof value.premiseReferences === 'function' &&
    'expectSharedPremiseReferences' in value &&
    typeof value.expectSharedPremiseReferences === 'function'
  );
}

// 接続検査そのものを実在する配置で確かめ、実装担当の指示や出力を期待値にしない。
for (const prefix of [
  'premise-harness-',
  'premise harness-',
  'premise harness.md-',
  'premise harness (copy)-',
  'premise harness[copy]-',
]) {
  test(`参照検査は信頼する配置の絶対パス全体を保持する: ${prefix}`, async () => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    try {
      const support = join(root, 'scripts/tests/support');
      const skills = join(root, 'skills/references');
      await mkdir(support, { recursive: true });
      await mkdir(skills, { recursive: true });
      const helper = join(support, 'premise-reference.ts');
      await copyFile(resolve(import.meta.dir, '../support/premise-reference.ts'), helper);
      const reference = join(skills, 'premise-validation.md');
      await writeFile(reference, '# 前提を確かめる手順\n');
      const outside = join(root, 'outside.md');
      await writeFile(outside, '# ハーネス外の資料\n');
      const referenceModule: unknown = await import(pathToFileURL(helper).href);
      assert(isReferenceModule(referenceModule));
      const { premiseReferences, expectSharedPremiseReferences } = referenceModule;
      for (const link of [reference, `\`${reference}\``, `[手順](<${reference}>)`]) {
        expect([...(await premiseReferences(`前提の手順: ${link}。確認してください。`))]).toEqual([
          await realpath(reference),
        ]);
      }
      await assert.rejects(
        premiseReferences(`前提の手順: ${outside}。`),
        /参照は信頼するハーネスのskills内に必要です/u,
      );
      await assert.rejects(
        premiseReferences(`要求:\n前提の手順: ${reference}。`),
        /前提の手順を渡す絶対パスの参照がありません/u,
      );
      const prompts = Array.from({ length: 3 }, () => `前提の手順: ${reference}。`);
      await expectSharedPremiseReferences(prompts);
      await assert.rejects(
        expectSharedPremiseReferences([...prompts, `前提の手順: ${outside}。`]),
        /参照は信頼するハーネスのskills内に必要です/u,
      );
      const other = join(skills, 'other.md');
      await writeFile(other, '# 別の前提手順\n');
      await assert.rejects(
        expectSharedPremiseReferences([`前提の手順: ${reference}。`, `前提の手順: ${other}。`]),
        /同じ前提検証の手順が届く必要があります/u,
      );
      // 別の観測時点では保存済みの検査結果を流用しない。
      await writeFile(reference, '');
      await assert.rejects(expectSharedPremiseReferences(prompts), /空の参照/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
