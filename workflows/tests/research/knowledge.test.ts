/** @file Outcome: Research is automatically distilled into searchable topic-based Knowledge. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import {
  KNOWLEDGE_RESULT_LIMIT,
  searchKnowledge,
  readKnowledge,
  updateKnowledge,
} from '../../research/knowledge.ts';

import {
  canonicalReport,
  canonicalJson,
  corpusPaths,
  renderCorpusMarkdown,
} from '../../research/corpus.ts';
function persistResearchReport(
  repo: string,
  report: import('../../research/contracts.ts').ResearchReport,
) {
  const canonical = canonicalReport(report),
    paths = corpusPaths(repo, canonical.research_id);
  fs.mkdirSync(path.dirname(paths.json), { recursive: true });
  fs.mkdirSync(path.dirname(paths.markdown), { recursive: true });
  fs.writeFileSync(paths.json, canonicalJson(canonical));
  fs.writeFileSync(paths.markdown, renderCorpusMarkdown(canonical));
  return paths;
}
import { RESEARCH_REPORT_PROTOCOL, type ResearchReport } from '../../research/contracts.ts';
import { knowledgeArtifactDirectory, researchArtifactDirectory } from '../../runtime/storage.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('knowledge-index-');

function report(question: string, statement: string, generatedAt: string): ResearchReport {
  return {
    protocol: RESEARCH_REPORT_PROTOCOL,
    generated_at: generatedAt,
    question,
    scope_paths: [],
    answer: statement,
    findings: [
      {
        id: 'F-001',
        statement,
        kind: 'fact',
        confidence: 'high',
        qualification: null,
        evidence: [
          {
            kind: 'web',
            source: 'https://example.com/research',
            locator: 'test fixture',
            supports: statement,
          },
        ],
        implication: statement,
      },
    ],
    rejected: [],
    unknowns: [],
    limitations: [],
  };
}

test('an empty Knowledge index is optional and read-only', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  assert.deepEqual(readKnowledge(repo), []);
  assert.deepEqual(searchKnowledge(repo, '保存方式'), []);
  assert.equal(fs.existsSync(knowledgeArtifactDirectory(repo)), false);
});

test('groups related Research into one topic with source references', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  persistResearchReport(
    repo,
    report('保存方式を調査する', 'JSONへ保存できる。', '2026-09-01T00:00:00.000Z'),
  );
  persistResearchReport(
    repo,
    report('保存方式を比較する', 'SQLiteも利用できる。', '2026-09-02T00:00:00.000Z'),
  );
  persistResearchReport(
    repo,
    report('画面配色を調査する', '青を利用する。', '2026-09-03T00:00:00.000Z'),
  );

  const entries = updateKnowledge(repo);

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries[0]?.sources.map((source) => source.generated_at),
    ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
  );
  assert.equal(entries[0]?.sources.length, 2);
  assert.deepEqual(readKnowledge(repo), entries);
});

test('search returns relevant report references', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  persistResearchReport(
    repo,
    report('保存方式を調査する', 'SQLiteを利用する。', '2026-09-01T00:00:00.000Z'),
  );
  persistResearchReport(
    repo,
    report('画面配色を調査する', '青を利用する。', '2026-09-02T00:00:00.000Z'),
  );
  updateKnowledge(repo);

  assert.deepEqual(
    searchKnowledge(repo, 'SQLiteの保存方式').map((entry) => entry.topic),
    ['保存方式を調査する'],
  );
});

test('keeps the latest related report when older Research was explicitly selected', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  const selected = persistResearchReport(
    repo,
    report('保存方式を調査する', 'JSONへ保存できる。', '2026-09-01T00:00:00.000Z'),
  );
  persistResearchReport(
    repo,
    report('保存方式を比較する', 'SQLiteも利用できる。', '2026-09-02T00:00:00.000Z'),
  );
  updateKnowledge(repo);

  const results = searchKnowledge(repo, '保存方式', [selected.json]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.sources[0]?.generated_at, '2026-09-02T00:00:00.000Z');
});

test('rebuild recovers the derived index from valid Research', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  persistResearchReport(
    repo,
    report('保存方式を調査する', 'JSONへ保存できる。', '2026-09-01T00:00:00.000Z'),
  );
  const researchDirectory = researchArtifactDirectory(repo);
  fs.mkdirSync(researchDirectory, { recursive: true });
  fs.writeFileSync(path.join(researchDirectory, 'broken.json'), '{');
  const indexFile = path.join(knowledgeArtifactDirectory(repo), 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, '{');

  const rebuilt = updateKnowledge(repo);

  assert.equal(rebuilt.length, 1);
  assert.deepEqual(readKnowledge(repo), rebuilt);
});

test('Knowledge omits malformed UTF-8 originals from lookup and rebuilding', () => {
  const repo = temporaryDirectory('knowledge-corrupted-');
  const paths = persistResearchReport(
    repo,
    report(
      'Storage choice',
      'A literal replacement character: \uFFFD.',
      '2026-09-01T00:00:00.000Z',
    ),
  );
  const entries = updateKnowledge(repo);
  assert.equal(entries.length, 1);
  assert.equal(searchKnowledge(repo, 'storage').length, 1);
  const canonical = fs.readFileSync(paths.json);
  const offset = canonical.indexOf(Buffer.from('\uFFFD'));
  assert(offset >= 0);
  const corrupted = Buffer.concat([
    canonical.subarray(0, offset),
    Buffer.from([0xff]),
    canonical.subarray(offset + 3),
  ]);
  assert.equal(corrupted.toString('utf8'), canonical.toString('utf8'));
  fs.writeFileSync(paths.json, corrupted);
  assert.deepEqual(searchKnowledge(repo, 'storage'), []);
  assert.throws(() => updateKnowledge(repo), /corpus integrity/);
  assert.deepEqual(readKnowledge(repo), entries);
  assert.deepEqual(searchKnowledge(repo, 'storage'), []);
  assert.deepEqual(fs.readFileSync(paths.json), corrupted);
});

function source(repo: string, question: string, date: string) {
  const paths = persistResearchReport(repo, report(question, 'Current lead.', date));
  return {
    report: path.basename(paths.json),
    research_id: path.basename(paths.json, '.json'),
    generated_at: date,
  };
}
test('bounds topic results and selects one latest original report per topic', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  const indexFile = path.join(knowledgeArtifactDirectory(repo), 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const entries = Array.from({ length: 8 }, (_, index) => ({
    topic: `storage choice ${index}`,
    updated_at: `2026-09-0${index + 1}T00:00:00.000Z`,
    sources: [
      source(repo, `Older ${index}`, '2026-01-01T00:00:00.000Z'),
      source(repo, `Newer ${index}`, `2026-09-0${index + 1}T00:00:00.000Z`),
    ],
  }));
  fs.writeFileSync(indexFile, JSON.stringify(entries));
  const results = searchKnowledge(repo, 'storage');
  assert.equal(results.length, KNOWLEDGE_RESULT_LIMIT);
  assert.deepEqual(
    results.map((entry) => entry.sources[0]),
    [entries[7]!.sources[1], entries[6]!.sources[1], entries[5]!.sources[1]],
  );
  assert.equal(
    searchKnowledge(repo, 'storage', [entries[7]!.sources[1]!.report])[0]?.sources[0]?.report,
    entries[6]!.sources[1]!.report,
  );
  fs.unlinkSync(path.join(repo, 'research/records', entries[7]!.sources[1]!.report));
  assert.equal(
    searchKnowledge(repo, 'storage')[0]?.sources[0]?.report,
    entries[6]!.sources[1]!.report,
  );
});
test('deduplicates original reports shared by topics and does not fall back to old selected evidence', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  const indexFile = path.join(knowledgeArtifactDirectory(repo), 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const sources = [
    source(repo, 'Old storage', '2026-01-01T00:00:00.000Z'),
    source(repo, 'Latest storage', '2026-09-01T00:00:00.000Z'),
  ];
  fs.writeFileSync(
    indexFile,
    JSON.stringify(
      ['storage choice', 'storage architecture'].map((topic) => ({
        topic,
        updated_at: sources[1]!.generated_at,
        sources,
      })),
    ),
  );
  assert.equal(searchKnowledge(repo, 'storage').length, 1);
  assert.deepEqual(searchKnowledge(repo, 'storage', [sources[1]!.report]), []);
});
test('a fresh checkout rebuilds original references without any private artifacts', async () => {
  const { execFileSync } = await import('node:child_process');
  const configured = process.env.CODEX_FLOW_ARTIFACT_DIR;
  delete process.env.CODEX_FLOW_ARTIFACT_DIR;
  try {
    const repo = temporaryDirectory('knowledge-origin-');
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.codex/workflow-artifacts/\n');
    source(repo, 'Storage choices', '2026-09-01T00:00:00.000Z');
    const expected = updateKnowledge(repo);
    execFileSync('git', ['-C', repo, 'add', 'research', '.gitignore']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@users.noreply.github.com',
      'commit',
      '-qm',
      'Corpus fixture',
    ]);
    const checkout = path.join(temporaryDirectory('knowledge-checkout-'), 'repo');
    execFileSync('git', ['clone', '-q', repo, checkout]);
    assert.equal(fs.existsSync(path.join(checkout, '.codex/workflow-artifacts')), false);
    const before = execFileSync('git', ['-C', checkout, 'status', '--porcelain']).toString();
    assert.deepEqual(readKnowledge(checkout), []);
    assert.equal(fs.existsSync(path.join(checkout, '.codex/workflow-artifacts')), false);
    assert.deepEqual(updateKnowledge(checkout), expected);
    assert.equal(execFileSync('git', ['-C', checkout, 'status', '--porcelain']).toString(), before);
    assert.equal(execFileSync('git', ['-C', checkout, 'diff', 'HEAD']).toString(), '');
  } finally {
    if (configured === undefined) delete process.env.CODEX_FLOW_ARTIFACT_DIR;
    else process.env.CODEX_FLOW_ARTIFACT_DIR = configured;
  }
});
test('private and legacy reports never contribute and a drifted Markdown view is not an independent source', async () => {
  const repo = temporaryDirectory('knowledge-private-');
  const { persistResearchReport: persistPrivate } = await import('../../research/artifact.ts');
  persistPrivate(repo, report('Private storage', 'Private fact.', '2026-09-01T00:00:00.000Z'));
  assert.deepEqual(updateKnowledge(repo), []);
  const publicReport = source(repo, 'Shared storage', '2026-09-02T00:00:00.000Z');
  fs.appendFileSync(
    path.join(repo, 'research/reports', `${publicReport.research_id}.md`),
    'Unverified addition',
  );
  assert.throws(() => updateKnowledge(repo), /corpus integrity/);
  assert.deepEqual(readKnowledge(repo), []);
  assert.deepEqual(searchKnowledge(repo, 'storage'), []);
});

for (const damage of ['drifted view', 'missing view', 'missing original', 'missing pair'] as const)
  test(`rebuilding with a ${damage} never revives an older topic original`, () => {
    const repo = temporaryDirectory('knowledge-no-fallback-');
    source(repo, 'Storage choices', '2026-09-01T00:00:00.000Z');
    const newest = source(repo, 'Storage choices', '2026-09-02T00:00:00.000Z');
    const entries = updateKnowledge(repo);
    const indexFile = path.join(knowledgeArtifactDirectory(repo), 'index.json');
    const originalIndex = fs.readFileSync(indexFile);
    const paths = corpusPaths(repo, newest.research_id);
    assert.equal(searchKnowledge(repo, 'storage')[0]?.sources[0]?.research_id, newest.research_id);
    if (damage === 'drifted view') fs.appendFileSync(paths.markdown, 'Invalid view');
    if (damage === 'missing view' || damage === 'missing pair') fs.unlinkSync(paths.markdown);
    if (damage === 'missing original' || damage === 'missing pair') fs.unlinkSync(paths.json);
    assert.deepEqual(searchKnowledge(repo, 'storage'), []);

    // An unrelated completed publication runs this same production rebuild entrypoint.
    source(repo, 'Screen colors', '2026-09-03T00:00:00.000Z');
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(
        () => updateKnowledge(repo),
        /corpus integrity|unavailable latest Research|ENOENT/,
      );
      assert.deepEqual(fs.readFileSync(indexFile), originalIndex);
      assert.deepEqual(readKnowledge(repo), entries);
      assert.deepEqual(searchKnowledge(repo, 'storage'), []);
    }
    // Restoring genuine bytes makes the corpus and its derived index usable again.
    persistResearchReport(
      repo,
      report('Storage choices', 'Current lead.', '2026-09-02T00:00:00.000Z'),
    );
    updateKnowledge(repo);
    assert.equal(searchKnowledge(repo, 'storage')[0]?.sources[0]?.research_id, newest.research_id);
    assert.equal(searchKnowledge(repo, 'screen').length, 1);
  });

test('Research Knowledge lookup validates immutable snapshot originals even after live deletion', async () => {
  const { execFileSync } = await import('node:child_process');
  const { createRepositorySnapshot } = await import('../../execution/repository-isolation.ts');
  const repo = temporaryDirectory('knowledge-sealed-');
  execFileSync('git', ['init', '-q', repo]);
  const original = source(repo, 'Storage choices', '2026-09-01T00:00:00.000Z');
  updateKnowledge(repo);
  const snapshot = path.join(temporaryDirectory('knowledge-snapshot-'), 'repo');
  createRepositorySnapshot(repo, snapshot);
  fs.unlinkSync(path.join(repo, 'research/records', original.report));
  assert.deepEqual(searchKnowledge(repo, 'storage'), []);
  assert.equal(
    searchKnowledge(repo, 'storage', [], snapshot)[0]?.sources[0]?.research_id,
    original.research_id,
  );
});
