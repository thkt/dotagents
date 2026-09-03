/** @file Outcome: Research is automatically distilled into searchable topic-based Knowledge. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { searchKnowledge } from '../../knowledge/search.ts';
import { readKnowledge, updateKnowledge } from '../../knowledge/update.ts';
import { persistResearchReport } from '../../research/artifact.ts';
import { RESEARCH_REPORT_PROTOCOL, type ResearchReport } from '../../research/contracts.ts';
import { knowledgeArtifactDirectory, researchArtifactDirectory } from '../../shared/storage.ts';
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
  assert.deepEqual(entries[0]?.summary.split('\n'), ['JSONへ保存できる。', 'SQLiteも利用できる。']);
  assert.equal(entries[0]?.sources.length, 2);
  assert.deepEqual(readKnowledge(repo), entries);
});

test('search returns related Knowledge without a fixed result limit', () => {
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

test('omits a topic when it contains explicitly selected Research', () => {
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

  assert.deepEqual(searchKnowledge(repo, '保存方式', [selected.json]), []);
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
