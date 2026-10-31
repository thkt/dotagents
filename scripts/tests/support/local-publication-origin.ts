import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { cp, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command } from '../../shared/process.ts';
import { hash } from '../../implement/host-records.ts';
import { snapshot } from '../../implement/correction.ts';
import { object, reviewReplySource } from './correction.ts';
import { issue } from './development.ts';
import type { DevelopmentFixture } from './development.ts';
import { formalHostFixture, formalTree } from './formal-host-return.ts';
import { nativeActorEnvironment } from './native-actor.ts';
import { git } from './target.ts';
import { contractArgs } from './human-decision-contract.ts';

export async function localPublicationOrigin(f: DevelopmentFixture, human: boolean) {
  const lineage = await formalHostFixture(f, { producer: '430' });
  await writeFile(lineage.control, JSON.stringify({ phase: 'accept', testHuman: human }));
  const host = await lineage.intake(lineage.r1, 'origin-host-return');
  const result = await lineage.generateCli(host.args);
  assert.equal(result.code, human ? 1 : 0, result.stderr);
  expect(result.timedOut).toBe(false);
  let prior = host.dir;
  if (human) {
    const stopped = object(JSON.parse(await readFile(join(prior, 'result.json'), 'utf8')));
    expect(stopped).toMatchObject({ reasonCode: 'human_decision_required', terminal: true });
    const file = join(dirname(f.dir), 'origin-supplement.json');
    const agreement = {
      format: 1,
      issue: `https://github.com/${f.settings.repository}/issues/99`,
      issueUpdatedAt: '1',
      issueSha256: hash(issue),
      source: '人が採用した模擬補足合意: local-publication-origin',
      content: '正式停止後は新しい独立判断を行い、実行済みの初回実装を繰り返さない。',
      decision: 'この補足を模擬Issueの版1へ適用する。',
    };
    await writeFile(file, JSON.stringify(agreement));
    const dir = join(dirname(f.dir), 'origin-human-return');
    const values: Record<string, string> = {
      ISSUE_NUMBER: '99',
      CURRENT_CHECKOUT: lineage.cwd,
      LATEST_ELIGIBLE_STOP: prior,
      EXTERNAL_REGULAR_SUPPLEMENT_JSON: file,
      UNUSED_SIBLING_RUN: dir,
    };
    await writeFile(lineage.control, JSON.stringify({ phase: 'accept' }));
    const resumed = await lineage.cli(contractArgs(values));
    assert.equal(resumed.code, 0, resumed.stderr);
    expect(resumed.timedOut).toBe(false);
    prior = dir;
  }
  const json = async (path: string) => object(JSON.parse(await readFile(path, 'utf8')));
  expect(await json(join(prior, 'result.json'))).toMatchObject({
    status: 'verified_local',
    terminal: true,
    localOnly: true,
    publication: 'not_attempted',
  });
  const state = await json(join(prior, 'verification/state.json'));
  expect(state).toMatchObject({ active: null, result: 'ready_for_human_review' });
  assert(Array.isArray(state.reviewHistory));
  expect(object(state.reviewHistory.at(-1)).status).toBe('accepted');
  expect((await lineage.observations()).filter((call) => call.role === 'repair')).toHaveLength(1);
  const implementation = join(lineage.r1, 'implementation.json');
  expect(await json(implementation)).toMatchObject({ code: 0, timedOut: false });
  const config = await json(join(prior, 'verification-config.json'));
  const decision = human ? object(config.humanDecision) : null;
  const supplements: string[] = [];
  if (decision) {
    const supplement = object(decision.supplement);
    assert(typeof supplement.path === 'string');
    supplements.push(supplement.path);
    assert(Array.isArray(decision.roots));
    const kinds = await Promise.all(
      decision.roots.map(async (path) => {
        assert(typeof path === 'string');
        return (await lstat(path)).isFile() ? 'file' : 'directory';
      }),
    );
    expect(kinds).toContain('file');
    expect(kinds).toContain('directory');
    assert(Array.isArray(decision.records));
    for (const value of decision.records) {
      const record = object(value);
      if (record.kind !== 'file') {
        continue;
      }
      assert(
        typeof record.path === 'string' &&
          typeof record.mode === 'number' &&
          typeof record.value === 'string',
      );
      expect((await lstat(record.path)).mode).toBe(record.mode);
      expect(hash(await readFile(record.path))).toBe(record.value);
    }
  }
  // 単独公開の外部事実だけを作る。受入run・state・原応答は補正しない。
  const root = dirname(f.dir);
  const published = join(root, 'origin-published');
  git(root, 'clone', lineage.cwd, published);
  for (const name of await readdir(lineage.cwd)) {
    if (name !== '.git') {
      await cp(join(lineage.cwd, name), join(published, name), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  }
  git(published, 'config', 'user.email', 'test@example.com');
  git(published, 'config', 'user.name', 'Test');
  git(published, 'remote', 'add', 'upstream', 'https://github.com/team/component.git');
  git(published, 'add', '.');
  git(published, 'commit', '-m', '正式復帰後の合成成果物の単独公開');
  expect(await snapshot(published)).toBe(await snapshot(lineage.cwd));
  expect(git(published, 'status', '--porcelain', '--untracked-files=all')).toBe('');
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
  const request = join(root, 'origin-request.txt');
  await writeFile(
    request,
    '人が採用した修正要求: revision.txtを追加する。同じPR・branchの修正と公開を明示的に許可する。',
  );
  const log = join(root, 'origin-calls.jsonl');
  const producer = join(root, 'origin-producer.ts');
  const control = join(root, 'origin-publication.json');
  const preload = join(root, 'origin-preload.ts');
  await writeFile(log, '');
  await writeFile(control, JSON.stringify(pr));
  await writeFile(
    producer,
    `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const role=process.argv[2],prompt=readFileSync(0,'utf8');
${reviewReplySource.replaceAll("readFileSync(0,'utf8')", 'prompt')}
appendFileSync(${JSON.stringify(log)},JSON.stringify({role,prompt,cwd:process.cwd()})+'\\n');
if(role==='test') {const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'合成課題の既存checkを維持する。',files:[]}));}
if(role==='repair') {writeFileSync('revision.txt','new correction');console.log(JSON.stringify({status:'repaired',findings:'採用した追加修正。'}));}
if(role==='review') console.log(JSON.stringify(reviewReply('accepted','現在版の合成評価。')));
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
const original={...module},execute=module.command,control=${JSON.stringify(control)},log=${JSON.stringify(log)};
mock.module(${JSON.stringify(processPath)},()=>({...original,command:async(argv,cwd,input,timeout,prefix,env)=>{
 const pr=JSON.parse(await readFile(control,'utf8'));let stdout;
 if(argv[0]==='ps') stdout='1 0 '+(argv.at(-1).includes('lstart')?'Thu Jan 1 00:00:00 2026 ':'')+'/sbin/launchd\\n';
 if(argv[0]==='git'&&argv.includes('ls-remote')&&!argv.includes('--get-url')) stdout=pr.headRefOid+'\\trefs/heads/'+pr.headRefName+'\\n';
 if(argv[0]==='gh') {
  await appendFile(log,JSON.stringify({role:'github',argv})+'\\n');
  if(argv[1]==='issue') stdout=${JSON.stringify(issue)};
  else if(argv[1]==='pr'&&argv[2]==='view') stdout=JSON.stringify(pr);
  else if(argv[1]==='pr'&&argv[2]==='edit') {pr.body=await readFile(argv[argv.indexOf('--body-file')+1],'utf8');await writeFile(control,JSON.stringify(pr));stdout='';}
  else if(argv[2]?.includes('/git/ref/')) stdout=JSON.stringify({object:{sha:pr.headRefOid}});
  else if(argv[2]?.endsWith('/pulls/100')) stdout=JSON.stringify({html_url:pr.url,state:'open',draft:true,user:pr.author,head:{ref:pr.headRefName,sha:pr.headRefOid,repo:{full_name:'team/component'}},base:{ref:pr.baseRefName,repo:{full_name:'team/component'}},body:pr.body});
  else if(argv[2]?.endsWith('/pulls')) stdout=JSON.stringify([[{number:100,html_url:pr.url,state:'open',draft:true,head:{ref:pr.headRefName,sha:pr.headRefOid,repo:{full_name:'team/component'}},base:{ref:pr.baseRefName},body:pr.body}]]);
  else stdout=githubTarget(argv,${JSON.stringify(f.settings)});
  if(stdout===undefined) throw Error('Unexpected GitHub command '+argv.join(' '));
 }
 if(argv[0]==='git'&&argv.includes('push')) {await appendFile(log,JSON.stringify({role:'push',argv})+'\\n');pr.headRefOid=(await execute(['git','rev-parse','HEAD'],cwd,'',10000)).stdout.trim();await writeFile(control,JSON.stringify(pr));stdout='';}
 if(argv[1]?.endsWith('/codex-actor.ts')) return execute(argv,cwd,input,timeout,prefix,{...process.env,...env,...${JSON.stringify(nativeEnv)},DOTAGENTS_ACTOR_PREFIX:prefix});
 if(argv[0]==='sh') await appendFile(log,JSON.stringify({role:'check'})+'\\n');
 if(stdout!==undefined) {if(prefix) {await writeFile(prefix+'.stdout',stdout);await writeFile(prefix+'.stderr','');}return {code:0,stdout,stderr:'',timedOut:false,ms:1};}
 return execute(argv,cwd,input,timeout,prefix,env);
}}));`,
  );
  const dir = join(root, 'origin-revision');
  return {
    lineage,
    prior,
    host,
    decision,
    implementation,
    published,
    pr,
    dir,
    request,
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
    cli: (args: string[]) =>
      command(
        [
          process.execPath,
          '--preload',
          preload,
          new URL('../../implement/development.ts', import.meta.url).pathname,
          ...args,
        ],
        published,
        '',
        30000,
      ),
    observations: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line))),
    retained: () =>
      Promise.all([
        formalTree(f.dir),
        formalTree(lineage.r1, true),
        formalTree(host.dir, true),
        formalTree(prior, true),
        formalTree(lineage.cwd),
        formalTree(host.evidenceFile),
        ...host.evidence.logs.map((ref) => formalTree(ref.path)),
        ...supplements.map((path) => formalTree(path)),
      ]),
  };
}
