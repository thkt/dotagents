import { researchContext } from './research-handoff.ts';
import type { ReportReference } from './input.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, lstat, realpath, rm, readlink } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { command } from '../shared/process.ts';
import { outside } from '../shared/values.ts';

const text = z.string().min(1).regex(/\S/);
const testReplyShape = z.strictObject({
  targetId: text,
  status: z.enum(['prepared', 'unnecessary', 'needs_human', 'needs_host']),
  findings: text,
  files: z.array(text),
});
export const testReplySchema = z.toJSONSchema(testReplyShape);
type Files = Record<string, string>;
export type TestRecord = {
  prefix: string;
  targetId: string;
  stdoutHash: string;
  files: Files;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function entries(cwd: string) {
  const result = await command(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    cwd,
    '',
    10000,
  );
  assert(result.code === 0 && !result.timedOut, 'テスト用の入力ファイルを取得できません');
  const files: Files = {};
  for (const path of new Set([...result.stdout.split('\0').filter(Boolean), '.dotagents.json'])) {
    const info = await lstat(resolve(cwd, path)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (info) {
      assert(info.isFile() || info.isSymbolicLink(), `テスト入力の種別が不正です: ${path}`);
      files[path] = hash(
        Buffer.concat([
          Buffer.from(`${info.mode}:`),
          info.isSymbolicLink()
            ? Buffer.from(await readlink(resolve(cwd, path)))
            : await readFile(resolve(cwd, path)),
        ]),
      );
    }
  }
  return files;
}

async function safePath(cwd: string, path: string, symbolic = false) {
  assert(
    !isAbsolute(path) &&
      path
        .split('/')
        .every((part) => part.length > 0 && !['.', '..', '.git', 'node_modules'].includes(part)),
    'テスト成果物のpathが不正です',
  );
  const target = resolve(cwd, path);
  assert(!outside(cwd, target), 'テスト成果物が作業場所の外を参照しています');
  await mkdir(dirname(target), { recursive: true });
  assert(
    (await realpath(dirname(target))) === dirname(target),
    'テスト成果物の親にsymlinkがあります',
  );
  const info = await lstat(target).catch(() => null);
  assert(
    !info || info.isFile() || (symbolic && info.isSymbolicLink()),
    'テスト成果物は通常ファイルに限ります',
  );
  return target;
}

// 実装開始前の入力を保存し、以降のテスト担当はこの版だけから開始します。
export async function prepareTestBaseline(cwd: string, baseline: string, io = command) {
  assert(outside(resolve(cwd), resolve(baseline)), 'テスト作業場所は実装checkoutの外に置きます');
  const cloned = await io(
    ['git', 'clone', '--no-hardlinks', '--local', cwd, baseline],
    cwd,
    '',
    660000,
  );
  assert(cloned.code === 0 && !cloned.timedOut, 'テスト用の修正前checkoutを準備できません');
  const original = await entries(cwd);
  for (const path of Object.keys(await entries(baseline))) {
    if (!(path in original)) {
      await rm(await safePath(baseline, path, true));
    }
  }
  for (const path of Object.keys(original)) {
    await rm(await safePath(baseline, path, true), { force: true });
    await cp(resolve(cwd, path), await safePath(baseline, path, true), { verbatimSymlinks: true });
  }
  const files = await entries(baseline);
  assert(
    JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) ===
      JSON.stringify(Object.entries(original).sort(([a], [b]) => a.localeCompare(b))),
    'テスト入力の複製が一致しません',
  );
  await writeFile(`${baseline}.json`, JSON.stringify({ files }, null, 2), { flag: 'wx' });
  return files;
}

export async function verifyTestArtifacts(cwd: string, records: TestRecord[]) {
  if (records.length === 0) {
    return;
  }
  const current = records.some((record) => Object.keys(record.files).length > 0)
    ? await entries(cwd)
    : {};
  await verifyTestManifest(current, records);
}

async function verifyTestManifest(current: Files, records: TestRecord[]) {
  const expected = z
    .record(z.string(), z.string())
    .parse(Object.assign({}, ...records.map((record) => record.files)));
  for (const [path, value] of Object.entries(expected)) {
    assert((current[path] ?? 'deleted') === value, `実装側でテスト成果物が変更されました: ${path}`);
  }
  for (const record of records) {
    assert(
      hash(await readFile(`${record.prefix}.stdout`)) === record.stdoutHash,
      'テスト応答が変更されました',
    );
  }
}

async function copyPreviousTests(
  source: string,
  cwd: string,
  previous: TestRecord[],
  current: Files,
) {
  const previousFiles = z
    .record(z.string(), z.string())
    .parse(Object.assign({}, ...previous.map((record) => record.files)));
  const transfers = Object.entries(previousFiles).filter(
    ([path, value]) => (current[path] ?? 'deleted') !== value,
  );
  if (transfers.length === 0) {
    return current;
  }
  for (const [path, value] of transfers) {
    const target = await safePath(cwd, path);
    if (value === 'deleted') {
      await rm(target, { force: true });
    } else {
      await cp(resolve(source, path), target);
    }
  }
  return entries(cwd);
}

async function testChanges(cwd: string, before: Files, reply: z.infer<typeof testReplyShape>) {
  const after = await entries(cwd);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (path) => before[path] !== after[path],
  );
  assert(
    new Set(reply.files).size === reply.files.length &&
      JSON.stringify([...reply.files].sort()) === JSON.stringify(changed.sort()),
    'テスト成果物と申告filesが一致しません',
  );
  assert(
    reply.status !== 'unnecessary' || changed.length === 0,
    'テスト不要の応答に変更があります',
  );
  return { after, changed };
}

async function installTestFiles(cwd: string, destination: string, changed: string[], after: Files) {
  const files: Files = Object.fromEntries(
    Object.entries(after).filter(([path]) =>
      /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/)|\.(?:test|spec)\./.test(path),
    ),
  );
  for (const path of changed) {
    if (after[path]) {
      assert(
        (await lstat(resolve(cwd, path))).isFile(),
        `テスト成果物は通常ファイルに限ります: ${path}`,
      );
    }
    await safePath(destination, path);
  }
  for (const path of changed) {
    const targetPath = await safePath(destination, path);
    if (after[path]) {
      await cp(resolve(cwd, path), targetPath);
    } else {
      await rm(targetPath, { force: true });
    }
    files[path] = after[path] ?? 'deleted';
  }
  return files;
}

export async function authorTests(
  input: {
    cwd: string;
    baseline: string;
    prefix: string;
    issue: string;
    baseCommit: string;
    check: string[];
    setup?: string[][];
    reports?: ReportReference[];
    evidence?: {
      source: string;
      command?: string[];
      code?: number | null;
      stdout: string;
      stderr?: string;
    }[];
    actor: string[];
    previous: TestRecord[];
    completed?: (result: Awaited<ReturnType<typeof command>>) => Promise<void>;
  },
  io = command,
) {
  const beforeImplementation = await entries(input.cwd);
  await verifyTestManifest(beforeImplementation, input.previous);
  const implementationBefore = JSON.stringify(
    Object.entries(beforeImplementation).sort(([a], [b]) => a.localeCompare(b)),
  );
  const baselineRecord = z
    .strictObject({ files: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(`${input.baseline}.json`, 'utf8')));
  assert(
    JSON.stringify(
      Object.entries(await entries(input.baseline)).sort(([a], [b]) => a.localeCompare(b)),
    ) ===
      JSON.stringify(Object.entries(baselineRecord.files).sort(([a], [b]) => a.localeCompare(b))),
    'テストの修正前入力が変更されました',
  );
  const cwd = `${input.prefix}-workspace`;
  const prepared = await prepareTestBaseline(input.baseline, cwd, io);
  // 前回のテストだけを渡し、実装checkoutの新コードや自己評価をコピーしません。
  const before = await copyPreviousTests(input.cwd, cwd, input.previous, prepared);
  const target = {
    issue: input.issue,
    baseCommit: input.baseCommit,
    baseline: baselineRecord.files,
    files: before,
    reports: input.reports ?? [],
    evidence: input.evidence ?? [],
    check: input.check,
    setup: input.setup ?? [],
  };
  const targetId = hash(JSON.stringify(target));
  await writeFile(`${input.prefix}.target.json`, JSON.stringify({ targetId, ...target }, null, 2), {
    flag: 'wx',
  });
  const prompt = [
    '合意済みIssueから今回必要なテストを判断し、必要な場合だけ作成・更新してください。実装とは別の新セッションです。',
    'AGENTS.mdと対象README・開発方針の関係する節、仕様・公開インターフェース、既存検証と実行方法を確認してください。修正前コードは不具合再現・接続・fixtureの確認に必要な範囲で読めます。',
    '入力にあるホストの実行証拠はテストの不足・接続不一致を診断する材料です。コマンド・対象版・終了と出力を読み、Issueと前回テストへ照合してください。実際の出力を期待値の根拠にせず、要求から期待結果を決めてください。実装担当の会話・判断・findingsや独立評価文は入力に含めません。',
    '新しい実装の説明・会話・判断・自己評価を期待値の根拠にしないでください。作業場所の外にある実装checkout・run記録や会話を読まないでください。Issueが参照する仕様は根拠と合意状態を照合し、未合意の要求を取り込まないでください。',
    '具体的な不具合、既存検証との差、正常な対照、失敗入力、要求から決まる期待結果、追加・維持・統合・削除の理由と費用、失う検出条件、残る検証・未確認の限界をfindingsに説明してください。テストごとの台帳は不要です。',
    '不具合再現では修正前の狙った失敗と正常対照を対象を絞った実行で確かめ、コマンド・結果・理由をfindingsに残してください。環境・ビルドの失敗をRedとしないでください。既存検証で十分な場合や失敗条件のない文書・内部整理ならunnecessaryで完了できます。全変更へのTDDや件数・カバレッジ維持は求めません。',
    '実装コードを変更しないでください。必要なテスト・fixture・接続定義の変更だけをfilesへ列挙してください。期待値と機械的な接続変更は区別し、期待値はIssueへ照合してください。前回テストの不足・誤りもこの別セッションで判断し、通すためだけに期待値を変更しないでください。',
    'commit・push・公開、ブラウザー・サーバー起動は禁止です。設定済み全体checkは後でホストが実行します。必要な受入検証が契約に含まれずホスト権限が必要ならneeds_host、要求・範囲・権限の変更は具体的な質問・選択肢・影響をfindingsに示してneeds_humanで止めてください。',
    'targetIdをそのまま返し、status: prepared | unnecessary | needs_human | needs_host、空白以外のfindings、変更したfilesの配列を含むJSONだけを返してください。unnecessaryではfilesは空配列です。',
    `入力: ${JSON.stringify({ targetId, baseCommit: input.baseCommit, check: input.check, setup: input.setup ?? [] })}`,
    `ホスト実行証拠: ${JSON.stringify(input.evidence ?? [])}`,
    `要求:\n${input.issue}`,
    researchContext(input.baseCommit, input.reports),
  ].join('\n');
  await writeFile(`${input.prefix}.prompt`, prompt, { flag: 'wx' });
  const result = await io(input.actor, cwd, prompt, null, input.prefix, {
    ...process.env,
    DOTAGENTS_ACTOR_PREFIX: input.prefix,
  });
  await input.completed?.(result);
  await writeFile(
    `${input.prefix}.execution.json`,
    JSON.stringify({ code: result.code, timedOut: result.timedOut, ms: result.ms }),
    { flag: 'wx' },
  );
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`テスト工程が失敗しました: ${input.prefix}: ${result.stderr}`, {
      cause: 'test_failed',
    });
  }
  const afterImplementation = await entries(input.cwd);
  assert(
    implementationBefore ===
      JSON.stringify(Object.entries(afterImplementation).sort(([a], [b]) => a.localeCompare(b))),
    'テスト工程中に実装checkoutが変更されました',
  );
  const reply = testReplyShape.parse(JSON.parse(result.stdout));
  assert(reply.targetId === targetId, 'テスト応答の入力が一致しません');
  const { after, changed } = await testChanges(cwd, before, reply);
  if (reply.status === 'needs_human' || reply.status === 'needs_host') {
    await writeFile(
      `${input.prefix}.json`,
      JSON.stringify(
        {
          targetId,
          status: reply.status,
          findings: reply.findings,
          pendingFiles: Object.fromEntries(changed.map((path) => [path, after[path] ?? 'deleted'])),
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    return { reply, result };
  }
  await verifyTestManifest(afterImplementation, input.previous);
  const files = await installTestFiles(cwd, input.cwd, changed, after);
  const record = { prefix: input.prefix, targetId, stdoutHash: hash(result.stdout), files };
  await writeFile(
    `${input.prefix}.json`,
    JSON.stringify({ ...record, status: reply.status, findings: reply.findings }, null, 2),
    { flag: 'wx' },
  );
  return { reply, result, record };
}
