import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../shared/values.ts';

// 私用版スキルが同梱するthkt/feedback-loopの生成物を検査し、指定commitから同梱し直す。
const skillDirectory = 'skills/setup-feedback-loop';
const bundledDirectories = ['scripts', 'references'];
const upstreamRepository = 'thkt/feedback-loop';
const upstreamDirectory = 'dist/private';
const usage = `使い方（repoのルートで実行します）:
  bun scripts/lint/feedback-loop-bundle.ts
      同梱ファイルがupstream.jsonのsha256と一致することを検査します
  bun scripts/lint/feedback-loop-bundle.ts update --source <feedback-loopのcheckout> --commit <commit>
      指定commitの${upstreamDirectory}で同梱ファイルとupstream.jsonを置き換えます`;

function sha256(body: Uint8Array) {
  return createHash('sha256').update(body).digest('hex');
}

function bundledFiles(root: string): string[] {
  return bundledDirectories
    .filter((directory) => existsSync(join(root, directory)))
    .flatMap((directory) =>
      readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
        .filter((entry) => !entry.isDirectory())
        .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)),
    )
    .sort();
}

function readRecordedHashes(root: string) {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'));
  assert(isRecord(manifest), 'upstream.jsonはオブジェクトです');
  assert(
    manifest.repository === upstreamRepository,
    `upstream.jsonのrepositoryは${upstreamRepository}です`,
  );
  assert(
    manifest.directory === upstreamDirectory,
    `upstream.jsonのdirectoryは${upstreamDirectory}です`,
  );
  assert(
    typeof manifest.commit === 'string' && /^[0-9a-f]{40}$/.test(manifest.commit),
    'upstream.jsonのcommitは40桁のフルhashです',
  );
  assert(isRecord(manifest.files), 'upstream.jsonのfilesはオブジェクトです');
  const hashes = new Map<string, string>();
  for (const [path, hash] of Object.entries(manifest.files)) {
    assert(
      typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
      `upstream.jsonのsha256が不正です: ${path}`,
    );
    hashes.set(path, hash);
  }
  assert(hashes.size > 0, 'upstream.jsonのfilesが空です');
  return { commit: manifest.commit, hashes };
}

function verify(root: string) {
  const { commit, hashes } = readRecordedHashes(root);
  const actual = bundledFiles(root);
  const problems = [
    ...[...hashes.keys()]
      .filter((path) => !actual.includes(path))
      .map((path) => `ファイルがありません: ${path}`),
    ...actual
      .filter((path) => !hashes.has(path))
      .map((path) => `upstream.jsonに記録がありません: ${path}`),
    ...actual
      .filter((path) => hashes.has(path))
      .filter((path) => sha256(readFileSync(join(root, path))) !== hashes.get(path))
      .map((path) => `sha256が一致しません: ${path}`),
  ];
  assert(problems.length === 0, problems.join('\n'));
  console.log(`同梱ファイル${actual.length}件が${upstreamRepository}@${commit}と一致します`);
}

function gitOutput(source: string, args: string[]) {
  const result = spawnSync('git', ['-C', source, ...args], { maxBuffer: 64 * 1024 * 1024 });
  assert(result.status === 0, `git ${args.join(' ')}: ${result.stderr?.toString()}`);
  return result.stdout;
}

function update(root: string, args: string[]) {
  assert(
    args.length === 4 && args[0] === '--source' && args[2] === '--commit',
    `update の引数が不正です\n${usage}`,
  );
  const [, source = '', , commit = ''] = args;
  const fullCommit = gitOutput(source, ['rev-parse', '--verify', `${commit}^{commit}`])
    .toString()
    .trim();
  const paths = gitOutput(source, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    fullCommit,
    upstreamDirectory,
  ])
    .toString()
    .split('\0')
    .filter(Boolean);
  const bodies = new Map(
    paths.map((path) => [
      path.slice(upstreamDirectory.length + 1),
      gitOutput(source, ['show', `${fullCommit}:${path}`]),
    ]),
  );
  assert(bodies.size > 0, `${fullCommit}に${upstreamDirectory}がありません`);
  assert(
    [...bodies.keys()].every((path) => bundledDirectories.includes(path.split('/')[0] ?? '')),
    `${upstreamDirectory}に同梱対象外のファイルがあります`,
  );
  for (const directory of bundledDirectories) {
    rmSync(join(root, directory), { recursive: true, force: true });
  }
  for (const [path, body] of bodies) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = Object.fromEntries(
    [...bodies]
      .map(([path, body]) => [path, sha256(body)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    join(root, 'upstream.json'),
    `${JSON.stringify(
      { repository: upstreamRepository, directory: upstreamDirectory, commit: fullCommit, files },
      null,
      2,
    )}\n`,
  );
  console.log(`${upstreamRepository}@${fullCommit}から${bodies.size}件を同梱しました`);
}

try {
  const root = resolve(skillDirectory);
  const [operation, ...args] = process.argv.slice(2);
  if (operation === undefined) {
    verify(root);
  } else {
    assert(operation === 'update', usage);
    update(root, args);
    verify(root);
  }
} catch (error) {
  console.error(
    `feedback-loopの同梱検査が未完了です: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
