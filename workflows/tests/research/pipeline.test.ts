/** @file Outcome: Research accepts only explicit, current evidence and derives read-only context from artifacts. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runResearch } from '../../../workflows/research/pipeline.ts';
import {
  validateResearchInput,
  type ResearchAudit,
  type ResearchDraft,
  type ResearchInput,
} from '../../../workflows/research/contracts.ts';
import type {
  ResearchContextSummary,
  PriorResearchSummary,
  ResearchAgent,
} from '../../../workflows/research/agent.ts';
import { investigationPrompt } from '../../../workflows/research/agent.ts';
import { researchArtifactDirectory } from '../../../workflows/shared/storage.ts';

function repoFixture(t: test.TestContext): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-research-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\ntwo\nthree\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const answer = 42;\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo },
  );
  return repo;
}

function input(repo: string, extra: Partial<ResearchInput> = {}): ResearchInput {
  return {
    protocol: 'codex-research-input/v1',
    repo,
    question: '何が正しいか？',
    mode: 'understand',
    scope_paths: [],
    external_sources: 'none',
    language: 'japanese',
    ...extra,
  };
}

const finding = {
  statement: 'answer は 42 である。',
  kind: 'fact' as const,
  evidence: [
    { kind: 'repository' as const, source: 'src/index.ts', locator: 'L1', supports: '定数の値' },
  ],
  implication: '値を利用できる。',
};
const draft: ResearchDraft = {
  findings: [
    {
      ...finding,
    },
  ],
  unknowns: [],
};
const audit: ResearchAudit = {
  answer: 'answer は 42 である。',
  findings: [{ ...finding, confidence: 'high', qualification: null }],
  rejected: [],
  unknowns: [],
  limitations: [],
  prior_reports: [],
};

class FakeAgent implements ResearchAgent {
  seen: { prior: PriorResearchSummary[]; context: ResearchContextSummary[] }[] = [];
  private readonly d: ResearchDraft;
  private readonly a: ResearchAudit;
  constructor(d: ResearchDraft = draft, a: ResearchAudit = audit) {
    this.d = d;
    this.a = a;
  }
  async investigate(
    _input: ResearchInput,
    prior: PriorResearchSummary[],
    context: ResearchContextSummary[] = [],
  ) {
    this.seen.push({ prior, context });
    return this.d;
  }
  async audit(
    _input: ResearchInput,
    _draft: ResearchDraft,
    prior: PriorResearchSummary[],
    context: ResearchContextSummary[] = [],
  ) {
    this.seen.push({ prior, context });
    return this.a;
  }
}

test('validates the input boundary and rejects invalid scope paths', (t) => {
  const repo = repoFixture(t);
  assert.equal(validateResearchInput(input(repo, { scope_paths: ['src'] })).scope_paths[0], 'src');
  assert.throws(
    () => validateResearchInput(input(repo, { scope_paths: ['missing'] })),
    /existing file or directory/u,
  );
  assert.throws(
    () => validateResearchInput(input(repo, { scope_paths: ['../'] })),
    /repo-relative/u,
  );
});

test('runs read-only research, seals repository evidence, and writes paired artifacts', async (t) => {
  const repo = repoFixture(t);
  const agent = new FakeAgent();
  const before = fs.readFileSync(path.join(repo, 'src/index.ts'), 'utf8');
  const result = await runResearch(input(repo), agent);
  assert.equal(result.context_status, 'loaded');
  const sealed = result.report.findings[0]?.evidence[0];
  assert.equal(sealed?.kind, 'repository');
  assert.equal(sealed && 'source_sha256' in sealed ? sealed.source_sha256.length : 0, 64);
  assert.ok(fs.existsSync(result.report_json));
  assert.ok(fs.existsSync(result.report_markdown));
  assert.equal(fs.readFileSync(path.join(repo, 'src/index.ts'), 'utf8'), before);
  assert.deepEqual(agent.seen[0]!.prior, []);
});

test('passes only active and review_required knowledge context, never decisions', async (t) => {
  const repo = repoFixture(t);
  const dir = researchArtifactDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  const agent = new FakeAgent();
  const result = await runResearch(input(repo), agent);
  assert.equal(result.context_status, 'loaded');
  for (const call of agent.seen) {
    assert.ok(call.context.every((entry) => entry.kind === 'knowledge'));
    assert.ok(
      call.context.every(
        (entry) => entry.status === 'active' || entry.status === 'review_required',
      ),
    );
  }
});

test('loads valid prior research reports and ignores malformed catalog entries', async (t) => {
  const repo = repoFixture(t);
  const dir = researchArtifactDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not-json');
  const first = await runResearch(input(repo), new FakeAgent());
  const agent = new FakeAgent();
  const second = await runResearch(input(repo, { mode: 'plan' }), agent);
  assert.equal(first.report.next_step, 'complete');
  assert.equal(second.report.next_step, 'think');
  assert.ok(agent.seen[0]!.prior.some((item) => item.path.endsWith('.json')));
});

test('rejects out-of-scope, invalid-line, and web evidence when disabled', async (t) => {
  const repo = repoFixture(t);
  const outside = new FakeAgent({
    findings: [
      {
        ...finding,
        evidence: [{ ...finding.evidence[0]!, source: 'README.md' }],
      },
    ],
    unknowns: [],
  });
  await assert.rejects(
    runResearch(input(repo, { scope_paths: ['src'] }), outside),
    /outside the research scope/u,
  );
  const badLine = new FakeAgent({
    findings: [{ ...finding, evidence: [{ ...finding.evidence[0]!, locator: 'L99' }] }],
    unknowns: [],
  });
  await assert.rejects(runResearch(input(repo), badLine), /line|evidence/u);
  const web = new FakeAgent({
    findings: [
      {
        ...finding,
        evidence: [{ kind: 'web', source: 'http://example.com', locator: 'x', supports: 'x' }],
      },
    ],
    unknowns: [],
  });
  await assert.rejects(runResearch(input(repo), web), /external sources|HTTPS/u);
});

test('rejects an audit with neither findings nor explicit unknown', async (t) => {
  const repo = repoFixture(t);
  const empty: ResearchAudit = { ...audit, answer: 'なし', findings: [], unknowns: [] };
  await assert.rejects(
    runResearch(input(repo), new FakeAgent(draft, empty)),
    /finding or an explicit unknown/u,
  );
});

test('degrades context safely when an artifact directory is malformed', async (t) => {
  const repo = repoFixture(t);
  const dir = researchArtifactDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{}');
  const result = await runResearch(input(repo), new FakeAgent());
  assert.equal(result.context_status, 'degraded');
});

test('research prompt labels supplied context as knowledge context', () => {
  const prompt = investigationPrompt(
    input('/repo'),
    [],
    [
      {
        id: 'k',
        kind: 'knowledge',
        status: 'active',
        statement: 'lead',
        source_artifact: 'r.json',
        source_id: 'F-001',
      },
    ],
  );
  assert.match(prompt, /KNOWLEDGE CONTEXT/u);
  assert.match(prompt, /lead/u);
});
