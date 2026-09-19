import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  stat,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { develop } from '../development.ts';
import { repairInstructions } from '../repair.ts';
import { command, interruptionMessage, withInterrupts } from '../process.ts';
import type { Config, State } from '../input.ts';
import { isRecord } from '../values.ts';
import { reviewSummary } from '../review.ts';
import type { Review } from '../review.ts';
import { initializeTarget, githubTarget, targetConfig } from './support/target.ts';

const issue = JSON.stringify({
  title: 'Make result visible',
  body: 'Show the requested result.',
  state: 'OPEN',
  updatedAt: '1',
});
const reportPath = 'research/result-behavior.md';
const reportContent = 'Reviewed finding: keep the result visible until reset.\n';
const secondReport = 'research/result-validation.md';

async function commitReport(repo: string) {
  await mkdir(join(repo, 'research'));
  await writeFile(join(repo, reportPath), reportContent);
  await writeFile(join(repo, secondReport), 'Existing result tests cover reset and empty input.\n');
  await git(repo, 'add', '--', reportPath, secondReport);
  await git(repo, 'commit', '-m', 'required research');
  return git(repo, 'rev-parse', `HEAD:${reportPath}`);
}
const verificationStops = {
  review_storage_failed: 'writable evidence storage',
  invalid_review: 'raw review response',
  check_unavailable: 'check startup or timeout',
  capture_unavailable: 'capture logs and configured runtime',
  human_decision_required: 'human decision described in the repair findings',
  execution_limit: 'human must decide any new scope or budget',
} as const;

function isVerificationStop(mode: string): mode is keyof typeof verificationStops {
  return Object.hasOwn(verificationStops, mode);
}

function verificationReason(mode: string, reviews: number) {
  if (isVerificationStop(mode)) {
    return mode;
  }
  return mode === 'review_failure'
    ? 'review_failed'
    : mode === 'source_changed' && reviews > 1
      ? 'target_changed_after_stop'
      : 'ready_for_human_review';
}

const stopReasons = {
  worktree_failure: /worktree fixture failure/,
  setup_failure: /setup fixture failure/,
  publication_unconfirmed: /PR author or body could not be confirmed/,
  attachment_failure: /attachment fixture failure/,
  ci_interruption: /Interrupted execution/,
  save_write_interruption: /Interrupted execution.*Result:/s,
  save_rename_interruption: /Interrupted execution.*Result:/s,
  save_stopped_interruption: /setup fixture failure.*Interrupted execution.*Result:/s,
  save_interruption_failure: /Interrupted execution.*result not saved.*storage fixture failure/s,
  save_failure: /setup fixture failure.*result not saved.*EISDIR/s,
  save_success_failure: /Local check and independent review accepted.*result not saved.*EEXIST/,
  denied_start: /GitHub push permission required/,
  no_ci: /Publishing requires expected CI checks/,
  permission_lost: /GitHub push permission required/,
  attachment_actor_changed: /Target configuration or GitHub actor changed/,
  initial_failure: /Initial implementation process failed/,
  initial_startup_failure: /Initial implementation process failed \(null\)/,
  initial_timeout: /Initial implementation timed out/,
  initial_interruption: /Interrupted execution/,
  needs_human: /Human decision required: Need agreement on scope/,
  invalid_reply: /Invalid implementation reply/,
  blank_human: /Invalid implementation reply/,
  review_failure: /Verification stopped: review_failed/,
  requirements_changed: /Requirements changed during implementation/,
  source_changed: /Verification stopped: target_changed_after_stop/,
  ci_publication_unavailable: /unavailable:/,
  ci_publication_timeout: /unavailable:/,
  ci_publication_invalid_json: /invalid_response:/,
  ci_publication_head_target_changed: /target_changed:/,
  ci_publication_base_target_changed: /target_changed:/,
  ci_publication_state_target_changed: /target_changed:/,
  ci_publication_url_target_changed: /target_changed:/,
  ci_publication_body_target_changed: /target_changed:/,
  ci_failure: /failed:/,
  ci_final_unavailable: /unavailable:/,
  ci_final_target_changed: /target_changed:/,
  retired_writing: /writing is no longer supported; remove writing from .dotagents.json/,
  wrong_repo: /GitHub repository mismatch/,
  missing_check: /Verification command is required/,
  wrong_issue: /Issue does not match target repository/,
  wrong_push: /Remote\/repository mismatch/,
  actor_changed: /Target configuration or GitHub actor changed/,
  local_actor_changed: /Target configuration or GitHub actor changed/,
  config_changed: /Target configuration or GitHub actor changed/,
  branch_changed: /Actor changed branch or HEAD/,
  head_changed: /Actor changed branch or HEAD/,
};

type StopMode = keyof typeof stopReasons | keyof typeof verificationStops;

function stopReason(mode: StopMode) {
  return isVerificationStop(mode) ? new RegExp(`Verification stopped: ${mode}`) : stopReasons[mode];
}

async function checkStop(mode: StopMode, dir: string, reviews: number, implementations: number) {
  if (
    [
      'denied_start',
      'no_ci',
      'wrong_repo',
      'missing_check',
      'retired_writing',
      'wrong_issue',
      'wrong_push',
    ].includes(mode)
  ) {
    expect(implementations).toBe(0);
    expect(reviews).toBe(0);
    expect(existsSync(dir)).toBe(false);
    return;
  }
  expect(existsSync(join(dir, 'stopped.txt'))).toBe(false);
  if (mode.startsWith('save_')) {
    return;
  }
  const saved = await savedResult(dir);
  expect([saved.reasonCode, saved.reason].join(': ')).toMatch(stopReason(mode));
  expect(saved.status).toBe('stopped');
  expect(saved.nextAction).toBeTruthy();
  expect(saved.evidence).toBe(dir);
  expect(saved.issue).toContain('/issues/99');
  expect(saved.startCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(saved.remaining).toContain('human_review');
  checkEarlyStop(mode, saved, reviews, implementations);
  if (isVerificationStop(mode)) {
    expect(saved.reasonCode).toBe(mode);
    expect(saved.nextAction).toContain(verificationStops[mode]);
    expect(saved.nextAction).toContain('Evidence: ' + join(dir, 'verification/state.json'));
    expect(saved.nextAction).toContain(
      'reconfirm target, evidence, authorization and verification',
    );
    expect(saved.nextAction).toContain('Do not resume this run');
    expect(saved.publication).toBe('not_attempted');
    expect(saved.remaining).toContain('local_verification');
    expect(reviews).toBe(1);
  }
  if (
    [
      'publication_unconfirmed',
      'attachment_failure',
      'attachment_actor_changed',
      'ci_interruption',
    ].includes(mode)
  ) {
    await checkPublicationStop(mode, dir, saved);
  }
  const initialStop =
    mode.startsWith('initial_') || ['needs_human', 'invalid_reply', 'blank_human'].includes(mode);
  if (initialStop || mode === 'requirements_changed') {
    expect(reviews).toBe(0);
  }
  if (!initialStop) {
    return;
  }
  expect(existsSync(join(dir, 'verification-config.json'))).toBe(false);
  expect(await readFile(join(dir, 'implementation.stderr'), 'utf8')).toContain(
    mode === 'initial_startup_failure' ? 'ENOENT' : 'Actor diagnostic',
  );
  expect(existsSync(join(dir, 'implementation.json'))).toBe(mode !== 'initial_interruption');
  if (['invalid_reply', 'needs_human', 'blank_human'].includes(mode)) {
    expect(implementations).toBe(1);
    expect(saved.publication).toBe('not_attempted');
    expect(await readFile(join(dir, 'checkout/result.txt'), 'utf8')).toBe('implemented');
    expect(await readFile(join(dir, 'implementation.stdout'), 'utf8')).toBe(
      implementationResult(mode).stdout,
    );
    expect(existsSync(join(dir, 'implementation-summary.md'))).toBe(mode === 'needs_human');
  }
  if (mode === 'needs_human') {
    expect(await readFile(join(dir, 'implementation-summary.md'), 'utf8')).toBe(
      'Need agreement on scope',
    );
  }
}

function checkEarlyStop(
  mode: string,
  saved: Record<string, unknown>,
  reviews: number,
  implementations: number,
) {
  if (['worktree_failure', 'setup_failure'].includes(mode)) {
    expect(saved.phase).toBe(mode === 'worktree_failure' ? 'preparation' : 'implementation');
    expect(saved.operation).toBe(mode === 'worktree_failure' ? 'prepare worktree' : 'setup-1');
    expect(saved.publication).toBe('not_attempted');
    expect(reviews).toBe(0);
    expect(implementations).toBe(0);
  }
  if (mode === 'needs_human') {
    expect(saved.reasonCode).toBe('human_decision_required');
    expect(saved.nextAction).toContain('human decision');
  }
  if (mode === 'review_failure' || mode === 'source_changed') {
    expect(saved.phase).toBe('verification');
    expect(saved.reasonCode).toBe(
      mode === 'review_failure' ? 'review_failed' : 'target_changed_after_stop',
    );
  }
}

async function savedResult(dir: string) {
  const saved: unknown = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  assert(isRecord(saved));
  return saved;
}

async function checkVerificationEvidence(
  mode: string,
  dir: string,
  expected: Pick<State, 'findings' | 'reviewHistory' | 'result'>,
  rawReview: string,
) {
  expect(existsSync(join(dir, 'verification-summary.md'))).toBe(false);
  if (
    ![
      'success',
      'other_repo',
      'local_denied',
      'local_no_ci',
      'review_failure',
      'source_changed',
    ].includes(mode) &&
    !isVerificationStop(mode)
  ) {
    return;
  }
  const result = await savedResult(dir);
  assert(typeof result.evidence === 'string');
  const statePath = join(result.evidence, 'verification/state.json');
  if (mode !== 'success') {
    expect(result.details).toBe(statePath);
  }
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject(expected);
  expect(await readFile(join(result.evidence, 'verification/review-2.stdout'), 'utf8')).toBe(
    rawReview,
  );
}

async function checkPublicationStop(mode: string, dir: string, saved: Record<string, unknown>) {
  expect(saved.publication).toBe(mode === 'publication_unconfirmed' ? 'unconfirmed' : 'published');
  expect(saved.phase).toBe(mode === 'ci_interruption' ? 'ci' : 'publication');
  expect(saved.commit).toBe(await git(join(dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.branch).toBe('codex/development-99');
  expect(saved.nextAction).toContain('GitHub');
  expect(saved.ci).toBeUndefined();
  if (mode === 'publication_unconfirmed') {
    expect(saved.url).toBeUndefined();
    expect(existsSync(join(dir, 'pr-url.txt'))).toBe(false);
  } else {
    expect(saved.url).toBe(await readFile(join(dir, 'pr-url.txt'), 'utf8'));
    expect(saved.url).toContain('/pull/100');
  }
  if (mode.startsWith('attachment_')) {
    expect(saved.remaining).toEqual(['ci', 'human_review', 'attachments', 'rendered_media_check']);
  }
  if (mode === 'ci_interruption') {
    expect(await readFile(join(dir, 'pr-publication.stdout'), 'utf8')).toContain('headRefOid');
    expect(existsSync(join(dir, 'ci-final-target.stdout'))).toBe(false);
  }
}

async function checkSaveFailure(
  mode: string,
  dir: string,
  implementations: number,
  reviews: number,
) {
  if (mode === 'save_failure') {
    expect((await stat(join(dir, 'result.json'))).isDirectory()).toBe(true);
    expect(await readFile(join(dir, 'setup-1.stderr'), 'utf8')).toContain('setup fixture failure');
    expect(implementations).toBe(0);
    expect(reviews).toBe(0);
  }
  if (mode.startsWith('save_') && mode.includes('interruption')) {
    const saved = await savedResult(dir);
    if (mode === 'save_interruption_failure') {
      // A failed replacement retains the previous complete record, not a partial JSON.
      expect(saved.status).toBe('ready_for_human_review');
    } else {
      expect(saved.status).toBe('stopped');
      expect(saved.reason).toContain(interruptionMessage);
      expect(saved.nextAction).toContain('Reconcile');
    }
    if (['save_rename_interruption', 'save_interruption_failure'].includes(mode)) {
      expect(saved.publication).toBe('published');
      expect(saved.url).toBe(await readFile(join(dir, 'pr-url.txt'), 'utf8'));
      expect(saved.commit).toBe(await git(join(dir, 'checkout'), 'rev-parse', 'HEAD'));
      expect(saved.ci).toBe('passed');
      expect(saved.ciDetails).toMatchObject({ status: 'passed' });
      expect(saved.remaining).toEqual(['human_review']);
    }
    if (mode === 'save_write_interruption') {
      expect(saved.publication).toBe('not_attempted');
      expect(saved.reasonCode).toBeUndefined();
      expect(saved.remaining).toEqual(['publication', 'ci', 'human_review']);
    }
    if (mode === 'save_stopped_interruption') {
      expect(saved.reason).toContain('setup fixture failure');
      expect(await readFile(join(dir, 'setup-1.stderr'), 'utf8')).toContain(
        'setup fixture failure',
      );
      expect(implementations).toBe(0);
      expect(reviews).toBe(0);
    }
  }
  if (mode === 'save_success_failure') {
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe('previous complete record');
    expect(await readFile(join(dir, 'result.json.tmp'), 'utf8')).toBe(
      'retained temporary evidence',
    );
    expect(implementations).toBe(1);
    expect(reviews).toBe(1);
  }
}

// Notify the real interrupt scope at deterministic async storage boundaries.
function interruptResultSave(mode: string, dir: string) {
  if (!mode.startsWith('save_') || !mode.includes('interruption')) {
    return () => {};
  }
  const originalWrite = fs.writeFile;
  const originalRename = fs.rename;
  let notified = false;
  const write = spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (args[0] === join(dir, 'result.json.tmp')) {
      if (notified && mode === 'save_interruption_failure') {
        throw Error('storage fixture failure');
      }
      if (!notified && ['save_write_interruption', 'save_stopped_interruption'].includes(mode)) {
        notified = true;
        process.emit('SIGINT');
      }
    }
    await originalWrite(...args);
  });
  const rename = spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await originalRename(...args);
    if (
      args[1] === join(dir, 'result.json') &&
      !notified &&
      ['save_rename_interruption', 'save_interruption_failure'].includes(mode)
    ) {
      notified = true;
      process.emit('SIGTERM');
    }
  });
  return () => {
    write.mockRestore();
    rename.mockRestore();
  };
}

async function implementReply(
  mode: string,
  cwd: string,
  input: string,
  timeout: number | null,
  prefix?: string,
) {
  if (mode === 'success') {
    // Transport only; instruction meaning is assessed by independent review.
    expect(input).toContain(repairInstructions({ destination: 'review/media' }));
    for (const instruction of [
      'Do not change the Issue or weaken acceptance criteria',
      'Do not commit, push or publish',
      'Leave configured full verification to the host after your changes',
      'do not launch browsers or servers in your sandbox',
    ]) {
      expect(input).toContain(instruction);
    }
    expect(input).not.toContain('Failure evidence:');
  }
  if (mode === 'initial_startup_failure') {
    return command(['/nonexistent-implementation-test-command'], cwd, input, timeout, prefix);
  }
  const response = implementationResult(mode);
  await writeFile(`${prefix}.stdout`, response.stdout);
  await writeFile(`${prefix}.stderr`, 'Actor diagnostic');
  if (mode === 'initial_interruption') {
    throw Error(interruptionMessage);
  }
  await writeFile(join(cwd, 'result.txt'), 'implemented');
  return response;
}

const implementationResults: Record<string, Partial<Awaited<ReturnType<typeof command>>>> = {
  initial_failure: { code: 1 },
  initial_timeout: { timedOut: true },
  invalid_reply: { stdout: JSON.stringify({ status: 'accepted', findings: 'Unexpected status' }) },
  blank_human: { stdout: JSON.stringify({ status: 'needs_human', findings: ' \t\r\n\u3000' }) },
  needs_human: {
    stdout: JSON.stringify({ status: 'needs_human', findings: 'Need agreement on scope' }),
  },
};
function implementationResult(mode: string) {
  return {
    ...ok(
      JSON.stringify({ status: 'repaired', findings: 'Implementation claim, not verification' }),
    ),
    ms: mode === 'success' ? 1200001 : 500,
    ...implementationResults[mode],
  };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, ms: 1 });
async function git(cwd: string, ...args: string[]) {
  const result = await command(['git', ...args], cwd, '', 10000);
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

async function prepareInput(repo: string, mode: string, settings: typeof targetConfig) {
  if (mode === 'other_repo') {
    await writeFile(join(repo, 'notes.txt'), 'committed notes');
    await git(repo, 'add', '--', 'notes.txt');
    await commitReport(repo);
    await writeFile(join(repo, 'notes.txt'), 'staged notes');
    await git(repo, 'add', '--', 'notes.txt');
    await writeFile(join(repo, 'notes.txt'), 'working notes');
    await chmod(join(repo, 'notes.txt'), 0o755);
    await writeFile(join(repo, 'unrelated.txt'), 'retain');
    await chmod(join(repo, 'unrelated.txt'), 0o751);
  }
  if (mode === 'missing_check' || mode === 'retired_writing') {
    await writeFile(
      join(repo, '.dotagents.json'),
      JSON.stringify({
        ...settings,
        ...(mode === 'missing_check' ? { check: [] } : { writing: { documents: ['README.md'] } }),
      }),
    );
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'unset verification');
  }
  if (mode === 'wrong_push') {
    await git(
      repo,
      'remote',
      'set-url',
      '--push',
      settings.remote,
      'git@github.com:other/repo.git',
    );
  }
  return git(repo, 'rev-parse', 'HEAD');
}

async function pendingWork(repo: string) {
  if (!existsSync(join(repo, 'notes.txt'))) {
    return undefined;
  }
  return {
    status: await git(repo, 'status', '--porcelain'),
    staged: await git(repo, 'diff', '--cached', '--binary'),
    working: await git(repo, 'diff', '--binary'),
    notes: await readFile(join(repo, 'notes.txt'), 'utf8'),
    notesMode: (await stat(join(repo, 'notes.txt'))).mode,
    untracked: await readFile(join(repo, 'unrelated.txt'), 'utf8'),
    untrackedMode: (await stat(join(repo, 'unrelated.txt'))).mode,
  };
}

function targetResponse(
  mode: string,
  reply: string,
  repository: string,
  reviews: number,
  publications: number,
) {
  if (mode === 'wrong_repo') {
    return reply.replace(repository, 'other/repo');
  }
  if (
    ['denied_start', 'local_denied'].includes(mode) ||
    (mode === 'permission_lost' && reviews > 0)
  ) {
    reply = reply.replace('"push":true', '"push":false');
  }
  if (mode === 'attachment_actor_changed' && publications > 0) {
    reply = reply.replace('operator', 'different-operator');
  }
  return ['actor_changed', 'local_actor_changed'].includes(mode) && reviews > 0
    ? reply.replace('operator', 'different-operator')
    : reply;
}
async function developmentArguments(mode: string, repo: string, original: string) {
  if (mode === 'other_repo') {
    return [
      '--start-commit',
      original,
      '--report',
      `${reportPath}=${await git(repo, 'rev-parse', `HEAD:${reportPath}`)}`,
      '--report',
      `${secondReport}=${await git(repo, 'rev-parse', `HEAD:${secondReport}`)}`,
    ];
  }
  return ['local_actor_changed', 'save_success_failure', 'save_write_interruption'].includes(mode)
    ? ['--no-publish']
    : [];
}
async function changeTarget(mode: string, config: Config, settings: typeof targetConfig) {
  switch (mode) {
    case 'config_changed':
      await writeFile(join(config.cwd, '.dotagents.json'), JSON.stringify(settings) + '\n');
      break;
    case 'branch_changed':
      await git(config.cwd, 'switch', '-c', 'unexpected');
      break;
    case 'head_changed':
      await git(config.cwd, 'add', '.');
      await git(config.cwd, 'commit', '-m', 'unexpected actor commit');
  }
}

const publicationChanges: Record<string, Record<string, string>> = {
  ci_publication_head_target_changed: { headRefOid: 'another-commit' },
  ci_publication_base_target_changed: { baseRefName: 'other-base' },
  ci_publication_state_target_changed: { state: 'CLOSED' },
  ci_publication_url_target_changed: { url: 'https://github.com/other/repo/pull/100' },
  ci_publication_body_target_changed: { body: 'Closes #990' },
};

function publicationView(mode: string, stdout: string) {
  if (mode === 'ci_publication_unavailable') {
    return { ...ok(stdout), code: 1, stderr: 'API unavailable in fixture' };
  }
  if (mode === 'ci_publication_timeout') {
    return { ...ok(stdout), timedOut: true };
  }
  return ok(mode === 'ci_publication_invalid_json' ? 'not JSON' : stdout);
}

async function prView(
  mode: string,
  argv: string[],
  cwd: string,
  settings: typeof targetConfig,
  timeout: number | null,
  attached: boolean,
) {
  const publication = argv.at(-1)?.includes('body');
  expect(timeout).toBe(660000);
  const finalRead = argv.at(-1) === 'headRefOid,baseRefName,state';
  if (mode === 'ci_final_unavailable' && finalRead) {
    return { ...ok('raw API response'), code: 1, stderr: 'API unavailable in fixture' };
  }
  const changed = mode === 'ci_final_target_changed' && finalRead;
  const stdout = JSON.stringify({
    url: `https://github.com/${settings.repository}/pull/100`,
    headRefOid: changed ? 'another-commit' : await git(cwd, 'rev-parse', 'HEAD'),
    baseRefName: settings.baseBranch,
    state: 'OPEN',
    body: attached ? 'Closes #99\nAttached media' : 'Closes #99',
    statusCheckRollup: [
      {
        name: 'checks',
        status: 'COMPLETED',
        conclusion:
          (mode === 'ci_failure' && publication) || (mode === 'success' && !attached)
            ? 'FAILURE'
            : 'SUCCESS',
      },
    ],
    ...(publication ? publicationChanges[mode] : {}),
  });
  return publication ? publicationView(mode, stdout) : ok(stdout);
}

async function checkPublicationEvidence(
  mode: string,
  dir: string,
  details: Record<string, unknown>,
) {
  const log = join(dir, 'pr-publication');
  expect(details.logs).toEqual([log]);
  expect(details.lastObservation).toBeNull();
  expect(details.timedOut).toBe(false); // The CI wait budget has not started.
  expect(existsSync(join(dir, 'ci-registration-1.stdout'))).toBe(false);
  expect(existsSync(join(dir, 'ci-final-target.stdout'))).toBe(false);
  expect(await readFile(join(dir, 'pr.json'), 'utf8')).toBe(
    await readFile(`${log}.stdout`, 'utf8'),
  );
  const reasons: Record<string, string> = {
    ci_publication_unavailable: 'exit 1',
    ci_publication_timeout: 'timedOut true',
    ci_publication_invalid_json: 'JSON',
    ci_publication_head_target_changed: 'head=another-commit',
    ci_publication_base_target_changed: 'base=other-base',
    ci_publication_state_target_changed: 'state=CLOSED',
    ci_publication_url_target_changed: 'URL or Issue reference changed',
    ci_publication_body_target_changed: 'URL or Issue reference changed',
  };
  expect(details.reason).toContain(reasons[mode] ?? 'unexpected publication mode');
  if (mode.endsWith('unavailable')) {
    expect(await readFile(`${log}.stderr`, 'utf8')).toBe('API unavailable in fixture');
  }
}

async function checkCiEvidence(mode: string, dir: string, prReads: string[]) {
  if (!mode.startsWith('ci_') || mode === 'ci_interruption') {
    return;
  }
  expect(await readFile(join(dir, 'pr-url.txt'), 'utf8')).toContain('/pull/100');
  const body = await readFile(join(dir, 'pr.md'), 'utf8');
  expect(body).toContain('公開・CI・公開後確認・人の承認は未完了');
  expect(body).not.toMatch(/媒体を添付|rendered_media_check|新規添付対象/);
  const saved: unknown = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  assert(isRecord(saved) && isRecord(saved.ciDetails));
  expect(saved.url).toBe(await readFile(join(dir, 'pr-url.txt'), 'utf8'));
  expect(saved).toMatchObject({
    publication: 'published',
    requiredChecks: ['checks'],
    ci: ciStatus(mode),
    remaining: ['ci', 'human_review'],
  });
  expect(saved.commit).toBe(await git(join(dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.nextAction).toContain(ciAction(mode));
  if (mode === 'ci_failure') {
    expect(prReads).toEqual([
      'url,headRefOid,baseRefName,state,body,statusCheckRollup',
      'headRefOid,baseRefName,state',
    ]);
  }
  if (mode.startsWith('ci_publication_')) {
    expect(prReads).toEqual(['url,headRefOid,baseRefName,state,body,statusCheckRollup']);
    await checkPublicationEvidence(mode, dir, saved.ciDetails);
    return;
  }
  const published: unknown = JSON.parse(await readFile(join(dir, 'pr.json'), 'utf8'));
  assert(isRecord(published));
  expect(published.headRefOid).toBe(saved.commit);
  const log = join(dir, mode.startsWith('ci_final_') ? 'ci-final-target' : 'pr-publication');
  expect(saved.ciDetails.logs).toContain(log);
  expect(await readFile(`${log}.stdout`, 'utf8')).toContain(
    mode.endsWith('unavailable') ? 'raw API response' : 'headRefOid',
  );
  if (mode.startsWith('ci_final_')) {
    expect(saved.ciDetails.lastObservation).toMatchObject({ status: 'passed' });
  }
  if (mode.endsWith('unavailable')) {
    expect(await readFile(`${log}.stderr`, 'utf8')).toBe('API unavailable in fixture');
  }
}

for (const mode of [
  'success',
  'worktree_failure',
  'setup_failure',
  'publication_unconfirmed',
  'attachment_failure',
  'ci_interruption',
  'save_failure',
  'save_success_failure',
  'save_write_interruption',
  'save_rename_interruption',
  'save_stopped_interruption',
  'save_interruption_failure',
  'no_ci',
  'local_no_ci',
  'denied_start',
  'permission_lost',
  'local_denied',
  'attachment_actor_changed',
  'initial_failure',
  'initial_startup_failure',
  'initial_timeout',
  'initial_interruption',
  'needs_human',
  'invalid_reply',
  'blank_human',
  'review_failure',
  ...Object.keys(verificationStops).filter(isVerificationStop),
  'requirements_changed',
  'source_changed',
  'ci_publication_unavailable',
  'ci_publication_timeout',
  'ci_publication_invalid_json',
  'ci_publication_head_target_changed',
  'ci_publication_base_target_changed',
  'ci_publication_state_target_changed',
  'ci_publication_url_target_changed',
  'ci_publication_body_target_changed',
  'ci_failure',
  'ci_final_unavailable',
  'ci_final_target_changed',
  'retired_writing',
  'wrong_repo',
  'missing_check',
  'wrong_issue',
  'wrong_push',
  'other_repo',
  'actor_changed',
  'local_actor_changed',
  'config_changed',
  'branch_changed',
  'head_changed',
] as const) {
  test(`development ${mode}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'development run-')));
    const repo = join(root, 'repo');
    const dir = join(root, 'run');
    await mkdir(repo);
    const settings = {
      ...targetConfig,
      setup: [['sh', '-c', 'printf configured > setup.txt']],
      check: [
        'sh',
        '-c',
        'test "$(cat result.txt)" = implemented && test "$(cat setup.txt)" = configured',
      ],
      capture: ['success', 'attachment_actor_changed', 'attachment_failure'].includes(mode)
        ? {
            command: ['capture-fixture'],
            destination: 'review/media',
            required: false,
          }
        : null,
    };
    if (['no_ci', 'local_no_ci'].includes(mode)) {
      settings.ciChecks = [];
    }
    await initializeTarget(repo, settings);
    const original = await prepareInput(repo, mode, settings);
    const pending = await pendingWork(repo);
    const review: Review = {
      status: 'accepted',
      targetId: 'internal-current-target',
      findings: `Internal narrative: ${dir}/verification/review-2.stdout\nRAW_LOG_ONLY`,
      assessments: {
        code: `Keep the requested result visible until reset so readers can inspect it. The /home/settings route now preserves the selected filters; see https://example.com/results. 詳細は${dir}/verification/check-2.stdoutを確認済みだが実サービスのタイミングは未確認。`,
        requirements: 'Issue #99 requires a visible result; result.txt now retains that result.',
        tests: `Reset and empty-input checks passed; live service behavior remains unverified. Details: ${dir}/verification/check-2.stdout`,
        documentation:
          'The historical pointer observation applies only to pointer input; focus movement remains an unagreed proposal.',
      },
      items: [
        {
          id: 'R1-result',
          introducedIn: 'internal-old-target',
          kind: 'defect',
          area: 'requirements',
          required: true,
          location: { path: 'result.txt', line: 1 },
          condition: 'Reset left stale content.',
          impact: 'Readers could see an obsolete result.',
          evidence: `RAW_LOG_ONLY\n${dir}/verification/check-1.stderr`,
          action: 'Clear the retained result on reset.',
          disposition: 'fixed',
          reason: `Reset now clears the result, confirmed by the reset check (${dir}/verification/check-2.stdout).`,
        },
        {
          id: 'R2-live',
          introducedIn: 'internal-current-target',
          kind: 'concern',
          area: 'tests',
          required: false,
          location: { path: null, line: null },
          condition: 'Live service timing is unmeasured.',
          impact: 'Timing may differ in production.',
          evidence: 'Only simulated service responses were available.',
          action: '担当AI: Report live service timing as unverified.',
          disposition: 'open',
          reason: 'This run verifies the agreed local behavior only.',
        },
      ],
      documents: [
        {
          path: '.dotagents.json',
          role: 'current',
          reason: 'Defines the local check; its success does not establish live service behavior.',
        },
      ],
      handoff: [
        `担当AI: 実サービスAの応答が遅い場合、結果の保持時間を計測する。現時点では未計測（${dir}/verification/check-2.stdout）。`,
        '運用担当: 実サービスBの応答が遅い場合、結果の保持時間を計測する。現時点では未計測。',
      ],
    };
    const firstItem = review.items[0];
    assert(firstItem);
    const history: Review[] = [
      {
        ...review,
        status: 'needs_changes',
        targetId: 'internal-old-target',
        items: [
          { ...firstItem, disposition: 'open', reason: 'Still reproducible in the first check.' },
        ],
      },
      review,
    ];
    const internal = JSON.stringify(history);
    const { status: _status, items, ...details } = review;
    const rawReview = JSON.stringify({
      ...details,
      updates: [{ id: firstItem.id, disposition: firstItem.disposition, reason: firstItem.reason }],
      newItems: items
        .slice(1)
        .map(({ introducedIn: _introducedIn, disposition: _disposition, ...item }) => item),
    });
    const summary = reviewSummary(history, [
      join(dir, 'verification/review-1.json'),
      join(dir, 'verification/review-2.json'),
    ]);
    let implementations = 0,
      reviews = 0,
      pushes = 0,
      publications = 0;
    const expectedPublications = Number(
      mode.startsWith('ci_') ||
        [
          'attachment_actor_changed',
          'attachment_failure',
          'publication_unconfirmed',
          'save_rename_interruption',
          'save_interruption_failure',
        ].includes(mode),
    );
    let attached = false;
    let attachmentWrites = 0;
    const prReads: string[] = [];
    async function github(argv: string[], cwd: string, timeout: number | null) {
      const targetReply = githubTarget(argv, settings);
      if (targetReply !== undefined) {
        return ok(targetResponse(mode, targetReply, settings.repository, reviews, publications));
      }
      switch (`${argv[1]}/${argv[2]}`) {
        case 'issue/view':
          return ok(
            mode === 'requirements_changed' && implementations
              ? issue.replace('visible', 'different')
              : issue,
          );
        case 'pr/edit':
          attachmentWrites++;
          if (mode === 'attachment_failure') {
            return { ...ok(), code: 1, stderr: 'attachment fixture failure' };
          }
          attached = true;
          return ok();
        case 'pr/view':
          prReads.push(argv.at(-1) ?? '');
          const response = await prView(mode, argv, cwd, settings, timeout, attached);
          if (mode === 'ci_interruption') {
            process.emit('SIGINT');
          }
          return response;
        default:
          throw Error('Unexpected gh call');
      }
    }
    async function localCommand(
      argv: string[],
      cwd: string,
      input: string,
      timeout: number | null,
      prefix?: string,
    ) {
      if (mode === 'worktree_failure' && argv[1] === 'worktree') {
        return { ...ok(), code: 1, stderr: 'worktree fixture failure' };
      }
      if (
        ['setup_failure', 'save_failure', 'save_stopped_interruption'].includes(mode) &&
        argv[0] === 'sh'
      ) {
        if (mode === 'save_failure') {
          await mkdir(join(dir, 'result.json'));
        }
        return command(
          ['sh', '-c', 'echo setup fixture failure >&2; exit 1'],
          cwd,
          input,
          timeout,
          prefix,
        );
      }
      if (mode === 'save_success_failure' && argv[0] === 'sh') {
        await writeFile(join(dir, 'result.json'), 'previous complete record');
        await writeFile(join(dir, 'result.json.tmp'), 'retained temporary evidence');
      }
      expect(timeout).toBe(660000);
      return command(argv, cwd, input, timeout, prefix);
    }
    const io = {
      command: async (
        argv: string[],
        cwd: string,
        input: string,
        timeout: number | null,
        prefix?: string,
      ) => {
        if (argv[0] === 'git' && argv.includes('push')) {
          pushes++;
          expect(argv).toContain(
            `remote.dotagents-publish.pushurl=https://github.com/${settings.repository}.git`,
          );
          expect(argv).toContain('credential.helper=!gh auth git-credential');
          return ok();
        }
        if (['git', 'sh'].includes(argv[0] ?? '')) {
          return localCommand(argv, cwd, input, timeout, prefix);
        }
        if (argv[0] === 'gh') {
          const response = await github(argv, cwd, timeout);
          if (prefix) {
            await writeFile(`${prefix}.stdout`, response.stdout);
            await writeFile(`${prefix}.stderr`, response.stderr);
          }
          return response;
        }
        expect(argv.slice(1, 3)).toEqual([
          new URL('../codex-actor.ts', import.meta.url).pathname,
          'repair',
        ]);
        expect(timeout).toBeNull();
        implementations++;
        if (mode === 'other_repo') {
          expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(original);
          expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('committed notes');
          expect((await stat(join(cwd, 'notes.txt'))).mode & 0o111).toBe(0);
          expect(existsSync(join(cwd, 'unrelated.txt'))).toBe(false);
          expect(await readFile(join(cwd, '.dotagents.json'), 'utf8')).toBe(
            JSON.stringify(settings),
          );
          expect(input).not.toContain('CAPTURE_OUTPUT');
          expect(input).not.toContain('Close video contexts');
          expect(input).toContain('If the agreed Issue needs media, return needs_human');
          expect(await readFile(join(cwd, 'setup.txt'), 'utf8')).toBe('configured');
          expect(await readFile(join(cwd, reportPath), 'utf8')).toBe(reportContent);
          expect(await readFile(join(cwd, secondReport), 'utf8')).toBe(
            'Existing result tests cover reset and empty input.\n',
          );
          expect(input).toContain(reportPath);
          expect(input).toContain(secondReport);
          expect(input).toContain(original);
          expect(input).not.toContain(reportContent.trim());
        }
        expect(input).toContain('Show the requested result.');
        return implementReply(mode, cwd, input, timeout, prefix);
      },
      verify: async (config: Config): Promise<State> => {
        expect(config).not.toHaveProperty('writing');
        expect(config.modelTimeMs).toBeNull();
        expect(config.repairLimit).toBe(2);
        expect(config.reviewLimit).toBe(2);
        expect(config.checkTimeMs).toBe(540000);
        reviews++;
        if (reviews === 1) {
          await changeTarget(mode, config, settings);
          await mkdir(config.runDir, { recursive: true });
          await writeFile(join(config.runDir, 'review-2.stdout'), rawReview);
          if (settings.capture) {
            const media = join(config.cwd, 'review/media');
            await mkdir(media, { recursive: true });
            await writeFile(join(media, 'view.png'), 'image');
          }
        }
        if (mode === 'other_repo') {
          expect(config.baseCommit).toBe(original);
          expect(config.reports).toEqual([
            { path: reportPath, blob: await git(repo, 'rev-parse', `HEAD:${reportPath}`) },
            { path: secondReport, blob: await git(repo, 'rev-parse', `HEAD:${secondReport}`) },
          ]);
          expect(config.check).toEqual(settings.check);
          expect(config.capture).toBeUndefined();
          expect((await command(config.check, config.cwd, '', 10000)).code).toBe(0);
        }
        if (mode === 'success') {
          expect(config.capture?.length).toBeGreaterThan(0);
        }
        expect(await readFile(join(config.cwd, 'result.txt'), 'utf8')).toBe('implemented');
        const state: State = {
          reviewFormat: 3,
          baseCommit: await git(config.cwd, 'rev-parse', 'HEAD'),
          reviewHistory: history,
          configHash: '',
          issueHash: '',
          repair: 0,
          review: 1,
          checks: 1,
          modelMs: 1,
          active: null,
          events: [],
          findings: summary,
          result: verificationReason(mode, reviews),
        };
        if (reviews === 1) {
          await writeFile(join(config.runDir, 'state.json'), JSON.stringify(state));
        }
        return state;
      },
      publish: async (args: string[]) => {
        expect(args).toContain('--repo');
        expect(args[args.indexOf('--actor') + 1]).toBe('operator');
        publications++;
        expect(pushes).toBe(1);
        const bodyPath = args[args.indexOf('--body-file') + 1];
        assert(bodyPath);
        expect(await readFile(bodyPath, 'utf8')).toBe(await readFile(join(dir, 'pr.md'), 'utf8'));
        if (mode === 'publication_unconfirmed') {
          throw Error('PR author or body could not be confirmed');
        }
        return `https://github.com/${settings.repository}/pull/100`;
      },
    };
    const restoreStorage = interruptResultSave(mode, dir);
    try {
      const args = [
        mode === 'wrong_issue'
          ? 'https://github.com/other/repo/issues/99'
          : `https://github.com/${settings.repository}/issues/99`,
        '--repo',
        repo,
        '--run-dir',
        dir,
      ];
      args.push(...(await developmentArguments(mode, repo, original)));
      if (mode === 'other_repo' || mode === 'local_denied' || mode === 'local_no_ci') {
        const result = await develop([...args, '--no-publish'], io);
        expect(await savedResult(dir)).toEqual(result);
        expect(existsSync(join(dir, 'stopped.txt'))).toBe(false);
        expect(result.status).toBe('verified_local');
        expect(pushes).toBe(0);
        expect(publications).toBe(0);
        expect(result.remaining).toContain('publication');
        expect(result.remaining).toContain('human_review');
        expect(result.remaining.includes('ci')).toBe(mode !== 'local_no_ci');
        expect(existsSync(join(dir, 'pr.md'))).toBe(false);
      } else if (mode === 'success') {
        const result = await develop(args, io);
        assert(result.ciDetails);
        expect(await savedResult(dir)).toEqual(result);
        expect(result.ci).toBe('passed');
        expect(prReads).toEqual([
          'url,headRefOid,baseRefName,state,body,statusCheckRollup',
          'headRefOid,baseRefName,state',
        ]);
        expect(result.ciDetails.logs).toEqual([
          join(dir, 'pr-publication'),
          join(dir, 'ci-final-target'),
        ]);
        expect(await readFile(join(dir, 'pr.json'), 'utf8')).toContain('Attached media');
        expect(existsSync(join(dir, 'ci-registration-1.stdout'))).toBe(false);
        expect(JSON.parse(await readFile(join(dir, 'implementation.json'), 'utf8'))).toEqual({
          code: 0,
          timedOut: false,
          ms: 1200001,
        });
        expect(
          JSON.parse(await readFile(join(dir, 'verification-config.json'), 'utf8')),
        ).toMatchObject({
          modelTimeMs: null,
          repairLimit: 2,
          reviewLimit: 2,
          checkTimeMs: 540000,
        });
        expect(result.url).toContain('/pull/100');
        expect(publications).toBe(1);
        const body = await readFile(join(dir, 'pr.md'), 'utf8');
        expect(body).toContain('Keep the requested result visible until reset');
        expect(body).toContain(
          '詳細は（内部パス省略）を確認済みだが実サービスのタイミングは未確認。',
        );
        expect(body).toContain('The /home/settings route now preserves the selected filters');
        expect(body).toContain('https://example.com/results');
        expect(body).toContain('Issue #99 requires a visible result');
        expect(body).toContain('Reset and empty-input checks passed');
        expect(body).toContain('Reset now clears the result, confirmed by the reset check');
        expect(body).toContain('Live service timing is unmeasured');
        expect(body).toContain('Report live service timing as unverified');
        expect(body).toContain('focus movement remains an unagreed proposal');
        expect(body).toContain(`/blob/${result.commit}/.dotagents.json`);
        expect(body).toContain('its success does not establish live service behavior');
        expect(body).toContain('対象commit: ' + result.commit);
        expect(body).toContain('Closes #99');
        [
          'CLI: PRを公開し、同じheadのCI（checks）',
          'CLI: 対象commitの媒体を添付する（review/media/view.png）',
          '担当AI: 添付後の実際のPR画面',
          '担当AI: 公開本文をIssue・対象commit・検証結果と照合',
          '人: 要求や権限の変更を判断',
          '公開・CI・公開後確認・人の承認は未完了',
          '担当AI: 実サービスAの応答が遅い場合、結果の保持時間を計測する。現時点では未計測（（内部パス省略））。',
          '運用担当: 実サービスBの応答が遅い場合、結果の保持時間を計測する。現時点では未計測。',
        ].forEach((task) => {
          expect(body.split(task)).toHaveLength(2);
        });
        expect(result.remaining).toEqual(['human_review', 'rendered_media_check']);
        [
          dir,
          'RAW_LOG_ONLY',
          'internal-old-target',
          'internal-current-target',
          'check-2.stdout',
          'review-1.json',
        ].forEach((privateDetail) => {
          expect(body).not.toContain(privateDetail);
        });
        expect(JSON.stringify(history)).toBe(internal);
        expect(body).not.toContain('Implementation claim, not verification');
        const beforeCollision = await readFile(join(dir, 'result.json'), 'utf8');
        await assert.rejects(() => develop(args, io), /EEXIST.*no safe new run directory/);
        expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe(beforeCollision);
        expect(existsSync(join(dir, 'stopped.txt'))).toBe(false);
        expect(implementations).toBe(1);
        expect(publications).toBe(1);
      } else {
        await assert.rejects(() => withInterrupts(() => develop(args, io)), stopReason(mode));
        await withInterrupts(async () => {});
        await checkSaveFailure(mode, dir, implementations, reviews);
        expect(publications).toBe(expectedPublications);
        expect(attachmentWrites).toBe(Number(mode === 'attachment_failure'));
        expect(pushes).toBe(expectedPublications);
        await checkStop(mode, dir, reviews, implementations);
        await checkCiEvidence(mode, dir, prReads);
        if (
          ['publication_unconfirmed', 'attachment_failure', 'attachment_actor_changed'].includes(
            mode,
          )
        ) {
          expect(prReads).toEqual([]);
        }
        if (mode === 'ci_interruption') {
          expect(prReads).toHaveLength(1);
        }
      }
      await checkVerificationEvidence(
        mode,
        dir,
        {
          findings: summary,
          reviewHistory: history,
          result: verificationReason(mode, 1),
        },
        rawReview,
      );
      expect(await git(repo, 'rev-parse', 'HEAD')).toBe(original);
      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('old');
      if (pending) {
        expect(await pendingWork(repo)).toEqual(pending);
      }
    } finally {
      restoreStorage();
      await withInterrupts(async () => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function startInputFixture(root: string) {
  const repo = join(root, 'repo');
  const dir = join(root, 'run');
  const settings = { ...targetConfig, setup: [['fixture-setup']] };
  await mkdir(repo);
  await initializeTarget(repo, settings);
  const beforeReport = await git(repo, 'rev-parse', 'HEAD');
  const blob = await commitReport(repo);
  const base = await git(repo, 'rev-parse', 'HEAD');
  const args = [
    '99',
    '--repo',
    repo,
    '--run-dir',
    dir,
    '--no-publish',
    '--report',
    `${reportPath}=${blob}`,
  ];
  const hooks: {
    setups: number;
    issue?: string;
    changeDuring?: (event: 'target' | 'issue' | 'setup', cwd: string) => Promise<void>;
  } = { setups: 0 };
  const io = {
    command: async (argv: string[], cwd: string, input: string, timeout: number | null) => {
      const reply = githubTarget(argv, settings);
      if (reply !== undefined) {
        if (argv[2] === 'user') {
          await hooks.changeDuring?.('target', cwd);
        }
        return ok(reply);
      }
      if (argv[0] === 'git') {
        return command(argv, cwd, input, timeout);
      }
      if (argv[0] === 'gh' && argv[1] === 'issue') {
        await hooks.changeDuring?.('issue', cwd);
        return ok(hooks.issue ?? issue);
      }
      if (argv[0] === 'fixture-setup') {
        hooks.setups++;
        await hooks.changeDuring?.('setup', cwd);
        return ok();
      }
      throw Error(`Implementation must not start: ${argv[0]}`);
    },
    verify: async (): Promise<State> => {
      throw Error('Verification must not start');
    },
    publish: async (): Promise<string> => {
      throw Error('Publication must not start');
    },
  };
  return { repo, dir, beforeReport, blob, base, args, hooks, io };
}

function testStartInput(
  name: string,
  run: (fixture: Awaited<ReturnType<typeof startInputFixture>>) => Promise<void>,
) {
  test(name, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'development-input-')));
    try {
      await run(await startInputFixture(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const handoffFailures = {
  missing: /Required report is missing from start commit.*research\/result-behavior.md/,
  uncommitted: /Required report is missing from start commit.*research\/result-behavior.md/,
  modified: /Required report has uncommitted content.*research\/result-behavior.md/,
  different_blob: /Required report differs from reviewed version.*research\/result-behavior.md/,
  different_start: /Start commit differs from handoff/,
  no_start: /Required reports need --start-commit/,
  setup_modified: /Required report has uncommitted content.*research\/result-behavior.md/,
};

for (const [mode, reason] of Object.entries(handoffFailures)) {
  testStartInput(`development stops incomplete research handoff: ${mode}`, async (fixture) => {
    const { repo, dir, beforeReport, base, args, hooks, io } = fixture;
    if (mode === 'missing' || mode === 'uncommitted') {
      await git(repo, 'reset', '--hard', beforeReport);
      if (mode === 'uncommitted') {
        await mkdir(join(repo, 'research'));
        await writeFile(join(repo, reportPath), reportContent);
      }
    }
    if (mode === 'modified') {
      await writeFile(join(repo, reportPath), 'Unchecked working report.\n');
    }
    if (mode === 'different_blob') {
      await writeFile(join(repo, reportPath), 'A different committed report.\n');
      await git(repo, 'add', '--', reportPath);
      await git(repo, 'commit', '-m', 'changed report');
      args.unshift(
        '--report',
        `${secondReport}=${await git(repo, 'rev-parse', `HEAD:${secondReport}`)}`,
      );
    }
    if (mode !== 'setup_modified') {
      await writeFile(join(repo, 'unrelated.txt'), 'Preserve other work');
    }
    const head = await git(repo, 'rev-parse', 'HEAD');
    const status = await git(repo, 'status', '--porcelain');
    hooks.changeDuring = async (event, cwd) => {
      if (event === 'setup') {
        await writeFile(join(cwd, reportPath), 'Setup replaced the reviewed content.\n');
      }
    };
    if (mode !== 'no_start') {
      args.push('--start-commit', mode === 'different_start' ? beforeReport : head);
    }
    await assert.rejects(() => develop(args, io), reason);
    expect(hooks.setups).toBe(mode === 'setup_modified' ? 1 : 0);
    expect(existsSync(join(dir, 'checkout'))).toBe(mode === 'setup_modified');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(repo, 'status', '--porcelain')).toBe(status);
    if (mode !== 'setup_modified') {
      expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('Preserve other work');
    } else {
      expect(head).toBe(base);
      expect(await readFile(join(repo, reportPath), 'utf8')).toBe(reportContent);
    }
  });
}

const startChanges = {
  config: async (repo: string) => {
    const path = join(repo, '.dotagents.json');
    await writeFile(path, (await readFile(path, 'utf8')) + '\n');
  },
  config_index: async (repo: string) => {
    const path = join(repo, '.dotagents.json');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original + '\n');
    await git(repo, 'add', '--', '.dotagents.json');
    await writeFile(path, original);
  },
  report: async (repo: string) => {
    await writeFile(join(repo, reportPath), 'Unreviewed report.\n');
  },
  report_index: async (repo: string) => {
    await writeFile(join(repo, reportPath), 'Unreviewed report.\n');
    await git(repo, 'add', '--', reportPath);
    await writeFile(join(repo, reportPath), reportContent);
  },
  report_mode: async (repo: string) => {
    await git(repo, 'config', 'core.filemode', 'false');
    await chmod(join(repo, reportPath), 0o755);
  },
  report_missing: async (repo: string) => {
    await rm(join(repo, reportPath));
  },
  head: async (repo: string) => {
    await git(repo, 'commit', '--allow-empty', '-m', 'concurrent HEAD change');
  },
  push: async (repo: string) => {
    await git(
      repo,
      'remote',
      'set-url',
      '--push',
      targetConfig.remote,
      'https://github.com/other/repo.git',
    );
  },
};

for (const [phase, change, reason] of [
  ['initial', 'config', /Target configuration differs from start commit/],
  ['initial', 'config_index', /Required start inputs have uncommitted changes/],
  ['initial', 'report_index', /Required start inputs have uncommitted changes/],
  ['initial', 'report_mode', /Required start inputs have uncommitted changes/],
  ['initial', 'report_missing', /Required report is missing or not a regular checkout file/],
  ['target', 'head', /Start HEAD changed during preparation/],
  ['issue', 'head', /Start HEAD changed during preparation/],
  ['setup', 'config', /Target configuration differs from start commit/],
  ['setup', 'report', /Required report has uncommitted content/],
  ['setup', 'head', /Start HEAD changed during preparation/],
  ['setup', 'push', /Remote\/repository mismatch/],
  ['checkout_setup', 'config', /Target configuration or GitHub actor changed/],
  ['checkout_setup', 'report_index', /Required start inputs have uncommitted changes/],
  ['checkout_setup', 'report_mode', /Required start inputs have uncommitted changes/],
] as const) {
  testStartInput(`development rejects changed start input: ${phase} ${change}`, async (fixture) => {
    const { repo, dir, base, args, hooks, io } = fixture;
    await writeFile(join(repo, 'unrelated.txt'), 'Preserve other work');
    if (phase === 'initial') {
      await startChanges[change](repo);
    }
    hooks.changeDuring = async (event, cwd) => {
      if (phase === event) {
        await startChanges[change](repo);
      }
      if (phase === 'checkout_setup' && event === 'setup') {
        await startChanges[change](cwd);
      }
    };
    args.push('--start-commit', base);
    await assert.rejects(() => develop(args, io), reason);
    expect(hooks.setups).toBe(phase.endsWith('setup') ? 1 : 0);
    expect(existsSync(join(dir, 'checkout'))).toBe(phase.endsWith('setup'));
    expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('Preserve other work');
  });
}

function ciStatus(mode: string) {
  if (mode === 'ci_publication_invalid_json') {
    return 'invalid_response';
  }
  return mode === 'ci_failure'
    ? 'failed'
    : mode.endsWith('target_changed')
      ? 'target_changed'
      : 'unavailable';
}
function ciAction(mode: string) {
  if (mode === 'ci_publication_invalid_json') {
    return 'raw PR/CI response';
  }
  return mode === 'ci_failure'
    ? 'Inspect failing'
    : mode.endsWith('target_changed')
      ? 'Reconcile'
      : 'Check gh';
}

for (const [change, expected] of [
  ['content', /Required report has uncommitted content/],
  ['index', /Required start inputs have uncommitted changes/],
  ['setup', /Required report has uncommitted content/],
  ['blob', /Required report differs from reviewed version/],
  ['missing', /Required report is missing from start commit/],
] as const) {
  testStartInput(`selected knowledge is a required start input: ${change}`, async (fixture) => {
    const { repo, args, hooks, io, dir } = fixture;
    const path = 'model.json';
    const content = await readFile(
      new URL('../../docs/knowledge/implementation-start.json', import.meta.url),
      'utf8',
    );
    await writeFile(join(repo, path), content);
    await git(repo, 'add', path);
    await git(repo, 'commit', '-m', 'knowledge');
    const base = await git(repo, 'rev-parse', 'HEAD');
    const blob = await git(repo, 'rev-parse', `HEAD:${path}`);
    hooks.issue = JSON.stringify({
      title: 'Selected knowledge',
      state: 'OPEN',
      body:
        '```dotagents-knowledge\n' +
        JSON.stringify([
          {
            path: change === 'missing' ? 'absent.json' : path,
            blob: change === 'blob' ? 'a'.repeat(40) : blob,
            ids: ['start-identity'],
          },
        ]) +
        '\n```',
    });
    if (change === 'content' || change === 'index') {
      await writeFile(join(repo, path), content + '\n');
      if (change === 'index') {
        await git(repo, 'add', path);
        await writeFile(join(repo, path), content);
      }
    }
    if (change === 'setup') {
      hooks.changeDuring = async (event, cwd) => {
        if (event === 'setup') {
          await writeFile(join(cwd, path), content + '\n');
        }
      };
    }
    args.push('--start-commit', base);
    await assert.rejects(() => develop(args, io), expected);
    expect(hooks.setups).toBe(change === 'setup' ? 1 : 0);
    expect(existsSync(join(dir, 'implementation.prompt'))).toBe(false);
  });
}

for (const location of ['checkout', 'git', 'symlink'] as const) {
  testStartInput(
    `development does not save into unsafe ${location} storage`,
    async ({ repo, args, base, hooks, io }) => {
      const dir = join(repo, location === 'git' ? '.git/unsafe-run' : 'unsafe-run');
      if (location === 'git') {
        // With a linked checkout, common Git storage lies outside the checkout guard.
        const checkout = join(repo, '..', 'linked-checkout');
        await git(repo, 'worktree', 'add', '-b', 'fixture-linked', checkout, base);
        args[args.indexOf('--repo') + 1] = checkout;
      }
      let requested = dir;
      if (location === 'symlink') {
        const link = join(repo, '..', 'repository-link');
        await symlink(repo, link);
        requested = join(link, 'unsafe-run');
      }
      const index = args.indexOf('--run-dir');
      args[index + 1] = requested;
      args.push('--start-commit', base);
      await assert.rejects(
        () => develop(args, io),
        /Run directory.*result not saved: no safe new run directory/,
      );
      expect(hooks.setups).toBe(0);
      expect(existsSync(join(dir, 'result.json'))).toBe(false);
      expect(existsSync(join(dir, 'issue.json'))).toBe(false);
      expect(existsSync(join(dir, 'checkout'))).toBe(false);
    },
  );
}
