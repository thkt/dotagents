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
type Chunk = { done: true; value: undefined } | { done: false; value: unknown };

function assertRead(
  value: unknown,
): asserts value is (this: ReadableStreamDefaultReader<unknown>) => Promise<Chunk> {
  assert(typeof value === 'function');
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

const [modulePath, root, scenario] = process.argv.slice(2);
assert(modulePath && root && scenario);
const readDescriptor = Object.getOwnPropertyDescriptor(
  ReadableStreamDefaultReader.prototype,
  'read',
);
assert(readDescriptor);
const originalRead: unknown = readDescriptor.value;
assertRead(originalRead);
const originalKill = process.kill.bind(process);
const conditions = { readFailures: 0, stderrEof: false, groupKills: 0, signaled: false };
const escaped: unknown[] = [];
if (scenario === 'read-failure') {
  const failedReaders = new WeakSet<object>();
  process.on('uncaughtException', (error) => escaped.push(serialize(error)));
  ReadableStreamDefaultReader.prototype.read = async function (): Promise<Chunk> {
    if (failedReaders.has(this)) {
      conditions.readFailures++;
      throw Error('controlled stdout read failure');
    }
    const chunk = await originalRead.call(this);
    if (chunk.done) {
      conditions.stderrEof = true;
    } else if (
      chunk.value instanceof Uint8Array &&
      Buffer.from(chunk.value).toString('utf8') === 'partial stdout'
    ) {
      failedReaders.add(this);
    }
    return chunk;
  };
  process.kill = (pid, signal) => {
    const groupFile = join(root, 'group.pid');
    const group = existsSync(groupFile) ? Number(readFileSync(groupFile, 'utf8')) : undefined;
    if (group !== undefined && pid === -group && signal === 'SIGKILL') {
      conditions.groupKills++;
      throw Object.assign(Error('controlled owned-group kill failure'), {
        code: 'EPERM',
        syscall: 'kill',
      });
    }
    return originalKill(pid, signal);
  };
}
const api: unknown = await import(pathToFileURL(modulePath).href);
assertApi(api);
const common = `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'group.pid'))}, String(process.pid));`;
const scripts: Record<string, string> = {
  bom: `${common}process.stdout.write(Buffer.from('efbbbf41','hex'));process.stderr.write(Buffer.from('efbbbf42','hex'));`,
  'large-stdin': `${common}const hash=require('node:crypto').createHash('sha256');let bytes=0;process.stdin.on('data',chunk=>{bytes+=chunk.length;hash.update(chunk);});process.stdin.on('end',()=>process.stdout.write(JSON.stringify({bytes,sha256:hash.digest('hex')})));`,
  'read-failure': `${common}require('node:fs').closeSync(2);process.stdout.write('partial stdout');setInterval(()=>{},1000);`,
};
const script = scripts[scenario];
assert(script);
const pending = api
  .withInterrupts(() =>
    api.command(
      [process.execPath, '-e', script],
      root,
      readFileSync(join(root, 'input')).toString('utf8'),
      5000,
      join(root, 'acquired'),
    ),
  )
  .then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error: serialize(error) }),
  );
if (scenario === 'read-failure') {
  const deadline = Date.now() + 2000;
  while (!conditions.readFailures || !conditions.stderrEof) {
    assert(Date.now() < deadline, 'read-failure conditions not reached');
    await Bun.sleep(10);
  }
  conditions.signaled = process.listenerCount('SIGTERM') > 0;
  if (conditions.signaled) {
    originalKill(process.pid, 'SIGTERM');
  }
}
const outcome = await pending;
Object.defineProperty(ReadableStreamDefaultReader.prototype, 'read', readDescriptor);
process.kill = originalKill;
writeFileSync(
  join(root, 'settled.json'),
  `${JSON.stringify({ ...outcome, conditions, escaped }, null, 2)}\n`,
);
