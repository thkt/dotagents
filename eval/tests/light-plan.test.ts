import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { isRecord } from '../../scripts/shared/values.ts';
import { instructionFiles, lightInputRepository } from './trusted-inputs.ts';
import { lightCliFixture } from './light-cli.fixture.ts';

// Issueの段階・順序が正本。入口とJSONキーは独立テストの接続上の選択であり、
// 内部exportの公開契約や、実アカウントでの推論許可を追加するものではない。
const pinned = '0c7316253a9768844eb1c224961e00be52dcdcf2';
const orders = [
  [
    'before-storage-fields',
    'after-storage-fields',
    'after-completion-message',
    'before-completion-message',
  ],
  [
    'before-retry-limit',
    'after-retry-limit',
    'after-guide-link',
    'before-guide-link',
    'before-work-area',
    'after-work-area',
    'after-cli-description',
    'before-cli-description',
    'before-history-record',
    'after-history-record',
    'after-save-diagnostics',
    'before-save-diagnostics',
  ],
];
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const repository = resolve(import.meta.dir, '../..');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(
  stage: 1 | 2,
  action: (context: {
    repo: string;
    config: Record<string, unknown>;
    invoke: (mode: string, changes?: Record<string, unknown>) => Promise<SpawnSyncReturns<string>>;
    starts: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'eval-light-plan-'));
  try {
    const repo = join(root, 'repo');
    await lightInputRepository(repo);
    const bin = join(root, 'bin');
    const home = join(root, 'dummy-codex-home');
    const starts = join(root, 'forbidden-starts');
    await mkdir(bin);
    await mkdir(home);
    // 版・認証種別の確認と推論を区別して観測する。実CLIへ委譲しない。
    const control = join(root, 'control.json');
    await writeFile(
      control,
      JSON.stringify({ auth: 'chatgpt', scenario: 'normal', events: starts }),
    );
    await writeFile(
      join(bin, 'codex'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(lightCliFixture)} ${quote(control)} "$@"\n`,
      { mode: 0o755 },
    );
    await writeFile(join(bin, 'docker'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
    const trialOrder = orders[stage - 1];
    assert(trialOrder);
    const config: Record<string, unknown> = {
      repository: 'thkt/dotagents',
      issue: 'https://github.com/thkt/dotagents/issues/405',
      authentication: 'chatgpt',
      stage,
      before: 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092',
      after: '6181233d17a29c711a84f20549f78507c5c3e5fb',
      corpusCommit: pinned,
      workspaceCommit: pinned,
      workspaceFiles: git(
        repo,
        'ls-tree',
        '-r',
        '--name-only',
        pinned,
        '--',
        'eval/fixtures/workspace',
      ).split('\n'),
      instructionFiles,
      cases: [...new Set(trialOrder.map((trial) => trial.replace(/^(before|after)-/, '')))],
      trialOrder,
      maxTrials: trialOrder.length,
      model: 'gpt-6.1-sol',
      reasoning: 'medium',
      cliVersion: 'codex-cli 0.163.0',
      bunVersion: '1.4.3',
      gitVersion: git(repo, '--version'),
      permissionProfile: 'eval-light',
      caseTimeMs: 600000,
      totalTimeMs: stage === 1 ? 2400000 : 7200000,
      outputDirectory: join(root, 'new-run'),
      disclosure: {
        inputs: 'reviewed-public-committed-files-only',
        raw: 'local-only',
        summary: 'manual-issue-or-pr',
      },
    };
    const invoke = async (mode: string, changes: Record<string, unknown> = {}) => {
      const file = join(root, 'config.json');
      await writeFile(file, JSON.stringify({ ...config, ...changes }));
      return spawnSync(process.execPath, [join(repository, 'eval/light.ts'), mode, file], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, CODEX_HOME: home },
      });
    };
    await action({ repo, config, invoke, starts });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function successfulPlan(result: SpawnSyncReturns<string>) {
  assert(!result.error && !result.signal, '計画のプロセスが完了していない');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value: unknown = JSON.parse(result.stdout);
  assert(isRecord(value) && isRecord(value.config) && Array.isArray(value.variants));
  return { ...value, config: value.config, variants: value.variants };
}

async function noInference(path: string) {
  const raw = await readFile(path, 'utf8').catch((cause: unknown) => {
    assert(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT');
    return '';
  });
  for (const line of raw.split('\n').filter(Boolean)) {
    const value: unknown = JSON.parse(line);
    assert(isRecord(value) && Array.isArray(value.args));
    const args: unknown[] = value.args;
    expect(args.some((arg) => ['exec', 'resume', 'logout'].includes(String(arg)))).toBe(false);
    const login = args.indexOf('login');
    if (login >= 0) {
      expect(args[login + 1]).toBe('status');
    }
  }
}

function verifyVariant(repo: string, config: Record<string, unknown>, variant: unknown) {
  assert(isRecord(variant) && isRecord(variant.files) && isRecord(variant.versions));
  const absent = [
    'skills/references/mechanization.md',
    'skills/references/premise-validation.md',
    'skills/references/caller-first-design.md',
  ];
  assert(Array.isArray(config.workspaceFiles) && Array.isArray(config.instructionFiles));
  const workspaceFiles = config.workspaceFiles.map((path: unknown) => {
    assert(typeof path === 'string');
    return path;
  });
  const instructionPaths = config.instructionFiles.map((path: unknown) => {
    assert(typeof path === 'string');
    return path;
  });
  const expectedFiles = [...workspaceFiles, ...instructionPaths].filter(
    (path) => variant.side !== 'before' || !absent.includes(path),
  );
  expect(Object.keys(variant.files).sort()).toEqual(expectedFiles.sort());
  const commit = variant.side === 'before' ? config.before : config.after;
  for (const [path, body] of Object.entries(variant.files)) {
    assert(typeof body === 'string');
    const version = path.startsWith('eval/fixtures/workspace/') ? pinned : String(commit);
    const original = spawnSync('git', ['show', `${version}:${path}`], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(original.status, 0, original.stderr);
    expect(body).toBe(original.stdout);
    expect(variant.versions[path]).toBe(hash(original.stdout));
  }
  expect(Object.hasOwn(variant.files, 'eval/fixtures/workspace/README.md')).toBe(true);
  for (const path of absent) {
    expect(Object.hasOwn(variant.files, path)).toBe(variant.side === 'after');
  }
}

for (const stage of [1, 2] as const) {
  test(`軽量planの第${stage}段階は固定順序・有限上限・両側の公開blobを示し推論を起動しない`, async () => {
    await fixture(stage, async ({ repo, config, invoke, starts }) => {
      const plan = successfulPlan(await invoke('plan'));
      expect(plan.config).toMatchObject(config);
      expect(plan.variants).toHaveLength(2);
      expect(plan.variants.map((variant) => (isRecord(variant) ? variant.side : null))).toEqual([
        'before',
        'after',
      ]);
      for (const variant of plan.variants) {
        verifyVariant(repo, config, variant);
      }
      await noInference(starts);
      expect(JSON.stringify(plan)).not.toContain('containersRemoved');
      expect(JSON.stringify(plan)).not.toContain('danger-full-access');
    });
  });
}

const invalidPlans: [string, Record<string, unknown>][] = [
  ['片側だけ', { trialOrder: ['before-storage-fields', 'before-completion-message'] }],
  ['重複', { trialOrder: Array(4).fill('before-storage-fields') }],
  ['順序の入替え', { trialOrder: [...(orders[0] ?? [])].reverse() }],
  ['余分な課題', { cases: ['storage-fields', 'completion-message', 'retry-limit'] }],
  ['第2段階の再実行混入', { stage: 2 }],
  ['試行上限超過', { maxTrials: 5 }],
  ['試行時間超過', { caseTimeMs: 600001 }],
  ['全体時間超過', { totalTimeMs: 2400001 }],
  ['API認証の選択', { authentication: 'api' }],
  ['旧sandboxとの混在', { sandbox: 'workspace-write' }],
  ['ホスト全体の許可', { additionalReadPaths: ['/'] }],
  ['不要なモデル経路', { webSearch: true }],
  ['追加agentの起動経路', { multiAgent: true }],
  ['MCP接続の持込み', { mcpServers: { private: { command: 'synthetic-private-tool' } } }],
  ['hookの持込み', { hooks: ['synthetic-hook'] }],
  ['sandbox無効化による回避', { permissionProfile: 'danger-full-access' }],
  ['採点情報の入力', { workspaceFiles: ['eval/corpus/cases.json'] }],
  ['認証の入力', { workspaceFiles: ['auth.json'] }],
  ['過去runの入力', { workspaceFiles: ['runs/previous/actor.stdout'] }],
];

for (const [name, changes] of invalidPlans) {
  test(`軽量planは${name}を拒否する（同じ設定の正常対照つき）`, async () => {
    await fixture(1, async ({ invoke, starts }) => {
      successfulPlan(await invoke('plan'));
      const result = await invoke('plan', changes);
      assert(!result.error && !result.signal, '拒否判定まで到達していない');
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      await noInference(starts);
    });
  });
}
