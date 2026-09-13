import assert from 'node:assert/strict';
import { assertConfig, assertState } from './input.ts';
import type { Config, State, ActorRole, StopReason } from './input.ts';
import { writingHostTimeoutMs } from './writing.ts';
import { spawn } from 'node:child_process';
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
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}
type Persist = () => Promise<void>;
type ModelResult = { stdout: string } | { stop: StopReason };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function save(path: string, value: State) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}

const interruptionMessage =
  'Interrupted execution: reconcile existing process and evidence before continuing';
let interrupted = false;
let activeGroup: number | undefined;

function killGroup(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

function interrupt() {
  interrupted = true;
  killGroup(activeGroup);
}

export function assertRunning() {
  if (interrupted) {
    throw Error(interruptionMessage);
  }
}

// A process group includes tools launched by the actor, not just its CLI parent.
export async function command(
  argv: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  files?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  assertRunning();
  let stdout = '',
    stderr = '',
    timedOut = false;
  const start = performance.now();
  const [executable, ...args] = argv;
  if (!executable) {
    throw Error('Command executable is required');
  }
  const child = spawn(executable, args, {
    cwd,
    detached: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeGroup = child.pid;
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  child.stdout.setEncoding('utf8').on('data', (data) => {
    stdout += data;
  });
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, timeoutMs);
  const writingWorker = argv[1]?.endsWith('/writing-review.ts') && argv[2] === '--worker';
  const code = await new Promise<number | null>((done) => {
    // Bun 1.4.2 can drop 'close', or the whole exit notification, for a child that
    // the timeout or an interrupt killed. Finish on exit plus ended pipes as well,
    // and poll for the kill until the runtime reports it.
    const poll = setInterval(() => {
      if ((timedOut || interrupted) && child.pid !== undefined) {
        try {
          process.kill(child.pid, 0);
        } catch {
          resolveCode(null);
        }
      }
    }, 50);
    const resolveCode = (code: number | null) => {
      clearInterval(poll);
      done(code);
    };
    let exitCode: number | null | undefined;
    let openPipes = 2;
    const settle = () => {
      if (exitCode !== undefined && openPipes === 0) {
        resolveCode(exitCode);
      }
    };
    for (const pipe of [child.stdout, child.stderr]) {
      pipe.once('end', () => {
        openPipes--;
        settle();
      });
    }
    child.on('exit', (code) => {
      if (code !== 0 || writingWorker) {
        killGroup(child.pid);
      }
      exitCode = code;
      settle();
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolveCode(null);
    });
    child.on('close', resolveCode);
  });
  clearTimeout(timer);
  activeGroup = undefined;
  if (files) {
    await writeFile(`${files}.stdout`, stdout);
    await writeFile(`${files}.stderr`, stderr);
  }
  assertRunning(); // Keep the persisted active reservation when interrupted.
  return { code, stdout, stderr, timedOut, ms: performance.now() - start };
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

async function snapshot(cwd: string, captureOnly = false, destination = '') {
  const list = await command(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    cwd,
    '',
    10000,
  );
  if (list.code !== 0) {
    throw Error('Cannot identify source files');
  }
  const entries = [];
  for (const name of [...new Set(list.stdout.split('\0').filter(Boolean))].sort()) {
    const path = resolve(cwd, name);
    try {
      const stat = await lstat(path);
      if (
        captureOnly &&
        stat.isFile() &&
        !(stat.mode & 0o111) &&
        isCaptureRecord(name, destination)
      ) {
        continue;
      }
      const bytes = stat.isSymbolicLink() ? await readlink(path) : await readFile(path);
      entries.push([name, stat.mode, digest(bytes)]);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      if (!captureOnly) {
        entries.push([name, 'deleted']);
      }
    }
  }
  return digest(JSON.stringify(entries));
}

function outside(parent: string, child: string) {
  const relation = relative(parent, child);
  return relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation);
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
  return result.stdout;
}

export function parseReply(stdout: string): { status: string; findings: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if (!('status' in value) || typeof value.status !== 'string') {
    return null;
  }
  if (!('findings' in value) || typeof value.findings !== 'string') {
    return null;
  }
  return { status: value.status, findings: value.findings };
}

function parseReview(stdout: string) {
  const reply = parseReply(stdout);
  if (!reply || !['accepted', 'needs_changes'].includes(reply.status)) {
    return null;
  }
  if (reply.status === 'needs_changes' && !reply.findings.trim()) {
    return null;
  }
  return reply;
}

async function runModel(
  config: Config,
  state: State,
  role: ActorRole,
  prompt: string,
  persist: Persist,
): Promise<ModelResult> {
  const remaining = config.modelTimeMs - state.modelMs;
  if (state[role] >= config[`${role}Limit`] || remaining <= 0) {
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
  await persist();
  if (result.timedOut) {
    return { stop: 'execution_limit' };
  }
  if (result.code !== 0) {
    return { stop: `${role}_failed` };
  }
  return result;
}

export const testInstructions =
  'Before creating or updating tests, apply the target test policy when present and these common test criteria. Ask what realistic bug deleting each relevant test would miss. Compare its additional assurance with runtime, flakiness and maintenance cost; actively remove or consolidate tests that do not justify that cost. Do not retain tests merely for reassurance, test counts or coverage metrics. Explain any lost detection conditions and the remaining verification.';

export function captureInstructions(capture: { destination: string } | null) {
  return [
    ...(capture
      ? [
          `Prepare the configured capture command and required media for this Issue. Reference final media at ${capture.destination}/.`,
          'The host runs capture separately from normal tests. Its command receives the absolute output directory as the final argument. Save only PNG/JPEG/WebP/MP4/WebM files directly under that directory (CAPTURE_OUTPUT for browser definitions). Close video contexts and save video there. Do not write media or reports into the checkout during capture.',
        ]
      : [
          'This target declares no capture. If the agreed Issue needs media, return needs_human to configure required capture before execution.',
        ]),
    'Return repaired when implementation and test/capture definitions are ready; pending host execution alone is not needs_human. Actual requirement or authorization decisions still require needs_human.',
  ].join(' ');
}

async function hostCommand(
  config: Config,
  state: State,
  role: 'capture' | 'check' | 'writing',
  argv: string[],
  persist: Persist,
) {
  const attempt =
    role !== 'check'
      ? state.events.filter((event) => event.role === role).length + 1
      : state.checks;
  const prefix = resolve(config.runDir, `${role}-${attempt}`);
  state.active = { role, prefix };
  await persist();
  const result = await command(
    argv,
    config.cwd,
    '',
    role === 'writing' ? writingHostTimeoutMs : config.checkTimeMs,
    prefix,
  );
  state.active = null;
  state.events.push({
    role,
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

async function needsCapture(config: Config, previousSource?: string) {
  const { cwd } = config;
  if (previousSource !== undefined) {
    return (
      previousSource !== (await snapshot(cwd, !config.captureRequired, config.captureDestination))
    );
  }
  if (config.captureRequired) {
    return true;
  }
  const tracked = await command(['git', 'diff', '--name-only', '-z', 'HEAD'], cwd, '', 10000);
  const untracked = await command(
    ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
    cwd,
    '',
    10000,
  );
  if (tracked.code !== 0 || untracked.code !== 0) {
    return true;
  }
  const paths = `${tracked.stdout}${untracked.stdout}`.split('\0').filter(Boolean);
  return !(paths.length > 0 && paths.every((path) => path.endsWith('.md')));
}

async function verifyWriting(config: Config, state: State, persist: Persist) {
  if (!config.writing) {
    return undefined;
  }
  const writing = await hostCommand(config, state, 'writing', config.writing, persist);
  state.findings = `Writing logs: ${writing.prefix}.stdout and ${writing.prefix}.stderr`;
  if (digest(await readIssue(config)) !== state.issueHash) {
    return 'requirements_changed' as const;
  }
  return writing.code !== 0 || writing.timedOut ? ('writing_failed' as const) : undefined;
}

async function verifyHost(
  config: Config,
  state: State,
  persist: Persist,
): Promise<{ stop?: StopReason; findings?: string }> {
  const writingStop = await verifyWriting(config, state, persist);
  if (writingStop) {
    return { stop: writingStop };
  }
  state.source = await snapshot(config.cwd);
  if (config.capture && (await needsCapture(config, state.captureSource))) {
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
    );
    const changed = await targetChange(config, state);
    if (changed) {
      return { stop: changed };
    }
    state.findings = `Capture logs: ${capture.prefix}.stdout and ${capture.prefix}.stderr; environment stops require the host operator, execution failures return to repair.`;
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
    state.source = await snapshot(config.cwd);
    state.captureSource = await snapshot(
      config.cwd,
      !config.captureRequired,
      config.captureDestination,
    );
    await persist();
  }
  return verifyCheck(config, state, persist);
}

async function verifyCheck(
  config: Config,
  state: State,
  persist: Persist,
): Promise<{ stop?: StopReason; findings?: string }> {
  state.checks++;
  const checked = await hostCommand(config, state, 'check', config.check, persist);
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

async function evaluate(
  config: Config,
  state: State,
  issue: string,
  persist: Persist,
): Promise<{ stop?: StopReason; findings?: string }> {
  const prompt = [
    'Assess readiness for publication and human review against the full requirements: implementation, meaningful tests, required documentation, and prepared evidence.',
    'Read the target test policy when present and evaluate the tests relevant to this change against it. Ask what realistic bug deleting each relevant test would miss and weigh its additional assurance against runtime, flakiness and maintenance cost. Passing checks alone do not establish behavioral assurance. Return needs_changes for concrete missed behavior or unjustified tests, identifying the affected tests and reasons; do not reject justified deletion or consolidation merely because test counts or coverage metrics decrease.',
    'Apply the target documentation policy when present, including documentation-only changes; assess required updates and their evidence rather than requiring code or new tests for every Issue.',
    'Do not edit files or run check; its host-side result is exit 0. Do not trust implementation claims.',
    'Return needs_changes for deficiencies in those deliverables, including missing required media or unclear evidence provenance.',
    'The publisher owns PR creation, attachment upload and rendered-media checks; humans own review and approval. Their pending actions alone are not implementation defects.',
    'If the deliverables are ready, return accepted and identify the remaining publisher/human actions in findings. Do not claim those actions are completed or waive them.',
    'Return JSON {"status":"accepted"|"needs_changes","findings":"concrete unmet conditions or review summary and remaining handoff actions"}.',
    `Requirements:\n${issue}`,
  ].join('\n');
  const reviewed = await runModel(config, state, 'review', prompt, persist);
  if ('stop' in reviewed) {
    return { stop: reviewed.stop };
  }
  const changed = await targetChange(config, state);
  if (changed) {
    return { stop: changed };
  }
  const review = parseReview(reviewed.stdout);
  if (!review) {
    return { stop: 'invalid_review' };
  }
  if (review.status === 'accepted') {
    state.findings = review.findings;
    return { stop: 'ready_for_human_review' };
  }

  state.findings = review.findings;
  return { findings: review.findings };
}

async function cycle(
  config: Config,
  state: State,
  issue: string,
  persist: Persist,
): Promise<StopReason | null> {
  if (digest(await readIssue(config)) !== state.issueHash) {
    return 'requirements_changed';
  }
  const host = await verifyHost(config, state, persist);
  if (host.stop) {
    return host.stop;
  }
  let findings = host.findings;
  if (!findings) {
    const result = await evaluate(config, state, issue, persist);
    if (result.stop) {
      return result.stop;
    }
    findings = result.findings;
  }
  const prompt = [
    'Repair only within these agreed requirements. Read the current files and fix the root cause.',
    testInstructions,
    'Apply the target documentation policy when present to documentation-only changes and accompanying updates; keep current operating instructions accurate and historical results in evidence.',
    'Preserve agreed acceptance criteria and the verification needed to protect required behavior. Removing or consolidating unnecessary tests is allowed; making checks pass by hiding a realistic regression is not. Do not commit, push or publish.',
    'Run only targeted checks needed to diagnose or validate your repair; leave the full check command to the host.',
    'The host runs the configured verification after your changes; do not launch browsers or servers in the actor sandbox.',
    captureInstructions(
      config.capture && config.captureDestination
        ? { destination: config.captureDestination }
        : null,
    ),
    'Return JSON with status repaired or needs_human, and findings explaining your changes or the necessary human decision.',
    'If requirements, permissions or execution limits must change, report needs_human without changing them.',
    `Requirements:\n${issue}\nFailure evidence:\n${findings}`,
  ].join('\n');
  const repaired = await runModel(config, state, 'repair', prompt, persist);
  if ('stop' in repaired) {
    return repaired.stop;
  }
  state.findings = parseReply(repaired.stdout)?.findings;
  return repairOutcome(repaired.stdout);
}

function repairOutcome(stdout: string): StopReason | null {
  const value = parseReply(stdout);
  if (!value || !['repaired', 'needs_human'].includes(value.status)) {
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
  state ??= {
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
  if (state.result) {
    const unchanged =
      state.issueHash === digest(issue) && state.source === (await snapshot(config.cwd));
    return { ...state, result: unchanged ? state.result : 'target_changed_after_stop' };
  }
  await persist();
  while (!state.result) {
    state.result = await cycle(config, state, issue, persist);
  }
  await persist();
  return state;
}

export async function withInterrupts<T>(action: () => Promise<T>): Promise<T> {
  interrupted = false;
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const result = await action();
    assertRunning();
    return result;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
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
