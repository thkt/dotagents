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
  return Object.fromEntries(
    Object.getOwnPropertyNames(value)
      .filter((key) => key !== 'stack')
      .map((key) => {
        const item: unknown = Reflect.get(value, key);
        return [key, serialize(item, seen)];
      }),
  );
}

const [modulePath, root, inputSize] = process.argv.slice(2);
assert(modulePath && root && inputSize);
const api: unknown = await import(pathToFileURL(modulePath).href);
assertApi(api);
const originalKill = process.kill.bind(process);
const injected: unknown[] = [];
const escaped: unknown[] = [];
const groupFile = join(root, 'group.pid');
process.on('uncaughtException', (error) => escaped.push(serialize(error)));
process.kill = (pid, signal) => {
  const group = existsSync(groupFile) ? Number(readFileSync(groupFile, 'utf8')) : undefined;
  if (group !== undefined && pid === -group && signal === 'SIGKILL') {
    const error = Object.assign(Error('controlled owned-group kill failure'), {
      code: 'EPERM',
      syscall: 'kill',
    });
    injected.push({ pid, signal, error: serialize(error) });
    writeFileSync(join(root, 'injected.json'), JSON.stringify(injected));
    throw error;
  }
  return originalKill(pid, signal);
};

const pending = api
  .withInterrupts(() =>
    api.command(
      [process.execPath, join(import.meta.dir, 'process-cleanup-worker.ts'), root, 'signal'],
      root,
      'x'.repeat(Number(inputSize)),
      null,
      join(root, 'acquired'),
    ),
  )
  .then(
    (value) => ({ status: 'fulfilled', value: serialize(value) }),
    (error) => ({ status: 'rejected', error: serialize(error) }),
  );

const readyDeadline = Date.now() + 4000;
while (!existsSync(join(root, 'ready'))) {
  assert(Date.now() < readyDeadline, 'fixture-not-ready');
  await Bun.sleep(10);
}
await Bun.sleep(100);
originalKill(process.pid, 'SIGTERM');
const first = await pending;
writeFileSync(
  join(root, 'settled.json'),
  `${JSON.stringify({ first, injected, escaped }, null, 2)}\n`,
);
// 呼出側へ返った後の自然終了を、外側だけで観測・回収する。
