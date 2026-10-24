import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { hash } from './record-observation.ts';

const absolutePath = z.string().refine(isAbsolute);
export const formalModeReference = z.strictObject({
  path: absolutePath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.number().int(),
});
const modesShape = z
  .array(
    z.strictObject({ path: absolutePath, mode: z.number().int(), link: z.string().optional() }),
  )
  .min(1);
const capsuleShape = z.strictObject({
  coverage: z.literal('records_and_external_evidence').optional(),
  observedAt: z.string().datetime(),
  earlierModes: z.literal('unknown_before_observation'),
  checkout: absolutePath,
  roots: z.array(z.strictObject({ path: absolutePath, modes: modesShape })).min(1),
});

// 現在の成果物checkoutだけを除外し、symlinkは辿らずfullmodeを記録する。
// 旧形式に無い過去のmodeを復元した記録ではなく、この観測以降の保全に使う。
async function formalModes(path: string, cwd: string): Promise<z.infer<typeof modesShape>> {
  if (path === cwd) {
    return [];
  }
  const info = await lstat(path);
  assert(
    info.isFile() || info.isDirectory() || info.isSymbolicLink(),
    '祖先記録の種別を照合できません',
  );
  const entries: z.infer<typeof modesShape> = [
    { path, mode: info.mode, ...(info.isSymbolicLink() ? { link: await readlink(path) } : {}) },
  ];
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) {
      entries.push(...(await formalModes(join(path, name), cwd)));
    }
  }
  return entries;
}

function modesMatch(expected: z.infer<typeof modesShape>, actual: z.infer<typeof modesShape>) {
  return (
    expected.length === actual.length &&
    expected.every(
      (entry, index) =>
        entry.path === actual[index]?.path &&
        entry.mode === actual[index]?.mode &&
        (entry.link === undefined || entry.link === actual[index]?.link),
    )
  );
}

export async function verifyFormalModes(
  cwd: string,
  roots: string[],
  references: z.infer<typeof formalModeReference>[],
  complete: boolean,
  legacyRoots: string[],
) {
  const checked = new Map<string, string>();
  const expectations = new Map<string, z.infer<typeof modesShape>>();
  let externalCoverage = false;
  for (const reference of references) {
    assert(
      !checked.has(reference.path) ||
        checked.get(reference.path) === `${reference.sha256}:${reference.mode}`,
      '祖先mode記録の参照に異なる期待値があります',
    );
    if (checked.has(reference.path)) {
      continue;
    }
    checked.set(reference.path, `${reference.sha256}:${reference.mode}`);
    const info = await lstat(reference.path);
    assert(
      info.isFile() && info.mode === reference.mode,
      '祖先mode記録の種別・モードが変わりました',
    );
    const content = await readFile(reference.path);
    assert(hash(content) === reference.sha256, '祖先mode記録の内容が変わりました');
    const capsule = capsuleShape.parse(JSON.parse(content.toString('utf8')));
    assert(
      !capsule.coverage ||
        capsule.roots.every((root) =>
          root.modes.every(
            (entry) => (entry.mode & 0o170000) !== 0o120000 || entry.link !== undefined,
          ),
        ),
      '祖先symlinkの保全範囲が不足しています',
    );
    if (reference === references[0]) {
      externalCoverage = capsule.coverage === 'records_and_external_evidence';
    }
    assert(capsule.checkout === cwd, '祖先mode記録のcheckoutが一致しません');
    for (const root of capsule.roots) {
      assert(roots.includes(root.path), '祖先mode記録の保存先が履歴と一致しません');
      const previous = expectations.get(root.path);
      assert(
        !previous ||
          modesMatch(
            previous.map((entry, index) => ({ ...root.modes[index], ...entry })),
            root.modes.map((entry, index) => ({ ...previous[index], ...entry })),
          ),
        '同じ祖先のmodeに異なる期待値があります',
      );
      expectations.set(
        root.path,
        root.modes.map((entry, index) => ({ ...previous?.[index], ...entry })),
      );
    }
  }
  for (const [path, expected] of expectations) {
    assert(
      modesMatch(expected, await formalModes(path, cwd)),
      `正式な祖先記録の一覧・モードが変わりました: ${path}`,
    );
  }
  assert(
    !complete || (externalCoverage ? roots : legacyRoots).every((path) => expectations.has(path)),
    '祖先modeの保全範囲が不足しています',
  );
  // 旧capsuleに無いリンク先は補作せず、新しい観測で保全範囲へ加える。
  return [...expectations]
    .filter(([, modes]) =>
      modes.every((entry) => (entry.mode & 0o170000) !== 0o120000 || entry.link !== undefined),
    )
    .map(([path]) => path);
}

export async function prepareFormalModes(
  cwd: string,
  runDirectory: string,
  history: string[],
  previous: string[],
) {
  const roots = [];
  for (const path of history) {
    if (!previous.includes(path)) {
      roots.push({ path, modes: await formalModes(path, cwd) });
    }
  }
  assert(roots.length > 0, '新しく観測する正式停止記録がありません');
  const content = JSON.stringify(
    {
      coverage: 'records_and_external_evidence',
      observedAt: new Date().toISOString(),
      earlierModes: 'unknown_before_observation',
      checkout: cwd,
      roots,
    },
    null,
    2,
  );
  const directory = join(dirname(runDirectory), `host-preservation-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, 'formal-modes.json');
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  return { path, sha256: hash(content), mode: (await lstat(path)).mode };
}
