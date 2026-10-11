import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { develop } from '../../implement/orchestrator.ts';
import { run } from '../../implement/correction.ts';
import { command } from '../../shared/process.ts';
import { gitOutput, issue, testDevelopment } from './development.ts';
import type { DevelopmentFixture } from './development.ts';
import { object, reviewReplySource } from './correction.ts';

// ホスト提示の任意引数を転送し、修正前の1引数版でも再現を実行する。
const verifyRun: (config: unknown, publicationHead?: string) => ReturnType<typeof run> = run;

export function testReviewRecovery(
  name: string,
  execute: (fixture: DevelopmentFixture) => Promise<void>,
) {
  // 初回停止の準備と新runの子プロセス実行を含む結合テストだけに有限の期限を設ける。
  // 検証コマンドの期限、実行回数・修正上限、他のdevelopmentテストは変更しない。
  testDevelopment(name, execute, {}, 30000);
}

export async function records(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'checkout') {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await records(path));
    } else {
      result[path] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    }
  }
  return result;
}

// 応答生成側だけを変更する。対象設定・検証コマンド・checkoutは固定する。
export async function recoveryFixture(f: DevelopmentFixture, localOnly = true) {
  const script = join(dirname(f.dir), 'review-producer.js');
  const control = join(dirname(f.dir), 'review-control.json');
  const executions = join(dirname(f.dir), 'actor-executions.txt');
  await writeFile(executions, '');
  await writeFile(control, JSON.stringify({ response: 'invalid' }));
  await writeFile(
    script,
    `import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
const control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
appendFileSync(${JSON.stringify(executions)},role+'\\n');
if(role==='check') {
 if(readFileSync('result.txt','utf8')!=='implemented'||readFileSync('setup.txt','utf8')!=='configured')process.exit(1);
 if(control.changeCheck) writeFileSync(control.changeCheck.path,control.changeCheck.content);
 if(control.failCheck) {writeFileSync(${JSON.stringify(control)},JSON.stringify({...control,failCheck:false}));process.exit(1);}
}
if(role==='test') {
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'要求した対照は既存checkで確認する。',files:[]}));
}
if(role==='repair') {
 writeFileSync('README.md','要求した操作説明');
 console.log(JSON.stringify({status:'repaired',findings:'操作説明を追加'}));
}
if(role==='review') {
 if(control.change) writeFileSync(control.change.path,control.change.content);
 const needs=control.response==='needs_changes'&&!existsSync('README.md');
 const reply=reviewReply(needs?'needs_changes':'accepted','模擬評価。実モデルの品質は未確認。');
 reply.walkthrough[0].code=[{path:'result.txt',start:1,end:control.response==='invalid'?2:1}];
 console.log(JSON.stringify(reply));
}`,
  );
  f.settings.check = [process.execPath, script, 'check'];
  await writeFile(join(f.repo, '.dotagents.json'), JSON.stringify(f.settings));
  await gitOutput(f.repo, 'add', '.dotagents.json');
  await gitOutput(f.repo, 'commit', '-m', '模擬check契約');
  f.verify = async (config, publicationHead) => {
    const actual = {
      ...config,
      issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
      review: [process.execPath, script, 'review'],
      repair: [process.execPath, script, 'repair'],
      test: [process.execPath, script, 'test'],
    };
    await writeFile(
      join(dirname(config.runDir), 'verification-config.json'),
      JSON.stringify(actual),
    );
    return verifyRun(actual, publicationHead);
  };
  // 初回の独立テストを実際に転送して、内容・実行モードの維持を検証する。
  f.test = async (_argv, cwd, prompt, _timeout, prefix) => {
    const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
    const name = 'result.test.js';
    await writeFile(
      join(cwd, name),
      "import {readFileSync} from 'node:fs'; if(readFileSync('result.txt','utf8')!=='implemented')process.exit(1);\n",
      { mode: 0o755 },
    );
    const response = JSON.stringify({
      targetId: input.targetId,
      status: 'prepared',
      findings: '合意したresult値を判定するfixture。',
      files: [name],
    });
    assert(prefix);
    await writeFile(`${prefix}.stdout`, response);
    await writeFile(`${prefix}.stderr`, '');
    return { code: 0, stdout: response, stderr: '', timedOut: false, ms: 1 };
  };
  if (localOnly) {
    f.args.push('--no-publish');
  }
  await develop(f.args, f.io).then(
    () => {
      throw Error('初回不正評価を拒否する必要があります');
    },
    (error: unknown) => {
      expect(String(error)).toContain('Verification stopped: invalid_review');
    },
  );
  const cwd = join(f.dir, 'checkout');
  const statePath = join(f.dir, 'verification/state.json');
  const state = object(JSON.parse(await readFile(statePath, 'utf8')));
  expect(state).toMatchObject({
    result: 'invalid_review',
    checks: 1,
    review: 1,
    repair: 0,
    reviewHistory: [],
    active: null,
  });
  expect(state.findings).toContain('コード行範囲を確認できません');
  expect(object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')))).toMatchObject({
    status: 'stopped',
    reasonCode: 'invalid_review',
    publication: 'not_attempted',
  });
  const dir = join(dirname(f.dir), 'review-return');
  // 引数名は接続上の仮選択。要求は初回不正評価からの新run作成である。
  const args = ['99', '--repo', cwd, '--review-run', f.dir, '--run-dir', dir];
  if (localOnly) {
    args.push('--no-publish');
  }
  // 不一致を注入する前に模擬actorを固定し、欠落ケースでもCLI自身へ到達させる。
  const actors = object(
    JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
  );
  await writeFile(control, JSON.stringify({ response: 'accepted' }));
  return { cwd, dir, args, control, executions, statePath, state, script, actors };
}

// 保存設定・configHashを差し替えず、実CLIが選ぶactorの外部I/Oだけを模擬する。
export async function contractRecoveryCli(
  f: DevelopmentFixture,
  t: Awaited<ReturnType<typeof recoveryFixture>>,
  args: string[],
) {
  const preload = join(dirname(f.dir), 'contract-cli.ts');
  const processPath = new URL('../../shared/process.ts', import.meta.url).pathname;
  const targetPath = new URL('./target.ts', import.meta.url).pathname;
  await writeFile(
    preload,
    `import {mock} from 'bun:test';
import * as processModule from ${JSON.stringify(processPath)};
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {githubTarget} from ${JSON.stringify(targetPath)};
const realCommand=processModule.command;
const original={...processModule};
mock.module(${JSON.stringify(processPath)},()=>({...original,command:async(argv,cwd,input,timeout,prefix,env)=>{
 if(argv[0]==='gh') {
  const stdout=argv[1]==='issue'?${JSON.stringify(issue)}:githubTarget(argv,${JSON.stringify(f.settings)});
  if(stdout===undefined) throw Error('Unexpected GitHub operation');
  if(prefix) {await writeFile(prefix+'.stdout',stdout);await writeFile(prefix+'.stderr','');}
  return {code:0,stdout,stderr:'',timedOut:false,ms:1};
 }
 if(argv[0]==='git'&&argv.includes('push')) throw Error('Unexpected publication');
 if(argv[1]?.endsWith('/codex-actor.ts')) {
  if(argv[2]==='test'&&(await readFile(join(cwd,'result.txt'),'utf8'))!=='implemented') {
   const context=JSON.parse(input.split('入力: ')[1].split('\\n')[0]);
   await writeFile(join(cwd,'result.test.js'),"import {readFileSync} from 'node:fs'; if(readFileSync('result.txt','utf8')!=='implemented')process.exit(1);\\n",{mode:0o755});
   const stdout=JSON.stringify({targetId:context.targetId,status:'prepared',findings:'合意したresult値を確認する。',files:['result.test.js']});
   await writeFile(prefix+'.stdout',stdout);await writeFile(prefix+'.stderr','');
   return {code:0,stdout,stderr:'',timedOut:false,ms:1};
  }
  if(argv[2]==='repair'&&prefix?.endsWith('/implementation')) {
   await writeFile(join(cwd,'result.txt'),'implemented');
   const stdout=JSON.stringify({status:'repaired',findings:'要求した結果を保存する。'});
   await writeFile(prefix+'.stdout',stdout);await writeFile(prefix+'.stderr','');
   return {code:0,stdout,stderr:'',timedOut:false,ms:1};
  }
  return realCommand([process.execPath,${JSON.stringify(t.script)},argv[2]],cwd,input,timeout,prefix,env);
 }
 return realCommand(argv,cwd,input,timeout,prefix,env);
}}));`,
  );
  return command(
    [
      process.execPath,
      '--preload',
      preload,
      new URL('../../implement/development.ts', import.meta.url).pathname,
      ...args,
    ],
    f.repo,
    '',
    10000,
  );
}

// CLIのmain・argv・終了コードを通す。GitHubとモデルのI/Oだけを模擬する。
export async function recoveryCli(
  f: DevelopmentFixture,
  t: Awaited<ReturnType<typeof recoveryFixture>>,
  githubReplies: Record<string, string> = {},
) {
  const preload = join(dirname(f.dir), 'recovery-cli.ts');
  const modulePath = (relative: string) => new URL(relative, import.meta.url).pathname;
  const actors = t.actors;
  await writeFile(
    preload,
    `import {mock} from 'bun:test';
import {develop} from ${JSON.stringify(modulePath('../../implement/orchestrator.ts'))};
import {run} from ${JSON.stringify(modulePath('../../implement/correction.ts'))};
import {command} from ${JSON.stringify(modulePath('../../shared/process.ts'))};
import {githubTarget} from ${JSON.stringify(modulePath('./target.ts'))};
const settings=${JSON.stringify(f.settings)};
const actors=${JSON.stringify(actors)};
const replies=${JSON.stringify(githubReplies)};
const io={
 command:async(argv,cwd,input,timeout,prefix)=>{
  if(argv[0]==='gh') {
   const key=argv[1]==='issue'?'issue':argv[2];
   const stdout=replies[key]??(argv[1]==='issue'?${JSON.stringify(issue)}:githubTarget(argv,settings));
   if(stdout===undefined) throw Error('Unexpected GitHub operation');
   return {code:0,stdout,stderr:'',timedOut:false,ms:1};
  }
  if(argv[0]==='git'&&argv.includes('push')) throw Error('Unexpected publication');
  if(argv[2]==='test') return command(actors.test,cwd,input,timeout,prefix);
  if(argv[2]==='repair') throw Error('Unexpected initial implementation');
  return command(argv,cwd,input,timeout,prefix);
 },
 verify:(config,publicationHead)=>run({...config,issue:actors.issue,review:actors.review,repair:actors.repair,test:actors.test},publicationHead),
 publish:()=>{throw Error('Unexpected publication');}
};
const entry=develop;
mock.module(${JSON.stringify(modulePath('../../implement/orchestrator.ts'))},()=>({develop:args=>entry(args,io)}));`,
  );
  return command(
    [
      process.execPath,
      '--preload',
      preload,
      modulePath('../../implement/development.ts'),
      ...t.args,
    ],
    t.cwd,
    '',
    10000,
  );
}
