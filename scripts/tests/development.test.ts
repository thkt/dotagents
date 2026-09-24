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
import { run } from '../correction.ts';
import { createHash } from 'node:crypto';
import { reviewReplySource } from './support/correction.ts';
import { PublicationError } from '../publish.ts';
import { command, interruptionMessage, withInterrupts } from '../process.ts';
import type { Config, State } from '../input.ts';
import { isRecord } from '../values.ts';
import { initializeTarget, githubTarget, targetConfig } from './support/target.ts';

import { git, issue, ok, mediaCapture, testDevelopment } from './support/development.ts';
import type { DevelopmentFixture } from './support/development.ts';

const reportPath = 'docs/research/result-behavior.md';
const reportContent = 'Reviewed finding: keep the result visible until reset.\n';
const secondReport = 'docs/research/result-validation.md';

async function commitReport(repo: string) {
  await mkdir(join(repo, 'docs/research'), { recursive: true });
  await writeFile(join(repo, reportPath), reportContent);
  await writeFile(join(repo, secondReport), 'Existing result tests cover reset and empty input.\n');
  await git(repo, 'add', '--', reportPath, secondReport);
  await git(repo, 'commit', '-m', 'required research');
  return git(repo, 'rev-parse', `HEAD:${reportPath}`);
}
async function savedResult(dir: string) {
  const saved: unknown = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  assert(isRecord(saved));
  return saved;
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

// Only fixed observations are shared. Each test supplies its own mutation and stop reason.
async function runDevelopment(f: DevelopmentFixture) {
  const original = await git(f.repo, 'rev-parse', 'HEAD');
  const pending = await pendingWork(f.repo);
  try {
    return await withInterrupts(() => develop(f.args, f.io));
  } finally {
    await withInterrupts(async () => {});
    expect(await git(f.repo, 'rev-parse', 'HEAD')).toBe(original);
    expect(await readFile(join(f.repo, 'result.txt'), 'utf8')).toBe('old');
    if (pending) {
      expect(await pendingWork(f.repo)).toEqual(pending);
    }
  }
}

function noPublication(f: DevelopmentFixture) {
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
  expect(f.calls.attachments).toBe(0);
  expect(f.prReads).toEqual([]);
}

async function stopped(f: DevelopmentFixture, reason: RegExp) {
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

async function rejectedBeforeStart(f: DevelopmentFixture, reason: RegExp) {
  await assert.rejects(() => runDevelopment(f), reason);
  expect(f.calls.implementations).toBe(0);
  expect(f.calls.reviews).toBe(0);
  noPublication(f);
  expect(existsSync(f.dir)).toBe(false);
}

async function verificationEvidence(f: DevelopmentFixture, result: State['result']) {
  const statePath = join(f.dir, 'verification/state.json');
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
    findings: f.summary,
    reviewHistory: f.history,
    result,
  });
  expect(await readFile(join(f.dir, 'verification/review-2.stdout'), 'utf8')).toBe(f.rawReview);
  return statePath;
}

async function verifiedLocal(f: DevelopmentFixture) {
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

async function publishedEvidence(f: DevelopmentFixture, saved: Record<string, unknown>) {
  expect(f.calls.pushes).toBe(1);
  expect(f.calls.publications).toBe(1);
  expect(saved.commit).toBe(await git(join(f.dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.branch).toBe('codex/development-99');
  expect(saved.nextAction).toContain('GitHub');
}

async function commitSettings(f: DevelopmentFixture, settings: unknown) {
  await writeFile(join(f.repo, '.dotagents.json'), JSON.stringify(settings));
  await git(f.repo, 'add', '.dotagents.json');
  await git(f.repo, 'commit', '-m', 'fixture configuration');
}

function failSetup(f: DevelopmentFixture) {
  f.localCommand = (argv, cwd, input, timeout, prefix) =>
    command(
      argv[0] === 'sh' ? ['sh', '-c', 'echo setup fixture failure >&2; exit 1'] : argv,
      cwd,
      input,
      timeout,
      prefix,
    );
}

testDevelopment('worktree_failure', async (f) => {
  f.localCommand = (argv, ...rest) =>
    argv[1] === 'worktree'
      ? Promise.resolve({ ...ok(), code: 1, stderr: 'worktree fixture failure' })
      : command(argv, ...rest);
  const saved = await stopped(f, /worktree fixture failure/);
  expect(saved).toMatchObject({
    phase: 'preparation',
    operation: 'prepare worktree',
    publication: 'not_attempted',
  });
  expect(f.calls.implementations).toBe(0);
  expect(f.calls.reviews).toBe(0);
  noPublication(f);
});

testDevelopment('setup_failure', async (f) => {
  failSetup(f);
  const saved = await stopped(f, /setup fixture failure/);
  expect(saved).toMatchObject({
    phase: 'implementation',
    operation: 'setup-1',
    publication: 'not_attempted',
  });
  expect(f.calls.implementations).toBe(0);
  expect(f.calls.reviews).toBe(0);
  noPublication(f);
});

testDevelopment('missing_check', async (f) => {
  await commitSettings(f, { ...f.settings, check: [] });
  await rejectedBeforeStart(f, /Verification command is required/);
});

testDevelopment(
  'no_ci',
  async (f) => {
    await rejectedBeforeStart(f, /Publishing requires expected CI checks/);
  },
  { ciChecks: [] },
);

testDevelopment(
  'local_no_ci',
  async (f) => {
    f.args.push('--no-publish');
    const result = await verifiedLocal(f);
    expect(result.remaining).not.toContain('ci');
  },
  { ciChecks: [] },
);

testDevelopment('report failure preserves a verified local result', async (f) => {
  f.args.push('--no-publish');
  const verify = f.verify;
  f.verify = async (config) => {
    const state = await verify(config);
    await writeFile(join(f.dir, 'report.html'), 'existing report');
    return state;
  };
  await assert.rejects(
    () => runDevelopment(f),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('Run verified_local') &&
      error.message.includes('report generation failed') &&
      error.message.includes(`'${f.dir}'`) &&
      error.message.includes("run-report.ts'") &&
      error.message.includes("report-new.html'"),
  );
  expect((await savedResult(f.dir)).status).toBe('verified_local');
  expect(await readFile(join(f.dir, 'report.html'), 'utf8')).toBe('existing report');
  expect(f.calls.reviews).toBe(1);
  noPublication(f);
});

testDevelopment('report failure preserves an earlier stop', async (f) => {
  const local = f.localCommand;
  f.localCommand = async (argv, cwd, input, timeout, prefix) => {
    if (argv[0] === 'sh') {
      await writeFile(join(f.dir, 'report.html'), 'existing report');
      return { ...ok(), code: 1, stderr: 'setup failed' };
    }
    return local(argv, cwd, input, timeout, prefix);
  };
  await assert.rejects(
    () => runDevelopment(f),
    /Run stopped:.*setup failed.*report generation failed/,
  );
  const saved = await savedResult(f.dir);
  expect(saved).toMatchObject({ status: 'stopped', phase: 'implementation', operation: 'setup-1' });
  expect(saved.reason).toContain('setup failed');
  expect(await readFile(join(f.dir, 'report.html'), 'utf8')).toBe('existing report');
  expect(f.calls.implementations).toBe(0);
  noPublication(f);
});

for (const [name, replacement, reason] of [
  ['wrong_repo', ['team/component', 'other/repo'], /GitHub repository mismatch/],
  ['denied_start', ['"push":true', '"push":false'], /GitHub push permission required/],
] as const) {
  testDevelopment(name, async (f) => {
    const github = f.github;
    f.github = async (...args) => {
      const response = await github(...args);
      return { ...response, stdout: response.stdout.replace(replacement[0], replacement[1]) };
    };
    await rejectedBeforeStart(f, reason);
  });
}

testDevelopment('local_denied', async (f) => {
  f.args.push('--no-publish');
  const github = f.github;
  f.github = async (...args) => {
    const response = await github(...args);
    return { ...response, stdout: response.stdout.replace('"push":true', '"push":false') };
  };
  expect((await verifiedLocal(f)).remaining).toContain('ci');
});

testDevelopment('wrong_issue', async (f) => {
  f.args[0] = 'https://github.com/other/repo/issues/99';
  await rejectedBeforeStart(f, /Issue does not match target repository/);
});

testDevelopment('wrong_push', async (f) => {
  await git(
    f.repo,
    'remote',
    'set-url',
    '--push',
    f.settings.remote,
    'git@github.com:other/repo.git',
  );
  await rejectedBeforeStart(f, /Remote\/repository mismatch/);
});

for (const [name, args, replacement, reason] of [
  ['permission_lost', [], ['"push":true', '"push":false'], /GitHub push permission required/],
  [
    'actor_changed',
    [],
    ['operator', 'different-operator'],
    /Target configuration or GitHub actor changed/,
  ],
  [
    'local_actor_changed',
    ['--no-publish'],
    ['operator', 'different-operator'],
    /Target configuration or GitHub actor changed/,
  ],
] as const) {
  testDevelopment(name, async (f) => {
    f.args.push(...args);
    const github = f.github;
    f.github = async (...args) => {
      const response = await github(...args);
      return f.calls.reviews > 0
        ? { ...response, stdout: response.stdout.replace(replacement[0], replacement[1]) }
        : response;
    };
    await stopped(f, reason);
    expect(f.calls.reviews).toBe(1);
    noPublication(f);
  });
}

for (const [name, change, reason] of [
  [
    'config_changed',
    async (config: Config, f: DevelopmentFixture) => {
      await writeFile(join(config.cwd, '.dotagents.json'), JSON.stringify(f.settings) + '\n');
    },
    /Target configuration or GitHub actor changed/,
  ],
  [
    'branch_changed',
    async (config: Config) => {
      await git(config.cwd, 'switch', '-c', 'unexpected');
    },
    /Actor changed branch or HEAD/,
  ],
  [
    'head_changed',
    async (config: Config) => {
      await git(config.cwd, 'add', '.');
      await git(config.cwd, 'commit', '-m', 'unexpected actor commit');
    },
    /Actor changed branch or HEAD/,
  ],
] as const) {
  testDevelopment(name, async (f) => {
    const verify = f.verify;
    f.verify = async (config) => {
      await change(config, f);
      return verify(config);
    };
    await stopped(f, reason);
    expect(f.calls.reviews).toBe(1);
    noPublication(f);
  });
}

testDevelopment('requirements_changed', async (f) => {
  const github = f.github;
  f.github = async (argv, ...rest) =>
    argv[1] === 'issue' && f.calls.implementations > 0
      ? ok(issue.replace('visible', 'different'))
      : github(argv, ...rest);
  await stopped(f, /Requirements changed during implementation/);
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.reviews).toBe(0);
  noPublication(f);
});

async function initialStop(f: DevelopmentFixture, reason: RegExp) {
  const saved = await stopped(f, reason);
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.reviews).toBe(0);
  noPublication(f);
  expect(saved.publication).toBe('not_attempted');
  expect(existsSync(join(f.dir, 'verification-config.json'))).toBe(false);
  return saved;
}

for (const [name, response, reason] of [
  ['initial_failure', { code: 1 }, /Initial implementation process failed/],
  ['initial_timeout', { timedOut: true }, /Initial implementation timed out/],
] as const) {
  testDevelopment(name, async (f) => {
    const implement = f.implement;
    f.implement = async (...args) => ({ ...(await implement(...args)), ...response });
    await initialStop(f, reason);
    expect(await readFile(join(f.dir, 'implementation.stderr'), 'utf8')).toContain(
      'Actor diagnostic',
    );
    expect(existsSync(join(f.dir, 'implementation.json'))).toBe(true);
  });
}

testDevelopment('initial_startup_failure', async (f) => {
  f.implement = (_argv, ...rest) => command(['/nonexistent-implementation-test-command'], ...rest);
  await initialStop(f, /Initial implementation process failed \(null\)/);
  expect(await readFile(join(f.dir, 'implementation.stderr'), 'utf8')).toContain('ENOENT');
  expect(existsSync(join(f.dir, 'implementation.json'))).toBe(true);
});

testDevelopment('initial_interruption', async (f) => {
  f.implement = async (_argv, _cwd, _input, _timeout, prefix) => {
    await writeFile(`${prefix}.stdout`, 'interrupted actor output');
    await writeFile(`${prefix}.stderr`, 'Actor diagnostic');
    throw Error(interruptionMessage);
  };
  await initialStop(f, /Interrupted execution/);
  expect(await readFile(join(f.dir, 'implementation.stderr'), 'utf8')).toContain(
    'Actor diagnostic',
  );
  expect(existsSync(join(f.dir, 'implementation.json'))).toBe(false);
});

for (const [name, reply, reason] of [
  [
    'needs_human',
    { status: 'needs_human', findings: 'Need agreement on scope' },
    /Human decision required: Need agreement on scope/,
  ],
  [
    'invalid_reply',
    { status: 'accepted', findings: 'Unexpected status' },
    /Invalid implementation reply/,
  ],
  [
    'blank_human',
    { status: 'needs_human', findings: ' \t\r\n\u3000' },
    /Invalid implementation reply/,
  ],
] as const) {
  testDevelopment(name, async (f) => {
    const stdout = JSON.stringify(reply);
    f.implement = async (_argv, cwd, _input, _timeout, prefix) => {
      await writeFile(`${prefix}.stdout`, stdout);
      await writeFile(`${prefix}.stderr`, 'Actor diagnostic');
      await writeFile(join(cwd, 'result.txt'), 'implemented');
      return { ...ok(stdout), ms: 500 };
    };
    const saved = await initialStop(f, reason);
    expect(await readFile(join(f.dir, 'implementation.stderr'), 'utf8')).toContain(
      'Actor diagnostic',
    );
    expect(existsSync(join(f.dir, 'implementation.json'))).toBe(true);
    expect(await readFile(join(f.dir, 'checkout/result.txt'), 'utf8')).toBe('implemented');
    expect(await readFile(join(f.dir, 'implementation.stdout'), 'utf8')).toBe(stdout);
    expect(existsSync(join(f.dir, 'implementation-summary.md'))).toBe(name === 'needs_human');
    if (name === 'needs_human') {
      expect(saved.reasonCode).toBe('human_decision_required');
      expect(saved.nextAction).toContain('human decision');
      expect(await readFile(join(f.dir, 'implementation-summary.md'), 'utf8')).toBe(
        'Need agreement on scope',
      );
    }
  });
}

for (const [result, nextAction] of [
  ['review_storage_failed', 'writable evidence storage'],
  ['invalid_review', 'raw review response'],
  ['check_unavailable', 'check startup or timeout'],
  ['capture_unavailable', 'capture logs and configured runtime'],
  ['human_decision_required', 'human decision described in the repair findings'],
  ['execution_limit', 'human must decide any new scope or budget'],
] as const) {
  testDevelopment(result, async (f) => {
    const verify = f.verify;
    f.verify = async (config) => ({ ...(await verify(config)), result });
    const saved = await stopped(f, new RegExp(`Verification stopped: ${result}`));
    expect(saved.reasonCode).toBe(result);
    expect(saved.nextAction).toContain(nextAction);
    expect(saved.nextAction).toContain('Evidence: ' + join(f.dir, 'verification/state.json'));
    expect(saved.nextAction).toContain(
      'reconfirm target, evidence, authorization and verification',
    );
    expect(saved.nextAction).toContain('Do not resume this run');
    expect(saved.publication).toBe('not_attempted');
    expect(saved.remaining).toContain('local_verification');
    expect(f.calls.reviews).toBe(1);
    noPublication(f);
    const statePath = await verificationEvidence(f, result);
    expect(saved.details).toBe(statePath);
  });
}

testDevelopment('review_failure', async (f) => {
  const verify = f.verify;
  f.verify = async (config) => ({ ...(await verify(config)), result: 'review_failed' });
  const saved = await stopped(f, /Verification stopped: review_failed/);
  expect(saved).toMatchObject({ phase: 'verification', reasonCode: 'review_failed' });
  noPublication(f);
  const statePath = await verificationEvidence(f, 'review_failed');
  expect(saved.details).toBe(statePath);
});

testDevelopment('source_changed', async (f) => {
  const verify = f.verify;
  f.verify = async (config) => ({
    ...(await verify(config)),
    result: f.calls.reviews > 1 ? 'target_changed_after_stop' : 'ready_for_human_review',
  });
  const saved = await stopped(f, /Verification stopped: target_changed_after_stop/);
  expect(saved).toMatchObject({ phase: 'verification', reasonCode: 'target_changed_after_stop' });
  expect(f.calls.reviews).toBe(2);
  noPublication(f);
  const statePath = await verificationEvidence(f, 'ready_for_human_review');
  expect(saved.details).toBe(statePath);
});
testDevelopment('save_failure', async (f) => {
  failSetup(f);
  const localCommand = f.localCommand;
  f.localCommand = async (argv, ...rest) => {
    if (argv[0] === 'sh') {
      await mkdir(join(f.dir, 'result.json'));
    }
    return localCommand(argv, ...rest);
  };
  await assert.rejects(() => runDevelopment(f), /setup fixture failure.*result not saved.*EISDIR/s);
  expect((await stat(join(f.dir, 'result.json'))).isDirectory()).toBe(true);
  expect(await readFile(join(f.dir, 'setup-1.stderr'), 'utf8')).toContain('setup fixture failure');
  expect(f.calls.implementations).toBe(0);
  expect(f.calls.reviews).toBe(0);
  noPublication(f);
});

testDevelopment('save_success_failure', async (f) => {
  f.args.push('--no-publish');
  f.localCommand = async (argv, ...rest) => {
    if (argv[0] === 'sh') {
      await writeFile(join(f.dir, 'result.json'), 'previous complete record');
      await writeFile(join(f.dir, 'result.json.tmp'), 'retained temporary evidence');
    }
    return command(argv, ...rest);
  };
  await assert.rejects(
    () => runDevelopment(f),
    /Local check and independent review accepted.*result not saved.*EEXIST/,
  );
  expect(await readFile(join(f.dir, 'result.json'), 'utf8')).toBe('previous complete record');
  expect(await readFile(join(f.dir, 'result.json.tmp'), 'utf8')).toBe(
    'retained temporary evidence',
  );
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.reviews).toBe(1);
  noPublication(f);
});

// Notify the real interrupt scope at deterministic async storage boundaries.
function interruptWrite(dir: string) {
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

function interruptRename(dir: string) {
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

async function interruptedRecord(f: DevelopmentFixture) {
  const saved = await savedResult(f.dir);
  expect(saved.status).toBe('stopped');
  expect(saved.reason).toContain(interruptionMessage);
  expect(saved.nextAction).toContain('Reconcile');
  return saved;
}

async function retainedPublication(f: DevelopmentFixture, saved: Record<string, unknown>) {
  expect(saved.publication).toBe('published');
  expect(saved.url).toBe(await readFile(join(f.dir, 'pr-url.txt'), 'utf8'));
  expect(saved.commit).toBe(await git(join(f.dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.ci).toBe('passed');
  expect(saved.ciDetails).toMatchObject({ status: 'passed' });
  expect(saved.remaining).toEqual(['published_body_check', 'mark_ready', 'human_review']);
  expect(f.calls.pushes).toBe(1);
  expect(f.calls.publications).toBe(1);
  expect(f.calls.attachments).toBe(0);
}

testDevelopment('save_write_interruption', async (f) => {
  f.args.push('--no-publish');
  const write = interruptWrite(f.dir);
  try {
    await assert.rejects(() => runDevelopment(f), /Interrupted execution.*Result:/s);
    const saved = await interruptedRecord(f);
    expect(saved.publication).toBe('not_attempted');
    expect(saved.reasonCode).toBeUndefined();
    expect(saved.remaining).toEqual([
      'publication',
      'ci',
      'published_body_check',
      'mark_ready',
      'human_review',
    ]);
    noPublication(f);
  } finally {
    write.mockRestore();
  }
});

testDevelopment('save_stopped_interruption', async (f) => {
  failSetup(f);
  const write = interruptWrite(f.dir);
  try {
    await assert.rejects(
      () => runDevelopment(f),
      /setup fixture failure.*Interrupted execution.*Result:/s,
    );
    const saved = await interruptedRecord(f);
    expect(saved.reason).toContain('setup fixture failure');
    expect(await readFile(join(f.dir, 'setup-1.stderr'), 'utf8')).toContain(
      'setup fixture failure',
    );
    expect(f.calls.implementations).toBe(0);
    expect(f.calls.reviews).toBe(0);
    noPublication(f);
  } finally {
    write.mockRestore();
  }
});

testDevelopment('save_rename_interruption', async (f) => {
  const rename = interruptRename(f.dir);
  try {
    await assert.rejects(() => runDevelopment(f), /Interrupted execution.*Result:/s);
    await retainedPublication(f, await interruptedRecord(f));
  } finally {
    rename.mockRestore();
  }
});

testDevelopment('save_interruption_failure', async (f) => {
  const rename = interruptRename(f.dir);
  const writeFile = fs.writeFile;
  let written = false;
  const write = spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (args[0] === join(f.dir, 'result.json.tmp')) {
      if (written) {
        throw Error('storage fixture failure');
      }
      written = true;
    }
    await writeFile(...args);
  });
  try {
    await assert.rejects(
      () => runDevelopment(f),
      /Interrupted execution.*result not saved.*storage fixture failure/s,
    );
    const saved = await savedResult(f.dir);
    // A failed replacement retains the previous complete record, not partial JSON.
    expect(saved.status).toBe('published_draft');
    await retainedPublication(f, saved);
  } finally {
    write.mockRestore();
    rename.mockRestore();
  }
});

for (const [name, error, url] of [
  ['publication_unconfirmed', Error('PR author or body could not be confirmed'), undefined],
  [
    'publication_readback_unconfirmed',
    new PublicationError(
      'https://github.com/team/component/pull/100',
      Error('PR author or body could not be confirmed'),
    ),
    'https://github.com/team/component/pull/100',
  ],
] as const) {
  testDevelopment(name, async (f) => {
    const publish = f.publish;
    f.publish = async (input) => {
      await publish(input);
      throw error;
    };
    const saved = await stopped(f, /PR author or body could not be confirmed/);
    await publishedEvidence(f, saved);
    expect(saved).toMatchObject({ publication: 'unconfirmed', phase: 'publication' });
    expect(saved.url).toBe(url);
    expect(saved.ci).toBeUndefined();
    expect(existsSync(join(f.dir, 'pr-url.txt'))).toBe(false);
    expect(f.calls.attachments).toBe(0);
    expect(f.prReads).toEqual([]);
  });
}

testDevelopment('existing_ready_pr', async (f) => {
  const github = f.github;
  f.github = async (argv, ...rest) =>
    argv[2] === `repos/${f.settings.repository}/pulls`
      ? ok(
          JSON.stringify([
            [
              {
                html_url: 'https://github.com/team/component/pull/100',
                head: { ref: 'codex/development-99', repo: { full_name: f.settings.repository } },
              },
            ],
          ]),
        )
      : github(argv, ...rest);
  await stopped(f, /Open PR already uses this branch/);
  noPublication(f);
});

async function attachmentStop(f: DevelopmentFixture, reason: RegExp) {
  const saved = await stopped(f, reason);
  await publishedEvidence(f, saved);
  expect(saved).toMatchObject({ publication: 'published', phase: 'publication' });
  expect(saved.url).toBe(await readFile(join(f.dir, 'pr-url.txt'), 'utf8'));
  expect(saved.url).toContain('/pull/100');
  expect(saved.ci).toBeUndefined();
  expect(saved.remaining).toEqual([
    'ci',
    'published_body_check',
    'mark_ready',
    'human_review',
    'attachments',
    'rendered_media_check',
  ]);
  expect(f.prReads).toEqual([]);
}

testDevelopment(
  'attachment_failure',
  async (f) => {
    const github = f.github;
    f.github = async (argv, ...rest) =>
      argv[1] === 'pr' && argv[2] === 'edit'
        ? { ...ok(), code: 1, stderr: 'attachment fixture failure' }
        : github(argv, ...rest);
    await attachmentStop(f, /attachment fixture failure/);
    expect(f.calls.attachments).toBe(1);
  },
  { capture: mediaCapture },
);

testDevelopment(
  'attachment_actor_changed',
  async (f) => {
    const github = f.github;
    f.github = async (...args) => {
      const response = await github(...args);
      return f.calls.publications > 0
        ? { ...response, stdout: response.stdout.replace('operator', 'different-operator') }
        : response;
    };
    await attachmentStop(f, /Target configuration or GitHub actor changed/);
    expect(f.calls.attachments).toBe(0);
  },
  { capture: mediaCapture },
);

testDevelopment(
  'attachment_draft_changed',
  async (f) => {
    const github = f.github;
    f.github = async (argv, ...rest) => {
      const response = await github(argv, ...rest);
      return argv[2] === `repos/${f.settings.repository}/pulls/100`
        ? { ...response, stdout: response.stdout.replace('"draft":true', '"draft":false') }
        : response;
    };
    await attachmentStop(f, /not confirmed draft/);
    expect(f.calls.attachments).toBe(0);
  },
  { capture: mediaCapture },
);

testDevelopment('ci_interruption', async (f) => {
  const prView = f.prView;
  f.prView = async (...args) => {
    const response = await prView(...args);
    process.emit('SIGINT');
    return response;
  };
  const saved = await stopped(f, /Interrupted execution/);
  await publishedEvidence(f, saved);
  expect(saved).toMatchObject({ publication: 'published', phase: 'ci' });
  expect(saved.url).toBe(await readFile(join(f.dir, 'pr-url.txt'), 'utf8'));
  expect(saved.url).toContain('/pull/100');
  expect(saved.ci).toBeUndefined();
  expect(await readFile(join(f.dir, 'pr-publication.stdout'), 'utf8')).toContain('headRefOid');
  expect(existsSync(join(f.dir, 'ci-final-target.stdout'))).toBe(false);
  expect(f.prReads).toHaveLength(1);
  expect(f.calls.attachments).toBe(0);
});
const publicationFields = 'url,headRefOid,baseRefName,state,isDraft,body,statusCheckRollup';
const finalFields = 'headRefOid,baseRefName,state,isDraft';

async function ciStop(f: DevelopmentFixture, status: string, action: string) {
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
  expect(saved.commit).toBe(await git(join(f.dir, 'checkout'), 'rev-parse', 'HEAD'));
  expect(saved.nextAction).toContain(action);
  expect(f.calls.pushes).toBe(1);
  expect(f.calls.publications).toBe(1);
  expect(f.calls.attachments).toBe(0);
  assert(isRecord(saved.ciDetails));
  return { saved, details: saved.ciDetails };
}

async function publicationReadStop(
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

for (const [name, failure, status, action, reason] of [
  [
    'ci_publication_unavailable',
    { code: 1, stderr: 'API unavailable in fixture' },
    'unavailable',
    'Check gh',
    'exit 1',
  ],
  ['ci_publication_timeout', { timedOut: true }, 'unavailable', 'Check gh', 'timedOut true'],
] as const) {
  testDevelopment(name, async (f) => {
    const prView = f.prView;
    f.prView = async (argv, cwd, timeout) => {
      const response = await prView(argv, cwd, timeout);
      return argv.at(-1) === publicationFields ? { ...response, ...failure } : response;
    };
    await publicationReadStop(f, status, action, reason);
    if ('stderr' in failure) {
      expect(await readFile(join(f.dir, 'pr-publication.stderr'), 'utf8')).toBe(
        'API unavailable in fixture',
      );
    }
  });
}

// CI owns the initial target field matrix; development retains the stop/result connection.
testDevelopment('CI publication rejects changed head', async (f) => {
  const prView = f.prView;
  f.prView = async (argv, cwd, timeout) => {
    const response = await prView(argv, cwd, timeout);
    if (argv.at(-1) !== publicationFields) {
      return response;
    }
    const view: unknown = JSON.parse(response.stdout);
    assert(isRecord(view));
    return { ...response, stdout: JSON.stringify({ ...view, headRefOid: 'another-commit' }) };
  };
  await publicationReadStop(f, 'target_changed', 'Reconcile', 'head=another-commit');
});

testDevelopment('ci_failure', async (f) => {
  const prView = f.prView;
  f.prView = async (argv, ...rest) => {
    const response = await prView(argv, ...rest);
    return argv.at(-1) === publicationFields
      ? { ...response, stdout: response.stdout.replace('SUCCESS', 'FAILURE') }
      : response;
  };
  const { saved, details } = await ciStop(f, 'failed', 'Inspect failing');
  expect(f.prReads).toEqual([publicationFields, finalFields]);
  const published: unknown = JSON.parse(await readFile(join(f.dir, 'pr.json'), 'utf8'));
  assert(isRecord(published));
  expect(published.headRefOid).toBe(saved.commit);
  expect(details.logs).toContain(join(f.dir, 'pr-publication'));
  expect(await readFile(join(f.dir, 'pr-publication.stdout'), 'utf8')).toContain('headRefOid');
});

for (const [name, failure, status, action, output] of [
  [
    'ci_final_unavailable',
    { code: 1, stdout: 'raw API response', stderr: 'API unavailable in fixture' },
    'unavailable',
    'Check gh',
    'raw API response',
  ],
  ['ci_final_target_changed', {}, 'target_changed', 'Reconcile', 'headRefOid'],
] as const) {
  testDevelopment(name, async (f) => {
    const prView = f.prView;
    f.prView = async (argv, cwd, timeout) => {
      if (argv.at(-1) !== finalFields) {
        return prView(argv, cwd, timeout);
      }
      expect(timeout).toBe(660000);
      if ('code' in failure) {
        return { ...ok(), ...failure };
      }
      return ok(
        JSON.stringify({
          headRefOid: 'another-commit',
          baseRefName: f.settings.baseBranch,
          state: 'OPEN',
          isDraft: true,
        }),
      );
    };
    const { saved, details } = await ciStop(f, status, action);
    expect(f.prReads).toEqual([publicationFields, finalFields]);
    const published: unknown = JSON.parse(await readFile(join(f.dir, 'pr.json'), 'utf8'));
    assert(isRecord(published));
    expect(published.headRefOid).toBe(saved.commit);
    const log = join(f.dir, 'ci-final-target');
    expect(details.logs).toContain(log);
    expect(details.lastObservation).toMatchObject({ status: 'passed' });
    expect(await readFile(`${log}.stdout`, 'utf8')).toContain(output);
    if ('stderr' in failure) {
      expect(await readFile(`${log}.stderr`, 'utf8')).toBe('API unavailable in fixture');
    }
  });
}

testDevelopment(
  'success',
  async (f) => {
    const { dir, history, args, io, prReads } = f;
    const internal = JSON.stringify(history);
    const implement = f.implement;
    f.implement = async (...args) => {
      const input = args[2];
      expect(input).toContain(JSON.stringify(f.settings));
      expect(input).toContain(issue);

      return { ...(await implement(...args)), ms: 1200001 };
    };
    const verify = f.verify;
    f.verify = async (config) => {
      expect(config.capture?.length).toBeGreaterThan(0);
      return verify(config);
    };
    const prView = f.prView;
    f.prView = async (...args) => {
      const response = await prView(...args);
      // CI must use the observation after attachment, not stale pre-attachment checks.
      return f.calls.attachments === 0
        ? { ...response, stdout: response.stdout.replace('SUCCESS', 'FAILURE') }
        : response;
    };
    const result = await runDevelopment(f);
    assert(result.ciDetails);
    const beforeCollision = await readFile(join(dir, 'result.json'), 'utf8');
    expect(JSON.parse(beforeCollision)).toEqual(result);
    expect(result.evidence).toBe(dir);
    expect(result.ci).toBe('passed');
    expect(prReads).toEqual([
      'url,headRefOid,baseRefName,state,isDraft,body,statusCheckRollup',
      'headRefOid,baseRefName,state,isDraft',
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
    expect(JSON.parse(await readFile(join(dir, 'verification-config.json'), 'utf8'))).toMatchObject(
      {
        modelTimeMs: null,
        repairLimit: null,
        reviewLimit: null,
        checkTimeMs: 540000,
      },
    );
    expect(result.url).toContain('/pull/100');
    expect(f.calls.publications).toBe(1);
    const body = await readFile(join(dir, 'pr.md'), 'utf8');
    expect(body).toContain('Keep the requested result visible until reset');
    expect(body).toContain('詳細は（内部パス省略）を確認済みだが実サービスのタイミングは未確認。');
    expect(body).toContain('The /home/settings route now preserves the selected filters');
    expect(body).toContain('https://example.com/results');
    expect(body).toContain('Issue #99 requires a visible result');
    expect(body).toContain('Reset and empty-input checks passed');
    expect(body).toContain('Reset now clears the result, confirmed by the reset check');
    expect(body).not.toContain('Reset left stale content.');
    expect(body).not.toContain('Readers could see an obsolete result.');
    expect(body).toContain('Live service timing is unmeasured');
    expect(body).toContain('Timing may differ in production.');
    expect(body).toContain('Report live service timing as unverified');
    expect(body).toContain('focus movement remains an unagreed proposal');
    expect(body).toContain(`/blob/${result.commit}/.dotagents.json`);
    expect(body).toContain('its success does not establish live service behavior');
    expect(body).toContain('対象commit: ' + result.commit);
    expect(body).toContain('Closes #99');
    expect(body).toContain(
      'https://github.com/thkt/dotagents/blob/main/scripts/README.md#公開後確認とreadyへの切替',
    );
    [
      'CLI: PRをdraftで公開し、同じheadのCI（checks）',
      'CLI: 対象commitの媒体を添付する（review/media/view.png）',
      '担当AI: 添付後の実際のPR画面',
      '担当AI: 最新の公開本文をIssue・対象commit・accepted評価・検証結果と照合',
      '人: 要求や権限の変更を判断',
      'draft公開・CI・本文と媒体の確認・ready切替・人の承認は未完了',
      '担当AI: 実サービスAの応答が遅い場合、結果の保持時間を計測する。現時点では未計測（（内部パス省略））。',
      '運用担当: 実サービスBの応答が遅い場合、結果の保持時間を計測する。現時点では未計測。',
    ].forEach((task) => {
      expect(body.split(task)).toHaveLength(2);
    });
    expect(result.remaining).toEqual([
      'published_body_check',
      'mark_ready',
      'human_review',
      'rendered_media_check',
    ]);
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
    await assert.rejects(() => develop(args, io), /EEXIST.*no safe new run directory/);
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe(beforeCollision);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.publications).toBe(1);

    await verificationEvidence(f, 'ready_for_human_review');
  },
  { capture: mediaCapture },
);

testDevelopment('other_repo', async (f) => {
  const { repo, settings } = f;
  await writeFile(join(repo, 'notes.txt'), 'committed notes');
  await git(repo, 'add', '--', 'notes.txt');
  await commitReport(repo);
  await writeFile(join(repo, 'notes.txt'), 'staged notes');
  await git(repo, 'add', '--', 'notes.txt');
  await writeFile(join(repo, 'notes.txt'), 'working notes');
  await chmod(join(repo, 'notes.txt'), 0o755);
  await writeFile(join(repo, 'unrelated.txt'), 'retain');
  await chmod(join(repo, 'unrelated.txt'), 0o751);

  const original = await git(repo, 'rev-parse', 'HEAD');
  f.args.push(
    '--no-publish',
    '--start-commit',
    original,
    '--report',
    `${reportPath}=${await git(repo, 'rev-parse', `HEAD:${reportPath}`)}`,
    '--report',
    `${secondReport}=${await git(repo, 'rev-parse', `HEAD:${secondReport}`)}`,
  );
  const implement = f.implement;
  f.implement = async (argv, cwd, input, timeout, prefix) => {
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(original);
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('committed notes');
    expect((await stat(join(cwd, 'notes.txt'))).mode & 0o111).toBe(0);
    expect(existsSync(join(cwd, 'unrelated.txt'))).toBe(false);
    expect(await readFile(join(cwd, '.dotagents.json'), 'utf8')).toBe(JSON.stringify(settings));
    expect(input).toContain(JSON.stringify(settings));
    expect(await readFile(join(cwd, 'setup.txt'), 'utf8')).toBe('configured');
    expect(await readFile(join(cwd, reportPath), 'utf8')).toBe(reportContent);
    expect(await readFile(join(cwd, secondReport), 'utf8')).toBe(
      'Existing result tests cover reset and empty input.\n',
    );
    expect(input).toContain(reportPath);
    expect(input).toContain(secondReport);
    expect(input).toContain(original);
    expect(input).not.toContain(reportContent.trim());

    return implement(argv, cwd, input, timeout, prefix);
  };
  const verify = f.verify;
  f.verify = async (config) => {
    expect(config.baseCommit).toBe(original);
    expect(config.reports).toEqual([
      { path: reportPath, blob: await git(repo, 'rev-parse', `HEAD:${reportPath}`) },
      { path: secondReport, blob: await git(repo, 'rev-parse', `HEAD:${secondReport}`) },
    ]);
    expect(config.check).toEqual(settings.check);
    expect(config.capture).toBeUndefined();
    expect((await command(config.check, config.cwd, '', 10000)).code).toBe(0);

    return verify(config);
  };
  expect((await verifiedLocal(f)).remaining).toContain('ci');
});

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
  missing: /Required report is missing from start commit.*docs\/research\/result-behavior.md/,
  uncommitted: /Required report is missing from start commit.*docs\/research\/result-behavior.md/,
  modified: /Required report has uncommitted content.*docs\/research\/result-behavior.md/,
  different_blob:
    /Required report differs from reviewed version.*docs\/research\/result-behavior.md/,
  different_start: /Start commit differs from handoff/,
  no_start: /Required reports need --start-commit/,
  setup_modified: /Required report has uncommitted content.*docs\/research\/result-behavior.md/,
};

for (const [mode, reason] of Object.entries(handoffFailures)) {
  testStartInput(`development stops incomplete research handoff: ${mode}`, async (fixture) => {
    const { repo, dir, beforeReport, base, args, hooks, io } = fixture;
    if (mode === 'missing' || mode === 'uncommitted') {
      await git(repo, 'reset', '--hard', beforeReport);
      if (mode === 'uncommitted') {
        await mkdir(join(repo, 'docs/research'), { recursive: true });
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

for (const suffix of ['', '\n']) {
  testDevelopment(
    `Issue acquisition and verification share saved JSON: suffix=${JSON.stringify(suffix)}`,
    async (f) => {
      const text = JSON.stringify({
        title: '日本語',
        body: '  Show the requested result. 本文\n\n末尾 \n',
        state: 'OPEN',
        updatedAt: '1',
      });
      const raw = text + suffix;
      const github = f.github;
      f.github = async (argv, ...rest) => (argv[1] === 'issue' ? ok(raw) : github(argv, ...rest));
      f.args.push('--no-publish');
      f.verify = (config) =>
        run({
          ...config,
          issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(raw)})`],
          review: [
            process.execPath,
            '-e',
            `const {readFileSync}=require('node:fs'); const role='review'; ${reviewReplySource} console.log(JSON.stringify(reviewReply('accepted','Verified')));`,
          ],
        });
      const result = await runDevelopment(f);
      expect(result.status).toBe('verified_local');
      const saved = await readFile(join(f.dir, 'issue.json'), 'utf8');
      expect(saved).toBe(text);
      expect(await readFile(join(f.dir, 'issue.stdout'), 'utf8')).toBe(raw);
      const state: unknown = JSON.parse(
        await readFile(join(f.dir, 'verification/state.json'), 'utf8'),
      );
      assert(isRecord(state));
      expect(state.issueHash).toBe(createHash('sha256').update(saved).digest('hex'));
      noPublication(f);
    },
  );
}
