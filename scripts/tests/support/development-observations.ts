import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { expect, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { develop } from '../../implement/orchestrator.ts';

import { command, interruptionMessage, withInterrupts } from '../../shared/process.ts';
import type { State } from '../../implement/input.ts';
import { isRecord } from '../../shared/values.ts';

import { gitOutput } from './development.ts';
import type { DevelopmentFixture } from './development.ts';

export const reportPath = 'docs/research/result-behavior.md';
export const reportContent = 'Reviewed finding: keep the result visible until reset.\n';
export const secondReport = 'docs/wiki/result-validation.md';

export async function commitReport(repo: string) {
  await mkdir(join(repo, 'docs/research'), { recursive: true });
  await mkdir(join(repo, 'docs/wiki'), { recursive: true });
  await writeFile(join(repo, reportPath), reportContent);
  await writeFile(join(repo, secondReport), 'Existing result tests cover reset and empty input.\n');
  await gitOutput(repo, 'add', '--', reportPath, secondReport);
  await gitOutput(repo, 'commit', '-m', 'required research');
  return gitOutput(repo, 'rev-parse', `HEAD:${reportPath}`);
}
export async function savedResult(dir: string) {
  const saved: unknown = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  assert(isRecord(saved));
  return saved;
}

async function pendingWork(repo: string) {
  if (!existsSync(join(repo, 'notes.txt'))) {
    return undefined;
  }
  return {
    status: await gitOutput(repo, 'status', '--porcelain'),
    staged: await gitOutput(repo, 'diff', '--cached', '--binary'),
    working: await gitOutput(repo, 'diff', '--binary'),
    notes: await readFile(join(repo, 'notes.txt'), 'utf8'),
    notesMode: (await stat(join(repo, 'notes.txt'))).mode,
    untracked: await readFile(join(repo, 'unrelated.txt'), 'utf8'),
    untrackedMode: (await stat(join(repo, 'unrelated.txt'))).mode,
  };
}

// Only fixed observations are shared. Each test supplies its own mutation and stop reason.
export async function runDevelopment(f: DevelopmentFixture) {
  const original = await gitOutput(f.repo, 'rev-parse', 'HEAD');
  const pending = await pendingWork(f.repo);
  try {
    return await withInterrupts(() => develop(f.args, f.io));
  } finally {
    await withInterrupts(async () => {});
    expect(await gitOutput(f.repo, 'rev-parse', 'HEAD')).toBe(original);
    expect(await readFile(join(f.repo, 'result.txt'), 'utf8')).toBe('old');
    if (pending) {
      expect(await pendingWork(f.repo)).toEqual(pending);
    }
  }
}

export function noPublication(f: DevelopmentFixture) {
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
  expect(f.calls.attachments).toBe(0);
  expect(f.prReads).toEqual([]);
}

export async function stopped(f: DevelopmentFixture, reason: RegExp) {
  await assert.rejects(() => runDevelopment(f), reason);
  const saved = await savedResult(f.dir);
  expect([saved.reasonCode, saved.reason].join(': ')).toMatch(reason);
  expect(saved.status).toBe('stopped');
  expect(saved.nextAction).toBeTruthy();
  expect(saved.evidence).toBe(f.dir);
  expect(saved.issue).toContain('/issues/99');
  expect(saved.startCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(saved.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(saved.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(await readFile(join(f.dir, 'report.html'), 'utf8')).toContain('停止');
  expect(saved.remaining).toContain('human_review');
  return saved;
}

export async function rejectedBeforeStart(f: DevelopmentFixture, reason: RegExp) {
  await assert.rejects(() => runDevelopment(f), reason);
  expect(f.calls.implementations).toBe(0);
  expect(f.calls.verificationEntries).toBe(0);
  noPublication(f);
  expect(existsSync(f.dir)).toBe(false);
}

export async function verificationEvidence(f: DevelopmentFixture, result: State['result']) {
  const statePath = join(f.dir, 'verification/state.json');
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
    findings: f.summary,
    reviewHistory: f.history,
    result,
  });
  expect(await readFile(join(f.dir, 'verification/review-2.stdout'), 'utf8')).toBe(f.rawReview);
  return statePath;
}

export async function verifiedLocal(f: DevelopmentFixture) {
  const result = await runDevelopment(f);
  expect(await savedResult(f.dir)).toEqual(result);
  expect(result.evidence).toBe(f.dir);
  expect(result.status).toBe('verified_local');
  expect(await readFile(join(f.dir, 'report.html'), 'utf8')).toContain('ローカル検証済み');
  expect(result.remaining).toContain('publication');
  expect(result.remaining).toContain('human_review');
  expect(existsSync(join(f.dir, 'pr.md'))).toBe(false);
  noPublication(f);
  const statePath = await verificationEvidence(f, 'ready_for_human_review');
  expect(result.details).toBe(statePath);
  return result;
}

export async function publishedEvidence(f: DevelopmentFixture, saved: Record<string, unknown>) {
  expect(f.calls.pushes).toBe(1);
  expect(f.calls.publications).toBe(1);
  expect(saved.commit).toBe(await gitOutput(join(f.dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.branch).toBe('codex/development-99');
  expect(saved.nextAction).toContain('GitHub');
}

export async function commitSettings(f: DevelopmentFixture, settings: unknown) {
  await writeFile(join(f.repo, '.dotagents.json'), JSON.stringify(settings));
  await gitOutput(f.repo, 'add', '.dotagents.json');
  await gitOutput(f.repo, 'commit', '-m', 'fixture configuration');
}

export function failSetup(f: DevelopmentFixture) {
  f.localCommand = (argv, cwd, input, timeout, prefix) =>
    command(
      argv[0] === 'sh' ? ['sh', '-c', 'echo setup fixture failure >&2; exit 1'] : argv,
      cwd,
      input,
      timeout,
      prefix,
    );
}

export async function initialStop(f: DevelopmentFixture, reason: RegExp) {
  const saved = await stopped(f, reason);
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.verificationEntries).toBe(0);
  noPublication(f);
  expect(saved.publication).toBe('not_attempted');
  expect(existsSync(join(f.dir, 'verification-config.json'))).toBe(false);
  return saved;
}

export function interruptWrite(dir: string) {
  const writeFile = fs.writeFile;
  let notified = false;
  return spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (args[0] === join(dir, 'result.json.tmp') && !notified) {
      notified = true;
      process.emit('SIGINT');
    }
    await writeFile(...args);
  });
}

export function interruptRename(dir: string) {
  const rename = fs.rename;
  let notified = false;
  return spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await rename(...args);
    if (args[1] === join(dir, 'result.json') && !notified) {
      notified = true;
      process.emit('SIGTERM');
    }
  });
}

export async function interruptedRecord(f: DevelopmentFixture) {
  const saved = await savedResult(f.dir);
  expect(saved.status).toBe('stopped');
  expect(saved.reason).toContain(interruptionMessage);
  expect(saved.nextAction).toContain('Reconcile');
  return saved;
}

export async function retainedPublication(f: DevelopmentFixture, saved: Record<string, unknown>) {
  expect(saved.publication).toBe('published');
  expect(saved.url).toBe(await readFile(join(f.dir, 'pr-url.txt'), 'utf8'));
  expect(saved.commit).toBe(await gitOutput(join(f.dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.ci).toBe('passed');
  expect(saved.ciDetails).toMatchObject({ status: 'passed' });
  expect(saved.remaining).toEqual(['published_body_check', 'mark_ready', 'human_review']);
  expect(f.calls.pushes).toBe(1);
  expect(f.calls.publications).toBe(1);
  expect(f.calls.attachments).toBe(0);
}

export const publicationFields = 'url,headRefOid,baseRefName,state,isDraft,body,statusCheckRollup';
export const finalFields = 'headRefOid,baseRefName,state,isDraft';

export async function ciStop(f: DevelopmentFixture, status: string, action: string) {
  const saved = await stopped(f, new RegExp(`${status}:`));
  const url = await readFile(join(f.dir, 'pr-url.txt'), 'utf8');
  expect(url).toContain('/pull/100');
  const body = await readFile(join(f.dir, 'pr.md'), 'utf8');
  expect(body).toContain('draft公開・CI・本文と媒体の確認・ready切替・人の承認は未完了');
  expect(body).not.toMatch(/媒体を添付|rendered_media_check|新規添付対象/);
  expect(saved.url).toBe(url);
  expect(saved).toMatchObject({
    publication: 'published',
    requiredChecks: ['checks'],
    ci: status,
    remaining: ['ci', 'published_body_check', 'mark_ready', 'human_review'],
  });
  expect(saved.commit).toBe(await gitOutput(join(f.dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.nextAction).toContain(action);
  expect(f.calls.pushes).toBe(1);
  expect(f.calls.publications).toBe(1);
  expect(f.calls.attachments).toBe(0);
  assert(isRecord(saved.ciDetails));
  return { saved, details: saved.ciDetails };
}

export async function publicationReadStop(
  f: DevelopmentFixture,
  status: string,
  action: string,
  reason: string,
) {
  const { details } = await ciStop(f, status, action);
  const log = join(f.dir, 'pr-publication');
  expect(f.prReads).toEqual([publicationFields]);
  expect(details.logs).toEqual([log]);
  expect(details.lastObservation).toBeNull();
  expect(details.timedOut).toBe(false); // The CI wait budget has not started.
  expect(details.reason).toContain(reason);
  expect(existsSync(join(f.dir, 'ci-registration-1.stdout'))).toBe(false);
  expect(existsSync(join(f.dir, 'ci-final-target.stdout'))).toBe(false);
  expect(await readFile(join(f.dir, 'pr.json'), 'utf8')).toBe(
    await readFile(`${log}.stdout`, 'utf8'),
  );
}
