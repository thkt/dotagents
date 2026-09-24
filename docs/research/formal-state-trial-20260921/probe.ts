import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { correctionFixture } from './baseline/scripts/tests/support/correction.ts';
const root = import.meta.dir;
const source = await readFile(join(root, 'baseline/scripts/correction.ts'), 'utf8');
const fixture = correctionFixture();
const results: unknown[] = [];
function start(controller: string, configFile: string) {
  const child = spawn(process.execPath, [controller, configFile], {stdio:['ignore','pipe','pipe']});
  let stdout='',stderr=''; let finished=false;
  child.stdout!.on('data',x=>stdout+=x); child.stderr!.on('data',x=>stderr+=x);
  const done = new Promise<number|null>(resolve=>child.on('close',c=>{finished=true;resolve(c)}));
  return {child,done,get finished(){return finished},get stdout(){return stdout},get stderr(){return stderr}};
}
async function count(path:string) {try{return (await readFile(path,'utf8')).trim().split('\n').filter(Boolean).length}catch{return 0}}
async function waitForStarted(path:string,n:number,child:ReturnType<typeof start>) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if(await count(path)>=n)return true;if(child.finished)return false;await Bun.sleep(10)}
  throw Error('Timed out waiting for controlled check');
}
function replaceOnce(s:string,from:string,to:string){assert.equal(s.split(from).length,2);return s.replace(from,to)}
try {
 for (const variant of ['baseline','late-reservation','ignore-active']) {
  let controller=join(root,'baseline/scripts/correction.ts');
  if(variant!=='baseline') {
   const dest=join(root,variant); await mkdir(dest,{recursive:true});
   await cp(join(root,'baseline/scripts'),join(dest,'scripts'),{recursive:true});
   let changed=source;
   if(variant==='late-reservation') {
    changed=replaceOnce(changed,
      "  await persist();\n  const result = await command(argv, config.cwd, '', config.checkTimeMs, prefix);",
      "  const result = await command(argv, config.cwd, '', config.checkTimeMs, prefix);\n  await persist();");
   } else {
    changed=replaceOnce(changed,"  if (state?.active) {\n    throw Error(interruptionMessage);\n  }\n",'');
   }
   controller=join(dest,'scripts/correction.ts'); await writeFile(controller,changed);
  }
  const t=await fixture.trial('normal',{modelTimeMs:null,checkTimeMs:15000});
  const starts=join(t.root,'starts'); const worker=join(t.root,'held-check.js');
  await writeFile(worker,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(starts)},String(process.pid)+'\\n');console.log('held check started');setInterval(()=>{},100);`);
  await writeFile(t.configFile,JSON.stringify({...t.config,check:[process.execPath,worker]}));
  const begin=performance.now();const first=start(controller,t.configFile);let second:ReturnType<typeof start>|undefined;
  try {
   assert(await waitForStarted(starts,1,first));
   const before=await t.state();first.child.kill('SIGTERM');const firstCode=await first.done;
   second=start(controller,t.configFile); const restarted=await waitForStarted(starts,2,second);
   if(restarted)second.child.kill('SIGTERM');const secondCode=await second.done;
   const evidence={variant,seconds:(performance.now()-begin)/1000,firstCode,secondCode,
    beforeActive:before.active,beforeChecks:before.checks,startedChecks:await count(starts),
    restarted,firstError:first.stderr,secondError:second.stderr};
   results.push(evidence);console.log(JSON.stringify(evidence));
   assert.equal(firstCode,1);assert.equal(restarted,variant!=='baseline');
   if(variant==='baseline')assert(second.stderr.includes('Interrupted execution'));
  } finally {first.child.kill('SIGKILL');if(second)second.child.kill('SIGKILL');await first.done;if(second)await second.done}
 }
 const dest=join(root,'no-lock');await mkdir(dest,{recursive:true});await cp(join(root,'baseline/scripts'),join(dest,'scripts'),{recursive:true});
 const noLock=replaceOnce(source,
  "  const lock = resolve(config.runDir, 'lock');\n  await mkdir(lock); // Existing lock requires reconciliation, never an automatic takeover.\n  try {\n    return await execute(config);\n  } finally {\n    await rm(lock, { recursive: true });\n  }",
  '  return await execute(config);');
 await writeFile(join(dest,'scripts/correction.ts'),noLock);
 const begin=performance.now();const tested=spawnSync(process.execPath,['test','scripts/tests/correction.test.ts','--test-name-pattern','terminal success still refuses an active reservation or an existing lock'],{cwd:dest,encoding:'utf8',timeout:15000});
 await writeFile(join(root,'no-lock-test.log'),tested.stdout+tested.stderr);
 assert.equal(tested.status,1);assert(tested.stderr.includes('Expected: 1'));assert(tested.stderr.includes('Received: 0'));
 results.push({variant:'no-lock',seconds:(performance.now()-begin)/1000,existingTestDetected:true,exitCode:tested.status});
 await writeFile(join(root,'code-probe-results.json'),JSON.stringify(results,null,2));
 console.log('All expected baseline and fault observations matched');
} finally {await fixture.cleanup()}
