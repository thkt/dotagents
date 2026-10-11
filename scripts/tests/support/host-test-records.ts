import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { authorTests } from '../../implement/test-author.ts';
import { hash } from '../../implement/host-records.ts';
import { snapshot } from '../../implement/correction.ts';
import { command } from '../../shared/process.ts';
import { issue } from './development.ts';
import type { DevelopmentFixture } from './development.ts';
import { object, reviewReplySource } from './correction.ts';

export const asset = 'external-result.test.js';
export const assetSource =
  "import {readFileSync} from 'node:fs'; process.exit(readFileSync('result.txt','utf8')==='implemented'?0:1);\n";

export async function hostTestFixture(f: DevelopmentFixture, status = 'prepared') {
  const root = dirname(f.dir);
  const control = join(root, 'test-control.json');
  const observations = join(root, 'cli-observations.jsonl');
  const script = join(root, 'host-actors.js');
  await writeFile(control, JSON.stringify({ pending: true }));
  await writeFile(observations, '');
  await writeFile(
    script,
    `import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
const control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
if(role==='test') {
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 appendFileSync(${JSON.stringify(observations)},JSON.stringify({role,prompt,asset:existsSync(${JSON.stringify(asset)})?readFileSync(${JSON.stringify(asset)},'utf8'):null,result:readFileSync('result.txt','utf8')})+'\\n');
 console.log(JSON.stringify({targetId:input.targetId,status:control.pending?'needs_host':'unnecessary',findings:'模擬工程。固定した要求からテスト資産を再判定する。',files:[]}));
}
if(role==='repair') {
 appendFileSync(${JSON.stringify(observations)},JSON.stringify({role})+'\\n');
 writeFileSync('result.txt','implemented');
 console.log(JSON.stringify({status:'repaired',findings:'IMPLEMENTATION_PRIVATE_SENTINEL'}));
}
if(role==='review') {
 appendFileSync(${JSON.stringify(observations)},JSON.stringify({role})+'\\n');
 console.log(JSON.stringify(reviewReply('accepted','模擬評価。実モデルの判断は未確認。')));
}`,
  );
  const preload = join(root, 'host-cli.ts');
  const processPath = new URL('../../shared/process.ts', import.meta.url).pathname;
  const targetPath = new URL('./target.ts', import.meta.url).pathname;
  await writeFile(
    preload,
    `import {mock} from 'bun:test';
import * as processModule from ${JSON.stringify(processPath)};
import {writeFile,appendFile} from 'node:fs/promises';
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
 if(argv[0]==='git'&&argv.includes('push')) {
  await appendFile(${JSON.stringify(observations)},JSON.stringify({role:'publish'})+'\\n');
  throw Error('Unexpected publication');
 }
 if(argv[1]?.endsWith('/codex-actor.ts')) return realCommand([process.execPath,${JSON.stringify(script)},argv[2]],cwd,input,timeout,prefix,env);
 return realCommand(argv,cwd,input,timeout,prefix,env);
}}));`,
  );
  const cli = (args: string[]) =>
    command(
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
  const stopped = await cli([...f.args, '--no-publish']);
  expect(stopped.timedOut).toBe(false);
  expect(stopped.code).toBe(1);
  expect(stopped.stderr).toMatch(/Host verification required|ホスト/i);
  const cwd = join(f.dir, 'checkout');
  const config = object(
    JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
  );
  const external = join(root, 'external-preparation');
  await mkdir(external);
  const prefix = join(external, 'test-1');
  assert(typeof config.testBaseline === 'string' && typeof config.baseCommit === 'string');
  const prepared = await authorTests(
    {
      cwd,
      baseline: config.testBaseline,
      prefix,
      issue,
      baseCommit: config.baseCommit,
      check: f.settings.check,
      setup: f.settings.setup,
      actor: ['external-test-fixture'],
      previous: [],
    },
    async (argv, work, prompt, timeout, output) => {
      if (argv[0] !== 'external-test-fixture') {
        return command(argv, work, prompt, timeout, output);
      }
      const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
      if (status === 'prepared') {
        await writeFile(join(work, asset), assetSource, { mode: 0o755 });
      }
      const stdout = JSON.stringify({
        targetId: input.targetId,
        status,
        findings: 'EXTERNAL_PRIVATE_SENTINEL: 要求したresult値を確認する独立資産。',
        files: status === 'prepared' ? [asset] : [],
      });
      assert(output);
      await writeFile(`${output}.stdout`, stdout);
      await writeFile(`${output}.stderr`, '');
      return { code: 0, stdout, stderr: '', timedOut: false, ms: 1 };
    },
  );
  const recordPath = `${prefix}.json`;
  const record = object(JSON.parse(await readFile(recordPath, 'utf8')));
  const ref = { path: recordPath, sha256: hash(await readFile(recordPath)) };
  const evidence = {
    status: 'passed',
    source: await snapshot(cwd),
    findings: '模擬ホスト支援。受入は新しいcheck・独立評価で判断する。',
    logs: [ref],
    testRecords: [ref],
  };
  const evidenceFile = join(root, 'external-evidence.json');
  const dir = join(root, 'external-return');
  const args = [
    '99',
    '--repo',
    cwd,
    '--host-run',
    f.dir,
    '--host-evidence',
    evidenceFile,
    '--run-dir',
    dir,
    '--no-publish',
  ];
  await writeFile(control, JSON.stringify({ pending: false }));
  await writeFile(observations, '');
  return {
    cwd,
    dir,
    external,
    prefix,
    recordPath,
    record,
    ref,
    evidence,
    evidenceFile,
    args,
    cli,
    observations,
    prepared,
  };
}
