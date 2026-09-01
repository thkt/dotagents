/** @file Outcome: Shared text and prompt serialization preserve compact text and inert boundaries. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { inertJsonBlock } from '../../shared/prompt.ts';
import { oneLine, sentenceItems, textMatchesLanguage } from '../../shared/text.ts';

test('normalizes one-line text', () => assert.equal(oneLine('  a\n\t b  '), 'a b'));

test('splits Japanese and English prose into readable sentence items', () => {
  assert.deepEqual(sentenceItems('一文目です。二文目です。'), ['一文目です。', '二文目です。']);
  assert.deepEqual(sentenceItems('First sentence. Second sentence.'), [
    'First sentence.',
    'Second sentence.',
  ]);
  assert.equal(textMatchesLanguage('[機能] 設定を反映する', 'japanese'), true);
  assert.equal(textMatchesLanguage('[Feature] Reflect settings', 'english'), true);
});

test('wraps JSON data in nonce-matched inert markers', () => {
  const block = inertJsonBlock('DATA', { value: 1 });
  const match = block.match(/^----- BEGIN DATA (.+) -----\n(.+)\n----- END DATA \1 -----$/u);
  assert.ok(match);
  assert.deepEqual(JSON.parse(match[2]!), { value: 1 });
});
