import { writeFile } from 'node:fs/promises';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export class OutputStorageError extends Error {
  constructor(
    readonly failures: { path: string; cause: unknown }[],
    readonly result: CommandResult,
  ) {
    super(
      `${failures.map(({ path, cause }) => `Cannot save command output at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`).join('; ')}; acquired command result: ${JSON.stringify(result)}`,
      { cause: new AggregateError(failures.map(({ cause }) => cause)) },
    );
  }
}

class ProcessCleanupError extends Error {
  constructor(
    readonly group: number,
    readonly context: { executable: string; cwd: string },
    readonly result: CommandResult,
    readonly outputComplete: boolean,
    cause: unknown,
  ) {
    super(
      `プロセスグループの終了を確認できません (${group}, ${context.executable}, ${context.cwd}): ${String(cause)}; 出力取得の完了: ${outputComplete}; 取得済みの実行結果: ${JSON.stringify(result)}`,
      { cause },
    );
  }
}

// One owner for sequential commands; concurrent commands and nested scopes are unsupported.
export const interruptionMessage =
  'Interrupted execution: reconcile existing process and evidence before continuing';
let interrupted = false;
let activeGroup: number | undefined;
// 終了未確認のgroupを残した場合は、新しい割り込みscopeでも処理を再開しない。
let cleanupFailure: { group: number; cause: unknown } | undefined;

function killGroup(pid: number | undefined) {
  if (pid === undefined || pid !== activeGroup || cleanupFailure) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      cleanupFailure = { group: pid, cause: error };
      interrupted = true;
      return;
    }
  }
  activeGroup = undefined;
}

function interrupt() {
  interrupted = true;
  killGroup(activeGroup);
}

export function assertRunning() {
  if (interrupted || cleanupFailure) {
    throw Error(interruptionMessage);
  }
}

// A process group includes tools launched by the actor, not just its CLI parent.
export async function command(
  argv: string[],
  cwd: string,
  input: string,
  timeoutMs: number | null,
  files?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  assertRunning();
  let stdout = '',
    stderr = '',
    timedOut = false;
  const start = performance.now();
  const [executable, ...args] = argv;
  if (!executable) {
    throw Error('Command executable is required');
  }
  let exitCode: number | null | undefined;
  let openPipes = 2;
  let completedPipes = 0;
  let resolveCode: (code: number | null) => void = () => {};
  const finished = new Promise<number | null>((resolve) => {
    resolveCode = resolve;
  });
  const settle = () => {
    if (exitCode !== undefined && openPipes === 0) {
      resolveCode(exitCode);
    }
  };
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    child = Bun.spawn([executable, ...args], {
      cwd,
      detached: true,
      env: env ?? process.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      onExit(process, code, signal, error) {
        exitCode = signal === null ? code : null;
        if (error) {
          stderr += `${error.message}\n`;
        }
        killGroup(process.pid);
        settle();
      },
    });
  } catch (error) {
    const result = {
      code: null,
      stdout,
      stderr: `${String(error)}\n`,
      timedOut,
      ms: performance.now() - start,
    };
    if (files) {
      await saveOutput(files, result);
    }
    assertRunning();
    return result;
  }
  activeGroup = child.pid;
  // onExitはspawnが返る前に呼ばれる場合もある。
  if (exitCode !== undefined) {
    killGroup(child.pid);
  }
  try {
    Promise.resolve(child.stdin.write(input)).catch(() => {});
    Promise.resolve(child.stdin.end()).catch(() => {});
  } catch {
    // 入力を読み終えず終了するコマンドもある。
  }
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  for (const [index, reader] of readers.entries()) {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const append = (text: string) => {
      if (index === 0) {
        stdout += text;
      } else {
        stderr += text;
      }
    };
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          append(decoder.decode(value, { stream: true }));
        }
        append(decoder.decode());
        completedPipes++;
      } catch (error) {
        stderr += `${String(error)}\n`;
        interrupt();
      } finally {
        openPipes--;
        reader.releaseLock();
        settle();
      }
    })().catch((error) => {
      stderr += `${String(error)}\n`;
      interrupt();
      resolveCode(exitCode ?? null);
    });
  }
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, timeoutMs);
  const poll = setInterval(() => {
    if (cleanupFailure) {
      resolveCode(exitCode ?? null);
    }
  }, 50);
  const code = await finished;
  clearTimeout(timer);
  clearInterval(poll);
  killGroup(child.pid);
  const outputComplete = completedPipes === 2;
  if (cleanupFailure) {
    child.stdin.unref();
    for (const reader of readers) {
      void reader.cancel().catch(() => {});
    }
    child.unref();
  }
  const result = { code, stdout, stderr, timedOut, ms: performance.now() - start };
  if (files) {
    await saveOutput(files, result);
  }
  if (cleanupFailure) {
    throw new ProcessCleanupError(
      cleanupFailure.group,
      { executable, cwd },
      result,
      outputComplete,
      cleanupFailure.cause,
    );
  }
  assertRunning(); // Save output before reporting interruption to the caller.
  return { ...result, ms: performance.now() - start };
}

async function saveOutput(prefix: string, result: CommandResult) {
  const failures: { path: string; cause: unknown }[] = [];
  for (const stream of ['stdout', 'stderr'] as const) {
    const path = `${prefix}.${stream}`;
    try {
      await writeFile(path, result[stream]);
    } catch (cause) {
      failures.push({ path, cause });
    }
  }
  if (failures.length) {
    throw new OutputStorageError(failures, result);
  }
}

export async function withInterrupts<T>(action: () => Promise<T>): Promise<T> {
  interrupted = false;
  assertRunning();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const result = await action();
    assertRunning();
    return result;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
