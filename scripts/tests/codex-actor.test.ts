import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { events, object } from './support/correction.ts';

function sortedStrings(value: unknown) {
  const values = events(value);
  assert(values.every((item) => typeof item === 'string'));
  return values.toSorted();
}

async function expectInvocation(root: string, role: string) {
  const invocation = object(JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')));
  const args = events(invocation.args);
  expect(args).toContain('--output-schema');
  expect(args[args.indexOf('--sandbox') + 1]).toBe(
    role === 'repair' ? 'workspace-write' : 'read-only',
  );
  const schema = object(invocation.schema);
  expect(sortedStrings(schema.required)).toEqual(
    (role === 'review'
      ? ['findings', 'targetId', 'assessments', 'updates', 'newItems', 'documents', 'handoff']
      : ['status', 'findings']
    ).toSorted(),
  );
  const properties = object(schema.properties);
  if (role === 'repair') {
    expect(sortedStrings(object(properties.status).enum)).toEqual(['needs_human', 'repaired']);
  } else {
    expect(properties).not.toHaveProperty('status');
    const newItem = object(object(properties.newItems).items);
    for (const field of ['id', 'introducedIn', 'disposition']) {
      expect(newItem.properties).not.toHaveProperty(field);
      expect(sortedStrings(newItem.required)).not.toContain(field);
    }
    expect(sortedStrings(object(object(properties.updates).items).required)).toEqual([
      'disposition',
      'id',
      'reason',
    ]);
  }
}

for (const mode of ['normal', 'repair', 'nonzero', 'missing', 'write_error'] as const) {
  const role = mode === 'repair' ? mode : 'review';
  const succeeds = ['normal', 'repair'].includes(mode);
  test(`Codex actor logs: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'actor-stream-'));
    try {
      const bytes = mode === 'nonzero' ? 64 : 2 * 1024 * 1024;
      if (mode !== 'missing') {
        await writeFile(
          join(root, 'codex'),
          `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const schemaIndex = args.indexOf('--output-schema');
const schema = schemaIndex < 0 ? null : JSON.parse(readFileSync(args[schemaIndex + 1], 'utf8'));
writeFileSync(${JSON.stringify(join(root, 'invocation.json'))}, JSON.stringify({args, schema}));
writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({status:'accepted', findings:''}));
process.stdout.write('x'.repeat(${bytes}) + 'stdout-end');
process.stderr.write('y'.repeat(${bytes}) + 'stderr-end');
process.exitCode = ${mode === 'nonzero' ? 7 : 0};
`,
          { mode: 0o755 },
        );
      }
      // Allow schema and invocation metadata, then fail large log writes with EFBIG.
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          mode === 'write_error' ? 'ulimit -f 16; trap "" XFSZ; exec "$@"' : 'exec "$@"',
          'actor-test',
          process.execPath,
          resolve('scripts/codex-actor.ts'),
          role,
          root,
        ],
        {
          env: { ...process.env, PATH: root },
          input: 'Review fixture',
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(succeeds ? 0 : 1);
      if (succeeds) {
        expect(JSON.parse(result.stdout)).toEqual({ status: 'accepted', findings: '' });
      } else {
        expect(result.stdout).toBe('');
      }
      const entries = await readdir(root);
      const dir = entries.find((entry) => entry.startsWith(`${role}-codex-`));
      expect(dir).toBeDefined();
      if (dir && (succeeds || mode === 'nonzero')) {
        await expectInvocation(root, role);
        expect(await readFile(join(root, dir, 'events.jsonl'), 'utf8')).toBe(
          'x'.repeat(bytes) + 'stdout-end',
        );
        expect(await readFile(join(root, dir, 'stderr.log'), 'utf8')).toBe(
          'y'.repeat(bytes) + 'stderr-end',
        );
      }
      if (dir && mode === 'write_error') {
        await expectInvocation(root, role);
        const sizes = await Promise.all(
          ['events.jsonl', 'stderr.log'].map(
            async (name) => (await stat(join(root, dir, name))).size,
          ),
        );
        expect(sizes.some((size) => size > 0 && size < bytes)).toBe(true);
        expect(result.stderr).toContain('EFBIG');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
