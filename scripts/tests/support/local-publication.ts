import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../shared/process.ts';
import { initializeTarget, targetConfig, git } from './target.ts';
import { nativeActorEnvironment } from './native-actor.ts';
import { issue } from './development.ts';
import { object, reviewReplySource } from './correction.ts';

// CLIの引数名だけをここに集める。期待結果はIssueの条件から個別ケースで判定する。
export async function localPublicationFixture(publicBranch?: string, interruptedHistory = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-publication-')));
  const repo = join(root, 'repo');
  const prior = join(root, 'local');
  const initial = interruptedHistory ? join(root, 'interrupted') : prior;
  const checkout = join(initial, 'checkout');
  const published = join(root, 'published');
  const dir = join(root, 'revision');
  const request = join(root, 'request.txt');
  const control = join(root, 'control.json');
  const log = join(root, 'calls.jsonl');
  const preload = join(root, 'preload.ts');
  const producer = join(root, 'actor.ts');
  await mkdir(repo);
  const settings = {
    ...targetConfig,
    check: ['sh', '-c', 'test "$(cat result.txt)" = implemented'],
  };
  await initializeTarget(repo, settings);
  const report = 'docs/research/approved.md';
  await mkdir(join(repo, 'docs/research'), { recursive: true });
  await writeFile(join(repo, report), 'Agreed original reference.\n');
  git(repo, 'add', report);
  git(repo, 'commit', '-m', '合成の合意済み参照資料');
  const base = git(repo, 'rev-parse', 'HEAD');
  const blob = git(repo, 'rev-parse', `HEAD:${report}`);
  await writeFile(
    request,
    '人が採用した修正要求: result.txtを保持して追加修正する。同じPR・branchの修正と公開を明示的に許可する。',
  );
  await writeFile(control, JSON.stringify({ interrupt: interruptedHistory }));
  await writeFile(log, '');
  await writeFile(
    producer,
    `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const role=process.argv[2];
const prompt=readFileSync(0,'utf8');
${reviewReplySource.replaceAll("readFileSync(0,'utf8')", 'prompt')}
appendFileSync(${JSON.stringify(log)},JSON.stringify({role,prompt,cwd:process.cwd()})+'\\n');
if(role==='test') {
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'合成fixtureの既存checkを維持する。',files:[]}));
 const c=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
 if(c.gitLockAfterTest) writeFileSync(c.gitLockAfterTest,'fixture Git lock',{mode:0o640});
}
if(role==='repair') {
 writeFileSync('result.txt','implemented');
 writeFileSync('deliverable.txt','accepted deliverable');
 writeFileSync(${JSON.stringify(report)},'Accepted current reference; retain the original blob.\\n');
 if(process.cwd()!==${JSON.stringify(checkout)}) writeFileSync('revision.txt','new correction');
 const c=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
 console.log(JSON.stringify({status:c.host?'needs_host':'repaired',findings:c.host?'模擬ホスト検証の証拠が必要です。':'合成要求の修正。'}));
}
if(role==='review'&&JSON.parse(readFileSync(${JSON.stringify(control)},'utf8')).interrupt) {
 process.kill(Number(process.env.FIXTURE_HOST_PID),'SIGTERM');await new Promise(()=>{});
}
if(role==='review') console.log(JSON.stringify(reviewReply('accepted','新しい対象版を評価した合成応答。')));
`,
  );
  const nativeEnv = await nativeActorEnvironment(
    root,
    Object.fromEntries(
      ['test', 'repair', 'review'].map((role) => [role, [process.execPath, producer, role]]),
    ),
  );
  const processPath = new URL('../../shared/process.ts', import.meta.url).pathname;
  const targetPath = new URL('./target.ts', import.meta.url).pathname;
  await writeFile(
    preload,
    `import {mock} from 'bun:test';
import * as module from ${JSON.stringify(processPath)};
import {githubTarget} from ${JSON.stringify(targetPath)};
import {readFile,writeFile,appendFile} from 'node:fs/promises';
const original={...module}, execute=module.command;
const control=${JSON.stringify(control)},log=${JSON.stringify(log)};
mock.module(${JSON.stringify(processPath)},()=>({...original,command:async(argv,cwd,input,timeout,prefix,env)=>{
 const c=JSON.parse(await readFile(control,'utf8'));
 let stdout,code=0;
 if(argv[0]==='ps') {
  const start=argv.at(-1).includes('lstart')?'Thu Jan 1 00:00:00 2026 ':'';
  stdout='1 0 '+start+'/sbin/launchd\\n';
  if(c.live) stdout+='424242 1 '+start+'bun codex-actor.ts repair '+${JSON.stringify(prior)}+'\\n';
  if(c.unavailable) code=1;
 }
 if(argv[0]==='git'&&argv.includes('ls-remote')&&!argv.includes('--get-url')) stdout=c.pr?(c.remote??c.pr.headRefOid)+'\\trefs/heads/'+c.pr.headRefName+'\\n':'';
 if(argv[0]==='gh') {
  await appendFile(log,JSON.stringify({role:'github',argv})+'\\n');
  if(argv[1]==='issue') stdout=${JSON.stringify(issue)};
  else if(argv[1]==='pr'&&argv[2]==='view') stdout=JSON.stringify(c.pr);
  else if(argv[1]==='pr'&&argv[2]==='edit') {
   c.pr.body=await readFile(argv[argv.indexOf('--body-file')+1],'utf8');
   await writeFile(control,JSON.stringify(c));stdout='';
  } else if(argv[2]?.includes('/git/ref/')) stdout=JSON.stringify({object:{sha:c.remote??c.pr.headRefOid}});
  else if(argv[2]?.endsWith('/pulls/100')) stdout=JSON.stringify({html_url:c.pr.url,state:c.pr.state.toLowerCase(),draft:c.pr.isDraft,user:c.pr.author,head:{ref:c.pr.headRefName,sha:c.pr.headRefOid,repo:{full_name:'team/component'}},base:{ref:c.pr.baseRefName,repo:{full_name:'team/component'}},body:c.pr.body});
  else if(argv[2]?.endsWith('/pulls')) stdout=JSON.stringify(c.pr?[[{number:100,html_url:c.pr.url,state:'open',draft:c.pr.isDraft,head:{ref:c.pr.headRefName,sha:c.pr.headRefOid,repo:{full_name:'team/component'}},base:{ref:c.pr.baseRefName},body:c.pr.body}]]:[[]]);
  else {
   stdout=githubTarget(argv,${JSON.stringify(settings)});
   if(argv[2]==='user'&&c.actor) stdout=JSON.stringify({login:c.actor});
   if(argv[2]==='repos/team/component'&&c.denied) stdout=JSON.stringify({full_name:'team/component',id:123,permissions:{push:false}});
  }
  if(stdout===undefined) throw Error('Unexpected GitHub command '+argv.join(' '));
 }
 if(argv[0]==='git'&&argv.includes('push')) {
  await appendFile(log,JSON.stringify({role:'push',argv})+'\\n');
  c.pr.headRefOid=(await execute(['git','rev-parse','HEAD'],cwd,'',10000)).stdout.trim();
  c.remote=c.pr.headRefOid;await writeFile(control,JSON.stringify(c));stdout='';
 }
 if(argv[1]?.endsWith('/codex-actor.ts')) return execute(argv,cwd,input,timeout,prefix,{...process.env,...env,...${JSON.stringify(nativeEnv)},DOTAGENTS_ACTOR_PREFIX:prefix,FIXTURE_HOST_PID:String(process.pid)});
 if(argv[0]==='sh') await appendFile(log,JSON.stringify({role:'check',argv})+'\\n');
 if(stdout!==undefined) {
  if(prefix) {await writeFile(prefix+'.stdout',stdout);await writeFile(prefix+'.stderr','');}
  return {code,stdout,stderr:code?'fixture process observation unavailable':'',timedOut:false,ms:1};
 }
 return execute(argv,cwd,input,timeout,prefix,env);
}}));`,
  );
  const cli = async (args: string[]) => {
    const result = await command(
      [
        process.execPath,
        '--preload',
        preload,
        new URL('../../implement/development.ts', import.meta.url).pathname,
        ...args,
      ],
      repo,
      '',
      30000,
    );
    assert(!result.timedOut, result.stderr);
    return result;
  };
  const origin = await cli([
    '99',
    '--repo',
    repo,
    '--run-dir',
    initial,
    '--no-publish',
    '--start-commit',
    base,
    '--report',
    `${report}=${blob}`,
  ]);
  if (interruptedHistory) {
    assert.equal(origin.code, 1, origin.stderr);
    assert.match(origin.stderr, /Interrupted execution/);
    await writeFile(control, '{}');
    const resumed = await cli([
      '99',
      '--repo',
      checkout,
      '--interrupted-run',
      initial,
      '--run-dir',
      prior,
      '--no-publish',
    ]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(object(JSON.parse(resumed.stdout)).status, 'verified_local');
  } else {
    assert.equal(origin.code, 0, origin.stderr);
    assert.equal(object(JSON.parse(origin.stdout)).status, 'verified_local');
  }
  // 単独公開を外部事実として準備する。旧resultやstateを公開済みに書き換えない。
  git(repo, 'clone', checkout, published);
  if (publicBranch) {
    git(published, 'checkout', '-b', publicBranch);
  }
  for (const name of ['result.txt', 'deliverable.txt', report]) {
    await writeFile(join(published, name), await readFile(join(checkout, name)));
  }
  git(published, 'config', 'user.email', 'test@example.com');
  git(published, 'config', 'user.name', 'Test');
  git(published, 'remote', 'add', 'upstream', 'https://github.com/team/component.git');
  git(published, 'add', '.');
  git(published, 'commit', '-m', '単独公開の合成成果物');
  const pr = {
    url: 'https://github.com/team/component/pull/100',
    state: 'OPEN',
    isDraft: true,
    author: { login: 'operator' },
    headRefName: git(published, 'branch', '--show-current'),
    headRefOid: git(published, 'rev-parse', 'HEAD'),
    baseRefName: 'release',
    headRepository: { name: 'component' },
    headRepositoryOwner: { login: 'team' },
    isCrossRepository: false,
    body: 'Closes #99\n単独公開した成果物。',
    closingIssuesReferences: [],
    statusCheckRollup: [{ name: 'checks', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  await writeFile(control, JSON.stringify({ pr }));
  await writeFile(log, '');
  return {
    root,
    initial,
    base,
    report,
    blob,
    repo,
    prior,
    checkout,
    published,
    dir,
    request,
    control,
    pr,
    cli,
    args: [
      '99',
      '--repo',
      published,
      '--adopt-local-run',
      prior,
      '--adopt-pr',
      pr.url,
      '--request-file',
      request,
      '--run-dir',
      dir,
      '--allow-publish',
    ],
    async observations() {
      return (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)));
    },
    async changeControl(change: Record<string, unknown>) {
      await writeFile(
        control,
        JSON.stringify({ ...object(JSON.parse(await readFile(control, 'utf8'))), ...change }),
      );
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
