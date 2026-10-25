import type { FixedSupplement } from './human-decision-schema.ts';
import { supplementContext, verifySupplement } from './supplement.ts';
import { researchContext } from './research-handoff.ts';
import type { ReportReference } from './input.ts';
import type { TestDiagnostic } from './test-diagnostics.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, lstat, realpath, rm, readlink } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { RecordObservation } from './record-observation.ts';
import { command } from '../shared/process.ts';
import { outside } from '../shared/values.ts';

const text = z.string().min(1).regex(/\S/);
export const testReplyShape = z.strictObject({
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
  inputHash?: string;
  promptHash?: string;
};
export interface TestIntake {
  manifest: Record<string, string>;
  records: RecordObservation;
}

export function testRecordPaths(records: TestRecord[]) {
  const paths = [];
  for (const record of records) {
    paths.push(`${record.prefix}.stdout`);
    if (record.inputHash) {
      paths.push(`${record.prefix}.target.json`);
    }
    if (record.promptHash) {
      paths.push(`${record.prefix}.prompt`);
    }
  }
  return paths;
}

async function readTestRecord(path: string, observation?: RecordObservation) {
  if (observation) {
    return observation.read(path);
  }
  const content = await readFile(path);
  return { content, sha256: hash(content) };
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const isTestArtifact = (path: string) =>
  /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/)|\.(?:test|spec)\./.test(path);

export async function testInputFiles(cwd: string) {
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
  const original = await testInputFiles(cwd);
  for (const path of Object.keys(await testInputFiles(baseline))) {
    if (!(path in original)) {
      await rm(await safePath(baseline, path, true));
    }
  }
  for (const path of Object.keys(original)) {
    await rm(await safePath(baseline, path, true), { force: true });
    await cp(resolve(cwd, path), await safePath(baseline, path, true), { verbatimSymlinks: true });
  }
  const files = await testInputFiles(baseline);
  assert(
    JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) ===
      JSON.stringify(Object.entries(original).sort(([a], [b]) => a.localeCompare(b))),
    'テスト入力の複製が一致しません',
  );
  await writeFile(`${baseline}.json`, JSON.stringify({ files }, null, 2), { flag: 'wx' });
  return files;
}

export async function verifyTestArtifacts(
  cwd: string,
  records: TestRecord[],
  observedManifest?: Files,
  observation?: RecordObservation,
) {
  if (records.length === 0) {
    return;
  }
  const current =
    observedManifest ??
    (records.some((record) => Object.keys(record.files).length > 0)
      ? await testInputFiles(cwd)
      : {});
  observation?.retain(testRecordPaths(records));
  return verifyTestManifest(current, records, observation);
}

// ホストが別の独立テスト工程で準備した資産だけを新しい工程へ渡します。
export async function readPreparedTestRecord(
  content: string,
  issue: string,
  cwd: string,
  intake?: TestIntake,
): Promise<TestRecord> {
  const record = z
    .strictObject({
      prefix: text.refine(isAbsolute),
      targetId: text,
      stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
      files: z.record(text, text),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      promptHash: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(['prepared', 'unnecessary']),
      findings: text,
    })
    .parse(JSON.parse(content));
  intake?.records.retain([`${record.prefix}.json`, ...testRecordPaths([record])]);
  assert(
    outside(cwd, await realpath(record.prefix + '.json')),
    'テスト記録はcheckoutの外に置きます',
  );
  assert(
    (await readTestRecord(record.prefix + '.json', intake?.records)).content.toString('utf8') ===
      content,
    '元のテスト記録と参照が一致しません',
  );
  const [observed] =
    (await verifyTestArtifacts(cwd, [record], intake?.manifest, intake?.records)) ?? [];
  assert(observed?.input, '準備済みテストの検証済み入力がありません');
  const reply = testReplyShape.parse(JSON.parse(observed.stdout.toString('utf8')));
  const target = z
    .object({ targetId: text, issue: text, files: z.record(text, text) })
    .parse(JSON.parse(observed.input.toString('utf8')));
  assert(
    reply.targetId === record.targetId &&
      target.targetId === record.targetId &&
      target.issue === issue &&
      reply.status === record.status &&
      reply.findings === record.findings,
    '準備済みテストの応答・入力・固定Issueが一致しません',
  );
  const changed = [
    ...new Set([...Object.keys(record.files), ...Object.keys(target.files).filter(isTestArtifact)]),
  ].filter((path) => (target.files[path] ?? 'deleted') !== (record.files[path] ?? 'deleted'));
  assert(
    reply.files.every((path) => Object.hasOwn(record.files, path)) &&
      JSON.stringify([...reply.files].sort()) === JSON.stringify(changed.sort()),
    '準備済みテストの原応答と成果物申告の由来が一致しません',
  );
  return {
    prefix: record.prefix,
    targetId: record.targetId,
    stdoutHash: record.stdoutHash,
    files: record.files,
    inputHash: record.inputHash,
    promptHash: record.promptHash,
  };
}

async function verifyTestManifest(
  current: Files,
  records: TestRecord[],
  observation?: RecordObservation,
) {
  const expected = z
    .record(z.string(), z.string())
    .parse(Object.assign({}, ...records.map((record) => record.files)));
  for (const [path, value] of Object.entries(expected)) {
    assert((current[path] ?? 'deleted') === value, `実装側でテスト成果物が変更されました: ${path}`);
  }
  const observations = [];
  for (const record of records) {
    const stdout = await readTestRecord(`${record.prefix}.stdout`, observation);
    assert(stdout.sha256 === record.stdoutHash, 'テスト応答が変更されました');
    const input = record.inputHash
      ? await readTestRecord(`${record.prefix}.target.json`, observation)
      : undefined;
    if (input) {
      assert(input.sha256 === record.inputHash, '保存テスト入力が変更されました');
    }
    if (record.promptHash) {
      assert(
        (await readTestRecord(`${record.prefix}.prompt`, observation)).sha256 === record.promptHash,
        '保存テスト指示が変更されました',
      );
    }
    observations.push({ stdout: stdout.content, input: input?.content });
  }
  return observations;
}

export async function verifyTestBaseline(baseline: string) {
  const record = z
    .strictObject({ files: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(`${baseline}.json`, 'utf8')));
  assert(
    JSON.stringify(
      Object.entries(await testInputFiles(baseline)).sort(([a], [b]) => a.localeCompare(b)),
    ) === JSON.stringify(Object.entries(record.files).sort(([a], [b]) => a.localeCompare(b))),
    'テストの修正前入力が変更されました',
  );
  return record;
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
  return testInputFiles(cwd);
}

async function testChanges(cwd: string, before: Files, reply: z.infer<typeof testReplyShape>) {
  const after = await testInputFiles(cwd);
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
    Object.entries(after).filter(([path]) => isTestArtifact(path)),
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
    stage: 'initial' | 'revision' | 'correction' | 'host_return';
    revisionRequest?: string;
    supplement?: FixedSupplement;
    baseCommit: string;
    check: string[];
    setup?: string[][];
    reports?: ReportReference[];
    diagnostics?: TestDiagnostic[];
    observedManifest?: Files;
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
  await verifySupplement(input.supplement);
  const beforeImplementation = input.observedManifest ?? (await testInputFiles(input.cwd));
  await verifyTestManifest(beforeImplementation, input.previous);
  const implementationBefore = JSON.stringify(
    Object.entries(beforeImplementation).sort(([a], [b]) => a.localeCompare(b)),
  );
  const baselineRecord = await verifyTestBaseline(input.baseline);
  const cwd = `${input.prefix}-workspace`;
  const prepared = await prepareTestBaseline(input.baseline, cwd, io);
  // 前回のテストだけを渡し、実装checkoutの新コードや自己評価をコピーしません。
  const before = await copyPreviousTests(input.cwd, cwd, input.previous, prepared);
  const target = {
    issue: input.issue,
    stage: input.stage,
    ...(input.supplement ? { supplement: input.supplement.agreement } : {}),
    revisionRequest: input.revisionRequest ?? null,
    baseCommit: input.baseCommit,
    baseline: baselineRecord.files,
    files: before,
    reports: input.reports ?? [],
    evidence: input.evidence ?? [],
    check: input.check,
    setup: input.setup ?? [],
    ...(input.diagnostics?.length ? { diagnostics: input.diagnostics } : {}),
  };
  const targetId = hash(JSON.stringify(target));
  const targetText = JSON.stringify({ targetId, ...target }, null, 2);
  await writeFile(`${input.prefix}.target.json`, targetText, {
    flag: 'wx',
  });
  const prompt = testPrompt({ ...input, baseline: baselineRecord.files }, targetId);
  await writeFile(`${input.prefix}.prompt`, prompt, { flag: 'wx' });
  const result = await io(input.actor, cwd, prompt, null, input.prefix, {
    ...process.env,
    DOTAGENTS_ACTOR_PREFIX: input.prefix,
  });
  await writeFile(
    `${input.prefix}.execution.json`,
    JSON.stringify({ code: result.code, timedOut: result.timedOut, ms: result.ms }),
    { flag: 'wx' },
  );
  await input.completed?.(result);
  await verifySupplement(input.supplement);
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`テスト工程が失敗しました: ${input.prefix}: ${result.stderr}`, {
      cause: 'test_failed',
    });
  }
  const afterImplementation = await testInputFiles(input.cwd);
  assert(
    implementationBefore ===
      JSON.stringify(Object.entries(afterImplementation).sort(([a], [b]) => a.localeCompare(b))),
    'テスト工程中に実装checkoutが変更されました',
  );
  const reply = testReplyShape.parse(JSON.parse(result.stdout));
  assert(reply.targetId === targetId, 'テスト応答の入力が一致しません');
  assert(
    (await readFile(`${input.prefix}.target.json`, 'utf8')) === targetText,
    '保存テスト入力・診断が変更されました',
  );
  assert(
    (await readFile(`${input.prefix}.prompt`, 'utf8')) === prompt,
    '保存テスト指示が変更されました',
  );
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
  const record = {
    prefix: input.prefix,
    targetId,
    stdoutHash: hash(result.stdout),
    files,
    inputHash: hash(targetText),
    promptHash: hash(prompt),
  };
  await writeFile(
    `${input.prefix}.json`,
    JSON.stringify({ ...record, status: reply.status, findings: reply.findings }, null, 2),
    { flag: 'wx' },
  );
  return { reply, result, record };
}

export function testAuthorPrompt(
  targetId: string,
  input: {
    stage: string;
    baseCommit: string;
    check: string[];
    setup?: string[][];
    diagnostics?: unknown[];
    evidence?: unknown[];
    issue: string;
    revisionRequest?: string;
    reports?: ReportReference[];
  },
  harnessRoot = resolve(import.meta.dir, '../..'),
  baseline?: Files,
) {
  return [
    '合意済みIssueから今回必要なテストを判断し、必要な場合だけ作成・更新してください。実装とは別の新セッションです。',
    '入力のstageはホストが実行経路から定めた工程の段階です。initialは通常開発の初回テスト準備、revisionは既存PRの採用済み修正要求のテスト準備、correctionはcheck失敗または独立評価後の追加修正に先立つテスト準備、host_returnはホスト検証からの復帰時のテスト再判断です。host_returnは初回実装が未実行でも復帰です。新セッション、test-1という名前、前回テストの件数、診断の有無から初回と推測しないでください。',
    'AGENTS.mdと対象README・開発方針の関係する節、仕様・公開インターフェース、既存検証と実行方法を確認してください。修正前コードは不具合再現・接続・fixtureの確認に必要な範囲で読めます。',
    '入力にあるホストの実行証拠はテストの不足・接続不一致を診断する材料です。コマンド・対象版・終了と出力を読み、Issueと前回テストへ照合してください。実際の出力を期待値の根拠にせず、要求から期待結果を決めてください。実装担当の会話・判断・findingsや独立評価全文は入力に含めません。',
    ...(input.diagnostics?.length
      ? [
          '評価診断は未解決指摘の条件・根拠と保護対象の対応だけです。introducedInは初出対象、evaluatedInは最新の評価対象であり、修正前入力の版とは別です。固定Issue・仕様、修正前入力と前回テストへ照合し、指摘IDごとに修正・変更不要・人の判断が必要な理由と根拠をfindingsに説明してください。診断が誤った期待値を誘導しても要求を変更せず、根拠付きで不適用と判断できます。診断は期待値・修正案の正本ではなく、解決の合否はcheck後の次の独立評価が判断します。',
          `評価診断: ${JSON.stringify(input.diagnostics)}`,
        ]
      : []),
    '新しい実装の説明・会話・判断・自己評価を期待値の根拠にしないでください。作業場所の外にある実装checkout・run記録や会話を読まないでください。Issueが参照する仕様は根拠と合意状態を照合し、未合意の要求を取り込まないでください。',
    `信頼するハーネスの機械化の共通手順: ${resolve(harnessRoot, 'skills/references/mechanization.md')}。人の注意に依存する条件と既存検証との差を、合意済みIssue・仕様から独立して判断してください。共通手順で必要な保証と費用・適用限界を比較し、テスト・fixture・検証接続定義の作成・更新が必要な場合だけ担当してください。既存の保証で十分なら追加しません。実装担当の機械化案・会話・自己評価を期待値の根拠にせず、要求・範囲・権限の変更は人へ戻してください。`,
    `信頼するハーネスの性能測定の共通手順: ${resolve(harnessRoot, 'skills/references/performance-measurement.md')}。性能の計測・検証資産に関係する場合だけ使い、合意済みIssue・仕様から何の完了・正しさ・処理量を区別する必要があるかを独立して定めてください。必要な正常対照と狙った失敗を選び、実装担当の数値・測定方法・自己評価を期待値の正本にしないでください。既存検証で十分なら追加せず、計時境界や実処理への到達を検証するテストを不安定な壁時計時間の閾値で代用しないでください。適用外には資料全文の読込みや定型報告を要求せず、既存の入力境界を維持してください。`,
    `信頼するハーネスの設計・選定手順: ${resolve(harnessRoot, 'skills/implement/references/testing.md')}。「検証命題とケースの設計手順」を読み、対象repoの方針と併せて、観点→命題と必要条件・判定基準→ケースと独立した判定根拠→採用・維持・統合・省略の順に照合してください。対応と選定理由、未充足・未確認事項は既存のfindingsへ残し、設計上の被覆と対象版・環境・入力に対応する実行結果を区別してください。必須検証を省略せず、既存検証で十分なら追加しません。分類表・台帳・数式化は一律に求めません。`,
    '具体的な不具合、既存検証との差、正常な対照、失敗入力、要求から決まる期待結果、追加・維持・統合・削除の理由と費用、失う検出条件、残る検証・未確認の限界をfindingsに説明してください。テストごとの台帳は不要です。',
    '不具合再現では修正前の狙った失敗と正常対照を対象を絞った実行で確かめ、コマンド・結果・理由をfindingsに残してください。環境・ビルドの失敗をRedとしないでください。既存検証で十分な場合や失敗条件のない文書・内部整理ならunnecessaryで完了できます。全変更へのTDDや件数・カバレッジ維持は求めません。',
    '実装コードを変更しないでください。必要なテスト・fixture・接続定義の変更だけをfilesへ列挙してください。期待値と機械的な接続変更は区別し、期待値はIssueへ照合してください。前回テストの不足・誤りもこの別セッションで判断し、通すためだけに期待値を変更しないでください。',
    'commit・push・公開、ブラウザー・サーバー起動は禁止です。statusは独立テストの準備状態です。必要な資産が準備できればprepared、既存検証で十分ならunnecessaryです。設定済み全体checkとIssue全体の受入は後でホストと独立評価が確認します。その実行待ちだけでneeds_hostにしないでください。テストの準備に必要な未解決のホスト作業・入力がある場合はneeds_hostとして不足を具体的に示してください。要求・範囲・権限の変更は質問・選択肢・影響をfindingsに示してneeds_humanで止めてください。未確認の受入条件と限界はfindingsへ残し、成功扱いしないでください。',
    'targetIdをそのまま返し、status: prepared | unnecessary | needs_human | needs_host、空白以外のfindings、変更したfilesの配列を含むJSONだけを返してください。unnecessaryではfilesは空配列です。',
    `入力: ${JSON.stringify({ targetId, stage: input.stage, baseCommit: input.baseCommit, ...(baseline ? { baseline } : {}), check: input.check, setup: input.setup ?? [] })}`,
    `ホスト実行証拠: ${JSON.stringify(input.evidence ?? [])}`,
    `要求:\n${input.issue}`,
    ...(input.revisionRequest ? [`人が採用した固定の修正要求:\n${input.revisionRequest}`] : []),
    researchContext(input.baseCommit, input.reports),
  ].join('\n');
}

export function testPrompt(
  input: {
    issue: string;
    stage: string;
    baseCommit: string;
    baseline: Files;
    check: string[];
    setup?: string[][];
    reports?: ReportReference[];
    diagnostics?: unknown[];
    evidence?: unknown[];
    revisionRequest?: string;
    supplement?: FixedSupplement;
  },
  targetId: string,
  harnessRoot = resolve(import.meta.dir, '../..'),
  legacy = false,
) {
  if (!input.supplement) {
    return testAuthorPrompt(targetId, input, harnessRoot, input.baseline);
  }
  return [
    '合意済みIssueから今回必要なテストを判断し、必要な場合だけ作成・更新してください。実装とは別の新セッションです。',
    '入力のstageはホストが実行経路から定めた工程の段階です。initialは通常開発の初回テスト準備、revisionは既存PRの採用済み修正要求のテスト準備、correctionはcheck失敗または独立評価後の追加修正に先立つテスト準備、host_returnはホスト検証からの復帰時のテスト再判断です。host_returnは初回実装が未実行でも復帰です。新セッション、test-1という名前、前回テストの件数、診断の有無から初回と推測しないでください。',
    'AGENTS.mdと対象README・開発方針の関係する節、仕様・公開インターフェース、既存検証と実行方法を確認してください。修正前コードは不具合再現・接続・fixtureの確認に必要な範囲で読めます。',
    '入力にあるホストの実行証拠はテストの不足・接続不一致を診断する材料です。コマンド・対象版・終了と出力を読み、Issueと前回テストへ照合してください。実際の出力を期待値の根拠にせず、要求から期待結果を決めてください。実装担当の会話・判断・findingsや独立評価全文は入力に含めません。',
    ...(input.diagnostics?.length
      ? [
          '評価診断は未解決指摘の条件・根拠と保護対象の対応だけです。introducedInは初出対象、evaluatedInは最新の評価対象であり、修正前入力の版とは別です。固定Issue・仕様、修正前入力と前回テストへ照合し、指摘IDごとに修正・変更不要・人の判断が必要な理由と根拠をfindingsに説明してください。診断が誤った期待値を誘導しても要求を変更せず、根拠付きで不適用と判断できます。診断は期待値・修正案の正本ではなく、解決の合否はcheck後の次の独立評価が判断します。',
          `評価診断: ${JSON.stringify(input.diagnostics)}`,
        ]
      : []),
    '新しい実装の説明・会話・判断・自己評価を期待値の根拠にしないでください。作業場所の外にある実装checkout・run記録や会話を読まないでください。Issueが参照する仕様は根拠と合意状態を照合し、未合意の要求を取り込まないでください。',
    `信頼するハーネスの機械化の共通手順: ${resolve(harnessRoot, 'skills/references/mechanization.md')}。人の注意に依存する条件と既存検証との差を、合意済みIssue・仕様から独立して判断してください。共通手順で必要な保証と費用・適用限界を比較し、テスト・fixture・検証接続定義の作成・更新が必要な場合だけ担当してください。既存の保証で十分なら追加しません。実装担当の機械化案・会話・自己評価を期待値の根拠にせず、要求・範囲・権限の変更は人へ戻してください。`,
    `信頼するハーネスの性能測定の共通手順: ${resolve(harnessRoot, 'skills/references/performance-measurement.md')}。性能の計測・検証資産に関係する場合だけ使い、合意済みIssue・仕様から何の完了・正しさ・処理量を区別する必要があるかを独立して定めてください。必要な正常対照と狙った失敗を選び、実装担当の数値・測定方法・自己評価を期待値の正本にしないでください。既存検証で十分なら追加せず、計時境界や実処理への到達を検証するテストを不安定な壁時計時間の閾値で代用しないでください。適用外には資料全文の読込みや定型報告を要求せず、既存の入力境界を維持してください。`,
    `信頼するハーネスの設計・選定手順: ${resolve(harnessRoot, 'skills/implement/references/testing.md')}。「検証命題とケースの設計手順」を読み、対象repoの方針と併せて、観点→命題と必要条件・判定基準→ケースと独立した判定根拠→採用・維持・統合・省略の順に照合してください。対応と選定理由、未充足・未確認事項は既存のfindingsへ残し、設計上の被覆と対象版・環境・入力に対応する実行結果を区別してください。必須検証を省略せず、既存検証で十分なら追加しません。分類表・台帳・数式化は一律に求めません。`,
    '具体的な不具合、既存検証との差、正常な対照、失敗入力、要求から決まる期待結果、追加・維持・統合・削除の理由と費用、失う検出条件、残る検証・未確認の限界をfindingsに説明してください。テストごとの台帳は不要です。',
    '不具合再現では修正前の狙った失敗と正常対照を対象を絞った実行で確かめ、コマンド・結果・理由をfindingsに残してください。環境・ビルドの失敗をRedとしないでください。既存検証で十分な場合や失敗条件のない文書・内部整理ならunnecessaryで完了できます。全変更へのTDDや件数・カバレッジ維持は求めません。',
    '実装コードを変更しないでください。必要なテスト・fixture・接続定義の変更だけをfilesへ列挙してください。期待値と機械的な接続変更は区別し、期待値はIssueへ照合してください。前回テストの不足・誤りもこの別セッションで判断し、通すためだけに期待値を変更しないでください。',
    'commit・push・公開、ブラウザー・サーバー起動は禁止です。statusは独立テストの準備状態です。必要な資産が準備できればprepared、既存検証で十分ならunnecessaryです。設定済み全体checkとIssue全体の受入は後でホストと独立評価が確認します。その実行待ちだけでneeds_hostにしないでください。テストの準備に必要な未解決のホスト作業・入力がある場合はneeds_hostとして不足を具体的に示してください。要求・範囲・権限の変更は質問・選択肢・影響をfindingsに示してneeds_humanで止めてください。未確認の受入条件と限界はfindingsへ残し、成功扱いしないでください。',
    'targetIdをそのまま返し、status: prepared | unnecessary | needs_human | needs_host、空白以外のfindings、変更したfilesの配列を含むJSONだけを返してください。unnecessaryではfilesは空配列です。',
    `入力: ${JSON.stringify({ targetId, stage: input.stage, baseCommit: input.baseCommit, ...(legacy ? { baseline: input.baseline } : {}), check: input.check, setup: input.setup ?? [] })}`,
    `ホスト実行証拠: ${JSON.stringify(input.evidence ?? [])}`,
    `要求:\n${input.issue}`,
    ...(input.revisionRequest ? [`人が採用した固定の修正要求:\n${input.revisionRequest}`] : []),
    researchContext(input.baseCommit, input.reports),
    ...(legacy ? [] : [supplementContext(input.supplement)]),
  ].join('\n');
}
