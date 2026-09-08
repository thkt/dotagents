/** @file Outcome: Think turns a semantic request into one reviewed Plan or research questions. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import type { ThinkAgent, ThinkResearchContext } from '../../think/agent.ts';
import {
  parseThinkDecision,
  parseThinkReport,
  validateThinkInput,
  type ThinkDecision,
  type ThinkDraft,
  type ThinkInput,
} from '../../think/contracts.ts';
import { runThinkWorkflow } from '../../think/runner.ts';
import { armIntent } from '../../runtime/invocation.ts';
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
import { updateKnowledge } from '../../research/knowledge.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-think-tests-');

const ready: ThinkDecision = {
  status: 'ready',
  research_questions: [],
  plan: {
    outcome: '値を保存して取得できる。',
    test_command: 'bun test',
    units: [
      {
        goal: '値を保存する。',
        files: ['src/value.ts'],
        contract: '保存した値を取得すると同じ値を返す。',
        tests: ['保存した値を取得すると同じ値になる。'],
      },
    ],
  },
};

function repository(): string {
  const repo = temporaryDirectory('codex-think-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Think Test',
    '-c',
    'user.email=think@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return repo;
}

class Agent implements ThinkAgent {
  reviews = 0;
  research: ThinkResearchContext[] = [];
  knowledge: ThinkResearchContext[] = [];
  private readonly draft: ThinkDraft;
  constructor(draft: ThinkDraft) {
    this.draft = draft;
  }
  async design(
    input: ThinkInput,
    research: ThinkResearchContext[],
    knowledge: ThinkResearchContext[],
    _contract: unknown,
    snapshotRepo: string,
  ) {
    assert.notEqual(snapshotRepo, input.repo);
    this.research = research;
    this.knowledge = knowledge;
    return this.draft;
  }
  async review() {
    this.reviews++;
    return { summary: 'The candidate meets the request.', findings: [] };
  }
}

async function runRequest(input: ThinkInput, agent: ThinkAgent) {
  const intent = armIntent({ runId: crypto.randomUUID(), workflow: 'think', cwd: input.repo });
  fs.writeFileSync(intent.input_path, JSON.stringify(input));
  const result = await runThinkWorkflow(intent.run_id, intent.input_path, agent);
  return {
    ...result,
    report: parseThinkReport(JSON.parse(fs.readFileSync(result.report_json!, 'utf8'))),
  };
}

function archivedReport(question: string): ResearchReport {
  const answer = `${question}への回答`;
  return {
    protocol: RESEARCH_REPORT_PROTOCOL,
    generated_at: new Date().toISOString(),
    question,
    scope_paths: [],
    answer,
    findings: [
      {
        id: 'F-001',
        statement: answer,
        kind: 'fact',
        confidence: 'high',
        qualification: null,
        evidence: [
          {
            kind: 'web',
            source: 'https://example.com/research',
            locator: 'test fixture',
            supports: answer,
          },
        ],
        implication: answer,
      },
    ],
    rejected: [],
    unknowns: [],
    limitations: [],
  };
}

test('input contains only repo, request, and optional Research reports', () => {
  const repo = repository();
  assert.deepEqual(validateThinkInput({ repo, request: '保存を追加する' }), {
    repo,
    request: '保存を追加する',
    research_reports: [],
  });
});

test('persists the reviewed ready Plan as the Issue handoff', async () => {
  const repo = repository();
  const result = await runRequest(
    { repo, request: '保存を追加する', research_reports: [] },
    new Agent(ready),
  );
  assert.equal(result.report.status, 'ready');
  assert.deepEqual(
    parseThinkReport(JSON.parse(fs.readFileSync(result.report_json!, 'utf8'))),
    result.report,
  );
  assert.match(fs.readFileSync(result.report_markdown!, 'utf8'), /## Plan/u);
});

test('automatically supplies related Knowledge to Think', async () => {
  const repo = repository();
  persistResearchReport(repo, archivedReport('保存方式を調査する'));
  persistResearchReport(repo, archivedReport('画面配色を調査する'));
  updateKnowledge(repo);
  const agent = new Agent(ready);

  await runRequest({ repo, request: '保存方式を変更する', research_reports: [] }, agent);

  assert.deepEqual(agent.research, []);
  assert.deepEqual(
    agent.knowledge.map(({ question }) => question),
    ['保存方式を調査する'],
  );
});

test('does not duplicate explicitly selected Research through Knowledge', async () => {
  const repo = repository();
  const selected = persistResearchReport(repo, archivedReport('保存方式を調査する')).json;
  updateKnowledge(repo);
  const agent = new Agent(ready);

  await runRequest({ repo, request: '保存方式を変更する', research_reports: [selected] }, agent);

  assert.equal(agent.research.length, 1);
  assert.equal(agent.knowledge.length, 0);
});

test('rejects mixed or empty terminal states', () => {
  assert.throws(
    () => parseThinkDecision({ ...ready, research_questions: ['追加調査'] }),
    /cannot contain unresolved research questions/u,
  );
  assert.throws(
    () => parseThinkDecision({ status: 'research_required', plan: null, research_questions: [] }),
    /must contain a research question/u,
  );
});

test('uses original latest evidence without merging contradictory archived findings', async () => {
  const repo = repository();
  const old = archivedReport('storage choice');
  old.generated_at = '2026-01-01T00:00:00.000Z';
  old.findings[0]!.statement = 'Use obsolete storage';
  persistResearchReport(repo, old);
  const current = archivedReport('storage choice');
  current.generated_at = '2026-09-01T00:00:00.000Z';
  current.findings[0]!.statement = 'Current storage evidence';
  const artifact = persistResearchReport(repo, current);
  updateKnowledge(repo);
  const agent = new Agent(ready);
  const result = await runRequest({ repo, request: 'storage choice', research_reports: [] }, agent);
  assert.deepEqual(result.report.research_reports, [path.basename(artifact.json)]);
  assert.equal(agent.knowledge.length, 1);
  assert.equal(agent.knowledge[0]?.path, path.basename(artifact.json));
  assert.equal(agent.knowledge[0]?.generated_at, current.generated_at);
  assert.deepEqual(agent.knowledge[0]?.findings, current.findings);
  assert.deepEqual(agent.knowledge[0]?.limitations, current.limitations);
});

test('selected and related context preserve complete dated originals and distinct provenance in design and review', async () => {
  const repo = repository();
  const original = {
    ...archivedReport('Storage selection'),
    scope_paths: ['src'],
    rejected: [{ statement: 'A rejected storage claim.', reason: 'No supporting evidence.' }],
    limitations: ['Historical scope only.'],
  };
  original.findings[0]!.qualification = 'Only the inspected case.';
  const selected = persistResearchReport(repo, original);
  let designs = 0,
    reviews = 0;
  const check = (reports: ThinkResearchContext[]) => {
    assert.equal(reports[0]?.provenance, 'selected');
    assert.deepEqual(reports[0]?.scope_paths, original.scope_paths);
    assert.deepEqual(reports[0]?.rejected, original.rejected);
    assert.deepEqual(reports[0]?.findings, original.findings);
    assert.deepEqual(reports[0]?.limitations, original.limitations);
    assert.equal(reports[0]?.generated_at, original.generated_at);
  };
  await runRequest(
    {
      repo,
      request: 'Use the selected storage evidence.',
      research_reports: [path.basename(selected.json)],
    },
    {
      async design(_input, reports) {
        designs++;
        check(reports);
        return ready;
      },
      async review(_input, _draft, reports) {
        reviews++;
        check(reports);
        return { summary: 'Complete evidence checked.', findings: [] };
      },
    },
  );
  assert.equal(designs, 1);
  assert.equal(reviews, 1);
});
test('explicit Think selectors reject private, Markdown, escaping, noncanonical and mismatched corpus evidence before design', async () => {
  for (const mode of [
    'private',
    'markdown',
    'symlink',
    'noncanonical',
    'utf8',
    'identity',
    'view',
  ]) {
    const repo = repository(),
      original = archivedReport('Storage selection');
    if (mode === 'utf8') original.answer = 'A literal replacement character: \uFFFD.';
    const pair = persistResearchReport(repo, original);
    let selector = pair.json;
    if (mode === 'private') {
      const { persistResearchReport: privateReport } = await import('../../research/artifact.ts');
      selector = privateReport(repo, original).json;
    }
    if (mode === 'markdown') selector = pair.markdown;
    if (mode === 'symlink') {
      const bytes = fs.readFileSync(pair.json);
      fs.unlinkSync(pair.json);
      const outside = path.join(temporaryDirectory('outside-corpus-'), 'report.json');
      fs.writeFileSync(outside, bytes);
      fs.symlinkSync(outside, pair.json);
    }
    if (mode === 'noncanonical')
      fs.writeFileSync(
        pair.json,
        JSON.stringify(JSON.parse(fs.readFileSync(pair.json, 'utf8')), null, 2),
      );
    if (mode === 'utf8') {
      const canonical = fs.readFileSync(pair.json);
      const offset = canonical.indexOf(Buffer.from('\uFFFD'));
      assert(offset >= 0);
      const corrupted = Buffer.concat([
        canonical.subarray(0, offset),
        Buffer.from([0xff]),
        canonical.subarray(offset + 3),
      ]);
      assert.equal(corrupted.toString('utf8'), canonical.toString('utf8'));
      fs.writeFileSync(pair.json, corrupted);
    }
    if (mode === 'identity') {
      const value = JSON.parse(fs.readFileSync(pair.json, 'utf8'));
      value.research_id = '0'.repeat(64);
      fs.writeFileSync(pair.json, canonicalJson(value));
    }
    if (mode === 'view') fs.appendFileSync(pair.markdown, 'drift');
    let designs = 0;
    await assert.rejects(
      runRequest(
        { repo, request: 'Use selected evidence.', research_reports: [selector] },
        {
          async design() {
            designs++;
            return ready;
          },
          async review() {
            return { summary: 'review', findings: [] };
          },
        },
      ),
    );
    assert.equal(designs, 0);
  }
});
