import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostEvidenceShape } from '../../implement/host-records.ts';
import { correctionFixture, reviewReplySource } from '../support/correction.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

for (const status of ['repaired', 'needs_host']) {
  test(`external verification pending: ${status}`, async () => {
    const t = await trial('docs', { reviewLimit: 3 });
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await writeFile(
      join(t.root, 'helper.js'),
      `
      import {readFileSync} from 'node:fs';
      const role=process.argv[2];
      ${reviewReplySource}
      if(role==='issue') console.log('Agreed requirement: correct source and docs');
      if(role==='check') process.exit(0);
      if(role==='review') console.log(JSON.stringify(reviewReply('needs_changes','External measurement is missing')));
      if(role==='repair') console.log(JSON.stringify({status:${JSON.stringify(status)},findings:'Measure the current source on the authorized host; normal check only checks syntax. Retain measured results and logs.'}));
    `,
    );
    expect(t.execute().status).toBe(1);
    const state = await t.state();
    expect(state).toMatchObject(
      status === 'repaired'
        ? { result: 'execution_limit', checks: 3, review: 3, repair: 2 }
        : { result: 'host_verification_required', checks: 1, review: 1, repair: 1 },
    );
    expect(await readFile(join(t.config.runDir, 'repair-1.stdout'), 'utf8')).toContain('Measure');
  });
}

test('host evidence binds absolute log paths and nonblank findings', () => {
  const value = {
    status: 'passed',
    source: 'a'.repeat(64),
    findings: 'Measured the agreed target',
    logs: [{ path: '/tmp/log', sha256: 'b'.repeat(64) }],
  };
  expect(hostEvidenceShape.safeParse(value).success).toBe(true);
  for (const changed of [
    { ...value, findings: ' \t\n' },
    { ...value, logs: [] },
    { ...value, logs: [{ path: 'log', sha256: 'b'.repeat(64) }] },
  ]) {
    expect(hostEvidenceShape.safeParse(changed).success).toBe(false);
  }
});
