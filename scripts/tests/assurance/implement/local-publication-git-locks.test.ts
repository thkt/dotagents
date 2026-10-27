import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { object } from '../../support/correction.ts';
import { formalTree } from '../../support/formal-host-return.ts';
import { localPublicationFixture } from '../../support/local-publication.ts';
import { git } from '../../support/target.ts';

type Fixture = Awaited<ReturnType<typeof localPublicationFixture>>;
type Lock = 'index' | 'refs' | 'common';

function lockPath(cwd: string, kind: Lock) {
  const gitDir = git(cwd, 'rev-parse', '--absolute-git-dir');
  const commonDir = resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir'));
  if (kind === 'index') {
    return join(gitDir, 'index.lock');
  }
  if (kind === 'refs') {
    return join(commonDir, 'refs/heads/fixture.lock');
  }
  return join(commonDir, 'config.lock');
}

async function retained(f: Fixture) {
  const source = async (cwd: string) =>
    Promise.all(
      (await readdir(cwd))
        .filter((name) => name !== '.git')
        .sort()
        .map(async (name) => [name, await formalTree(join(cwd, name))]),
    );
  return {
    records: await formalTree(f.prior, true),
    localSource: await source(f.checkout),
    publishedSource: await source(f.published),
  };
}

for (const boundary of ['intake', 'after-test'] as const) {
  for (const side of ['checkout', 'published'] as const) {
    for (const kind of ['index', 'refs', 'common'] as const) {
      test(`単独公開のGit管理lock ${boundary} ${side} ${kind}は原本を保ち後続を止める`, async () => {
        const f = await localPublicationFixture('codex/standalone-publication');
        try {
          const config = object(
            JSON.parse(await readFile(join(f.prior, 'verification-config.json'), 'utf8')),
          );
          expect(config.hostReturn).toBeUndefined();
          expect(config.reviewReturn).toBeUndefined();
          const old = object(JSON.parse(await readFile(join(f.prior, 'result.json'), 'utf8')));
          expect(old).toMatchObject({
            status: 'verified_local',
            terminal: true,
            publication: 'not_attempted',
          });
          const state = object(
            JSON.parse(await readFile(join(f.prior, 'verification/state.json'), 'utf8')),
          );
          expect(state).toMatchObject({ active: null, result: 'ready_for_human_review' });
          const path = lockPath(f[side], kind);
          await mkdir(dirname(path), { recursive: true });
          if (boundary === 'intake') {
            await writeFile(path, 'fixture Git lock', { mode: 0o640 });
          } else {
            // 採用受付にはlockを置かず、有効な独立判断の直後に外部状態だけを変える。
            await f.changeControl({ gitLockAfterTest: path });
          }
          const before = await retained(f);
          const result = await f.cli(f.args);
          expect(result.timedOut).toBe(false);
          expect(await readFile(path, 'utf8')).toBe('fixture Git lock');
          expect((await lstat(path)).mode).toBe(0o100640);
          const calls = await f.observations();
          const roles = calls.filter((call) => call.role !== 'github').map((call) => call.role);
          assert.deepEqual(
            { code: result.code, roles, retained: await retained(f) },
            { code: 1, roles: boundary === 'intake' ? [] : ['test'], retained: before },
            result.stderr,
          );
          expect(
            calls.some(
              (call) =>
                Array.isArray(call.argv) &&
                ['create', 'edit', 'ready'].includes(String(call.argv[2])),
            ),
          ).toBe(false);
          assert.equal(result.code, 1, result.stdout + result.stderr);
          assert.match(result.stderr, /lock|ロック/i);
          assert.doesNotMatch(
            result.stderr,
            /Unknown option|Cannot find|ENOENT|SyntaxError|ReferenceError/,
          );
        } finally {
          await f.dispose();
        }
      }, 60000);
    }
  }
}
