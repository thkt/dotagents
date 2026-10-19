import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { isRecord } from '../scripts/shared/values.ts';
import type { EvalConfig } from './data.ts';

type ActorConfig = Pick<
  EvalConfig,
  'before' | 'after' | 'trialOrder' | 'workspaceCommit' | 'model' | 'reasoning'
>;

const trusted = {
  before: 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092',
  after: '6181233d17a29c711a84f20549f78507c5c3e5fb',
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  assert(from >= 0 && source.indexOf(start, from + start.length) < 0, 'Ambiguous trusted source');
  const to = source.indexOf(end, from + start.length);
  assert(to >= 0, 'Unsupported trusted source');
  return source.slice(from + start.length, to);
}

// 固定commitの指定した式だけを評価する。対象workspaceのTSや任意版は実行しない。
function expression(source: string, bindings: Record<string, unknown>): unknown {
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `globalThis.__evalResult = (${source})`,
  );
  return runInNewContext(js, bindings, { timeout: 1000 }) as unknown;
}

export async function initialActorSources(
  config: ActorConfig,
  read: (path: string) => Promise<string>,
) {
  assert(
    config.before === trusted.before && config.after === trusted.after,
    'Initial actor requires the trusted instruction commits',
  );
  assert(config.trialOrder, 'Initial actor requires the fixed paired order');
  const sources: Record<string, { body: string; sha256: string }> = {};
  for (const path of [
    'scripts/implement/repair.ts',
    'scripts/implement/orchestrator.ts',
    'scripts/implement/codex-actor.ts',
    'scripts/implement/research-handoff.ts',
    'scripts/implement/review.ts',
  ]) {
    const body = await read(path);
    sources[path] = { body, sha256: hash(body) };
  }
  return sources;
}

// 条件ごとの固定入力を一度準備し、課題別のpromptと記録だけを生成する。
export function prepareInitialActorInput(
  config: ActorConfig,
  files: Record<string, string>,
  sources: Awaited<ReturnType<typeof initialActorSources>>,
  destination = '/work/repo',
) {
  const source = (path: string) => {
    const entry = sources[`scripts/implement/${path}.ts`];
    assert(entry, 'Missing trusted source');
    return entry.body;
  };
  const root = destination;
  assert(posix.isAbsolute(root) && !root.includes('\n'), 'Absolute actor destination required');
  const dir = posix.join(root, 'actor-records');
  const repair = between(
    source('repair'),
    'export function repairInstructions(capture: { destination: string } | null) {\n  return ',
    ';\n}',
  );
  const instructions = expression(
    repair.replaceAll('import.meta.dir', JSON.stringify(`${root}/scripts/implement`)),
    {
      resolve: posix.resolve,
      capture: null,
    },
  );
  assert(typeof instructions === 'string', 'Invalid repair instructions');
  const absoluteReferences = instructions
    .split(`${root}/skills/`)
    .slice(1)
    .map((tail) => {
      const path = tail.match(/^[a-zA-Z0-9/_.-]+\.md/)?.[0];
      assert(path, 'Invalid trusted actor reference');
      return `skills/${path}`;
    });
  for (const path of absoluteReferences) {
    assert(Object.hasOwn(files, path), `Missing trusted actor reference: ${path}`);
  }
  const research = between(
    source('research-handoff'),
    'export function researchContext(startCommit: string, reports: ReportReference[] = []) {\n  return ',
    ';\n}',
  );
  const researchText = expression(research, { startCommit: config.workspaceCommit, reports: [] });
  assert(typeof researchText === 'string', 'Invalid research context');
  assert(
    source('review').includes(
      "export const reviewModel = { model: 'gpt-6.1-sol', reasoningEffort: 'high' };",
    ),
    'Unsupported source model',
  );
  const actor = source('codex-actor');
  assert(
    actor.includes(
      "const model = role !== 'review' ? { ...reviewModel, reasoningEffort: 'medium' } : reviewModel;",
    ) && actor.includes("role !== 'review' ? 'workspace-write' : 'read-only'"),
    'Unsupported actor role',
  );
  const schemaExpression = between(
    actor,
    "      : role === 'test'\n        ? testReplySchema\n        : ",
    ',\n  ),\n);',
  );
  const schema = expression(schemaExpression, {});
  assert(isRecord(schema), 'Invalid repair response contract');
  const tests = Object.entries(files).filter(([path]) =>
    path.startsWith('eval/fixtures/workspace/tests/'),
  );
  assert(tests.length > 0, 'Independent task tests required');
  const promptExpression = between(
    source('orchestrator'),
    '  const prompt = [\n',
    "\n  await writeFile(join(dir, 'implementation.prompt'), prompt);",
  );
  const instructionsHash = hash(instructions);
  const testHashes = Object.fromEntries(tests.map(([path, body]) => [path, hash(body)]));
  return (item: { id: string; contextBody: string | null; check?: string[] }) => {
    const contract = {
      repository: 'thkt/eval-workspace',
      remote: 'origin',
      baseBranch: 'main',
      setup: [],
      check: item.check,
      capture: null,
      ciChecks: [],
    };
    // 開始済みの通常初回担当と同じ配列式を、公開の合成要求と独立資産へ束縛する。
    const prompt = expression(`[\n${promptExpression.trim().replace(/;$/, '')}`, {
      context: {
        target: { config: contract },
        number: 1,
        reviewBase: config.workspaceCommit,
        reports: [],
      },
      dir,
      original: item.contextBody,
      join: posix.join,
      repairInstructions: () => instructions,
      revisionContext: () => '',
      hostReturnContext: () => '',
      researchContext: () => researchText,
    });
    assert(typeof prompt === 'string', 'Invalid initial actor input');
    const record = {
      status: 'prepared',
      stage: 'initial',
      baseCommit: config.workspaceCommit,
      check: item.check,
      setup: [],
      files: testHashes,
      findings:
        '公開の合成仕様と独立テストを固定した。これは準備記録であり、この試行での修正前再現・修正後成功の実行結果ではない。テスト・fixture・接続定義は変更せず、不足はfindingsへ返す。',
    };
    return {
      case: item.id,
      role: 'repair',
      stage: 'initial',
      prompt,
      promptHash: hash(prompt),
      schema,
      files: { 'actor-records/test-1.json': `${JSON.stringify(record, null, 2)}\n` },
      sources,
      repairInstructions: instructions,
      repairInstructionsHash: instructionsHash,
      references: absoluteReferences,
      sourceLaunch: {
        model: 'gpt-6.1-sol',
        reasoning: 'medium',
        sandbox: 'workspace-write',
      },
      launch: {
        model: config.model,
        reasoning: config.reasoning,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        isolation: 'verified-eval-docker',
      },
      commonDifferences: [
        '通常CLIを再帰起動せず、隔離evalの同一runnerから初回repair担当だけを起動する。',
        '公開の合成Issue・setupなし・課題別check・captureなし・独立準備記録を両条件へ同じ形で渡す。',
        'eval専用Dockerを隔離境界とし、danger-full-access・承認never・ephemeral・ignore-rules・中継・有限上限をA/B共通で使う。通常のworkspace境界は保証せず、独立評価と公開は行わない。',
        '通常repairの候補はgpt-6.1-sol / medium。実行時は別途合意したconfigのmodel / reasoningで全試行を固定する。',
      ],
    };
  };
}
