import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ProcessApi {
  command: (
    argv: string[],
    cwd: string,
    input: string,
    timeout: number | null,
    files?: string,
  ) => Promise<unknown>;
  withInterrupts: <T>(action: () => Promise<T>) => Promise<T>;
}
type Outcome =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; error: unknown }
  | { status: 'watchdog' };

function assertApi(value: unknown): asserts value is ProcessApi {
  assert(value !== null && typeof value === 'object');
  assert('command' in value && typeof value.command === 'function');
  assert('withInterrupts' in value && typeof value.withInterrupts === 'function');
}

function serialize(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item: unknown) => serialize(item, seen));
  }
  return Object.fromEntries(
    Object.getOwnPropertyNames(value)
      .filter((key) => key !== 'stack')
      .map((key) => {
        const item: unknown = Reflect.get(value, key);
        return [key, serialize(item, seen)];
      }),
  );
}

const [modulePath, root, trigger, injection] = process.argv.slice(2);
assert(modulePath && root && trigger && injection);
const api: unknown = await import(pathToFileURL(modulePath).href);
assertApi(api);
const originalKill = process.kill.bind(process);
const injected: unknown[] = [];
const escaped: unknown[] = [];
const groupFile = join(root, 'group.pid');
const prefix = join(root, 'acquired');
const marker = join(root, 'next-command');
const deadlineMs = 2000;
let cleaningUp = false;
let cleanupChecks = 0;

function alive(pid: number) {
  try {
    if (cleaningUp) {
      cleanupChecks += 1;
      if (
        injection === 'cleanup-EPERM' ||
        (injection === 'cleanup-EPERM-once' && cleanupChecks === 1) ||
        injection === 'cleanup-exception'
      ) {
        const error = Object.assign(Error('controlled cleanup existence failure'), {
          code: injection === 'cleanup-exception' ? 'EIO' : 'EPERM',
          syscall: 'kill',
        });
        injected.push({ pid, signal: 0, error: serialize(error) });
        throw error;
      }
    }
    originalKill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    if (cleaningUp && error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

async function waitFor(path: string) {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw Error(`fixture-not-ready: ${path}`);
    }
    await Bun.sleep(10);
  }
}

async function outcome(action: () => Promise<unknown>): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action().then(
        (value): Outcome => ({ status: 'fulfilled', value: serialize(value) }),
        (error): Outcome => ({ status: 'rejected', error: serialize(error) }),
      ),
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'watchdog' }), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

process.on('uncaughtException', (error) => {
  escaped.push(serialize(error));
  process.exitCode = 1;
});
process.kill = (pid, signal) => {
  const ownedGroup = existsSync(groupFile) ? Number(readFileSync(groupFile, 'utf8')) : undefined;
  if (
    injection === 'EPERM' &&
    ownedGroup !== undefined &&
    pid === -ownedGroup &&
    signal === 'SIGKILL'
  ) {
    const error = Object.assign(Error('controlled owned-group kill failure'), {
      code: 'EPERM',
      syscall: 'kill',
    });
    injected.push({ pid, signal, error: serialize(error) });
    throw error;
  }
  return originalKill(pid, signal);
};

const report: Record<string, unknown> = { trigger, injection, injected, escaped };
try {
  const pending = outcome(() =>
    api.withInterrupts(() =>
      api.command(
        [process.execPath, join(import.meta.dir, 'process-cleanup-worker.ts'), root, trigger],
        root,
        '',
        trigger === 'timeout' ? 600 : null,
        prefix,
      ),
    ),
  );
  await waitFor(join(root, 'ready'));
  // 出力の取得を済ませてから、外部signalの入口へ進める。
  if (trigger === 'signal') {
    await Bun.sleep(100);
    originalKill(process.pid, 'SIGTERM');
  }
  const first = await pending;
  report.first = first;
  const group = Number(readFileSync(groupFile, 'utf8'));
  report.group = group;
  report.groupAliveBeforeNext = alive(-group);
  if (first.status !== 'watchdog') {
    report.next = await outcome(() =>
      api.withInterrupts(() =>
        api.command(
          [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
          ],
          root,
          '',
          1000,
        ),
      ),
    );
  }
  report.nextStarted = existsSync(marker);
  report.saved = Object.fromEntries(
    ['stdout', 'stderr'].map((stream) => {
      const path = `${prefix}.${stream}`;
      return [stream, existsSync(path) ? readFileSync(path, 'utf8') : null];
    }),
  );
} catch (error) {
  report.harnessError = serialize(error);
}
cleaningUp = true;
process.kill = originalKill;
try {
  if (existsSync(groupFile)) {
    const group = Number(readFileSync(groupFile, 'utf8'));
    if (Number.isSafeInteger(group) && group > 1) {
      try {
        originalKill(-group, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error;
        }
      }
      const deadline = Date.now() + 1000;
      let groupAlive = true;
      do {
        groupAlive = alive(-group);
        if (!groupAlive) {
          break;
        }
        await Bun.sleep(20);
      } while (Date.now() < deadline);
      report.groupAliveAfterCleanup = groupAlive;
      if (groupAlive) {
        throw Error('process group disappearance unconfirmed after cleanup');
      }
    }
  }
} catch (error) {
  report.cleanupError = serialize(error);
}
writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.exit(process.exitCode ?? 0);
