import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { initialActorSources, prepareInitialActorInput } from '../initial-input.ts';
import { isRecord } from '../../scripts/shared/values.ts';
import { instructionFiles, lightInputRepository } from './trusted-inputs.ts';

let root: string;
let temporary: string;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'eval-light-input-'));
  root = join(temporary, 'repo');
  await lightInputRepository(root);
});
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});
const before = 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092';
const after = '6181233d17a29c711a84f20549f78507c5c3e5fb';
const workspace = '0c7316253a9768844eb1c224961e00be52dcdcf2';
const prepareAt: (
  config: Parameters<typeof prepareInitialActorInput>[0],
  files: Parameters<typeof prepareInitialActorInput>[1],
  sources: Parameters<typeof prepareInitialActorInput>[2],
  root: string,
) => ReturnType<typeof prepareInitialActorInput> = prepareInitialActorInput;
const config = {
  repository: 'thkt/dotagents',
  issue: 'https://github.com/thkt/dotagents/issues/405',
  before,
  after,
  corpusCommit: workspace,
  workspaceCommit: workspace,
  workspaceFiles: ['eval/fixtures/workspace/tests/messages.test.ts'],
  instructionFiles,
  cases: ['completion-message'],
  trialOrder: ['after-completion-message', 'before-completion-message'],
  model: 'gpt-6.1-sol',
  reasoning: 'medium' as const,
  cliVersion: 'codex-cli 0.163.0',
  bunVersion: '1.4.3',
  gitVersion: 'git synthetic',
  caseTimeMs: 600000,
  totalTimeMs: 2400000,
  maxTrials: 2,
  outputDirectory: '/tmp/not-executed',
  disclosure: {
    inputs: 'reviewed-public-committed-files-only',
    raw: 'local-only',
    summary: 'manual-issue-or-pr',
  },
};

function blob(commit: string, path: string, absent = false) {
  if (absent) {
    const tree = spawnSync('git', ['ls-tree', commit, '--', path], { cwd: root, encoding: 'utf8' });
    assert.equal(tree.status, 0, tree.stderr);
    assert.equal(tree.stdout, '', `Aで意図した不存在: ${path}`);
    return null;
  }
  const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function inputs(commit: string) {
  const files: Record<string, string> = {};
  for (const path of instructionFiles) {
    const body = blob(
      commit,
      path,
      commit === before &&
        [
          'skills/references/mechanization.md',
          'skills/references/premise-validation.md',
          'skills/references/caller-first-design.md',
        ].includes(path),
    );
    if (body !== null) {
      files[path] = body;
    }
  }
  const paths = spawnSync(
    'git',
    ['ls-tree', '-r', '--name-only', workspace, '--', 'eval/fixtures/workspace/tests'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(paths.status, 0, paths.stderr);
  for (const path of paths.stdout.trim().split('\n')) {
    files[path] = blob(workspace, path) ?? '';
  }
  const sources = await initialActorSources(config, async (path) => blob(commit, path) ?? '');
  return { files, sources };
}

for (const commit of [before, after]) {
  for (const id of ['completion-message', 'guide-link', 'work-area', 'save-diagnostics']) {
    test(`固定初回担当入力${id}/${commit.slice(0, 7)}は配置先だけを変換し、固定した担当入力を維持する`, async () => {
      const { files, sources } = await inputs(commit);
      const corpus: unknown = JSON.parse(blob(workspace, 'eval/corpus/cases.json') ?? 'null');
      assert(Array.isArray(corpus));
      const source: unknown = corpus.find((entry: unknown) => isRecord(entry) && entry.id === id);
      assert(isRecord(source) && isRecord(source.context) && Array.isArray(source.check));
      assert(typeof source.context.body === 'string');
      const item = {
        id,
        contextBody: source.context.body,
        check: source.check.map((arg: unknown) => {
          assert(typeof arg === 'string');
          return arg;
        }),
      };
      const original = prepareInitialActorInput(config, files, sources)(item);
      const destination = '/private/tmp/eval-light-trial/workspace';
      // 第4引数は配置先を指定する接続。期待する本文は新実装から作らず、
      // 固定blobの既存生成と、Issueが許した配置先置換だけから定める。
      const generate = prepareAt(config, files, sources, destination);
      const relocated = generate(item);
      expect(original.prompt).toContain('/work/repo/');
      expect(relocated.prompt).toBe(original.prompt.replaceAll('/work/repo', destination));
      expect(relocated.repairInstructions).toBe(
        original.repairInstructions.replaceAll('/work/repo', destination),
      );
      expect(relocated.schema).toEqual(original.schema);
      expect(relocated.schema).toEqual({
        type: 'object',
        additionalProperties: false,
        required: ['status', 'findings'],
        properties: {
          status: { type: 'string', enum: ['repaired', 'needs_host', 'needs_human'] },
          findings: { type: 'string' },
        },
      });
      expect(relocated.role).toBe('repair');
      expect(relocated.stage).toBe('initial');
      expect(relocated.prompt).toContain(item.contextBody);
      const testRecord: unknown = JSON.parse(
        relocated.files['actor-records/test-1.json'] ?? 'null',
      );
      assert(isRecord(testRecord) && isRecord(testRecord.files));
      expect(testRecord.check).toEqual(item.check);
      for (const path of item.check.filter((arg) =>
        arg.startsWith('eval/fixtures/workspace/tests/'),
      )) {
        expect(testRecord.files[path]).toBeDefined();
      }
      expect(testRecord.status).toBe('prepared');
      expect(testRecord.baseCommit).toBe(workspace);
      expect(relocated.prompt).toContain(`${destination}/actor-records/test-1.json`);
      for (const [path, body] of Object.entries(files).filter(([path]) =>
        path.startsWith('eval/fixtures/workspace/tests/'),
      )) {
        expect(testRecord.files[path]).toBe(createHash('sha256').update(body).digest('hex'));
      }
      expect(relocated.sources).toEqual(original.sources);
      expect(relocated.files).toEqual(original.files);
      expect(relocated.promptHash).toBe(
        createHash('sha256').update(relocated.prompt).digest('hex'),
      );
      expect(relocated.repairInstructionsHash).toBe(
        createHash('sha256').update(relocated.repairInstructions).digest('hex'),
      );
      expect(relocated.references).toEqual(original.references);
      expect(JSON.stringify(relocated)).not.toContain('HOST_ONLY');
    });
  }
}
for (const commit of [before, after]) {
  test(`固定初回入力は必須参照の欠落を他方で補完しない: ${commit.slice(0, 7)}`, async () => {
    const { files, sources } = await inputs(commit);
    const generate = prepareAt(config, files, sources, '/private/tmp/fixed-input');
    const item = { id: 'completion-message', contextBody: '公開仕様', check: ['bun', 'test'] };
    expect(generate(item).references.length).toBeGreaterThan(0);
    for (const path of generate(item).references) {
      const incomplete = { ...files };
      delete incomplete[path];
      expect(() => prepareAt(config, incomplete, sources, '/private/tmp/fixed-input')).toThrow(
        'Missing trusted actor reference',
      );
    }
  });
}
