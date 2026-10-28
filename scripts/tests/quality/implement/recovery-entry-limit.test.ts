import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { develop } from '../../../implement/orchestrator.ts';

const downstream = 'fixture: downstream command reached';

// 引数の検査より後の処理は、最初のgitコマンドで止めて起動の有無だけを数える。
function entryProbe() {
  const probe = { commands: 0 };
  const io = {
    command: async () => {
      probe.commands++;
      throw Error(downstream);
    },
    verify: async () => {
      throw Error('fixture: unexpected verification');
    },
    publish: async () => {
      throw Error('fixture: unexpected publication');
    },
  };
  return Object.assign(probe, { io });
}

function args(entries: string[]) {
  const root = tmpdir();
  return [
    '99',
    '--repo',
    root,
    '--run-dir',
    join(root, 'recovery-entry-limit-run'),
    ...entries.flatMap((entry) => [`--${entry}`, join(root, entry)]),
  ];
}

test('T-009 復帰入口を 2 つ同時に指定すると後続のコマンドを起動する前に拒否する', async () => {
  const probe = entryProbe();
  await assert.rejects(
    () => develop(args(['review-run', 'check-timeout-run']), probe.io),
    /復帰入口は併用できません/,
  );
  expect(probe.commands).toBe(0);
});

test('T-010 復帰入口を 1 つだけ指定したときは併用の拒否が起きない', async () => {
  const probe = entryProbe();
  await assert.rejects(
    () => develop(args(['review-run']), probe.io),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.doesNotMatch(error.message, /復帰入口は併用できません/);
      assert.match(error.message, new RegExp(downstream));
      return true;
    },
  );
  expect(probe.commands).toBe(1);
});
