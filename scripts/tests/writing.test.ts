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
  {
    name: 'README.md',
    body: 'reviewHistoryの商品は4件です。`CODEX_FLOW_RUNTIME_DIR`\n[手順](./steps.md)\n',
  },
];
test('reject missing completion and tool use', () => {
  expect(() =>
    geminiResponse('{"event":"init","init":{"model":"gemini-3.8-flash-high"}}'),
  ).toThrow();
  expect(() => geminiResponse(eventStream('text') + '\n{"event":"tool_call"}')).toThrow();
});

test('invalid model streams remain failures even with a service-error payload', () => {
  expect(() => geminiResponse('not JSON')).toThrow(SyntaxError);
  const error =
    '\n' +
    JSON.stringify({
      event: 'result',
      result: {
        status: 'ERROR',
        error: '503 service unavailable',
      },
    });
  expect(() => geminiResponse('{"event":"init","init":{"model":"wrong"}}' + error)).toThrow(
    'Unexpected writing model',
  );
  expect(() => geminiResponse(eventStream('text').replace('SUCCESS', 'UNKNOWN'))).toThrow(
    'Invalid Gemini result',
  );
});

test('protected references and duplicate documents cannot be silently rewritten', () => {
  expect(() =>
    writingCandidate(
      JSON.stringify({ documents: [{ name: 'README.md', body: '商品は4件です。' }] }),
      original,
    ),
  ).toThrow('Protected content changed');
  expect(() =>
    writingCandidate(JSON.stringify({ documents: [...original, ...original] }), [
      ...original,
      { name: 'steps.md', body: '手順です。' },
    ]),
  ).toThrow('Missing/duplicate document');
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
        body: `\`reviewHistory\`の商品は${accepted ? '4' : '5'}件あります。\`CODEX_FLOW_RUNTIME_DIR\`\n[手順](./steps.md)\n`,
      },
    ];
    try {
      const action = () =>
        reviewWriting(original, '商品数は4件。', dir, async (argv, _cwd, input) => {
          calls++;
          if (argv[0] === 'agy') {
            return JSON.stringify({ documents: candidate });
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
      () => reviewWriting(original, '4件', join(root, 'invalid'), async () => 'not JSON'),
      SyntaxError,
    );
    await assert.rejects(() => readFile(join(root, 'invalid', 'skipped.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, before, after] of [
  ['inline value', '`reviewHistory`', '`reviewState`'],
  ['inline omission', '`prepare` then `publish`', '`prepare` then publish'],
  ['inline duplication', '`prepare` then publish', '`prepare` then `prepare`'],
  ['nested inline delimiter', '``a `quoted` value``', '``a `changed` value``'],
  ['image destination', '![画面](./before.png)', '![画面](./after.png)'],
  ['frontmatter', '---\nname: reviewHistory\n---\n本文', '---\nname: `reviewHistory`\n---\n本文'],
  ['hash', '版は' + 'a'.repeat(40), '版は' + 'b'.repeat(40)],
  ['closing reference', 'Closes #67', 'Closes #68'],
  ['indented fence', '  ~~~sh\n  publish --dry-run\n  ~~~\n', '  ~~~sh\n  publish\n  ~~~\n'],
  ['nested fence', '- 手順\n\n  ```sh\n  safe\n  ```\n', '- 手順\n\n  ```sh\n  unsafe\n  ```\n'],
  ['indented code', '手順\n\n    safe\n', '手順\n\n    unsafe\n'],
  [
    'relative reference',
    '[手順][steps]\n\n[steps]: ./safe.md\n',
    '[手順][steps]\n\n[steps]: ./unsafe.md\n',
  ],
  [
    'collapsed reference',
    '[steps][]\n\n[steps]: ./safe.md\n',
    '[steps][]\n\n[steps]: ./unsafe.md\n',
  ],
  ['reference image', '![steps]\n\n[steps]: ./safe.png\n', '![steps]\n\n[steps]: ./unsafe.png\n'],
  ['reference count', '[steps]\n\n[steps]: ./safe.md\n', '[steps] [steps]\n\n[steps]: ./safe.md\n'],
  ['reference order', '[a] [b]\n\n[a]: ./a\n[b]: ./b\n', '[b] [a]\n\n[a]: ./a\n[b]: ./b\n'],
  ['inline order', '`prepare` then `publish`', '`publish` then `prepare`'],
  [
    'link order',
    '[Setup](https://example.org/setup) [Deploy](https://example.org/deploy)',
    '[Deploy](https://example.org/deploy) [Setup](https://example.org/setup)',
  ],
  ['block and inline order', '`prepare`\n```sh\ndeploy\n```\n', '```sh\ndeploy\n```\n`prepare`\n'],
] as const) {
  test(`protected content rejects changed ${name}`, () => {
    const unchanged = [{ name: 'README.md', body: before }];
    expect(writingCandidate(JSON.stringify({ documents: unchanged }), unchanged)).toEqual(
      unchanged,
    );
    expect(() =>
      writingCandidate(JSON.stringify({ documents: [{ name: 'README.md', body: after }] }), [
        { name: 'README.md', body: before },
      ]),
    ).toThrow('Protected content changed');
  });
}

for (const [name, before, after] of [
  ['changed identifier', 'reviewHistoryを保持する。', '`reviewState`を保持する。'],
  ['identifier substring', 'reviewHistoryNextを保持する。', '`reviewHistory`を保持する。'],
  [
    'qualified identifier substring',
    'state.reviewHistoryを保持する。',
    '`reviewHistory`を保持する。',
  ],
  ['member identifier prefix', 'reviewHistory.stateを保持する。', '`reviewHistory`を保持する。'],
  [
    'private identifier substring',
    '非公開フィールド#reviewHistoryを保持する。',
    '非公開フィールド`reviewHistory`を保持する。',
  ],
  ['namespace identifier substring', 'std::vectorを使用する。', '`vector`を使用する。'],
  ['namespace identifier prefix', 'std::vectorを使用する。', '`std`を使用する。'],
  ['ambiguous source', 'reviewHistoryを読む。reviewHistoryを残す。', '`reviewHistory`を残す。'],
  ['duplicate addition', 'reviewHistoryを残す。', '`reviewHistory`と`reviewHistory`を残す。'],
  ['crossed anchor', 'reviewHistoryの後に`publish`。', '`publish`の後に`reviewHistory`。'],
  ['omitted existing code', 'reviewHistoryの後に`publish`。', '`reviewHistory`の後にpublish。'],
  ['reordered additions', 'reviewHistoryとreviewState。', '`reviewState`と`reviewHistory`。'],
  ['hidden link', '[手順](./steps.md)を読む。', '`[手順](./steps.md)`を読む。'],
] as const) {
  test(`inline decoration rejects ${name}`, () => {
    expect(() =>
      writingCandidate(JSON.stringify({ documents: [{ name: 'README.md', body: after }] }), [
        { name: 'README.md', body: before },
      ]),
    ).toThrow('Protected content changed');
  });
}

for (const [name, before, after] of [
  ['sentence-final identifier', 'Use reviewHistory.', 'Use `reviewHistory`.'],
  [
    'private identifier',
    '非公開フィールド#reviewHistoryを保持する。',
    '非公開フィールド`#reviewHistory`を保持する。',
  ],
  ['namespace identifier', 'std::vectorを使用する。', '`std::vector`を使用する。'],
] as const) {
  test(`inline decoration accepts complete ${name}`, () => {
    const candidate = [{ name: 'README.md', body: after }];
    expect(
      writingCandidate(JSON.stringify({ documents: candidate }), [
        { name: 'README.md', body: before },
      ]),
    ).toEqual(candidate);
  });
}

test('multiple exact decorations coexist with prose edits and existing protected content', () => {
  const before = [
    {
      name: 'README.md',
      body: 'reviewHistoryを残すことができます。`prepare`\n[手順](./steps.md)のreviewStateを確認します。',
    },
  ];
  const after = [
    {
      name: 'README.md',
      body: '`reviewHistory`を残せます。`prepare`\n[手順](./steps.md)の``reviewState``を確認します。',
    },
  ];
  expect(writingCandidate(JSON.stringify({ documents: after }), before)).toEqual(after);
});

for (const response of ['not JSON', '{"status":"accepted"}', 'unavailable']) {
  test(`decoration cannot bypass failed fidelity review: ${response}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'writing-fidelity-'));
    const dir = join(root, 'review');
    const candidate = original.map((doc) => ({
      ...doc,
      body: doc.body.replace('reviewHistory', '`reviewHistory`'),
    }));
    try {
      await assert.rejects(
        () =>
          reviewWriting(original, '商品数は4件。', dir, async (argv) => {
            if (argv[0] === 'agy') {
              return JSON.stringify({ documents: candidate });
            }
            if (response === 'unavailable') {
              throw Error('Codex unavailable');
            }
            return response;
          }),
        response === 'unavailable'
          ? /Codex unavailable/
          : response === 'not JSON'
            ? SyntaxError
            : /did not accept/,
      );
      expect(JSON.parse(await readFile(join(dir, 'candidate.json'), 'utf8'))).toEqual(candidate);
      expect(JSON.parse(await readFile(join(dir, 'input.json'), 'utf8'))).toEqual({
        facts: '商品数は4件。',
        documents: original,
      });
      if (response !== 'unavailable') {
        expect(await readFile(join(dir, 'review.json'), 'utf8')).toBe(response);
      }
      await assert.rejects(() => readFile(join(dir, 'accepted.json')), { code: 'ENOENT' });
      await assert.rejects(() => readFile(join(dir, 'skipped.json')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
