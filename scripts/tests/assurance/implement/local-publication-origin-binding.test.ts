import assert from 'node:assert/strict';
import { expect, spyOn } from 'bun:test';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as hostRecords from '../../../implement/host-records.ts';
import { adoptLocalRun } from '../../../implement/local-publication.ts';
import { verifyLocalPublication } from '../../../implement/local-publication-records.ts';
import { hash } from '../../../implement/record-observation.ts';
import { command } from '../../../shared/process.ts';
import { readTarget } from '../../../shared/target.ts';
import type { Reader } from '../../../shared/target.ts';
import { object } from '../../support/correction.ts';
import { testDevelopment } from '../../support/development.ts';
import type { DevelopmentFixture } from '../../support/development.ts';
import { formalTree } from '../../support/formal-host-return.ts';
import { localPublicationOrigin } from '../../support/local-publication-origin.ts';
import { githubTarget } from '../../support/target.ts';

type Origin = Awaited<ReturnType<typeof localPublicationOrigin>>;
type Shape = 'directory' | 'file';
const mismatch = /原記録|証拠|hash|mode|変更|不一致|変わ|record|integrity/i;

async function diagnostic(name: string, value: unknown) {
  const directory = process.env.ORIGIN_BINDING_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
}

function reader(f: DevelopmentFixture, processes: () => Promise<void> = async () => {}) {
  const read: Reader = async (argv, cwd) => {
    if (argv[0] === 'ps') {
      await processes();
      return '1 0 Thu Jan 1 00:00:00 2026 /sbin/launchd\n';
    }
    if (argv[0] === 'gh') {
      const reply = githubTarget(argv, f.settings);
      assert(reply !== undefined, `Unexpected mock GitHub read: ${argv.join(' ')}`);
      return reply;
    }
    assert(argv[0] === 'git', `Unexpected observation: ${argv.join(' ')}`);
    const result = await command(argv, cwd, '', 10000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.timedOut, false);
    return result.stdout.trim();
  };
  return read;
}

async function nativeBundle(t: Origin) {
  const name = (await readdir(t.lineage.r1)).find((entry) => entry.startsWith('repair-codex-'));
  assert(name);
  return Promise.all(
    [
      join(t.lineage.r1, 'implementation.stdout'),
      join(t.lineage.r1, 'implementation.json'),
      join(t.lineage.r1, name, 'actor.json'),
      join(t.lineage.r1, name, 'final.json'),
    ].map(async (path) => ({
      path,
      sha256: hash(await readFile(path)),
      mode: (await lstat(path)).mode,
    })),
  );
}

async function intake(
  t: Origin,
  f: DevelopmentFixture,
  shape: Shape,
  onProcesses?: () => Promise<void>,
) {
  const read = reader(f, onProcesses);
  const target = await readTarget(t.published, read, true);
  const originalVerify = hostRecords.verifyHostReturn;
  const selected = shape === 'file' ? join(t.lineage.r1, 'implementation.stdout') : t.lineage.r1;
  const inImplementation = (path: string) =>
    path === t.lineage.r1 || path.startsWith(`${t.lineage.r1}/`);
  // 検証済み参照の入口の形だけを制御し、native原記録や受入内容は作り替えない。
  const history = spyOn(hostRecords, 'verifyHostReturn').mockImplementation(async (...args) => {
    const verified = await originalVerify(...args);
    return {
      ...verified,
      previousRuns: [
        ...new Set(verified.previousRuns.map((path) => (inImplementation(path) ? selected : path))),
      ],
      references: verified.references.filter((path) => !inImplementation(path)),
    };
  });
  try {
    return await adoptLocalRun({
      directory: t.prior,
      url: t.pr.url,
      runDirectory: t.dir,
      cwd: t.published,
      issue: '99',
      head: t.pr.headRefOid,
      target,
      read,
    });
  } finally {
    history.mockRestore();
  }
}

function scenario(name: string, run: (t: Origin, f: DevelopmentFixture) => Promise<void>) {
  testDevelopment(
    `初回実装原記録の束縛 ${name}`,
    async (f) => {
      const t = await localPublicationOrigin(f, true);
      await run(t, f);
    },
    {},
    60000,
  );
}

for (const shape of ['directory', 'file'] as const) {
  scenario(`${shape}参照でも消費したnative・終了結果を全hashとmodeへ固定する`, async (t, f) => {
    const before = await t.retained();
    const expected = await nativeBundle(t);
    const adopted = await intake(t, f, shape);
    const bound = adopted.localPublication.records;
    const actual = expected.map(({ path }) => bound.find((record) => record.path === path));
    await diagnostic(`bundle-${shape}`, { expected, actual });
    expect(actual).toEqual(expected);
    await verifyLocalPublication(adopted.localPublication, t.published, t.dir, reader(f));
    expect(await t.observations()).toEqual([]);
    expect(await t.retained()).toEqual(before);
  });
}

scenario('file参照の取り込み中に取得済みexit結果が変われば後続へ渡さない', async (t, f) => {
  const before = await readFile(t.implementation, 'utf8');
  let changed = false;
  let retainedAfterMutation = '';
  let error: unknown;
  try {
    await intake(t, f, 'file', async () => {
      if (!changed) {
        const execution = object(JSON.parse(before));
        assert(typeof execution.ms === 'number');
        await writeFile(t.implementation, JSON.stringify({ ...execution, ms: execution.ms + 1 }));
        changed = true;
        retainedAfterMutation = JSON.stringify(
          await Promise.all([t.retained(), formalTree(t.published)]),
        );
      }
    });
  } catch (failure) {
    error = failure;
  }
  await diagnostic('changed-during-intake', {
    changed,
    rejected: error instanceof Error,
    message: error instanceof Error ? error.message : null,
  });
  expect(changed).toBe(true);
  expect(JSON.stringify(await Promise.all([t.retained(), formalTree(t.published)]))).toBe(
    retainedAfterMutation,
  );
  assert(error instanceof Error, '取り込み中に変わった取得済みexit結果を採用してはならない');
  assert.match(error.message, mismatch);
  expect(await t.observations()).toEqual([]);
  expect(await readFile(t.implementation, 'utf8')).not.toBe(before);
});

for (const defect of ['native-content', 'exit-mode'] as const) {
  scenario(`file参照の採用後に${defect}が変われば次の境界で停止する`, async (t, f) => {
    const adopted = await intake(t, f, 'file');
    const bundle = await nativeBundle(t);
    const path =
      defect === 'exit-mode'
        ? t.implementation
        : bundle.find((ref) => ref.path.endsWith('/final.json'))?.path;
    assert(path);
    if (defect === 'exit-mode') {
      await chmod(path, ((await lstat(path)).mode & 0o7777) ^ 0o100);
    } else {
      const reply = object(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(path, JSON.stringify({ ...reply, findings: 'changed after acquisition' }));
    }
    const before = await Promise.all([t.retained(), formalTree(t.published)]);
    let reads = 0;
    let error: unknown;
    try {
      await verifyLocalPublication(
        adopted.localPublication,
        t.published,
        t.dir,
        reader(f, async () => {
          reads++;
        }),
      );
    } catch (failure) {
      error = failure;
    }
    await diagnostic(`changed-after-${defect}`, {
      path,
      bound: adopted.localPublication.records.some((ref) => ref.path === path),
      rejected: error instanceof Error,
      reads,
      message: error instanceof Error ? error.message : null,
    });
    assert(
      error instanceof Error,
      '取得後に変わったnative・exit原記録を後続で再利用してはならない',
    );
    assert.match(error.message, mismatch);
    expect(reads).toBe(0);
    expect(await t.observations()).toEqual([]);
    expect(await Promise.all([t.retained(), formalTree(t.published)])).toEqual(before);
  });
}
