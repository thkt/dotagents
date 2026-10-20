import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isRecord } from '../../scripts/shared/values.ts';

export const lightEvidenceWorker = import.meta.path;
const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
if (import.meta.main) {
  const [root, mode] = process.argv.slice(2);
  assert(root && (mode === 'stable' || mode === 'replace'));
  const realFs = { ...fs };
  const path = join(root, 'boundary.json');
  const log = join(root, 'synthetic.log');
  await realFs.writeFile(log, '合成の観測。');
  const logHash = digest(await realFs.readFile(log));
  const observations = [
    ...['public-input'].map((target) => ({
      method: 'command',
      target,
      operation: 'read',
      result: 'allowed',
    })),
    ...['trial-workspace', 'trial-temporary'].map((target) => ({
      method: 'command',
      target,
      operation: 'write',
      result: 'allowed',
    })),
    ...[
      'dummy-auth',
      'other-trial',
      'host-judgments',
      'synthetic-private',
      'unlisted-scratch-tmp',
      'unlisted-scratch-var-tmp',
    ].flatMap((target) =>
      ['read', 'write'].map((operation) => ({
        method: 'command',
        target,
        operation,
        result: 'denied',
      })),
    ),
    { method: 'command', target: 'network', operation: 'network', result: 'denied' },
    ...['timeout', 'SIGINT', 'SIGTERM', 'normal-child-exit'].map((target) => ({
      method: 'lifecycle',
      target,
      operation: 'execution',
      result: 'stopped',
    })),
  ].map((item) => ({ ...item, log, sha256: logHash }));
  const fixtureHashes: Record<string, string> = {};
  for (const file of [
    'eval/tests/light-boundary.fixture.ts',
    'eval/tests/fixtures/light-host-cases.json',
    'eval/tests/light-cli.fixture.ts',
  ]) {
    fixtureHashes[file] = digest(await realFs.readFile(resolve(import.meta.dir, '../..', file)));
  }
  let replaced = false;
  // 同一参照を、最初の本文取得後に不合格の版へ置換する。内部読取り回数は要求しない。
  await mock.module('node:fs/promises', () => ({
    ...realFs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const body = await realFs.readFile(...args);
      if (args[0] === path && mode === 'replace' && !replaced) {
        replaced = true;
        await realFs.writeFile(
          path,
          JSON.stringify({ status: 'failed', unvalidated: '置換後の未検査本文' }),
        );
      }
      return body;
    },
  }));
  const native: unknown = await import('../light-native.ts');
  assert(
    isRecord(native) &&
      typeof native.lightProfile === 'function' &&
      typeof native.requireLightBoundary === 'function',
  );
  const versions = {
    cli: 'synthetic-cli',
    bun: '1.4.3',
    git: 'synthetic-git',
    platform: 'darwin',
    arch: 'synthetic',
    entries: {},
  };
  const runnerHashes = { 'synthetic-runner': digest('runner') };
  const original = JSON.stringify({
    status: 'passed',
    runnerHashes,
    versions,
    profilePolicyHash: digest(native.lightProfile.toString()),
    fixtureHashes,
    readToolInventory: { exposed: [], log, sha256: logHash },
    observations,
  });
  await realFs.writeFile(path, original);
  let value: unknown;
  try {
    value = await Reflect.apply(native.requireLightBoundary, undefined, [
      { boundaryEvidence: path },
      runnerHashes,
      versions,
    ]);
  } catch (cause) {
    const error = String(cause);
    assert(!/Cannot find|ENOENT|EPERM|EACCES|SyntaxError/.test(error), error);
    console.log(JSON.stringify({ accepted: false, error, replaced }));
    process.exit(0);
  }
  assert(isRecord(value));
  console.log(
    JSON.stringify({
      accepted: true,
      hash: value.evidenceHash,
      originalHash: digest(original),
      replaced,
    }),
  );
}
