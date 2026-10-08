import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  writeFile,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  rename,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { events, object } from '../support/correction.ts';
import { runtimeShape } from '../../implement/actor-runtime.ts';

function sortedStrings(value: unknown) {
  const values = events(value);
  assert(values.every((item) => typeof item === 'string'));
  return values.toSorted();
}

async function expectInvocation(root: string, role: string) {
  const invocation = object(JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')));
  const version = object(JSON.parse(await readFile(join(root, 'version-invocation.json'), 'utf8')));
  for (const key of ['entry', 'cwd', 'env']) {
    expect(invocation[key]).toEqual(version[key]);
  }
  expect(invocation.entry).toBe(join(root, 'codex'));
  expect(object(invocation.env).DOTAGENTS_FIXTURE_ENV).toBe('fixture-339');
  expect(invocation.inheritedPrefix).toBeNull();
  const args = events(invocation.args);
  expect(args[args.indexOf('-m') + 1]).toBe('gpt-6.1-sol');
  expect(args[args.indexOf('-c') + 1]).toBe(
    role === 'repair' ? 'model_reasoning_effort="medium"' : 'model_reasoning_effort="high"',
  );
  expect(args).toContain('--ignore-user-config');
  expect(args).toContain('--output-schema');
  expect(args[args.indexOf('--sandbox') + 1]).toBe(
    role === 'repair' ? 'workspace-write' : 'read-only',
  );
  return invocation.schema;
}

function expectResponseSchema(value: unknown, mode: Mode) {
  if (!['normal', 'repair'].includes(mode)) {
    return;
  }
  const role = mode === 'repair' ? 'repair' : 'review';
  const schema = object(value);
  expect(sortedStrings(schema.required)).toEqual(
    (role === 'review'
      ? [
          'findings',
          'targetId',
          'assessments',
          'updates',
          'newItems',
          'documents',
          'handoff',
          'walkthrough',
        ]
      : ['status', 'findings']
    ).toSorted(),
  );
  const properties = object(schema.properties);
  if (role === 'repair') {
    expect(sortedStrings(object(properties.status).enum)).toEqual([
      'needs_host',
      'needs_human',
      'repaired',
    ]);
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
    const location = object(object(newItem.properties).location);
    for (const closed of [
      schema,
      object(properties.assessments),
      object(object(properties.updates).items),
      newItem,
      location,
      object(object(properties.documents).items),
    ]) {
      expect(closed.additionalProperties).toBe(false);
      expect(sortedStrings(closed.required)).toEqual(Object.keys(object(closed.properties)).sort());
    }
    const position = object(location.properties);
    expect(object(properties.findings)).toMatchObject({
      type: 'string',
      minLength: 1,
      pattern: '\\S',
    });
    expect(object(position.path).anyOf).toEqual([
      { type: 'string', minLength: 1, pattern: '\\S' },
      { type: 'null' },
    ]);
    expect(object(position.line).anyOf).toEqual([
      { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      { type: 'null' },
    ]);
  }
}

const modes = [
  'normal',
  'repair',
  'shim',
  'version_failure',
  'version_empty',
  'version_timeout',
  'version_orphan',
  'version_overflow',
  'metadata_error',
  'launch_error',
  'nonzero',
  'missing',
  'write_error',
] as const;
type Mode = (typeof modes)[number];

async function mockCodex(root: string, mode: Mode, bytes: number) {
  if (mode !== 'missing') {
    await writeFile(
      join(root, 'codex'),
      `#!${process.execPath}
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import {spawn} from 'node:child_process';
const args = process.argv.slice(${mode === 'shim' ? 3 : 2});
const conditions = {entry:process.argv[${mode === 'shim' ? 2 : 1}],cwd:process.cwd(),env:process.env};
if(args[0] === '--version') {
  if(${JSON.stringify(mode)} === 'metadata_error') {
    const dir = readdirSync(${JSON.stringify(root)}).find(name=>name.startsWith('review-codex-'));
    mkdirSync(${JSON.stringify(root)}+'/'+dir+'/actor.json');
  }
  if(${JSON.stringify(mode)} === 'launch_error') unlinkSync(${JSON.stringify(join(root, 'codex'))});
  writeFileSync(${JSON.stringify(join(root, 'version-invocation.json'))}, JSON.stringify(conditions));
  if(['version_timeout','version_overflow','version_orphan'].includes(${JSON.stringify(mode)})) {
    const child=spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(()=>{},1000)'], {stdio:['ignore','inherit','ignore']});
    writeFileSync(${JSON.stringify(join(root, 'descendant.pid'))},String(child.pid));
  }
  if(${JSON.stringify(mode)} === 'version_orphan') process.exit(0);
  if(${JSON.stringify(mode)} === 'version_timeout') {setInterval(()=>{},1000);}
  else if(${JSON.stringify(mode)} === 'version_overflow') {process.stdout.write('x'.repeat(65537));setInterval(()=>{},1000);}
  else if(${JSON.stringify(mode)} === 'version_failure') {process.exit(9);}
  else {if(${JSON.stringify(mode)} !== 'version_empty') console.log('codex-cli fixture-339');process.exit(0);}
} else {
const schemaIndex = args.indexOf('--output-schema');
const schema = schemaIndex < 0 ? null : JSON.parse(readFileSync(args[schemaIndex + 1], 'utf8'));
writeFileSync(${JSON.stringify(join(root, 'invocation.json'))}, JSON.stringify({...conditions, args, schema, inheritedPrefix: process.env.DOTAGENTS_ACTOR_PREFIX ?? null}));
writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({status:'accepted', findings:''}));
process.stdout.write('x'.repeat(${bytes}) + 'stdout-end');
process.stderr.write('y'.repeat(${bytes}) + 'stderr-end');
}
process.exitCode = ${mode === 'nonzero' ? 7 : 0};
`,
      { mode: 0o755 },
    );
  }
  if (mode === 'shim') {
    await rename(join(root, 'codex'), join(root, 'codex-body'));
    await writeFile(
      join(root, 'manager'),
      `#!/bin/sh
case "$0" in */codex) ;; *) exit 23;; esac
exec "${process.execPath}" "${join(root, 'codex-body')}" "$0" "$@"
`,
      { mode: 0o755 },
    );
    await symlink('manager', join(root, 'codex'));
  }
}

function expectUnknown(value: unknown) {
  const observation = object(value);
  expect(observation.value).toBeNull();
  expect(typeof observation.reason).toBe('string');
  expect(observation.reason).not.toBe('');
}

function expectRuntime(
  metadata: unknown,
  mode: Mode,
  root: string,
  stderr: string,
  entries: string[],
) {
  const runtime = object(object(metadata).runtime);
  if (mode === 'normal') {
    // PATHには模擬Codexだけがあり、Git観測は取得不能でも限定hashは保存されます。
    expect(runtime.harness).toMatchObject({
      commit: { value: null, reason: 'exit code 1' },
      trackedDirty: { value: null, reason: 'harness repository unavailable' },
      scope:
        'implement/shared direct *.ts + package.json + bun.lock; sorted path/mode/content SHA-256; regular files only',
    });
    const codeHash = object(object(runtime.harness).codeHash);
    expect(codeHash.value).toMatch(/^[a-f0-9]{64}$/);
    expect(codeHash.reason).toBeNull();
    expect(runtimeShape.safeParse(runtime).success).toBe(true);
  }
  const cli = object(runtime.cli);
  if (mode === 'missing') {
    expectUnknown(cli.entry);
    expectUnknown(cli.version);
  } else {
    expect(cli.entry).toEqual({ value: join(root, 'codex'), reason: null });
    if (mode === 'launch_error') {
      expect(cli.realpath).toEqual({ value: join(root, 'codex'), reason: null });
      expect(stderr).toContain('ENOENT');
      expect(entries).not.toContain('invocation.json');
    } else {
      expect(cli.realpath).toEqual({
        value: join(root, mode === 'shim' ? 'manager' : 'codex'),
        reason: null,
      });
    }
    const failures: Record<string, string> = {
      version_timeout: 'timeout',
      version_orphan: 'timeout',
      version_empty: 'empty output',
      version_failure: 'exit code 9',
      version_overflow: 'output exceeds 64 KiB',
    };
    expect(cli.version).toEqual(
      failures[mode]
        ? { value: null, reason: failures[mode] }
        : { value: 'codex-cli fixture-339', reason: null },
    );
  }
}

async function cleanupDescendant(root: string) {
  const raw = await readFile(join(root, 'descendant.pid'), 'utf8').catch(() => null);
  if (raw !== null) {
    try {
      process.kill(Number(raw), 'SIGKILL');
    } catch {
      // 観測の終了処理で停止済みです。
    }
  }
}

async function expectWriteError(root: string, dir: string, bytes: number, stderr: string) {
  // /bin/shの単位差に備え、512バイト単位でも小さい記録が収まることを確認します。
  for (const path of [
    join(root, 'version-invocation.json'),
    join(root, 'invocation.json'),
    join(root, dir, 'actor.json'),
    join(root, dir, 'schema.json'),
    join(root, dir, 'final.json'),
  ]) {
    expect((await stat(path)).size).toBeLessThan(16 * 512);
  }
  const sizes = await Promise.all(
    ['events.jsonl', 'stderr.log'].map(async (name) => (await stat(join(root, dir, name))).size),
  );
  expect(sizes.some((size) => size > 0 && size < bytes)).toBe(true);
  expect(stderr).toContain('EFBIG');
}

for (const mode of modes) {
  const role = mode === 'repair' ? mode : 'review';
  const sandbox = role === 'repair' ? 'workspace-write' : 'read-only';
  const succeeds = ![
    'metadata_error',
    'launch_error',
    'nonzero',
    'missing',
    'write_error',
  ].includes(mode);
  test(`Codex actor logs: ${mode}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'actor-stream-')));
    try {
      const bytes = ['normal', 'repair', 'write_error'].includes(mode) ? 2 * 1024 * 1024 : 64;
      await mockCodex(root, mode, bytes);
      // 小さい明示環境でschemaと起動記録を保存し、大容量ログだけをEFBIGにします。
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          mode === 'write_error' ? 'ulimit -f 16; trap "" XFSZ; exec "$@"' : 'exec "$@"',
          'actor-test',
          process.execPath,
          resolve('scripts/implement/codex-actor.ts'),
          role,
          root,
        ],
        {
          env: {
            PATH: root,
            DOTAGENTS_FIXTURE_ENV: 'fixture-339',
            DOTAGENTS_ACTOR_PREFIX: join(root, 'verification/actor-1'),
          },
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
      assert(dir, 'Actor evidence directory missing');
      if (mode === 'metadata_error') {
        expect(result.stderr).toContain('EEXIST');
        expect(await stat(join(root, dir, 'actor.json')).then((info) => info.isDirectory())).toBe(
          true,
        );
        expect(entries).not.toContain('invocation.json');
        return;
      }
      const metadata: unknown = JSON.parse(await readFile(join(root, dir, 'actor.json'), 'utf8'));
      expect(metadata).toMatchObject({
        recordFormat: 2,
        role,
        hostPrefix: 'verification/actor-1',
        model: 'gpt-6.1-sol',
        reasoningEffort: role === 'repair' ? 'medium' : 'high',
        sandbox,
        ignoreUserConfig: true,
      });
      expectRuntime(metadata, mode, root, result.stderr, entries);
      if (['version_timeout', 'version_overflow', 'version_orphan'].includes(mode)) {
        const pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
      }
      if (succeeds || mode === 'nonzero' || mode === 'write_error') {
        const schema = await expectInvocation(root, role);
        expectResponseSchema(schema, mode);
      }
      if (succeeds || mode === 'nonzero') {
        expect(await readFile(join(root, dir, 'events.jsonl'), 'utf8')).toBe(
          'x'.repeat(bytes) + 'stdout-end',
        );
        expect(await readFile(join(root, dir, 'stderr.log'), 'utf8')).toBe(
          'y'.repeat(bytes) + 'stderr-end',
        );
      }
      if (mode === 'write_error') {
        await expectWriteError(root, dir, bytes, result.stderr);
      }
    } finally {
      await cleanupDescendant(root);
      await rm(root, { recursive: true, force: true });
    }
  });
}
