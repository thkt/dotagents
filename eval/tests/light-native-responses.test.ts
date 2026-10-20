import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import {
  nativeBoundaryResponses,
  nativeFixedResponses,
  nativeFixedInputResponses,
  nativeReadToolResponses,
  nativeToolInventoryResponses,
} from './light-native-responses.fixture.ts';
import { lightBoundaryFixture } from './light-boundary.fixture.ts';
import { isRecord } from '../../scripts/shared/values.ts';

function toolInput(sse: string) {
  const events: unknown[] = sse
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line): unknown => JSON.parse(line.slice(6)));
  const done = events.find(
    (event) => isRecord(event) && event.type === 'response.custom_tool_call_input.done',
  );
  assert(isRecord(done) && typeof done.input === 'string');
  return done.input;
}

function executeProbe(
  sse: string,
  inventory: unknown,
  tools: Record<string, unknown>,
  outputs: unknown[],
) {
  const prototype: unknown = Object.getPrototypeOf(async () => {});
  assert(isRecord(prototype) && typeof prototype.constructor === 'function');
  const execute: unknown = Reflect.construct(prototype.constructor, [
    'ALL_TOOLS',
    'tools',
    'text',
    toolInput(sse),
  ]);
  assert(typeof execute === 'function');
  return Promise.resolve(
    Reflect.apply(execute, undefined, [inventory, tools, (value: unknown) => outputs.push(value)]),
  );
}

test('境界固定応答はworkspace内の同一fixtureから指定対象へ到達し、操作結果と失敗を保持する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-boundary-response-'));
  try {
    const fixturePath = join(root, "boundary probe's.ts");
    const targetPath = join(root, "canary's file.txt");
    await copyFile(lightBoundaryFixture, fixturePath);
    expect(await readFile(fixturePath)).toEqual(await readFile(lightBoundaryFixture));
    for (const kind of ['read', 'shell-read', 'write'] as const) {
      await writeFile(targetPath, 'SYNTHETIC_PUBLIC_CONTROL\n');
      const step = nativeBoundaryResponses(process.execPath, fixturePath, kind, targetPath)[0];
      assert(step);
      const outputs: unknown[] = [];
      let calls = 0;
      await executeProbe(
        step.sse,
        [],
        {
          exec_command: ({ cmd }: { cmd: string }) => {
            calls++;
            const result = spawnSync('/bin/sh', ['-c', cmd], {
              cwd: root,
              encoding: 'utf8',
              timeout: 3000,
            });
            assert(!result.error && !result.signal, result.stderr);
            return { exit_code: result.status, output: result.stdout + result.stderr };
          },
        },
        outputs,
      );
      expect(calls).toBe(1);
      const observed = outputs[0];
      assert(isRecord(observed) && isRecord(observed.result));
      expect(observed.marker).toBe('PUBLIC_NATIVE_BOUNDARY_OBSERVATION');
      expect(observed.kind).toBe(kind);
      expect(observed.result.exit_code).toBe(0);
      assert(typeof observed.result.output === 'string');
      const result: unknown = JSON.parse(observed.result.output);
      assert(isRecord(result) && isRecord(result.observation));
      expect(result).toMatchObject({ kind, status: 'completed' });
      if (kind === 'write') {
        expect(await readFile(targetPath, 'utf8')).toBe('SYNTHETIC_BOUNDARY_WRITE\n');
      } else {
        expect(result.observation.sha256).toBe(
          Bun.SHA256.hash('SYNTHETIC_PUBLIC_CONTROL\n', 'hex'),
        );
      }
    }
    // 拒否・未存在・未完了を固定応答側で成功へ変換しない。
    const step = nativeBoundaryResponses(process.execPath, fixturePath, 'read', targetPath)[0];
    assert(step);
    for (const code of ['EACCES', 'ENOENT']) {
      const outputs: unknown[] = [];
      const pending = { session_id: 42, output: '' };
      const finished = {
        exit_code: 1,
        output: JSON.stringify({ kind: 'read', status: 'failed', code }),
      };
      await executeProbe(
        step.sse,
        [],
        {
          exec_command: () => pending,
          write_stdin: (args: unknown) => {
            expect(args).toMatchObject({ session_id: 42 });
            return finished;
          },
        },
        outputs,
      );
      expect(outputs).toEqual([
        { marker: 'PUBLIC_NATIVE_BOUNDARY_OBSERVATION', kind: 'read', result: pending },
        { marker: 'PUBLIC_NATIVE_BOUNDARY_OBSERVATION', kind: 'read', result: finished },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('実行時一覧は遅延ツールも原名で記録し、未取得を空一覧へ変換しない', async () => {
  const step = nativeToolInventoryResponses()[0];
  assert(step);
  const inventory = [
    { name: 'exec_command', description: '公開コマンド' },
    { name: 'deferred_read', description: '遅延公開の合成読取りツール' },
  ];
  const outputs: unknown[] = [];
  await executeProbe(step.sse, inventory, {}, outputs);
  expect(outputs).toEqual([{ marker: 'PUBLIC_NATIVE_TOOL_INVENTORY', tools: inventory }]);
  await assert.rejects(executeProbe(step.sse, undefined, {}, outputs), /inventory unavailable/);
  expect(outputs).toHaveLength(1);
});

test('読取り固定応答は指定された実ツールへ接続し、許可と拒否を裁定せず記録する', async () => {
  // tool名・schemaはホストで決定する。この合成対照はSSEの接続だけを保証する。
  const inventory = [{ name: 'synthetic_read', description: '合成読取り' }];
  const calls: unknown[] = [];
  for (const denied of [false, true]) {
    const args = { path: denied ? '/synthetic/dummy-auth' : '/synthetic/public-input' };
    const step = nativeReadToolResponses('synthetic_read', args)[0];
    assert(step);
    const outputs: unknown[] = [];
    await executeProbe(
      step.sse,
      inventory,
      {
        synthetic_read: (received: unknown) => {
          calls.push(received);
          if (denied) {
            throw new Error('EACCES: synthetic permission denied');
          }
          return { text: '公開された合成対照' };
        },
      },
      outputs,
    );
    expect(calls.at(-1)).toEqual(args);
    expect(outputs).toEqual([
      denied
        ? {
            marker: 'PUBLIC_NATIVE_READ_TOOL_OBSERVATION',
            name: 'synthetic_read',
            error: 'Error: EACCES: synthetic permission denied',
          }
        : {
            marker: 'PUBLIC_NATIVE_READ_TOOL_OBSERVATION',
            name: 'synthetic_read',
            result: { text: '公開された合成対照' },
          },
    ]);
  }
  expect(calls).toHaveLength(2);
});

test('読取りツールが未公開なら代替コマンドを起動せず失敗する', async () => {
  const step = nativeReadToolResponses('synthetic_read', { path: '/synthetic/public-input' })[0];
  assert(step);
  let calls = 0;
  const read = () => {
    calls++;
  };
  for (const [inventory, tools] of [
    [[], { synthetic_read: read, exec_command: read }],
    [[{ name: 'synthetic_read', description: '' }], { exec_command: read }],
  ] as const) {
    const outputs: unknown[] = [];
    await assert.rejects(
      executeProbe(step.sse, inventory, tools, outputs),
      /read tool unavailable/,
    );
    expect(outputs).toEqual([]);
  }
  expect(calls).toBe(0);
});

for (const item of nativeFixedResponses(process.execPath, Bun.version)) {
  test(`ネイティブ固定応答のJavaScriptと操作をモデルなしで照合する: ${item.id}`, async () => {
    // SSEを解析した後の実際のJSを検査する。二重escapeによる未実行を成功としない。
    const prototype: unknown = Object.getPrototypeOf(async () => {});
    assert(isRecord(prototype) && typeof prototype.constructor === 'function');
    const execute: unknown = Reflect.construct(prototype.constructor, [
      'tools',
      'text',
      toolInput(item.steps[0]?.sse ?? ''),
    ]);
    assert(typeof execute === 'function');
    if (['timeout', 'interrupt'].includes(item.id)) {
      // 親子停止はlight-native.test.tsで別途実処理を観測する。
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'native-fixed-response-'));
    try {
      await writeFile(join(root, 'public-input.txt'), item.files['public-input.txt']);
      const outputs: unknown[] = [];
      await Reflect.apply(execute, undefined, [
        {
          exec_command: ({ cmd }: { cmd: string }) => {
            const result = spawnSync('/bin/sh', ['-c', cmd], {
              cwd: root,
              encoding: 'utf8',
              timeout: 3000,
              env: { PATH: '/usr/bin:/bin' },
            });
            assert(!result.error && !result.signal, result.stderr);
            return { exit_code: result.status, output: result.stdout + result.stderr };
          },
        },
        (value: unknown) => outputs.push(value),
      ]);
      expect(outputs).toHaveLength(1);
      const result = outputs[0];
      assert(isRecord(result) && typeof result.output === 'string');
      expect(result.exit_code).toBe(item.id === 'command-failure' ? 23 : 0);
      const runtime: unknown = JSON.parse(await readFile(join(root, item.runtimeArtifact), 'utf8'));
      assert(isRecord(runtime));
      expect(runtime.parent).toEqual(runtime.child);
      if (item.id !== 'command-failure') {
        expect(await readFile(join(root, item.artifact), 'utf8')).toBe(item.artifactText);
      }
      expect(result.output.includes(item.marker)).toBe(['scoping', 'initial'].includes(item.id));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('固定入力のSSEは実ファイルのhashを観測し、初回担当の応答契約へ接続できる', async () => {
  const root = await mkdtemp(join(tmpdir(), "native-fixed-input's-"));
  try {
    const path = join(root, 'SKILL.md');
    const body = '公開された固定skill本文\n';
    await writeFile(path, body);
    const sha256 = Bun.SHA256.hash(body, 'hex');
    const steps = nativeFixedInputResponses(
      process.execPath,
      [{ path, sha256 }],
      '公開AGENTS',
      [path],
      true,
    );
    const first = steps[0],
      last = steps[1];
    assert(first && last);
    const outputs: unknown[] = [];
    await executeProbe(
      first.sse,
      [],
      {
        exec_command: ({ cmd }: { cmd: string }) => {
          const result = spawnSync('/bin/sh', ['-c', cmd], {
            cwd: root,
            encoding: 'utf8',
            timeout: 3000,
          });
          assert(!result.error && !result.signal, result.stderr);
          return { exit_code: result.status, output: result.stdout + result.stderr };
        },
      },
      outputs,
    );
    const observed = outputs[0];
    assert(isRecord(observed) && typeof observed.output === 'string');
    expect(observed.exit_code).toBe(0);
    expect(JSON.parse(observed.output)).toEqual({
      marker: 'PUBLIC_FIXED_INPUT_HASHES',
      files: [{ path, sha256 }],
    });
    const output = observed.output;
    expect(last.requestIncludes.every((value) => output.includes(value))).toBe(true);
    const completed = last.sse
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as unknown)
      .find((event) => isRecord(event) && event.type === 'response.completed');
    assert(isRecord(completed) && isRecord(completed.response));
    // JSONLの自己申告を受入証拠とはせず、固定fixtureのschema接続だけを調べる。
    expect(JSON.stringify(completed.response.output)).toContain('repaired');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
