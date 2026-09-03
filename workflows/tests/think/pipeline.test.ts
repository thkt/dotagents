/** @file Outcome: Think turns a semantic request into one reviewed Plan or research questions. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import type { ThinkAgent, ThinkResearchContext, ThinkReviewCorrection } from '../../think/agent.ts';
import {
  parseThinkDecision,
  parseThinkReport,
  validateThinkInput,
  type ThinkDecision,
  type ThinkDraft,
  type ThinkInput,
} from '../../think/contracts.ts';
import { runThink } from '../../think/pipeline.ts';
import { persistResearchReport } from '../../research/artifact.ts';
import { RESEARCH_REPORT_PROTOCOL, type ResearchReport } from '../../research/contracts.ts';
import { updateKnowledge, type KnowledgeEntry } from '../../knowledge/update.ts';
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
  knowledge: KnowledgeEntry[] = [];
  private readonly draft: ThinkDraft;
  private readonly decisions: ThinkDecision[];

  constructor(draft: ThinkDraft, decisions: ThinkDecision[]) {
    this.draft = draft;
    this.decisions = decisions;
  }

  async design(
    _input: ThinkInput,
    research: ThinkResearchContext[],
    knowledge: KnowledgeEntry[],
    _buildContract: unknown,
    snapshotRepo: string,
  ): Promise<ThinkDraft> {
    assert.notEqual(snapshotRepo, _input.repo);
    this.research = research;
    this.knowledge = knowledge;
    return this.draft;
  }

  async review(
    _input: ThinkInput,
    _draft: ThinkDraft,
    _research: ThinkResearchContext[],
    _knowledge: KnowledgeEntry[],
    _buildContract: unknown,
    _correction: ThinkReviewCorrection | undefined,
    _snapshotRepo: string,
  ): Promise<ThinkDecision> {
    return this.decisions[this.reviews++]!;
  }
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
  const result = await runThink(
    { repo, request: '保存を追加する', research_reports: [] },
    new Agent(ready, [ready]),
  );
  assert.equal(result.report.status, 'ready');
  assert.deepEqual(
    parseThinkReport(JSON.parse(fs.readFileSync(result.report_json, 'utf8'))),
    result.report,
  );
  assert.match(fs.readFileSync(result.report_markdown, 'utf8'), /## Plan/u);
});

test('automatically supplies related Knowledge to Think', async () => {
  const repo = repository();
  persistResearchReport(repo, archivedReport('保存方式を調査する'));
  persistResearchReport(repo, archivedReport('画面配色を調査する'));
  updateKnowledge(repo);
  const agent = new Agent(ready, [ready]);

  await runThink({ repo, request: '保存方式を変更する', research_reports: [] }, agent);

  assert.deepEqual(agent.research, []);
  assert.deepEqual(
    agent.knowledge.map(({ topic }) => topic),
    ['保存方式を調査する'],
  );
});

test('does not duplicate explicitly selected Research through Knowledge', async () => {
  const repo = repository();
  const selected = persistResearchReport(repo, archivedReport('保存方式を調査する')).json;
  updateKnowledge(repo);
  const agent = new Agent(ready, [ready]);

  await runThink({ repo, request: '保存方式を変更する', research_reports: [selected] }, agent);

  assert.equal(agent.research.length, 1);
  assert.equal(agent.knowledge.length, 0);
});

test('returns focused Research questions without a partial Plan', async () => {
  const repo = repository();
  const researchRequired: ThinkDecision = {
    status: 'research_required',
    plan: null,
    research_questions: ['現在の永続化方式は何か。'],
  };
  const result = await runThink(
    { repo, request: '保存を追加する', research_reports: [] },
    new Agent(researchRequired, [researchRequired]),
  );
  assert.deepEqual(result.report.research_questions, ['現在の永続化方式は何か。']);
  assert.equal(result.report.plan, null);
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

test('gives one mechanically invalid reviewed Plan back for correction', async () => {
  const repo = repository();
  const invalid: ThinkDecision = {
    ...ready,
    plan: { ...ready.plan!, test_command: 'bun test && echo unsafe' },
  };
  const agent = new Agent(ready, [invalid, ready]);
  const result = await runThink({ repo, request: '保存を追加する', research_reports: [] }, agent);
  assert.equal(result.report.status, 'ready');
  assert.equal(agent.reviews, 2);
});
