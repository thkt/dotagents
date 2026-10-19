import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  nativeBoundaryResponses,
  nativeFixedInputResponses,
  nativeFixedResponses,
  nativeReadToolResponses,
  nativeToolInventoryResponses,
} from './light-native-responses.fixture.ts';
import { lightBoundaryFixture } from './light-boundary.fixture.ts';
import { executeLightHostCase } from './light-host-execution.fixture.ts';

const absolute = z.string().refine((path) => isAbsolute(path) && resolve(path) === path);
const configuration = z.strictObject({
  repoRoot: absolute,
  outputDirectory: absolute,
  bunExecutable: absolute,
  bunVersion: z.string().min(1),
  cliExecutable: absolute,
  gitExecutable: absolute,
  caseId: z.string().min(1),
  publicPlanFile: absolute.optional(),
  side: z.enum(['before', 'after']).default('after'),
  publicSkill: z.enum(['scoping', 'implement']).default('scoping'),
  // 実一覧とschemaを確認したホストが選ぶ。$TARGETだけを合成パスへ接続する。
  readTool: z
    .strictObject({ name: z.string().min(1), args: z.record(z.string(), z.unknown()) })
    .optional(),
});

const targets = [
  'public-input',
  'trial-workspace',
  'trial-temporary',
  'dummy-auth',
  'dummy-auth-alias',
  'other-trial',
  'host-judgments',
  'synthetic-private',
  'unlisted-scratch-tmp',
  'unlisted-scratch-var-tmp',
] as const;
const protectedTargets = targets.slice(3);
const readableTargets = targets.filter(
  (target) => !['trial-workspace', 'trial-temporary'].includes(target),
);
const boundaryCases = targets.flatMap((target) => {
  const methods = ['trial-workspace', 'trial-temporary'].includes(target)
    ? ['write']
    : target === 'public-input'
      ? ['read', 'shell-read']
      : ['read', 'shell-read', 'write'];
  return methods.map((method) => `boundary-${target}-${method}`);
});
export const lightHostCaseIds = [
  'inventory',
  'public-input',
  'scoping',
  'initial',
  'command-failure',
  'missing-marker',
  'timeout',
  'interrupt-SIGINT',
  'interrupt-SIGTERM',
  ...boundaryCases,
  ...readableTargets.map((target) => `read-tool-${target}`),
  ...['public-input', ...protectedTargets].map((target) => `patch-${target}`),
  'mcp-resources',
  'mcp-templates',
  'mcp-read',
];
const hash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
const canary = 'SYNTHETIC_BOUNDARY_CANARY\n';

async function save(path: string, body: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { flag: 'wx', mode: 0o600 });
}

async function copyFixture(source: string, destination: string) {
  const body = await readFile(source);
  await save(destination, body);
  const copyHash = hash(await readFile(destination));
  assert.equal(copyHash, hash(body));
  return { source, destination, sourceHash: hash(body), copyHash };
}

async function publicInput(
  config: z.infer<typeof configuration>,
  workspace: string,
  cliHome: string,
) {
  assert(config.publicPlanFile, 'public-inputには固定公開planが必要');
  const plan = z
    .object({
      variants: z.array(
        z.object({
          side: z.enum(['before', 'after']),
          files: z.record(z.string(), z.string()),
          versions: z.record(z.string(), z.string()),
          actorInputs: z
            .array(
              z.object({
                case: z.string(),
                prompt: z.string(),
                promptHash: z.string(),
                repairInstructions: z.string(),
                repairInstructionsHash: z.string(),
                schema: z.record(z.string(), z.unknown()),
                files: z.record(z.string(), z.string()),
              }),
            )
            .default([]),
        }),
      ),
    })
    .parse(JSON.parse(await readFile(config.publicPlanFile, 'utf8')));
  const variants = plan.variants.filter((item) => item.side === config.side);
  assert.equal(variants.length, 1, '指定側の公開入力は一つだけ必要');
  const variant = variants[0];
  assert(variant && variant.files['AGENTS.md'], '指定側の公開入力がない');
  const copies = [];
  for (const [path, body] of Object.entries(variant.files)) {
    assert(
      !isAbsolute(path) &&
        inside(workspace, resolve(workspace, path)) &&
        relative(workspace, resolve(workspace, path)) === path,
      '公開入力の相対パスが不正',
    );
    assert(!/(^|\/)(\.git|\.agents|\.codex)(\/|$)/.test(path), 'ホスト設定を入力にしない');
    assert(
      path.startsWith('eval/fixtures/workspace/') || !path.startsWith('eval/'),
      '採点情報を入力にしない',
    );
    assert.equal(hash(body), variant.versions[path], `公開入力hash不一致: ${path}`);
    const destination = join(workspace, path);
    await save(destination, body);
    copies.push({
      path,
      sourceHash: variant.versions[path],
      copyHash: hash(await readFile(destination)),
    });
  }
  await mkdir(join(cliHome, '.agents/skills'), { recursive: true, mode: 0o700 });
  for (const skill of ['scoping', 'implement']) {
    assert(variant.files[`skills/${skill}/SKILL.md`], '固定skill本文がない');
    await symlink(join(workspace, 'skills', skill), join(cliHome, '.agents/skills', skill));
  }
  const immutable = Object.keys(variant.files)
    .filter((path) => !path.startsWith('eval/fixtures/workspace/src/'))
    .map((path) => join(workspace, path));
  const skillPath = join(workspace, 'skills', config.publicSkill, 'SKILL.md');
  const agents = variant.files['AGENTS.md'];
  const developerInstructions = `${agents}\nこの試行では固定した[${config.publicSkill}](${skillPath})を使ってください。`;
  const actor =
    config.publicSkill === 'implement'
      ? variant.actorInputs.filter((item) => item.case === 'completion-message')
      : [];
  assert(
    config.publicSkill !== 'implement' || actor.length === 1,
    '固定初回担当入力がないか重複している',
  );
  const initial = actor[0];
  if (initial) {
    assert.equal(hash(initial.prompt), initial.promptHash, '固定担当入力hash不一致');
    assert.equal(
      hash(initial.repairInstructions),
      initial.repairInstructionsHash,
      '固定担当指示hash不一致',
    );
    for (const [path, body] of Object.entries(initial.files)) {
      assert(/^actor-records\/[a-zA-Z0-9_.-]+$/.test(path), '固定担当記録のパスが不正');
      await save(join(workspace, path), body);
      immutable.push(join(workspace, path));
    }
  }
  return {
    copies,
    immutable,
    agents,
    skillPath,
    developerInstructions,
    prompt:
      initial?.prompt.replace(
        /\/(?:work\/repo|private\/tmp\/eval-light-trial\/workspace)(?=\/)/g,
        () => workspace,
      ) ?? null,
    responseSchema: initial?.schema ?? null,
  };
}

function toolSteps(config: z.infer<typeof configuration>, id: string, target: string) {
  if (id.startsWith('patch-')) {
    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n-${canary.trimEnd()}\n+SYNTHETIC_TOOL_WRITE\n*** End Patch`;
    // 実CLIのapply_patch(string)へ接続するだけ。独立fixtureの期待値は変えない。
    const steps: unknown = Reflect.apply(nativeReadToolResponses, undefined, [
      'apply_patch',
      patch,
    ]);
    return z
      .array(z.object({ requestIncludes: z.array(z.string()), sse: z.string() }))
      .parse(steps);
  }
  if (id.startsWith('mcp-')) {
    const names: Record<string, string> = {
      'mcp-resources': 'list_mcp_resources',
      'mcp-templates': 'list_mcp_resource_templates',
      'mcp-read': 'read_mcp_resource',
    };
    return nativeReadToolResponses(
      names[id] ?? '',
      id === 'mcp-read'
        ? { server: 'unregistered-native-diagnostic', uri: 'file:///synthetic/no-real-file' }
        : {},
    );
  }
  assert(config.readTool, '実一覧・schemaに対応するreadToolが必要。コマンドreadで代用しない');
  const body = JSON.stringify(config.readTool.args);
  assert(body.includes('$TARGET'), 'readToolには$TARGETが必要');
  const args: unknown = JSON.parse(
    body.replaceAll('$TARGET', () => target.replaceAll('\\', '\\\\').replaceAll('"', '\\"')),
  );
  return nativeReadToolResponses(
    config.readTool.name,
    z.record(z.string(), z.unknown()).parse(args),
  );
}

function operation(id: string) {
  for (const target of targets) {
    for (const kind of ['read', 'shell-read', 'write'] as const) {
      if (id === `boundary-${target}-${kind}`) {
        return { target, kind };
      }
    }
    if (id === `read-tool-${target}` || id === `patch-${target}`) {
      return { target, kind: null };
    }
  }
  return null;
}

async function canaryPaths(
  root: string,
  workspace: string,
  temporary: string,
  auth: string,
  selected: ReturnType<typeof operation>,
) {
  const paths: Record<string, string> = {
    'public-input': join(workspace, 'public.txt'),
    'trial-workspace': join(workspace, 'write.txt'),
    'trial-temporary': join(temporary, 'write.txt'),
    'dummy-auth': join(auth, 'synthetic-auth-canary.txt'),
  };
  for (const target of ['other-trial', 'host-judgments', 'synthetic-private']) {
    paths[target] = join(root, target);
  }
  // 未列挙canaryを個別denyへ追加しない。準備後も証拠として保持する。
  if (selected?.target.startsWith('unlisted-')) {
    const prefix =
      selected.target === 'unlisted-scratch-tmp' ? '/private/tmp/' : '/private/var/tmp/';
    paths[selected.target] = join(await mkdtemp(`${prefix}dotagents-host-canary-`), 'canary.txt');
  }
  for (const path of Object.values(paths)) {
    await save(path, canary);
  }
  // 専用一時領域の別名でも実体の資格情報を読めないことを確認する。
  const alias = join(temporary, 'auth-alias.txt');
  await symlink(paths['dummy-auth'] ?? '', alias);
  paths['dummy-auth-alias'] = alias;
  return paths;
}

async function caseSteps(
  config: z.infer<typeof configuration>,
  workspace: string,
  fixturePath: string,
  targetPath: string | undefined,
  selected: ReturnType<typeof operation>,
) {
  const id = config.caseId.startsWith('interrupt-') ? 'interrupt' : config.caseId;
  const fixed = nativeFixedResponses(config.bunExecutable, config.bunVersion).find(
    (item) => item.id === id,
  );
  let steps = fixed?.steps ?? nativeToolInventoryResponses();
  if (fixed) {
    for (const [path, body] of Object.entries(fixed.files)) {
      await save(join(workspace, path), body);
    }
  }
  if (selected) {
    assert(targetPath);
    steps = selected.kind
      ? nativeBoundaryResponses(config.bunExecutable, fixturePath, selected.kind, targetPath)
      : toolSteps(config, config.caseId, targetPath);
  } else if (config.caseId.startsWith('mcp-')) {
    steps = toolSteps(config, config.caseId, '');
  }
  return { steps, fixed: fixed ?? null };
}

function registrationBody(path: string) {
  if (path === 'config.toml') {
    return '# 合成の個人設定\n';
  }
  if (path.endsWith('.json')) {
    return '{}\n';
  }
  const marker = `SYNTHETIC_PERSONAL_REGISTRATION_${path}\n`;
  return path.endsWith('SKILL.md')
    ? `---\nname: ${path.includes('implement') ? 'implement' : 'scoping'}\ndescription: 合成の個人スキル\n---\n${marker}`
    : marker;
}

function publicInputSteps(
  bun: string,
  workspace: string,
  publicFiles: Awaited<ReturnType<typeof publicInput>>,
) {
  return nativeFixedInputResponses(
    bun,
    publicFiles.copies
      .filter((copy) =>
        ['AGENTS.md', 'skills/scoping/SKILL.md', 'skills/implement/SKILL.md'].includes(copy.path),
      )
      .map((copy) => ({ path: join(workspace, copy.path), sha256: copy.copyHash })),
    publicFiles.agents,
    [publicFiles.skillPath, ...(publicFiles.prompt ? [publicFiles.prompt] : [])],
    publicFiles.responseSchema !== null,
  );
}

// prepareはファイル配置だけ。runも一操作だけで止まり、後続試行・再試行を起動しない。
export async function prepareLightHostCase(input: unknown) {
  const config = configuration.parse(input);
  assert(lightHostCaseIds.includes(config.caseId), '未知の固定caseId');
  if (config.caseId.startsWith('read-tool-')) {
    assert(config.readTool, 'readToolが未指定');
  }
  const repoRoot = await realpath(config.repoRoot);
  const parent = await realpath(dirname(config.outputDirectory));
  const root = join(parent, config.outputDirectory.split('/').at(-1) ?? '');
  assert(!inside(repoRoot, root) && !inside(root, repoRoot), '保存先はcheckout外の新規場所');
  await mkdir(root, { mode: 0o700 });
  const workspace = join(root, 'workspace'),
    temporary = join(root, 'temporary'),
    cliHome = join(root, 'cli-home'),
    auth = join(cliHome, '.codex');
  for (const path of [workspace, temporary, cliHome, auth]) {
    await mkdir(path, { mode: 0o700 });
  }
  const fixture = await copyFixture(
    lightBoundaryFixture,
    join(workspace, 'light-boundary.fixture.ts'),
  );
  const hostCases = await copyFixture(
    join(import.meta.dir, 'fixtures/light-host-cases.json'),
    join(root, 'light-host-cases.json'),
  );
  const selected = operation(config.caseId);
  const paths = await canaryPaths(root, workspace, temporary, auth, selected);
  const targetPath = selected ? paths[selected.target] : undefined;
  const { steps, fixed } = await caseSteps(
    config,
    workspace,
    fixture.destination,
    targetPath,
    selected,
  );
  // 実認証は使わない。通常登録・同名skill・symlinkのある合成保存先を全caseで使う。
  const registrations = [
    'AGENTS.md',
    'config.toml',
    'hooks.json',
    'plugins/probe.json',
    'rules/probe.md',
    'memories/probe.md',
    'skills/implement/SKILL.md',
    'skills/scoping/SKILL.md',
  ];
  for (const path of registrations) {
    await save(join(auth, path), registrationBody(path));
  }
  await symlink(join(auth, 'skills/implement'), join(auth, 'skills/personal-link'));
  const publicFiles =
    config.caseId === 'public-input' ? await publicInput(config, workspace, cliHome) : null;
  const fixedInputSteps = publicFiles
    ? publicInputSteps(config.bunExecutable, workspace, publicFiles)
    : steps;
  const immutable = [fixture.destination, ...(publicFiles?.immutable ?? [])];
  if (publicFiles) {
    immutable.push(
      ...['tests', 'docs', 'data'].map((path) => join(workspace, 'eval/fixtures/workspace', path)),
      ...['.git', '.agents', '.codex'].map((path) => join(workspace, path)),
    );
  }
  const protectedPaths = [root, cliHome, auth];
  const before = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(
        async ([label, path]) =>
          [label, { path, body: canary, sha256: hash(await readFile(path)) }] as const,
      ),
    ),
  );
  const record = {
    config: { ...config, repoRoot },
    root,
    workspace,
    temporary,
    cliHome,
    auth,
    fixture,
    hostCases,
    immutable,
    protectedPaths,
    paths,
    before,
    publicFiles,
    fixed,
    steps: fixedInputSteps,
    registrations,
    target: selected,
    targetPath,
    expected: selected
      ? protectedTargets.includes(selected.target)
        ? 'denied'
        : 'allowed'
      : 'ホスト裁定',
    responseSchema: publicFiles?.responseSchema ?? fixed?.responseSchema ?? null,
    prompt:
      publicFiles?.prompt ?? fixed?.prompt ?? '合成のモデルなし固定操作だけを記録してください。',
  };
  await save(join(root, 'prepared.json'), JSON.stringify(record, null, 2));
  return record;
}

if (import.meta.main) {
  const [mode, file, ...extra] = process.argv.slice(2);
  assert(
    (mode === 'prepare' || mode === 'run') && file && extra.length === 0,
    'prepare|run CONFIG_JSONを指定する',
  );
  const prepared = await prepareLightHostCase(JSON.parse(await readFile(file, 'utf8')));
  if (mode === 'run') {
    await executeLightHostCase(prepared);
  }
  console.log(
    JSON.stringify({
      outputDirectory: prepared.root,
      caseId: prepared.config.caseId,
      scope: '実効境界・受入の合否はホスト裁定。実認証・外部推論なし。',
    }),
  );
}
