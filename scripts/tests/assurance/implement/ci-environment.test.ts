import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForCi } from '../../../implement/ci.ts';
import { command, OutputStorageError } from '../../../shared/process.ts';
import {
  scenarios,
  runScenario,
  isAssuranceScenario,
  target,
  ok,
  required,
  frame,
} from '../../support/ci.ts';

for (const scenario of scenarios.filter(isAssuranceScenario)) {
  test(`CI execution: ${scenario.name}`, () => runScenario(scenario));
}

for (const collision of ['directory', 'complete record']) {
  test(`CI response save failure preserves ${collision} and raw retrieval evidence`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-save-'));
    const path = join(dir, 'pr.json');
    const raw = JSON.stringify(frame(required));
    let reads = 0;
    try {
      if (collision === 'directory') {
        await mkdir(path);
      } else {
        await writeFile(path, 'previous complete record');
      }
      const result = await waitForCi(
        { ...target, dir },
        async (_argv, _cwd, _input, _timeout, log) => {
          reads++;
          await writeFile(`${log}.stdout`, raw);
          await writeFile(`${log}.stderr`, '');
          return ok(raw);
        },
        1000,
      );
      expect(result.status).toBe('storage_failed');
      expect(result.reason).toContain(path);
      expect(result.reason).toContain('EEXIST');
      expect(result.lastObservation).toBeNull();
      expect(result.nextAction).toContain('host must restore writable evidence storage');
      expect(result.nextAction).toContain('Do not resume');
      expect(result.nextAction).not.toContain('gh authentication');
      expect(result.logs).toEqual([join(dir, 'pr-publication')]);
      expect(await readFile(`${result.logs[0]}.stdout`, 'utf8')).toBe(raw);
      expect(reads).toBe(1);
      if (collision === 'complete record') {
        expect(await readFile(path, 'utf8')).toBe('previous complete record');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const { phase, streams } of [
  { phase: 'initial', streams: ['stdout'] },
  { phase: 'initial', streams: ['stderr'] },
  { phase: 'final', streams: ['stderr'] },
  { phase: 'initial', streams: ['stdout', 'stderr'] },
]) {
  test(`CI ${phase} ${streams.join('/')} save failure preserves acquired evidence`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-output-'));
    const log = join(dir, phase === 'initial' ? 'pr-publication' : 'ci-final-target');
    const raw = JSON.stringify(frame(required));
    let reads = 0;
    try {
      for (const stream of streams) {
        await mkdir(`${log}.${stream}`);
      }
      if (streams.length === 2) {
        await writeFile(join(dir, 'pr.json'), 'previous complete record');
      }
      const result = await waitForCi(
        { ...target, dir },
        async (_argv, cwd, input, timeout, prefix) => {
          reads++;
          return command(
            [
              process.execPath,
              '-e',
              `process.stdout.write(${JSON.stringify(raw)}); process.stderr.write('retrieval diagnostic')`,
            ],
            cwd,
            input,
            timeout,
            prefix,
          );
        },
        1000,
      );
      expect(result.status).toBe('storage_failed');
      for (const stream of streams) {
        expect(result.reason).toContain(`${log}.${stream}`);
      }
      expect(result.reason).toContain(JSON.stringify(raw));
      expect(result.reason).toContain('retrieval diagnostic');
      expect(result.reason).toContain('"code":0');
      expect(result.reason).toContain('"timedOut":false');
      expect(result.reason).toContain('EISDIR');
      expect(result.lastObservation?.status ?? null).toBe(phase === 'initial' ? null : 'passed');
      expect(result.nextAction).toContain('writable evidence storage');
      expect(result.logs.at(-1)).toBe(log);
      for (const stream of ['stdout', 'stderr'].filter((stream) => !streams.includes(stream))) {
        expect(await readFile(`${log}.${stream}`, 'utf8')).toBe(
          stream === 'stdout' ? raw : 'retrieval diagnostic',
        );
      }
      expect(await readFile(join(dir, 'pr.json'), 'utf8')).toBe(
        streams.length === 2 ? 'previous complete record' : raw,
      );
      if (streams.length === 2) {
        expect(result.reason).toContain(join(dir, 'pr.json'));
        expect(result.reason).toContain('EEXIST');
      }
      expect(reads).toBe(phase === 'initial' ? 1 : 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const finalStatus of ['unavailable', 'target_changed', 'storage_failed'] as const) {
  test(`CI poll storage failure survives final ${finalStatus}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-poll-storage-'));
    const pollLog = join(dir, 'ci-registration-1');
    const finalLog = join(dir, 'ci-final-target');
    const raw = JSON.stringify(frame(required));
    let reads = 0;
    try {
      const result = await waitForCi(
        { ...target, dir },
        async (_argv, _cwd, _input, _timeout, log) => {
          reads++;
          if (log === pollLog || (log === finalLog && finalStatus === 'storage_failed')) {
            throw new OutputStorageError(
              [{ path: `${log}.stdout`, cause: Error(`ENOSPC at ${log}`) }],
              { ...ok(raw), stderr: 'retrieval diagnostic' },
            );
          }
          if (log === finalLog) {
            return finalStatus === 'unavailable'
              ? { ...ok(''), code: 1, stderr: 'offline' }
              : ok(JSON.stringify(frame(required, 'different')));
          }
          return ok(JSON.stringify(frame([])));
        },
        1000,
        async () => {},
      );
      expect(result.status).toBe('storage_failed');
      expect(result.reason).toContain(`${pollLog}.stdout`);
      expect(result.reason).toContain(`ENOSPC at ${pollLog}`);
      expect(result.reason).toContain(JSON.stringify(raw));
      expect(result.reason).toContain(`final target check (${finalStatus})`);
      expect(result.reason).toContain(
        finalStatus === 'unavailable'
          ? 'exit 1'
          : finalStatus === 'target_changed'
            ? 'head=different'
            : `ENOSPC at ${finalLog}`,
      );
      expect(result.nextAction).toContain('writable evidence storage');
      expect(result.nextAction).toContain('Do not resume');
      if (finalStatus === 'unavailable') {
        expect(result.nextAction).toContain('gh authentication');
      } else if (finalStatus === 'target_changed') {
        expect(result.nextAction).toContain('Reconcile the current PR');
      }
      expect(result.lastObservation?.status).toBe('missing');
      expect(result.logs).toEqual([join(dir, 'pr-publication'), pollLog, finalLog]);
      expect(await readFile(join(dir, 'pr.json'), 'utf8')).toBe(JSON.stringify(frame([])));
      expect(reads).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
