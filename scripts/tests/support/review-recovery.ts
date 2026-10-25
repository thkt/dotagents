import assert from 'node:assert/strict';
import { expect, spyOn } from 'bun:test';
import * as processModule from '../../shared/process.ts';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { develop } from '../../implement/orchestrator.ts';
import { run, snapshot } from '../../implement/correction.ts';
import { command, withInterrupts, interruptionMessage } from '../../shared/process.ts';
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

export async function recordPaths(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'checkout') {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await recordPaths(path)));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

export async function records(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await recordPaths(dir)) {
    result[path] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  return result;
}

// 応答生成側だけを変更する。対象設定・検証コマンド・checkoutは固定する。
export async function recoveryFixture(
  f: DevelopmentFixture,
  localOnly = true,
  stop: 'invalid' | 'interrupted' | 'timeout' = 'invalid',
  origin: 'initial' | 'host_return' = 'initial',
  savedBudget?: number,
  currentBudget = false,
) {
  const script = join(dirname(f.dir), 'review-producer.js');
  const control = join(dirname(f.dir), 'review-control.json');
  const executions = join(dirname(f.dir), 'actor-executions.txt');
  await writeFile(executions, '');
  await writeFile(control, JSON.stringify({ response: stop }));
  await writeFile(
    script,
    `import {appendFileSync,readFileSync,writeFileSync,existsSync,unlinkSync,chmodSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
const control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
appendFileSync(${JSON.stringify(executions)},role+'\\n');
if(role==='check') {
 if(readFileSync('result.txt','utf8')!=='implemented'||readFileSync('setup.txt','utf8')!=='configured')process.exit(1);
 if(control.requiredArtifact && (!existsSync(control.requiredArtifact.path)||readFileSync(control.requiredArtifact.path,'utf8')!==control.requiredArtifact.content))process.exit(1);
 if(control.changeCheck) {if(control.changeCheck.mode!==undefined) chmodSync(control.changeCheck.path,control.changeCheck.mode);else if(control.changeCheck.remove) unlinkSync(control.changeCheck.path);else writeFileSync(control.changeCheck.path,control.changeCheck.content);}
 if(control.failCheck) {writeFileSync(${JSON.stringify(control)},JSON.stringify({...control,failCheck:false}));process.exit(1);}
}
if(role==='test') {
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 console.log(JSON.stringify({targetId:input.targetId,status:control.testHostRequired?'needs_host':'unnecessary',findings:control.testHostRequired?'独立テスト工程の模擬ホスト検証が必要です。':'要求した対照は既存checkで確認する。',files:[]}));
}
if(role==='repair') {
 writeFileSync('README.md','要求した操作説明');
 console.log(JSON.stringify(control.hostRequired
  ? {status:'needs_host',findings:'合意したホスト検証の追加証拠が必要です。'}
  : {status:'repaired',findings:'操作説明を追加'}));
}
if(role==='review') {
 if(control.response==='interrupted') {process.kill(process.ppid,'SIGTERM');await new Promise(()=>{});}
 if(control.change) {if(control.change.mode!==undefined) chmodSync(control.change.path,control.change.mode);else if(control.change.remove) unlinkSync(control.change.path);else writeFileSync(control.change.path,control.change.content);}
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
    // 旧runの有限値を固定し、通常動作の検証時だけ生成された設定をそのまま使う。
    const actual = {
      ...config,
      ...(!currentBudget
        ? { checkTimeMs: savedBudget ?? (stop === 'timeout' ? 540000 : 900000) }
        : {}),
      issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
      review: [process.execPath, script, 'review'],
      repair: [process.execPath, script, 'repair'],
      test: [process.execPath, script, 'test'],
    };
    await writeFile(
      join(dirname(config.runDir), 'verification-config.json'),
      JSON.stringify(actual),
    );
    if (stop !== 'timeout') {
      return verifyRun(actual, publicationHead);
    }
    // 旧9分版の保存契約を生成する。保存後のstate/configは修復しない。
    const execute = f.observationCommand;
    const timer = spyOn(processModule, 'command').mockImplementation(async (...args) => {
      if (args[0][2] !== 'check') {
        return execute(...args);
      }
      expect(args[3]).toBe(540000);
      assert(args[4]);
      await writeFile(`${args[4]}.stdout`, 'fixture: partial check output');
      await writeFile(`${args[4]}.stderr`, 'fixture: timeout');
      return {
        code: null,
        stdout: 'fixture: partial check output',
        stderr: 'fixture: timeout',
        timedOut: true,
        ms: 540000,
      };
    });
    try {
      return await verifyRun(actual, publicationHead);
    } finally {
      timer.mockImplementation(execute);
    }
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
  if (origin === 'host_return') {
    await prepareHostOrigin(f);
  }
  await withInterrupts(() => develop(f.args, f.io)).then(
    () => {
      throw Error('初回不正評価を拒否する必要があります');
    },
    (error: unknown) => {
      expect(String(error)).toContain(
        stop === 'timeout'
          ? 'Verification stopped: check_unavailable'
          : stop === 'invalid'
            ? 'Verification stopped: invalid_review'
            : interruptionMessage,
      );
    },
  );
  // 中断状態は旧stateへ残し、テストプロセス側の信号フラグだけを次の操作へ戻す。
  if (stop === 'interrupted') {
    await withInterrupts(async () => {});
  }
  const cwd = object(
    JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
  ).cwd;
  assert(typeof cwd === 'string');
  const statePath = join(f.dir, 'verification/state.json');
  const state = object(JSON.parse(await readFile(statePath, 'utf8')));
  expect(state).toMatchObject({
    result:
      stop === 'timeout'
        ? 'check_unavailable'
        : stop === 'invalid'
          ? 'invalid_review'
          : 'interrupted',
    checks: 1,
    review: stop === 'timeout' ? 0 : 1,
    repair: 0,
    reviewHistory: [],
    active:
      stop !== 'interrupted'
        ? null
        : { role: 'review', prefix: join(f.dir, 'verification/review-1') },
  });
  if (stop === 'invalid') {
    expect(state.findings).toContain('コード行範囲を確認できません');
  }
  expect(object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')))).toMatchObject({
    status: 'stopped',
    ...(stop === 'timeout'
      ? { reasonCode: 'check_unavailable' }
      : stop === 'invalid'
        ? { reasonCode: 'invalid_review' }
        : { reason: interruptionMessage }),
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

// 元のホスト引継ぎから実際の既存復帰入口を通し、その初回評価だけを中断する。
async function prepareHostOrigin(f: DevelopmentFixture) {
  const original = f.implement;
  f.implement = async (...args) => {
    const result = await original(...args);
    result.stdout = JSON.stringify({
      status: 'needs_host',
      findings: '模擬ホスト検証の追加証拠が必要です。',
    });
    await writeFile(`${args[4]}.stdout`, result.stdout);
    return result;
  };
  await assert.rejects(() => develop(f.args, f.io), /Host verification required/);
  f.implement = original;
  f.test = async (_argv, _cwd, prompt, _timeout, prefix) => {
    const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
    const stdout = JSON.stringify({
      targetId: input.targetId,
      status: 'unnecessary',
      findings: '既存の独立テストを維持する。',
      files: [],
    });
    assert(prefix);
    await writeFile(`${prefix}.stdout`, stdout);
    await writeFile(`${prefix}.stderr`, '');
    return { code: 0, stdout, stderr: '', timedOut: false, ms: 1 };
  };
  const previousRun = f.dir;
  const cwd = join(previousRun, 'checkout');
  const log = join(dirname(previousRun), 'origin-host.stdout');
  await writeFile(log, 'fixture host observation: passed');
  const evidence = join(dirname(previousRun), 'origin-host.json');
  await writeFile(
    evidence,
    JSON.stringify({
      status: 'passed',
      source: await snapshot(cwd),
      findings: '現在sourceに対する模擬観測。実サービスは未確認。',
      logs: [
        {
          path: log,
          sha256: createHash('sha256')
            .update(await readFile(log))
            .digest('hex'),
        },
      ],
    }),
  );
  f.dir = join(dirname(previousRun), 'host-origin-return');
  f.args = [
    '99',
    '--repo',
    cwd,
    '--host-run',
    previousRun,
    '--host-evidence',
    evidence,
    '--run-dir',
    f.dir,
    '--no-publish',
  ];
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

// CLIのmain・argv・終了コードを通す。新入口ではプロセスとremoteの観測も模擬する。
export async function recoveryCli(
  f: DevelopmentFixture,
  t: Pick<
    Awaited<ReturnType<typeof recoveryFixture>>,
    'cwd' | 'dir' | 'args' | 'actors' | 'script' | 'control' | 'executions'
  >,
  githubReplies: Record<string, string> = {},
  options: {
    observe?: boolean;
    publication?: boolean;
    allowImplementation?: boolean;
    actorEnvironment?: Record<string, string>;
  } = {},
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
import * as processModule from ${JSON.stringify(modulePath('../../shared/process.ts'))};
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {githubTarget} from ${JSON.stringify(modulePath('./target.ts'))};
const settings=${JSON.stringify(f.settings)};
const actors=${JSON.stringify(actors)};
const nativeActors=${JSON.stringify(Boolean(options.actorEnvironment))};
const replies=${JSON.stringify(githubReplies)};
const observing=${JSON.stringify(options.observe ?? t.args.includes('--interrupted-run'))};
const publication=${JSON.stringify(options.publication ?? false)};
const publishedFile=${JSON.stringify(join(dirname(f.dir), 'recovery-published.json'))};
async function published() {return JSON.parse(await readFile(publishedFile,'utf8').catch(()=> 'null'));}
async function publicationReply(argv,cwd) {
 const pr=await published();
 if(argv[1]==='pr'&&argv[2]==='view'&&pr) return JSON.stringify(pr);
 if(argv[2]?.includes('/git/ref/heads/')&&pr) return JSON.stringify({object:{sha:pr.headRefOid}});
 if(argv[2]?.endsWith('/pulls/100')&&pr) return JSON.stringify({html_url:pr.url,state:'open',draft:true,user:pr.author,head:{ref:pr.headRefName,sha:pr.headRefOid,repo:{full_name:settings.repository}},base:{ref:pr.baseRefName,repo:{full_name:settings.repository}},body:pr.body});
 if(argv[1]==='pr'&&argv[2]==='list'||argv[2]?.endsWith('/pulls')) {
  const prs=pr?[{html_url:pr.url,head:{ref:pr.headRefName,repo:{full_name:settings.repository}},base:{ref:pr.baseRefName},draft:true}]:[];
  return JSON.stringify(argv.includes('--slurp')?[prs]:prs);
 }
 return undefined;
}
async function fakePush(argv) {
 if(!publication) throw Error('Unexpected publication');
 await appendFile(${JSON.stringify(t.executions)},'push\\n');
 return {code:0,stdout:'',stderr:'',timedOut:false,ms:1};
}
const realCommand=command;
const originalProcess={...processModule};
function psStart(value,timeZone) {
 const parts=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
 const part=type=>parts.find(value=>value.type===type).value;
 return part('weekday')+' '+part('month')+' '+part('day')+' '+part('hour')+':'+part('minute')+':'+part('second')+' '+part('year');
}
if(observing) mock.module(${JSON.stringify(modulePath('../../shared/process.ts'))},()=>({...originalProcess,command:async(argv,cwd,input,timeout,prefix,env)=>{
 if(argv[0]==='git'&&argv.includes('push')) return fakePush(argv);
 if(!nativeActors&&argv[1]?.endsWith('/codex-actor.ts')&&['test','review','repair'].includes(argv[2])) {
  return realCommand(actors[argv[2]],cwd,input,timeout,prefix,env);
 }
 const control=JSON.parse(await readFile(${JSON.stringify(t.control)},'utf8'));
 if(control.traceSetup&&argv[0]==='sh'&&argv.includes('printf configured > setup.txt')) await appendFile(${JSON.stringify(t.executions)},'setup\\n');
 if(argv[2]==='check'&&control.expectedBudget!==undefined&&timeout!==control.expectedBudget) throw Error('fixture: check budget mismatch '+timeout);
 // 不完全な実行結果の故障注入。msは経過値で、上限なしのタイマー発火を表さない。
 if(argv[2]==='check'&&control.timeoutCheck) {
  await appendFile(${JSON.stringify(t.executions)},'check\\n');
  const result={code:null,stdout:'fixture: partial fresh check',stderr:'fixture: timeout',timedOut:true,ms:timeout??900000};
  await writeFile(prefix+'.stdout',result.stdout);await writeFile(prefix+'.stderr',result.stderr);
  return result;
 }
 let stdout,code=0;
 if(argv[0]==='ps') {
  await appendFile(${JSON.stringify(t.executions)},'observe-process\\n');
  const start='Wed Oct 14 16:02:44 2026';
  stdout='    1     0 '+start+'     /sbin/launchd\\n 424242     1 '+start+' /usr/bin/unrelated-fixture\\n';
  if(control.observation==='live') stdout='424242 1 '+start+' '+process.execPath+' '+${JSON.stringify(t.script)}+' review '+${JSON.stringify(f.dir)}+'\\n';
  if(['normal_host','return_impostor'].includes(control.observation)) {
   const saved=JSON.parse(await readFile(${JSON.stringify(join(f.dir, 'result.json'))},'utf8'));
   const time=new Date(control.observation==='normal_host'?Date.parse(saved.startedAt)-60000:Date.parse(saved.finishedAt));
   const lstart=psStart(time,env?.TZ);
   const host=${JSON.stringify(join(dirname(f.repo), 'shared-harness/scripts/implement/development.ts'))};
   const args=control.observation==='normal_host'?['99','--repo',${JSON.stringify(f.repo)},'--no-publish']:${JSON.stringify(t.args)};
   const argv=[process.execPath,host,...args].map(arg=>/\\s/.test(arg)?JSON.stringify(arg):arg).join(' ');
   stdout+='424243 1 '+lstart+' '+argv+'\\n';
  }
  if(control.observation==='process_incomplete') stdout='424242 /usr/bin/unrelated-fixture\\n';
  if(control.observation==='process_partial') stdout+='424243 /usr/bin/unrelated-fixture\\n';
  if(control.observation==='process_unsupported') stdout='424242 1 unsupported-start /usr/bin/unrelated-fixture\\n';
  if(control.observation==='process_ambiguous') stdout+='424242 2 '+start+' /usr/bin/another-fixture\\n';
  if(control.observation==='process_empty') stdout='';
  if(control.observation==='process_failed') code=1;
  // psの時刻は観測コマンドのTZ、未指定なら観測する子CLIのローカル時刻で生成する。
  // bun test側の既定時刻帯とホストの時刻帯が違っても、同じ瞬間を対応付ける。
  if(control.processStartedAt!==undefined) {
   const start=psStart(control.processStartedAt,env?.TZ);
   stdout='100000001 1 '+start+' '+control.processCommand;
  }
  if(control.processStdout!==undefined) stdout=control.processStdout;
  if(control.ancestorProcess) {
   const dated=argv.some(value=>value.includes('lstart'));
   const current=dated?psStart(Date.now(),env?.TZ)+' ':'';
   const old=dated?psStart(control.ancestorProcess.startedAt,env?.TZ)+' ':'';
   const owner=[process.execPath,${JSON.stringify(modulePath('../../implement/development.ts'))},...${JSON.stringify(t.args)}].join(' ');
   stdout='1 0 '+old+'/sbin/launchd\\n424242 1 '+old+'/usr/bin/unrelated-fixture\\n'+process.pid+' '+process.ppid+' '+current+owner+'\\n';
   if(control.observation==='live') stdout+='424243 1 '+old+control.ancestorProcess.command+'\\n';
   await appendFile(${JSON.stringify(t.control + '.process.jsonl')},JSON.stringify({run:${JSON.stringify(t.dir)},argv,code,stdout,observation:control.observation??'safe',ownerPid:process.pid})+'\\n');
  }
 }
 if(argv[0]==='git'&&argv.includes('ls-remote')&&!argv.includes('--get-url')) {
  await appendFile(${JSON.stringify(t.executions)},'observe-remote\\n');
  const pr=publication?await published():null;
  stdout=control.observation==='remote_present'?'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/codex/development-99\\n':pr?pr.headRefOid+' refs/heads/'+pr.headRefName+'\\n':'';
  if(control.observation==='remote_failed') code=1;
 }
 if(argv[0]==='gh') {
  await appendFile(${JSON.stringify(t.executions)},'observe-github\\n');
  if(argv[1]==='issue') stdout=replies.issue??${JSON.stringify(issue)};
  else if(argv[1]==='pr'&&argv[2]==='list'||argv[2]?.endsWith('/pulls')) {
   const prs=control.observation==='closed_pr'?[{number:100,state:'closed',url:'https://github.com/'+settings.repository+'/pull/100',html_url:'https://github.com/'+settings.repository+'/pull/100',head:{ref:'codex/development-99',sha:'a'.repeat(40),repo:{full_name:settings.repository}}}]:[];
   stdout=publication?await publicationReply(argv,cwd):JSON.stringify(argv.includes('--slurp')?[prs]:prs);
   if(control.observation==='github_failed') code=1;
  }
  else stdout=replies[argv[2]]??(publication?await publicationReply(argv,cwd):undefined)??githubTarget(argv,settings);
 }
 if(argv[0]==='gh'&&stdout===undefined) throw Error('Unexpected GitHub operation');
 if(stdout===undefined) return realCommand(argv,cwd,input,timeout,prefix,env);
 const result={code,stdout,stderr:code?'fixture observation failed':'',timedOut:false,ms:1};
 if(prefix) {await writeFile(prefix+'.stdout',result.stdout);await writeFile(prefix+'.stderr',result.stderr);}
 return result;
}}));
const io={
 command:async(argv,cwd,input,timeout,prefix,env)=>{
  if(observing&&(argv[0]==='gh'||argv[0]==='ps'||argv[0]==='git'&&argv.includes('ls-remote'))) return command(argv,cwd,input,timeout,prefix);
  if(argv[0]==='gh') {
   const key=argv[1]==='issue'?'issue':argv[2];
   const stdout=replies[key]??(argv[1]==='issue'?${JSON.stringify(issue)}:(publication?await publicationReply(argv,cwd):undefined)??githubTarget(argv,settings));
   if(stdout===undefined) throw Error('Unexpected GitHub operation');
   return {code:0,stdout,stderr:'',timedOut:false,ms:1};
  }
  if(argv[0]==='git'&&argv.includes('push')) return fakePush(argv);
  if(argv[2]==='test') return command(nativeActors?argv:actors.test,cwd,input,timeout,prefix,nativeActors?env:undefined);
  if(argv[2]==='repair') {
   if(!${JSON.stringify(t.args.includes('--previous-run') || options.allowImplementation)}) throw Error('Unexpected initial implementation');
   return command(nativeActors?argv:actors.repair,cwd,input,timeout,prefix,nativeActors?env:undefined);
  }
  return command(argv,cwd,input,timeout,prefix);
 },
 verify:(config,publicationHead)=>run(observing?config:{...config,issue:actors.issue,review:actors.review,repair:actors.repair,test:actors.test},publicationHead),
 publish:async(input)=>{
  if(!publication) throw Error('Unexpected publication');
  await appendFile(${JSON.stringify(t.executions)},'publish\\n');
  const pr={url:'https://github.com/'+settings.repository+'/pull/100',state:'OPEN',isDraft:true,body:await readFile(input.bodyFile,'utf8'),author:{login:'operator'},headRefName:input.head,headRefOid:input.commit,baseRefName:settings.baseBranch,headRepository:{name:settings.repository.split('/')[1]},headRepositoryOwner:{login:settings.repository.split('/')[0]},isCrossRepository:false,closingIssuesReferences:[],statusCheckRollup:[{name:'checks',status:'COMPLETED',conclusion:'SUCCESS'}]};
  await writeFile(publishedFile,JSON.stringify(pr));
  return pr.url;
 }
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
    undefined,
    options.actorEnvironment ? { ...process.env, ...options.actorEnvironment } : undefined,
  );
}
