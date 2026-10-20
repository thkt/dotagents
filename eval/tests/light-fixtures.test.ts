import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { lightBoundaryFixture } from './light-boundary.fixture.ts';
import { lightCliFixture } from './light-cli.fixture.ts';
import { isRecord } from '../../scripts/shared/values.ts';

async function temporary(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'light-fixed-operations-'));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('固定境界操作は実ファイルへ到達し、未存在を権限拒否に偽装しない', async () => {
  await temporary(async (root) => {
    const path = join(root, 'public.txt');
    const body = '公開の合成対照\n';
    await writeFile(path, body);
    for (const kind of ['read', 'shell-read']) {
      const result = spawnSync(process.execPath, [lightBoundaryFixture, kind, path], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      expect(result.status, result.stderr).toBe(0);
      const value: unknown = JSON.parse(result.stdout);
      assert(isRecord(value) && isRecord(value.observation));
      expect(value.observation.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    }
    const write = spawnSync(process.execPath, [lightBoundaryFixture, 'write', path], {
      encoding: 'utf8',
    });
    expect(write.status).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('SYNTHETIC_BOUNDARY_WRITE\n');
    const absent = spawnSync(
      process.execPath,
      [lightBoundaryFixture, 'read', join(root, 'absent')],
      { encoding: 'utf8' },
    );
    expect(absent.status).toBe(1);
    expect(JSON.parse(absent.stdout)).toMatchObject({ status: 'failed', code: 'ENOENT' });
  });
});

test('模擬CLIは課題コマンド失敗とCLI失敗を別の実終了・JSONLとして生成する', async () => {
  await temporary(async (root) => {
    const control = join(root, 'control.json');
    for (const [scenario, expectedExit] of [
      ['normal', 0],
      ['task-failure', 0],
      ['cli-failure', 1],
    ] as const) {
      await writeFile(
        control,
        JSON.stringify({ auth: 'chatgpt', scenario, events: join(root, 'events') }),
      );
      const result = spawnSync(process.execPath, [lightCliFixture, control, 'exec', '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      expect(result.status, result.stderr).toBe(expectedExit);
      const events: unknown[] = result.stdout
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
      expect(events.some((event) => isRecord(event) && event.type === 'turn.completed')).toBe(
        expectedExit === 0,
      );
      if (scenario === 'task-failure') {
        expect(
          events.some(
            (event) => isRecord(event) && isRecord(event.item) && event.item.exit_code === 1,
          ),
        ).toBe(true);
      }
    }
  });
});
