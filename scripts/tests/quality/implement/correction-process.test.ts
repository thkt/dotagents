import { test, expect, afterEach } from 'bun:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewReplySource, correctionFixture, object } from '../../support/correction.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

test('split UTF-8 survives requirements, actor replies and both logs', async () => {
  const t = await trial('unicode');
  await writeFile(
    join(t.root, 'helper.js'),
    `import {readFileSync,writeFileSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
async function split(stream,text) {
 const bytes=Buffer.from(text);
 const cut=bytes.findIndex(byte=>byte>127)+1;
 stream.write(bytes.subarray(0,cut));
 await new Promise(resolve=>setTimeout(resolve,50));
 stream.write(bytes.subarray(cut));
}
if(role==='issue') await split(process.stdout,'日本語の要件');
if(role==='check' && readFileSync('source.txt','utf8')==='broken') {
 await split(process.stdout,'確認結果');
 await split(process.stderr,'修正が必要');
 process.exitCode=1;
}
if(role==='repair') {
 writeFileSync('source.txt','correct');
 await split(process.stdout,JSON.stringify({status:'repaired',findings:'修正済み'}));
}
if(role==='review') await split(process.stdout,JSON.stringify(reviewReply('accepted','検証済み')));
`,
  );
  expect(t.execute().status).toBe(0);
  for (const role of ['repair', 'review']) {
    expect(await readFile(join(t.config.runDir, `${role}-1.prompt`), 'utf8')).toContain(
      '日本語の要件',
    );
  }
  expect(await readFile(join(t.config.runDir, 'check-1.stdout'), 'utf8')).toBe('確認結果');
  expect(await readFile(join(t.config.runDir, 'check-1.stderr'), 'utf8')).toBe('修正が必要');
  for (const [role, findings] of [
    ['repair', '修正済み'],
    ['review', '検証済み'],
  ]) {
    const reply = object(
      JSON.parse(await readFile(join(t.config.runDir, `${role}-1.stdout`), 'utf8')),
    );
    expect(reply.findings).toBe(findings);
  }
});
