/** @file Outcome: Shared text and prompt serialization preserve compact text and inert boundaries. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { inertJsonBlock } from '../../shared/prompt.ts';
import { oneLine } from '../../shared/text.ts';

test('normalizes one-line text', () => assert.equal(oneLine('  a\n\t b  '), 'a b'));

test('wraps JSON data in nonce-matched inert markers', () => {
  const block = inertJsonBlock('DATA', { value: 1 });
  const match = block.match(/^----- BEGIN DATA (.+) -----\n(.+)\n----- END DATA \1 -----$/u);
  assert.ok(match);
  assert.deepEqual(JSON.parse(match[2]!), { value: 1 });
});
