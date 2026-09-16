import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { correctionFixture, events, object, reviewReplySource } from './support/correction.ts';
import { git } from './support/target.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

async function reviewer(t: Awaited<ReturnType<typeof trial>>, body: string) {
  const path = join(t.root, 'review.js');
  await writeFile(
    path,
    `import {readFileSync,writeFileSync} from 'node:fs';
const role='review';
${reviewReplySource}
${body}
console.log(JSON.stringify(reply));`,
  );
  t.config.review = [process.execPath, path];
  await writeFile(t.configFile, JSON.stringify(t.config));
}

// Each mutation isolates an external response error with an otherwise valid response/check.
for (const [name, mutation, reason] of [
  ['target', "reply.targetId='different-source'", 'target mismatch'],
  ['non-string enum', "reply.items[0].kind=['defect']", 'Missing or invalid'],
  ['required field', 'delete reply.assessments.tests', 'Missing or invalid'],
  ['unresolved accepted', "reply.status='accepted'", 'contradicts required'],
  ['empty rejection', 'reply.items=[]', 'contradicts required'],
  ['duplicate ID', 'reply.items.push(reply.items[0])', 'Duplicate finding'],
  ['invented introduction', "reply.items[0].introducedIn='old-target'", 'Invalid new finding'],
  [
    'document outside target',
    "reply.documents=[{path:'missing.md',role:'current',reason:'Policy'}]",
    'not in reviewed source',
  ],
] as const) {
  test(`review rejects ${name} and preserves the raw response and target`, async () => {
    const t = await trial('normal');
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await reviewer(
      t,
      `const reply=reviewReply('needs_changes','Concrete documentation defect'); ${mutation};`,
    );
    const result = t.execute();
    expect(result.status).toBe(1);
    const state = await t.state();
    expect(state.result).toBe('invalid_review');
    expect(state.findings).toContain(reason);
    expect(state.reviewHistory).toEqual([]);
    expect(state.repair).toBe(0);
    expect(await Bun.file(join(t.config.runDir, 'review-1.stdout')).exists()).toBe(true);
    const target = object(
      JSON.parse(await readFile(join(t.config.runDir, 'review-1.target.json'), 'utf8')),
    );
    expect(target.source).toBe(state.source);
    expect(await Bun.file(join(t.config.runDir, 'review-1.json')).exists()).toBe(false);
  });
}

for (const disposition of ['fixed', 'not_applicable', 'omitted', 'rewritten'] as const) {
  test(`re-evaluation adjudicates prior findings: ${disposition}`, async () => {
    const t = await trial('docs');
    if (disposition === 'not_applicable') {
      await writeFile(join(t.config.cwd, 'README.md'), 'current');
    }
    await reviewer(
      t,
      `writeFileSync(${JSON.stringify(join(t.root, 'reviewed'))},'1');
const reply=reviewReply(reviewContext.previous?'accepted':'needs_changes','Review summary');
if(reviewContext.previous) {
 ${disposition === 'omitted' ? 'reply.items=[];' : ''}
 ${disposition === 'rewritten' ? 'reply.items[0].required=false;' : ''}
 ${disposition === 'not_applicable' ? "reply.items[0].disposition='not_applicable'; reply.items[0].reason='README.md was present in both versions with current instructions; the original missing-file claim was incorrect.';" : ''}
}`,
    );
    const result = t.execute();
    const valid = disposition === 'fixed' || disposition === 'not_applicable';
    expect(result.status).toBe(valid ? 0 : 1);
    const state = await t.state();
    expect(state.result).toBe(valid ? 'ready_for_human_review' : 'invalid_review');
    const history = events(state.reviewHistory).map(object);
    expect(history.length).toBe(valid ? 2 : 1);
    const first = object(events(history[0]?.items)[0]);
    expect(first.disposition).toBe('open');
    if (valid) {
      expect([state.repair, state.review]).toEqual([2, 2]);
      expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
      expect(await readFile(join(t.config.cwd, 'README.md'), 'utf8')).toBe('current');
      const latest = object(events(history[1]?.items)[0]);
      expect(latest.id).toBe(first.id);
      expect(latest.introducedIn).toBe(history[0]?.targetId);
      expect(latest.disposition).toBe(disposition);
      expect(state.findings).toContain(latest.reason);
      expect(state.findings).toContain('review-1.json');
      expect(state.findings).toContain('review-2.json');
    } else {
      expect(state.findings).toContain(
        disposition === 'omitted' ? 'Prior finding omitted' : 'Prior finding details changed',
      );
    }
    expect(await readFile(join(t.config.runDir, 'review-2.prompt'), 'utf8')).toContain(
      String(first.introducedIn),
    );
    expect(await readFile(join(t.config.runDir, 'repair-2.prompt'), 'utf8')).toContain(
      String(first.id),
    );
  });
}

test('repair after a failed check retains prior review findings and current failure evidence', async () => {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  await reviewer(
    t,
    "const reply=reviewReply(reviewContext.previous?'accepted':'needs_changes','Documentation review');",
  );
  const repair = join(t.root, 'repair.js');
  await writeFile(
    repair,
    `import {readFileSync,writeFileSync} from 'node:fs';
readFileSync(0,'utf8');
const recovering=readFileSync('source.txt','utf8')==='broken';
writeFileSync('source.txt',recovering?'correct':'broken');
writeFileSync('README.md','current');
console.log(JSON.stringify({status:'repaired',findings:'Updated source and documentation'}));`,
  );
  t.config.repair = [process.execPath, repair];
  await writeFile(t.configFile, JSON.stringify(t.config));
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  expect(state.result).toBe('ready_for_human_review');
  expect([state.checks, state.repair, state.review]).toEqual([3, 2, 2]);
  const history = events(state.reviewHistory).map(object);
  const first = object(events(history[0]?.items)[0]);
  const prompt = await readFile(join(t.config.runDir, 'repair-2.prompt'), 'utf8');
  expect(prompt).toContain('check-2.stdout');
  expect(prompt).toContain('check-2.stderr');
  expect(prompt).toContain(String(first.id));
  expect(prompt).toContain(String(first.introducedIn));
  expect(prompt).toContain(String(first.evidence));
  expect(prompt).toContain(String(first.action));
  expect(prompt).toContain('review-1.json');
  expect(object(events(history[1]?.items)[0]).disposition).toBe('fixed');
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('correct');
  expect(await readFile(join(t.config.cwd, 'README.md'), 'utf8')).toBe('current');
});

test('accepted concerns, document versions, base diff, check and model remain traceable', async () => {
  const t = await trial('normal', {
    reviewModel: { model: 'fixture-model', reasoningEffort: 'high' },
  });
  await writeFile(join(t.config.cwd, 'README.md'), 'Current operating instructions');
  git(t.config.cwd, 'add', 'source.txt');
  git(t.config.cwd, 'commit', '-m', 'source base');
  const base = git(t.config.cwd, 'rev-parse', 'HEAD');
  await reviewer(
    t,
    `const reply=reviewReply('needs_changes','Ready with an unverified concern');
reply.status='accepted'; reply.items[0].kind='concern'; reply.items[0].required=false;
reply.documents=[{path:'README.md',role:'current',reason:'Operating instructions for this change'}];`,
  );
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  const target = object(
    JSON.parse(await readFile(join(t.config.runDir, 'review-1.target.json'), 'utf8')),
  );
  expect(target.baseCommit).toBe(base);
  expect(object(target.issue).hash).toBe(state.issueHash);
  expect(object(target.issue).content).toContain('Agreed requirement');
  expect(object(target.check).command).toEqual(t.config.check);
  expect(object(target.check).code).toBe(0);
  expect(object(target.check).source).toBe(state.source);
  expect(object(target.model).settings).toEqual(t.config.reviewModel);
  const record = object(JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8')));
  expect(object(record.review).targetId).toBe(target.targetId);
  expect(object(events(record.documents)[0]).hash).toBe(
    createHash('sha256').update('Current operating instructions').digest('hex'),
  );
  expect(await readFile(join(t.config.runDir, 'review-1.diff'), 'utf8')).toContain('+correct');
  expect(await readFile(join(t.config.runDir, 'review-1.additions.json'), 'utf8')).toContain(
    'README.md',
  );
  expect(state.findings).toContain('Human review and publication remain');
});

test('historical review runs are preserved without conversion or renewed execution', async () => {
  const t = await trial('normal');
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  delete state.reviewFormat;
  delete state.reviewHistory;
  const old = JSON.stringify(state);
  await writeFile(join(t.config.runDir, 'state.json'), old);
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Historical review format cannot be converted or resumed');
  expect(await readFile(join(t.config.runDir, 'state.json'), 'utf8')).toBe(old);
});

test('selected evidence reaches repair and review with original versions and changed applicability', async () => {
  const t = await trial('normal');
  const path = 'research/reset.md';
  const proposal = 'research/keyboard.md';
  const original =
    'Observed: pointer reset clears filters; keyboard behavior unverified. Source: source.txt at baseline.\n';
  const updated =
    'Observed: pointer reset clears filters; keyboard reset also verified by the new targeted check.\n';
  await mkdir(join(t.config.cwd, 'research'));
  await writeFile(join(t.config.cwd, path), original);
  await writeFile(
    join(t.config.cwd, proposal),
    'Proposal only: move focus to the first result on keyboard reset. No agreement.\n',
  );
  git(t.config.cwd, 'add', 'research');
  git(t.config.cwd, 'commit', '-m', 'selected evidence');
  const base = git(t.config.cwd, 'rev-parse', 'HEAD');
  const reports = [path, proposal].map((path) => ({
    path,
    blob: git(t.config.cwd, 'rev-parse', `HEAD:${path}`),
  }));
  t.config.baseCommit = base;
  t.config.reports = reports;
  const repair = join(t.root, 'repair.js');
  await writeFile(
    repair,
    `import {writeFileSync} from 'node:fs';
writeFileSync('source.txt','correct');
writeFileSync(${JSON.stringify(path)},${JSON.stringify(updated)});
console.log(JSON.stringify({status:'repaired',findings:'Fixture evidence updated; focus proposal remains unagreed'}));`,
  );
  t.config.repair = [process.execPath, repair];
  // The simulated judgment exercises transport only, not model semantic accuracy.
  await reviewer(
    t,
    `const reply=reviewReply('accepted','Scoped evidence assessed');
reply.assessments.requirements='Pointer and keyboard evidence have different applicability; focus movement is an unagreed proposal, not a requirement.';
reply.documents=[
 {path:${JSON.stringify(path)},role:'current',reason:'New keyboard observation supersedes the handoff limitation; compare startCommit before reuse'},
 {path:${JSON.stringify(proposal)},role:'proposal',reason:'Focus movement has no agreement; excluded from implementation scope'}
];`,
  );
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  expect([state.repair, state.review]).toEqual([1, 1]);
  for (const role of ['repair', 'review']) {
    const prompt = await readFile(join(t.config.runDir, `${role}-1.prompt`), 'utf8');
    const references: unknown = JSON.parse(
      prompt.split('Implementation references: ')[1]?.split('\n')[0] ?? 'null',
    );
    expect(references).toEqual({ startCommit: base, reports });
    expect(prompt).not.toContain(original.trim());
    expect(prompt).not.toContain(updated.trim());
  }
  const target = object(
    JSON.parse(await readFile(join(t.config.runDir, 'review-1.target.json'), 'utf8')),
  );
  expect(target.reports).toEqual(reports);
  expect(target.baseCommit).toBe(base);
  const record = object(JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8')));
  expect(object(events(record.documents)[0]).hash).toBe(
    createHash('sha256').update(updated).digest('hex'),
  );
  expect(git(t.config.cwd, 'show', `${base}:${path}`)).toBe(original.trim());
  expect(state.findings).toContain(`${proposal} (proposal)`);
  expect(state.findings).toContain('Focus movement has no agreement');
  // A later evidence-only edit cannot reuse the accepted result.
  await writeFile(join(t.config.cwd, path), 'Keyboard observation withdrawn.\n');
  const stale = t.execute();
  expect(stale.status).toBe(1);
  expect(object(JSON.parse(stale.stdout)).result).toBe('target_changed_after_stop');
});

test('standalone correction rejects a stale report pin before executing verification', async () => {
  const t = await trial('normal');
  const path = 'research/reset.md';
  await mkdir(join(t.config.cwd, 'research'));
  await writeFile(join(t.config.cwd, path), 'Reviewed pointer behavior');
  const blob = git(t.config.cwd, 'hash-object', '--no-filters', '--', path);
  await writeFile(join(t.config.cwd, path), 'Changed pointer behavior');
  git(t.config.cwd, 'add', 'research');
  git(t.config.cwd, 'commit', '-m', 'different evidence');
  t.config.baseCommit = git(t.config.cwd, 'rev-parse', 'HEAD');
  t.config.reports = [{ path, blob }];
  await writeFile(t.configFile, JSON.stringify(t.config));
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Required report differs from reviewed version: ${path}`);
  expect(await Bun.file(join(t.config.runDir, 'check-1.stdout')).exists()).toBe(false);
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
});
