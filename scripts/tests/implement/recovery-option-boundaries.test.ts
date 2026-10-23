import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyInterruptedProcesses } from '../../implement/interrupted-processes.ts';

for (const entry of ['--interrupted-run', '--check-timeout-run'] as const) {
  for (const form of [
    'equals',
    'separated',
    'quoted',
    'other-entry',
    'other-directory',
    'other-both',
    'old-suffix',
    'new-suffix',
  ] as const) {
    test(`復帰プロセスは正規オプションと指定パスの一致で除外する: ${entry} ${form}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'recovery-option-'));
      try {
        const previousRun = join(dir, 'old');
        const runDirectory = join(dir, 'new');
        await mkdir(previousRun);
        await writeFile(
          join(previousRun, 'result.json'),
          JSON.stringify({
            startedAt: '2020-01-01T00:00:00.000Z',
            finishedAt: '2020-01-01T00:10:00.000Z',
          }),
        );
        const oldOption =
          form === 'other-entry' || form === 'other-both' ? `--other${entry}` : entry;
        const newOption =
          form === 'other-directory' || form === 'other-both' ? '--other--run-dir' : '--run-dir';
        const oldPath = form === 'old-suffix' ? `${previousRun}-suffix` : previousRun;
        const newPath = form === 'new-suffix' ? `${runDirectory}-suffix` : runDirectory;
        const args =
          form === 'separated'
            ? `${oldOption} ${oldPath} ${newOption} ${newPath}`
            : form === 'quoted'
              ? `${oldOption}="${oldPath}" ${newOption}='${newPath}'`
              : `${oldOption}=${oldPath} ${newOption}=${newPath}`;
        const date = new Date('2020-01-01T00:10:02Z');
        const [weekday, month, day, year, time] = date.toString().split(' ');
        const result = verifyInterruptedProcesses(
          `100000001 1 ${weekday} ${month} ${day} ${time} ${year} bun /fixture/develop.ts ${args}`,
          { previousRun, runDirectory, review: ['/fixture/reviewer'], entry },
        );
        if (form === 'equals' || form === 'separated' || form === 'quoted') {
          await assert.doesNotReject(result);
        } else {
          await assert.rejects(result, /旧runまたは旧評価に対応する稼働プロセス/);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
