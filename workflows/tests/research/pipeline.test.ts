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
import { runStreamedCodexTurn } from '../../shared/codex.ts';
import { searchKnowledge, type KnowledgeEntry } from '../../research/knowledge.ts';

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
    report: parseResearchReport(JSON.parse(fs.readFileSync(result.report_json!, 'utf8'))),
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
  async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
    return {
      verdict: 'safe' as const,
      coverage: context.strings.map((item) => item.path),
      findings: [],
    };
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
  assert.ok(fs.existsSync(result.report_json!));
  assert.ok(fs.existsSync(result.report_markdown!));
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
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
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
  execFileSync('git', ['-C', repo, 'add', 'src/index.ts']);
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
    [path.basename(previous.report_json!)],
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

  assert.ok(fs.existsSync(result.report_json!));
  assert.equal(result.report.findings.length, 1);
});

test('unrelated Research publication cannot revive older Knowledge after the newest view is lost', async () => {
  const repo = repoFixture();
  const request = input(repo, { question: 'Exported value' });
  const older = await runRequest(request, new FakeAgent());
  const newest = await runRequest(request, new FakeAgent());
  assert.notEqual(older.report.research_id, newest.report.research_id);
  assert.equal(
    searchKnowledge(repo, 'Exported value')[0]?.sources[0]?.research_id,
    newest.report.research_id,
  );
  const index = path.join(knowledgeArtifactDirectory(repo), 'index.json');
  const bytes = fs.readFileSync(index);
  fs.unlinkSync(newest.report_markdown!);
  assert.deepEqual(searchKnowledge(repo, 'Exported value'), []);

  const agent = new FakeAgent();
  const result = await runRequest(input(repo, { question: 'Module consumers' }), agent);

  assert.equal(result.status, 'completed');
  assert.ok(fs.existsSync(result.report_json!));
  assert.ok(fs.existsSync(result.report_markdown!));
  assert.equal(result.report.findings.length, 1);
  assert.deepEqual(agent.seen, [[], []]);
  assert.deepEqual(fs.readFileSync(index), bytes);
  assert.deepEqual(searchKnowledge(repo, 'Exported value'), []);
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

test('production Research independently rejects an unnecessary question and audits its author correction and explicit answer', async () => {
  const { CodexResearchAgent } = await import('../../research/agent.ts');
  const { loadResearchState } = await import('../../research/state.ts');
  const repo = repoFixture();
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(
    path.join(repo, '.codex/OUTCOME.md'),
    '# Project outcome\n\nInvestigate an access policy.\n',
  );
  const pending = armIntent({ runId: crypto.randomUUID(), workflow: 'research', cwd: repo });
  const original = input(repo, {
    question: 'Investigate the "公開" access policy.\nPreserve C:\\policy\\rules and literal \\n.',
  });
  fs.writeFileSync(pending.input_path, JSON.stringify(original));
  const question = {
    id: 'policy',
    prompt: 'Which access policy must this investigation evaluate?',
    choices: [
      { label: 'Public', description: 'Evaluate unauthenticated access.' },
      { label: 'Private', description: 'Evaluate authenticated access.' },
    ],
    recommendation: null,
  };
  const prompts: string[] = [];
  let threads = 0;
  const worker = new CodexResearchAgent({
    startThread(options) {
      assert.equal(options!.sandboxMode, 'read-only');
      const index = threads++;
      return {
        async run(prompt, turnOptions) {
          prompts.push(prompt);
          const response =
            index === 0
              ? {
                  status: 'waiting',
                  question: {
                    ...question,
                    id: 'gratuitous',
                    prompt: 'Which internal variable name should be used?',
                  },
                  affected_questions: ['A1'],
                }
              : index === 1
                ? {
                    summary: 'Delegated implementation choice.',
                    findings: [
                      {
                        severity: 'blocking',
                        condition: 'A necessary material user-owned decision is required.',
                        message:
                          'The candidate asks for an internal implementation choice; the original request delegates this.',
                        evidence: [],
                      },
                    ],
                  }
                : index === 2
                  ? { status: 'waiting', question, affected_questions: null }
                  : index === 4
                    ? draft
                    : audit;
          if (index === 1)
            for (const criterion of [
              'gratuitous preferences',
              'factual questions',
              'internal implementation choices',
              'materially unnecessary',
            ])
              assert(prompt.includes(criterion));
          if (index === 2)
            assert(
              prompt.includes('Delegated implementation choice') ||
                prompt.includes('original request delegates'),
            );
          if (index >= 4) assert(prompt.includes('Complete clarification history'));
          // Inspect the emitted schema through the stream adapter; this is not an external API probe.
          const safety = prompt.match(/----- BEGIN PUBLIC SAFETY CONTEXT [^\n]+\n([^\n]+)\n/u);
          const finalResponse = JSON.stringify(
            safety
              ? {
                  verdict: 'safe',
                  coverage: (JSON.parse(safety[1]!) as { strings: { path: string }[] }).strings.map(
                    (item) => item.path,
                  ),
                  findings: [],
                }
              : index % 2 === 0
                ? { result: response }
                : response,
          );
          return runStreamedCodexTurn(
            {
              async runStreamed(actualPrompt, actualOptions) {
                assert.equal(actualPrompt, prompt);
                if (index % 2 === 0 && !safety) {
                  const schema = actualOptions?.outputSchema as {
                    properties: {
                      result: { anyOf: [unknown, { properties: { affected_questions: unknown } }] };
                    };
                  };
                  assert.deepEqual(
                    schema.properties.result.anyOf[1].properties.affected_questions,
                    {
                      anyOf: [
                        { type: 'array', minItems: 1, items: { type: 'string', enum: ['A1'] } },
                        { type: 'null' },
                      ],
                    },
                  );
                  assert(
                    prompt.includes(
                      `Complete assignment ID mapping: ${JSON.stringify([{ id: 'A1', question: original.question }])}`,
                    ),
                  );
                  assert(
                    prompt.includes(
                      `Your assignment and ID: ${JSON.stringify({ id: 'A1', question: original.question })}`,
                    ),
                  );
                } else if (index < 4) {
                  const saved = loadResearchState(pending.run_id)!;
                  assert.deepEqual(saved.investigations![0]!.affected, [original.question]);
                  assert(prompt.includes(JSON.stringify(original.question)));
                  assert.deepEqual(JSON.parse(saved.candidate!.answer).investigations[0].affected, [
                    original.question,
                  ]);
                }
                return {
                  events: (async function* () {
                    yield {
                      type: 'item.completed' as const,
                      item: { id: 'response', type: 'agent_message' as const, text: finalResponse },
                    };
                    yield {
                      type: 'turn.completed' as const,
                      usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        cached_input_tokens: 0,
                        cache_write_input_tokens: 0,
                        reasoning_output_tokens: 0,
                      },
                    };
                  })(),
                };
              },
            },
            prompt,
            turnOptions,
          );
        },
      };
    },
  });
  const waiting = await runResearchWorkflow(pending.run_id, pending.input_path, worker);
  assert(waiting.status === 'waiting');
  assert.equal(waiting.question.id, 'policy');
  assert.equal(threads, 4);
  assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
  assert.equal(loadResearchState(pending.run_id)!.corrections, 1);
  const savedWaiting = loadResearchState(pending.run_id)!;
  assert.deepEqual(savedWaiting.investigations![0]!.affected, [original.question]);
  assert.deepEqual(await runResearchWorkflow(pending.run_id, pending.input_path, worker), waiting);
  assert.deepEqual(loadResearchState(pending.run_id), savedWaiting);
  assert.equal(threads, 4);
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({
      ...original,
      clarification_answers: [
        {
          owner: waiting.owner,
          question_id: question.id,
          prompt: question.prompt,
          choices: question.choices,
          recommendation: null,
          selection: 'Private',
          answer: null,
        },
      ],
    }),
  );
  assert.equal(
    (await runResearchWorkflow(pending.run_id, pending.input_path, worker)).status,
    'completed',
  );
  assert.equal(threads, 7);
  assert(prompts[3]!.includes(question.prompt));
  assert.equal(loadResearchState(pending.run_id)!.corrections, 1);
});
