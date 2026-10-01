import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { observeRuntime, runtimeShape } from '../../implement/actor-runtime.ts';

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function expectChangedHash(
  hash: { value: string | null; reason: string | null },
  initial: string | null,
) {
  expect(hash.reason).toBeNull();
  expect(hash.value).toMatch(/^[a-f0-9]{64}$/);
  expect(hash.value).not.toBe(initial);
}

test('harness identity uses its own root; code hash covers contents, paths, additions, deletion and modes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'actor-runtime-')));
  try {
    const target = join(root, 'target'),
      harness = join(root, 'harness');
    await mkdir(target);
    await mkdir(join(harness, 'scripts/implement'), { recursive: true });
    await mkdir(join(harness, 'scripts/shared'));
    for (const [path, content] of [
      ['package.json', '{}'],
      ['bun.lock', 'lock'],
      ['scripts/implement/a.ts', 'a'],
      ['scripts/shared/b.ts', 'b'],
    ] as const) {
      await writeFile(join(harness, path), content, { mode: 0o644 });
    }
    git(harness, 'init', '-q');
    git(harness, 'add', '.');
    git(
      harness,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    const commit = git(harness, 'rev-parse', 'HEAD');
    git(harness, 'worktree', 'add', '-qb', 'contrast', target);
    git(
      target,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'different HEAD',
    );
    expect(git(target, 'rev-parse', 'HEAD')).not.toBe(commit);
    await writeFile(join(target, 'scripts/implement/a.ts'), 'foreign index');
    git(target, 'add', 'scripts/implement/a.ts');
    const foreignDir = git(target, 'rev-parse', '--absolute-git-dir');
    const bin = join(root, 'bin');
    await mkdir(bin);
    const gitEntry = Bun.which('git');
    if (!gitEntry) {
      throw Error('git fixture entry unavailable');
    }
    await symlink(gitEntry, join(bin, 'git'));
    const observe = () => observeRuntime(target, { ...process.env, PATH: bin }, harness);
    const initial = await observe();
    expect(runtimeShape.safeParse(initial).success).toBe(true);
    expect(initial.harness.commit).toEqual({ value: commit, reason: null });
    expect(initial.harness.trackedDirty).toEqual({ value: false, reason: null });
    const inherited = await observeRuntime(
      target,
      {
        ...process.env,
        PATH: bin,
        GIT_DIR: foreignDir,
        GIT_WORK_TREE: harness,
        GIT_INDEX_FILE: join(foreignDir, 'index'),
        GIT_COMMON_DIR: join(harness, '.git'),
      },
      harness,
    );
    expect(inherited.harness).toEqual(initial.harness);
    const hash = initial.harness.codeHash.value;
    assert(typeof hash === 'string', 'Initial code hash must be available');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(harness, 'notes.md'), 'outside scope');
    expect((await observe()).harness).toEqual(initial.harness);
    await writeFile(join(harness, 'scripts/implement/a.ts'), 'changed');
    const changed = (await observe()).harness;
    expect(changed.trackedDirty.value).toBe(true);
    expectChangedHash(changed.codeHash, hash);
    git(harness, 'add', 'scripts/implement/a.ts');
    expect((await observe()).harness.trackedDirty.value).toBe(true);
    git(harness, 'reset', '--hard', '-q', 'HEAD');
    await chmod(join(harness, 'scripts/shared/b.ts'), 0o755);
    expectChangedHash((await observe()).harness.codeHash, hash);
    await chmod(join(harness, 'scripts/shared/b.ts'), 0o644);
    // 同じディレクトリに1ファイルだけなので、順序・内容・モードを保ちパスだけを変えます。
    await rename(join(harness, 'scripts/shared/b.ts'), join(harness, 'scripts/shared/c.ts'));
    expectChangedHash((await observe()).harness.codeHash, hash);
    await rename(join(harness, 'scripts/shared/c.ts'), join(harness, 'scripts/shared/b.ts'));
    expect((await observe()).harness.codeHash).toEqual({ value: hash, reason: null });
    await writeFile(join(harness, 'scripts/shared/new.ts'), 'new');
    const added = (await observe()).harness;
    expect(added.trackedDirty.value).toBe(false);
    expectChangedHash(added.codeHash, hash);
    await rm(join(harness, 'scripts/shared/new.ts'));
    expect((await observe()).harness.codeHash.value).toBe(hash);
    await rm(join(harness, 'scripts/shared/b.ts'));
    expectChangedHash((await observe()).harness.codeHash, hash);
    await symlink('a.ts', join(harness, 'scripts/implement/link.ts'));
    expect((await observe()).harness.codeHash).toEqual({
      value: null,
      reason: 'not a regular file: scripts/implement/link.ts',
    });
    await rm(join(harness, 'scripts/implement/link.ts'));
    await rm(join(harness, 'package.json'));
    const missing = (await observe()).harness.codeHash;
    expect(missing.value).toBeNull();
    expect(typeof missing.reason).toBe('string');
    const unknown = await observeRuntime(target, { PATH: target }, harness);
    expect(runtimeShape.safeParse(unknown).success).toBe(true);
    expect(unknown.cli.entry.value).toBeNull();
    expect(unknown.harness.commit.value).toBeNull();
    expect(unknown.harness.trackedDirty.value).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
        stdio: 'ignore',
        env: { ...process.env, PATH: root },
      },
    );
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
