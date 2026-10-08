import assert from 'node:assert/strict';
import { test, expect, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertState } from '../../implement/input.ts';
import { run, snapshot } from '../../implement/correction.ts';
import { reconcileExecutions } from '../../implement/revision.ts';
import { withInterrupts, interruptionMessage, OutputStorageError } from '../../shared/process.ts';
import { correctionFixture } from '../support/correction.ts';

const { trial, cleanup } = correctionFixture();
const recordRoots: string[] = [];
afterEach(async () => {
  try {
    await cleanup();
    await Promise.all(
      recordRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  } finally {
    // 保存失敗でも残る中断状態を、次のケースのfixtureへ持ち越さない。
    await withInterrupts(async () => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  for (const boundary of ['active', 'completed', 'terminal', 'release-failure'] as const) {
    test(`${signal} at ${boundary} verification preserves interruption and reservation`, async () => {
      const t = await trial('normal');
      await fs.writeFile(join(t.config.cwd, 'source.txt'), 'correct');
      await fs.mkdir(t.config.runDir);
      const path = join(t.config.runDir, 'state.json');
      const rename = fs.rename;
      const rmdir = syncFs.rmdirSync;
      let injected = false;
      const unlock = spyOn(syncFs, 'rmdirSync').mockImplementation((...args) => {
        if (boundary === 'release-failure' && args[0] === join(t.config.runDir, 'lock')) {
          injected = true;
          process.emit(signal);
          throw Error('injected lock release failure');
        }
        rmdir(...args);
      });
      const hook = spyOn(fs, 'rename').mockImplementation(async (...args) => {
        await rename(...args);
        if (args[1] !== path || injected) {
          return;
        }
        const saved: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
        assertState(saved);
        if (
          saved.checks === 1 &&
          (boundary === 'active'
            ? saved.active?.role === 'check'
            : boundary === 'terminal'
              ? saved.result === 'ready_for_human_review'
              : boundary === 'completed' && saved.events.length === 1 && saved.active === null)
        ) {
          injected = true;
          process.emit(signal);
        }
      });
      try {
        await assert.rejects(
          () => withInterrupts(() => run(t.config)),
          new RegExp(
            boundary === 'release-failure' ? 'injected lock release failure' : interruptionMessage,
          ),
        );
      } finally {
        hook.mockRestore();
        unlock.mockRestore();
      }
      expect(injected).toBe(true);
      const saved = await t.state();
      expect(saved.result).toBe('interrupted');
      const reviewed = boundary === 'terminal' || boundary === 'release-failure';
      expect(saved.review).toBe(reviewed ? 1 : 0);
      expect(saved.repair).toBe(0);
      expect(saved.active === null).toBe(boundary !== 'active');
      expect(saved.events).toHaveLength(reviewed ? 2 : boundary === 'completed' ? 1 : 0);
      expect(await Bun.file(join(t.config.runDir, 'review-1.prompt')).exists()).toBe(reviewed);
      expect(syncFs.existsSync(join(t.config.runDir, 'lock'))).toBe(boundary === 'release-failure');
      const original = await fs.readFile(path, 'utf8');
      if (boundary === 'release-failure') {
        await assert.rejects(() => run(t.config), { code: 'EEXIST' });
      } else if (boundary === 'active') {
        await assert.rejects(
          () => withInterrupts(() => run(t.config)),
          new RegExp(interruptionMessage),
        );
      } else {
        const result = await withInterrupts(() => run(t.config));
        expect(result.result).toBe('interrupted');
      }
      expect(await fs.readFile(path, 'utf8')).toBe(original);
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  for (const boundary of ['active', 'terminal', 'release-failure'] as const) {
    test(`${signal} at ${boundary} retains previous state when interruption save fails`, async () => {
      const t = await trial('normal');
      await fs.writeFile(join(t.config.cwd, 'source.txt'), 'correct');
      await fs.mkdir(t.config.runDir);
      const path = join(t.config.runDir, 'state.json');
      const rename = fs.rename;
      const rmdir = syncFs.rmdirSync;
      let previous: string | undefined;
      const unlock = spyOn(syncFs, 'rmdirSync').mockImplementation((...args) => {
        if (boundary === 'release-failure' && args[0] === join(t.config.runDir, 'lock')) {
          previous = syncFs.readFileSync(path, 'utf8');
          process.emit(signal);
          throw Error('injected lock release failure');
        }
        rmdir(...args);
      });
      const hook = spyOn(fs, 'rename').mockImplementation(async (...args) => {
        if (args[1] === path && previous !== undefined) {
          throw Error('injected interruption storage failure');
        }
        await rename(...args);
        if (args[1] !== path) {
          return;
        }
        const text = await fs.readFile(path, 'utf8');
        const saved: unknown = JSON.parse(text);
        assertState(saved);
        if (
          boundary === 'active'
            ? saved.active?.role === 'check'
            : boundary === 'terminal' && saved.result === 'ready_for_human_review'
        ) {
          previous = text;
          process.emit(signal);
        }
      });
      try {
        await assert.rejects(
          () => withInterrupts(() => run(t.config)),
          /interrupted:.*cannot save terminal state.*injected interruption storage failure/s,
        );
      } finally {
        hook.mockRestore();
        unlock.mockRestore();
      }
      assert(typeof previous === 'string');
      expect(await fs.readFile(path, 'utf8')).toBe(previous);
      const saved = await t.state();
      assertState(saved);
      expect(saved.active === null).toBe(boundary !== 'active');
      expect(saved.review).toBe(boundary !== 'active' ? 1 : 0);
      expect(saved.repair).toBe(0);
      const pending: unknown = JSON.parse(await fs.readFile(`${path}.tmp`, 'utf8'));
      assertState(pending);
      expect(pending.result).toBe('interrupted');
      expect(pending.active).toEqual(saved.active);
      expect(syncFs.existsSync(join(t.config.runDir, 'lock'))).toBe(true);
      await assert.rejects(() => run(t.config), { code: 'EEXIST' });
    });
  }
}

test('normal terminal save excludes another verification through synchronous lock release', async () => {
  const t = await trial('normal');
  await fs.writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  await fs.mkdir(t.config.runDir);
  const lock = join(t.config.runDir, 'lock');
  const path = join(t.config.runDir, 'state.json');
  const rename = fs.rename;
  let excluded = false;
  const hook = spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await rename(...args);
    if (args[1] === path && (await t.state()).result === 'ready_for_human_review') {
      await assert.rejects(() => run(t.config), { code: 'EEXIST' });
      excluded = true;
    }
  });
  try {
    const result = await withInterrupts(() => run(t.config));
    expect(result.result).toBe('ready_for_human_review');
  } finally {
    hook.mockRestore();
  }
  expect(excluded).toBe(true);
  expect((await t.state()).result).toBe('ready_for_human_review');
  await assert.rejects(() => fs.access(lock), { code: 'ENOENT' });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} preserves exclusion throughout interruption state update`, async () => {
    const t = await trial('normal');
    await fs.writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await fs.mkdir(t.config.runDir);
    const path = join(t.config.runDir, 'state.json');
    const rename = fs.rename;
    let excluded = false;
    const hook = spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (args[1] === path) {
        const pending: unknown = JSON.parse(await fs.readFile(String(args[0]), 'utf8'));
        assertState(pending);
        if (pending.result === 'interrupted') {
          expect((await t.state()).result).toBe('ready_for_human_review');
          await assert.rejects(() => run(t.config), { code: 'EEXIST' });
          excluded = true;
        }
      }
      await rename(...args);
      if (args[1] === path && (await t.state()).result === 'ready_for_human_review') {
        process.emit(signal);
      }
    });
    try {
      await assert.rejects(
        () => withInterrupts(() => run(t.config)),
        new RegExp(interruptionMessage),
      );
    } finally {
      hook.mockRestore();
    }
    expect(excluded).toBe(true);
    expect((await t.state()).result).toBe('interrupted');
  });

  for (const mode of ['stopped', 'rejected'] as const) {
    test(`${signal} at failed lock release preserves ${mode} original record`, async () => {
      const realOutput = signal === 'SIGINT' && mode === 'stopped';
      const t = await terminalRecord(realOutput);
      const path = join(t.config.runDir, 'state.json');
      const original = await fs.readFile(path, 'utf8');
      const files = (await fs.readdir(t.config.runDir)).sort();
      // 直接準備した記録も正常に読めることを、障害注入前の同じrunで確認する。
      expect((await withInterrupts(() => run(t.config))).result).toBe(
        realOutput ? 'ready_for_human_review' : 'check_failed',
      );
      expect(await fs.readFile(path, 'utf8')).toBe(original);
      const config =
        mode === 'rejected' ? { ...t.config, checkTimeMs: t.config.checkTimeMs + 1 } : t.config;
      const rmdir = syncFs.rmdirSync;
      let injected = false;
      const hook = spyOn(syncFs, 'rmdirSync').mockImplementation((...args) => {
        if (args[0] === join(t.config.runDir, 'lock')) {
          injected = true;
          process.emit(signal);
          throw Error('injected lock release failure');
        }
        rmdir(...args);
      });
      try {
        await assert.rejects(
          () => withInterrupts(() => run(config)),
          new RegExp(
            mode === 'rejected'
              ? 'Run configuration changed.*injected lock release failure'
              : 'injected lock release failure',
          ),
        );
      } finally {
        hook.mockRestore();
      }
      expect(injected).toBe(true);
      expect(await fs.readFile(path, 'utf8')).toBe(original);
      expect(syncFs.existsSync(join(t.config.runDir, 'lock'))).toBe(true);
      expect((await fs.readdir(t.config.runDir)).filter((name) => name !== 'lock').sort()).toEqual(
        files,
      );
    });
  }
}

// 終端読取りへの実出力接続は1件残し、他は各checkoutに対応する記録だけを準備する。
async function terminalRecord(realOutput: boolean) {
  const t = await trial('normal');
  if (realOutput) {
    expect(t.execute().status).toBe(0);
    return t;
  }
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: t.config.cwd, encoding: 'utf8' });
  expect(base.status).toBe(0);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const state = {
    reviewFormat: 4,
    issueFormat: 1,
    configHash: hash(JSON.stringify(t.config)),
    issueHash: hash('Agreed requirement: correct source and docs\n'),
    baseCommit: base.stdout.trim(),
    source: await snapshot(t.config.cwd),
    repair: 0,
    review: 0,
    checks: 1,
    modelMs: 0,
    active: null,
    events: [{ role: 'check', prefix: 'check-1', code: 1, timedOut: false }],
    reviewHistory: [],
    result: 'check_failed',
  };
  assertState(state);
  await fs.mkdir(t.config.runDir);
  await fs.writeFile(join(t.config.runDir, 'state.json'), JSON.stringify(state, null, 2));
  return t;
}

for (const signal of [null, 'SIGINT', 'SIGTERM'] as const) {
  test(`output storage failure with ${signal ?? 'no interruption'} retains acquired output and reservation`, async () => {
    const t = await trial('normal');
    await fs.writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await fs.mkdir(t.config.runDir);
    const stdout = join(t.config.runDir, 'check-1.stdout');
    const writeFile = fs.writeFile;
    const cause = Error('injected output storage failure');
    const hook = spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === stdout) {
        if (signal) {
          process.emit(signal);
        }
        throw cause;
      }
      return writeFile(...args);
    });
    try {
      await assert.rejects(
        () => withInterrupts(() => run(t.config)),
        (error: unknown) => {
          assert(error instanceof OutputStorageError);
          expect(error.failures).toEqual([{ path: stdout, cause }]);
          expect(error.result.stdout).toBe('source must be correct\n');
          expect(error.result.code).toBe(0);
          return true;
        },
      );
    } finally {
      hook.mockRestore();
    }
    const saved = await t.state();
    expect(saved.result).toBe(signal ? 'interrupted' : undefined);
    expect(saved.active).toEqual({ role: 'check', prefix: join(t.config.runDir, 'check-1') });
    expect(saved.review).toBe(0);
    expect(saved.events).toHaveLength(0);
    expect(await fs.readFile(join(t.config.runDir, 'check-1.stderr'), 'utf8')).toBe(
      'validation failed: source is broken\n',
    );
  });
}

test('lock release failure without interruption preserves success and lock', async () => {
  const t = await trial('normal');
  await fs.writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  await fs.mkdir(t.config.runDir);
  const failure = Error('injected lock release failure');
  const hook = spyOn(syncFs, 'rmdirSync').mockImplementation(() => {
    throw failure;
  });
  try {
    await assert.rejects(
      () => withInterrupts(() => run(t.config)),
      (error: unknown) => error === failure,
    );
  } finally {
    hook.mockRestore();
  }
  expect((await t.state()).result).toBe('ready_for_human_review');
  await assert.rejects(() => run(t.config), { code: 'EEXIST' });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} retains output storage error when interruption state storage also fails`, async () => {
    const t = await trial('normal');
    await fs.writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await fs.mkdir(t.config.runDir);
    const path = join(t.config.runDir, 'state.json');
    const stdout = join(t.config.runDir, 'check-1.stdout');
    const writeFile = fs.writeFile;
    const rename = fs.rename;
    const cause = Error('injected output storage failure');
    let previous: string | undefined;
    const output = spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === stdout) {
        previous = await fs.readFile(path, 'utf8');
        process.emit(signal);
        throw cause;
      }
      return writeFile(...args);
    });
    const terminal = spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (args[1] === path && previous !== undefined) {
        throw Error('injected interruption storage failure');
      }
      return rename(...args);
    });
    try {
      await assert.rejects(
        () => withInterrupts(() => run(t.config)),
        (error: unknown) => {
          assert(error instanceof AggregateError);
          const first: unknown = error.errors[0];
          assert(first instanceof OutputStorageError);
          expect(first.failures).toEqual([{ path: stdout, cause }]);
          expect(first.result.stdout).toBe('source must be correct\n');
          expect(error.message).toMatch(
            /interrupted:.*cannot save terminal state.*injected interruption storage failure/s,
          );
          return true;
        },
      );
    } finally {
      output.mockRestore();
      terminal.mockRestore();
    }
    assert(typeof previous === 'string');
    expect(await fs.readFile(path, 'utf8')).toBe(previous);
    const pending: unknown = JSON.parse(await fs.readFile(`${path}.tmp`, 'utf8'));
    assertState(pending);
    expect(pending.result).toBe('interrupted');
    expect(pending.active?.role).toBe('check');
    await assert.rejects(() => run(t.config), { code: 'EEXIST' });
  });
}

const invalidTimes: Record<string, { startedAt?: unknown; finishedAt?: unknown }> = {
  'numeric-time': { startedAt: 0, finishedAt: 1 },
  'array-time': {
    startedAt: ['2026-10-08T08:21:32.456Z'],
    finishedAt: ['2026-10-08T08:25:35.417Z'],
  },
  'reversed-time': { finishedAt: '2026-10-08T08:20:00.000Z' },
  'non-utc-time': { finishedAt: '2026-10-08T08:25:35.417' },
};

for (const defect of [
  'none',
  'active',
  'lock',
  'nonterminal',
  'unfinished',
  'uncertain',
  'reason',
  'phase',
  'evidence',
  'details',
  'time',
  'state',
  'empty-state',
  'missing-state',
  'numeric-time',
  'array-time',
  'reversed-time',
  'non-utc-time',
] as const) {
  test(`legacy interrupted execution reconciliation: ${defect}`, async () => {
    const { dir, cwd, saved } = await legacyRecord(defect === 'none');
    const verification = join(dir, 'verification');
    await fs.mkdir(verification);
    delete saved.result;
    if (defect === 'active') {
      saved.active = { role: 'check', prefix: 'check-1' };
    }
    if (defect === 'state') {
      saved.review = -1;
    }
    const statePath = join(verification, 'state.json');
    if (defect !== 'missing-state') {
      await fs.writeFile(statePath, defect === 'empty-state' ? '' : JSON.stringify(saved));
    }
    if (defect === 'lock') {
      await fs.mkdir(join(verification, 'lock'));
    }
    const result: Record<string, unknown> = {
      checkout: cwd,
      evidence: dir,
      details: statePath,
      terminal: defect !== 'nonterminal',
      status: defect === 'unfinished' ? 'running' : 'stopped',
      phase: defect === 'phase' ? 'publication' : 'verification',
      reason: defect === 'reason' ? 'requirements_changed' : interruptionMessage,
      publication: defect === 'uncertain' ? 'unconfirmed' : 'not_attempted',
      startedAt: '2026-10-08T08:21:32.456Z',
      finishedAt: defect === 'time' ? '' : '2026-10-08T08:25:35.417Z',
    };
    Object.assign(result, invalidTimes[defect]);
    if (defect === 'evidence') {
      result.evidence = join(dir, 'other');
    }
    if (defect === 'details') {
      result.details = join(dir, 'other.json');
    }
    const resultPath = join(dir, 'result.json');
    await fs.writeFile(resultPath, JSON.stringify(result));
    const originalState = await readOptionalState(statePath);
    const originalResult = await fs.readFile(resultPath, 'utf8');
    const action = () =>
      reconcileExecutions({ previousRun: dir, runDirectory: join(dir, '..', 'new-run') }, cwd);
    if (defect === 'none') {
      await action();
    } else {
      await assert.rejects(action);
    }
    expect(await readOptionalState(statePath)).toBe(originalState);
    expect(await fs.readFile(resultPath, 'utf8')).toBe(originalResult);
  });
}

// 正常対照だけ実出力を使い、拒否条件はGit・actorを必要としない独立した記録で検査する。
async function legacyRecord(
  realOutput: boolean,
): Promise<{ dir: string; cwd: string; saved: Record<string, unknown> }> {
  if (realOutput) {
    const t = await trial('normal');
    expect(t.execute().status).toBe(0);
    return { dir: t.root, cwd: t.config.cwd, saved: await t.state() };
  }
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'interruption-record-')));
  recordRoots.push(root);
  const dir = join(root, 'previous');
  await fs.mkdir(dir);
  return {
    dir,
    cwd: join(root, 'work'),
    saved: {
      reviewFormat: 4,
      issueFormat: 1,
      configHash: 'fixture-config',
      issueHash: 'fixture-issue',
      baseCommit: 'fixture-base',
      repair: 0,
      review: 0,
      checks: 0,
      modelMs: 0,
      active: null,
      events: [],
      reviewHistory: [],
    },
  };
}

async function readOptionalState(path: string) {
  return fs.readFile(path, 'utf8').catch((error: unknown) => {
    assert(error instanceof Error && 'code' in error && error.code === 'ENOENT');
    return undefined;
  });
}

test('pre-verification stop does not require a verification state', async () => {
  const { dir, cwd } = await legacyRecord(false);
  const path = join(dir, 'result.json');
  const original = JSON.stringify({
    checkout: cwd,
    phase: 'preparation',
    reason: interruptionMessage,
    publication: 'not_attempted',
  });
  await fs.writeFile(path, original);
  await reconcileExecutions({ previousRun: dir, runDirectory: join(dir, '..', 'new-run') }, cwd);
  expect(await fs.readFile(path, 'utf8')).toBe(original);
  expect(await readOptionalState(join(dir, 'verification/state.json'))).toBeUndefined();
});
