import assert from 'node:assert/strict';
import { reviewModel } from './review.ts';
import { prBody } from './pr-body.ts';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { run } from './correction.ts';
import { parseRepairReply, repairInstructions } from './repair.ts';
import { command, withInterrupts } from './process.ts';
import { isRecord, outside } from './values.ts';
import { publish } from './publish.ts';
import { waitForCi } from './ci.ts';
import { readTarget, issueNumber, targetCommand, pushArguments } from './target.ts';
import { researchContext, researchHandoff, verifyReports } from './research-handoff.ts';
import type { ReportReference } from './input.ts';
import { knowledgeReferences, readKnowledge } from './knowledge.ts';

const runtime = { command, verify: run, publish };
// Applied separately to each local verification command and the CI wait.
const checkTimeMs = 540000;
// General commands and post-publication target checks retain their 11-minute limit.
const hostCommandTimeMs = 660000;

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

async function prepare(args: string[], io: typeof runtime) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      'run-dir': { type: 'string' },
      'no-publish': { type: 'boolean' },
      'start-commit': { type: 'string' },
      report: { type: 'string', multiple: true },
    },
  });
  assert(
    parsed.positionals.length === 1,
    'Usage: bun scripts/development.ts ISSUE [--repo CHECKOUT] [--run-dir DIRECTORY] [--start-commit SHA --report research/NAME.md=BLOB]',
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
  const reports = researchHandoff(base, parsed.values['start-commit'], parsed.values.report ?? []);
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
  const references = knowledgeReferences(original);
  const inputs = [...reports, ...references];
  await verifyStartInputs(repo, base, target.text, inputs, io);
  const knowledge = await readKnowledge(references, git);
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
  const remote = await git('remote', 'get-url', target.config.remote);
  const cwd = join(canonical, 'checkout');
  const branch = `codex/development-${number}`;
  await writeFile(join(dir, 'issue.json'), original);
  await writeFile(join(dir, 'target.json'), JSON.stringify(target, null, 2));
  assert((await git('rev-parse', 'HEAD')) === base, 'Start HEAD changed during preparation');
  await git('worktree', 'add', '-b', branch, cwd, base);
  return {
    repo,
    number,
    issue,
    original,
    requirements,
    dir,
    cwd,
    branch,
    base,
    remote,
    localOnly,
    target,
    reports,
    inputs,
    knowledge,
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
}

async function implement(context: Context, io: typeof runtime) {
  const { cwd, dir, original } = context;
  for (const [index, argv] of context.target.config.setup.entries()) {
    await checked(io, targetCommand(argv), cwd, join(dir, `setup-${index + 1}`));
  }
  await unchangedTarget(context, io);
  await verifyStartInputs(cwd, context.base, context.target.text, context.inputs, io);
  await verifyStartInputs(context.repo, context.base, context.target.text, context.inputs, io);
  const prompt = [
    'Implement the complete agreed Issue using existing code and verification assets. Follow applicable repository instructions; consult the target README and development policy sections relevant to this change.',
    'Complete the agreed implementation, needed tests and documentation, and targeted checks needed to prepare it for host verification without pausing for approval of routine choices within scope; reuse sufficient existing verification. Do not change the Issue or weaken acceptance criteria.',
    'Documentation-only Issues use the same flow; add tests or code only when the agreed requirements need them. Include changed documents in the existing independent review.',
    repairInstructions(context.target.config.capture),
    `Target setup/check/capture contract (do not weaken or replace): ${JSON.stringify(context.target.config)}`,
    'Do not edit control scripts or credentials outside this checkout. If scope or authorization must change, return needs_human with the concrete decision and its impact. If an instruction file caused that stop, identify the file actually read, quote the relevant instruction and distinguish its explicit requirement from your interpretation. Otherwise return repaired with a concrete summary.',
    `Requirements:\n${original}`,
    `Issue: https://github.com/${context.target.config.repository}/issues/${context.number}`,
    researchContext(context.base, context.reports, context.knowledge),
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
  assert(
    reply.status !== 'needs_human',
    `Human decision required: ${reply.findings}; evidence: ${dir}`,
  );
  assert(
    (await checked(io, context.issue, cwd)) === original,
    'Requirements changed during implementation',
  );
  const config = {
    baseCommit: context.base,
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
    repairLimit: 2,
    reviewLimit: 2,
    modelTimeMs: null,
    checkTimeMs,
  };
  await writeFile(join(dir, 'verification-config.json'), JSON.stringify(config, null, 2));
  const resultState = await io.verify(config);
  assert(
    resultState.result === 'ready_for_human_review',
    `Verification stopped: ${resultState.result}. ${resultState.findings ?? ''} Evidence: ${config.runDir}`,
  );
  await writeFile(
    join(dir, 'verification-summary.md'),
    resultState.findings ?? 'Local check and independent review accepted the current deliverables.',
  );
  return config;
}

async function ship(
  context: Context,
  config: Awaited<ReturnType<typeof implement>>,
  io: typeof runtime,
) {
  const { cwd, dir, number, branch, requirements } = context;
  const { repository, remote: remoteName, baseBranch } = context.target.config;
  await unchangedTarget(context, io);
  const git = (...args: string[]) => checked(io, ['git', ...args], cwd);
  assert((await git('remote', 'get-url', remoteName)) === context.remote, 'Actor changed remote');
  const changed = await git('status', '--porcelain');
  assert(changed.length > 0, 'No implementation changes; no PR created');
  // Reuse the controller's source/Issue check immediately before publication.
  const verified = await io.verify(config);
  assert(verified.result === 'ready_for_human_review', 'Verified source or requirements changed');
  await git('add', '--all');
  await git('commit', '-m', `${requirements.title} (#${number})`);
  const commit = await git('rev-parse', 'HEAD');
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
      localRoots: [cwd, dir],
    }),
  );
  const bodyText = await readFile(body, 'utf8');
  assert(bodyText.includes(`Closes #${number}`), 'Generated PR lost Issue reference');
  assert(bodyText.includes(commit), 'Generated PR lost verified commit');
  assert(
    (await io.verify(config)).result === 'ready_for_human_review',
    'Target changed before push',
  );
  await unchangedTarget(context, io, commit);
  await checked(
    io,
    await pushArguments(repository, branch, cwd, (argv, path) => checked(io, argv, path)),
    cwd,
  );
  const url = await io.publish([
    '--repo',
    cwd,
    '--actor',
    context.target.actor,
    '--head',
    branch,
    '--title',
    requirements.title,
    '--body-file',
    body,
  ]);
  await writeFile(join(dir, 'pr-url.txt'), url);
  if (media.length) {
    await unchangedTarget(context, io, commit);
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
  const result = {
    url,
    commit,
    evidence: dir,
    publication: 'published',
    requiredChecks: ciTarget.ciChecks,
    ci: ci.status,
    ciDetails: ci,
    nextAction: ci.nextAction,
    remaining: [
      ...(ci.status === 'passed' ? [] : ['ci']),
      'human_review',
      ...(media.length ? ['rendered_media_check'] : []),
    ],
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  assert(
    result.ci === 'passed',
    `PR created but CI is not confirmed (${ci.status}): ${url}; ${ci.reason} Next: ${ci.nextAction}; inspect ${dir}`,
  );
  return result;
}

export async function develop(args: string[], io = runtime) {
  const context = await prepare(args, io);
  console.error(
    `Development #${context.number}; checkout: ${context.cwd}; evidence: ${context.dir}`,
  );
  try {
    console.error('Implementing, checking and independently reviewing the Issue');
    const config = await implement(context, io);
    if (context.localOnly) {
      await unchangedTarget(context, io);
      return {
        status: 'verified_local',
        evidence: context.dir,
        checkout: context.cwd,
        remaining: [
          'publication',
          ...(context.target.config.ciChecks.length ? ['ci'] : []),
          'human_review',
        ],
      };
    }
    console.error('Verified; committing, publishing and checking CI');
    return await ship(context, config, io);
  } catch (error) {
    await writeFile(
      join(context.dir, 'stopped.txt'),
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
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
