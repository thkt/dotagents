import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

// One owner for sequential commands; concurrent commands and nested scopes are unsupported.
export const interruptionMessage =
  'Interrupted execution: reconcile existing process and evidence before continuing';
let interrupted = false;
let activeGroup: number | undefined;

function killGroup(pid: number | undefined) {
  if (pid === undefined || pid !== activeGroup) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
  activeGroup = undefined;
}

function interrupt() {
  interrupted = true;
  killGroup(activeGroup);
}

export function assertRunning() {
  if (interrupted) {
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
  const child = spawn(executable, args, {
    cwd,
    detached: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeGroup = child.pid;
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  child.stdout.setEncoding('utf8').on('data', (data) => {
    stdout += data;
  });
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, timeoutMs);
  const code = await new Promise<number | null>((done) => {
    // Bun 1.4.2 can drop 'close', or the whole exit notification, for a child that
    // the timeout or an interrupt killed. Finish on exit plus ended pipes as well,
    // and poll for the kill until the runtime reports it.
    const poll = setInterval(() => {
      if ((timedOut || interrupted) && child.pid !== undefined) {
        try {
          process.kill(child.pid, 0);
        } catch {
          resolveCode(null);
        }
      }
    }, 50);
    const resolveCode = (code: number | null) => {
      clearInterval(poll);
      done(code);
    };
    let exitCode: number | null | undefined;
    let openPipes = 2;
    const settle = () => {
      if (exitCode !== undefined && openPipes === 0) {
        resolveCode(exitCode);
      }
    };
    for (const pipe of [child.stdout, child.stderr]) {
      pipe.once('end', () => {
        openPipes--;
        settle();
      });
    }
    child.on('exit', (code) => {
      killGroup(child.pid);
      exitCode = code;
      settle();
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolveCode(null);
    });
    child.on('close', resolveCode);
  });
  clearTimeout(timer);
  killGroup(child.pid);
  if (files) {
    await writeFile(`${files}.stdout`, stdout);
    await writeFile(`${files}.stderr`, stderr);
  }
  assertRunning(); // Save output before reporting interruption to the caller.
  return { code, stdout, stderr, timedOut, ms: performance.now() - start };
}

export async function withInterrupts<T>(action: () => Promise<T>): Promise<T> {
  interrupted = false;
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
