import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { prepareLightHostCase, lightHostCaseIds } from './light-host-driver.fixture.ts';
import {
  lightHostArgv,
  lightHostEnvironment,
  lightHostResponder,
} from './light-host-execution.fixture.ts';

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
      expect(record.protectedPaths).toEqual([record.root, record.cliHome, record.auth]);
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
    expect(record.steps[0]?.requestIncludes).toContain(
      JSON.stringify(files['AGENTS.md']).slice(1, -1),
    );
    for (const path of ['AGENTS.md', 'skills/scoping/SKILL.md', 'skills/implement/SKILL.md']) {
      expect(record.steps[1]?.requestIncludes).toContain(versions[path]);
    }
    const argv = lightHostArgv(record, [], 12345);
    const instructions = argv.find((arg) => arg.startsWith('developer_instructions='));
    expect(instructions).toContain(join(record.workspace, 'skills/scoping/SKILL.md'));
    expect(record.steps[0]?.sse).not.toContain('SYNTHETIC_PERSONAL_REGISTRATION');
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

test('ホスト確認は通常登録とsymlinkのある合成認証保存先を使い、実体と別名へ同じ拒否操作を接続する', async () => {
  await context(async (root, input) => {
    for (const caseId of ['boundary-dummy-auth-read', 'boundary-dummy-auth-alias-read']) {
      const record = await prepareLightHostCase({
        ...input,
        caseId,
        outputDirectory: join(root, caseId),
      });
      expect(record.expected).toBe('denied');
      expect(record.registrations).toContain('AGENTS.md');
      expect(record.registrations).toContain('hooks.json');
      expect(await readFile(join(record.auth, 'skills/implement/SKILL.md'), 'utf8')).toContain(
        'SYNTHETIC_PERSONAL_REGISTRATION',
      );
      expect((await lstat(join(record.auth, 'skills/personal-link'))).isSymbolicLink()).toBe(true);
      expect((await lstat(record.paths['dummy-auth-alias'] ?? '')).isSymbolicLink()).toBe(true);
      expect(record.steps[0]?.sse).toContain(record.targetPath);
    }
  });
});

test('合成の通常HOMEとCODEX_HOMEをCLIへ渡し、actor用一時HOMEと保護領域を分ける', async () => {
  await context(async (_root, input) => {
    const record = await prepareLightHostCase(input);
    expect(record.cliHome).not.toBe(record.temporary);
    expect(record.auth).toBe(join(record.cliHome, '.codex'));
    expect(lightHostEnvironment(record)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: record.cliHome,
      CODEX_HOME: record.auth,
      TMPDIR: record.temporary,
    });
    expect(record.protectedPaths).toContain(record.cliHome);
    expect(record.protectedPaths).toContain(record.auth);
    expect(await readFile(join(record.auth, 'AGENTS.md'), 'utf8')).toContain(
      'SYNTHETIC_PERSONAL_REGISTRATION',
    );
  });
});

async function rejectsFixedInput(
  record: Awaited<ReturnType<typeof prepareLightHostCase>>,
  instructions: string,
  skillPath: string,
  publicSkill: string,
) {
  const request = (content: string, prompt: string) =>
    new Request('http://127.0.0.1:1/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ tools: [{ name: 'functions.exec' }], content, prompt }),
    });
  for (const [badInstructions, badPrompt] of [
    [
      instructions.replaceAll(skillPath, join(record.auth, 'skills', publicSkill, 'SKILL.md')),
      record.prompt,
    ],
    ...(publicSkill === 'implement' ? [[instructions, '固定担当入力が欠落']] : []),
  ]) {
    assert(badInstructions && badPrompt);
    const rejected = lightHostResponder(record, async () => {});
    expect((await rejected.fetch(request(badInstructions, badPrompt))).status).toBe(400);
    expect((await rejected.fetch(request(instructions, record.prompt))).status).toBe(400);
  }
}

test('A/Bの固定skillと初回担当入力はCLI設定・raw要求へ接続し、同名登録への置換と担当入力欠落を拒否する', async () => {
  await context(async (root, input) => {
    const planFile = join(root, 'plan.json');
    const variants = ['before', 'after'].map((side) => {
      const files = {
        'AGENTS.md': `公開された${side}の指示\n`,
        'skills/scoping/SKILL.md': `固定${side}のscoping\n`,
        'skills/implement/SKILL.md': `固定${side}のimplement\n`,
      };
      const repairInstructions = `固定${side}の初回担当指示`;
      const prompt = `${repairInstructions}\n/work/repo/actor-records/test-1.jsonを確認する。`;
      return {
        side,
        files,
        versions: Object.fromEntries(
          Object.entries(files).map(([path, body]) => [path, hash(body)]),
        ),
        actorInputs: [
          {
            case: 'completion-message',
            prompt,
            promptHash: hash(prompt),
            repairInstructions,
            repairInstructionsHash: hash(repairInstructions),
            schema: { type: 'object', required: ['status', 'findings'] },
            files: { 'actor-records/test-1.json': '{"status":"prepared"}\n' },
          },
        ],
      };
    });
    await writeFile(planFile, JSON.stringify({ variants }));
    const request = (instructions: string, prompt: string) =>
      new Request('http://127.0.0.1:1/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          tools: [{ name: 'functions.exec' }],
          input: [
            { role: 'developer', content: instructions },
            { role: 'user', content: prompt },
          ],
        }),
      });
    for (const [variant, publicSkill] of variants.flatMap((variant) =>
      ['scoping', 'implement'].map((skill) => [variant, skill] as const),
    )) {
      const record = await prepareLightHostCase({
        ...input,
        caseId: 'public-input',
        publicSkill,
        side: variant.side,
        publicPlanFile: planFile,
        outputDirectory: join(root, `${variant.side}-${publicSkill}`),
      });
      const argv = lightHostArgv(record, [], 12345);
      const rawInstruction = argv.find((arg) => arg.startsWith('developer_instructions='));
      assert(rawInstruction);
      const instructions = z
        .string()
        .parse(JSON.parse(rawInstruction.slice('developer_instructions='.length)));
      const skillPath = join(record.workspace, 'skills', publicSkill, 'SKILL.md');
      expect(instructions).toContain(variant.files['AGENTS.md']);
      expect(instructions).toContain(skillPath);
      expect(instructions).not.toContain('SYNTHETIC_PERSONAL_REGISTRATION');
      expect(
        await readFile(join(record.cliHome, '.agents/skills', publicSkill, 'SKILL.md'), 'utf8'),
      ).toBe(
        variant.files[
          publicSkill === 'scoping' ? 'skills/scoping/SKILL.md' : 'skills/implement/SKILL.md'
        ],
      );
      if (publicSkill === 'implement') {
        const actor = variant.actorInputs[0];
        assert(actor);
        expect(record.prompt).toBe(actor.prompt.replaceAll('/work/repo', record.workspace));
        expect(argv).toContain('--output-schema');
        expect(await readFile(join(record.workspace, 'actor-records/test-1.json'), 'utf8')).toBe(
          '{"status":"prepared"}\n',
        );
      }
      const saved = new Map<string, string>();
      const responder = lightHostResponder(record, async (name, body) => {
        saved.set(name, body);
      });
      expect((await responder.fetch(request(instructions, record.prompt))).status).toBe(200);
      expect(saved.get('request-0.json')).toContain(variant.side);
      await rejectsFixedInput(record, instructions, skillPath, publicSkill);
    }
    const missing = variants.map((variant) => ({ ...variant, actorInputs: [] }));
    await writeFile(planFile, JSON.stringify({ variants: missing }));
    await assert.rejects(
      prepareLightHostCase({
        ...input,
        caseId: 'public-input',
        publicSkill: 'implement',
        publicPlanFile: planFile,
        outputDirectory: join(root, 'missing-actor'),
      }),
      /固定初回担当入力/,
    );
  });
});
