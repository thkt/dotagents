import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { hash } from './record-observation.ts';

const names = ['bun.lock', 'uv.lock'];
const manifestShape = z.strictObject({
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

function artifactInputs(run: string, records: ReadonlySet<string>) {
  const baseline = join(run, 'test-baseline');
  const roots: [string, string][] = [
    [join(run, 'checkout'), `${baseline}.json`],
    [baseline, `${baseline}.json`],
  ];
  for (const path of records) {
    if (
      [run, join(run, 'verification')].includes(dirname(path)) &&
      /^test-\d+\.target\.json$/.test(basename(path))
    ) {
      const workspace = `${path.slice(0, -'.target.json'.length)}-workspace`;
      roots.push([workspace, `${workspace}.json`]);
    }
  }
  return roots;
}

async function dependencyPaths(root: string, manifest: string, records: ReadonlySet<string>) {
  const paths: string[] = [];
  if (!records.has(manifest)) {
    return paths;
  }
  assert((await lstat(manifest)).isFile(), '依存物の入力manifestは通常ファイルが必要です');
  const input = manifestShape.parse(JSON.parse(await readFile(manifest, 'utf8')));
  for (const path of Object.keys(input.files)) {
    if (names.includes(basename(path))) {
      assert(
        !isAbsolute(path) &&
          path
            .split('/')
            .every(
              (part) => part.length > 0 && !['.', '..', '.git', 'node_modules'].includes(part),
            ),
        '依存物の入力manifestのpathが不正です',
      );
      const declared = join(root, path);
      assert(
        (await realpath(dirname(declared))) === dirname(declared),
        '依存物の親にsymlinkがあります',
      );
      const info = await lstat(declared);
      assert(info.isFile(), '依存物は通常ファイルが必要です');
      assert(
        hash(Buffer.concat([Buffer.from(`${info.mode}:`), await readFile(declared)])) ===
          input.files[path],
        `依存物の内容・全modeが入力manifestと一致しません: ${declared}`,
      );
      paths.push(declared);
    }
  }
  return paths;
}

export async function formalDependencyLocks(run: string, records: Iterable<string>) {
  const paths = new Set(records);
  const dependencies = await Promise.all(
    artifactInputs(run, paths).map(([root, manifest]) => dependencyPaths(root, manifest, paths)),
  );
  return new Set(dependencies.flat());
}
