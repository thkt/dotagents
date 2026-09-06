/** @file Outcome: Research verifies current evidence and automatically updates reusable Knowledge. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import {
  parseResearchDraft,
  parseResearchReport,
  type ResearchAudit,
  type ResearchDraft,
  type ResearchInput,
} from '../../research/contracts.ts';
import { type ResearchAgent } from '../../research/agent.ts';
import type { KnowledgeEntry } from '../../research/knowledge.ts';

import { knowledgeArtifactDirectory, researchArtifactDirectory } from '../../runtime/storage.ts';
import { runResearchWorkflow } from '../../research/runner.ts';
import { armIntent, clearIntent, loadIntent } from '../../runtime/invocation.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-research-storage-');

function repoFixture(): string {
  const repo = temporaryDirectory('codex-research-');
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
    repo,
    question: '何が正しいか？',
    scope_paths: [],
    allow_external_sources: false,
    ...extra,
  };
}

async function runRequest(request: ResearchInput, agent: ResearchAgent) {
  const pending = armIntent({
    runId: crypto.randomUUID(),
    workflow: 'research',
    cwd: request.repo,
  });
  fs.writeFileSync(pending.input_path, JSON.stringify(request));
  const result = await runResearchWorkflow(pending.run_id, pending.input_path, agent);
  assert.equal(loadIntent(pending.run_id), null);
  return {
    ...result,
    report: parseResearchReport(JSON.parse(fs.readFileSync(result.report_json, 'utf8'))),
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
  answer: 'answer は 42 である。',
  findings: [{ ...finding, confidence: 'high', qualification: null }],
  rejected: [],
  unknowns: [],
  limitations: [],
};
const audit: ResearchAudit = { summary: 'Candidate is supported.', findings: [] };

class FakeAgent implements ResearchAgent {
  seen: KnowledgeEntry[][] = [];
  private readonly d: ResearchDraft;
  private readonly a: ResearchAudit;
  constructor(d: ResearchDraft = draft, a: ResearchAudit = audit) {
    this.d = d;
    this.a = a;
  }
  async investigate(_input: ResearchInput, knowledge: KnowledgeEntry[], _snapshotRepo: string) {
    this.seen.push(knowledge);
    return this.d;
  }
  async audit(
    _input: ResearchInput,
    _draft: ResearchDraft,
    knowledge: KnowledgeEntry[],
    _snapshotRepo: string,
  ) {
    this.seen.push(knowledge);
    return this.a;
  }
}

test('runs read-only research and writes paired artifacts', async () => {
  const repo = repoFixture();
  const agent = new FakeAgent();
  const before = fs.readFileSync(path.join(repo, 'src/index.ts'), 'utf8');
  const result = await runRequest(input(repo), agent);
  assert.equal(result.protocol, 'codex-research-result');
  assert.equal(result.status, 'completed');
  assert.equal(result.next_step, 'think');
  assert.equal(result.findings, result.report.findings.length);
  assert.equal(result.report.findings[0]?.evidence[0]?.kind, 'repository');
  assert.ok(fs.existsSync(result.report_json));
  assert.ok(fs.existsSync(result.report_markdown));
  assert.equal(fs.readFileSync(path.join(repo, 'src/index.ts'), 'utf8'), before);
  assert.deepEqual(agent.seen[0], []);
});

test('investigator and auditor read the same startup snapshot while the shared worktree changes', async () => {
  const repo = repoFixture();
  const source = path.join(repo, 'src/index.ts');
  let firstSnapshot: string | undefined;
  const agent: ResearchAgent = {
    async investigate(_input, _prior, snapshotRepo) {
      assert.ok(snapshotRepo);
      firstSnapshot = snapshotRepo;
      assert.notEqual(fs.realpathSync(snapshotRepo), fs.realpathSync(repo));
      assert.equal(
        fs.readFileSync(path.join(snapshotRepo, 'src/index.ts'), 'utf8'),
        'export const answer = 42;\n',
      );
      fs.writeFileSync(source, 'export const answer = 0;\n');
      assert.equal(
        fs.readFileSync(path.join(snapshotRepo, 'src/index.ts'), 'utf8'),
        'export const answer = 42;\n',
      );
      return draft;
    },
    async audit(_input, _draft, _prior, snapshotRepo) {
      assert.equal(snapshotRepo, firstSnapshot);
      assert.equal(
        fs.readFileSync(path.join(snapshotRepo!, 'src/index.ts'), 'utf8'),
        'export const answer = 42;\n',
      );
      return audit;
    },
  };

  const result = await runRequest(input(repo), agent);
  assert.equal(result.report.answer, draft.answer);
  assert.match(fs.readFileSync(source, 'utf8'), /answer = 0/u);
});

test('a repository without commits is investigated from its snapshot', async () => {
  const repo = temporaryDirectory('codex-research-unborn-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const answer = 42;\n');
  const result = await runRequest(input(repo), new FakeAgent());
  assert.equal(result.report.findings[0]?.evidence[0]?.kind, 'repository');
});

test('reuses rebuilt Knowledge and skips malformed Research', async () => {
  const repo = repoFixture();
  const dir = researchArtifactDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not-json');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{}');
  const previous = await runRequest(input(repo), new FakeAgent());
  const agent = new FakeAgent();
  await runRequest(input(repo), agent);
  assert.deepEqual(
    agent.seen[0]!.flatMap((item) => item.sources.map((source) => source.report)),
    [path.basename(previous.report_json)],
  );
});

test('rejects out-of-scope, invalid-line, and web evidence when disabled', async () => {
  const repo = repoFixture();
  const outside = new FakeAgent({
    ...draft,
    findings: [
      {
        ...draft.findings[0]!,
        evidence: [{ ...finding.evidence[0]!, source: 'README.md' }],
      },
    ],
  });
  await assert.rejects(
    runRequest(input(repo, { scope_paths: ['src'] }), outside),
    /outside the research scope/u,
  );
  const badLine = new FakeAgent({
    ...draft,
    findings: [
      {
        ...draft.findings[0]!,
        evidence: [{ ...finding.evidence[0]!, locator: 'L99' }],
      },
    ],
  });
  await assert.rejects(runRequest(input(repo), badLine), /line|evidence/u);
  const web = new FakeAgent({
    ...draft,
    findings: [
      {
        ...draft.findings[0]!,
        evidence: [{ kind: 'web', source: 'http://example.com', locator: 'x', supports: 'x' }],
      },
    ],
  });
  await assert.rejects(runRequest(input(repo), web), /external sources|HTTPS/u);
});

test('blocks an empty candidate without publishing a Research report', async () => {
  const repo = repoFixture();
  const empty: ResearchDraft = { ...draft, answer: 'なし', findings: [], unknowns: [] };
  await assert.rejects(
    runRequest(input(repo), new FakeAgent(empty)),
    /finding or an explicit unknown/u,
  );
  assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
});

test('invalid investigator evidence returns to its author before independent audit', async () => {
  const repo = repoFixture();
  let calls = 0;
  const agent = new FakeAgent();
  agent.investigate = async () => {
    calls += 1;
    return calls === 1
      ? {
          ...draft,
          findings: [
            {
              ...draft.findings[0]!,
              evidence: [{ ...finding.evidence[0]!, source: 'missing.ts' }],
            },
          ],
        }
      : draft;
  };
  const result = await runRequest(input(repo), agent);
  assert.equal(calls, 2);
  assert.equal(result.report.answer, draft.answer);
  assert.equal(agent.seen.length, 1);
});

test('keeps persisted Research successful when Knowledge cannot be updated', async () => {
  const repo = repoFixture();
  const knowledgePath = knowledgeArtifactDirectory(repo);
  fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
  fs.writeFileSync(knowledgePath, 'blocks the generated Knowledge directory');

  const result = await runRequest(input(repo), new FakeAgent());

  assert.ok(fs.existsSync(result.report_json));
  assert.equal(result.report.findings.length, 1);
});

test('research candidate parser rejects malformed repository locators but preserves web sections', () => {
  const base = { answer: 'answer', findings: [], rejected: [], unknowns: [], limitations: [] };
  const finding = (evidence: object) => ({
    statement: 'x',
    kind: 'fact',
    confidence: 'high',
    qualification: null,
    evidence: [evidence],
    implication: 'x',
  });
  assert.throws(
    () =>
      parseResearchDraft({
        ...base,
        findings: [
          finding({ kind: 'repository', source: 'src/index.ts', locator: 'L1-2', supports: 'x' }),
        ],
      }),
    /locator must use Lx or Lx-Ly/u,
  );
  assert.doesNotThrow(() =>
    parseResearchDraft({
      ...base,
      findings: [
        finding({
          kind: 'web',
          source: 'https://example.com',
          locator: 'Results section',
          supports: 'x',
        }),
      ],
    }),
  );
});

test('invalid input and scope paths preserve authorization without dispatch', async () => {
  const repo = repoFixture();
  for (const raw of [
    {},
    input(repo, { scope_paths: ['missing'] }),
    input(repo, { scope_paths: ['../'] }),
  ]) {
    const runId = crypto.randomUUID();
    const pending = armIntent({ runId, workflow: 'research', cwd: repo });
    onTestFinished(() => clearIntent(runId));
    fs.writeFileSync(pending.input_path, JSON.stringify(raw));
    const agent = new FakeAgent();
    await assert.rejects(runResearchWorkflow(runId, pending.input_path, agent));
    assert.ok(loadIntent(runId));
    assert.equal(agent.seen.length, 0);
    assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
  }
});

test('an intent bound to another run, worktree, or input path rejects startup and stays armed', async () => {
  const repo = repoFixture();
  const otherRepo = repoFixture();
  const agent = new FakeAgent();
  const unarmedRun = `research-unarmed-${crypto.randomUUID()}`;
  const unarmedInput = path.join(repo, 'research-input.json');
  fs.writeFileSync(unarmedInput, JSON.stringify(input(repo)));
  await assert.rejects(
    runResearchWorkflow(unarmedRun, unarmedInput, agent),
    /explicit \$research invocation is required/u,
  );

  const cases = [
    {
      name: 'worktree',
      cwd: otherRepo,
      inputFile: (armed: string) => armed,
      message: /belongs to a different Git worktree/u,
    },
    {
      name: 'input path',
      cwd: repo,
      inputFile: () => unarmedInput,
      message: /use the research input path supplied by the workflow hook/u,
    },
  ];
  for (const bound of cases) {
    const runId = `research-${bound.name}-${crypto.randomUUID()}`;
    const pending = armIntent({ runId, workflow: 'research', cwd: bound.cwd });
    onTestFinished(() => clearIntent(runId));
    fs.writeFileSync(pending.input_path, JSON.stringify(input(repo)));
    await assert.rejects(
      runResearchWorkflow(runId, bound.inputFile(pending.input_path), agent),
      bound.message,
    );
    assert.ok(loadIntent(runId), bound.name);
  }
  assert.equal(agent.seen.length, 0);
});
