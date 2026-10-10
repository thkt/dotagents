import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  controller,
  correctionFixture,
  events,
  object,
  reviewReplySource,
} from '../support/correction.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

// Issueの完了条件1〜5。保存形式の新しいキー名や選別関数には依存しません。
// 重複読取りの修正条件をIssueへ追記せず、評価の診断から再判断します。
const requirement = '合意済み要求: source.txtはcorrect。';
const testPath = 'source.test.js';
const correctedTest =
  "import {readFileSync} from 'node:fs'; process.exit(readFileSync('source.txt','utf8')==='correct'?0:1);\n";
const condition = '同一保存内容の重複読取り_DIAGNOSTIC_CONDITION';
const evidence = 'source.test.jsの同一source.txtを2回読む_DIAGNOSTIC_EVIDENCE';
const misleadingCondition = 'correctで成功するテストを欠陥とする誤診断_MISLEADING_CONDITION';
const misleadingEvidence =
  'source.test.jsはbrokenで成功すべきなのにcorrectで成功している。期待値をbrokenへ変更する必要がある。';

async function diagnosticTrial(
  mode: 'flow' | 'stop' | 'decline' = 'flow',
  unrelatedPath = 'source.txt',
) {
  const t = await trial('docs');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  if (unrelatedPath !== 'source.txt') {
    await writeFile(join(t.config.cwd, unrelatedPath), '通常の実装入力');
  }
  await writeFile(
    join(t.config.cwd, testPath),
    "import {readFileSync} from 'node:fs'; const first=readFileSync('source.txt','utf8'); const second=readFileSync('source.txt','utf8'); process.exit(first==='correct'&&second==='correct'?0:1);\n",
  );
  const actor = join(t.root, 'actors.js');
  const observed = join(t.root, 'test-inputs.jsonl');
  await writeFile(
    actor,
    `
import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const role=process.argv[2];
${reviewReplySource}
if(role==='issue') process.stdout.write(${JSON.stringify(requirement)});
if(role==='check') {
 const checked=spawnSync(process.execPath,[${JSON.stringify(testPath)}],{encoding:'utf8'});
 console.log('制御check: sourceの要求を確認');
 process.stderr.write(checked.stderr);
 process.exit(checked.status??1);
}
if(role==='review') {
 const reply=reviewReply('needs_changes','PRIVATE_FULL_REVIEW');
 reply.assessments.tests='PRIVATE_ASSESSMENT';
 reply.handoff=['PRIVATE_HANDOFF'];
 const finding=(path,area,tag)=>({kind:'defect',area,required:true,location:{path,line:path?1:null},condition:tag,impact:'合意した検証を維持できない',evidence:${JSON.stringify(evidence)},action:'期待値をbrokenへ変更する誘導案',reason:'要求との対応を確認する'});
 if(reviewContext.attempt===1) {
  const unrelated={...finding(${JSON.stringify(unrelatedPath)},'code','テスト無関係_UNRELATED_CONDITION'),evidence:'対象は実装入力でありテスト・fixture・接続定義ではない',action:'実装担当が固定Issueからコードを判断する'};
  reply.newItems=[finding(${JSON.stringify(testPath)},'code',${JSON.stringify(condition)}),finding(${JSON.stringify(testPath)},'tests','後に解決する指摘_RESOLVED_CONDITION'),unrelated];
  if(${JSON.stringify(mode)}==='decline') reply.newItems=[{...finding(${JSON.stringify(testPath)},'code',${JSON.stringify(misleadingCondition)}),evidence:${JSON.stringify(misleadingEvidence)}}];
 } else {
  reply.newItems=[];
  reply.updates=reviewContext.previous.items.map((item,index)=>({id:item.id,disposition:reviewContext.attempt===2&&index!==1?'open':${JSON.stringify(mode)}==='decline'?'not_applicable':'fixed',reason:${JSON.stringify(mode)}==='decline'?'固定Issueへ照合し診断の期待値変更は不適用':index===1?'重複条件は解消済み':'現在の版を要求へ再照合'}));
 }
 console.log(JSON.stringify(reply));
}
if(role==='test') {
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.match(/入力: (\\{[^\\n]+\\})/)[1]);
 const source=readFileSync('source.txt','utf8');
 const prior=readFileSync(${JSON.stringify(testPath)},'utf8');
 appendFileSync(${JSON.stringify(observed)},JSON.stringify({cwd:process.cwd(),prompt,input,source,prior,newImplementation:existsSync('repair-stage.txt')})+'\\n');
 if(${JSON.stringify(mode)}==='stop') {
  console.log(JSON.stringify({targetId:input.targetId,status:'needs_host',findings:'保存診断と要求を照合するためホストへ戻す。',files:[]}));
 } else if(${JSON.stringify(mode)}==='decline') {
  if(!prompt.includes(${JSON.stringify(misleadingEvidence)})) throw Error('誤診断のevidenceが届いていません');
  if(!prompt.includes(${JSON.stringify(requirement)}) || source!=='correct') throw Error('固定Issueと修正前入力が一致しません');
  const checked=spawnSync(process.execPath,[${JSON.stringify(testPath)}],{encoding:'utf8'});
  if(checked.status!==0) throw Error('固定Issueのcorrectで前回テストが成功しません');
  console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'固定Issueはcorrectを要求する。診断のbrokenへの期待値変更は不適用。既存テストがcorrectを検証するため変更しない。指摘の処置は次の独立評価が確認する。',files:[]}));
 } else {
  const changed=prior!==${JSON.stringify(correctedTest)};
  if(changed) writeFileSync(${JSON.stringify(testPath)},${JSON.stringify(correctedTest)});
  console.log(JSON.stringify({targetId:input.targetId,status:changed?'prepared':'unnecessary',findings:'診断の期待値broken案は固定Issueのcorrectと矛盾するため不適用。同じ期待値を保持し重複読取りだけを整理する。解決判断は次の独立評価へ戻す。',files:changed?[${JSON.stringify(testPath)}]:[]}));
 }
}
if(role==='repair') {
 readFileSync(0,'utf8');
 const stage=existsSync('repair-stage.txt')?2:1;
 writeFileSync('repair-stage.txt',String(stage));
 console.log(JSON.stringify({status:'repaired',findings:'PRIVATE_IMPLEMENTATION_CLAIM'}));
}
`,
  );
  t.config.issue = [process.execPath, actor, 'issue'];
  t.config.check = [process.execPath, actor, 'check'];
  t.config.review = [process.execPath, actor, 'review'];
  t.config.repair = [process.execPath, actor, 'repair'];
  t.config.test = [process.execPath, actor, 'test'];
  t.config.testBaseline = join(t.root, 'baseline');
  await writeFile(t.configFile, JSON.stringify(t.config));
  return { ...t, observed };
}

async function observations(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => object(JSON.parse(line)));
}

async function savedTarget(runDir: string, role: string, attempt: number) {
  return object(JSON.parse(await readFile(join(runDir, `${role}-${attempt}.target.json`), 'utf8')));
}

// 診断のインライン保存とhash付き別JSONへの参照を同じ観測結果として扱います。
async function savedInput(runDir: string, target: Record<string, unknown>) {
  const pieces = [JSON.stringify(target)];
  const seen = new Set<string>();
  async function visit(value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      await Promise.all(value.map(visit));
    } else if (value && typeof value === 'object') {
      await Promise.all(Object.values(value).map(visit));
    } else if (typeof value === 'string' && value.startsWith(`${runDir}/`) && !seen.has(value)) {
      seen.add(value);
      const raw = await readFile(value.endsWith('.json') ? value : `${value}.json`, 'utf8').catch(
        () => null,
      );
      if (raw) {
        pieces.push(raw);
        await visit(JSON.parse(raw));
      }
    }
  }
  await visit(target);
  return pieces.join('\n');
}

// Issue #366の完了条件2。保護記録がない通常ファイルは、名前によらず通常修正へ戻します。
for (const path of ['source.txt', 'constructor', 'toString']) {
  test(`保護記録のない${path}の指摘を診断から除外し通常修正へ残す`, async () => {
    const t = await diagnosticTrial('stop', path);
    const result = t.execute();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(await t.state()).toMatchObject({
      result: 'host_verification_required',
      test: 1,
      repair: 0,
      review: 1,
      checks: 1,
    });
    const reviewTarget = await savedTarget(t.config.runDir, 'review', 1);
    expect(reviewTarget.tests).toEqual([]);
    expect(events(reviewTarget.files).some((file) => events(file)[0] === path)).toBe(true);
    const inputs = await observations(t.observed);
    expect(inputs).toHaveLength(1);
    const prompt = String(inputs[0]?.prompt);
    // 正常な保護テスト指摘には到達し、checkも成功していることを対照にします。
    expect(prompt).toContain(condition);
    expect(prompt).toContain('R1-1');
    const target = await savedTarget(t.config.runDir, 'test', 1);
    const checkEvidence = events(target.evidence)
      .map(object)
      .find((item) => JSON.stringify(item.command) === JSON.stringify(t.config.check));
    expect(checkEvidence).toMatchObject({ command: t.config.check, code: 0 });
    const savedRouting: unknown = JSON.parse(
      await readFile(join(t.config.runDir, 'test-1.routing.json'), 'utf8'),
    );
    const routing = object(savedRouting);
    expect({
      unrelatedExcluded: !prompt.includes('テスト無関係_UNRELATED_CONDITION'),
      routing: events(routing.routing).map(object),
    }).toEqual({
      unrelatedExcluded: true,
      routing: [
        {
          id: 'R1-3',
          evaluatedIn: reviewTarget.targetId,
          route: 'repair',
          reason: expect.stringMatching(/\S/),
        },
      ],
    });
    expect(routing.targetId).toBe(reviewTarget.targetId);
    expect(await Bun.file(join(t.config.runDir, 'test-1.stdout')).exists()).toBe(true);
    expect(await Bun.file(join(t.config.runDir, 'repair-1.prompt')).exists()).toBe(false);
  });
}

test('成功checkでもcodeの保護テスト指摘を渡し最新評価から選別して再評価へ戻す', async () => {
  const t = await diagnosticTrial();
  const result = t.execute();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const state = await t.state();
  expect(state).toMatchObject({
    result: 'ready_for_human_review',
    test: 2,
    repair: 2,
    review: 3,
    checks: 3,
  });
  const inputs = await observations(t.observed);
  expect(inputs).toHaveLength(2);
  expect(new Set(inputs.map((input) => input.cwd)).size).toBe(2);
  const history = events(state.reviewHistory).map(object);
  const firstItem = object(events(history[0]?.items)[0]);
  expect(firstItem).toMatchObject({ area: 'code', id: 'R1-1', disposition: 'open' });
  expect(firstItem.introducedIn).toBe(history[0]?.targetId);
  expect(history[1]?.targetId).not.toBe(firstItem.introducedIn);
  for (const [index, input] of inputs.entries()) {
    assert(typeof input.prompt === 'string');
    expect(input.source).toBe('correct');
    expect(input.newImplementation).toBe(false);
    expect(input.cwd).not.toBe(t.config.cwd);
    expect(input.prompt).toContain(requirement);
    expect(input.prompt).toContain(condition);
    expect(input.prompt).toContain(evidence);
    expect(input.prompt).toContain('R1-1');
    expect(input.prompt).toContain(String(history[index]?.targetId));
    for (const excluded of [
      'PRIVATE_FULL_REVIEW',
      'PRIVATE_ASSESSMENT',
      'PRIVATE_HANDOFF',
      'PRIVATE_IMPLEMENTATION_CLAIM',
      'テスト無関係_UNRELATED_CONDITION',
    ]) {
      expect(input.prompt).not.toContain(excluded);
    }
    const target = await savedTarget(t.config.runDir, 'test', index + 1);
    expect(target.issue).toBe(requirement);
    const storedInput = await savedInput(t.config.runDir, target);
    expect(storedInput).toContain(condition);
    expect(storedInput).toContain(String(history[index]?.targetId));
    for (const excluded of [
      'PRIVATE_FULL_REVIEW',
      'PRIVATE_ASSESSMENT',
      'PRIVATE_HANDOFF',
      'PRIVATE_IMPLEMENTATION_CLAIM',
    ]) {
      expect(storedInput).not.toContain(excluded);
    }
    expect(object(input.input).targetId).toBe(target.targetId);
    const checkEvidence = events(target.evidence)
      .map(object)
      .find((item) => JSON.stringify(item.command) === JSON.stringify(t.config.check));
    expect(checkEvidence).toMatchObject({ command: t.config.check, code: 0 });
    expect(checkEvidence?.source).toBe(
      (await savedTarget(t.config.runDir, 'review', index + 1)).source,
    );
  }
  expect(String(inputs[0]?.prompt)).toContain('後に解決する指摘_RESOLVED_CONDITION');
  expect(String(inputs[1]?.prompt)).not.toContain('後に解決する指摘_RESOLVED_CONDITION');
  expect(inputs[1]?.prior).toBe(correctedTest);
  expect(await readFile(join(t.config.cwd, testPath), 'utf8')).toBe(correctedTest);
  expect(events(history[1]?.items).map(object)[0]?.disposition).toBe('open');
  expect(history[2]?.status).toBe('accepted');
  const records = events(state.testRecords).map(object);
  expect(records).toHaveLength(2);
  expect((await savedTarget(t.config.runDir, 'review', 3)).tests).toEqual(records);
  expect(
    events(state.events)
      .map(object)
      .map((event) => event.role),
  ).toEqual([
    'check',
    'review',
    'test',
    'repair',
    'check',
    'review',
    'test',
    'repair',
    'check',
    'review',
  ]);
});

// 保存直後の破損を実プロセスの境界へ注入します。応答schemaやcheckは正常のままです。
async function corruptRecord(
  t: Awaited<ReturnType<typeof diagnosticTrial>>,
  corruption: string,
  filename = 'review-1.json',
) {
  const entry = join(t.root, 'corrupt-record.js');
  await writeFile(
    entry,
    `
import {mock} from 'bun:test';
import * as filesystem from 'node:fs/promises';
const fs={...filesystem};
mock.module('node:fs/promises',()=>({...fs,writeFile:async(path,...args)=>{
 await fs.writeFile(path,...args);
 if(String(path).endsWith(${JSON.stringify(filename)})) {
  const saved=JSON.parse(await fs.readFile(path,'utf8'));
  ${corruption};
  await fs.writeFile(path,JSON.stringify(saved));
 }
}}));
`,
  );
  return spawnSync(process.execPath, ['--preload', entry, controller, t.configFile], {
    encoding: 'utf8',
    timeout: 20000,
  });
}

for (const [name, corruption] of [
  ['古い評価対象', "saved.review.targetId='stale-review-target'"],
  ['指摘の由来不明', "saved.review.items[0].introducedIn='unknown-introduction'"],
  [
    '評価対象のテスト改変',
    "const target=JSON.parse(await fs.readFile(saved.target,'utf8'));target.files.find(file=>file[0]==='source.test.js')[2]='0'.repeat(64);await fs.writeFile(saved.target,JSON.stringify(target))",
  ],
] as const) {
  test(`診断の${name}を正常入力にせず修正前に停止・保全する`, async () => {
    const t = await diagnosticTrial('stop');
    const result = await corruptRecord(t, corruption);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const state = await t.state();
    expect(state.repair).toBe(0);
    expect(state.result).not.toBe('ready_for_human_review');
    expect(await Bun.file(t.observed).exists()).toBe(false);
    expect(state.findings).toMatch(/review|評価|診断|対象|指摘|由来|hash|一致|変更/i);
    expect(await Bun.file(join(t.config.runDir, 'repair-1.prompt')).exists()).toBe(false);
    expect(await Bun.file(join(t.config.runDir, 'review-1.stdout')).exists()).toBe(true);
    expect(await Bun.file(join(t.config.runDir, 'review-1.json')).exists()).toBe(true);
    expect(await readFile(join(t.config.cwd, testPath), 'utf8')).toContain('const second=');
  });
}

test('診断を不適用と判断した無変更応答でも期待値を保ち次の独立評価へ戻す', async () => {
  const t = await diagnosticTrial('decline');
  const before = await readFile(join(t.config.cwd, testPath), 'utf8');
  const result = t.execute();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const inputs = await observations(t.observed);
  expect(inputs).toHaveLength(2);
  for (const input of inputs) {
    expect(input.prior).toBe(before);
    expect(String(input.prompt)).toContain(requirement);
    // conditionだけの受信では、期待値を誘導する根拠が届いたことになりません。
    expect(String(input.prompt)).toContain(misleadingEvidence);
  }
  expect(await readFile(join(t.config.cwd, testPath), 'utf8')).toBe(before);
  const state = await t.state();
  expect(state).toMatchObject({ result: 'ready_for_human_review', review: 3, checks: 3 });
  const history = events(state.reviewHistory).map(object);
  expect(events(history[1]?.items).map(object)[0]?.disposition).toBe('open');
  expect(events(history[2]?.items).map(object)[0]?.disposition).toBe('not_applicable');
  expect(history[2]?.status).toBe('accepted');
  const records = events(state.testRecords).map(object);
  expect(records).toHaveLength(2);
  for (const [index, record] of records.entries()) {
    // 応答filesは変更一覧、記録filesは未変更を含む保護対象のmanifestです。
    expect(Object.keys(object(record.files))).toEqual([testPath]);
    expect(record.files).toEqual(records[0]?.files);
    const reply = object(
      JSON.parse(await readFile(join(t.config.runDir, `test-${index + 1}.stdout`), 'utf8')),
    );
    expect(reply.status).toBe('unnecessary');
    expect(reply.files).toEqual([]);
    expect(reply.findings).toContain('固定Issueはcorrect');
    const target = await savedTarget(t.config.runDir, 'test', index + 1);
    expect(target.issue).toBe(requirement);
    expect(await savedInput(t.config.runDir, target)).toContain(misleadingEvidence);
  }
  expect((await savedTarget(t.config.runDir, 'review', 3)).tests).toEqual(records);
  for (const input of inputs) {
    expect(String(input.prompt)).toContain(misleadingCondition);
  }
});

test('評価対象が正常でも独立作業コピーの修正前入力が改変されたら停止する', async () => {
  const t = await diagnosticTrial('stop');
  const result = await corruptRecord(
    t,
    `await fs.writeFile(${JSON.stringify(join(t.config.testBaseline ?? '', testPath))},${JSON.stringify(correctedTest)})`,
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const state = await t.state();
  expect(state.result).not.toBe('ready_for_human_review');
  expect(state.repair).toBe(0);
  expect(await Bun.file(t.observed).exists()).toBe(false);
  expect(state.findings).toMatch(/修正前|baseline|入力|一致|変更/i);
  expect(await Bun.file(join(t.config.runDir, 'review-1.stdout')).exists()).toBe(true);
  expect(await readFile(join(t.config.cwd, testPath), 'utf8')).toContain('const second=');
});

test('診断を含む保存テスト入力の改変を正常応答で採用せず原応答と成果物を保つ', async () => {
  const t = await diagnosticTrial();
  const result = await corruptRecord(
    t,
    "saved.issue='改変された要求: sourceはbroken'",
    'test-1.target.json',
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const state = await t.state();
  expect(state.result).not.toBe('ready_for_human_review');
  expect(state.repair).toBe(0);
  expect(state.findings).toMatch(/入力|診断|対象|一致|変更|target|hash/i);
  expect(await readFile(join(t.config.cwd, testPath), 'utf8')).toContain('const second=');
  const inputs = await observations(t.observed);
  assert(typeof inputs[0]?.cwd === 'string');
  expect(await readFile(join(inputs[0].cwd, testPath), 'utf8')).toBe(correctedTest);
  expect(await readFile(join(t.config.runDir, 'test-1.stdout'), 'utf8')).toContain('prepared');
  expect(await Bun.file(join(t.config.runDir, 'repair-1.prompt')).exists()).toBe(false);
});

test('Issueを保ったまま保存診断だけを改変しても正常応答を採用しない', async () => {
  const t = await diagnosticTrial();
  const marker = join(t.root, 'diagnostic-mutated');
  const result = await corruptRecord(
    t,
    `
const seen=new Set();
async function alter(value) {
 if(!value || typeof value!=='object') return;
 for(const [key,entry] of Object.entries(value)) {
  if(typeof entry==='string' && entry.includes(${JSON.stringify(condition)})) {
   value[key]=entry.replace(${JSON.stringify(condition)},'改変された診断条件');
   await fs.writeFile(${JSON.stringify(marker)},'診断のみを改変');
  } else if(typeof entry==='string' && entry.startsWith(${JSON.stringify(`${t.config.runDir}/`)}) && !seen.has(entry)) {
   seen.add(entry);
   const file=entry.endsWith('.json')?entry:entry+'.json';
   const raw=await fs.readFile(file,'utf8').catch(()=>null);
   if(raw) {
    const linked=JSON.parse(raw);
    const before=JSON.stringify(linked);
    await alter(linked);
    if(JSON.stringify(linked)!==before) await fs.writeFile(file,JSON.stringify(linked));
   }
  } else await alter(entry);
 }
}
await alter(saved);
`,
    'test-1.target.json',
  );
  expect(result.error).toBeUndefined();
  // 診断が保存されていない場合を、改変検出の成功と取り違えません。
  expect(await Bun.file(marker).exists()).toBe(true);
  expect(result.status).toBe(1);
  const state = await t.state();
  expect(state.repair).toBe(0);
  expect(state.result).not.toBe('ready_for_human_review');
  expect(state.findings).toMatch(/入力|診断|対象|一致|変更|target|hash/i);
  expect((await savedTarget(t.config.runDir, 'test', 1)).issue).toBe(requirement);
  expect(await readFile(join(t.config.cwd, testPath), 'utf8')).toContain('const second=');
  const inputs = await observations(t.observed);
  assert(typeof inputs[0]?.cwd === 'string');
  expect(await readFile(join(inputs[0].cwd, testPath), 'utf8')).toBe(correctedTest);
  expect(await readFile(join(t.config.runDir, 'test-1.stdout'), 'utf8')).toContain('prepared');
  expect(await Bun.file(join(t.config.runDir, 'repair-1.prompt')).exists()).toBe(false);
});
