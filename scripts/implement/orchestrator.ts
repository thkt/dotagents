import {
  authorTests,
  prepareTestBaseline,
  readPreparedTestRecord,
  verifyTestArtifacts,
} from './test-author.ts';
import type { TestIntake } from './test-author.ts';
import { RecordObservation } from './record-observation.ts';
import assert from 'node:assert/strict';
import { reviewModel } from './review.ts';
import { issueText } from './issue.ts';
import { prBody } from './pr-body.ts';
import { mkdir, readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { previousReviewRun } from './review-recovery.ts';
import { verifyReviewReturn } from './review-recovery-records.ts';
import { previousHostRun, saveHostStop } from './host-handoff.ts';
import {
  hostLocalRoots,
  interruptionReturn,
  hostReturnContext,
  hash,
  verifyHostReturn,
  readReference,
} from './host-records.ts';
import { run, snapshot, recordArtifacts } from './correction.ts';
import { previousRun, checkRevision, revisionContext } from './revision.ts';
import { parseRepairReply, repairInstructions } from './repair.ts';
import { command, assertRunning } from '../shared/process.ts';
import { isRecord, outside } from '../shared/values.ts';
import { publish, checkPublishedPr, PublicationError } from './publish.ts';
import { waitForCi } from './ci.ts';
import type { CiResult } from './ci.ts';
import { readTarget, issueNumber, targetCommand, pushArguments } from '../shared/target.ts';
import {
  researchContext,
  researchHandoff,
  verifyReportBase,
  verifyReports,
} from './research-handoff.ts';
import { assertConfig, assertState, testRecordsShape } from './input.ts';
import type { Config, State, ReportReference, StopReason, Revision } from './input.ts';
import { writeRunReport } from './run-report.ts';

const runtime: {
  command: typeof command;
  verify: (config: Config, publicationHead?: string) => Promise<State>;
  publish: typeof publish;
} = { command, verify: run, publish };
// Applied separately to each local verification command.
const checkTimeMs = 900000;
// General commands and post-publication target checks retain their 11-minute limit.
const hostCommandTimeMs = 660000;

type DevelopmentResult = {
  startedAt: string;
  finishedAt?: string;
  terminal?: true;
  status: 'stopped' | 'verified_local' | 'published_draft';
  phase: 'preparation' | 'implementation' | 'verification' | 'publication' | 'ci';
  operation: string;
  reason: string;
  reasonCode?: string;
  nextAction: string;
  repository: string;
  issue: string;
  startCommit: string;
  branch: string;
  checkout: string;
  evidence: string;
  details: string;
  publication: 'not_attempted' | 'unconfirmed' | 'published';
  localOnly: boolean;
  url?: string;
  commit?: string;
  requiredChecks: string[];
  ci?: CiResult['status'];
  ciDetails?: CiResult;
  remaining: string[];
};

async function checkedOutput(io: typeof runtime, argv: string[], cwd: string, prefix?: string) {
  const result = await io.command(argv, cwd, '', hostCommandTimeMs, prefix);
  assert(result.code === 0 && !result.timedOut, `Command failed: ${argv[0]}; ${result.stderr}`);
  return result.stdout;
}

async function checked(io: typeof runtime, argv: string[], cwd: string, prefix?: string) {
  return (await checkedOutput(io, argv, cwd, prefix)).trim();
}

function issueValue(text: string) {
  const value: unknown = JSON.parse(text);
  assert(
    isRecord(value) &&
      typeof value.title === 'string' &&
      value.title.trim() &&
      typeof value.body === 'string' &&
      value.body.trim() &&
      value.state === 'OPEN',
    'Issue must be open with a title and requirements',
  );
  return { title: value.title };
}

async function verifyTargetInput(repo: string, base: string, text: string, io: typeof runtime) {
  const git = (...args: string[]) => checked(io, ['git', ...args], repo);
  assert(
    (await readFile(join(repo, '.dotagents.json'), 'utf8')) === text,
    'Target configuration differs from start commit',
  );
  const entry = await git('ls-tree', base, '--', '.dotagents.json');
  if (!entry) {
    assert(
      !(await git('ls-files', '--stage', '--', '.dotagents.json')),
      'ローカル対象設定をindexへ追加できません',
    );
    return true;
  }
  assert(
    /^100(?:644|755) blob /.test(entry) &&
      (await git('hash-object', '--no-filters', '--', '.dotagents.json')) === entry.split(/\s/)[2],
    'Target configuration differs from start commit',
  );
  assert(
    !(await git('-c', 'core.filemode=true', 'status', '--porcelain', '--', '.dotagents.json')),
    'Required start inputs have uncommitted changes',
  );
  return false;
}

async function verifyStartInputs(
  repo: string,
  base: string,
  targetText: string,
  reports: ReportReference[],
  io: typeof runtime,
) {
  const git = (...args: string[]) => checked(io, ['git', ...args], repo);
  assert((await git('rev-parse', 'HEAD')) === base, 'Start HEAD changed during preparation');
  const localTarget = await verifyTargetInput(repo, base, targetText, io);
  await verifyStartReports(repo, base, reports, io);
  return localTarget;
}

async function verifyStartReports(
  repo: string,
  base: string,
  reports: ReportReference[],
  io: typeof runtime,
) {
  const git = (...args: string[]) => checked(io, ['git', ...args], repo);
  await verifyReports(repo, base, reports, git);
  assert(
    reports.length === 0 ||
      (
        await git(
          '-c',
          'core.filemode=true',
          'status',
          '--porcelain',
          '--',
          ...reports.map(({ path }) => path),
        )
      ).length === 0,
    'Required start inputs have uncommitted changes',
  );
  assert((await git('rev-parse', 'HEAD')) === base, 'Start HEAD changed during preparation');
}

async function prepareRevision(
  prior: Awaited<ReturnType<typeof previousRun>> | undefined,
  requestPath: string | undefined,
  runDirectory: string | undefined,
  repo: string,
  number: string,
  issueText: string,
  base: string,
  target: Awaited<ReturnType<typeof readTarget>>,
  localOnly: boolean,
  io: typeof runtime,
) {
  const repository = target.config.repository;
  const git = (...args: string[]) => checked(io, ['git', ...args], repo);
  let revision: Revision | undefined;
  if (prior) {
    assert(requestPath && runDirectory, 'Revision requires a new --run-dir beside previous run');
    const requestFile = await realpath(requestPath);
    const request = await readFile(requestFile, 'utf8');
    assert(
      request.trim(),
      'Revision request must contain adopted findings, expected result and authorized scope',
    );
    revision = {
      previousRun: prior.dir,
      requestFile,
      request,
      url: prior.url,
      body: prior.body,
      head: prior.head,
      branch: prior.branch,
      baseBranch: target.config.baseBranch,
      repository,
      issue: number,
      issueText,
      runDirectory: resolve(runDirectory),
      actor: target.actor,
      repositoryId: target.repositoryId,
      targetText: target.text,
      localOnly,
      ...(interruptionReturn(prior.config)
        ? { reviewReturn: interruptionReturn(prior.config) }
        : {}),
    };
    assert(
      base === prior.head && (await snapshot(repo)) === prior.state.source,
      'Checkout differs from previous verified published head',
    );
    revision.body = await checkRevision(revision, repo, (argv, cwd) => checked(io, argv, cwd), {
      captureBody: true,
      target,
      issue: issueText,
    });
    assert(
      !(await git(
        '-c',
        'core.filemode=true',
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        '.',
        ':(top,exclude).dotagents.json',
      )),
      'Revision requires clean tracked and untracked work; preserve existing work',
    );
  }
  return revision;
}

function parseStart(args: string[]) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      'run-dir': { type: 'string' },
      'no-publish': { type: 'boolean' },
      'start-commit': { type: 'string' },
      report: { type: 'string', multiple: true },
      'previous-run': { type: 'string' },
      'request-file': { type: 'string' },
      'review-run': { type: 'string' },
      'check-timeout-run': { type: 'string' },
      'interrupted-run': { type: 'string' },
      'host-run': { type: 'string' },
      'host-evidence': { type: 'string' },
    },
  });
  assert(
    parsed.positionals.length === 1,
    'Usage: bun scripts/implement/development.ts ISSUE [--repo CHECKOUT] [--run-dir DIRECTORY] [--start-commit SHA --report docs/research/NAME.md=BLOB] [--previous-run DIRECTORY --request-file PATH] [--host-run DIRECTORY --host-evidence PATH] [--check-timeout-run DIRECTORY --run-dir DIRECTORY] [--review-run DIRECTORY --run-dir DIRECTORY] [--interrupted-run DIRECTORY --run-dir DIRECTORY [--host-evidence PATH]]',
  );
  assert(
    Boolean(parsed.values['previous-run']) === Boolean(parsed.values['request-file']),
    'Revision requires --previous-run and --request-file',
  );
  assert(
    !parsed.values['previous-run'] || (!parsed.values['start-commit'] && !parsed.values.report),
    'Revision inherits references from previous run',
  );
  assert(
    Boolean(
      parsed.values['host-run'] ||
      (parsed.values['interrupted-run'] && parsed.values['host-evidence']),
    ) === Boolean(parsed.values['host-evidence']),
    'Host return requires --host-run and --host-evidence',
  );
  assert(
    !parsed.values['host-run'] ||
      (parsed.values['run-dir'] &&
        !parsed.values['previous-run'] &&
        !parsed.values['start-commit'] &&
        !parsed.values.report),
    'Host return requires a new --run-dir and inherits its original references',
  );
  assert(
    !parsed.values['review-run'] ||
      (parsed.values['run-dir'] &&
        !parsed.values['host-run'] &&
        !parsed.values['previous-run'] &&
        !parsed.values['start-commit'] &&
        !parsed.values.report),
    '不正評価からの復帰は新しい--run-dirを使い、他の復帰入口・参照指定と混在できません',
  );
  assert(
    !parsed.values['interrupted-run'] ||
      (parsed.values['run-dir'] &&
        !parsed.values['review-run'] &&
        !parsed.values['host-run'] &&
        !parsed.values['previous-run'] &&
        !parsed.values['start-commit'] &&
        !parsed.values.report),
    '中断復帰は新しい--run-dirを使い、他の復帰入口・参照指定と混在できません',
  );
  const recoveryEntries = [
    'review-run',
    'interrupted-run',
    'check-timeout-run',
    'host-run',
    'previous-run',
  ] as const;
  assert(
    recoveryEntries.filter((name) => parsed.values[name]).length <= 1,
    '復帰入口は併用できません',
  );
  assert(
    !parsed.values['check-timeout-run'] ||
      (parsed.values['run-dir'] &&
        !parsed.values['start-commit'] &&
        !parsed.values.report &&
        !parsed.values['host-evidence']),
    'check時間切れ復帰には新しい--run-dirが必要で、参照・追加証拠を指定できません',
  );
  return parsed;
}

async function selectStart(args: string[], io: typeof runtime) {
  const parsed = parseStart(args);
  const repo = await realpath(parsed.values.repo ?? process.cwd());
  const git = (...argv: string[]) => checked(io, ['git', ...argv], repo);
  const base = await git('rev-parse', 'HEAD');
  const localOnly = parsed.values['no-publish'] ?? false;
  const target = await readTarget(repo, (argv, cwd) => checked(io, argv, cwd), !localOnly);
  assert(localOnly || target.config.ciChecks.length > 0, 'Publishing requires expected CI checks');
  const { repository } = target.config;
  const input = parsed.positionals[0];
  assert(input);
  const number = issueNumber(input, repository);
  const prior = parsed.values['previous-run']
    ? await previousRun(parsed.values['previous-run'], repo, number, target)
    : undefined;
  let reports =
    prior?.config.reports ??
    researchHandoff(base, parsed.values['start-commit'], parsed.values.report ?? []);
  const issue = [
    'gh',
    'issue',
    'view',
    number,
    '--repo',
    repository,
    '--json',
    'title,body,state,updatedAt',
  ];
  const rawIssue = await checkedOutput(io, issue, repo);
  const original = issueText(rawIssue);
  const requirements = issueValue(original);
  const hostPrior = await previousHostRun({
    directory: parsed.values['host-run'],
    evidenceFile: parsed.values['host-evidence'],
    runDirectory: parsed.values['run-dir'],
    cwd: repo,
    issue: number,
    original,
    head: base,
    target,
    localOnly,
  });
  const reviewPrior =
    parsed.values['review-run'] ||
    parsed.values['interrupted-run'] ||
    parsed.values['check-timeout-run']
      ? await previousReviewRun({
          ...reviewEntry(parsed),
          runDirectory: parsed.values['run-dir'],
          cwd: repo,
          issue: number,
          original,
          head: base,
          branch: await git('branch', '--show-current'),
          target,
          localOnly,
        })
      : undefined;
  reports = reviewPrior?.config.reports ?? hostPrior?.config.reports ?? reports;
  if (hostPrior) {
    assert(
      (await git('branch', '--show-current')) === hostPrior.branch,
      'Host handoff branch changed',
    );
  }
  let revision = await prepareRevision(
    prior,
    parsed.values['request-file'],
    parsed.values['run-dir'],
    repo,
    number,
    original,
    base,
    target,
    localOnly,
    io,
  );
  if (hostPrior?.config.revision) {
    revision = {
      ...hostPrior.config.revision,
      runDirectory: resolve(parsed.values['run-dir'] ?? ''),
      localOnly,
    };
  }
  const inheritedBase = reviewPrior?.baseCommit ?? hostPrior?.baseCommit ?? prior?.state.baseCommit;
  if (inheritedBase) {
    // Keep the original PR-wide base when handing off already implemented work.
    await verifyReportBase(inheritedBase, reports, git);
  }
  const inputs = reusesCheckout(prior, hostPrior, reviewPrior) ? [] : reports;
  const localTarget = await verifyStartInputs(repo, base, target.text, inputs, io);
  return {
    parsed,
    repo,
    base,
    localOnly,
    localTarget,
    target,
    repository,
    number,
    prior,
    hostPrior,
    reviewPrior,
    reports,
    revision,
    issue,
    original,
    rawIssue,
    requirements,
    inputs,
  };
}

function reusesCheckout(prior: unknown, hostPrior: unknown, reviewPrior: unknown) {
  return Boolean(prior || hostPrior || reviewPrior);
}

async function allocateDirectory(repo: string, common: string, dir: string, previous?: string) {
  assert(
    outside(repo, dir) && outside(common, dir),
    'Run directory must be outside checkout and Git storage',
  );
  await mkdir(resolve(dir, '..'), { recursive: true });
  await mkdir(dir); // Never reset an existing execution, budget, or uncertain publication.
  const canonical = await realpath(dir);
  assert(
    outside(repo, canonical) && outside(common, canonical),
    'Run directory resolves inside repository storage',
  );
  assert(
    !previous || outside(previous, canonical),
    'New revision evidence must be outside previous run',
  );
  return canonical;
}

async function prepare(
  args: string[],
  io: typeof runtime,
  allocated: (result: DevelopmentResult) => void,
  startedAt: string,
) {
  const {
    parsed,
    repo,
    base,
    localOnly,
    localTarget,
    target,
    repository,
    number,
    prior,
    hostPrior,
    reviewPrior,
    reports,
    revision,
    issue,
    original,
    rawIssue,
    requirements,
    inputs,
  } = await selectStart(args, io);
  const git = (...argv: string[]) => checked(io, ['git', ...argv], repo);
  const common = await realpath(
    await git('rev-parse', '--path-format=absolute', '--git-common-dir'),
  );
  const key = createHash('sha256').update(common).digest('hex').slice(0, 16);
  const dir = resolve(
    parsed.values['run-dir'] ?? join(homedir(), '.local/share/dotagents/development', key, number),
  );
  const canonical = await allocateDirectory(
    repo,
    common,
    dir,
    reviewPrior?.dir ?? hostPrior?.dir ?? prior?.dir,
  );
  const cwd = reusesCheckout(prior, hostPrior, reviewPrior) ? repo : join(canonical, 'checkout');
  const branch =
    reviewPrior?.branch ?? hostPrior?.branch ?? prior?.branch ?? `codex/development-${number}`;
  const result: DevelopmentResult = {
    startedAt,
    status: 'stopped',
    phase: 'preparation',
    operation: 'prepare worktree',
    reason: '',
    nextAction:
      'Inspect the reason and operation evidence; resolve the cause without resuming this run or resetting its limits.',
    repository,
    issue: `https://github.com/${repository}/issues/${number}`,
    startCommit: base,
    branch,
    checkout: cwd,
    evidence: canonical,
    details: canonical,
    publication: 'not_attempted',
    localOnly,
    ...(revision ? { url: revision.url } : {}),
    requiredChecks: target.config.ciChecks,
    remaining: [
      'local_verification',
      'publication',
      ...(target.config.ciChecks.length ? ['ci'] : []),
      'published_body_check',
      'mark_ready',
      'human_review',
    ],
  };
  allocated(result); // Only a newly created, canonical, safe directory can own a result.
  if (revision) {
    revision.runDirectory = canonical;
  }
  if (revision || hostPrior || reviewPrior) {
    await saveResult(result, undefined);
  }
  const remote = await git('remote', 'get-url', target.config.remote);
  await writeFile(join(dir, 'issue.json'), original);
  await writeFile(join(dir, 'issue.stdout'), rawIssue);
  await writeFile(join(dir, 'target.json'), JSON.stringify(target, null, 2));
  assert((await git('rev-parse', 'HEAD')) === base, 'Start HEAD changed during preparation');
  if (revision) {
    await writeFile(join(dir, 'revision-request.md'), revision.request);
  } else if (!hostPrior && !reviewPrior) {
    await git('worktree', 'add', '-b', branch, cwd, base);
    if (localTarget) {
      await writeFile(join(cwd, '.dotagents.json'), target.text, { flag: 'wx' });
    }
  }
  return {
    repo,
    number,
    issue,
    original,
    requirements,
    dir: canonical,
    result,
    cwd,
    branch,
    base,
    remote,
    localOnly,
    localTarget,
    target,
    reports,
    inputs,
    revision,
    hostReturn: hostPrior?.hostReturn,
    reviewPrior,
    reviewReturn: reviewPrior?.reviewReturn,
    reviewBase: reviewPrior?.baseCommit ?? hostPrior?.baseCommit ?? prior?.state.baseCommit ?? base,
  };
}
type Context = Awaited<ReturnType<typeof prepare>>;

async function unchangedTarget(
  context: Context,
  io: typeof runtime,
  head = context.base,
  target?: Context['target'],
) {
  assert(
    (await checked(io, ['git', 'rev-parse', 'HEAD'], context.cwd)) === head &&
      (await checked(io, ['git', 'branch', '--show-current'], context.cwd)) === context.branch,
    'Actor changed branch or HEAD',
  );
  const current =
    target ??
    (await readTarget(context.cwd, (argv, cwd) => checked(io, argv, cwd), !context.localOnly));
  assert(
    current.text === context.target.text &&
      current.repositoryId === context.target.repositoryId &&
      current.actor === context.target.actor,
    'Target configuration or GitHub actor changed',
  );
  await verifyTargetInput(context.cwd, context.base, context.target.text, io);
  return current;
}

async function revisionUnchanged(context: Context, io: typeof runtime, target?: Context['target']) {
  if (context.revision) {
    await checkRevision(context.revision, context.cwd, (argv, cwd) => checked(io, argv, cwd), {
      target,
    });
  }
}

function verificationConfig(context: Context): Config {
  const { cwd, dir } = context;
  return {
    baseCommit: context.reviewBase,
    ...(context.revision ? { revision: context.revision } : {}),
    reports: context.reports,
    targetText: context.target.text,
    ...(context.hostReturn ? { hostReturn: context.hostReturn } : {}),
    ...(context.reviewReturn ? { reviewReturn: context.reviewReturn } : {}),
    reviewModel,
    cwd,
    runDir: join(dir, 'verification'),
    issue: context.issue,
    check: targetCommand(context.target.config.check),
    ...(context.target.config.capture
      ? {
          capture: targetCommand(context.target.config.capture.command),
          captureDestination: context.target.config.capture.destination,
          captureRequired: context.target.config.capture.required,
        }
      : {}),
    test: [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'test', dir],
    testBaseline: join(dir, 'test-baseline'),
    setup: context.target.config.setup.map(targetCommand),
    repair: [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'repair', dir],
    review: [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'review', dir],
    checkTimeMs,
  };
}

async function stopForHost(
  context: Context,
  config: Config,
  findings: string,
  io: typeof runtime,
): Promise<never> {
  assert(
    issueText(await checkedOutput(io, context.issue, context.cwd)) === context.original,
    'Requirements changed during host handoff',
  );
  await saveHostStop({
    dir: context.dir,
    config,
    head: context.base,
    branch: context.branch,
    localOnly: context.localOnly,
    findings,
  });
  const argv = [
    process.execPath,
    resolve(import.meta.dir, 'development.ts'),
    context.number,
    '--repo',
    context.cwd,
    '--host-run',
    context.dir,
    '--host-evidence',
    'PATH',
    '--run-dir',
    'NEW_SIBLING',
    ...(context.localOnly ? ['--no-publish'] : []),
  ];
  context.result.reasonCode = 'host_verification_required';
  context.result.nextAction = `Assigned AI: read ${join(context.dir, 'host-stop.json')} and its referenced response, artifacts and findings. Execute the required verification within the agreed scope and existing host authority; keep raw logs outside checkout and this run. Update required summaries before checks. Then invoke this argument array after replacing PATH and NEW_SIBLING: ${JSON.stringify(argv)}. Never execute response commands automatically. Failure requires defect repair or environment resolution; only changed requirements or authority require a human decision. This handoff is not completion or acceptance.`;
  throw Error(`Host verification required: ${findings}`);
}

async function preparedHostTests(context: Context, contents: string[], intake: TestIntake) {
  return Promise.all(
    contents.map((content) =>
      readPreparedTestRecord(content, issueText(context.original), context.cwd, intake),
    ),
  );
}

async function returnedTests(context: Context) {
  const observation = new RecordObservation();
  const verified = context.hostReturn
    ? await verifyHostReturn(context.hostReturn, context.cwd, observation)
    : undefined;
  const manifest: Record<string, string> = {};
  const sourceBefore = context.hostReturn ? await snapshot(context.cwd, manifest) : undefined;
  assert(
    !verified || verified.source === sourceBefore,
    'Host evidence does not match current deliverables',
  );
  const records = await preparedHostTests(context, verified?.testRecordContents ?? [], {
    manifest,
    records: observation,
  });
  const evidence = [];
  const pendingImplementation = !verified?.implemented;
  let baseline: string | undefined;
  // 明示した最新の準備記録がある場合、古い記録で上書きしません。
  for (const entry of verified?.history ?? []) {
    const previousRun = entry.previousRun;
    const content = entry.records.get(join(previousRun, 'verification-config.json'));
    assert(content, 'ホスト復帰の設定参照がありません');
    const config: unknown = JSON.parse(content);
    assertConfig(config);
    baseline ??= config.testBaseline;
    const stateContent = entry.records.get(join(previousRun, 'verification/state.json'));
    if (records.length === 0 && stateContent) {
      const state: unknown = JSON.parse(stateContent);
      assertState(state);
      records.push(...(state.testRecords ?? []));
    }
    const testsContent = entry.records.get(join(previousRun, 'test-records.json'));
    if (records.length === 0 && testsContent) {
      records.push(...testRecordsShape.parse(JSON.parse(testsContent)));
    }
    // 任意のホスト生ログは会話・自己評価を含み得るためテストへ渡しません。
    evidence.push({
      source: entry.evidence.source,
      stdout: JSON.stringify({ hostVerificationStatus: entry.evidence.status }),
    });
  }
  return { baseline, records, evidence, pendingImplementation, sourceBefore };
}

async function recordHostPreparation(
  context: Context,
  config: Config,
  sourceBefore: string | undefined,
  sourceAfterTests: string | undefined,
  sourceAfter: string | undefined,
) {
  if (!context.hostReturn) {
    return;
  }
  assert(sourceBefore && sourceAfterTests && sourceAfter, 'ホスト復帰の版記録がありません');
  const path = join(context.dir, 'host-preparation.json');
  const content = JSON.stringify(
    {
      sourceBefore,
      sourceAfterTests,
      sourceAfter,
    },
    null,
    2,
  );
  await writeFile(path, content, { flag: 'wx' });
  config.hostPreparation = { path, sha256: hash(content) };
  await writeFile(join(context.dir, 'verification-config.json'), JSON.stringify(config, null, 2));
}

async function prepareIndependentTests(context: Context, testConfig: Config, io: typeof runtime) {
  const { cwd, dir, result: outcome } = context;
  assert(testConfig.testBaseline);
  if (context.hostReturn) {
    outcome.operation = 'host verification return';
    outcome.details = join(dir, 'host-return.json');
    await writeFile(outcome.details, JSON.stringify(context.hostReturn, null, 2), { flag: 'wx' });
    await writeFile(
      join(dir, 'host-current-artifacts.json'),
      JSON.stringify(await recordArtifacts(cwd, context.reviewBase), null, 2),
      { flag: 'wx' },
    );
    await writeFile(join(dir, 'verification-config.json'), JSON.stringify(testConfig, null, 2));
    await mkdir(testConfig.runDir, { recursive: true });
  }
  const returned = await returnedTests(context);
  if (context.hostReturn) {
    assert(
      returned.baseline,
      '旧runに独立テストの修正前入力がありません。旧runを変換・再開せず保全してください',
    );
    testConfig.testBaseline = returned.baseline;
    await writeFile(join(dir, 'verification-config.json'), JSON.stringify(testConfig, null, 2));
  } else {
    await prepareTestBaseline(cwd, testConfig.testBaseline, io.command);
  }
  return returned;
}

async function setup(context: Context, io: typeof runtime) {
  for (const [index, argv] of context.target.config.setup.entries()) {
    context.result.operation = `setup-${index + 1}`;
    context.result.details = join(context.dir, context.result.operation);
    await checked(io, targetCommand(argv), context.cwd, context.result.details);
  }
}

function testStage(context: Context) {
  return context.hostReturn ? 'host_return' : context.revision ? 'revision' : 'initial';
}

async function implement(context: Context, io: typeof runtime) {
  const { cwd, dir, original, result: outcome } = context;
  outcome.phase = 'implementation';
  outcome.operation = 'check revision before setup';
  await revisionUnchanged(context, io);
  await setup(context, io);
  outcome.operation = 'check implementation inputs';
  outcome.details = join(dir, 'target.json');
  const target = await unchangedTarget(context, io);
  await verifyStartReports(cwd, context.base, context.inputs, io);
  if (context.repo !== cwd) {
    await verifyStartInputs(context.repo, context.base, context.target.text, context.inputs, io);
  }
  await revisionUnchanged(context, io, target);
  if (context.revision && !context.hostReturn) {
    assert(
      !(await checked(
        io,
        [
          'git',
          '-c',
          'core.filemode=true',
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--',
          '.',
          ':(top,exclude).dotagents.json',
        ],
        cwd,
      )),
      'Setup left work in revision checkout; preserve it',
    );
  }
  const testConfig = verificationConfig(context);
  if (context.reviewPrior) {
    const prior = context.reviewPrior;
    await writeFile(
      join(dir, 'recovery-current-artifacts.json'),
      JSON.stringify(await recordArtifacts(cwd, context.reviewBase), null, 2),
      { flag: 'wx' },
    );
    await saveRecoveryProvenance(prior.reviewReturn, dir, prior.hostHistory);
    assert(prior.config.testBaseline);
    testConfig.testBaseline = prior.config.testBaseline;
    await verifyReviewReturn(prior.reviewReturn, cwd, testConfig.runDir);
    const manifest: Record<string, string> = {};
    assert(
      (await snapshot(cwd, manifest)) === prior.reviewReturn.source,
      '復帰前に成果物が変わりました',
    );
    await verifyTestArtifacts(cwd, prior.tests, manifest);
    await writeFile(join(dir, 'review-return.json'), JSON.stringify(prior.reviewReturn, null, 2), {
      flag: 'wx',
    });
    await writeFile(join(dir, 'test-records.json'), JSON.stringify(prior.tests), { flag: 'wx' });
    await writeFile(join(dir, 'verification-config.json'), JSON.stringify(testConfig, null, 2));
    await verify(context, testConfig, io);
    return testConfig;
  }
  assert(testConfig.test && testConfig.testBaseline);
  const returned = await prepareIndependentTests(context, testConfig, io);
  outcome.operation = 'independent test authoring';
  outcome.details = join(dir, 'test-1.target.json');
  const tests = await authorTests(
    {
      cwd,
      baseline: testConfig.testBaseline,
      prefix: join(dir, 'test-1'),
      issue: issueText(original),
      stage: testStage(context),
      revisionRequest: context.revision?.request,
      baseCommit: context.reviewBase,
      check: testConfig.check,
      setup: testConfig.setup,
      reports: testConfig.reports,
      actor: testConfig.test,
      previous: returned.records,
      evidence: returned.evidence,
    },
    io.command,
  );
  await writeFile(
    join(dir, 'test-records.json'),
    JSON.stringify([...returned.records, ...(tests.record ? [tests.record] : [])]),
    { flag: 'wx' },
  );
  if (tests.reply.status === 'needs_human') {
    outcome.reasonCode = 'human_decision_required';
    outcome.nextAction = tests.reply.findings;
    throw Error(`テスト工程で人の判断が必要です: ${tests.reply.findings}`);
  }
  if (tests.reply.status === 'needs_host') {
    await writeFile(join(dir, 'verification-config.json'), JSON.stringify(testConfig, null, 2));
    await stopForHost(context, testConfig, tests.reply.findings, io);
  }
  await unchangedTarget(context, io);
  assert(
    issueText(await checkedOutput(io, context.issue, cwd)) === issueText(original),
    'Requirements changed during test authoring',
  );
  const sourceAfterTests = context.hostReturn ? await snapshot(cwd) : undefined;
  if (context.hostReturn && !returned.pendingImplementation) {
    await recordHostPreparation(
      context,
      testConfig,
      returned.sourceBefore,
      sourceAfterTests,
      sourceAfterTests,
    );
    await verify(context, testConfig, io);
    return testConfig;
  }
  outcome.operation = 'initial implementation';
  outcome.details = join(dir, 'implementation');
  const prompt = [
    '既存のコードと検証資産を使い、合意済みIssue全体を実装してください。適用されるリポジトリ指示に従い、対象のREADMEと開発方針のうち今回の変更に関係する節を参照してください。',
    '合意範囲内の通常の選択について承認待ちで止まらず、合意した実装、必要なテストと文書、ホスト検証の準備に必要な範囲の確認を完了してください。十分な既存検証を再利用してください。Issueを変更したり、受入基準を弱めたりしないでください。',
    '文書だけのIssueにも同じ流れを使い、合意済みの要求で必要な場合だけテストやコードを追加してください。変更文書を既存の独立評価に含めてください。',
    repairInstructions(context.target.config.capture),
    `独立テストの記録: ${join(dir, 'test-1.json')}。findingsと成果物を読み、修正前の再現と実装後の成功・正常動作を区別してください。`,
    `対象のsetup/check/capture契約（弱めたり置き換えたりしないでください）: ${JSON.stringify(context.target.config)}`,
    'このcheckoutの外にある制御スクリプトや認証情報を編集しないでください。',
    `要求:\n${original}`,
    revisionContext(context.revision),
    hostReturnContext(context.hostReturn),
    `Issue: https://github.com/${context.target.config.repository}/issues/${context.number}`,
    researchContext(context.reviewBase, context.reports),
  ].join('\n');
  await writeFile(join(dir, 'implementation.prompt'), prompt);
  const actor = [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'repair', dir];
  const result = await io.command(actor, cwd, prompt, null, join(dir, 'implementation'), {
    ...process.env,
    DOTAGENTS_ACTOR_PREFIX: join(dir, 'implementation'),
  });
  await writeFile(
    join(dir, 'implementation.json'),
    JSON.stringify({ code: result.code, timedOut: result.timedOut, ms: result.ms }),
  );
  assert(!result.timedOut, `Initial implementation timed out; evidence: ${dir}`);
  assert(
    result.code === 0,
    `Initial implementation process failed (${result.code}); evidence: ${dir}`,
  );
  await verifyTestArtifacts(cwd, tests.record ? [tests.record] : []);
  const reply = parseRepairReply(result.stdout);
  assert(
    reply.status !== 'invalid',
    `Invalid implementation reply; inspect ${dir}/implementation.stdout`,
  );
  await writeFile(join(dir, 'implementation-summary.md'), reply.findings);
  if (reply.status === 'needs_human') {
    outcome.reasonCode = 'human_decision_required';
    outcome.nextAction =
      'Obtain the human decision described in the implementation findings; do not automatically retry.';
    throw Error(`Human decision required: ${reply.findings}`);
  }
  const config = testConfig;
  await writeFile(join(dir, 'verification-config.json'), JSON.stringify(config, null, 2));
  if (reply.status === 'needs_host') {
    await unchangedTarget(context, io);
    await stopForHost(context, config, reply.findings, io);
  }
  assert(
    issueText(await checkedOutput(io, context.issue, cwd)) === original,
    'Requirements changed during implementation',
  );

  await recordHostPreparation(
    context,
    config,
    returned.sourceBefore,
    sourceAfterTests,
    context.hostReturn ? await snapshot(cwd) : undefined,
  );
  await verify(context, config, io);
  return config;
}

const verificationActions: Record<Exclude<StopReason, 'ready_for_human_review'>, string> = {
  interrupted:
    '担当AI: 中断したプロセス・active予約・lock・公開状態を照合し、原記録を保持してください。旧runは再開せず、新しいrunで検証・評価してください。',
  host_evidence_changed:
    '担当AI: 旧記録と失敗runを保全し、証拠の変化・欠落・照合不能の原因を調べてください。--host-runからの復帰では元のホスト引き継ぎから新しい証拠と保存先で再評価します。--review-runからの復帰では旧記録を編集して条件を満たさず、初回不正評価の復帰条件へ照合してください。',
  host_verification_required:
    'Assigned AI: execute the requested host verification within existing authority, preserve evidence and return via --host-run with a new record.',
  review_completed:
    '評価試行の観測結果は開発の完了を意味しません。通常開発の検証記録を照合してください。',
  review_timeout: '評価試行の時間制限に到達しました。保存したログと対象を確認してください。',
  check_failed:
    '評価試行のcheckが失敗しました。指摘の有無を判断する前に検証ログを確認してください。',
  execution_limit:
    'Assigned AI: inspect consumed attempts, model time and unresolved findings; a human must decide any new scope or budget. Existing limits cannot be extended.',
  test_failed:
    '担当AI: テスト工程の原ログと作業場所を保全し、既存権限内で実行失敗の原因を解消してください。',
  invalid_test:
    '担当AI: テスト入力・応答・成果物の不一致を調べ、要求へ照合して新しいrunで検証してください。',
  repair_failed:
    'Assigned AI: inspect repair command stdout, stderr and exit evidence; investigate the actor environment within existing permissions before reassessment.',
  review_failed:
    'Assigned AI: inspect review command stdout, stderr and exit evidence; investigate the actor environment within existing permissions before reassessment.',
  requirements_changed:
    'Assigned AI: compare the current Issue with the recorded requirements; a human must agree any changed requirements or scope before new verification.',
  source_changed:
    'Assigned AI: identify the source changes against the recorded review target and check for concurrent writers; verify the intended deliverables again.',
  check_unavailable:
    '担当AI: checkの起動失敗・時間切れを原ログで調べてください。未公開・初回check時間切れ・未評価・未修正だけは、独立評価済みハーネスの--check-timeout-runと同じ親の新保存先で再検証できます。旧記録を編集せず、他の停止を転用しないでください。',
  capture_unavailable:
    'Assigned AI: inspect capture logs and configured runtime; the host must resolve missing browser, display or dependency support before required capture and verification.',
  capture_timeout:
    'Assigned AI: investigate capture timeout using retained logs and processes; the host must address environment problems within authorization. A human must decide any changed time limit.',
  invalid_review:
    '担当AI: 原応答・対象・行範囲・応答契約を照合し、信頼するハーネスの応答生成側を修正してください。未公開・履歴なし・追加修正なしの初回停止だけは--review-runと新しい--run-dirで検証できます。旧応答を編集・補正・再投入しないでください。',
  review_storage_failed:
    'Assigned AI: inspect the failed review save path, original error and raw response in state findings; the host must restore writable evidence storage. Previous complete reviewHistory is historical, not acceptance of this attempt.',
  invalid_repair:
    'Assigned AI: inspect the raw repair response against its response contract; correct the response producer before new verification.',
  human_decision_required:
    'Obtain the human decision described in the repair findings about requirements, scope, permissions or limits before further implementation.',
  target_changed_after_stop:
    'Assigned AI: reconcile current source and requirements with the retained terminal result; prior acceptance does not verify the changed target.',
};

async function verify(context: Context, config: Config, io: typeof runtime) {
  await unchangedTarget(context, io, context.result.commit ?? context.base);
  const result = context.result;
  result.phase = 'verification';
  result.operation = 'verification and independent review';
  result.details = join(config.runDir, 'state.json');
  result.nextAction =
    'Inspect verification/state.json and its referenced findings and logs; reconcile the stop without changing active reservations or limits, and obtain any required human decision.';
  const state: State = await io.verify(config, context.result.commit);
  const target = await readTarget(
    context.cwd,
    (argv, cwd) => checked(io, argv, cwd),
    !context.localOnly,
  );
  await revisionUnchanged(context, io, target);
  await unchangedTarget(context, io, context.result.commit ?? context.base, target);
  if (state.result === 'host_verification_required') {
    await stopForHost(context, config, state.findings ?? '', io);
  }
  if (state.result !== 'ready_for_human_review') {
    result.reasonCode = state.result ?? undefined;
    if (state.result) {
      result.nextAction = `${verificationActions[state.result]} Evidence: ${result.details} and its referenced findings, history and logs. Obtain permission for host environment changes outside existing authorization. After assistance, reconfirm target, evidence, authorization and verification. Do not resume this run or change old runs, locks, active reservations or limits; use only the documented new-run return path for the matching stop conditions. Do not retry uncertain publication automatically.`;
    }
    if (!result.remaining.includes('local_verification')) {
      result.remaining.unshift('local_verification');
    }
    throw Error(`Verification stopped: ${state.result}. ${state.findings ?? ''}`);
  }
  if (context.reviewReturn) {
    try {
      await verifyReviewReturn(
        context.reviewReturn,
        context.cwd,
        config.runDir,
        context.result.commit,
      );
    } catch (error) {
      result.reasonCode = 'host_evidence_changed';
      result.nextAction = verificationActions.host_evidence_changed;
      throw error;
    }
  }
  return { state, target };
}

async function checkBranchPulls(context: Context, io: typeof runtime) {
  const repository = context.target.config.repository;
  const pages: unknown = JSON.parse(
    await checked(
      io,
      [
        'gh',
        'api',
        `repos/${repository}/pulls`,
        '--method',
        'GET',
        '-f',
        'state=open',
        '-f',
        `head=${repository.split('/')[0]}:${context.branch}`,
        '--paginate',
        '--slurp',
      ],
      context.cwd,
    ),
  );
  assert(Array.isArray(pages) && pages.every(Array.isArray), 'Invalid branch PR response');
  for (const pr of pages.flat()) {
    assert(
      isRecord(pr) &&
        typeof pr.html_url === 'string' &&
        isRecord(pr.head) &&
        typeof pr.head.ref === 'string' &&
        isRecord(pr.head.repo) &&
        typeof pr.head.repo.full_name === 'string',
      'Invalid branch PR response',
    );
    if (pr.head.repo.full_name === repository && pr.head.ref === context.branch) {
      assert(
        pr.html_url === context.revision?.url,
        `Open PR already uses this branch: ${pr.html_url}; reconcile other PRs before pushing`,
      );
    }
  }
}

async function stageDeliverables(context: Context, io: typeof runtime) {
  await checked(
    io,
    // リテラルの除外pathspecはignoredパスの明示指定としてGitに拒否されるため、同じ名前をglobで指定する。
    ['git', 'add', '--all', '--', '.', ':(top,exclude,glob)[.]dotagents.json'],
    context.cwd,
  );
}

async function ship(
  context: Context,
  config: Awaited<ReturnType<typeof implement>>,
  io: typeof runtime,
) {
  const { cwd, dir, number, branch, requirements, result } = context;
  const { repository, remote: remoteName, baseBranch } = context.target.config;
  result.phase = 'publication';
  result.operation = 'check publication inputs';
  result.details = join(dir, 'target.json');
  result.nextAction =
    'Inspect the reason and reconcile publication inputs, permissions and the current target before any further write.';
  const git = (...args: string[]) => checked(io, ['git', ...args], cwd);
  assert((await git('remote', 'get-url', remoteName)) === context.remote, 'Actor changed remote');
  const changed = await git('status', '--porcelain', '--', '.', ':(top,exclude).dotagents.json');
  assert(changed.length > 0, 'No implementation changes; no PR created');
  // Reuse the controller's source/Issue check immediately before publication.
  const { state: verified } = await verify(context, config, io);
  result.phase = 'publication';
  result.operation = 'commit and prepare PR';
  result.details = join(dir, 'pr.md');
  result.nextAction =
    'Inspect the reason, checkout and publication evidence; reconcile the Git and GitHub state before any further write.';
  await stageDeliverables(context, io);
  await git('commit', '-m', `${requirements.title} (#${number})`);
  const commit = await git('rev-parse', 'HEAD');
  result.commit = commit;
  const files = (
    await git('diff-tree', '--no-commit-id', '--name-only', '--diff-filter=AM', '-z', '-r', 'HEAD')
  ).split('\0');
  const destination = context.target.config.capture?.destination;
  const media = files.filter(
    (file) =>
      destination &&
      file.startsWith(`${destination}/`) &&
      /\.(png|jpe?g|webp|mp4|webm)$/i.test(file),
  );
  if (media.length) {
    result.remaining.push('attachments', 'rendered_media_check');
  }
  const body = join(dir, 'pr.md');
  const localRoots = [
    cwd,
    dir,
    ...(context.revision ? [context.revision.previousRun] : []),
    ...(await hostLocalRoots(
      context.hostReturn ?? context.reviewReturn ?? context.revision?.reviewReturn,
    )),
  ];
  await writeFile(
    body,
    prBody({
      review: verified.reviewHistory.at(-1),
      localTarget: context.localTarget,
      repository,
      number,
      commit,
      check: context.target.config.check,
      ciChecks: context.target.config.ciChecks,
      media,
      localRoots,
    }),
  );
  const bodyText = await readFile(body, 'utf8');
  assert(bodyText.includes(`Closes #${number}`), 'Generated PR lost Issue reference');
  assert(bodyText.includes(commit), 'Generated PR lost verified commit');
  const { target } = await verify(context, config, io);
  result.phase = 'publication';
  result.operation = 'push';
  result.details = body;
  result.nextAction =
    'Inspect the publication evidence and GitHub branch state before any further write; PR creation has not been attempted.';
  const push = await pushArguments(repository, branch, commit, cwd, (argv, path) =>
    checked(io, argv, path),
  );
  await checkBranchPulls(context, io);
  if (context.revision) {
    result.operation = 'confirm revision draft';
    result.publication = 'unconfirmed';
    result.nextAction =
      'Reconcile the existing PR draft state, remote ref and body before any further write; draft conversion, push or body update may have succeeded. Do not retry automatically or restore ready.';
    await saveResult(result, undefined);
    await checkRevision(
      context.revision,
      cwd,
      (argv, path) =>
        checked(io, argv, path, argv[2] === 'ready' ? join(dir, 'pr-draft') : undefined),
      {
        target,
        draft: 'ensure',
      },
    );
  }
  result.operation = 'push';
  await checked(io, push, cwd, join(dir, 'push'));
  result.operation = 'publish PR';
  result.publication = 'unconfirmed';
  result.nextAction =
    'Check the actual PR, author, body and branch on GitHub before any further write; do not automatically recreate the PR or repeat attachments.';
  let url: string;
  try {
    url = await io.publish({
      cwd,
      actor: context.target.actor,
      head: branch,
      commit,
      title: requirements.title,
      bodyFile: body,
      revision: context.revision,
    });
  } catch (error) {
    if (error instanceof PublicationError) {
      result.url = error.url;
    }
    throw error;
  }
  result.url = url;
  result.publication = 'published';
  result.remaining = result.remaining.filter((task) => task !== 'publication');
  result.nextAction =
    'Inspect the existing PR and attachment state on GitHub, then confirm CI for this commit; do not automatically recreate the PR or repeat attachments.';
  await writeFile(join(dir, 'pr-url.txt'), url);
  if (media.length) {
    result.operation = 'attach media';
    result.details = join(dir, 'attachments');
    const target = await unchangedTarget(context, io, commit);
    if (context.revision) {
      await checkRevision(context.revision, cwd, (argv, path) => checked(io, argv, path), {
        head: commit,
        body: bodyText,
        target,
        draft: 'require',
      });
    } else {
      await checkPublishedPr(
        {
          cwd,
          repository,
          url,
          actor: target.actor,
          body: bodyText,
          head: branch,
          base: baseBranch,
          commit,
        },
        (argv, path) => checked(io, argv, path),
      );
    }
    await checked(
      io,
      [
        'gh',
        'pr',
        'edit',
        url,
        '--repo',
        repository,
        ...media.flatMap((file) => ['--attach', resolve(cwd, file)]),
      ],
      cwd,
      join(dir, 'attachments'),
    );
  }
  result.remaining = result.remaining.filter((task) => task !== 'attachments');
  result.phase = 'ci';
  result.operation = 'confirm published target and CI';
  result.details = dir;
  const ciTarget = {
    cwd,
    repository,
    url,
    commit,
    baseBranch,
    dir,
    ciChecks: context.target.config.ciChecks,
    issue: number,
  };
  const ci = await waitForCi(ciTarget, io.command, hostCommandTimeMs);
  result.ci = ci.status;
  result.ciDetails = ci;
  result.reasonCode = ci.status;
  result.reason = ci.reason;
  result.nextAction = ci.nextAction;
  if (ci.status === 'passed') {
    result.status = 'published_draft';
    result.remaining = result.remaining.filter((task) => task !== 'ci');
  }
}

export async function develop(args: string[], io = runtime) {
  const startedAt = new Date().toISOString();
  let result: DevelopmentResult | undefined;
  let failure: unknown;
  try {
    const context = await prepare(
      args,
      io,
      (allocated) => {
        result = allocated;
      },
      startedAt,
    );
    const outcome = context.result;
    console.error(
      `Development #${context.number}; checkout: ${context.cwd}; evidence: ${context.dir}`,
    );
    console.error('Implementing, checking and independently reviewing the Issue');
    const config = await implement(context, io);
    outcome.remaining = outcome.remaining.filter((task) => task !== 'local_verification');
    if (context.localOnly) {
      outcome.status = 'verified_local';
      outcome.reasonCode = 'ready_for_human_review';
      outcome.reason = 'Local check and independent review accepted the current deliverables.';
      outcome.nextAction =
        'Review the verified deliverables; draft publication, configured CI, published body and any rendered media checks, ready transition and human review remain.';
    } else {
      console.error('Verified; committing, publishing and checking CI');
      await ship(context, config, io);
    }
  } catch (error) {
    failure = error;
    if (!result) {
      throw new Error(
        `${errorMessage(error)}; result not saved: no safe new run directory was confirmed.`,
        { cause: error },
      );
    }
    result.reason = errorMessage(error);
  }
  assert(result);
  result.finishedAt = new Date().toISOString();
  result.terminal = true;
  await saveResult(result, failure);
  let report: string;
  try {
    report = await writeRunReport(result.evidence);
  } catch (error) {
    const regenerate = [
      'bun',
      resolve(import.meta.dir, 'run-report.ts'),
      result.evidence,
      '--output',
      join(result.evidence, 'report-new.html'),
    ]
      .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
      .join(' ');
    throw new Error(
      `Run ${result.status}: ${result.reason}. Result remains in ${join(result.evidence, 'result.json')}; report generation failed: ${errorMessage(error)}. Regenerate from saved records with ${regenerate}`,
      { cause: new AggregateError([failure ?? result.reason, error]) },
    );
  }
  if (io === runtime) {
    console.error(`Local run report: ${report}`);
  }
  if (result.status === 'stopped') {
    throw new Error(
      `${result.reasonCode ?? 'stopped'}: ${result.reason} Next: ${result.nextAction} Result: ${join(result.evidence, 'result.json')}`,
      { cause: failure },
    );
  }
  return result;
}

function recordInterruption(result: DevelopmentResult) {
  try {
    assertRunning();
    return false;
  } catch (error) {
    const reason = errorMessage(error);
    if (result.status !== 'stopped') {
      result.reason = '';
      delete result.reasonCode;
    }
    result.status = 'stopped';
    if (!result.reason.includes(reason)) {
      result.reason = [result.reason, reason].filter(Boolean).join('; ');
      result.nextAction =
        'Reconcile existing process, retained evidence and Git/GitHub state before any further write; do not resume this run or reset its limits. ' +
        result.nextAction;
    }
    return true;
  }
}

async function saveResult(result: DevelopmentResult, failure: unknown) {
  const path = join(result.evidence, 'result.json');
  const save = async () => {
    // 完成したJSONだけを結果の入口へrenameする。
    await writeFile(`${path}.tmp`, JSON.stringify(result, null, 2), { flag: 'wx' });
    await rename(`${path}.tmp`, path);
  };
  const interrupted = recordInterruption(result);
  try {
    await save();
    // Only a newly observed interruption needs a second terminal save, never a rerun.
    if (!interrupted && recordInterruption(result)) {
      await save();
    }
  } catch (error) {
    recordInterruption(result);
    throw new Error(
      `${result.reason}; result not saved at ${path}: ${errorMessage(error)}. Inspect the retained evidence and reconcile the storage failure.`,
      { cause: new AggregateError([failure ?? result.reason, error]) },
    );
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function reviewEntry(parsed: ReturnType<typeof parseStart>) {
  return {
    directory:
      parsed.values['review-run'] ??
      parsed.values['interrupted-run'] ??
      parsed.values['check-timeout-run'],
    checkTimeout: Boolean(parsed.values['check-timeout-run']),
    interrupted: Boolean(parsed.values['interrupted-run']),
    evidenceFile: parsed.values['interrupted-run'] ? parsed.values['host-evidence'] : undefined,
  };
}

async function saveRecoveryProvenance(
  input: NonNullable<Config['reviewReturn']>,
  dir: string,
  history: NonNullable<Context['reviewPrior']>['hostHistory'],
) {
  if (history) {
    await writeFile(join(dir, 'recovery-host-history.json'), JSON.stringify(history, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const stopped = input.interruption ?? input.checkTimeout;
  if (!stopped) {
    return;
  }
  const observations = await Promise.all(
    stopped.observations.map(async (ref) => ({
      ...ref,
      content: await readReference(ref),
    })),
  );
  await writeFile(join(dir, 'recovery-observations.json'), JSON.stringify(observations, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
}
