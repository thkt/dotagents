import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';

export const lightBoundaryFixture = import.meta.path;

// モデルなしホスト確認で、各操作を採用profileの内側から個別に起動する。
// 判定根拠はホスト側のmanifestに置く。出力は観測であり、安全性の自己認定ではない。
// read-toolは実CLIの公開読取りツールで別途行う。このコマンドfixtureで代用しない。
async function operation(kind: string, path: string) {
  if (kind === 'read') {
    const bytes = await readFile(path);
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  if (kind === 'write') {
    await writeFile(path, 'SYNTHETIC_BOUNDARY_WRITE\n');
    return { written: true };
  }
  if (kind === 'shell-read') {
    const result = spawnSync('/bin/cat', [path], { encoding: 'utf8' });
    // raw本文は保存しない。catの実エラーと終了を、親プロセスの成功に変換しない。
    return {
      code: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr,
      sha256: result.status === 0 ? createHash('sha256').update(result.stdout).digest('hex') : null,
    };
  }
  if (kind === 'network') {
    // ホストが別途用意し前後に到達確認する合成canaryへ接続する。
    // listener・外部推論・サーバーは起動しない。ECONNREFUSEDやtimeoutは拒否の証拠ではない。
    const endpoint = new URL(path);
    assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port);
    return await new Promise((accept, reject) => {
      const socket = connect({ host: '127.0.0.1', port: Number(endpoint.port) });
      socket.once('connect', () => {
        socket.destroy();
        accept({ connected: true });
      });
      socket.once('error', reject);
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error('network probe unconfirmed'));
      });
    });
  }
  throw new Error('未知の固定操作');
}

if (import.meta.main) {
  const [kind, path] = process.argv.slice(2);
  assert(kind && path);
  try {
    console.log(
      JSON.stringify({ kind, status: 'completed', observation: await operation(kind, path) }),
    );
  } catch (cause) {
    const code = cause instanceof Error && 'code' in cause ? cause.code : null;
    const message = cause instanceof Error ? cause.message : String(cause);
    console.log(JSON.stringify({ kind, status: 'failed', code, message }));
    process.exitCode = 1;
  }
}
