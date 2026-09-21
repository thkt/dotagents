import assert from 'node:assert/strict';
import { reviewModel } from './review.ts';
import { prBody } from './pr-body.ts';
import { mkdir, readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { run, snapshot } from './correction.ts';
import { previousRun, checkRevision, revisionContext } from './revision.ts';
import type { Revision } from './revision.ts';
import { parseRepairReply, repairInstructions } from './repair.ts';
import { command, assertRunning, withInterrupts } from './process.ts';
import { isRecord, outside } from './values.ts';
import { publish, checkPublishedPr, PublicationError } from './publish.ts';
import { waitForCi } from './ci.ts';
import type { CiResult } from './ci.ts';
import { readTarget, issueNumber, targetCommand, pushArguments } from './target.ts';
import { researchContext, researchHandoff, verifyReports } from './research-handoff.ts';
import type { Config, State, ReportReference, StopReason } from './input.ts';
import { knowledgeReferences, readKnowledge } from './knowledge.ts';

const runtime = { command, verify: run, publish };
// Applied separately to each local verification command and the CI wait.
const checkTimeMs = 540000;
// General commands and post-publication target checks retain their 11-minute limit.
const hostCommandTimeMs = 660000;

type DevelopmentResult = {
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
  url?: string;
  commit?: string;
  requiredChecks: string[];
  ci?: CiResult['status'];
  ciDetails?: CiResult;
  remaining: string[];
};

async function checked(io: typeof runtime, argv: string[], cwd: string, prefix?: string) {
  const result = await io.command(argv, cwd, '', hostCommandTimeMs, prefix);
  assert(result.code === 0 && !result.timedOut, `Command failed: ${argv[0]}; ${result.stderr}`);
  return result.stdout.trim();
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

async function verifyStartInputs(
  repo: string,
  base: string,
  targetText: string,
  reports: ReportReference[],
  io: typeof runtime,
) {
  const git = (...args: string[]) => checked(io, ['git', ...args], repo);
  assert((await git('rev-parse', 'HEAD')) === base, 'Start HEAD changed during preparation');
  const entry = await git('ls-tree', base, '--', '.dotagents.json');
  assert(
    /^100(?:644|755) blob /.test(entry) &&
      (await git('hash-object', '--no-filters', '--', '.dotagents.json')) ===
        entry.split(/\s/)[2] &&
      (await readFile(join(repo, '.dotagents.json'), 'utf8')) === targetText,
    'Target configuration differs from start commit',
  );
  await verifyReports(repo, base, reports, git);
  assert(
    (
      await git(
        '-c',
        'core.filemode=true',
        'status',
        '--porcelain',
        '--',
        '.dotagents.json',
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
    };
    assert(
      base === prior.head && (await snapshot(repo)) === prior.state.source,
      'Checkout differs from previous verified published head',
    );
    revision.body = await checkRevision(revision, repo, (argv, cwd) => checked(io, argv, cwd), {
      captureBody: true,
    });
    assert(
      !(await git('-c', 'core.filemode=true', 'status', '--porcelain', '--untracked-files=all')),
      'Revision requires clean tracked and untracked work; preserve existing work',
    );
  }
  return revision;
}

async function selectStart(args: string[], io: typeof runtime) {
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
    },
  });
  assert(
    parsed.positionals.length === 1,
    'Usage: bun scripts/development.ts ISSUE [--repo CHECKOUT] [--run-dir DIRECTORY] [--start-commit SHA --report research/NAME.md=BLOB] [--previous-run DIRECTORY --request-file PATH]',
  );
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
  assert(
    Boolean(parsed.values['previous-run']) === Boolean(parsed.values['request-file']),
    'Revision requires --previous-run and --request-file',
  );
  assert(
    !parsed.values['previous-run'] || (!parsed.values['start-commit'] && !parsed.values.report),
    'Revision inherits references from previous run',
  );
  const prior = parsed.values['previous-run']
    ? await previousRun(parsed.values['previous-run'], repo, number, target)
    : undefined;
  const reports =
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
  const original = await checked(io, issue, repo);
  const requirements = issueValue(original);
  const revision = await prepareRevision(
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
  const references = knowledgeReferences(original);
  const inputs = prior ? [] : [...reports, ...references];
  await verifyStartInputs(repo, base, target.text, inputs, io);
  const knowledge = await readKnowledge(references, git);
  return {
    parsed,
    repo,
    base,
    localOnly,
    target,
    repository,
    number,
    prior,
    reports,
    revision,
    issue,
    original,
    requirements,
    inputs,
    knowledge,
  };
}

async function prepare(
  args: string[],
  io: typeof runtime,
  allocated: (result: DevelopmentResult) => void,
) {
  const {
    parsed,
    repo,
    base,
    localOnly,
    target,
    repository,
    number,
    prior,
    reports,
    revision,
    issue,
    original,
    requirements,
    inputs,
    knowledge,
  } = await selectStart(args, io);
  const git = (...argv: string[]) => checked(io, ['git', ...argv], repo);
  const common = await realpath(
    await git('rev-parse', '--path-format=absolute', '--git-common-dir'),
  );
  const key = createHash('sha256').update(common).digest('hex').slice(0, 16);
  const dir = resolve(
    parsed.values['run-dir'] ?? join(homedir(), '.local/share/dotagents/development', key, number),
  );
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
    !prior || outside(prior.dir, canonical),
    'New revision evidence must be outside previous run',
  );
  const cwd = prior ? repo : join(canonical, 'checkout');
  const branch = prior?.branch ?? `codex/development-${number}`;
  const result: DevelopmentResult = {
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
    await saveResult(result, undefined);
  }
  const remote = await git('remote', 'get-url', target.config.remote);
  await writeFile(join(dir, 'issue.json'), original);
  await writeFile(join(dir, 'target.json'), JSON.stringify(target, null, 2));
  assert((await git('rev-parse', 'HEAD')) === base, 'Start HEAD changed during preparation');
  if (revision) {
    await writeFile(join(dir, 'revision-request.md'), revision.request);
  } else {
    await git('worktree', 'add', '-b', branch, cwd, base);
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
    target,
    reports,
    inputs,
    knowledge,
    revision,
    reviewBase: prior?.state.baseCommit ?? base,
  };
}
type Context = Awaited<ReturnType<typeof prepare>>;

async function unchangedTarget(context: Context, io: typeof runtime, head = context.base) {
  assert(
    (await checked(io, ['git', 'rev-parse', 'HEAD'], context.cwd)) === head &&
      (await checked(io, ['git', 'branch', '--show-current'], context.cwd)) === context.branch,
    'Actor changed branch or HEAD',
  );
  const current = await readTarget(
    context.cwd,
    (argv, cwd) => checked(io, argv, cwd),
    !context.localOnly,
  );
  assert(
    current.text === context.target.text &&
      current.repositoryId === context.target.repositoryId &&
      current.actor === context.target.actor,
    'Target configuration or GitHub actor changed',
  );
  return current;
}

async function revisionUnchanged(context: Context, io: typeof runtime, target?: Context['target']) {
  if (context.revision) {
    await checkRevision(context.revision, context.cwd, (argv, cwd) => checked(io, argv, cwd), {
      target,
    });
  }
}

async function implement(context: Context, io: typeof runtime) {
  const { cwd, dir, original, result: outcome } = context;
  outcome.phase = 'implementation';
  outcome.operation = 'check revision before setup';
  await revisionUnchanged(context, io);
  for (const [index, argv] of context.target.config.setup.entries()) {
    outcome.operation = `setup-${index + 1}`;
    outcome.details = join(dir, outcome.operation);
    await checked(io, targetCommand(argv), cwd, outcome.details);
  }
  outcome.operation = 'check implementation inputs';
  outcome.details = join(dir, 'target.json');
  const target = await unchangedTarget(context, io);
  for (const checkout of new Set([cwd, context.repo])) {
    await verifyStartInputs(checkout, context.base, context.target.text, context.inputs, io);
  }
  await revisionUnchanged(context, io, target);
  if (context.revision) {
    assert(
      !(await checked(
        io,
        ['git', '-c', 'core.filemode=true', 'status', '--porcelain', '--untracked-files=all'],
        cwd,
      )),
      'Setup left work in revision checkout; preserve it',
    );
  }
  outcome.operation = 'initial implementation';
  outcome.details = join(dir, 'implementation');
  const prompt = [
    'Implement the complete agreed Issue using existing code and verification assets. Follow applicable repository instructions; consult the target README and development policy sections relevant to this change.',
    'Complete the agreed implementation, needed tests and documentation, and targeted checks needed to prepare it for host verification without pausing for approval of routine choices within scope; reuse sufficient existing verification. Do not change the Issue or weaken acceptance criteria.',
    'Documentation-only Issues use the same flow; add tests or code only when the agreed requirements need them. Include changed documents in the existing independent review.',
    repairInstructions(context.target.config.capture),
    `Target setup/check/capture contract (do not weaken or replace): ${JSON.stringify(context.target.config)}`,
    'Do not edit control scripts or credentials outside this checkout.',
    `Requirements:\n${original}`,
    revisionContext(context.revision),
    `Issue: https://github.com/${context.target.config.repository}/issues/${context.number}`,
    researchContext(context.reviewBase, context.reports, context.knowledge),
  ].join('\n');
  await writeFile(join(dir, 'implementation.prompt'), prompt);
  const actor = [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'repair', dir];
  const result = await io.command(actor, cwd, prompt, null, join(dir, 'implementation'));
  await writeFile(
    join(dir, 'implementation.json'),
    JSON.stringify({ code: result.code, timedOut: result.timedOut, ms: result.ms }),
  );
  assert(!result.timedOut, `Initial implementation timed out; evidence: ${dir}`);
  assert(
    result.code === 0,
    `Initial implementation process failed (${result.code}); evidence: ${dir}`,
  );
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
  assert(
    (await checked(io, context.issue, cwd)) === original,
    'Requirements changed during implementation',
  );
  const config = {
    baseCommit: context.reviewBase,
    ...(context.revision ? { revision: context.revision } : {}),
    reports: context.reports,
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
    repair: actor,
    review: [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'review', dir],
    repairLimit: null,
    reviewLimit: null,
    modelTimeMs: null,
    checkTimeMs,
  };
  await writeFile(join(dir, 'verification-config.json'), JSON.stringify(config, null, 2));
  await verify(context, config, io);
  return config;
}

const verificationActions: Record<Exclude<StopReason, 'ready_for_human_review'>, string> = {
  execution_limit:
    'Assigned AI: inspect consumed attempts, model time and unresolved findings; a human must decide any new scope or budget. Existing limits cannot be extended.',
  repair_failed:
    'Assigned AI: inspect repair command stdout, stderr and exit evidence; investigate the actor environment within existing permissions before reassessment.',
  review_failed:
    'Assigned AI: inspect review command stdout, stderr and exit evidence; investigate the actor environment within existing permissions before reassessment.',
  requirements_changed:
    'Assigned AI: compare the current Issue with the recorded requirements; a human must agree any changed requirements or scope before new verification.',
  source_changed:
    'Assigned AI: identify the source changes against the recorded review target and check for concurrent writers; verify the intended deliverables again.',
  check_unavailable:
    'Assigned AI: investigate check startup or timeout from its command logs; the host must resolve execution environment problems within existing authorization before verification.',
  capture_unavailable:
    'Assigned AI: inspect capture logs and configured runtime; the host must resolve missing browser, display or dependency support before required capture and verification.',
  capture_timeout:
    'Assigned AI: investigate capture timeout using retained logs and processes; the host must address environment problems within authorization. A human must decide any changed time limit.',
  invalid_review:
    'Assigned AI: compare the raw review response with its target, document references and response contract; correct the response producer before new independent evaluation.',
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
  const result = context.result;
  result.phase = 'verification';
  result.operation = 'verification and independent review';
  result.details = join(config.runDir, 'state.json');
  result.nextAction =
    'Inspect verification/state.json and its referenced findings and logs; reconcile the stop without changing active reservations or limits, and obtain any required human decision.';
  const state: State = await io.verify(config);
  await revisionUnchanged(context, io);
  if (state.result !== 'ready_for_human_review') {
    result.reasonCode = state.result ?? undefined;
    if (state.result) {
      result.nextAction = `${verificationActions[state.result]} Evidence: ${result.details} and its referenced findings, history and logs. Obtain permission for host environment changes outside existing authorization. After assistance, reconfirm target, evidence, authorization and verification. Do not resume this run or change old runs, locks, active reservations or limits; the current entry point cannot resume a stopped run. Do not retry uncertain publication automatically.`;
    }
    if (!result.remaining.includes('local_verification')) {
      result.remaining.unshift('local_verification');
    }
    throw Error(`Verification stopped: ${state.result}. ${state.findings ?? ''}`);
  }
  return state;
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
  await unchangedTarget(context, io);
  const git = (...args: string[]) => checked(io, ['git', ...args], cwd);
  assert((await git('remote', 'get-url', remoteName)) === context.remote, 'Actor changed remote');
  const changed = await git('status', '--porcelain');
  assert(changed.length > 0, 'No implementation changes; no PR created');
  // Reuse the controller's source/Issue check immediately before publication.
  const verified = await verify(context, config, io);
  result.phase = 'publication';
  result.operation = 'commit and prepare PR';
  result.details = join(dir, 'pr.md');
  result.nextAction =
    'Inspect the reason, checkout and publication evidence; reconcile the Git and GitHub state before any further write.';
  await git('add', '--all');
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
  await writeFile(
    body,
    prBody({
      review: verified.reviewHistory.at(-1),
      repository,
      number,
      commit,
      check: context.target.config.check,
      ciChecks: context.target.config.ciChecks,
      media,
      localRoots: [cwd, dir, ...(context.revision ? [context.revision.previousRun] : [])],
    }),
  );
  const bodyText = await readFile(body, 'utf8');
  assert(bodyText.includes(`Closes #${number}`), 'Generated PR lost Issue reference');
  assert(bodyText.includes(commit), 'Generated PR lost verified commit');
  await verify(context, config, io);
  result.phase = 'publication';
  result.operation = 'push';
  result.details = body;
  result.nextAction =
    'Inspect the publication evidence and GitHub branch state before any further write; PR creation has not been attempted.';
  const target = await unchangedTarget(context, io, commit);
  const push = await pushArguments(repository, branch, cwd, (argv, path) =>
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
  const ci = await waitForCi(ciTarget, io.command, hostCommandTimeMs, checkTimeMs);
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
  let result: DevelopmentResult | undefined;
  let failure: unknown;
  try {
    const context = await prepare(args, io, (allocated) => {
      result = allocated;
    });
    const outcome = context.result;
    console.error(
      `Development #${context.number}; checkout: ${context.cwd}; evidence: ${context.dir}`,
    );
    console.error('Implementing, checking and independently reviewing the Issue');
    const config = await implement(context, io);
    outcome.remaining = outcome.remaining.filter((task) => task !== 'local_verification');
    if (context.localOnly) {
      await unchangedTarget(context, io);
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
  await saveResult(result, failure);
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
    // Like correction state, only complete JSON is renamed into the result entry point.
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

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(await withInterrupts(() => develop(process.argv.slice(2))), null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
