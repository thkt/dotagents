import assert from 'node:assert/strict';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { command } from '../../shared/process.ts';
import { z } from 'zod';

// ホスト提供の固定入力。#430の実装でも受入記録でもなく、合成祖先の生成だけに使う。
// source: 1a3cb85fee42f16e4490935b77a43adb37a1b0eea370b8cf16da44c3920b4ffa
// #430: source 811a3fab6f955037896a60fd5a4a35d801d1a6f48111ef4c8550f03a4cc3ee1a
// 旧producerの自然な判断待ちを作る固定入力で、#432 consumerとは分離する。
// 全snapshotを圧縮して保持し、生成器の暗黙の文書・schema依存も固定する。
export async function fixedHostGenerator(root: string, version: '428' | '430' = '428') {
  assert(
    version === '430' ? Bun.version === '1.4.4' : ['1.4.3', '1.4.4'].includes(Bun.version),
    '合成祖先の生成には確認済みBunが必要です',
  );
  const archive = new URL(
    `../fixtures/formal-host-return/accepted${version}-source.tar.gz`,
    import.meta.url,
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    version === '430'
      ? '656b84d44815a104dd223597893a7b2e26eca0bb06691f6d27afb7c9c82f7339'
      : '39e2c509dc90860e61f8f3659cbe41052da7f2ae926dc6ceeba8250b1b074f2e',
    '受理済み依存の固定入力が変化しました',
  );
  const directory = join(root, `accepted${version}-generator`);
  await mkdir(directory);
  const result = await command(['tar', '-xzf', archive.pathname, '-C', directory], root, '', 10000);
  assert.equal(result.code, 0, result.stderr);
  // 開発ツールの移行でlockfile全体は変わる。実行時依存の宣言と解決結果を照合する。
  const manifest = (path: string | URL) =>
    readFile(path, 'utf8').then(
      (raw) =>
        z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(raw))
          .dependencies,
    );
  const dependencies = await manifest(join(directory, 'package.json'));
  assert.deepEqual(dependencies, await manifest(new URL('../../../package.json', import.meta.url)));
  const fixedLock = await readFile(join(directory, 'bun.lock'), 'utf8');
  const currentLock = await readFile(new URL('../../../bun.lock', import.meta.url), 'utf8');
  for (const name of Object.keys(dependencies)) {
    const prefix = `${JSON.stringify(name)}: [`;
    const fixed = fixedLock.split('\n').find((line) => line.trimStart().startsWith(prefix));
    const current = currentLock.split('\n').find((line) => line.trimStart().startsWith(prefix));
    assert(fixed && current, `実行時依存の解決記録がありません: ${name}`);
    assert.equal(current.trim(), fixed.trim(), `実行時依存の解決結果が変化しました: ${name}`);
  }
  if (version === '430') {
    for (const [name, version] of Object.entries(dependencies)) {
      const installed = z
        .object({ version: z.string() })
        .parse(
          JSON.parse(
            await readFile(
              new URL(`../../../node_modules/${name}/package.json`, import.meta.url),
              'utf8',
            ),
          ),
        );
      assert.equal(installed.version, version, `実行時依存の実体が変化しました: ${name}`);
    }
  }
  await symlink(
    new URL('../../../node_modules', import.meta.url).pathname,
    join(directory, 'node_modules'),
  );
  return directory;
}
