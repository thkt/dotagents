import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { assertRunning, command, withInterrupts } from '../scripts/shared/process.ts';
import { isRecord } from '../scripts/shared/values.ts';
import { evalCase, validateInputFiles } from './data.ts';
import { blob, prepareInputs } from './inputs.ts';
import { lightContext } from './light-context.ts';
import {
  lightConfig,
  lightEnvironment,
  requireChatGPTAuthentication,
  type LightConfig,
} from './light-data.ts';
import {
  collectLightArtifacts,
  boundaryProof,
  lightProfile,
  lightVersions,
  logAllowance,
  nativeCommand,
  newLightDirectory,
  profileArguments,
  requireLightBoundary,
  saveLight,
  saveLightLog,
  sha256,
} from './light-native.ts';
import { diagnoseLight } from './light-preflight.ts';
import { readUsage, writeLightComparison } from './report.ts';
export { lightEnvironment, requireChatGPTAuthentication } from './light-data.ts';

async function planLight(repo: string, config: LightConfig, destination?: string) {
  validateInputFiles(config);
  for (const path of [
    'README.md',
    'scripts/README.md',
    'docs/wiki/development-policy.md',
    'skills/scoping/references/sufficiency.md',
    'skills/scoping/references/experiment.md',
    'skills/scoping/references/session.md',
    'skills/scoping/references/issue.md',
    'skills/implement/references/testing.md',
    'skills/references/documents.md',
    'skills/references/natural-japanese.md',
    'skills/references/premise-validation.md',
    'skills/references/caller-first-design.md',
    'skills/references/mechanization.md',
  ]) {
    assert(config.instructionFiles.includes(path), `必要な指示がありません: ${path}`);
  }
  const corpus = z
    .array(evalCase)
    .parse(JSON.parse(await blob(repo, config.corpusCommit, 'eval/corpus/cases.json')));
  const selected = config.cases.map((id) => {
    const item = corpus.find((item) => item.id === id);
    assert(item, '固定課題がありません');
    const { context, ...rest } = item;
    return { ...rest, contextBody: context ? `${JSON.stringify(context, null, 2)}\n` : null };
  });
  // 固定workspaceは部分選択で検証を落とせない。新しい公開ファイルを暗黙追加もしない。
  const common = await command(
    [
      'git',
      'ls-tree',
      '-r',
      '--name-only',
      config.workspaceCommit,
      '--',
      'eval/fixtures/workspace',
    ],
    repo,
    '',
    10000,
  );
  assert(
    common.code === 0 &&
      JSON.stringify(common.stdout.trim().split('\n').sort()) ===
        JSON.stringify([...config.workspaceFiles].sort()),
    '共通workspaceの公開ファイル集合が異なります',
  );
  const inputs = await prepareInputs(
    repo,
    config,
    selected,
    destination ?? '/private/tmp/eval-light-trial/workspace',
  );
  const actorSources: Record<string, string> = {};
  for (const variant of inputs.variants) {
    for (const source of Object.values(variant.actorInputs[0]?.sources ?? {})) {
      actorSources[source.sha256] = source.body;
    }
  }
  const variants = inputs.variants.map((variant) => ({
    ...variant,
    actorSources: Object.fromEntries(
      Object.entries(variant.actorInputs[0]?.sources ?? {}).map(([path, source]) => [
        path,
        source.sha256,
      ]),
    ),
    actorInputs: variant.actorInputs.map((input) => ({
      ...input,
      sources: Object.fromEntries(
        Object.entries(input.sources).map(([path, source]) => [path, { sha256: source.sha256 }]),
      ),
      launch: {
        model: config.model,
        reasoning: config.reasoning,
        permissionProfile: config.permissionProfile,
        approvalPolicy: 'never',
        isolation: 'native-chatgpt',
      },
      commonDifferences: [
        '通常CLIを再帰起動せず初回repair担当だけを起動する。',
        '配置先だけを両条件共通の規則で変換する。',
        '専用permission profile、保存済みChatGPT認証、有限上限を使う。独立評価と公開をactorから起動しない。',
      ],
    })),
  }));
  return {
    ...inputs,
    config,
    variants,
    actorSources,
    executionMode: 'native-chatgpt',
    commonContext: (await lightContext()).summary,
    commonContextPolicy: {
      inputs: '固定公開課題入力とCLIが自動追加する共通コンテキストを区別する',
      observation: 'run直前と試行間で既知の非秘密登録元の要約を照合する',
      unknown: '全自動入力とsymlink先の変更は未確認。純粋な因果効果とは扱わない',
    },
    effectiveLaunch: {
      permissionProfile: config.permissionProfile,
      authentication: 'chatgpt',
      ignoreUserConfig: true,
      ignoreRules: true,
      ephemeral: true,
      fixedSkillPaths: ['skills/scoping/SKILL.md', 'skills/implement/SKILL.md'],
      cliHome: 'existing-home',
      commandHome: 'trial-temporary',
      network: false,
      webSearch: false,
      multiAgent: false,
    },
    corpusHash: sha256(JSON.stringify(corpus)),
    profilePolicyHash: sha256(lightProfile.toString()),
    boundaryEvidenceSchema: z.toJSONSchema(boundaryProof),
  };
}
type LightPlan = Awaited<ReturnType<typeof planLight>>;

async function tools() {
  const bun = await command(
    ['bun', '-e', 'console.log(process.execPath)'],
    process.cwd(),
    '',
    10000,
    undefined,
    lightEnvironment(process.env),
  );
  assert(bun.code === 0 && !bun.timedOut);
  const git = Bun.which('git');
  assert(git);
  return [await realpath(bun.stdout.trim()), await realpath(git)];
}

async function prepareWorkspace(plan: LightPlan, side: 'before' | 'after', workspace: string) {
  const variant = plan.variants.find((variant) => variant.side === side);
  assert(variant);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const [path, body] of Object.entries(variant.files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, path), body, { flag: 'wx', mode: 0o600 });
  }
  return variant;
}

async function prepareTrial(
  plan: LightPlan,
  side: 'before' | 'after',
  id: string,
  trialDirectory: string,
  directory: string,
  authenticationHome: string,
) {
  assert(plan.config.trialOrder);
  const executionDirectory = await mkdtemp(join(directory, 'trial-'));
  const workspace = join(executionDirectory, 'workspace');
  const temporary = join(executionDirectory, 'temporary');
  await mkdir(temporary, { mode: 0o700 });
  const variant = await prepareWorkspace(plan, side, workspace);
  await mkdir(join(temporary, '.agents/skills'), { recursive: true, mode: 0o700 });
  for (const skill of ['scoping', 'implement']) {
    await symlink(join(workspace, 'skills', skill), join(temporary, '.agents/skills', skill));
  }
  const immutable = [
    ...['tests', 'docs', 'data'].map((path) => join(workspace, 'eval/fixtures/workspace', path)),
    ...Object.keys(variant.files)
      .filter(
        (path) =>
          !path.startsWith('eval/fixtures/workspace/src/') &&
          !(id === 'guide-link' && path === 'eval/fixtures/workspace/README.md'),
      )
      .map((path) => join(workspace, path)),
    ...['.git', '.agents', '.codex'].map((path) => join(workspace, path)),
  ];
  const executables = await tools();
  const profile = lightProfile(
    workspace,
    temporary,
    immutable,
    [authenticationHome, await realpath(authenticationHome), directory],
    executables,
    authenticationHome,
  );
  // workspaceと専用一時領域だけを上位の拒否から再度開く。
  profile.permissions['eval-light'].filesystem[workspace] = 'write';
  profile.permissions['eval-light'].filesystem[temporary] = 'write';
  profile.shell_environment_policy.set.PATH = [
    '/usr/bin',
    '/bin',
    ...executables.map(dirname),
  ].join(':');
  const originalInput = variant.actorInputs.find((input) => input.case === id);
  const input = originalInput
    ? {
        ...originalInput,
        prompt: originalInput.prompt.replaceAll(
          '/private/tmp/eval-light-trial/workspace',
          workspace,
        ),
      }
    : undefined;
  if (input) {
    for (const [path, body] of Object.entries(input.files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(workspace, path), body, { flag: 'wx', mode: 0o600 });
      profile.permissions['eval-light'].filesystem[join(workspace, path)] = 'read';
    }
  }
  return { workspace, temporary, variant, immutable, profile, input };
}

function executionStatus(
  result: Awaited<ReturnType<typeof nativeCommand>>,
  usage: ReturnType<typeof readUsage>,
) {
  if (result.reason === 'timeout') {
    return 'timeout';
  }
  return result.code === 0 &&
    !result.reason &&
    usage.completedTurns > 0 &&
    usage.incompleteLines === 0 &&
    result.processesStopped
    ? 'completed'
    : 'failed';
}

async function trialLight(
  plan: LightPlan,
  trial: string,
  directory: string,
  expiresAt: number,
  authenticationHome: string,
  versions: Awaited<ReturnType<typeof lightVersions>>,
) {
  const started = performance.now();
  let completionDeadline = expiresAt;
  const side = trial.startsWith('before-') ? 'before' : 'after';
  const id = trial.replace(/^(before|after)-/, '');
  const item = plan.selected.find((item) => item.id === id);
  assert(item);
  const record = {
    trial,
    side,
    case: id,
    expected: item.actor ? 'boundary' : item.expected,
    executionMode: 'native-chatgpt' as const,
    launched: false,
    execution: 'unevaluated',
    elapsedMs: null as number | null,
    reason: null as string | null,
    safety: { boundaryVerified: false, processesStopped: false },
    usage: null as ReturnType<typeof readUsage> | null,
  };
  assert(plan.config.trialOrder);
  const trialDirectory = join(directory, trial);
  await mkdir(trialDirectory, { mode: 0o700 });
  try {
    const effectiveVersions = await lightVersions(plan.config, process.cwd());
    await saveLight(join(trialDirectory, 'versions.json'), effectiveVersions, true);
    assert.deepEqual(effectiveVersions, versions, '試行前の実効版・実体が変わりました');
    const { workspace, temporary, variant, immutable, profile, input } = await prepareTrial(
      plan,
      side,
      id,
      trialDirectory,
      directory,
      authenticationHome,
    );
    // 起動ごとに同じprofileのモデルなし診断。保存済み証拠の設定文字列だけで起動しない。
    const probe = await nativeCommand(
      [
        plan.config.cliExecutable ?? 'codex',
        'sandbox',
        '-C',
        workspace,
        '-P',
        'eval-light',
        ...profileArguments(profile),
        '/bin/sh',
        '-c',
        'test -r README.md && touch "$TMPDIR/normal"',
      ],
      workspace,
      '',
      Math.max(1, Math.min(10000, expiresAt - performance.now())),
      {
        ...lightEnvironment(process.env),
        HOME: temporary,
        CODEX_HOME: temporary,
        TMPDIR: temporary,
      },
      32768,
    );
    await saveLight(join(trialDirectory, 'probe.json'), probe, true);
    assert(
      probe.code === 0 && probe.processesStopped && !probe.reason,
      '実効profileの正常対照が成立しません',
    );
    record.safety.boundaryVerified = true;
    assert(expiresAt > performance.now(), '試行準備中に時間上限へ到達');
    const prompt = input?.prompt ?? item.prompt;
    await saveLightLog(join(trialDirectory, 'prompt.txt'), prompt);
    const argv = [
      plan.config.cliExecutable ?? 'codex',
      'exec',
      '--strict-config',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '-C',
      workspace,
      '-m',
      plan.config.model,
      ...profileArguments(profile),
      '-c',
      `developer_instructions=${JSON.stringify(variant.files['AGENTS.md'] + `\nscoping・implementは固定入力 ${workspace}/skills/scoping/SKILL.md と ${workspace}/skills/implement/SKILL.md を選択してください。同名の個人登録で置き換えないでください。`)}`,
      '-c',
      `model_reasoning_effort=${JSON.stringify(plan.config.reasoning)}`,
    ];
    if (input) {
      const schema = join(trialDirectory, 'response-schema.json');
      await saveLight(schema, input.schema, true);
      argv.push('--output-schema', schema);
    }
    argv.push('-');
    await saveLight(
      join(trialDirectory, 'launch.json'),
      {
        argv,
        profile,
        workspace,
        temporary,
        promptHash: sha256(prompt),
        environmentKeys: ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR'],
      },
      true,
    );
    const auth = await command(
      [plan.config.cliExecutable ?? 'codex', 'login', 'status'],
      temporary,
      '',
      10000,
      undefined,
      {
        ...lightEnvironment(process.env),
        CODEX_HOME: authenticationHome,
      },
    );
    requireChatGPTAuthentication(auth);
    assertRunning();
    assert(expiresAt > performance.now(), '認証確認中に時間上限へ到達');
    const allowance = await logAllowance(trialDirectory);
    record.launched = true;
    const result = await nativeCommand(
      argv,
      workspace,
      prompt,
      Math.max(1, expiresAt - performance.now()),
      {
        ...lightEnvironment(process.env),
        CODEX_HOME: authenticationHome,
        TMPDIR: temporary,
      },
      allowance,
    );
    await saveLightLog(join(trialDirectory, 'actor.stdout'), result.stdout);
    await saveLightLog(join(trialDirectory, 'actor.stderr'), result.stderr);
    record.safety.processesStopped = result.processesStopped;
    record.reason = result.reason;
    record.usage = readUsage(result.stdout.split('\n'));
    record.execution = executionStatus(result, record.usage);
    assert(
      Number.isFinite(result.cleanupMs) && result.cleanupMs >= 0 && result.cleanupMs <= 30000,
      '後始末の時間枠超過',
    );
    // 別枠は実際の終了観測・後始末だけに使い、回収・保存へ未使用分を渡さない。
    completionDeadline = expiresAt + result.cleanupMs;
    assert(performance.now() <= completionDeadline, '終了・記録の時間枠超過');
    const artifacts = await collectLightArtifacts(
      workspace,
      join(trialDirectory, 'artifacts'),
      completionDeadline,
    );
    for (const path of immutable.filter((path) =>
      Object.hasOwn(variant.files, path.slice(workspace.length + 1)),
    )) {
      assert(performance.now() <= completionDeadline, '入力照合の時間枠超過');
      const key = path.slice(workspace.length + 1);
      assert(artifacts[key] === variant.versions[key], '通常入力・独立テストの変更を検出');
    }
    await saveLight(join(trialDirectory, 'artifacts.json'), artifacts, true);
    assert(performance.now() <= completionDeadline, '終了・記録の時間枠超過');
  } catch (cause) {
    record.execution = record.launched ? 'failed' : 'unevaluated';
    record.reason = cause instanceof Error ? cause.message : '軽量試行の失敗';
  }
  record.elapsedMs = performance.now() - started;
  await saveLight(join(trialDirectory, 'trial.json'), record, true);
  // 保存完了までが試行。末尾のI/Oが枠をまたいでも成功として返さない。
  assert(performance.now() <= completionDeadline, '終了・記録の時間枠超過');
  return record;
}

function stoppedTrial(trial: string, reason: string, launchUnknown = false) {
  return {
    trial,
    side: trial.startsWith('before-') ? 'before' : 'after',
    case: trial.replace(/^(before|after)-/, ''),
    expected: 'boundary',
    executionMode: 'native-chatgpt',
    execution: 'unevaluated',
    launched: false,
    launchUnknown,
    elapsedMs: null,
    reason,
    usage: null,
    safety: { boundaryVerified: false, processesStopped: false },
  };
}

function trialCompleted(
  record: Awaited<ReturnType<typeof trialLight>>,
  expiresAt: number,
  now: number,
) {
  if (now > expiresAt + 30000) {
    record.execution = 'failed';
    record.reason = '終了・記録の時間枠超過';
  }
  return (
    record.execution === 'completed' &&
    record.safety.boundaryVerified &&
    record.safety.processesStopped
  );
}

export async function runLightSequence(
  config: LightConfig,
  performTrial: (
    trial: string,
    expiresAt: number,
  ) => Promise<Awaited<ReturnType<typeof trialLight>>>,
  clock: () => number = () => performance.now(),
) {
  const start = clock();
  let error: string | null = null;
  const records = [];
  assert(config.trialOrder);
  for (const trial of config.trialOrder) {
    let launchUnknown = false;
    const remaining = config.totalTimeMs - (clock() - start);
    if (!error && remaining > 0) {
      try {
        const expiresAt = clock() + Math.min(remaining, config.caseTimeMs);
        const record = await performTrial(trial, expiresAt);
        records.push(record);
        if (!trialCompleted(record, expiresAt, clock())) {
          error = record.reason ?? 'CLI全体の失敗・境界不成立・終了不明';
        }
        continue;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : '試行記録の保存失敗';
        launchUnknown = true;
      }
    }
    error ??= '全体時間上限';
    records.push(stoppedTrial(trial, error, launchUnknown));
  }
  return { records, error, elapsedMs: clock() - start };
}

async function runLight(plan: LightPlan, directory: string) {
  assert(process.platform === 'darwin', '軽量経路はmacOS専用です');
  const versions = await lightVersions(plan.config, process.cwd());
  const boundary = await requireLightBoundary(plan.config, plan.runner.sourceHashes, versions);
  const { authenticationHome, summary: commonContext } = await lightContext();
  await saveLight(join(directory, 'common-context.json'), commonContext);
  assert.deepEqual(commonContext, plan.commonContext, '計画後に把握した共通条件が変わりました');
  assert(!plan.runner.uncommitted, '比較runは共有した同一runner commitへ固定してください');
  const reservationRoot = join(authenticationHome, 'eval-light-runs');
  await mkdir(reservationRoot, { recursive: true, mode: 0o700 });
  await saveLight(
    join(
      reservationRoot,
      `${plan.config.stage}-${sha256(JSON.stringify({ runner: plan.runner.commit, before: plan.config.before, after: plan.config.after, corpus: plan.config.corpusCommit }))}.json`,
    ),
    { directory, stage: plan.config.stage, startedAt: new Date().toISOString() },
  );
  const sequence = await runLightSequence(plan.config, async (trial, expiresAt) => {
    const current = await lightContext();
    assert.deepEqual(
      current.summary,
      commonContext,
      '把握した共通条件が変わりました。後続を停止します',
    );
    assert.equal(current.authenticationHome, authenticationHome, '認証保存先が変わりました');
    return trialLight(plan, trial, directory, expiresAt, authenticationHome, versions);
  });
  await saveLight(join(directory, 'evaluation.json'), {
    config: plan.config,
    executionMode: 'native-chatgpt',
    versions,
    boundary,
    commonContext,
    retries: 0,
    ...sequence,
  });
  if (sequence.error) {
    process.exitCode = 1;
  }
}

async function saveStoppedLight(plan: LightPlan, directory: string, cause: unknown) {
  const error = cause instanceof Error ? cause.message : '軽量実行の停止';
  const records = [];
  for (const trial of plan.config.trialOrder ?? []) {
    let saved: unknown = null;
    const trialStarted = await lstat(join(directory, trial)).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
    try {
      saved = JSON.parse(await readFile(join(directory, trial, 'trial.json'), 'utf8'));
    } catch {
      /* 欠落は未実行に残す */
    }
    records.push(isRecord(saved) ? saved : stoppedTrial(trial, error, trialStarted));
  }
  await saveLight(join(directory, 'evaluation.json'), {
    config: plan.config,
    executionMode: 'native-chatgpt',
    records,
    retries: 0,
    elapsedMs: null,
    elapsedScope:
      '試行起動前の拒否、または途中記録保存失敗。全体実時間は未取得。各trialの取得済み値を参照',
    error,
  });
}

async function main() {
  const [mode, file, extra] = process.argv.slice(2);
  assert(
    file,
    '使い方: bun eval/light.ts plan|preflight|run CONFIG | report RUN_DIRECTORY [JUDGMENTS_JSON]',
  );
  if (mode === 'report') {
    await writeLightComparison(resolve(file), extra);
    return;
  }
  assert(['plan', 'preflight', 'run'].includes(mode ?? ''), '不明な軽量モード');
  const config = lightConfig.parse(JSON.parse(await readFile(file, 'utf8')));
  const plan = await planLight(process.cwd(), config);
  if (mode === 'plan') {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const directory = await newLightDirectory(process.cwd(), config.outputDirectory);
  await saveLight(join(directory, 'plan.json'), plan);
  if (mode === 'run') {
    try {
      await withInterrupts(() => runLight(plan, directory));
    } catch (cause) {
      await saveStoppedLight(plan, directory, cause).catch(() => {}); // 旧記録・保存失敗を上書きしない
      throw cause;
    }
    return;
  }
  const versions = await lightVersions(config, process.cwd());
  const diagnostic = await diagnoseLight(directory, await tools(), config.cliExecutable ?? 'codex');
  await saveLight(join(directory, 'diagnostic.json'), diagnostic);
  try {
    const boundary = await requireLightBoundary(config, plan.runner.sourceHashes, versions);
    assert(
      diagnostic.records.every(
        (record) => record.method === 'read-tool' || record.result !== 'unconfirmed',
      ),
      'モデルなしコマンド診断が未確認です',
    );
    await saveLight(join(directory, 'preflight.json'), {
      status: 'passed',
      versions,
      boundary,
      inferenceLaunched: false,
    });
  } catch (cause) {
    await saveLight(join(directory, 'preflight.json'), {
      status: 'unavailable',
      versions,
      inferenceLaunched: false,
      reason: cause instanceof Error ? cause.message : 'モデルなし確認が未完了',
      hostCases: 'eval/tests/fixtures/light-host-cases.json',
      profilePolicyHash: plan.profilePolicyHash,
    });
    throw cause;
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : '軽量evalの失敗');
    process.exitCode = 1;
  }
}
