import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command } from '../../shared/process.ts';
import { object, reviewReplySource } from './correction.ts';
import { issue } from './development.ts';
import type { DevelopmentFixture } from './development.ts';

// 外部観測だけを子CLIで置換し、受付から各工程への接続は公開入口を通す。
export async function genericHostCli(
  f: DevelopmentFixture,
  args: string[],
  observation: string,
  boundary: 'intake' | 'setup' | 'test' | 'check',
) {
  const root = dirname(f.dir);
  const log = join(root, 'generic-observations.jsonl');
  const preload = join(root, 'generic-preload.ts');
  const actor = join(root, 'generic-actor.ts');
  const active = join(root, 'generic-active');
  const modulePath = new URL('../../shared/process.ts', import.meta.url).pathname;
  const targetPath = new URL('./target.ts', import.meta.url).pathname;
  await writeFile(log, '');
  await writeFile(
    actor,
    `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
const prompt=role==='test'?readFileSync(0,'utf8'):'';
if(role==='repair') throw Error('Unexpected repeated implementation');
const input=role==='test'?JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]):undefined;
appendFileSync(${JSON.stringify(log)},JSON.stringify({role,input})+'\\n');
if(role==='test'&&${JSON.stringify(boundary)}==='test') writeFileSync(${JSON.stringify(active)},'');
console.log(JSON.stringify(role==='test'?{targetId:input.targetId,status:'unnecessary',findings:'固定要求の模擬検証。',files:[]}:reviewReply('accepted','模擬検証。')));
`,
  );
  await writeFile(
    preload,
    `import {mock} from 'bun:test';
import * as processModule from ${JSON.stringify(modulePath)};
import {githubTarget} from ${JSON.stringify(targetPath)};
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
const original={...processModule}, realCommand=processModule.command;
const log=${JSON.stringify(log)},active=${JSON.stringify(active)};
const observation=${JSON.stringify(observation)},boundary=${JSON.stringify(boundary)};
mock.module(${JSON.stringify(modulePath)},()=>({...original,command:async(argv,cwd,input,timeout,prefix,env)=>{
 const unsafe=boundary==='intake'||existsSync(active);
 let stdout,code=0;
 if(argv[0]==='ps') {
  const start=argv.at(-1).includes('lstart')?'Thu Jan 1 00:00:00 2026 ':'';
  stdout='1 0 '+start+'/sbin/launchd\\n';
  if(unsafe&&observation==='live') stdout+='424242 1 '+start+'bun codex-actor.ts test '+${JSON.stringify(f.dir)}+'\\n';
  if(unsafe&&observation==='process-unavailable') code=1;
 }
 if(argv[0]==='git'&&argv.includes('ls-remote')&&!argv.includes('--get-url')) {
  stdout=unsafe&&observation==='remote'?'a'.repeat(40)+'\\trefs/heads/codex/development-99\\n':'';
  if(unsafe&&observation==='remote-unavailable') code=1;
 }
 if(argv[0]==='gh') {
  if(argv[1]==='issue') stdout=${JSON.stringify(issue)};
  else if(argv[2]?.endsWith('/pulls')) {
   stdout=JSON.stringify(unsafe&&observation==='pr'?[[{number:100,state:'closed',html_url:'https://github.com/'+${JSON.stringify(f.settings.repository)}+'/pull/100',head:{ref:'codex/development-99',sha:'a'.repeat(40),repo:{full_name:${JSON.stringify(f.settings.repository)}}}}]]:[[]]);
   if(unsafe&&observation==='github-malformed') stdout='not-json';
  } else stdout=githubTarget(argv,${JSON.stringify(f.settings)});
  if(stdout===undefined) throw Error('Unexpected GitHub operation');
 }
 if(argv[0]==='git'&&argv.includes('push')) throw Error('Unexpected publication');
 if(argv[1]?.endsWith('/codex-actor.ts')) return realCommand([process.execPath,${JSON.stringify(actor)},argv[2]],cwd,input,timeout,prefix,env);
 let role;
 if(argv[0]==='sh'&&argv[2]==='printf configured > setup.txt') role='setup';
 if(argv[0]==='sh'&&argv[2]?.includes('cat result.txt')) role='check';
 if(role) await appendFile(log,JSON.stringify({role})+'\\n');
 if(stdout!==undefined) {
  await appendFile(log,JSON.stringify({role:'observation',argv,cwd,code,stdout,unsafe})+'\\n');
  if(prefix) {await writeFile(prefix+'.stdout',stdout);await writeFile(prefix+'.stderr','');}
  return {code,stdout,stderr:code?'fixture observation unavailable':'',timedOut:false,ms:1};
 }
 const result=await realCommand(argv,cwd,input,timeout,prefix,env);
 if(role===boundary) await writeFile(active,'');
 return result;
}}));`,
  );
  const result = await command(
    [
      process.execPath,
      '--preload',
      preload,
      new URL('../../implement/development.ts', import.meta.url).pathname,
      ...args,
    ],
    f.repo,
    '',
    20000,
  );
  assert(!result.timedOut, result.stderr);
  const calls = (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => object(JSON.parse(line)));
  return { result, calls };
}

const diagnostics: Record<string, RegExp> = {
  live: /プロセス|process/i,
  'management-lock': /lock|ロック/i,
  'git-lock': /lock|ロック/i,
  'git-ref-lock': /lock|ロック/i,
  'git-worktree-lock': /lock|ロック/i,
  remote: /remote ref|公開/i,
  pr: /PR|GitHub|公開/i,
  'github-malformed': /PR|GitHub|JSON|公開/i,
  'process-unavailable': /観測|observation|process/i,
  'remote-unavailable': /観測|observation|remote/i,
};
const allowedRoles = {
  intake: [],
  setup: ['setup'],
  test: ['setup', 'test'],
  check: ['setup', 'test', 'check'],
};
export function expectGenericHostResult(
  { result, calls }: Awaited<ReturnType<typeof genericHostCli>>,
  observation: string,
  boundary: keyof typeof allowedRoles,
) {
  const roles = calls.filter((call) => call.role !== 'observation').map((call) => call.role);
  if (observation === 'safe') {
    assert.equal(result.code, 0, result.stderr);
    expect(object(JSON.parse(result.stdout))).toMatchObject({
      status: 'verified_local',
      publication: 'not_attempted',
    });
    expect(roles.filter((role) => role !== 'setup')).toEqual(['test', 'check', 'review']);
    return;
  }
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, diagnostics[observation] ?? /観測/);
  assert.doesNotMatch(
    result.stderr,
    /Cannot find|Unknown option|ENOENT|Host handoff configuration differs|ReferenceError|SyntaxError/,
  );
  for (const role of roles) {
    expect(allowedRoles[boundary]).toContain(String(role));
  }
  if (boundary !== 'intake') {
    expect(roles).toContain(boundary);
  }
  if (!observation.endsWith('lock')) {
    const executable =
      observation === 'live' || observation === 'process-unavailable'
        ? 'ps'
        : observation.startsWith('remote')
          ? 'git'
          : 'gh';
    expect(
      calls.some(
        (call) =>
          call.role === 'observation' &&
          call.unsafe &&
          Array.isArray(call.argv) &&
          call.argv[0] === executable,
      ),
    ).toBe(true);
  }
}
