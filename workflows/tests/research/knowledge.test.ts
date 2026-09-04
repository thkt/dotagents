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

import { persistResearchReport } from '../../research/artifact.ts';
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
  fs.writeFileSync(path.join(researchDirectory, 'broken.json'), '{');
  const indexFile = path.join(knowledgeArtifactDirectory(repo), 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, '{');

  const rebuilt = updateKnowledge(repo);

  assert.equal(rebuilt.length, 1);
  assert.deepEqual(readKnowledge(repo), rebuilt);
});

test('bounds topic results and selects one latest original report per topic', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  const indexFile = path.join(knowledgeArtifactDirectory(repo), 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(
    indexFile,
    JSON.stringify(
      Array.from({ length: 8 }, (_, index) => ({
        topic: `storage choice ${index}`,
        updated_at: `2026-09-0${index + 1}T00:00:00.000Z`,
        sources: [
          { report: `old-${index}.json`, generated_at: '2026-01-01T00:00:00.000Z' },
          { report: `new-${index}.json`, generated_at: `2026-09-0${index + 1}T00:00:00.000Z` },
        ],
      })),
    ),
  );
  const results = searchKnowledge(repo, 'storage');
  assert.equal(results.length, KNOWLEDGE_RESULT_LIMIT);
  assert.deepEqual(
    results.map((entry) => entry.sources.map((source) => source.report)),
    [['new-7.json'], ['new-6.json'], ['new-5.json']],
  );
  assert.equal(
    searchKnowledge(repo, 'storage', ['new-7.json'])[0]?.sources[0]?.report,
    'new-6.json',
  );
});

test('deduplicates original reports shared by topics and does not fall back to old selected evidence', () => {
  const repo = temporaryDirectory('knowledge-repo-');
  const indexFile = path.join(knowledgeArtifactDirectory(repo), 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(
    indexFile,
    JSON.stringify(
      ['storage choice', 'storage architecture'].map((topic) => ({
        topic,
        updated_at: '2026-09-01T00:00:00.000Z',
        sources: [
          { report: 'old.json', generated_at: '2026-01-01T00:00:00.000Z' },
          { report: 'latest.json', generated_at: '2026-09-01T00:00:00.000Z' },
        ],
      })),
    ),
  );
  assert.equal(searchKnowledge(repo, 'storage').length, 1);
  assert.deepEqual(searchKnowledge(repo, 'storage', ['latest.json']), []);
});
