import { afterEach, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectCallerFirstInstructions } from '../support/caller-first.ts';
import { repairInstructions } from '../../implement/repair.ts';
import { reviewInstructions } from '../../implement/review.ts';
import { develop } from '../../implement/orchestrator.ts';
import { correctionFixture } from '../support/correction.ts';
import { testDevelopment } from '../support/development.ts';
import { expectSharedPremiseReferences } from '../support/premise-reference.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

test('既存の設計手順は対象repoによらず信頼するハーネスへ到達する正常対照', async () => {
  await expectSharedPremiseReferences([repairInstructions(null), reviewInstructions], '設計・選定');
});

testDevelopment('初回実装の実際の担当入力から前提検証の参照へ到達する', async (f) => {
  f.args.push('--no-publish');
  const implement = f.implement;
  let prompt = '';
  const prepare = f.test;
  let testPrompt = '';
  f.test = async (...args) => {
    testPrompt = args[2];
    return prepare(...args);
  };
  f.implement = async (...args) => {
    prompt = args[2];
    return implement(...args);
  };
  const result = await develop(f.args, f.io);
  expect(result.status).toBe('verified_local');
  expect(prompt).toBe(await readFile(join(f.dir, 'implementation.prompt'), 'utf8'));
  await expectSharedPremiseReferences([prompt, reviewInstructions]);
  await expectSharedPremiseReferences([prompt, reviewInstructions], '設計理由');
  await expectSharedPremiseReferences([prompt, reviewInstructions], '利用例');
  expectCallerFirstInstructions(prompt, 'repair');
  await expectSharedPremiseReferences([prompt, testPrompt, reviewInstructions], '機械化');
  await expectSharedPremiseReferences([prompt, testPrompt, reviewInstructions], '性能');
});

test('check後の追加修正と独立評価の実際の入力が共通の前提検証へ到達する', async () => {
  const t = await trial('normal');
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  expect(state.result).toBe('ready_for_human_review');
  expect(state.repair).toBe(1);
  const repair = await readFile(join(t.config.runDir, 'repair-1.prompt'), 'utf8');
  const review = await readFile(join(t.config.runDir, 'review-1.prompt'), 'utf8');
  await expectSharedPremiseReferences([repair, review]);
  await expectSharedPremiseReferences([repair, review], '設計理由');
  await expectSharedPremiseReferences([repair, review], '利用例');
  await expectSharedPremiseReferences([repair, review], '機械化');
  await expectSharedPremiseReferences([repair, review], '性能');
  expect(repair).toBe(await readFile(join(t.root, 'received-repair.prompt'), 'utf8'));
  expect(review).toBe(await readFile(join(t.root, 'received-review.prompt'), 'utf8'));
  expectCallerFirstInstructions(repair, 'repair');
  expectCallerFirstInstructions(review, 'review');
});

// 正常対照は実装の出力でなく、合意済みIssueの追加文面から作る。
const repairContract = `信頼するハーネスの利用例から設計する手順: /trusted/caller-first-design.md。
型・API・責任の境界を選ぶ場合は、構造の採用を表明・実装する前に、実際の呼出元の入力・操作・期待結果と、判断を変える失敗・取消・所有・終了の条件を短い利用例として示してください。既存例を使う場合も、今回のAPIと責任への対応を示してください。例は既存の進捗説明などへ残し、詳細の共通手順に従って形を導いてください。実装後は例と実際の流れ・結果を照合し、選択理由と未確認をfindingsへ残してください。後から作った例を事前実施の証拠にせず、小さな内部変更や文書修正には新しい例や工程を一律に要求しないでください。要求・公開契約・許容範囲・権限の変更は人へ、検証資産の変更は独立テスト経路へ戻してください。`.replace(
  '。\n',
  '。',
);
const reviewContract = `信頼するハーネスの利用例から設計する手順: /trusted/caller-first-design.md。適用時は、例と設計の対応と、構造を選ぶ前に例を具体化した証拠を分けて確認してください。既存のfindingsと対象版に対応する参照可能な記録を使い、本文取得・既存テスト成功・最終findingsだけで例先行を確認したとしないでください。記録がなく順序を確認できない場合は未確認として残し、非公開の思考を推測しないでください。例や実装の不一致は条件・影響とともに既存の指摘へ戻してください。適用外への工程追加や、実装担当の例を独立テストの期待値へ転用することはしないでください。`;

test('合意済みの入力契約は既存例の再利用と適用外の非追加を保つ', () => {
  expectCallerFirstInstructions(repairContract, 'repair');
  expectCallerFirstInstructions(reviewContract, 'review');
});

test('参照だけが届き構造変更前の具体化がない入力を区別する', () => {
  expect(() =>
    expectCallerFirstInstructions(
      '信頼するハーネスの利用例から設計する手順: /trusted/caller-first-design.md。呼出元から形を導き、実装後に照合してください。',
      'repair',
    ),
  ).toThrow('構造選択前の具体化');
});

test('後付けの例だけで順序を確認済みとする説明を区別する', () => {
  const invalid = reviewContract.replace(
    '本文取得・既存テスト成功・最終findingsだけで例先行を確認したとしないでください',
    '最終findingsに例があれば例先行を確認済みとしてください',
  );
  expect(() => expectCallerFirstInstructions(invalid, 'review')).toThrow('本文取得や成功だけ');
});

test('適用外にも新規例を必須化する説明を区別する', () => {
  const invalid = repairContract.replace(
    '小さな内部変更や文書修正には新しい例や工程を一律に要求しないでください',
    '小さな内部変更や文書修正にも新しい例を必須としてください',
  );
  expect(() => expectCallerFirstInstructions(invalid, 'repair')).toThrow('適用外へ工程');
});

test('要求本文の契約文で担当指示の欠落を補えない', () => {
  expect(() => expectCallerFirstInstructions(`要求: ${repairContract}`, 'repair')).toThrow(
    '共通指示',
  );
});
