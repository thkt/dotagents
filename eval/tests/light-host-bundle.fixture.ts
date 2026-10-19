import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  nativeBoundaryResponses,
  nativeFixedResponses,
  nativeReadToolResponses,
  nativeToolInventoryResponses,
} from './light-native-responses.fixture.ts';
import { lightBoundaryFixture } from './light-boundary.fixture.ts';
import { isRecord } from '../../scripts/shared/values.ts';

// 接続資産だけを生成する。CLI・provider・認証・サーバーは起動しない。
export async function prepareLightHostBundle(destination: string, input: unknown) {
  assert(isAbsolute(destination), '保存先には新しい絶対パスを指定する');
  assert(isRecord(input));
  const { bunExecutable, bunVersion, workspace, targets, readTools } = input;
  assert(typeof bunExecutable === 'string' && isAbsolute(bunExecutable));
  assert(typeof bunVersion === 'string' && bunVersion.length > 0);
  assert(typeof workspace === 'string' && isAbsolute(workspace));
  assert(Array.isArray(targets) && Array.isArray(readTools));
  const operations = targets.map((target: unknown) => {
    assert(isRecord(target));
    assert(target.kind === 'read' || target.kind === 'shell-read' || target.kind === 'write');
    assert(typeof target.path === 'string' && isAbsolute(target.path));
    return {
      target,
      steps: nativeBoundaryResponses(
        bunExecutable,
        join(workspace, 'light-boundary.fixture.ts'),
        target.kind,
        target.path,
      ),
    };
  });
  const readers = readTools.map((tool: unknown) => {
    assert(isRecord(tool) && typeof tool.name === 'string' && isRecord(tool.args));
    return { tool, steps: nativeReadToolResponses(tool.name, tool.args) };
  });
  const files = new Map<string, string | Buffer>([
    [
      'fixed-responses.json',
      JSON.stringify(nativeFixedResponses(bunExecutable, bunVersion), null, 2),
    ],
    ['tool-inventory.json', JSON.stringify(nativeToolInventoryResponses(), null, 2)],
    ['boundary-responses.json', JSON.stringify(operations, null, 2)],
    ['read-tool-responses.json', JSON.stringify(readers, null, 2)],
    ['light-boundary.fixture.ts', await readFile(lightBoundaryFixture)],
    [
      'light-host-cases.json',
      await readFile(join(import.meta.dir, 'fixtures/light-host-cases.json')),
    ],
  ]);
  await mkdir(destination, { mode: 0o700 });
  const hashes: Record<string, string> = {};
  for (const [name, body] of files) {
    await writeFile(join(destination, name), body, { flag: 'wx', mode: 0o600 });
    hashes[name] = createHash('sha256').update(body).digest('hex');
  }
  await writeFile(
    join(destination, 'manifest.json'),
    JSON.stringify(
      { input, hashes, scope: '合成固定資産の生成のみ。実効境界と実認証は未確認。' },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  return hashes;
}
if (import.meta.main) {
  const [destination, configuration, ...extra] = process.argv.slice(2);
  assert(destination && configuration && extra.length === 0, '保存先と接続設定JSONを指定する');
  const input: unknown = JSON.parse(await readFile(configuration, 'utf8'));
  console.log(JSON.stringify(await prepareLightHostBundle(destination, input)));
}
