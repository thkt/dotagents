import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { develop } from '../../../implement/orchestrator.ts';
import { run } from '../../../implement/correction.ts';
import { assertConfig } from '../../../implement/input.ts';
import { testDevelopment, issue } from '../../support/development.ts';
import { object, reviewReplySource } from '../../support/correction.ts';
import {
  actorRecord,
  expectActorReference,
  expectActorAssociation,
  expectActorProblem,
  expectActorUnavailable,
  references,
  saveActorRecord,
} from '../../support/actor-records.ts';
import type { DevelopmentFixture } from '../../support/development.ts';

async function changeRecord(path: string, mode: string) {
  if (mode === 'external') {
    await rm(path);
  } else if (mode === 'missing') {
    await writeFile(
      path,
      JSON.stringify({
        ...actorRecord('repair', 'implementation', '11111111-1111-4111-8111-111111111111'),
        runtime: undefined,
      }),
    );
  } else if (mode === 'unsupported') {
    await writeFile(
      path,
      JSON.stringify({
        ...actorRecord('repair', 'implementation', '11111111-1111-4111-8111-111111111111'),
        recordFormat: 999,
      }),
    );
  } else if (mode === 'mismatch') {
    await writeFile(
      path,
      JSON.stringify(
        actorRecord('review', 'implementation', '11111111-1111-4111-8111-111111111111'),
      ),
    );
  } else if (mode === 'wrong-prefix' || mode === 'wrong-sandbox' || mode === 'unassigned') {
    const record = actorRecord('repair', 'implementation', '11111111-1111-4111-8111-111111111111');
    if (mode === 'unassigned') {
      record.hostPrefix = null;
    } else if (mode === 'wrong-prefix') {
      record.hostPrefix = 'verification/repair-99';
    } else {
      record.sandbox = 'read-only';
    }
    await writeFile(path, JSON.stringify(record));
  } else if (mode === 'unreadable') {
    // actor.jsonが通常ファイルでない場合。権限に依存せず取得不能を再現します。
    await rm(path);
    await mkdir(path);
  }
}

async function actors(f: DevelopmentFixture, mode: string) {
  const paths: string[] = [];
  for (const role of ['test', 'implement'] as const) {
    const original = f[role];
    f[role] = async (...args) => {
      const response = await original(...args);
      assert(args[4]);
      const path = await saveActorRecord(
        f.dir,
        args[4],
        role === 'implement' ? 'repair' : role,
        role,
      );
      if (role === 'implement') {
        await changeRecord(path, mode);
      }
      paths.push(path);
      return response;
    };
  }
  const script = join(dirname(f.dir), 'runtime-actor.ts');
  await writeFile(
    script,
    `
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
const role=process.argv[2], root=${JSON.stringify(f.dir)}, mode=${JSON.stringify(mode)};
${reviewReplySource}
const prefix=process.env.DOTAGENTS_ACTOR_PREFIX;
const name=relative(root,prefix).replaceAll('/','-');
const recordDir=join(root,role+'-codex-'+name);
mkdirSync(recordDir,{recursive:true});
writeFileSync(join(recordDir,'actor.json'),JSON.stringify((${actorRecord.toString()})(role,relative(root,prefix),randomUUID())));
if(role==='test') {
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'既存checkを維持する',files:[]}));
}
if(role==='repair') {
 writeFileSync('README.md','要求した操作説明');
 console.log(JSON.stringify({status:'repaired',findings:'要約にはruntimeを含めない'}));
}
if(role==='review') {
 if(mode==='tamper') writeFileSync(${JSON.stringify(join(f.dir, 'repair-codex-implement/actor.json'))},'changed during review');
 const needs=mode==='multiple'&&!existsSync('README.md');
 console.log(JSON.stringify(reviewReply(needs?'needs_changes':'accepted','要約にはruntimeを含めない')));
}
`,
  );
  f.verify = (config) =>
    run({
      ...config,
      issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
      review: [process.execPath, script, 'review', f.dir],
      repair: [process.execPath, script, 'repair', f.dir],
      test: [process.execPath, script, 'test', f.dir],
    });
  f.args.push('--no-publish');
  return paths;
}

for (const mode of ['normal', 'multiple'] as const) {
  testDevelopment(
    `runtime原記録は要約なしでも${mode === 'normal' ? '初回評価' : '追加修正後の評価'}へ届く`,
    async (f) => {
      const paths = await actors(f, mode);
      // 隣の無関係なrunは探索対象にしません。
      const unrelated = await saveActorRecord(
        join(dirname(f.dir), 'unrelated-run'),
        'implementation',
        'repair',
        'foreign',
      );
      expect((await develop(f.args, f.io)).status).toBe('verified_local');
      const count = mode === 'multiple' ? 2 : 1;
      for (let n = 1; n <= count; n++) {
        const prefix = join(f.dir, `verification/review-${n}`);
        const target = object(JSON.parse(await readFile(`${prefix}.target.json`, 'utf8')));
        const prompt = await readFile(`${prefix}.prompt`, 'utf8');
        expect(prompt).toContain(`${prefix}.target.json`);
        for (const path of paths) {
          const record = object(await expectActorReference(target, path));
          expectActorAssociation(
            target,
            path,
            f.dir,
            record.role === 'test' ? 'test-1' : 'implementation',
            String(record.role),
          );
          const runtime = object(record.runtime);
          const cli = object(runtime.cli);
          const harness = object(runtime.harness);
          expect(cli.version).toEqual({
            value: null,
            reason: 'fixture version observation timed out',
          });
          expect(object(cli.entry).value).not.toBe(object(cli.realpath).value);
          expect(object(harness.commit).value).not.toBe(target.baseCommit);
          expect(record).toMatchObject({
            model: 'fixture-model',
            reasoningEffort: 'medium',
            sandbox: 'workspace-write',
            ignoreUserConfig: true,
          });
        }
        expect(references(target).some((ref) => ref.path === unrelated)).toBe(false);
        expect(
          references(target).some(
            (ref) => ref.path === join(f.dir, `review-codex-verification-review-${n}/actor.json`),
          ),
        ).toBe(false);
        if (n === 2) {
          for (const [role, prefix] of [
            ['review', 'verification/review-1'],
            ['repair', 'verification/repair-1'],
            ['test', 'verification/test-1'],
          ]) {
            const path = join(f.dir, `${role}-codex-${prefix?.replaceAll('/', '-')}/actor.json`);
            await expectActorReference(target, path);
            expectActorAssociation(target, path, f.dir, String(prefix), String(role));
          }
        }
      }
      expect(f.calls.publications).toBe(0);
      expect(f.calls.pushes).toBe(0);
    },
  );
}

testDevelopment('評価中のruntime原記録の改変を受入へ変換しない', async (f) => {
  await actors(f, 'tamper');
  const outcome: unknown = await develop(f.args, f.io).catch((error: unknown) => error);
  const state = object(JSON.parse(await readFile(join(f.dir, 'verification/state.json'), 'utf8')));
  expect(state.review).toBe(1);
  expect(state.reviewHistory).toEqual([]);
  expect(state.result).not.toBe('ready_for_human_review');
  expect(state.findings).toMatch(/runtime|actor|原記録/i);
  expect(state.findings).toMatch(/chang|hash|変更|変化|不一致/i);
  expect(outcome).toBeInstanceOf(Error);
  expect(await readFile(join(f.dir, 'repair-codex-implement/actor.json'), 'utf8')).toBe(
    'changed during review',
  );
  expect(f.calls.publications).toBe(0);
  expect(f.calls.pushes).toBe(0);
});

for (const [mode, reason] of [
  [
    'external',
    /external|missing|absent|not.?recorded|unrecorded|付属|欠落|記録.*(?:ない|なし|ありません)/i,
  ],
  ['missing', /missing|absent|not.?recorded|runtime.*(?:ない|欠落)|欠落/i],
  ['unsupported', /unsupported|非対応|形式.*(?:不明|不正)|(?:不明|不正).*形式/i],
  ['wrong-prefix', /prefix|phase|unassigned|対応|工程|不一致/i],
  ['unassigned', /prefix|phase|unassigned|対応|工程|未確認/i],
  ['wrong-sandbox', /sandbox|settings|role|対応|設定|不一致/i],
  ['mismatch', /mismatch|inconsistent|contradic|不一致|矛盾|対応.*(?:未確認|不明|しない)/i],
  [
    'unreadable',
    /unavailable|unreadable|EISDIR|not.*(?:regular|file)|取得|通常ファイル|読.*(?:不能|ない)/i,
  ],
] as const) {
  testDevelopment(`runtime原記録の${mode}は理由付きで区別する`, async (f) => {
    const paths = await actors(f, mode);
    const outcome: unknown = await develop(f.args, f.io).catch((error: unknown) => error);
    // 不完全な証拠でも評価へ渡す設計と、安全に停止する設計の双方を許します。
    // どちらも理由なしの成功や架空の観測値への補完は認めません。
    const targetFile = join(f.dir, 'verification/review-1.target.json');
    const stateFile = join(f.dir, 'verification/state.json');
    const state = (await Bun.file(stateFile).exists())
      ? object(JSON.parse(await readFile(stateFile, 'utf8')))
      : object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
    const diagnostic = (await Bun.file(targetFile).exists())
      ? JSON.stringify(object(JSON.parse(await readFile(targetFile, 'utf8'))))
      : JSON.stringify(state) + String(outcome);
    if (await Bun.file(targetFile).exists()) {
      const target: unknown = JSON.parse(await readFile(targetFile, 'utf8'));
      if (mode === 'external' || mode === 'unreadable') {
        expectActorUnavailable(target, f.dir, 'implementation', reason);
      } else {
        assert(paths[1]);
        // 読める不完全な原記録も、実内容のhashと問題の理由を対応させます。
        await expectActorReference(target, paths[1]);
        expectActorProblem(target, paths[1], reason);
      }
    }
    expect(diagnostic).toMatch(reason);
    expect(diagnostic).toMatch(/runtime|actor|原記録/i);
    expect(diagnostic).toContain('implementation');
    expect(f.calls.publications).toBe(0);
  });
}

testDevelopment('受入後のactor原記録の改変は保存済み成功の再利用を止める', async (f) => {
  const paths = await actors(f, 'normal');
  expect((await develop(f.args, f.io)).status).toBe('verified_local');
  const statePath = join(f.dir, 'verification/state.json');
  const before = await readFile(statePath, 'utf8');
  const config: unknown = JSON.parse(
    await readFile(join(f.dir, 'verification-config.json'), 'utf8'),
  );
  assertConfig(config);
  assert(paths[1]);
  await writeFile(paths[1], 'changed after acceptance');
  const outcome = await f.verify(config).catch((error: unknown) => error);
  if (outcome instanceof Error) {
    expect(String(outcome)).toMatch(/runtime|actor|原記録/i);
    expect(String(outcome)).toMatch(/chang|hash|変更|変化|不一致/i);
  } else {
    expect(object(outcome).result).not.toBe('ready_for_human_review');
  }
  expect(await readFile(statePath, 'utf8')).toBe(before);
  expect(f.calls.publications).toBe(0);
  expect(f.calls.pushes).toBe(0);
});
