import assert from 'node:assert/strict';
import { realpath, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from '../../input.ts';
import { isRecord, isArray } from '../../values.ts';

export function object(value: unknown) {
  assert(isRecord(value));
  return value;
}
export function events(value: unknown) {
  assert(isArray(value));
  return value;
}

// Simulated external actor response; expectations remain in individual tests.
export const reviewReplySource = `
const reviewContext=role==='review'?JSON.parse(readFileSync(0,'utf8').split('Host context: ')[1].split('\\n')[0]):null;
function reviewReply(status,findings) {
 const previous=reviewContext.previous?.items??[];
 return {findings,targetId:reviewContext.targetId,
 assessments:{code:'Source behavior inspected',requirements:'Compared agreed deliverables',tests:'Existing check covers source',documentation:'Documentation inspected'},
 updates: previous.map(item=>({id:item.id,disposition:status==='accepted'?'fixed':'open',reason:status==='accepted'?'Current README contains the required instructions':'Documentation remains absent'})),
 newItems: previous.length || status==='accepted'?[]:[{
 id:'R'+reviewContext.attempt+'-docs',introducedIn:reviewContext.targetId,kind:'defect',area:'documentation',required:true,location:{path:null,line:null},condition:'Reader needs setup instructions',impact:'Cannot operate the change',evidence:'Required README is absent',action:'Add current instructions',disposition:'open',reason:'Missing documentation confirmed'}],
 documents:[],handoff:['担当AI: 未計測の実サービス応答時間を報告する']};
}
`;

export const controller = resolve(import.meta.dir, '../../correction.ts');

export function correctionConfig(root: string, mode = 'normal'): Config {
  const helper = join(root, 'helper.js');
  return {
    cwd: join(root, 'work'),
    runDir: join(root, 'evidence'),
    issue: [process.execPath, helper, 'issue'],
    check: [process.execPath, helper, 'check'],
    ...(mode.startsWith('capture_') ? { capture: [process.execPath, helper, 'capture'] } : {}),
    captureDestination: 'trial/evidence/generated',
    captureRequired: false,
    repair: [process.execPath, helper, 'repair'],
    review: [process.execPath, helper, 'review'],
    repairLimit: 2,
    reviewLimit: 2,
    modelTimeMs: 15000,
    checkTimeMs: 1000,
  };
}

export function correctionFixture() {
  const roots: string[] = [];
  async function trial(mode: string, overrides: Partial<Config> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'correction-test-')));
    roots.push(root);
    const cwd = join(root, 'work');
    const initialized = spawnSync('git', ['init', '-q', cwd]);
    if (initialized.status !== 0) {
      throw Error('Test repository initialization failed');
    }
    for (const args of [
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test'],
      ['commit', '--allow-empty', '-m', 'fixture base'],
    ]) {
      assert(spawnSync('git', args, { cwd }).status === 0);
    }
    await writeFile(join(cwd, 'source.txt'), 'broken');
    const helper = join(root, 'helper.js');
    await writeFile(
      helper,
      `
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const role=process.argv[2], mode=${JSON.stringify(mode)};
${reviewReplySource}
if(role==='issue') console.log(mode==='issue_changed'&&existsSync(${JSON.stringify(join(root, 'issue-changed'))})?'Changed requirement':'Agreed requirement: correct source and docs');
if(role==='capture') {
 if(mode==='capture_timeout') await new Promise(r=>setTimeout(r,10000));
 if(mode==='capture_unavailable') {console.error('Host permission denied');process.exit(78);}
 if(mode==='capture_changed') writeFileSync('source.txt','changed by capture');
 if(mode==='capture_failure' && readFileSync('source.txt','utf8')==='broken') {console.error('Capture assertion failed');process.exit(1);}
 writeFileSync(join(process.argv[3],'desktop.png'),readFileSync('source.txt','utf8'));
}
if(role==='check') {
 if(mode==='check_timeout') await new Promise(r=>setTimeout(r,10000));
 if(mode==='normal') {console.log('source must be correct');console.error('validation failed: source is broken');}
 process.exit(readFileSync('source.txt','utf8')==='broken'?1:0);
}
if(role==='repair') {
 if(mode==='normal') {
  const prompt=readFileSync(0,'utf8');
  const stdout=${JSON.stringify(join(root, 'evidence/check-1.stdout'))};
  const stderr=${JSON.stringify(join(root, 'evidence/check-1.stderr'))};
  if(!prompt.includes(stdout)||!prompt.includes(stderr)) process.exit(3);
  const expected=readFileSync(stdout,'utf8').trim();
  const failure=readFileSync(stderr,'utf8').trim();
  if(expected!=='source must be correct'||failure!=='validation failed: source is broken') process.exit(4);
  if(prompt.includes(expected)||prompt.includes(failure)) process.exit(5);
 }
 if(mode==='null_repair') {console.log('null');process.exit(0);}
 if(mode==='timeout') await new Promise(r=>setTimeout(r,10000));
 if(mode==='human') {console.log(JSON.stringify({status:'needs_human',findings:'Need changed requirements'}));process.exit(0);}
 if(mode!=='exhaust') writeFileSync('source.txt','correct');
 if(existsSync(${JSON.stringify(join(root, 'reviewed'))})) writeFileSync('README.md','current');
 console.log(JSON.stringify({status:'repaired',findings:'fixed'}));
}
if(role==='review') {
 if(mode.startsWith('capture_') && readFileSync('trial/evidence/generated/desktop.png','utf8')!==readFileSync('source.txt','utf8')) process.exit(5);
 if(mode==='capture_review'&&!existsSync('README.md')) {writeFileSync(${JSON.stringify(join(root, 'reviewed'))},'1');console.log(JSON.stringify(reviewReply('needs_changes','README missing')));process.exit(0);}

 if(mode==='null_review') {console.log('null');process.exit(0);}
 if(mode==='review_failed') process.exit(2);
 if(mode==='issue_changed') writeFileSync(${JSON.stringify(join(root, 'issue-changed'))},'yes');
 if(mode==='malformed') console.log('success');
 else if(mode==='changed') {writeFileSync('source.txt','changed');console.log(JSON.stringify(reviewReply('accepted','changed')));}
 else if(mode==='docs'&&!existsSync('README.md')) {writeFileSync(${JSON.stringify(join(root, 'reviewed'))},'1');console.log(JSON.stringify(reviewReply('needs_changes','README missing')));}
 else console.log(JSON.stringify(reviewReply('accepted','checked')));
}
`,
    );
    const config = { ...correctionConfig(root, mode), ...overrides };
    const configFile = join(root, 'config.json');
    await writeFile(configFile, JSON.stringify(config));
    const execute = () =>
      spawnSync(process.execPath, [controller, configFile], { encoding: 'utf8', timeout: 20000 });
    return {
      root,
      config,
      configFile,
      execute,
      state: async () =>
        object(JSON.parse(await readFile(join(config.runDir, 'state.json'), 'utf8'))),
    };
  }

  return {
    trial,
    cleanup: async () => {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}
