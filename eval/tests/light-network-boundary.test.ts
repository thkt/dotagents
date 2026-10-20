import { expect, test } from 'bun:test';
import { networkBoundaryObservation } from '../light-preflight.ts';

// Issue #405の「実効境界を確認できなければ未対応」が判定根拠。
// ホスト提示の呼出契約だけを使う。実通信・listener・実認証は起動しない。
// ECONNREFUSEDだけでは拒否にしない。公式診断が同じ操作の拒否を示す場合を別に確認する。
function operation(code: number, value: Record<string, unknown>) {
  return {
    code,
    stdout: `${JSON.stringify({ kind: 'network', ...value })}\n`,
    stderr: '',
    reason: null as string | null,
    processesStopped: true,
    processes: {
      stopped: true,
      records: [{ pid: 123, parent: 1, group: 123, birth: 'synthetic', stopped: true }],
      observationFailed: false,
    },
    ms: 1,
    cleanupMs: 1,
  };
}

const connected = () => operation(0, { status: 'completed', observation: { connected: true } });
const failed = (code: string) => operation(1, { status: 'failed', code, message: code });

for (const code of ['EPERM', 'EACCES']) {
  test(`前後の同一操作が接続でき、内側だけ${code}なら明示的な拒否として扱う`, () => {
    expect(networkBoundaryObservation(failed(code), connected(), connected())).toBe('denied');
  });
}

for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']) {
  test(`前後が接続できても内側の${code}だけでは権限拒否を認定しない`, () => {
    expect(networkBoundaryObservation(failed(code), connected(), connected())).toBe('unconfirmed');
  });
}

test('内側から接続できる場合を拒否済みにしない', () => {
  expect(networkBoundaryObservation(connected(), connected(), connected())).toBe('unconfirmed');
});

test('明示的な拒否でも前または後の接続対照が不成立なら未確認とする', () => {
  for (const [before, after] of [
    [failed('ECONNREFUSED'), connected()],
    [connected(), failed('ECONNREFUSED')],
  ] as const) {
    expect(networkBoundaryObservation(failed('EPERM'), before, after)).toBe('unconfirmed');
  }
});

test('拒否の出力があっても時間切れ・終了不明・観測不能を拒否済みにしない', () => {
  for (const position of [0, 1, 2]) {
    for (const condition of ['timeout', 'not-stopped', 'observation-failed']) {
      const results = [failed('EPERM'), connected(), connected()] as const;
      const result = results[position];
      if (!result) {
        throw new Error('合成操作の位置が不正');
      }
      if (condition === 'timeout') {
        result.reason = 'timeout';
      }
      if (condition === 'not-stopped') {
        result.processesStopped = false;
        result.processes.stopped = false;
      }
      if (condition === 'observation-failed') {
        result.processes.observationFailed = true;
      }
      expect(networkBoundaryObservation(...results), `${position}: ${condition}`).toBe(
        'unconfirmed',
      );
    }
  }
});

// 第4引数はhost_returnで提示された接続契約。期待値はIssue #405の
// 「実効境界」「正常・拒否の対照」「終了不明を成功にしない」から定める。
// CLI 0.163.0の診断形式を合成し、ホスト実測のポートやPIDには依存しない。
const denialTarget = { program: 'bun', port: 54321 };
const denialLine = '(bun) network-outbound remote:*:54321';
function loggedFailure(lines: string[] = [denialLine]) {
  return {
    ...failed('ECONNREFUSED'),
    stderr: `\n=== Sandbox denials ===\n${lines.join('\n')}\n`,
  };
}

test('前後が接続でき、同じ実行ファイル・canaryポートの公式拒否診断があれば拒否を確認できる', () => {
  const inside = loggedFailure([
    '(bun) sysctl-read kern.bootargs',
    '(bun) file-read-data /private',
    denialLine,
  ]);
  expect(networkBoundaryObservation(inside, connected(), connected(), denialTarget)).toBe('denied');
  // 対象情報なしでは、偶然一致した別操作のログを使わない。
  expect(networkBoundaryObservation(inside, connected(), connected())).toBe('unconfirmed');
});

for (const [name, lines] of [
  ['別の実行ファイル', ['(node) network-outbound remote:*:54321']],
  ['実行ファイルの部分一致', ['(other-bun) network-outbound remote:*:54321']],
  ['別ポート', ['(bun) network-outbound remote:*:54322']],
  ['ポートの部分一致', ['(bun) network-outbound remote:*:543210']],
  ['内向きの通信', ['(bun) network-inbound local:*:54321']],
  ['ファイル拒否だけ', ['(bun) file-read-data /private']],
  ['診断なし', []],
] as const) {
  test(`公式診断でも${name}は対象の通信拒否を証明しない`, () => {
    expect(
      networkBoundaryObservation(loggedFailure([...lines]), connected(), connected(), denialTarget),
    ).toBe('unconfirmed');
  });
}

test('actorのstdoutや通常のstderrにある診断風文字列を公式拒否診断にしない', () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const inside = failed('ECONNREFUSED');
    if (stream === 'stdout') {
      inside.stdout += loggedFailure().stderr;
    } else {
      inside.stderr = `${denialLine}\n`;
    }
    expect(networkBoundaryObservation(inside, connected(), connected(), denialTarget)).toBe(
      'unconfirmed',
    );
  }
});

test('対象の公式拒否診断があっても内側の接続成功や前後対照の失敗は未確認とする', () => {
  expect(
    networkBoundaryObservation(
      { ...connected(), stderr: loggedFailure().stderr },
      connected(),
      connected(),
      denialTarget,
    ),
  ).toBe('unconfirmed');
  for (const position of [1, 2]) {
    const results = [loggedFailure(), connected(), connected()] as const;
    const control = results[position];
    if (!control) {
      throw new Error('合成対照の位置が不正');
    }
    Object.assign(control, failed('ECONNREFUSED'));
    expect(networkBoundaryObservation(...results, denialTarget)).toBe('unconfirmed');
  }
});

test('対象の公式拒否診断があっても期限超過・終了不明・観測失敗は未確認とする', () => {
  for (const position of [0, 1, 2]) {
    for (const condition of ['timeout', 'not-stopped', 'observation-failed']) {
      const results = [loggedFailure(), connected(), connected()] as const;
      const result = results[position];
      if (!result) {
        throw new Error('合成操作の位置が不正');
      }
      if (condition === 'timeout') {
        result.reason = 'timeout';
      }
      if (condition === 'not-stopped') {
        result.processesStopped = false;
        result.processes.stopped = false;
      }
      if (condition === 'observation-failed') {
        result.processes.observationFailed = true;
      }
      expect(
        networkBoundaryObservation(...results, denialTarget),
        `${position}: ${condition}`,
      ).toBe('unconfirmed');
    }
  }
});
