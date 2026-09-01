/** @file Outcome: Think routes explicit requests through read-only design and review. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CODEX_FLOW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-think-state-'));

import { runThink } from '../../../workflows/think/pipeline.ts';
import { CodexThinkAgent, designPrompt, reviewPrompt } from '../../../workflows/think/agent.ts';
import { runThinkWorkflow } from '../../../workflows/think/runner.ts';
import type {
  ThinkAgent,
  ThinkResearchContext,
  ThinkContextSummary,
} from '../../../workflows/think/agent.ts';
import type { ThinkDecision, ThinkDraft, ThinkInput } from '../../../workflows/think/contracts.ts';
import { RESEARCH_REPORT_PROTOCOL } from '../../../workflows/research/contracts.ts';
import { emptyStageTimings } from '../../../workflows/shared/codex.ts';
import { researchArtifactDirectory } from '../../../workflows/shared/storage.ts';
import { errorCode } from '../../../workflows/shared/errors.ts';

function repoFixture(t: test.TestContext): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-think-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\ntwo\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo },
  );
  return repo;
}
function input(repo: string, extra: Partial<ThinkInput> = {}): ThinkInput {
  return {
    protocol: 'codex-think-input/v1',
    repo,
    request: 'どう変更するか？',
    task_type: 'feature',
    research_reports: [],
    language: 'japanese',
    ...extra,
  };
}
const draft: ThinkDraft = {
  problem: '問題',
  constraints: [],
  approaches: [{ id: 'a', summary: '案', benefits: ['b'], costs: [], risks: [] }],
  recommendation: { approach_id: 'a', rationale: '妥当' },
  plan: null,
  uncertainties: [],
};
const researchDecision: ThinkDecision = {
  readiness: 'research_required',
  outcome: '未確定',
  root_cause: null,
  decision: '追加調査',
  rationale: '根拠不足',
  alternatives: [],
  evidence: [],
  plan: null,
  research_questions: ['何を確認するか'],
  review_notes: [],
};

class FakeAgent implements ThinkAgent {
  designCalls = 0;
  reviewCalls = 0;
  seen: unknown[][] = [];
  private readonly decision: ThinkDecision;
  private readonly retry: ThinkDecision | undefined;
  constructor(decision: ThinkDecision = researchDecision, retry?: ThinkDecision) {
    this.decision = decision;
    this.retry = retry;
  }
  async design(
    _input: ThinkInput,
    research: ThinkResearchContext[],
    _contract: unknown,
    context: ThinkContextSummary[] = [],
  ) {
    this.designCalls++;
    this.seen.push([research, context]);
    return draft;
  }
  async review(
    _input: ThinkInput,
    _draft: ThinkDraft,
    research: ThinkResearchContext[],
    _contract: unknown,
    correction?: unknown,
    context: ThinkContextSummary[] = [],
  ) {
    this.reviewCalls++;
    this.seen.push([research, correction, context]);
    return correction && this.retry ? this.retry : this.decision;
  }
}

test('routes a read-only Think run through designer and reviewer and preserves the worktree', async (t) => {
  const repo = repoFixture(t);
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  const agent = new FakeAgent();
  const result = await runThink(input(repo), agent);
  assert.equal(result.report.next_step, 'research');
  assert.equal(agent.designCalls, 1);
  assert.equal(agent.reviewCalls, 1);
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }),
    before,
  );
  assert.ok(fs.existsSync(result.report_json));
  assert.ok(fs.existsSync(result.report_markdown));
});

test('think prompt labels supplied artifact context', () => {
  const prompt = designPrompt(input('/repo'), [], {}, [
    {
      id: 'k',
      kind: 'knowledge',
      status: 'active',
      statement: 'lead',
      source_artifact: 'r.json',
      source_id: 'F-001',
    },
  ]);
  assert.match(prompt, /KNOWLEDGE AND DECISION CONTEXT/u);
  assert.match(prompt, /lead/u);
});

test('think designer prompt bounds investigation and reserves schema for final output', () => {
  const prompt = designPrompt(input('/repo'), [], {}, []);
  assert.match(prompt, /directly affected implementation files/u);
  assert.match(prompt, /Do not run the full test suite/u);
  assert.match(prompt, /structured response.*commentary/u);
});

test('think prompts apply the bounded investigation and final-only contract to review', () => {
  const prompt = reviewPrompt(input('/repo'), draft, [], {}, undefined, []);
  assert.match(prompt, /directly affected implementation files/u);
  assert.match(prompt, /Do not run the full test suite/u);
  assert.match(prompt, /schema exactly once as the final response/u);
});

test('classifies designer and reviewer aborts by stage', async () => {
  const abort = (name: string) => {
    const error = new Error(name);
    error.name = name;
    return error;
  };
  const client = (failure: Error) => ({
    startThread() {
      return {
        run: async () => {
          throw failure;
        },
      };
    },
  });
  const agent = new CodexThinkAgent(client(abort('AbortError')));
  await assert.rejects(agent.design(input('/repo'), [], {}), (error: unknown) => {
    assert.equal(errorCode(error), 'think_designer_timeout');
    assert.match(String((error as Error).message), /designer/u);
    return true;
  });
  const reviewer = new CodexThinkAgent(client(abort('TimeoutError')));
  await assert.rejects(reviewer.review(input('/repo'), draft, [], {}), (error: unknown) => {
    assert.equal(errorCode(error), 'think_reviewer_timeout');
    assert.match(String((error as Error).message), /reviewer/u);
    return true;
  });
});

test('rejects stale selected research evidence before invoking the agent', async (t) => {
  const repo = repoFixture(t);
  const dir = researchArtifactDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'stale.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      protocol: RESEARCH_REPORT_PROTOCOL,
      generated_at: new Date().toISOString(),
      question: 'q',
      mode: 'plan',
      language: 'japanese',
      scope_paths: [],
      external_sources: 'none',
      repository: { head: null, dirty: false },
      answer: 'a',
      findings: [
        {
          id: 'F-001',
          statement: 's',
          kind: 'fact',
          confidence: 'high',
          qualification: null,
          evidence: [
            {
              kind: 'repository',
              source: 'README.md',
              locator: 'L1',
              supports: 's',
              source_sha256: '0'.repeat(64),
            },
          ],
          implication: 'i',
        },
      ],
      unknowns: [],
      rejected: [],
      limitations: [],
      prior_reports: [],
      timings: emptyStageTimings(),
      next_step: 'think',
    }),
  );
  await assert.rejects(
    runThink(input(repo, { research_reports: [file] }), new FakeAgent()),
    /stale/u,
  );
});

test('preserves selected Research findings and web trail for both agent phases', async (t) => {
  const repo = repoFixture(t);
  const dir = researchArtifactDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'web.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      protocol: RESEARCH_REPORT_PROTOCOL,
      generated_at: new Date().toISOString(),
      question: 'q',
      mode: 'plan',
      language: 'japanese',
      scope_paths: [],
      external_sources: 'primary',
      repository: { head: null, dirty: false },
      answer: 'a',
      findings: [
        {
          id: 'F-001',
          statement: 'web fact',
          kind: 'fact',
          confidence: 'high',
          qualification: null,
          evidence: [
            { kind: 'web', source: 'https://example.com', locator: 'title', supports: 'trail' },
          ],
          implication: 'i',
        },
      ],
      unknowns: [],
      rejected: [],
      limitations: [],
      prior_reports: [],
      timings: emptyStageTimings(),
      next_step: 'think',
    }),
  );
  const agent = new FakeAgent();
  await runThink(input(repo, { research_reports: [file] }), agent);
  assert.equal(agent.seen.length, 2);
  for (const call of agent.seen) {
    const selected = call[0] as ThinkResearchContext[];
    assert.equal(selected[0]?.path, 'web.json');
    assert.equal(selected[0]?.findings[0]?.evidence[0]?.kind, 'web');
  }
});

test('sends one concrete reviewer correction and accepts the retry', async (t) => {
  const repo = repoFixture(t);
  const invalid: ThinkDecision = {
    ...researchDecision,
    readiness: 'ready',
    plan: null,
    research_questions: [],
  };
  const agent = new FakeAgent(invalid, researchDecision);
  const result = await runThink(input(repo), agent);
  assert.equal(result.report.readiness, 'research_required');
  assert.equal(agent.reviewCalls, 2);
  const correction = agent.seen[2]?.[1];
  assert.ok(correction && typeof correction === 'object' && 'errors' in correction);
  assert.match(String((correction as { errors: string[] }).errors[0]), /plan/u);
});

test('stops after the second invalid reviewer handoff', async (t) => {
  const repo = repoFixture(t);
  const invalid: ThinkDecision = {
    ...researchDecision,
    readiness: 'ready',
    plan: null,
    research_questions: [],
  };
  const agent = new FakeAgent(invalid, invalid);
  await assert.rejects(runThink(input(repo), agent), /ready decision must contain a plan/u);
  assert.equal(agent.reviewCalls, 2);
});

test('returns no partial Plan for research_required and exposes context status', async (t) => {
  const result = await runThink(input(repoFixture(t)), new FakeAgent());
  assert.equal(result.report.plan, null);
  assert.ok(['loaded', 'degraded'].includes(result.context_status));
});

test('closed input is required and unknown command is rejected', async (t) => {
  const repo = repoFixture(t);
  const runId = `think-${Date.now()}`;
  const file = path.join(repo, 'input.json');
  fs.writeFileSync(file, JSON.stringify(input(repo)));
  await assert.rejects(
    runThinkWorkflow(runId, file, new FakeAgent()),
    /intent|armed|input|invocation/u,
  );
  await assert.rejects(
    import('../../../workflows/think/runner.ts').then((m) => m.main(['wat'])),
    /unknown command/u,
  );
});
