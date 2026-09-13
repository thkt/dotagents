import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { waitForCi } from '../ci.ts';
import { withInterrupts } from '../correction.ts';

const target = {
  cwd: '/tmp',
  repository: 'team/component',
  url: 'https://github.com/team/component/pull/1',
  commit: 'verified',
  baseBranch: 'main',
  dir: '/tmp',
};
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, ms: 1 });
function registration(mode: string, views: number) {
  return {
    headRefOid: mode === 'head_changes' && views > 1 ? 'different' : 'verified',
    baseRefName: 'main',
    state: 'OPEN',
    statusCheckRollup: views > 1 && mode !== 'never_registers' ? [{ name: 'check' }] : [],
  };
}
for (const mode of [
  'registers',
  'never_registers',
  'head_changes',
  'failed_checks',
  'interrupted',
] as const) {
  test(`CI registration: ${mode}`, async () => {
    let views = 0,
      watched = false;
    try {
      const action = () =>
        waitForCi(
          target,
          async (argv, _cwd, _input, timeout) => {
            if (argv[2] === 'checks') {
              watched = true;
              expect(timeout).toBeLessThan(3000);
              return { ...ok(), code: mode === 'failed_checks' ? 1 : 0 };
            }
            views++;
            if (mode === 'interrupted') {
              process.emit('SIGINT');
            }
            return ok(JSON.stringify(registration(mode, views)));
          },
          mode === 'never_registers' ? 20 : 3000,
        );
      if (mode === 'head_changes' || mode === 'interrupted') {
        await assert.rejects(
          () => withInterrupts(action),
          mode === 'interrupted' ? /Interrupted execution/ : /PR target changed/,
        );
        expect(watched).toBe(false);
      } else {
        const result = await withInterrupts(action);
        expect(watched).toBe(mode !== 'never_registers');
        expect(result?.code).toBe(
          mode === 'never_registers' ? undefined : mode === 'failed_checks' ? 1 : 0,
        );
      }
    } finally {
      await withInterrupts(async () => {});
    }
  });
}
