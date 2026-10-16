import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { isRecord } from '../../shared/values.ts';

// 通常actorのrepair応答契約。モデルの返答やevalの実出力から期待値を作らない。
const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings'],
  properties: {
    status: { type: 'string', enum: ['repaired', 'needs_host', 'needs_human'] },
    findings: { type: 'string' },
  },
};

async function launch(initial: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'eval-initial-actor-'));
  try {
    for (const path of ['input/skills/scoping', 'input/skills/implement', 'runtime']) {
      await mkdir(join(root, path), { recursive: true });
    }
    await writeFile(join(root, 'input/README.md'), '公開された課題の通常資料');
    const capture = join(root, 'launch.json');
    const cli = join(root, 'fake-codex');
    await writeFile(
      cli,
      `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
const index=args.indexOf('--output-schema');
const schema=index<0?null:JSON.parse(readFileSync(args[index+1],'utf8'));
writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,input:readFileSync(0,'utf8')}));
console.log(JSON.stringify({type:'turn.completed'}));
`,
      { mode: 0o755 },
    );
    // コンテナー用の絶対配置と実CLIだけを一時領域へ付け替える。
    // actor関数・引数構築・設定読取りは製品のコードをそのまま実行する。
    const source = await readFile(resolve(import.meta.dir, '../../eval/container.ts'), 'utf8');
    const runtime = source
      .replaceAll('/work', join(root, 'work'))
      .replaceAll('/input', join(root, 'input'))
      .replaceAll('/runtime', join(root, 'runtime'))
      .replaceAll("'codex'", JSON.stringify(cli));
    const path = join(root, 'runtime/container.ts');
    await writeFile(path, runtime);
    const prompt = '合意済みの完了メッセージ変更を実装し、既存の動作を維持してください。';
    await writeFile(
      join(root, 'runtime/settings.json'),
      JSON.stringify({
        model: 'simulated-model',
        reasoning: 'medium',
        maxRequests: 20,
        maxOutputTokens: 8000,
        expiresAt: Date.now() + 10000,
        prompt,
        ...(initial ? { responseSchema } : {}),
      }),
    );
    const result = spawnSync(process.execPath, [path, 'actor'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH },
    });
    assert(!result.error && result.signal === null, '模擬actorの実行が完了していない');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const saved: unknown = JSON.parse(await readFile(capture, 'utf8'));
    assert(isRecord(saved) && Array.isArray(saved.args));
    expect(saved.input).toBe(prompt);
    expect(saved.args).toContain('--ignore-user-config');
    expect(saved.args).toContain('workspace-write');
    expect(saved.args).toContain('model_reasoning_effort="medium"');
    expect(saved.args).toContain('model_providers.eval.request_max_retries=0');
    expect(saved.args).toContain('model_providers.eval.stream_max_retries=0');
    return saved;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('既存のスキル選択actorは初回担当の応答契約を強制しない', async () => {
  const saved = await launch(false);
  expect(saved.args).not.toContain('--output-schema');
  expect(saved.schema).toBeNull();
});

test('初回担当はresponseSchemaを実CLIのoutput-schemaへ接続する', async () => {
  const saved = await launch(true);
  expect(saved.args).toContain('--output-schema');
  expect(saved.schema).toEqual(responseSchema);
});
