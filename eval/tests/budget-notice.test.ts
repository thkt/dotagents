import assert from 'node:assert/strict';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { isRecord } from '../../scripts/shared/values.ts';

// #403「通知、保存、全体停止」とhost_returnの公開接続契約を使う。
// 子プロセスの実stdoutを保存し、模擬gatewayがackを受けた時点で照合する。
// 実API・実Dockerを起動するfixtureではない。
const driver = `
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[1];
const { createBudgetRun, observeBudget } = await import(process.env.NOTICE_HOST_MODULE);
const { budgetApi, conditions, reservation, seed } = await import(process.env.NOTICE_CONTRACT_MODULE);
const directory = join(root, 'trial');
const runtime = join(directory, 'gateway-runtime');
await mkdir(runtime, {recursive:true});
const host = await createBudgetRun(root, conditions);
await host.delegate(runtime, Date.now()+5000);
const { createRunBudget } = await budgetApi();
const ledger = createRunBudget({runId:host.state.snapshot.runId, conditions,
 save:async()=>{}, notify:async()=>{}});
await seed(ledger, conditions.notify-reservation);
if (!await ledger.reserve('notice-reservation')) throw Error('通知の正常入力を作れない');
const notice = structuredClone(ledger.snapshot());
await ledger.releaseUnsent('notice-reservation');
const final = ledger.snapshot();
await writeFile(join(root,'snapshots.json'), JSON.stringify({notice,final}));
if(process.env.NOTICE_FAULT==='save') await mkdir(join(directory,'budget-notice.json'));
// 製品の注入APIを増やさず、呼出しプロセスのstdoutの公開write契約を使う。
if (process.env.NOTICE_FAULT.startsWith('stdout-')) {
 const originalWrite = process.stdout.write.bind(process.stdout);
 process.stdout.write = (chunk, ...args) => {
  if (!String(chunk).includes('eval.budget-notice')) return originalWrite(chunk, ...args);
  const callback = args.at(-1);
  void (async () => {
   await writeFile(join(root,'write-pending.json'),JSON.stringify({hasCallback:typeof callback==='function'}));
   while (!await readFile(join(root,'write-release')).then(()=>true,()=>false)) {
    await new Promise(resolve=>setTimeout(resolve,1));
   }
   const done = async error => {
    await writeFile(join(root,'write-completed.json'),JSON.stringify({failed:!!error}));
    if (typeof callback==='function') callback(error);
   };
   if (process.env.NOTICE_FAULT==='stdout-error') await done(new Error('合成stdout書込み失敗'));
   else originalWrite(chunk, error=>{void done(error)});
  })();
  return true;
 };
}
const observation = await observeBudget('synthetic-gateway', runtime, directory, Date.now()+5000);
// closeの成否にかかわらず、同じ終了観測期限で補助処理を止める接続契約。
const deadline = performance.now()+1500;
try {
 await observation.close(deadline);
} finally {
 await observation.stop(deadline);
}
`;

const peer = `
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const root=process.env.NOTICE_ROOT;
const {notice,final}=JSON.parse(readFileSync(join(root,'snapshots.json')));
const delegation=JSON.parse(readFileSync(join(root,'trial/gateway-runtime/delegation.json')));
const messages=[
 {delegation:delegation.id,sequence:1,kind:'save',snapshot:notice},
 {delegation:delegation.id,sequence:2,kind:'notify',snapshot:notice},
 {delegation:delegation.id,sequence:3,kind:'save',snapshot:final},
 {delegation:delegation.id,sequence:4,kind:'closed',snapshot:final},
];
// callbackを解放する前のackを独立したpeerで観測する。
if (process.env.NOTICE_FAULT.startsWith('stdout-')) void (async()=>{
 while (!await readFile(join(root,'write-pending.json')).then(()=>true,()=>false)) {
  await new Promise(resolve=>setTimeout(resolve,1));
 }
 const acks=await readFile(join(root,'acks.jsonl'),'utf8').catch(()=>'');
 await writeFile(join(root,'before-callback.json'),JSON.stringify({acks}));
 await writeFile(join(root,'write-release'),'release');
})();
let index=0, closing=false, pending='';
const emit=()=>console.log(JSON.stringify(messages[index]));
emit();
for await(const chunk of Bun.stdin.stream()) {
 pending+=new TextDecoder().decode(chunk);
 let end;
 while((end=pending.indexOf('\\n'))>=0) {
  const line=pending.slice(0,end);pending=pending.slice(end+1);
  if(line==='close') {
   closing=true;
   if(index===3) emit();
   continue;
  }
  if(Number(line)!==messages[index].sequence) throw Error('ackのsequence不一致');
  let saved=null;
  try {saved=JSON.parse(readFileSync(join(root,'trial/budget-notice.json')))} catch {}
  const output=readFileSync(join(root,'stdout'),'utf8');
  let writeCompleted=null;
  try {writeCompleted=JSON.parse(readFileSync(join(root,'write-completed.json')))} catch {}
  appendFileSync(join(root,'acks.jsonl'),JSON.stringify({sequence:Number(line),saved,output,writeCompleted})+'\\n');
  if(index===3) process.exit(0);
  index++;
  if(index<3||closing) emit();
 }
}
`;

async function observe(fault: string, action: (root: string, code: number) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'budget-notice-'));
  const output = openSync(join(root, 'stdout'), 'w');
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin/docker'), `#!${process.execPath}\n${peer}`, { mode: 0o755 });
    const child = Bun.spawn([process.execPath, '--eval', driver, root], {
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
        NOTICE_ROOT: root,
        NOTICE_FAULT: fault,
        NOTICE_HOST_MODULE: join(import.meta.dir, '../budget-host.ts'),
        NOTICE_CONTRACT_MODULE: join(import.meta.dir, 'budget-contract.ts'),
      },
      stdout: output,
      stderr: 'pipe',
      timeout: 8000,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    // 接続以前のimport失敗を、保存失敗の正常な拒否として数えない。
    expect(stderr).not.toContain('Cannot find module');
    await action(root, code);
  } finally {
    closeSync(output);
    await rm(root, { recursive: true, force: true });
  }
}

async function acknowledgements(root: string) {
  const lines = (await readFile(join(root, 'acks.jsonl'), 'utf8')).trim().split('\n');
  return lines.map((line): Record<string, unknown> => {
    const value: unknown = JSON.parse(line);
    assert(isRecord(value));
    return value;
  });
}

test('ホストは通知をCLIとrun記録へ出してからackし、減額後も通知記録を保つ', async () => {
  await observe('', async (root, code) => {
    expect(code).toBe(0);
    const acks = await acknowledgements(root);
    expect(acks.map((ack) => ack.sequence)).toEqual([1, 2, 3, 4]);
    const ack = acks[1];
    assert(ack && typeof ack.output === 'string');
    const expected = {
      sequence: 2,
      kind: 'notify',
      snapshot: {
        settled: 3_952_700_000,
        reserved: 47_300_000,
        unrecoverable: 0,
        accounted: 4_000_000_000,
        notified: true,
      },
    };
    expect(ack.saved).toMatchObject(expected);
    assert(isRecord(ack.saved));
    const notices = ack.output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
    expect(notices).toEqual([{ type: 'eval.budget-notice', ...ack.saved }]);
    expect(notices[0]).toMatchObject(expected);
    const finalOutput = await readFile(join(root, 'stdout'), 'utf8');
    expect(finalOutput).toBe(ack.output);
    expect(JSON.parse(await readFile(join(root, 'trial/budget-notice.json'), 'utf8'))).toEqual(
      ack.saved,
    );
    expect(
      JSON.parse(await readFile(join(root, 'trial/budget-closed.json'), 'utf8')),
    ).toMatchObject({
      sequence: 4,
      snapshot: { accounted: 3_952_700_000, reserved: 0, notified: true },
    });
  });
});

test('通知の保存不能では通知ackと後続の状態受渡しへ進まない', async () => {
  await observe('save', async (root) => {
    const acks = await acknowledgements(root);
    // 同じ正常入力のsaveはackされ、狙った通知保存だけが失敗する。
    expect(acks.map((ack) => ack.sequence)).toEqual([1]);
    expect(await readFile(join(root, 'trial/budget-closed.json')).catch(() => null)).toBe(null);
  });
});

for (const fault of ['stdout-success', 'stdout-error']) {
  test(`通知stdoutのcallback完了を待ち、${fault}に応じてackと後続受渡しを制御する`, async () => {
    await observe(fault, async (root, code) => {
      const pending: unknown = JSON.parse(await readFile(join(root, 'write-pending.json'), 'utf8'));
      expect(pending).toEqual({ hasCallback: true });
      const before: unknown = JSON.parse(
        await readFile(join(root, 'before-callback.json'), 'utf8'),
      );
      assert(isRecord(before) && typeof before.acks === 'string');
      const early = before.acks
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
      expect(early).toHaveLength(1);
      expect(early[0]).toMatchObject({ sequence: 1 });
      const completion: unknown = JSON.parse(
        await readFile(join(root, 'write-completed.json'), 'utf8'),
      );
      expect(completion).toEqual({ failed: fault === 'stdout-error' });
      const acks = await acknowledgements(root);
      if (fault === 'stdout-error') {
        expect(acks.map((ack) => ack.sequence)).toEqual([1]);
        expect(await readFile(join(root, 'trial/budget-closed.json')).catch(() => null)).toBeNull();
      } else {
        expect(code).toBe(0);
        expect(acks.map((ack) => ack.sequence)).toEqual([1, 2, 3, 4]);
        expect(acks[1]).toMatchObject({
          writeCompleted: { failed: false },
          saved: { sequence: 2, kind: 'notify' },
        });
        const output = await readFile(join(root, 'stdout'), 'utf8');
        expect(JSON.parse(output)).toMatchObject({
          type: 'eval.budget-notice',
          sequence: 2,
          kind: 'notify',
        });
        expect(await readFile(join(root, 'trial/budget-closed.json'), 'utf8')).toBeTruthy();
      }
    });
  });
}
