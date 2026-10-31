import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

type ExecutionOptions = {
  runtime: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  monitorParent?: boolean;
  captureStdout?: boolean;
  packageManager?: 'bun' | 'npm';
};

function startCommand(argv: string[], options: Required<ExecutionOptions>) {
  const { runtime, cwd, env, monitorParent, captureStdout, packageManager } = options;
  const stdout = captureStdout ? 'pipe' : 'inherit';
  const [command, ...args] = argv;
  assert(command, '実行コマンドがありません');
  if (monitorParent) {
    assert(process.connected, '検査の開始前に親との接続が切れました');
  } else {
    const log = captureStdout ? console.error : console.log;
    const operation = captureStdout ? '収集' : '実行';
    log(`${operation}: ${argv.join(' ')}; 再実行: ${packageManager} run test:affected`);
  }
  const startupEnv = { ...env };
  if (!monitorParent) {
    // 対象コマンドのpreloadは監視プロセスでは実行せず、IPC経由で元の環境を渡します。
    delete startupEnv.BUN_OPTIONS;
    delete startupEnv.NODE_OPTIONS;
  }
  const child = spawn(
    monitorParent ? command : process.execPath,
    monitorParent
      ? args
      : [...(process.versions.bun ? ['--no-env-file'] : []), runtime, 'execute-child'],
    {
      stdio: monitorParent ? ['inherit', 'inherit', 'pipe'] : ['inherit', stdout, 'pipe', 'ipc'],
      cwd,
      env: startupEnv,
      detached: true,
      serialization: 'json',
    },
  );
  return child;
}

export async function execute(argv: string[], options: ExecutionOptions) {
  const {
    runtime,
    cwd = process.cwd(),
    env = process.env,
    monitorParent = false,
    captureStdout = false,
    packageManager = process.versions.bun ? 'bun' : 'npm',
  } = options;
  const child = startCommand(argv, {
    runtime,
    cwd,
    env,
    monitorParent,
    captureStdout,
    packageManager,
  });
  assert(child.stderr);
  // Bunの選択診断は先頭に出ます。テスト本体の大量ログは保持しません。
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (!process.stderr.destroyed) {
      process.stderr.write(chunk);
    }
    stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
  });
  let cancelled = false;
  let cleanupError: unknown;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) {
      return;
    }
    try {
      // 取消をコマンドへ渡し、Bunの別グループのworkerはBun自身が終了するまで待ちます。
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        cleanupError = error;
      }
    }
  };
  const forward = (signal: NodeJS.Signals) => {
    cancelled = true;
    stop(signal);
    if (monitorParent) {
      killTimer ??= setTimeout(() => stop('SIGKILL'), 1000);
      killTimer.unref();
    }
  };
  let stdout = '';
  let stdoutBytes = 0;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 64 * 1024 * 1024) {
      cleanupError ??= new Error('テスト収集の出力が64MiBを超えました');
      forward('SIGTERM');
    } else {
      stdout += chunk;
    }
  });
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  child.once('exit', () => stop('SIGKILL'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  if (monitorParent) {
    process.on('disconnect', terminate);
  } else {
    child.send({ argv, env }, (error) => {
      if (error) {
        cleanupError = error;
        stop('SIGKILL');
      }
    });
  }
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, fail) => {
        child.once('error', fail);
        child.once('close', (code, signal) => done({ code, signal }));
      },
    );
    assert(cleanupError === undefined, `子プロセスの終了を確認できません: ${String(cleanupError)}`);
    assert(!cancelled && result.code === 0, `検査失敗または取消: ${result.signal ?? result.code}`);
    return { stdout, stderr };
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    clearTimeout(killTimer);
    if (monitorParent) {
      process.off('disconnect', terminate);
      if (process.connected) {
        process.disconnect?.();
      }
    }
  }
}
