import assert from 'node:assert/strict';
import { hostReturnContext, verifyHostReturn } from './host-records.ts';
import { checkRevision, revisionContext } from './revision.ts';
import { issueText } from './issue.ts';
import { parseRepairReply, repairInstructions } from './repair.ts';
import { parseReview, reviewInstructions, reviewSummary } from './review.ts';
import type { Review } from './review.ts';
import { researchContext, verifyReportBase } from './research-handoff.ts';
import { assertConfig, assertProbeConfig, assertState } from './input.ts';
import { outside } from '../shared/values.ts';
import type {
  Config,
  ReviewConfig,
  ProbeConfig,
  State,
  ActorRole,
  StopReason,
  CaptureDecision,
} from './input.ts';
import { command, interruptionMessage } from '../shared/process.ts';
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
type RepairReference = {
  attempt: number;
  prefix: string;
  sourceBefore: string;
  sourceAfter: string;
  stdoutHash: string;
};
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
  const names = new Set([
    ...list.stdout.split('\0').filter(Boolean),
    ...untracked.keys(),
    '.dotagents.json',
  ]);
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

export async function recordArtifacts(cwd: string, baseCommit: string) {
  const additions: Addition[] = [];
  const files = await sourceFiles(cwd, additions);
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
      baseCommit,
    ],
    cwd,
    '',
    10000,
  );
  assert(diff.code === 0 && !diff.timedOut, 'Cannot preserve deliverable diff');
  const source = digest(JSON.stringify(files));
  assert(source === (await snapshot(cwd)), 'Source changed while preserving deliverables');
  return { source, files, additions, diff: diff.stdout };
}

async function validate(config: ReviewConfig) {
  if (!outside(resolve(config.cwd), resolve(config.runDir))) {
    throw Error('Evidence must be outside the worktree');
  }
  await mkdir(config.runDir, { recursive: true });
  if (!outside(await realpath(config.cwd), await realpath(config.runDir))) {
    throw Error('Evidence must not resolve inside the worktree');
  }
}

async function readIssue(config: ReviewConfig, record = false) {
  if (record) {
    const files = await readdir(config.runDir);
    assert(
      !files.some((name) => ['issue.stdout', 'issue.stderr', 'issue.txt'].includes(name)),
      'Initial Issue evidence already exists; preserve existing run and use a new run',
    );
  }
  const result = await command(
    config.issue,
    config.cwd,
    '',
    30000,
    record ? resolve(config.runDir, 'issue') : undefined,
  );

  if (result.code !== 0 || result.timedOut || !result.stdout.trim()) {
    throw Error('Issue unavailable');
  }
  return issueText(result.stdout);
}

// Use only the Issue just read at this boundary; checkRevision reads the remaining
// revision inputs afresh. Keep its failures ahead of the generic Issue hash check.
async function revisionUnchanged(config: ReviewConfig, issue: string) {
  if (config.targetText !== undefined) {
    if (config.revision) {
      assert(config.targetText === config.revision.targetText, '検証中に対象設定が変更されました');
    } else {
      assert(
        (await lstat(resolve(config.cwd, '.dotagents.json'))).isFile() &&
          (await readFile(resolve(config.cwd, '.dotagents.json'), 'utf8')) === config.targetText,
        '検証中に対象設定が変更されました',
      );
    }
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
      { issue },
    );
  }
}

async function readEntryIssue(config: ReviewConfig, record: boolean) {
  const issue = await readIssue(config, record);
  await revisionUnchanged(config, issue);
  if (record) {
    // Record the comparison text only after the revision target matched at entry.
    await writeFile(resolve(config.runDir, 'issue.txt'), issue, { flag: 'wx' });
  }
  return issue;
}

async function runModel(
  config: ReviewConfig,
  state: State,
  role: ActorRole,
  argv: string[],
  prompt: string,
  persist: Persist,
  timeoutMs: number | null = null,
): Promise<ModelResult> {
  state[role]++;
  const prefix = resolve(config.runDir, `${role}-${state[role]}`);
  state.active = { role, prefix };
  await persist(); // Reserve before launching. An interrupted reservation is never reset.
  await writeFile(`${prefix}.prompt`, prompt, { flag: 'wx' });
  const result = await command(argv, config.cwd, prompt, timeoutMs, prefix, {
    ...process.env,
    DOTAGENTS_ACTOR_PREFIX: prefix,
  });
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
  // Keep the persisted reservation until the next command reservation or terminal save.
  // A failure before that save must never make this attempt runnable again.
  if (result.timedOut) {
    return { stop: 'review_timeout' };
  }
  if (result.code !== 0) {
    return { stop: `${role}_failed` };
  }
  return result;
}

async function hostCommand(
  config: ReviewConfig,
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

async function installMedia(config: ReviewConfig, output: string) {
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

function captureDefinitions(config: ReviewConfig) {
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

async function captureIdentity(config: ReviewConfig, source: string, files: SourceFile[]) {
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
    !ignoredPaths.some(
      (path) =>
        definitions.includes(path) &&
        !(
          config.targetText !== undefined &&
          path === resolve(config.cwd, '.dotagents.json') &&
          files.some(([name]) => name === '.dotagents.json')
        ),
    ),
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
  config: ReviewConfig,
  source: string,
  files: SourceFile[],
  previousSource?: string,
): Promise<CaptureDecision> {
  if (!config.capture) {
    return {
      outcome: 'not_required',
      reason: 'captureは未設定です。Issueの媒体要件との一致が必要です',
    };
  }
  const current = await captureIdentity(config, source, files);
  if (previousSource !== undefined) {
    return {
      outcome: previousSource === current ? 'reused' : 'execute',
      reason:
        previousSource === current
          ? 'このrun内でcaptureの入力と媒体が一致しています'
          : 'captureの入力または媒体が変わりました',
      source: current,
      previousSource,
    };
  }
  const unnecessary =
    !config.captureRequired && (await onlyPlainMarkdown(config, captureDefinitions(config)));
  return {
    outcome: unnecessary ? 'not_required' : 'execute',
    reason: unnecessary
      ? '通常のMarkdownだけの変更で、画面に影響しない入力として設定されています'
      : 'このrun内に一致するcaptureがありません',
    source: current,
  };
}

function initialUntrackedPaths(config: ReviewConfig, definitions: string[], output: string) {
  const pinnedTarget =
    config.targetText !== undefined &&
    !definitions.includes(resolve(config.cwd, '.dotagents.json'));
  return new Map(
    output
      .split('\0')
      .filter((path) => path && !(pinnedTarget && path === '.dotagents.json'))
      .map((path) => [path, false]),
  );
}

async function onlyPlainMarkdown(config: ReviewConfig, definitions: string[]) {
  const cwd = config.cwd;
  const tracked = await command(
    ['git', '-c', 'core.filemode=true', 'diff', '--raw', '--no-renames', '-z', 'HEAD'],
    cwd,
    '',
    10000,
  );
  const untracked = await command(
    [
      'git',
      'ls-files',
      '--others',
      '--exclude-standard',
      ...(config.targetText !== undefined ? ['--exclude=!/.dotagents.json'] : []),
      '-z',
    ],
    cwd,
    '',
    10000,
  );
  if (tracked.code !== 0 || untracked.code !== 0) {
    return false;
  }
  const paths = initialUntrackedPaths(config, definitions, untracked.stdout);
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
  config: ReviewConfig,
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
    state.findings = `captureのログ: ${capture.prefix}.stdout と ${capture.prefix}.stderr。担当AIは既存権限内で環境の根拠を調査してください。ホスト環境の変更には許可が必要です。実行失敗は修正へ戻してください。`;
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
  config: ReviewConfig,
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
  state.findings = `checkのログ: ${checked.prefix}.stdout と ${checked.prefix}.stderr。`;
  if (checked.timedOut || checked.code === null) {
    return { stop: 'check_unavailable' };
  }
  return checked.code === 0
    ? {}
    : {
        findings: `checkが失敗しました。${checked.prefix}.stdout と ${checked.prefix}.stderr を読んでください。`,
      };
}

async function reviewTarget(
  config: ReviewConfig,
  state: State,
  issue: string,
  repairsSinceReview: RepairReference[],
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
  for (const repair of repairsSinceReview) {
    try {
      assert(
        digest(await readFile(`${repair.prefix}.stdout`)) === repair.stdoutHash,
        'Repair response changed',
      );
    } catch (error) {
      state.findings = `Cannot hand off repair response at ${repair.prefix}.stdout: ${error instanceof Error ? error.message : String(error)}; preserve the run and investigate before further evaluation.`;
      return { stop: 'invalid_repair' as const };
    }
  }
  const target = {
    issue: { hash: state.issueHash, content: issue },
    baseCommit: state.baseCommit,
    reports: config.reports ?? [],
    revision: config.revision,
    hostReturn: config.hostReturn,
    source: state.source,
    latestRepair: repairsSinceReview.at(-1) ?? null,
    repairsSinceReview,
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
  config: ReviewConfig,
  state: State,
  issue: string,
  persist: Persist,
  repairsSinceReview: RepairReference[],
  timeoutMs: number | null = null,
): Promise<StopReason | null> {
  const target = await reviewTarget(config, state, issue, repairsSinceReview);
  if (target.stop) {
    return target.stop;
  }
  const history = state.reviewHistory;
  const prompt = [
    reviewInstructions,
    revisionContext(config.revision),
    hostReturnContext(config.hostReturn),
    `ホストコンテキスト: ${JSON.stringify({ targetId: target.targetId, attempt: state.review + 1, targetRecord: `${target.prefix}.target.json`, diff: `${target.prefix}.diff`, additions: `${target.prefix}.additions.json`, previous: history.at(-1) ?? null })}`,
    `要求:\n${issue}`,
    researchContext(state.baseCommit, config.reports),
  ].join('\n');
  const before = await targetChange(config, state);
  if (before) {
    return before;
  }
  const reviewed = await runModel(
    config,
    state,
    'review',
    config.review,
    prompt,
    persist,
    timeoutMs,
  );
  if ('stop' in reviewed) {
    return reviewed.stop;
  }
  const changed = await targetChange(config, state);
  if (changed) {
    return changed;
  }
  let review: Review;
  let documents: ReturnType<typeof documentVersions>;
  try {
    review = parseReview(reviewed.stdout, target.targetId, state.review, history.at(-1));
    documents = documentVersions(review, target.files);
  } catch (error) {
    state.findings = `Invalid review: ${error instanceof Error ? error.message : String(error)}; raw response: ${target.prefix}.stdout`;
    return 'invalid_review';
  }
  try {
    await writeFile(
      `${target.prefix}.json`,
      JSON.stringify({ target: `${target.prefix}.target.json`, review, documents }, null, 2),
      { flag: 'wx' },
    );
  } catch (error) {
    state.findings = `Cannot save review at ${target.prefix}.json: ${error instanceof Error ? error.message : String(error)}; raw response: ${target.prefix}.stdout; previous complete reviews remain in reviewHistory.`;
    return 'review_storage_failed';
  }
  history.push(review);
  state.findings = summarizeReviews(state);
  return null;
}

function summarizeReviews(state: State) {
  return reviewSummary(
    state.reviewHistory,
    state.events.filter((event) => event.role === 'review').map((event) => `${event.prefix}.json`),
  );
}

async function requirementsChanged(config: ReviewConfig, state: State) {
  const currentIssue = await readIssue(config);
  await revisionUnchanged(config, currentIssue);
  return digest(currentIssue) !== state.issueHash;
}

async function repairOutcome(
  config: Config,
  state: State,
  stdout: string,
  repairsSinceReview: RepairReference[],
): Promise<StopReason | RepairReference[]> {
  const value = parseRepairReply(stdout);
  state.findings = value.findings;
  if (value.status === 'invalid') {
    return 'invalid_repair';
  }
  if (value.status === 'needs_host') {
    state.source = await snapshot(config.cwd);
    return 'host_verification_required';
  }
  if (value.status === 'needs_human') {
    return 'human_decision_required';
  }
  assert(state.source);
  return [
    ...repairsSinceReview,
    {
      attempt: state.repair,
      prefix: resolve(config.runDir, `repair-${state.repair}`),
      sourceBefore: state.source,
      sourceAfter: await snapshot(config.cwd),
      stdoutHash: digest(stdout),
    },
  ];
}

async function cycle(
  config: Config,
  state: State,
  issue: string,
  persist: Persist,
  repairsSinceReview: RepairReference[],
): Promise<StopReason | RepairReference[]> {
  if (await requirementsChanged(config, state)) {
    return 'requirements_changed';
  }
  const host = await verifyHost(config, state, persist);
  if (host.stop) {
    return host.stop;
  }
  let findings = host.findings;
  if (findings && state.reviewHistory.length) {
    findings += `\n過去の独立評価（過去の記録です。現在の成果物を確認してください）:\n${summarizeReviews(state)}`;
  }
  if (!findings) {
    const stopped = await evaluate(config, state, issue, persist, repairsSinceReview);
    if (stopped) {
      return stopped;
    }
    if (state.reviewHistory.at(-1)?.status === 'accepted') {
      return 'ready_for_human_review';
    }
    findings = state.findings;
    // The completed review has consumed these explanations. Check failures do not.
    repairsSinceReview = [];
  }
  const prompt = [
    'これらの合意済み要求の範囲内だけで修正してください。現在のファイルを読み、根本原因を直してください。',
    '指摘が再発した場合は、既存の評価記録と過去の修正結果を現在の成果物と比較し、原因と修正方法を見直して、合意範囲内で必要な修正を続けてください。範囲外の改善や好みを完了条件にしないでください。',
    revisionContext(config.revision),
    hostReturnContext(config.hostReturn),
    '文書内容の欠陥は修正へ戻し、影響するcheckと独立評価を更新してください。',
    '合意済みの受入基準と必要な振る舞いの検証を保ち、checkを通すために現実的な退行を隠さないでください。',
    '修正の診断や妥当性の確認に必要な範囲のcheckだけを実行してください。',
    repairInstructions(
      config.capture && config.captureDestination
        ? { destination: config.captureDestination }
        : null,
    ),
    `対象のcheck/capture契約（弱めたり置き換えたりしないでください）: ${JSON.stringify({ check: config.check, capture: config.capture ? { command: config.capture, destination: config.captureDestination, required: config.captureRequired } : null })}`,
    `要求:\n${issue}\n失敗の根拠:\n${findings}`,
    researchContext(state.baseCommit, config.reports),
  ].join('\n');
  if (await requirementsChanged(config, state)) {
    return 'requirements_changed';
  }
  const repaired = await runModel(config, state, 'repair', config.repair, prompt, persist);
  if ('stop' in repaired) {
    return repaired.stop;
  }
  return repairOutcome(config, state, repaired.stdout, repairsSinceReview);
}

async function targetChange(config: ReviewConfig, state: State): Promise<StopReason | null> {
  const issue = await readIssue(config);
  await revisionUnchanged(config, issue);
  if (digest(issue) !== state.issueHash) {
    return 'requirements_changed';
  }
  if ((await snapshot(config.cwd)) !== state.source) {
    return 'source_changed';
  }
  if (config.hostReturn) {
    try {
      await verifyHostReturn(config.hostReturn, config.cwd);
    } catch (error) {
      state.findings = error instanceof Error ? error.message : String(error);
      return 'host_evidence_changed';
    }
  }
  return null;
}

type Verification = (state: State, issue: string, persist: Persist) => Promise<StopReason>;

export async function run(config: unknown) {
  assertConfig(config);
  return lockedRun(config, async (state, issue, persist) => {
    // 今回完了した修正だけを次の評価へ渡し、別runの説明を混ぜない。
    let result: StopReason | RepairReference[] = [];
    while (typeof result !== 'string') {
      result = await cycle(config, state, issue, persist, result);
    }
    return result;
  });
}

export async function reviewOnce(config: unknown) {
  assertProbeConfig(config);
  return lockedRun(config, async (state, issue, persist) => {
    const host = await verifyHost(config, state, persist);
    if (host.stop) {
      return host.stop;
    }
    if (host.findings) {
      return 'check_failed';
    }
    return (
      (await evaluate(config, state, issue, persist, [], config.reviewTimeMs)) ?? 'review_completed'
    );
  });
}

async function lockedRun(config: Config | ProbeConfig, verify: Verification) {
  await validate(config);
  const lock = resolve(config.runDir, 'lock');
  await mkdir(lock); // 既存lockは照合が必要であり、自動で引き継がない。
  try {
    return await execute(config, verify);
  } finally {
    await rm(lock, { recursive: true });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function execute(config: Config | ProbeConfig, verify: Verification): Promise<State> {
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
    throw Error('Run configuration changed; preserve the existing run');
  }
  if (state?.active) {
    throw Error(interruptionMessage);
  }
  const issue = await readEntryIssue(config, !state);
  const base =
    state?.baseCommit ??
    config.baseCommit ??
    (await command(['git', 'rev-parse', 'HEAD'], config.cwd, '', 10000)).stdout.trim();
  assert(/^[a-f0-9]{40,64}$/.test(base), 'Review requires a base commit');
  const git = async (...args: string[]) => {
    const result = await command(['git', ...args], config.cwd, '', 10000);
    assert(result.code === 0 && !result.timedOut, 'Cannot verify report base');
    return result.stdout.trim();
  };
  await verifyReportBase(base, config.reports ?? [], git);
  if (config.hostReturn) {
    const evidence = await verifyHostReturn(config.hostReturn, config.cwd);
    assert(
      state || evidence.source === (await snapshot(config.cwd)),
      'Host evidence does not match current deliverables',
    );
  }
  if (state?.result) {
    const unchanged =
      state.issueHash === digest(issue) && state.source === (await snapshot(config.cwd));
    return { ...state, result: unchanged ? state.result : 'target_changed_after_stop' };
  }
  state ??= {
    reviewFormat: 4,
    issueFormat: 1,
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
  state.result = await verify(state, issue, persist);
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
  console.error(
    '単独の修正CLIは廃止しました。通常開発はdevelopment.ts、評価試行はreview-probe.tsを使ってください。旧runは再開せず保全してください。',
  );
  process.exitCode = 1;
}
