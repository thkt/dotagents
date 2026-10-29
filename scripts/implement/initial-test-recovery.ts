import assert from 'node:assert/strict';
import { verifyInitialTestActor } from './initial-test-actor.ts';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  initialTestRecords,
  verifyInitialTestReturn,
  unusedTestReturn,
} from './initial-test-records.ts';
import {
  testAuthorPrompt,
  testInputFiles,
  testReplyShape,
  verifyTestBaseline,
} from './test-author.ts';
import { hash, recordText } from './record-observation.ts';
import { assertReportReferences } from './input.ts';
import { command } from '../shared/process.ts';
import { isRecord } from '../shared/values.ts';
import { targetCommand } from '../shared/target.ts';
import type { readTarget } from '../shared/target.ts';

const targetShape = z.strictObject({
  targetId: z.string().regex(/^[a-f0-9]{64}$/),
  issue: z.string(),
  stage: z.literal('initial'),
  revisionRequest: z.null(),
  baseCommit: z.string(),
  baseline: z.record(z.string(), z.string()),
  files: z.record(z.string(), z.string()),
  reports: z.array(z.unknown()),
  evidence: z.array(z.unknown()).length(0),
  check: z.array(z.string()),
  feedbackCheck: z.array(z.string()).optional(),
  setup: z.array(z.array(z.string())),
});
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (value: Record<string, string>) =>
  Object.entries(value).sort(([a], [b]) => a.localeCompare(b));

export async function previousTestRun(input: {
  directory?: string;
  runDirectory?: string;
  cwd: string;
  issue: string;
  original: string;
  head: string;
  target: Awaited<ReturnType<typeof readTarget>>;
  localOnly: boolean;
}) {
  if (!input.directory) {
    return undefined;
  }
  const currentBranch = await command(['git', 'branch', '--show-current'], input.cwd, '', 10000);
  assert(currentBranch.code === 0 && !currentBranch.timedOut, '現在のbranchを照合できません');
  const branchName = currentBranch.stdout.trim();
  assert(input.runDirectory, '初回テスト復帰には新しい--run-dirが必要です');
  const dir = await realpath(input.directory);
  const runDirectory = resolve(input.runDirectory);
  assert(
    dir !== runDirectory && dirname(dir) === dirname(runDirectory),
    '新runは旧runと同じ親の別保存先が必要です',
  );
  const records = await initialTestRecords(dir);
  const text = (name: string) => recordText(join(dir, name));
  const result: unknown = JSON.parse(await text('result.json'));
  assert(isRecord(result), '旧runの結果が不正です');
  assert(
    result.terminal === true &&
      result.status === 'stopped' &&
      result.phase === 'implementation' &&
      result.operation === 'independent test authoring' &&
      result.reason === 'テスト応答の入力が一致しません' &&
      result.publication === 'not_attempted' &&
      !result.url &&
      !result.commit,
    '復帰対象は未公開・初回実装前の初回テストID不一致だけです',
  );
  for (const path of Object.keys(records)) {
    const relative = path.slice(dir.length + 1);
    assert(
      !/^(?:test-(?!1(?:[.-]|$))\d+|implementation(?:[./-]|$)|verification(?:\/|$)|test-records\.json$|test-1\.json$|host-|review-return|initial-test-return|revision-request|recovery-)/.test(
        relative,
      ),
      '実装・有効な判断・評価履歴・復帰履歴のあるrunには流用できません',
    );
  }
  assert(
    result.checkout === input.cwd &&
      result.evidence === dir &&
      result.startCommit === input.head &&
      result.branch === branchName &&
      result.repository === input.target.config.repository &&
      result.issue === `https://github.com/${input.target.config.repository}/issues/${input.issue}`,
    '旧runのcheckout・HEAD・branch・要求の対象が一致しません',
  );
  assert(
    typeof result.localOnly === 'boolean' && (!result.localOnly || input.localOnly),
    '復帰で公開権限を拡大できません',
  );
  const savedTarget: unknown = JSON.parse(await text('target.json'));
  assert(
    isRecord(savedTarget) &&
      savedTarget.text === input.target.text &&
      equal(savedTarget.config, input.target.config) &&
      savedTarget.actor === input.target.actor &&
      savedTarget.repositoryId === input.target.repositoryId,
    '旧runの設定・実効主体が一致しません',
  );
  assert((await text('issue.json')) === input.original, '合意済みIssueが変わりました');
  const target = targetShape.parse(JSON.parse(await text('test-1.target.json')));
  const { targetId, ...payload } = target;
  assert(targetId === hash(JSON.stringify(payload)), '旧テスト入力IDが一致しません');
  const reports = target.reports;
  assertReportReferences(reports);
  assert(
    target.issue === input.original &&
      target.baseCommit === input.head &&
      equal(target.check, targetCommand(input.target.config.check)) &&
      equal(
        target.feedbackCheck,
        input.target.config.feedbackCheck
          ? targetCommand(input.target.config.feedbackCheck)
          : undefined,
      ) &&
      equal(target.setup, input.target.config.setup.map(targetCommand)),
    '旧テストの要求・開始版・実行契約が一致しません',
  );
  const baseline = await verifyTestBaseline(join(dir, 'test-baseline'));
  assert(
    equal(sorted(baseline.files), sorted(target.baseline)) &&
      equal(sorted(target.files), sorted(target.baseline)),
    '旧入力manifestが一致しません',
  );
  assert(
    equal(sorted(await testInputFiles(input.cwd)), sorted(baseline.files)),
    '停止時の成果物・モードが変わりました',
  );
  const prompt = await text('test-1.prompt');
  // 旧ハーネスの配置だけは旧指示から取り出す。参照先を実行・読取りせず、
  // 全文を同じテンプレートへ照合して任意の指示変更を受け入れない。
  const harnessRoot =
    /^信頼するハーネスの機械化の共通手順: (.+)\/skills\/references\/mechanization\.md。/m.exec(
      prompt,
    )?.[1];
  assert(harnessRoot && isAbsolute(harnessRoot), '旧ハーネスの指示参照を照合できません');
  const promptInput = { ...target, reports, revisionRequest: undefined };
  const expectedPrompts = [
    testAuthorPrompt(targetId, promptInput, harnessRoot),
    testAuthorPrompt(targetId, promptInput, harnessRoot, baseline.files),
  ];
  assert(expectedPrompts.includes(prompt), '旧テストの指示が一致しません');
  const execution = z
    .strictObject({ code: z.literal(0), timedOut: z.literal(false), ms: z.number().nonnegative() })
    .parse(JSON.parse(await text('test-1.execution.json')));
  const stdout = await text('test-1.stdout');
  const reply = testReplyShape.parse(JSON.parse(stdout));
  await verifyInitialTestActor(dir, stdout);
  assert(
    reply.targetId !== targetId && execution.code === 0,
    '初回テストのID不一致を確認できません',
  );
  await verifyUnusedWorkspace(dir, baseline.files, reply);
  await text('test-1.stderr');
  const branch = await command(
    ['git', 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
    input.cwd,
    '',
    10000,
  );
  assert(
    branch.code === 0 &&
      !branch.timedOut &&
      equal(branch.stdout.trim().split(/\r?\n/), [input.head, `refs/heads/${branchName}`]),
    '旧checkoutのHEAD・branchが一致しません',
  );
  const returned = {
    previousRun: dir,
    cwd: input.cwd,
    branch: branchName,
    head: input.head,
    targetText: input.target.text,
    actor: [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'test', dir],
    records,
  };
  await unusedTestReturn(dir, runDirectory);
  await verifyInitialTestReturn(returned, runDirectory);
  return { dir, returned, reports, baseline: join(dir, 'test-baseline'), branch: branchName };
}

async function verifyUnusedWorkspace(
  dir: string,
  baseline: Record<string, string>,
  reply: z.infer<typeof testReplyShape>,
) {
  const workspace = join(dir, 'test-1-workspace');
  const saved = z
    .strictObject({ files: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(`${workspace}.json`, 'utf8')));
  assert(equal(sorted(saved.files), sorted(baseline)), '未採用workspaceの開始manifestが不一致です');
  const current = await testInputFiles(workspace);
  const changed = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].filter(
    (path) => baseline[path] !== current[path],
  );
  // 不正IDの判断・成果物は採用せず、原応答への対応と保全だけを確認する。
  assert(
    new Set(reply.files).size === reply.files.length &&
      equal([...reply.files].sort(), changed.sort()) &&
      (reply.status !== 'unnecessary' || changed.length === 0),
    '未採用workspaceの成果物を照合できません',
  );
}
