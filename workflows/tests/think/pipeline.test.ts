/** @file Outcome: Think preserves a mechanically valid designer Plan while reviewer findings only control disposition. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { runThink } from '../../../workflows/think/pipeline.ts';
import { reviewPrompt, type ThinkAgent } from '../../../workflows/think/agent.ts';
import type {
  ThinkDraft,
  ThinkInput,
  ThinkReviewFinding,
} from '../../../workflows/think/contracts.ts';
process.env.CODEX_FLOW_STATE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'think-state-'));
const plan = {
  outcome: 'outcome',
  root_cause: null,
  test_command: 'node --test',
  reference_module: {
    kind: 'no-module' as const,
    reason: 'small',
    path: null,
    files: [],
    instances: 0,
    conventions: [],
  },
  preconditions: [],
  backlog_candidates: [],
  rules: [],
  manual_verification: [],
  units: [
    {
      id: 'U-001',
      goal: 'goal',
      files: ['README.md'],
      contract: 'contract',
      tests: [{ id: 'T-001', name: 'test' }],
      seam: false,
    },
  ],
};
const draft: ThinkDraft = {
  outcome: 'outcome',
  root_cause: null,
  decision: 'decision',
  rationale: 'rationale',
  alternatives: [{ summary: 'other', rejected_because: 'larger' }],
  evidence: [{ kind: 'repository', source: 'README.md', locator: 'L1', supports: 'evidence' }],
  plan,
  research_questions: [],
};
const input = (repo: string): ThinkInput => ({
  protocol: 'codex-think-input/v1',
  repo,
  request: 'request',
  task_type: 'feature',
  research_reports: [],
  language: 'english',
});

test('review correction stays within the findings-only semantic boundary', () => {
  const prompt = reviewPrompt(input('/repo'), draft, [], {}, { errors: ['mechanical error'] });
  assert.match(prompt, /Update findings only/u);
  assert.match(
    prompt,
    /mechanical schema, ID, and precondition validation remains the controller/u,
  );
  assert.doesNotMatch(prompt, /satisfies every validation error/u);
});

function repo(t: test.TestContext) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'think-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  fs.writeFileSync(path.join(r, 'README.md'), 'x\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r });
  execFileSync('git', ['add', '.'], { cwd: r });
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'x'], {
    cwd: r,
  });
  return r;
}
class Agent implements ThinkAgent {
  designCalls = 0;
  reviewCalls = 0;
  findings: ThinkReviewFinding[];
  failures: number;
  constructor(findings: ThinkReviewFinding[] = [], failures = 0) {
    this.findings = findings;
    this.failures = failures;
  }
  async design() {
    this.designCalls++;
    return draft;
  }
  async review() {
    this.reviewCalls++;
    if (this.failures-- > 0) throw new Error('timeout');
    return this.findings;
  }
}
test('accepted findings preserve original Plan', async (t) => {
  const a = new Agent();
  const r = await runThink(input(repo(t)), a);
  assert.deepEqual(r.report.plan, plan);
  assert.equal(a.designCalls, 1);
  assert.equal(a.reviewCalls, 1);
});
test('review failure retries once without redesign', async (t) => {
  const a = new Agent([], 1);
  await runThink(input(repo(t)), a);
  assert.equal(a.designCalls, 1);
  assert.equal(a.reviewCalls, 2);
});
test('blocking finding routes research and retains Plan', async (t) => {
  const f = {
    severity: 'blocking' as const,
    statement: 'assumption',
    evidence: draft.evidence,
    implication: 'risk',
    required_action: 'research',
  };
  const r = await runThink(input(repo(t)), new Agent([f]));
  assert.equal(r.report.readiness, 'research_required');
  assert.deepEqual(r.report.plan, plan);
  assert.equal(r.report.review_findings[0]?.disposition, 'block_issue');
});
test('advisory finding keeps ready disposition', async (t) => {
  const f = {
    severity: 'nonblocking' as const,
    statement: 'smaller',
    evidence: draft.evidence,
    implication: 'none',
    required_action: 'consider',
  };
  const r = await runThink(input(repo(t)), new Agent([f]));
  assert.equal(r.report.readiness, 'ready');
  assert.equal(r.report.review_findings[0]?.disposition, 'advisory');
});
test('mechanically invalid designer is rejected before review', async (t) => {
  const a = new Agent();
  const bad = {
    ...draft,
    plan: { ...plan, units: [...plan.units, { ...plan.units[0], id: 'U-001' }] },
  } as ThinkDraft;
  a.design = async () => {
    a.designCalls++;
    return bad;
  };
  await assert.rejects(runThink(input(repo(t)), a));
  assert.equal(a.reviewCalls, 0);
});
test('review findings parser rejects Plan rewrite keys', async () => {
  const { parseThinkReview } = await import('../../../workflows/think/contracts.ts');
  assert.throws(() =>
    parseThinkReview({
      findings: [
        {
          severity: 'blocking',
          statement: 'x',
          evidence: [],
          implication: 'i',
          required_action: 'a',
          plan: null,
        },
      ],
    }),
  );
});
test('report findings retain controller disposition', async (t) => {
  const f = {
    severity: 'nonblocking' as const,
    statement: 'smaller',
    evidence: draft.evidence,
    implication: 'none',
    required_action: 'consider',
  };
  const r = await runThink(input(repo(t)), new Agent([f]));
  assert.equal(r.report.review_findings[0]?.disposition, 'advisory');
});
