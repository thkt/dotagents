import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { exitObservationWorker } from './exit-observation.fixture.ts';
import { command } from '../../scripts/shared/process.ts';
import { isRecord } from '../../scripts/shared/values.ts';

type Saved = Record<string, unknown>;

function verifyBudget(calls: Saved[], mode: string) {
  const observations = calls.filter((call) =>
    ['stats', 'gateway', 'canary'].includes(String(call.kind)),
  );
  expect(observations.map((call) => call.kind)).toEqual(
    mode === 'exhausted' ? ['stats', 'gateway'] : ['stats', 'gateway', 'canary'],
  );
  const first = observations[0];
  assert(first && typeof first.at === 'number');
  for (const call of observations) {
    assert(typeof call.at === 'number' && typeof call.timeout === 'number');
    assert(call.timeout > 0, '残り0でDockerを起動しない');
    assert(call.timeout <= Math.min(2500, 5000 - (call.at - first.at)), '共通の残り予算を超えない');
  }
}

function verifyCleanup(calls: Saved[], safety: unknown) {
  const cleanup = calls.filter((call) => call.kind === 'cleanup');
  assert(cleanup.length >= 2);
  const containerArgs: unknown[] = [];
  const networkArgs: unknown[] = [];
  for (const call of cleanup) {
    assert.equal(call.timeout, 30000, '観測予算と削除予算を混同しない');
    assert(Array.isArray(call.args));
    const args: unknown[] = call.args;
    (args[0] === 'network' ? networkArgs : containerArgs).push(...args);
  }
  assert(containerArgs.includes('-f'));
  for (const role of ['gateway', 'probe', 'actor', 'canary', 'canary-control']) {
    assert(containerArgs.some((arg) => typeof arg === 'string' && arg.endsWith(`-${role}`)));
  }
  assert(networkArgs.includes('rm'));
  assert(networkArgs.some((arg) => typeof arg === 'string' && arg.endsWith('-canary-net')));
  expect(safety).toEqual({ containersRemoved: true, networkRemoved: true });
}

function verifyResult(saved: Saved, mode: string) {
  assert(isRecord(saved.savedLogs));
  if (mode === 'normal' || mode === 'consumed') {
    assert.equal(saved.error, null);
    assert(isRecord(saved.result) && saved.result.mode === 'model-free-preflight');
    expect(saved.result.requests).toEqual({ requests: 2, rejected: 5, failed: false });
    for (const key of ['gateway-logs', 'canary-logs']) {
      const log: unknown = saved.savedLogs[key];
      assert(isRecord(log) && log.code === 0);
    }
  } else if (mode === 'exhausted' || mode === 'gateway-failure') {
    assert(typeof saved.error === 'string' && saved.error.length > 0, '観測不能を正常結果にしない');
    if (mode === 'gateway-failure') {
      const log: unknown = saved.savedLogs['gateway-logs'];
      assert(isRecord(log) && log.code === 1, '失敗した原観測を保存する');
    }
  } else {
    // stats失敗を0件へ読み替えず、ログの残り予算を維持する。
    assert(saved.error !== null || (isRecord(saved.result) && saved.result.requests === null));
  }
}

// 期待値は#401の終了観測5秒・削除30秒+30秒と失敗時の証拠保全から定める。
// 接続名・保存形式だけをホスト提示契約へ合わせ、実Dockerの安全性とは区別する。
for (const mode of ['normal', 'consumed', 'exhausted', 'stats-failure', 'gateway-failure']) {
  test(`canaryありの終了観測を共有予算と削除へ接続する: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'exit-observation-'));
    try {
      const output = await command(
        [process.execPath, exitObservationWorker, root, mode],
        root,
        '',
        10000,
      );
      assert.equal(output.code, 0, output.stderr);
      // 公開入口はactor開始をstdoutへ通知するため、workerの結果と分ける。
      const saved: unknown = JSON.parse(await readFile(join(root, 'observation.json'), 'utf8'));
      assert(isRecord(saved));
      // 未到達を予算検査の成功にしない。正常対照にも同じ前提を要求する。
      assert.equal(saved.actorStarted, true, String(saved.error));
      assert.equal(saved.controls, 2, 'actor前後の正常対照を完了する');
      assert(Array.isArray(saved.calls));
      const calls = saved.calls.filter(isRecord);
      verifyBudget(calls, mode);
      verifyCleanup(calls, saved.safety);
      verifyResult(saved, mode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
