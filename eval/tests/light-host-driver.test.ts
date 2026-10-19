import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { prepareLightHostCase, lightHostCaseIds } from './light-host-driver.fixture.ts';
import { lightHostArgv, lightHostResponder } from './light-host-execution.fixture.ts';

const hash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
async function context(
  action: (root: string, input: ReturnType<typeof inputFor>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'light-host-driver-'));
  try {
    await action(root, inputFor(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function inputFor(root: string) {
  return {
    repoRoot: join(import.meta.dir, '../..'),
    outputDirectory: join(root, 'output'),
    bunExecutable: process.execPath,
    bunVersion: Bun.version,
    cliExecutable: join(root, 'forbidden-cli'),
    gitExecutable: '/usr/bin/git',
    caseId: 'inventory',
  };
}

test('driverは新規保存先だけへ配置し、fixtureの原文/hashと既存記録を保つ。prepareはCLI未存在でも起動しない', async () => {
  await context(async (root, input) => {
    const configFile = join(root, 'config.json');
    await writeFile(configFile, JSON.stringify(input));
    const invoke = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [join(import.meta.dir, 'light-host-driver.fixture.ts'), ...args],
        { encoding: 'utf8', timeout: 5000 },
      );
    const good = invoke('prepare', configFile);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const raw = await readFile(join(input.outputDirectory, 'prepared.json'));
    const copy = z.object({
      source: z.string(),
      destination: z.string(),
      sourceHash: z.string(),
      copyHash: z.string(),
    });
    const record = z.object({ fixture: copy, hostCases: copy }).parse(JSON.parse(raw.toString()));
    for (const item of [record.fixture, record.hostCases]) {
      const original = await readFile(item.source);
      const copied = await readFile(item.destination);
      expect(copied).toEqual(original);
      expect(item.sourceHash).toBe(hash(original));
      expect(item.copyHash).toBe(hash(copied));
    }
    expect(invoke('prepare', configFile).status).not.toBe(0);
    expect(await readFile(join(input.outputDirectory, 'prepared.json'))).toEqual(raw);
    expect(invoke('prepare', configFile, 'extra').status).not.toBe(0);
    expect(invoke('unknown', configFile).status).not.toBe(0);
  });
});

test('不正接続は保存・CLI起動より前に拒否する。同じ設定の正常対照は生成できる', async () => {
  await context(async (root, input) => {
    for (const changes of [
      { cliExecutable: 'codex' },
      { bunExecutable: 'bun' },
      { gitExecutable: 'git' },
      { repoRoot: 'relative' },
      { outputDirectory: 'relative' },
      { caseId: 'unknown' },
      { caseId: 'read-tool-public-input' },
      { endpoint: 'https://external.invalid' },
      { sandbox: 'danger-full-access' },
      { authentication: 'real' },
    ]) {
      await assert.rejects(prepareLightHostCase({ ...input, ...changes }));
    }
    expect(await readdir(root)).toEqual([]);
    await prepareLightHostCase(input);
    await assert.rejects(
      prepareLightHostCase({ ...input, outputDirectory: join(input.repoRoot, 'forbidden-output') }),
      /checkout外/,
    );
  });
});

test('host-casesの正常・保護・未列挙canaryを同じ操作へ接続する。networkは既存経路へ維持する', async () => {
  const manifest = z
    .object({ operations: z.array(z.object({ target: z.string(), methods: z.array(z.string()) })) })
    .parse(
      JSON.parse(await readFile(join(import.meta.dir, 'fixtures/light-host-cases.json'), 'utf8')),
    );
  for (const item of manifest.operations) {
    for (const method of item.methods) {
      if (method === 'network') {
        continue;
      }
      expect(lightHostCaseIds).toContain(
        method === 'read-tool' ? `read-tool-${item.target}` : `boundary-${item.target}-${method}`,
      );
    }
  }
  expect(lightHostCaseIds.some((id) => id.includes('network'))).toBe(false);
  await context(async (root, input) => {
    for (const [caseId, expected] of [
      ['boundary-public-input-read', 'allowed'],
      ['boundary-dummy-auth-shell-read', 'denied'],
      ['boundary-trial-temporary-write', 'allowed'],
      ['patch-synthetic-private', 'denied'],
    ] as const) {
      const record = await prepareLightHostCase({
        ...input,
        caseId,
        outputDirectory: join(root, caseId),
      });
      expect(record.expected).toBe(expected);
      assert(record.targetPath);
      expect(await readFile(record.targetPath, 'utf8')).toBe('SYNTHETIC_BOUNDARY_CANARY\n');
      expect(record.steps[0]?.sse).toContain(record.targetPath);
      expect(record.protectedPaths).toEqual([record.root, record.auth]);
    }
    expect(lightHostCaseIds).toContain('interrupt-SIGINT');
    expect(lightHostCaseIds).toContain('interrupt-SIGTERM');
  });
});

test('固定公開planの配置は本文/hashを保存し、偽hash・脱出パス・採点情報を受け付けない', async () => {
  await context(async (root, input) => {
    const planFile = join(root, 'public-plan.json');
    const files = {
      'AGENTS.md': '公開指示\n',
      'skills/scoping/SKILL.md': '公開scoping\n',
      'skills/implement/SKILL.md': '公開implement\n',
      'eval/fixtures/workspace/src/public.ts': '公開課題\n',
    };
    const versions = Object.fromEntries(
      Object.entries(files).map(([path, body]) => [path, hash(body)]),
    );
    const writePlan = (bodies: Record<string, string>, hashes = versions) =>
      writeFile(
        planFile,
        JSON.stringify({ variants: [{ side: 'after', files: bodies, versions: hashes }] }),
      );
    await writePlan(files);
    const config = { ...input, caseId: 'public-input', publicPlanFile: planFile };
    const record = await prepareLightHostCase(config);
    for (const [path, body] of Object.entries(files)) {
      expect(await readFile(join(record.workspace, path), 'utf8')).toBe(body);
    }
    expect(record.publicFiles?.copies.every((copy) => copy.sourceHash === copy.copyHash)).toBe(
      true,
    );
    for (const [index, path] of [
      '../escaped',
      'eval/corpus/cases.json',
      '.codex/config.toml',
    ].entries()) {
      await writePlan(
        { ...files, [path]: '合成不正入力' },
        { ...versions, [path]: hash('合成不正入力') },
      );
      await assert.rejects(
        prepareLightHostCase({ ...config, outputDirectory: join(root, `bad-path-${index}`) }),
      );
    }
    await writePlan(files, { ...versions, 'AGENTS.md': hash('異なる本文') });
    await assert.rejects(
      prepareLightHostCase({ ...config, outputDirectory: join(root, 'bad-hash') }),
      /hash不一致/,
    );
  });
});

test('実一覧から選んだ読取り工具の引数へ生成canaryだけを接続し、保護対象の期待値を維持する', async () => {
  await context(async (root, input) => {
    for (const target of ['public-input', 'dummy-auth']) {
      const record = await prepareLightHostCase({
        ...input,
        caseId: `read-tool-${target}`,
        outputDirectory: join(root, `${target}'s $& directory`),
        readTool: { name: 'synthetic_actual_read', args: { file_path: '$TARGET' } },
      });
      assert(record.targetPath);
      expect(record.steps[0]?.sse).toContain(record.targetPath);
      expect(record.steps[0]?.sse).toContain('synthetic_actual_read');
      expect(record.steps[0]?.sse).not.toContain('$TARGET');
      expect(record.expected).toBe(target === 'public-input' ? 'allowed' : 'denied');
    }
  });
});

test('CLI接続先は固定loopbackのみで、schemaと採用profileを渡す。実認証・旧sandbox・外部providerの入口を作らない', async () => {
  await context(async (_root, input) => {
    const record = await prepareLightHostCase({ ...input, caseId: 'initial' });
    const argv = lightHostArgv(record, ['-c', 'SYNTHETIC_PROFILE'], 12345);
    expect(argv[0]).toBe(input.cliExecutable);
    expect(argv).toContain('--output-schema');
    expect(argv).toContain(join(record.root, 'schema.json'));
    expect(argv).toContain('SYNTHETIC_PROFILE');
    expect(argv).toContain('--ignore-user-config');
    expect(argv.join(' ')).toContain('http://127.0.0.1:12345/v1');
    expect(argv.join(' ')).toContain('requires_openai_auth=false');
    expect(argv.join(' ')).not.toContain('--sandbox');
    expect(() => lightHostArgv(record, [], 0)).toThrow();
  });
});

test('固定SSEは実request本文と応答を保存し、不一致・保存失敗後を再試行成功へ変えない（listenerなし）', async () => {
  await context(async (_root, input) => {
    const record = await prepareLightHostCase(input);
    const saved = new Map<string, string>();
    const responder = lightHostResponder(record, async (name, body) => {
      saved.set(name, body);
    });
    const request = (body: string) =>
      new Request('http://127.0.0.1:1/v1/responses', { method: 'POST', body });
    const response = await responder.fetch(request('functions exec'));
    const first = record.steps[0];
    assert(first);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(first.sse);
    expect(saved.get('request-0.json')).toBe('functions exec');
    expect(saved.get('response-0.sse')).toBe(first.sse);
    expect((await responder.fetch(request('不一致'))).status).toBe(400);
    expect((await responder.fetch(request('PUBLIC_NATIVE_TOOL_INVENTORY'))).status).toBe(400);
    expect(responder.observations().failed).toBe(true);
    const failed = lightHostResponder(record, async () => {
      throw new Error('SYNTHETIC_SAVE_FAILURE');
    });
    expect((await failed.fetch(request('functions exec'))).status).toBe(400);
    expect(JSON.stringify(failed.observations())).toContain('SYNTHETIC_SAVE_FAILURE');
  });
});
