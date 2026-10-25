import assert from 'node:assert/strict';
import { z } from 'zod';
import { expect, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { develop } from '../../implement/orchestrator.ts';
import { testReplySchema } from '../../implement/test-author.ts';
import { snapshot } from '../../implement/correction.ts';
import { hash } from '../../implement/host-records.ts';
import { command } from '../../shared/process.ts';
import { saveActorRecord } from './actor-records.ts';
import { object, reviewReplySource } from './correction.ts';
import { gitOutput, issue, ok } from './development.ts';
import type { DevelopmentFixture } from './development.ts';
import { nativeActorEnvironment } from './native-actor.ts';
import { fixedHostGenerator } from './fixed-host-generator.ts';

// #428の受理済み合成fixtureと同じ保存障害を使う。成功記録の削除で中断を作らない。
async function interruptedOrigin(f: DevelopmentFixture, generate: typeof develop) {
  f.test = async (_argv, workspace, prompt, _timeout, prefix) => {
    assert(prefix);
    const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
    await fs.writeFile(join(workspace, 'unadopted.test.js'), 'throw Error("OLD_ASSET");\n', {
      mode: 0o750,
    });
    const stdout = JSON.stringify({
      targetId: input.targetId,
      status: 'prepared',
      findings: 'OLD_PRIVATE_JUDGMENT',
      files: ['unadopted.test.js'],
    });
    const actor = dirname(await saveActorRecord(f.dir, prefix, 'test', 'interrupted'));
    await fs.writeFile(join(actor, 'schema.json'), JSON.stringify(testReplySchema));
    await fs.writeFile(join(actor, 'final.json'), stdout);
    await fs.writeFile(join(actor, 'stderr.log'), '');
    await fs.writeFile(
      join(actor, 'events.jsonl'),
      [
        { type: 'thread.started', thread_id: 'fixture-test' },
        { type: 'item.completed', item: { type: 'agent_message', text: stdout } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );
    await fs.writeFile(`${prefix}.stdout`, stdout);
    await fs.writeFile(`${prefix}.stderr`, '');
    return ok(stdout);
  };
  const write = fs.writeFile;
  const failure = spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (
      typeof args[0] === 'string' &&
      [join(f.dir, 'test-1.execution.json'), join(f.dir, 'result.json.tmp')].includes(args[0])
    ) {
      throw Error('fixture: host storage unavailable');
    }
    return write(...args);
  });
  try {
    await assert.rejects(
      () => generate([...f.args, '--no-publish'], f.io),
      /host storage unavailable/,
    );
  } finally {
    failure.mockRestore();
  }
  expect(f.calls.implementations).toBe(0);
  for (const name of ['result.json', 'test-1.execution.json', 'test-1.json']) {
    expect(await Bun.file(join(f.dir, name)).exists()).toBe(false);
  }
}

// 原記録の内容・全mode・symlinkを観測する。.git参照ファイルは通常のbytesとして読む。
// 原runのidentityと現在checkoutを混同しない。正式停止runでは現在checkoutだけを除く。
export async function formalTree(path: string, omitCheckout = false): Promise<unknown> {
  const info = await fs.lstat(path);
  if (info.isSymbolicLink()) {
    return [info.mode, await fs.readlink(path)];
  }
  if (info.isFile()) {
    return [info.mode, hash(await fs.readFile(path))];
  }
  assert(info.isDirectory());
  const entries = [];
  for (const name of (await fs.readdir(path)).sort()) {
    if (omitCheckout && name === 'checkout') {
      continue;
    }
    entries.push([name, await formalTree(join(path, name))]);
  }
  return [info.mode, entries];
}

export async function formalHostFixture(
  f: DevelopmentFixture,
  options: {
    pendingImplementation?: boolean;
    dependencyLock?: boolean;
    nestedDependency?: boolean;
    producer?: '430';
  } = {},
) {
  const root = dirname(f.dir);
  const generator = await fixedHostGenerator(root);
  const entry = join(generator, 'scripts/implement/development.ts');
  const { develop: generate } = z
    .object({ develop: z.custom<typeof develop>((value) => typeof value === 'function') })
    .parse(await import(join(generator, 'scripts/implement/orchestrator.ts')));
  if (options.nestedDependency) {
    await fs.mkdir(join(f.repo, 'evaluation'));
    await fs.writeFile(join(f.repo, 'evaluation/uv.lock'), 'version = 1\nrevision = 3\n');
    await fs.chmod(join(f.repo, 'evaluation/uv.lock'), 0o644);
    await gitOutput(f.repo, 'add', 'evaluation/uv.lock');
    await gitOutput(f.repo, 'commit', '-m', '模擬依存manifestの入力');
  }
  if (options.dependencyLock) {
    // 依存lockfileをsetupで作り、保存後の祖先へ後付けしない。
    f.settings.setup.push(['sh', '-c', 'printf dependency > bun.lock']);
    await fs.writeFile(join(f.repo, '.dotagents.json'), JSON.stringify(f.settings));
    await gitOutput(f.repo, 'add', '.dotagents.json');
    await gitOutput(f.repo, 'commit', '-m', '模擬依存lockfileのsetup');
  }
  await interruptedOrigin(f, generate);
  const control = join(root, 'formal-control.json');
  const calls = join(root, 'formal-calls.jsonl');
  const preload = join(root, 'formal-preload.ts');
  const processPath = new URL('../../shared/process.ts', import.meta.url).pathname;
  const targetPath = new URL('./target.ts', import.meta.url).pathname;
  const producer = join(root, 'formal-producer.js');
  await fs.writeFile(calls, '');
  await fs.writeFile(
    control,
    JSON.stringify({ phase: options.pendingImplementation ? 'test-stop' : 'implementation' }),
  );
  await fs.writeFile(
    producer,
    `import {readFileSync,writeFileSync,appendFileSync,existsSync,chmodSync} from 'node:fs';
const role=process.argv[2];
const prompt=readFileSync(0,'utf8');
${reviewReplySource.replaceAll("readFileSync(0,'utf8')", 'prompt')}
const control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
if(role==='test') {
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 appendFileSync(${JSON.stringify(calls)},JSON.stringify({role,prompt,input,result:readFileSync('result.txt','utf8'),oldAsset:existsSync('unadopted.test.js')})+'\\n');
 console.log(JSON.stringify({targetId:input.targetId,status:control.testHuman?'needs_human':control.phase==='test-stop'?'needs_host':'unnecessary',findings:'固定要求の模擬ホスト検証。',files:[]}));
} else {
 appendFileSync(${JSON.stringify(calls)},JSON.stringify({role,prompt})+'\\n');
 if(role==='repair') {
  writeFileSync('result.txt','implemented');
  if(control.changeImplementation) chmodSync(control.changeImplementation,0o700);
  console.log(JSON.stringify({status:'needs_host',findings:'模擬ホスト検証の新しい証拠が必要です。'}));
 }
 // 評価中に別プロセスが祖先を変えた状況を注入し、応答自体は正常に保つ。
 if(role==='review') {
  if(control.changeReview) chmodSync(control.changeReview,0o700);
  console.log(JSON.stringify(reviewReply(control.phase==='accept'?'accepted':'needs_changes','現在版の模擬評価。')));
 }
}
`,
  );
  const nativeEnv =
    options.producer === '430'
      ? await nativeActorEnvironment(
          root,
          Object.fromEntries(
            ['test', 'repair', 'review'].map((role) => [role, [process.execPath, producer, role]]),
          ),
        )
      : null;
  await fs.writeFile(
    preload,
    `import {mock} from 'bun:test';
import * as processModule from ${JSON.stringify(processPath)};
import {githubTarget} from ${JSON.stringify(targetPath)};
import {writeFile,readFile,appendFile,chmod} from 'node:fs/promises';
const original={...processModule};
const realCommand=processModule.command;
mock.module(${JSON.stringify(processPath)},()=>({...original,command:async(argv,cwd,input,timeout,prefix,env)=>{
 const control=JSON.parse(await readFile(${JSON.stringify(control)},'utf8'));
 let stdout;
 if(argv[0]==='ps') {
  if(control.observation==='unavailable') return {code:1,stdout:'',stderr:'fixture observation unavailable',timedOut:false,ms:1};
  const start=argv.at(-1).includes('lstart')?'Thu Jan 1 00:00:00 2026 ':'';
  stdout='1 0 '+start+'/sbin/launchd\\n';
  if(control.observation==='live') stdout+='424242 1 '+start+'bun codex-actor.ts test '+${JSON.stringify(f.dir)}+'\\n';
  if(['returning','other-entry','other-directory','other-repo'].includes(control.observation)) {
   const option=control.observation==='other-entry'?'--host-run':control.observation==='other-directory'?'--run-dir':control.observation==='other-repo'?'--repo':undefined;
   const args=process.argv.slice(1).map(value=>value===option?'--other'+value:value);
   stdout+=process.ppid+' 0 '+start+'bun '+args.map(value=>value.startsWith('--')?value:JSON.stringify(value)).join(' ')+'\\n';
  }
 }
 if(argv[0]==='git'&&argv.includes('ls-remote')) stdout=control.observation==='remote'?'a'.repeat(40)+'\\trefs/heads/codex/development-99\\n':'';
 if(argv[0]==='gh') {
  if(argv[1]==='issue') stdout=${JSON.stringify(issue)};
  else if(argv[2]?.endsWith('/pulls')) stdout=JSON.stringify(control.observation==='pr'?[[{number:100,state:'closed'}]]:[[]]);
  else stdout=githubTarget(argv,${JSON.stringify(f.settings)});
  if(stdout===undefined) throw Error('Unexpected GitHub operation');
 }
 if(argv[0]==='git'&&argv.includes('push')) throw Error('Unexpected publication');
 if(argv[1]?.endsWith('/codex-actor.ts')) return ${JSON.stringify(options.producer === '430')} ? realCommand(argv,cwd,input,timeout,prefix,{...process.env,...env,...${JSON.stringify(nativeEnv)},DOTAGENTS_ACTOR_PREFIX:prefix}) : realCommand([process.execPath,${JSON.stringify(producer)},argv[2]],cwd,input,timeout,prefix,env);
 if(argv[0]==='sh'&&argv[2]?.includes('cat result.txt')) {
  await appendFile(${JSON.stringify(calls)},JSON.stringify({role:'check'})+'\\n');
  if(control.changeCheck) await chmod(control.changeCheck,0o700);
 }
 if(stdout!==undefined) {
  if(prefix) {await writeFile(prefix+'.stdout',stdout);await writeFile(prefix+'.stderr','');}
  return {code:0,stdout,stderr:'',timedOut:false,ms:1};
 }
 return realCommand(argv,cwd,input,timeout,prefix,env);
}}));`,
  );
  const generatorPreload = join(root, 'formal-generator-preload.ts');
  await fs.writeFile(
    generatorPreload,
    (await fs.readFile(preload, 'utf8')).replaceAll(
      processPath,
      join(generator, 'scripts/shared/process.ts'),
    ),
  );
  const invoke = (script: string, hooks: string, args: string[]) =>
    command([process.execPath, '--preload', hooks, script, ...args], f.repo, '', 20000);
  const cli = (args: string[]) =>
    invoke(new URL('../../implement/development.ts', import.meta.url).pathname, preload, args);
  const generateCli = (args: string[]) => invoke(entry, generatorPreload, args);
  const r1 = join(root, 'formal-r1');
  const first = await generateCli([
    '99',
    '--repo',
    join(f.dir, 'checkout'),
    '--test-interrupted-run',
    f.dir,
    '--run-dir',
    r1,
    '--no-publish',
  ]);
  assert.equal(first.code, 1, first.stderr);
  // 不明な入口・schema不正・ビルド失敗を正式停止と数えない。
  assert.match(first.stderr, /Host verification required/);
  const stopped = object(JSON.parse(await fs.readFile(join(r1, 'result.json'), 'utf8')));
  expect(stopped.reasonCode).toBe('host_verification_required');
  assert(typeof stopped.checkout === 'string');
  const cwd = stopped.checkout;
  const originConfig = object(
    JSON.parse(await fs.readFile(join(r1, 'verification-config.json'), 'utf8')),
  );
  const origin = object(originConfig.testInterruption);
  expect(origin.execution).toEqual({ code: null, ms: null, usage: 'unknown' });
  expect(origin.retained).toBe(hash(JSON.stringify(await formalTree(f.dir))));
  const savedOrigin = await formalTree(f.dir);
  async function intake(previousRun: string, name: string) {
    const dir = join(root, name);
    const log = join(root, `${name}-host.stdout`);
    await fs.writeFile(log, '模擬ホスト検証。実適用の証拠ではない。');
    const evidence = {
      status: 'passed',
      source: await snapshot(cwd),
      findings: '現在版の模擬ホスト証拠。',
      logs: [{ path: log, sha256: hash(await fs.readFile(log)) }],
    };
    const evidenceFile = join(root, `${name}-evidence.json`);
    await fs.writeFile(evidenceFile, JSON.stringify(evidence));
    return {
      dir,
      evidenceFile,
      evidence,
      args: [
        '99',
        '--repo',
        cwd,
        '--host-run',
        previousRun,
        '--host-evidence',
        evidenceFile,
        '--run-dir',
        dir,
        '--no-publish',
      ],
    };
  }
  let historicalCli = generateCli;
  if (options.producer === '430') {
    const historical = await fixedHostGenerator(root, '430');
    const hooks = join(root, 'formal-historical-preload.ts');
    await fs.writeFile(
      hooks,
      (await fs.readFile(preload, 'utf8')).replaceAll(
        processPath,
        join(historical, 'scripts/shared/process.ts'),
      ),
    );
    historicalCli = (args: string[]) =>
      invoke(join(historical, 'scripts/implement/development.ts'), hooks, args);
  }
  async function observations() {
    return (await fs.readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => object(JSON.parse(line)));
  }
  return {
    cli,
    generateCli: historicalCli,
    preload,
    r1,
    cwd,
    control,
    calls,
    origin,
    originConfig,
    savedOrigin,
    intake,
    observations,
  };
}
