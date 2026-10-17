import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';

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
writeFileSync(${JSON.stringify(capture)},JSON.stringify({args}));
if(args.includes('--version')) {console.log('codex-cli synthetic');process.exit(0);}
const index=args.indexOf('--output-schema');
const schema=index<0?null:JSON.parse(readFileSync(args[index+1],'utf8'));
writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,input:readFileSync(0,'utf8')}));
console.log(JSON.stringify({type:'turn.completed'}));
`,
      { mode: 0o755 },
    );
    // コンテナー用の絶対配置と実CLIだけを一時領域へ付け替える。
    // actor関数・引数構築・設定読取りは製品のコードをそのまま実行する。
    const source = await readFile(resolve(import.meta.dir, '../container.ts'), 'utf8');
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
        cliVersion: 'codex-cli synthetic',
        bunVersion: process.versions.bun,
        gitVersion: 'git version synthetic',
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
    // #401: 環境変数・合成版応答・パスの付替えでは外側の境界を証明できない。
    // ホスト上では版取得を含むCLIを起動せず、非0で停止することが期待結果。
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    await assert.rejects(access(capture), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const initial of [false, true]) {
  test(`ホスト直接実行は${initial ? '初回担当schemaあり' : 'スキル選択'}でもCLIを起動しない`, async () => {
    await launch(initial);
  });
}
