import { afterEach, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  f.implement = async (...args) => {
    prompt = args[2];
    return implement(...args);
  };
  const result = await develop(f.args, f.io);
  expect(result.status).toBe('verified_local');
  expect(prompt).toBe(await readFile(join(f.dir, 'implementation.prompt'), 'utf8'));
  await expectSharedPremiseReferences([prompt, reviewInstructions]);
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
});
