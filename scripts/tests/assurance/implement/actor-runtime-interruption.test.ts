import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
async function waitFor<T>(read: () => Promise<T | null>, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await Bun.sleep(20);
  }
  throw Error('Fixture observation timed out');
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('host group stop also terminates the version observation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'actor-host-stop-')));
  let observerPid: number | undefined;
  let descendantPid: number | undefined;
  let actorPid: number | undefined;
  try {
    await writeFile(
      join(root, 'codex'),
      `#!${process.execPath}
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const child=spawn(${JSON.stringify(process.execPath)}, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(join(root, 'descendant.pid'))},String(child.pid));
writeFileSync(${JSON.stringify(join(root, 'version.pid'))},String(process.pid));
setInterval(()=>{},1000);
`,
      { mode: 0o755 },
    );
    const actor = spawn(
      process.execPath,
      [resolve('scripts/implement/codex-actor.ts'), 'repair', root],
      {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, PATH: root },
      },
    );
    actor.stdin.end('Repair fixture');
    actorPid = actor.pid;
    if (actorPid === undefined) {
      throw Error('Actor fixture could not start');
    }
    actor.unref();
    observerPid = await waitFor(async () => {
      const raw = await readFile(join(root, 'version.pid'), 'utf8').catch(() => null);
      return raw === null ? null : Number(raw);
    }, 1000);
    descendantPid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
    expect(alive(observerPid)).toBe(true);
    expect(alive(descendantPid)).toBe(true);
    process.kill(-actorPid, 'SIGKILL');
    const stopped = await waitFor(
      async () => (alive(observerPid ?? 0) || alive(descendantPid ?? 0) ? null : true),
      2500,
    );
    expect(stopped).toBe(true);
  } finally {
    for (const pid of [
      actorPid === undefined ? undefined : -actorPid,
      observerPid,
      descendantPid,
    ]) {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
