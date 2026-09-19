import assert from 'node:assert/strict';
import { checkRevision, revisionContext } from './revision.ts';
import { parseRepairReply, repairInstructions } from './repair.ts';
import { parseReview, reviewInstructions, reviewSummary } from './review.ts';
import type { Review } from './review.ts';
import { researchContext, verifyReportBase } from './research-handoff.ts';
import { knowledgeReferences, readKnowledge } from './knowledge.ts';
import type { SelectedKnowledge } from './knowledge.ts';
import { assertConfig, assertState } from './input.ts';
import { outside } from './values.ts';
import type { Config, State, ActorRole, StopReason, CaptureDecision } from './input.ts';
import { command, assertRunning, withInterrupts, interruptionMessage } from './process.ts';
import { createHash } from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  lstat,
  readlink,
  rm,
  readdir,
  cp,
  realpath,
} from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';

type Persist = () => Promise<void>;
type ModelResult = { stdout: string } | { stop: StopReason };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function save(path: string, value: State) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}

// Plain documentation and saved verification records do not change the rendered app.
// Keep media, executable files and symlinks in the capture identity.
function isCaptureRecord(name: string, destination: string) {
  return (
    name.endsWith('.md') ||
    (name.startsWith(`${dirname(destination)}/`) &&
      !name.startsWith(`${destination}/`) &&
      /\.(json|txt|log|stdout|stderr|diff)$/.test(name))
  );
}

type SourceFile = [string, number, string];
type Addition = { path: string; mode: number; symlink: boolean; content: string };

async function sourceFiles(cwd: string, additions?: Addition[]) {
  const untracked = new Map<string, number>();
  if (additions) {
    const list = await command(
      ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
      cwd,
      '',
      10000,
    );
    assert(list.code === 0, 'Cannot record untracked files');
    for (const name of list.stdout.split('\0').filter(Boolean)) {
      untracked.set(name, untracked.size);
    }
  }
  const list = await command(
    ['git', 'ls-files', '-z', '--cached', ...(additions ? [] : ['--others', '--exclude-standard'])],
    cwd,
    '',
    10000,
  );
  if (list.code !== 0) {
    throw Error('Cannot identify source files');
  }
  const entries: SourceFile[] = [];
  const names = new Set([...list.stdout.split('\0').filter(Boolean), ...untracked.keys()]);
  for (const name of [...names].sort()) {
    const path = resolve(cwd, name);
    const stat = await lstat(path).catch((error: unknown) => {
      if (!isMissing(error) || untracked.has(name)) {
        throw error;
      }
      return undefined;
    });
    if (!stat) {
      // Materialized deletion has the same identity before and after staging.
      continue;
    }
    // A path disappearing after lstat is an unknown read, not an identified deletion.
    const bytes = stat.isSymbolicLink() ? await readlink(path) : await readFile(path);
    entries.push([name, stat.mode, digest(bytes)]);
    const index = untracked.get(name);
    if (index !== undefined) {
      assert(additions);
      additions[index] = {
        path: name,
        mode: stat.mode,
        symlink: stat.isSymbolicLink(),
        content: typeof bytes === 'string' ? bytes : bytes.toString('base64'),
      };
    }
  }
  return entries;
}

function captureFiles(
  files: SourceFile[],
  cwd: string,
  destination: string,
  definitions: string[],
) {
  return files.filter(
    ([name, mode]) =>
      definitions.includes(resolve(cwd, name)) ||
      (mode & 0o170000) !== 0o100000 ||
      !!(mode & 0o111) ||
      !isCaptureRecord(name, destination),
  );
}

export async function snapshot(cwd: string) {
  return digest(JSON.stringify(await sourceFiles(cwd)));
}

async function validate(config: Config) {
  if (!outside(resolve(config.cwd), resolve(config.runDir))) {
    throw Error('Evidence must be outside the worktree');
  }
  await mkdir(config.runDir, { recursive: true });
  if (!outside(await realpath(config.cwd), await realpath(config.runDir))) {
    throw Error('Evidence must not resolve inside the worktree');
  }
}

async function readIssue(config: Config) {
  const result = await command(config.issue, config.cwd, '', 30000);
  if (result.code !== 0 || result.timedOut || !result.stdout.trim()) {
    throw Error('Issue unavailable');
  }
  if (config.revision) {
    await checkRevision(
      config.revision,
      config.cwd,
      async (argv, cwd) => {
        const result = await command(argv, cwd, '', 660000);
        assert(result.code === 0 && !result.timedOut, 'Revision target unavailable');
        return result.stdout.trim();
      },
      { issue: result.stdout },
    );
  }
  return result.stdout;
}

async function runModel(
  config: Config,
  state: State,
  role: ActorRole,
  prompt: string,
  persist: Persist,
): Promise<ModelResult> {
  const remaining = config.modelTimeMs === null ? null : config.modelTimeMs - state.modelMs;
  if (state[role] >= config[`${role}Limit`] || (remaining !== null && remaining <= 0)) {
    return { stop: 'execution_limit' };
  }
  state[role]++;
  const prefix = resolve(config.runDir, `${role}-${state[role]}`);
  state.active = { role, prefix };
  await persist(); // Reserve before launching. An interrupted reservation is never reset.
  await writeFile(`${prefix}.prompt`, prompt, { flag: 'wx' });
  const result = await command(config[role], config.cwd, prompt, remaining, prefix);
  state.modelMs += result.ms;
  state.active = null;
  state.events.push({
    role,
    source: state.source,
    code: result.code,
    timedOut: result.timedOut,
    ms: result.ms,
    prefix,
  });
  // Keep the persisted review reservation until response adoption and the next
  // state save complete. A storage failure must never make this attempt runnable again.
  if (role !== 'review') {
    await persist();
  }
  if (result.timedOut) {
    return { stop: 'execution_limit' };
  }
  if (result.code !== 0) {
    return { stop: `${role}_failed` };
  }
  return result;
}

async function hostCommand(
  config: Config,
  state: State,
  role: 'capture' | 'check',
  argv: string[],
  persist: Persist,
  captureDecision?: CaptureDecision,
) {
  const attempt =
    role !== 'check'
      ? state.events.filter((event) => event.role === role).length + 1
      : state.checks;
  const prefix = resolve(config.runDir, `${role}-${attempt}`);
  state.active = { role, prefix };
  await persist();
  const result = await command(argv, config.cwd, '', config.checkTimeMs, prefix);
  state.active = null;
  state.events.push({
    role,
    captureDecision,
    source: state.source,
    code: result.code,
    timedOut: result.timedOut,
    ms: result.ms,
    prefix,
  });
  await persist();
  return { ...result, prefix };
}

async function installMedia(config: Config, output: string) {
  const names = await readdir(output);
  for (const name of names) {
    if (
      !/\.(png|jpe?g|webp|mp4|webm)$/i.test(name) ||
      !(await lstat(resolve(output, name))).isFile()
    ) {
      throw Error(`Invalid capture output: ${name}`);
    }
  }
  if (!names.length) {
    throw Error('Capture succeeded without required media');
  }
  assert(config.captureDestination);
  const destination = resolve(config.cwd, config.captureDestination);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  if ((await realpath(parent)) !== parent) {
    throw Error('Capture destination must not resolve through a symlink');
  }
  await rm(destination, { recursive: true, force: true });
  await cp(output, destination, { recursive: true });
}

function captureDefinitions(config: Config) {
  const command = config.capture ?? [];
  const directories = command.flatMap((argument, index) =>
    argument === '--cwd'
      ? [command[index + 1] ?? '']
      : argument.startsWith('--cwd=')
        ? [argument.slice('--cwd='.length)]
        : [],
  );
  const bases = [
    config.cwd,
    ...directories.filter(Boolean).map((path) => resolve(config.cwd, path)),
  ];
  return command.flatMap((argument) => {
    const separator = argument.startsWith('-') ? argument.indexOf('=') : -1;
    const paths = separator > 0 ? [argument, argument.slice(separator + 1)] : [argument];
    return paths.filter(Boolean).flatMap((path) => bases.map((base) => resolve(base, path)));
  });
}

async function captureIdentity(config: Config, source: string, files: SourceFile[]) {
  assert(config.captureDestination);
  const definitions = captureDefinitions(config);
  const ignored = await command(
    [
      'git',
      '--literal-pathspecs',
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      config.captureDestination,
      ...definitions
        .filter((path) => !outside(config.cwd, path))
        .map((path) => relative(config.cwd, path) || '.'),
    ],
    config.cwd,
    '',
    10000,
  );
  assert(ignored.code === 0 && !ignored.timedOut, 'Cannot identify capture media or definitions');
  const ignoredPaths = ignored.stdout
    .split('\0')
    .filter(Boolean)
    .map((path) => resolve(config.cwd, path));
  assert(
    !ignoredPaths.some((path) => definitions.includes(path)),
    'Capture definitions must not be excluded from source identity by Git ignore rules',
  );
  const destination = resolve(config.cwd, config.captureDestination);
  assert(
    !ignoredPaths.some((path) => !outside(destination, path)),
    'Capture media must not be excluded from source identity by Git ignore rules',
  );
  return config.captureRequired
    ? source
    : digest(
        JSON.stringify(captureFiles(files, config.cwd, config.captureDestination, definitions)),
      );
}

async function captureDecision(
  config: Config,
  source: string,
  files: SourceFile[],
  previousSource?: string,
): Promise<CaptureDecision> {
  if (!config.capture) {
    return {
      outcome: 'not_required',
      reason: 'Capture is not configured; Issue media requirements must agree',
    };
  }
  const current = await captureIdentity(config, source, files);
  if (previousSource !== undefined) {
    return {
      outcome: previousSource === current ? 'reused' : 'execute',
      reason:
        previousSource === current
          ? 'Same capture inputs and media in this run'
          : 'Capture inputs or media changed',
      source: current,
      previousSource,
    };
  }
  const unnecessary =
    !config.captureRequired && (await onlyPlainMarkdown(config.cwd, captureDefinitions(config)));
  return {
    outcome: unnecessary ? 'not_required' : 'execute',
    reason: unnecessary
      ? 'Only plain Markdown changed; configured as non-rendering input'
      : 'No matching capture in this run',
    source: current,
  };
}

async function onlyPlainMarkdown(cwd: string, definitions: string[]) {
  const tracked = await command(
    ['git', '-c', 'core.filemode=true', 'diff', '--raw', '--no-renames', '-z', 'HEAD'],
    cwd,
    '',
    10000,
  );
  const untracked = await command(
    ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
    cwd,
    '',
    10000,
  );
  if (tracked.code !== 0 || untracked.code !== 0) {
    return false;
  }
  const paths = new Map(
    untracked.stdout
      .split('\0')
      .filter(Boolean)
      .map((path) => [path, false]),
  );
  const records = tracked.stdout.split('\0');
  for (let index = 0; index < records.length - 1; index += 2) {
    const header = records[index] ?? '';
    const path = records[index + 1];
    // Both sides matter: deleting a symlink or removing an executable bit changes code too.
    if (!path || !/^:(?:000000|100644) (?:000000|100644) /.test(header)) {
      return false;
    }
    paths.set(path, header.startsWith(':100644 000000 '));
  }
  if (!paths.size) {
    return false;
  }
  for (const [path, deleted] of paths) {
    if (
      definitions.includes(resolve(cwd, path)) ||
      !(await plainMarkdownFile(cwd, path, deleted))
    ) {
      return false;
    }
  }
  return true;
}

async function plainMarkdownFile(cwd: string, path: string, deleted: boolean) {
  if (!path.endsWith('.md')) {
    return false;
  }
  try {
    const stat = await lstat(resolve(cwd, path));
    return stat.isFile() && !(stat.mode & 0o111);
  } catch (error) {
    return deleted && isMissing(error);
  }
}

async function verifyHost(
  config: Config,
  state: State,
  persist: Persist,
): Promise<{ stop?: StopReason; findings?: string }> {
  const files = await sourceFiles(config.cwd);
  state.source = digest(JSON.stringify(files));
  const decision = await captureDecision(config, state.source, files, state.captureSource);
  if (config.capture && decision.outcome === 'execute') {
    state.captureSource = undefined;
    const output = resolve(
      config.runDir,
      `capture-${state.events.filter((event) => event.role === 'capture').length + 1}-media`,
    );
    await mkdir(output); // Each capture has a fresh directory, never prior media.
    const capture = await hostCommand(
      config,
      state,
      'capture',
      [...config.capture, output],
      persist,
      decision,
    );
    const changed = await targetChange(config, state);
    if (changed) {
      return { stop: changed };
    }
    state.findings = `Capture logs: ${capture.prefix}.stdout and ${capture.prefix}.stderr; the assigned AI investigates environment evidence within existing permissions; host environment changes require authorization, execution failures return to repair.`;
    if (capture.timedOut) {
      return { stop: 'capture_timeout' };
    }
    if (capture.code === null || capture.code === 78) {
      return { stop: 'capture_unavailable' };
    }
    if (capture.code !== 0) {
      return { findings: state.findings };
    }
    await installMedia(config, output);
    const installed = await sourceFiles(config.cwd);
    state.source = digest(JSON.stringify(installed));
    state.captureSource = await captureIdentity(config, state.source, installed);
    await persist();
  }
  return verifyCheck(config, state, persist, decision);
}

async function verifyCheck(
  config: Config,
  state: State,
  persist: Persist,
  decision: CaptureDecision,
): Promise<{ stop?: StopReason; findings?: string }> {
  state.checks++;
  const checked = await hostCommand(config, state, 'check', config.check, persist, decision);
  const changed = await targetChange(config, state);
  if (changed) {
    return { stop: changed };
  }
  state.findings = `Check logs: ${checked.prefix}.stdout and ${checked.prefix}.stderr.`;
  if (checked.timedOut || checked.code === null) {
    return { stop: 'check_unavailable' };
  }
  return checked.code === 0
    ? {}
    : { findings: `check failed. Read ${checked.prefix}.stdout and ${checked.prefix}.stderr.` };
}

async function reviewTarget(
  config: Config,
  state: State,
  issue: string,
  knowledge: SelectedKnowledge[],
) {
  const prefix = resolve(config.runDir, `review-${state.review + 1}`);
  const additions: Addition[] = [];
  const files = await sourceFiles(config.cwd, additions);
  if (digest(JSON.stringify(files)) !== state.source) {
    return { stop: 'source_changed' as const };
  }
  const check = state.events.findLast((event) => event.role === 'check');
  assert(
    check && check.code === 0 && !check.timedOut && check.source === state.source,
    'Review requires successful check of current source',
  );
  const target = {
    issue: { hash: state.issueHash, content: issue },
    baseCommit: state.baseCommit,
    reports: config.reports ?? [],
    revision: config.revision,
    knowledge,
    source: state.source,
    files,
    check: {
      command: config.check,
      ...check,
      stdoutHash: digest(await readFile(`${check.prefix}.stdout`)),
      stderrHash: digest(await readFile(`${check.prefix}.stderr`)),
    },
    model: { command: config.review, settings: config.reviewModel ?? null },
    configHash: state.configHash,
  };
  const targetId = digest(JSON.stringify(target));
  await writeFile(`${prefix}.target.json`, JSON.stringify({ targetId, ...target }, null, 2), {
    flag: 'wx',
  });
  const diff = await command(
    [
      'git',
      '-c',
      'core.filemode=true',
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      state.baseCommit,
    ],
    config.cwd,
    '',
    10000,
  );
  assert(diff.code === 0, 'Cannot record review diff');
  await writeFile(`${prefix}.diff`, diff.stdout, { flag: 'wx' });
  await writeFile(`${prefix}.additions.json`, JSON.stringify(additions, null, 2), { flag: 'wx' });
  return { prefix, targetId, files };
}

function documentVersions(review: Review, files: [string, number, string][]) {
  return review.documents.map((document) => {
    const file = files.find(([path]) => path === document.path);
    assert(file, `Document reference is not in reviewed source: ${document.path}`);
    // Symlinks can refer to ignored or external content not covered by the source identity.
    assert(
      (file[1] & 0o170000) === 0o100000,
      'Document reference must be a regular repository file',
    );
    return { ...document, mode: file[1], hash: file[2] };
  });
}

async function evaluate(
  config: Config,
  state: State,
  issue: string,
  persist: Persist,
  knowledge: SelectedKnowledge[],
): Promise<{ stop?: StopReason; findings?: string }> {
  // Do not create an apparent attempt if the existing execution budget is exhausted.
  if (
    state.review >= config.reviewLimit ||
    (config.modelTimeMs !== null && state.modelMs >= config.modelTimeMs)
  ) {
    return { stop: 'execution_limit' };
  }
  const target = await reviewTarget(config, state, issue, knowledge);
  if ('stop' in target) {
    return { stop: target.stop };
  }
  const history = state.reviewHistory;
  const prompt = [
    reviewInstructions,
    revisionContext(config.revision),
    `Host context: ${JSON.stringify({ targetId: target.targetId, attempt: state.review + 1, targetRecord: `${target.prefix}.target.json`, diff: `${target.prefix}.diff`, additions: `${target.prefix}.additions.json`, previous: history.at(-1) ?? null })}`,
    `Requirements:\n${issue}`,
    researchContext(state.baseCommit, config.reports, knowledge),
  ].join('\n');
  const before = await targetChange(config, state);
  if (before) {
    return { stop: before };
  }
  const reviewed = await runModel(config, state, 'review', prompt, persist);
  if ('stop' in reviewed) {
    return { stop: reviewed.stop };
  }
  const changed = await targetChange(config, state);
  if (changed) {
    return { stop: changed };
  }
  let review: Review;
  let documents: ReturnType<typeof documentVersions>;
  try {
    review = parseReview(reviewed.stdout, target.targetId, state.review, history.at(-1));
    documents = documentVersions(review, target.files);
  } catch (error) {
    state.findings = `Invalid review: ${error instanceof Error ? error.message : String(error)}; raw response: ${target.prefix}.stdout`;
    return { stop: 'invalid_review' };
  }
  try {
    await writeFile(
      `${target.prefix}.json`,
      JSON.stringify({ target: `${target.prefix}.target.json`, review, documents }, null, 2),
      { flag: 'wx' },
    );
  } catch (error) {
    state.findings = `Cannot save review at ${target.prefix}.json: ${error instanceof Error ? error.message : String(error)}; raw response: ${target.prefix}.stdout; previous complete reviews remain in reviewHistory.`;
    return { stop: 'review_storage_failed' };
  }
  history.push(review);
  state.reviewHistory = history;
  state.findings = summarizeReviews(state);
  if (review.status === 'accepted') {
    return { stop: 'ready_for_human_review' };
  }
  return { findings: state.findings };
}

function summarizeReviews(state: State) {
  return reviewSummary(
    state.reviewHistory,
    state.events.filter((event) => event.role === 'review').map((event) => `${event.prefix}.json`),
  );
}

async function cycle(
  config: Config,
  state: State,
  issue: string,
  persist: Persist,
  knowledge: SelectedKnowledge[],
): Promise<StopReason | null> {
  if (digest(await readIssue(config)) !== state.issueHash) {
    return 'requirements_changed';
  }
  const host = await verifyHost(config, state, persist);
  if (host.stop) {
    return host.stop;
  }
  let findings = host.findings;
  if (findings && state.reviewHistory.length) {
    findings += `\nPrevious independent review (historical; verify current artifacts):\n${summarizeReviews(state)}`;
  }
  if (!findings) {
    const result = await evaluate(config, state, issue, persist, knowledge);
    if (result.stop) {
      return result.stop;
    }
    findings = result.findings;
  }
  const prompt = [
    'Repair only within these agreed requirements. Read the current files and fix the root cause.',
    revisionContext(config.revision),
    'Return document content defects to repair and renew affected checks and independent review.',
    'Preserve agreed acceptance criteria and verification of required behavior; never hide realistic regressions to make checks pass.',
    'Run only targeted checks needed to diagnose or validate your repair.',
    repairInstructions(
      config.capture && config.captureDestination
        ? { destination: config.captureDestination }
        : null,
    ),
    'If requirements, permissions or execution limits must change, report needs_human without changing them.',
    `Requirements:\n${issue}\nFailure evidence:\n${findings}`,
    researchContext(state.baseCommit, config.reports, knowledge),
  ].join('\n');
  if (digest(await readIssue(config)) !== state.issueHash) {
    return 'requirements_changed';
  }
  const repaired = await runModel(config, state, 'repair', prompt, persist);
  if ('stop' in repaired) {
    return repaired.stop;
  }
  const value = parseRepairReply(repaired.stdout);
  state.findings = value.findings;
  if (value.status === 'invalid') {
    return 'invalid_repair';
  }
  return value.status === 'needs_human' ? 'human_decision_required' : null;
}

async function targetChange(config: Config, state: State): Promise<StopReason | null> {
  if (digest(await readIssue(config)) !== state.issueHash) {
    return 'requirements_changed';
  }
  if ((await snapshot(config.cwd)) !== state.source) {
    return 'source_changed';
  }
  return null;
}

export async function run(config: Config) {
  assertConfig(config);
  await validate(config);
  const lock = resolve(config.runDir, 'lock');
  await mkdir(lock); // Existing lock requires reconciliation, never an automatic takeover.
  try {
    return await execute(config);
  } finally {
    await rm(lock, { recursive: true });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function execute(config: Config): Promise<State> {
  const path = resolve(config.runDir, 'state.json');
  let state: State | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    assertState(value);
    state = value;
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  const configHash = digest(JSON.stringify(config));
  if (state && state.configHash !== configHash) {
    throw Error('Run configuration changed; do not reset the existing limits');
  }
  if (state?.active) {
    throw Error(interruptionMessage);
  }
  const issue = await readIssue(config);
  const base =
    state?.baseCommit ??
    config.baseCommit ??
    (await command(['git', 'rev-parse', 'HEAD'], config.cwd, '', 10000)).stdout.trim();
  assert(/^[a-f0-9]{40,64}$/.test(base), 'Review requires a base commit');
  const references = knowledgeReferences(issue);
  const git = async (...args: string[]) => {
    const result = await command(['git', ...args], config.cwd, '', 10000);
    assert(result.code === 0 && !result.timedOut, 'Cannot verify report base');
    return result.stdout.trim();
  };
  await verifyReportBase(base, [...(config.reports ?? []), ...references], git);
  if (state?.result) {
    // The unchanged selection and immutable base blobs were validated during preparation.
    // ls-tree alone does not detect a missing blob object; check availability without extraction.
    for (const { blob } of references) {
      await git('cat-file', '-e', `${blob}^{blob}`);
    }
    const unchanged =
      state.issueHash === digest(issue) && state.source === (await snapshot(config.cwd));
    return { ...state, result: unchanged ? state.result : 'target_changed_after_stop' };
  }
  const knowledge = await readKnowledge(references, git);
  state ??= {
    reviewFormat: 3,
    baseCommit: base,
    reviewHistory: [],
    configHash,
    issueHash: digest(issue),
    repair: 0,
    review: 0,
    checks: 0,
    modelMs: 0,
    active: null,
    events: [],
  };
  const persist = () => save(path, state);
  await persist();
  while (!state.result) {
    state.result = await cycle(config, state, issue, persist, knowledge);
  }
  await saveTerminal(path, state);
  return state;
}

async function saveTerminal(path: string, state: State) {
  try {
    await save(path, state);
  } catch (error) {
    throw new Error(
      `${state.result}: ${state.findings ?? ''}; cannot save terminal state at ${path}: ${error instanceof Error ? error.message : String(error)}. Preserve the previous state and active reservation; do not resume this run.`,
      { cause: error },
    );
  }
}

if (import.meta.main) {
  try {
    await withInterrupts(async () => {
      const configFile = process.argv[2];
      if (!configFile) {
        throw Error('Usage: bun scripts/correction.ts CONFIG_FILE');
      }
      const config: unknown = JSON.parse(await readFile(configFile, 'utf8'));
      assertConfig(config);
      const result = await run(config);
      assertRunning();
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.result === 'ready_for_human_review' ? 0 : 1;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
