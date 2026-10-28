import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { expect, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { command, interruptionMessage } from '../../../shared/process.ts';

import { ok, testDevelopment } from '../../support/development.ts';

import {
  savedResult,
  runDevelopment,
  noPublication,
  stopped,
  publishedEvidence,
  failSetup,
  initialStop,
  interruptWrite,
  interruptRename,
  interruptedRecord,
  retainedPublication,
  publicationFields,
  publicationReadStop,
} from '../../support/development-observations.ts';
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
  expect(f.calls.verificationEntries).toBe(0);
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
  expect(f.calls.verificationEntries).toBe(0);
  noPublication(f);
});

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
  expect(f.calls.verificationEntries).toBe(1);
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
  expect(f.calls.verificationEntries).toBe(0);
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
  expect(f.calls.verificationEntries).toBe(1);
  noPublication(f);
});

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
    expect(f.calls.verificationEntries).toBe(0);
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
