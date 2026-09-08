/** @file Outcome: Corpus identity, paired views and creation-only publication are independently verifiable. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import {
  canonicalJson,
  canonicalReport,
  corpusPaths,
  publishCorpusPair,
  readCorpusReport,
  renderCorpusMarkdown,
  sha256,
  verifyResearchCorpus,
} from '../../research/corpus.ts';
import type { ResearchReport } from '../../research/contracts.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

const report: ResearchReport = {
  protocol: 'codex-research-report',
  generated_at: '2026-09-01T00:00:00.000Z',
  question: 'Which boundary applies?',
  scope_paths: ['src'],
  answer: 'Preserve <literal> syntax | and\nnewlines.',
  findings: [],
  rejected: [{ statement: 'Earlier claim', reason: 'Not established.' }],
  unknowns: [{ question: 'Which value?', resolution: 'Inspect current evidence.' }],
  limitations: ['Dated evidence.'],
};
function fixture() {
  return {
    repo: temporaryDirectory('corpus-repo-'),
    staging: temporaryDirectory('corpus-staging-'),
    report: canonicalReport(report),
  };
}
test('equivalent parsed reports have identical canonical UTF-8 bytes, identities and faithful rendering', () => {
  const first = canonicalReport(report);
  const reordered = Object.fromEntries(
    Object.entries(report).reverse(),
  ) as unknown as ResearchReport;
  assert.equal(canonicalJson(first), canonicalJson(canonicalReport(reordered)));
  const { research_id, ...original } = first;
  assert.equal(research_id, sha256(canonicalJson(original)));
  assert.equal(renderCorpusMarkdown(first), renderCorpusMarkdown(canonicalReport(reordered)));
  const view = renderCorpusMarkdown(first).replace(/&#(\d+);/gu, (_, number: string) =>
    String.fromCodePoint(Number(number)),
  );
  assert(view.includes(report.answer));
  assert(view.includes(report.rejected[0]!.reason));
  assert(view.includes('/scope_paths/0'));
});
test('empty and valid corpora verify; identical publication performs no rewriting and conflicts preserve bytes', async () => {
  const f = fixture();
  assert.deepEqual(verifyResearchCorpus(f.repo), []);
  const paths = await publishCorpusPair(f.repo, f.report, f.staging);
  assert.deepEqual(verifyResearchCorpus(f.repo), [f.report]);
  const sentinel = new Date('2000-01-01T00:00:00.000Z');
  for (const file of Object.values(paths)) fs.utimesSync(file, sentinel, sentinel);
  await publishCorpusPair(f.repo, f.report, '/unneeded-staging', true);
  for (const file of Object.values(paths))
    assert.equal(fs.statSync(file).mtimeMs, sentinel.getTime());
  fs.writeFileSync(paths.markdown, 'conflicting view');
  await assert.rejects(publishCorpusPair(f.repo, f.report, f.staging));
  assert.equal(fs.readFileSync(paths.markdown, 'utf8'), 'conflicting view');
});
test('verifier rejects noncanonical JSON, identity mismatch, missing pairs, unexpected files and unsafe entries', async () => {
  for (const mutation of [
    'json',
    'identity',
    'missing-json',
    'missing-view',
    'view',
    'extra',
    'symlink',
    'directory',
    'filename',
    'root-link',
  ]) {
    const f = fixture();
    const paths = await publishCorpusPair(f.repo, f.report, f.staging);
    if (mutation === 'json') fs.writeFileSync(paths.json, JSON.stringify(f.report, null, 2));
    if (mutation === 'identity')
      fs.writeFileSync(paths.json, canonicalJson({ ...f.report, research_id: 'a'.repeat(64) }));
    if (mutation === 'missing-json') fs.unlinkSync(paths.json);
    if (mutation === 'missing-view') fs.unlinkSync(paths.markdown);
    if (mutation === 'view') fs.appendFileSync(paths.markdown, 'invented claim');
    if (mutation === 'extra')
      fs.writeFileSync(path.join(f.repo, 'research/records/notes.txt'), 'unexpected');
    if (mutation === 'symlink') {
      fs.unlinkSync(paths.json);
      fs.symlinkSync(path.join(f.staging, 'json'), paths.json);
    }
    if (mutation === 'directory') fs.mkdirSync(path.join(f.repo, 'research/records/nested'));
    if (mutation === 'filename')
      fs.renameSync(paths.json, paths.json.replace(f.report.research_id, 'b'.repeat(64)));
    if (mutation === 'root-link') {
      fs.renameSync(path.join(f.repo, 'research'), path.join(f.repo, 'outside'));
      fs.symlinkSync('outside', path.join(f.repo, 'research'));
    }
    assert.throws(() => verifyResearchCorpus(f.repo), mutation);
  }
});
test('malformed UTF-8 cannot impersonate a canonical replacement character', async () => {
  for (const invalid of [[0xff], [0x80], [0xe2, 0x82]]) {
    const f = fixture();
    f.report = canonicalReport({ ...report, answer: 'A literal replacement character: \uFFFD.' });
    const paths = await publishCorpusPair(f.repo, f.report, f.staging);
    assert.deepEqual(verifyResearchCorpus(f.repo), [f.report]);
    const canonical = fs.readFileSync(paths.json);
    const offset = canonical.indexOf(Buffer.from('\uFFFD'));
    assert(offset >= 0);
    const corrupted = Buffer.concat([
      canonical.subarray(0, offset),
      Buffer.from(invalid),
      canonical.subarray(offset + 3),
    ]);
    assert.equal(corrupted.toString('utf8'), canonical.toString('utf8'));
    assert.notDeepEqual(corrupted, canonical);
    fs.writeFileSync(paths.json, corrupted);
    assert.throws(() => readCorpusReport(f.repo, paths.json));
    assert.throws(() => verifyResearchCorpus(f.repo));
    // Neither ordinary reuse nor completed retrieval may accept the corrupted pair.
    for (const completed of [false, true])
      await assert.rejects(publishCorpusPair(f.repo, f.report, f.staging, completed));
    assert.deepEqual(fs.readFileSync(paths.json), corrupted);
    // A missing view must not authorize repair from a corrupted original.
    fs.unlinkSync(paths.markdown);
    await assert.rejects(publishCorpusPair(f.repo, f.report, f.staging, true));
    assert.equal(fs.existsSync(paths.markdown), false);
    assert.deepEqual(fs.readFileSync(paths.json), corrupted);
    // The hard-linked private staging bytes are corrupted too; reject them before relinking.
    fs.unlinkSync(paths.json);
    await assert.rejects(publishCorpusPair(f.repo, f.report, f.staging));
    assert.equal(fs.existsSync(paths.json), false);
    assert.equal(fs.existsSync(paths.markdown), false);
    assert.deepEqual(fs.readFileSync(path.join(f.staging, 'json')), corrupted);
  }
});
test('unowned partial pairs are not adopted or removed; owned interruptions reconcile and simultaneous identical publishers reuse a pair', async () => {
  const f = fixture(),
    paths = corpusPaths(f.repo, f.report.research_id);
  fs.mkdirSync(path.dirname(paths.json), { recursive: true });
  fs.writeFileSync(paths.json, canonicalJson(f.report));
  await assert.rejects(publishCorpusPair(f.repo, f.report, f.staging));
  assert.equal(fs.readFileSync(paths.json, 'utf8'), canonicalJson(f.report));
  fs.unlinkSync(paths.json);
  fs.writeFileSync(path.join(f.staging, 'json'), canonicalJson(f.report));
  fs.linkSync(path.join(f.staging, 'json'), paths.json);
  await publishCorpusPair(f.repo, f.report, f.staging);
  assert.deepEqual(readCorpusReport(f.repo, paths.json), f.report);
  assert.deepEqual(
    await Promise.all([
      publishCorpusPair(f.repo, f.report, f.staging),
      publishCorpusPair(f.repo, f.report, temporaryDirectory('other-staging-')),
    ]),
    [paths, paths],
  );
});

test('independent processes coordinate identical pairs across TMPDIR values and repository aliases', async () => {
  const f = fixture();
  const other = temporaryDirectory('corpus-other-publisher-');
  const script = path.join(temporaryDirectory('corpus-process-'), 'publish.ts');
  const module = new URL('../../research/corpus.ts', import.meta.url).pathname;
  const alias = path.join(temporaryDirectory('corpus-alias-'), 'repo');
  fs.symlinkSync(f.repo, alias);
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
     import {publishCorpusPair} from ${JSON.stringify(module)};
     const link = fs.linkSync;
     fs.linkSync = (...args) => {
       link(...args);
       if (String(args[1]).endsWith('.json')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
     };
     await publishCorpusPair(process.argv[3], ${JSON.stringify(f.report)}, process.argv[2]);`,
  );
  const children = [f.staging, other].map((staging, index) =>
    Bun.spawn([process.execPath, script, staging, index === 0 ? f.repo : alias], {
      env: { ...process.env, TMPDIR: staging },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  for (const child of children)
    assert.equal(await child.exited, 0, await new Response(child.stderr).text());
  assert.deepEqual(verifyResearchCorpus(f.repo), [f.report]);
  assert.equal(fs.readdirSync(f.staging).length + fs.readdirSync(other).length, 2);
});
