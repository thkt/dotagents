import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  geminiResponse,
  writingCandidate,
  reviewWriting,
  writingModel,
  GeminiUnavailable,
  availabilityReason,
} from '../writing.ts';
import { eventStream } from './support/writing.ts';

const original = [
  { name: 'README.md', body: '商品は4件です。`CODEX_FLOW_RUNTIME_DIR`\n[手順](./steps.md)\n' },
];
test('reject missing completion and tool use', () => {
  expect(() =>
    geminiResponse('{"event":"init","init":{"model":"gemini-3.8-flash-high"}}'),
  ).toThrow();
  expect(() => geminiResponse(eventStream('text') + '\n{"event":"tool_call"}')).toThrow();
});

test('protected references and duplicate documents cannot be silently rewritten', () => {
  expect(() =>
    writingCandidate(
      JSON.stringify({ documents: [{ name: 'README.md', body: '商品は4件です。' }] }),
      original,
    ),
  ).toThrow();
  expect(() =>
    writingCandidate(JSON.stringify({ documents: [...original, ...original] }), [
      ...original,
      { name: 'steps.md', body: '手順です。' },
    ]),
  ).toThrow();
  expect(writingCandidate(JSON.stringify({ documents: original }), original)).toEqual(original);
});

for (const accepted of [true, false]) {
  test(`separate fidelity decision controls adoption: ${accepted}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'writing-test-'));
    const dir = join(root, 'review');
    let calls = 0;
    const candidate = [
      {
        ...original[0],
        name: 'README.md',
        body: `商品は${accepted ? '4' : '5'}件あります。\`CODEX_FLOW_RUNTIME_DIR\`\n[手順](./steps.md)\n`,
      },
    ];
    try {
      const action = () =>
        reviewWriting(original, '商品数は4件。', dir, async (argv, _cwd, input) => {
          calls++;
          if (argv[0] === 'agy') {
            return eventStream(JSON.stringify({ documents: candidate }));
          }
          const payload = input.slice(input.lastIndexOf('\n') + 1);
          expect(JSON.parse(payload)).toEqual({ facts: '商品数は4件。', original, candidate });
          return JSON.stringify({
            status: accepted ? 'accepted' : 'needs_changes',
            findings: accepted ? '数量と条件を保持' : '商品数を5件へ変更している',
          });
        });
      if (accepted) {
        expect(await action()).toEqual(candidate);
        expect(await readFile(join(dir, 'accepted.json'), 'utf8')).toContain(writingModel);
      } else {
        await assert.rejects(action, /did not accept/);
        await assert.rejects(() => readFile(join(dir, 'accepted.json')), { code: 'ENOENT' });
        expect(await readFile(join(dir, 'candidate.json'), 'utf8')).toContain('5件');
      }
      if (accepted) {
        await assert.rejects(action, { code: 'EEXIST' });
        expect(calls).toBe(2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('unavailable Gemini retains original without accepting it', async () => {
  const reason = 'cli_missing';
  const root = await mkdtemp(join(tmpdir(), 'writing-skip-'));
  try {
    let calls = 0;
    const dir = join(root, 'review');
    expect(
      await reviewWriting(original, '4件', dir, async () => {
        calls++;
        throw new GeminiUnavailable(reason);
      }),
    ).toEqual(original);
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(join(dir, 'skipped.json'), 'utf8'))).toMatchObject({
      status: 'skipped',
      reason,
    });
    await assert.rejects(() => readFile(join(dir, 'accepted.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('availability classification does not swallow unknown or malformed failures', async () => {
  expect(availabilityReason('ENOENT', '')).toBe('cli_missing');
  expect(availabilityReason(undefined, 'authentication failed: 401')).toBe('authentication');
  expect(availabilityReason(undefined, 'ENOTFOUND')).toBe('connection');
  expect(availabilityReason(undefined, 'unexpected internal failure')).toBeUndefined();
  for (const code of [401, 429, 503]) {
    expect(
      availabilityReason(undefined, `TypeError: unexpected value at /cli.js:${code}:12`),
    ).toBeUndefined();
  }
  expect(availabilityReason(undefined, 'HTTP status: 503')).toBe('service_unavailable');
  const root = await mkdtemp(join(tmpdir(), 'writing-invalid-'));
  try {
    const failure = Error('unknown');
    await assert.rejects(
      () =>
        reviewWriting(original, '4件', join(root, 'unknown'), async () => {
          throw failure;
        }),
      failure,
    );
    await assert.rejects(
      () =>
        reviewWriting(original, '4件', join(root, 'invalid'), async () => eventStream('not JSON')),
      SyntaxError,
    );
    await assert.rejects(() => readFile(join(root, 'invalid', 'skipped.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
