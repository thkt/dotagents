import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { evalConfig } from '../data.ts';
import { initialActorSources, prepareInitialActorInput } from '../initial-input.ts';
import { instructionFiles } from './trusted-inputs.ts';

const root = resolve(import.meta.dir, '../..');
const before = 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092';
const after = '6181233d17a29c711a84f20549f78507c5c3e5fb';
const workspace = '0c7316253a9768844eb1c224961e00be52dcdcf2';
const prepareAt: (
  config: Parameters<typeof prepareInitialActorInput>[0],
  files: Parameters<typeof prepareInitialActorInput>[1],
  sources: Parameters<typeof prepareInitialActorInput>[2],
  root: string,
) => ReturnType<typeof prepareInitialActorInput> = prepareInitialActorInput;
const config = evalConfig.parse({
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
  image: `synthetic/eval@sha256:${'d'.repeat(64)}`,
  imageReview: '固定入力生成だけの合成設定。実行には使わない。',
  model: 'gpt-6.1-sol',
  reasoning: 'medium',
  cliVersion: 'codex-cli 0.163.0',
  bunVersion: '1.4.3',
  gitVersion: 'git synthetic',
  caseTimeMs: 600000,
  totalTimeMs: 2400000,
  maxTrials: 2,
  maxModelRequestsPerCase: 20,
  maxOutputTokens: 8000,
  outputDirectory: '/tmp/not-executed',
  disclosure: {
    inputs: 'reviewed-public-committed-files-only',
    raw: 'local-only',
    summary: 'manual-issue-or-pr',
  },
});

function blob(commit: string, path: string, absent = false) {
  const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8' });
  if (absent && result.status !== 0) {
    return null;
  }
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
  for (const path of config.workspaceFiles) {
    files[path] = blob(workspace, path) ?? '';
  }
  const sources = await initialActorSources(config, async (path) => blob(commit, path) ?? '');
  return { files, sources };
}

for (const commit of [before, after]) {
  test(`固定初回担当入力${commit.slice(0, 7)}は配置先だけを変換し、既存Docker入力を維持する`, async () => {
    const { files, sources } = await inputs(commit);
    const item = {
      id: 'completion-message',
      contextBody: '公開された合意済み課題本文',
      check: ['bun', 'test', 'eval/fixtures/workspace/tests/messages.test.ts'],
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
    expect(relocated.sources).toEqual(original.sources);
    expect(relocated.files).toEqual(original.files);
    expect(relocated.promptHash).toBe(createHash('sha256').update(relocated.prompt).digest('hex'));
    expect(relocated.repairInstructionsHash).toBe(
      createHash('sha256').update(relocated.repairInstructions).digest('hex'),
    );
    expect(relocated.references).toEqual(original.references);
    expect(JSON.stringify(relocated)).not.toContain('HOST_ONLY');
  });
}
