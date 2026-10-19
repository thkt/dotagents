import assert from 'node:assert/strict';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const hash = (body: string) => createHash('sha256').update(body).digest('hex');

// 認証本文と全ホームは読まない。既知の登録元だけを要約し、symlinkは追わない。
export async function lightContext() {
  const home = process.env.HOME ?? '';
  const location = process.env.CODEX_HOME ?? join(home, '.codex');
  const authenticationHome = await realpath(location).catch((cause: unknown) => {
    assert(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT');
    return resolve(location);
  });
  const sources: Record<string, string> = {};
  let entries = 0;
  const observe = async (path: string, contents = false): Promise<string> => {
    assert(++entries <= 4000, '共通条件の登録数が観測上限を超えました');
    const stat = await lstat(path).catch((cause: unknown) => {
      assert(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT');
      return null;
    });
    if (!stat) {
      return 'absent';
    }
    if (stat.isSymbolicLink()) {
      return hash(`symlink:${await readlink(path)}`);
    }
    if (stat.isDirectory()) {
      const children = [];
      for (const name of (await readdir(path)).sort()) {
        assert(++entries <= 4000, '共通条件の登録数が観測上限を超えました');
        const child = await lstat(join(path, name));
        children.push([
          name,
          child.isSymbolicLink()
            ? hash(await readlink(join(path, name)))
            : `${child.mode}:${child.size}:${child.mtimeMs}`,
        ]);
      }
      return hash(JSON.stringify(children));
    }
    assert(stat.isFile(), '共通条件の登録形式が未対応です');
    if (!contents) {
      return hash(`${stat.mode}:${stat.size}:${stat.mtimeMs}`);
    }
    assert(stat.size <= 1024 * 1024, '共通条件の観測容量上限');
    return hash(await readFile(path, 'utf8'));
  };
  for (const name of [
    'AGENTS.md',
    'config.toml',
    'hooks.json',
    'skills',
    'plugins',
    'rules',
    'memories',
  ]) {
    sources[`CODEX_HOME/${name}`] = await observe(
      join(authenticationHome, name),
      ['AGENTS.md', 'config.toml', 'hooks.json'].includes(name),
    );
  }
  sources['HOME/.agents/skills'] = await observe(join(home, '.agents/skills'));
  return {
    authenticationHome: resolve(location),
    summary: {
      storageIdentity: hash(authenticationHome),
      sources,
      suppressed: [
        'user-config',
        'rules',
        'project-doc-discovery',
        'hooks',
        'MCP',
        'plugins',
        'memories',
        'multi-agent',
      ],
      fixedInputs: '公開A/BのAGENTS本文と明示したscoping・implementのパスを選択する',
      scope: '日常環境の共通条件下の少数比較。固定課題入力とCLIの共通コンテキストは別',
      unknown:
        'CLIが自動追加する全入力、登録ディレクトリ内の本文・symlink先の変更、OS資格情報ストアへの実認証互換性は未確認。全ホームの同一性を保証しない',
    },
  };
}
