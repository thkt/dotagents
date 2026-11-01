import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyInterruptedProcesses } from '../../../implement/interrupted-processes.ts';

// Issueの不稼働条件を、旧パスとの直接対応と旧実行期間内の同じcheckに分ける。
// 停止後に始まった、旧パスを参照しない同名checkは旧runの稼働を示さない。
for (const name of [
  'other_after_stop',
  'same_check_after_stop',
  'same_check_during_old_run',
  'old_path_after_stop',
] as const) {
  test(`初回check復帰のプロセス対応を時刻とcommandで区別する: ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'check-timeout-processes-'));
    try {
      const previousRun = join(dir, 'old');
      // 保存期間は固定した過去の値。実時間の待機や実プロセスを使わない。
      await mkdir(previousRun);
      await writeFile(
        join(previousRun, 'result.json'),
        JSON.stringify({
          startedAt: '2020-01-01T00:00:00.500Z',
          finishedAt: '2020-01-01T00:10:00.500Z',
        }),
      );
      const during = name === 'same_check_during_old_run';
      const date = new Date(during ? '2020-01-01T00:00:02Z' : '2020-01-01T00:10:02Z');
      const [weekday, month, day, year, time] = date.toString().split(' ');
      const check = ['/bin/sh', '-c', 'bun run check'];
      const command =
        name === 'other_after_stop'
          ? '/bin/sh -c bun run other'
          : name === 'old_path_after_stop'
            ? `/bin/sh -c cat ${previousRun}/result.json`
            : check.join(' ');
      const input = {
        previousRun,
        runDirectory: join(dir, 'new'),
        review: ['/usr/bin/bun', '/fixture/review.ts'],
        check,
        entry: '--check-timeout-run' as const,
      };
      const result = verifyInterruptedProcesses(
        `100000001 1 ${weekday} ${month} ${day} ${time} ${year} ${command}`,
        input,
      );
      if (during || name === 'old_path_after_stop') {
        await assert.rejects(result, /プロセス|process/i);
      } else {
        await assert.doesNotReject(result);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
