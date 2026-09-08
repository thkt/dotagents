/** @file Outcome: Independent Research parts overlap and survive interruption without bypassing the final audit. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'bun:test';
import { armIntent } from '../../runtime/invocation.ts';
import { researchArtifactDirectory, researchStatePath } from '../../runtime/storage.ts';
import { runResearchWorkflow } from '../../research/runner.ts';
import { readCorpusReport } from '../../research/corpus.ts';
import { loadResearchState, saveResearchState, researchDigest } from '../../research/state.ts';
import { CodexResearchAgent, type ResearchAgent } from '../../research/agent.ts';
import { RESEARCH_WAITING_SCHEMA, type ResearchDraft } from '../../research/contracts.ts';
import { runStreamedCodexTurn } from '../../shared/codex.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';
useTemporaryWorkflowStorage('research-parallel-');
const questions = ['What does left.ts export?', 'What does right.ts export?'];
const pass = { summary: 'Both answers are supported.', findings: [] };
const draft = (source = 'left.ts'): ResearchDraft => ({
  answer: `${source} exports a value.`,
  findings: [
    {
      statement: `${source} exports a value.`,
      kind: 'fact',
      confidence: 'high',
      qualification: null,
      evidence: [{ kind: 'repository', source, locator: 'L1', supports: 'Export is on line 1.' }],
      implication: 'Use the exported value.',
    },
  ],
  rejected: [],
  unknowns: [],
  limitations: [],
});
function fixture(subquestions: unknown = questions) {
  const repo = temporaryDirectory('parallel-repo-');
  execFileSync('git', ['init', '-q', repo]);
  for (const file of ['left.ts', 'right.ts'])
    fs.writeFileSync(path.join(repo, file), 'export const value = 1;\n');
  execFileSync('git', ['-C', repo, 'add', 'left.ts', 'right.ts']);
  const runId = crypto.randomUUID();
  const input = armIntent({ runId, workflow: 'research', cwd: repo }).input_path;
  fs.writeFileSync(
    input,
    JSON.stringify({
      repo,
      question: 'What do both modules export?',
      scope_paths: [],
      allow_external_sources: false,
      ...(subquestions === undefined ? {} : { subquestions }),
    }),
  );
  return { repo, runId, input };
}
const run = async (f: ReturnType<typeof fixture>, agent: ResearchAgent) => {
  const result = await runResearchWorkflow(f.runId, f.input, agent);
  if (result.status === 'completed') readCorpusReport(f.repo, result.report_json);
  else
    for (const directory of ['records', 'reports'])
      assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
  return result;
};
const agent: ResearchAgent = {
  async investigate(_i, _k, _s, _c, assignment) {
    return draft(assignment!.question.includes('right') ? 'right.ts' : 'left.ts');
  },
  async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
    return {
      verdict: 'safe' as const,
      coverage: context.strings.map((item) => item.path),
      findings: [],
    };
  },
  async audit() {
    return pass;
  },
};

test('two production investigators overlap and all evidence reaches one independent audit', async () => {
  const f = fixture();
  let entered = 0,
    active = 0,
    peak = 0,
    audits = 0,
    safetyAudits = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const snapshots = new Set<string>();
  const result = await run(f, {
    async investigate(input, knowledge, snapshot, correction, assignment) {
      entered++;
      active++;
      peak = Math.max(active, peak);
      snapshots.add(snapshot);
      assert.equal(input.question, 'What do both modules export?');
      assert.deepEqual(input.subquestions, questions);
      assert.deepEqual(input.scope_paths, []);
      assert.equal(input.allow_external_sources, false);
      assert.deepEqual(knowledge, []);
      assert.equal(correction, undefined);
      if (entered === 2) release();
      await gate;
      active--;
      return draft(assignment!.question.includes('right') ? 'right.ts' : 'left.ts');
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      safetyAudits++;
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit(input, candidate) {
      audits++;
      assert.equal(active, 0);
      assert.equal(input.question, 'What do both modules export?');
      assert.deepEqual(
        candidate.findings.map((f) => f.evidence[0]!.source),
        ['left.ts', 'right.ts'],
      );
      for (const q of questions) assert.ok(candidate.answer.includes(q));
      return pass;
    },
  });
  assert.equal(peak, 2);
  assert.equal(snapshots.size, 1);
  assert.equal(audits, 1);
  assert.equal(safetyAudits, 1);
  assert(result.status === 'completed');
  assert.equal(result.findings, 2);
  assert.equal(loadResearchState(f.runId)!.investigations, null);
});

test('invalid subquestions stop before any investigator', async () => {
  for (const value of [[], ['same', 'same'], ['a', 'b', 'c'], [' '], null, 42]) {
    const f = fixture(value);
    await assert.rejects(run(f, agent), /subquestions|subquestion/);
    assert.equal(loadResearchState(f.runId), null);
  }
});

test('failed required work retains accepted siblings and never becomes an unknown or report', async () => {
  const f = fixture();
  const calls = [0, 0];
  const broken: ResearchAgent = {
    ...agent,
    async investigate(_i, _k, _s, _c, a) {
      const index = questions.indexOf(a!.question);
      calls[index] = calls[index]! + 1;
      if (index === 1) throw new Error('research_investigator_idle_timeout');
      return draft();
    },
  };
  await assert.rejects(run(f, broken), /Research blocked/);
  await assert.rejects(run(f, broken), /Research blocked/);
  assert.deepEqual(calls, [1, 2]);
  const state = loadResearchState(f.runId)!;
  assert.ok(state.investigations![0]!.result);
  assert.equal(state.investigations![1]!.result, null);
  assert.equal(state.candidate, null);
  assert.equal(state.corrections, 0);
  assert.equal(fs.existsSync(researchArtifactDirectory(f.repo)), false);
  for (const directory of ['records', 'reports'])
    assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
});

test('whole-question audit correction replaces the batch while audit retries reuse it', async () => {
  const f = fixture();
  let authors = 0,
    audits = 0;
  const result = await run(f, {
    async investigate(_i, _k, _s, c, a) {
      authors++;
      if (authors > 2) assert.match(c!.reason, /coverage/);
      return draft(a!.question.includes('right') ? 'right.ts' : 'left.ts');
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit() {
      audits++;
      if (audits === 1) throw new Error('indeterminate');
      if (audits === 2)
        return {
          summary: 'Missing coverage.',
          findings: [
            {
              severity: 'blocking',
              condition: 'Complete original-question coverage.',
              message: 'Check both module exports.',
              evidence: draft().findings[0]!.evidence,
            },
          ],
        };
      return pass;
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(authors, 4);
  assert.equal(audits, 3);
  assert.equal(loadResearchState(f.runId)!.corrections, 1);
});

test('integration retains contradictory claims, qualifiers and explicit unknowns for the auditor', async () => {
  const f = fixture();
  let seen = false;
  await run(f, {
    async investigate(_i, _k, _s, _c, a) {
      return {
        ...draft(),
        answer: a!.question,
        findings: [
          {
            ...draft().findings[0]!,
            statement: a!.question,
            confidence: 'low',
            qualification: 'Uncertain.',
          },
        ],
        unknowns: [{ question: a!.question, resolution: 'Inspect deployment.' }],
        rejected: [{ statement: a!.question, reason: 'Not confirmed.' }],
        limitations: [a!.question],
      };
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit(_i, c) {
      seen = true;
      assert.equal(c.findings.length, 2);
      assert.equal(c.unknowns.length, 2);
      assert.equal(c.rejected.length, 2);
      assert.equal(c.limitations.length, 2);
      assert.ok(c.findings.every((f) => f.qualification === 'Uncertain.'));
      return pass;
    },
  });
  assert.ok(seen);
});

test('partial results survive process exit and only the pending sibling is dispatched on resume', async () => {
  const f = fixture();
  const script = path.join(temporaryDirectory('parallel-process-'), 'run.ts');
  fs.writeFileSync(
    script,
    `
 import fs from 'node:fs';import {mock} from 'bun:test';
 const rename=fs.renameSync;
 fs.renameSync=(...args)=>{rename(...args);if(String(args[1]).endsWith('research-state.json')){const s=JSON.parse(fs.readFileSync(args[1],'utf8')).state;if(s.investigations?.[0]?.result)process.exit(73);}};
 mock.module('node:fs',()=>({...fs,default:fs}));
 const {runResearchWorkflow}=await import(${JSON.stringify(new URL('../../research/runner.ts', import.meta.url).pathname)});
 await runResearchWorkflow(${JSON.stringify(f.runId)},${JSON.stringify(f.input)},{async investigate(_i,_k,_s,_c,a){if(a.question.includes('right'))await new Promise(()=>{});return ${JSON.stringify(draft())};},async auditPublicSafety(_input,context){return {verdict:'safe',coverage:context.strings.map(item=>item.path),findings:[]};},async audit(){throw new Error('partial work must not audit');}});
 `,
  );
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const err = new Response(child.stderr).text();
  assert.equal(await child.exited, 73, await err);
  assert.ok(loadResearchState(f.runId)!.investigations![0]!.result);
  assert.equal(fs.existsSync(researchArtifactDirectory(f.repo)), false);
  for (const directory of ['records', 'reports'])
    assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
  const calls: string[] = [];
  await run(f, {
    ...agent,
    async investigate(...args) {
      calls.push(args[4]!.question);
      return agent.investigate(...args);
    },
  });
  assert.deepEqual(calls, [questions[1]]);
});

test('changed input cancels late siblings and ownership remains until they settle', async () => {
  const f = fixture();
  let secondStarted!: () => void;
  const started = new Promise<void>((r) => (secondStarted = r));
  let settled = false;
  await assert.rejects(
    run(f, {
      ...agent,
      async investigate(_i, _k, _s, _c, a) {
        if (a!.question === questions[0]) {
          await started;
          fs.writeFileSync(f.input, '{}');
          return draft();
        }
        secondStarted();
        await new Promise<void>((r) =>
          a!.signal.addEventListener(
            'abort',
            () => {
              settled = true;
              r();
            },
            { once: true },
          ),
        );
        return draft('right.ts');
      },
    }),
    /repo|input/,
  );
  assert.equal(settled, true);
  assert.equal(
    loadResearchState(f.runId)!.investigations!.every((p) => p.result === null),
    true,
  );
  assert.equal(fs.existsSync(researchArtifactDirectory(f.repo)), false);
  for (const directory of ['records', 'reports'])
    assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
});

test('old state is retained and independent SDK assignments share only the read-only snapshot', async () => {
  const f = fixture();
  let entered = 0;
  await assert.rejects(
    run(f, {
      ...agent,
      async investigate() {
        const s = loadResearchState(f.runId)!;
        Object.assign(s, { protocol: 'codex-research-state-v2' });
        saveResearchState(f.runId, s);
        entered++;
        return draft();
      },
    }),
    /Retain the record/,
  );
  const before = fs.readFileSync(researchStatePath(f.runId), 'utf8');
  await assert.rejects(run(f, agent), /Retain the record/);
  assert.equal(fs.readFileSync(researchStatePath(f.runId), 'utf8'), before);
  assert.equal(entered, 1);
  let threads = 0;
  const prompts: string[] = [];
  const controller = new AbortController();
  const sdk = new CodexResearchAgent({
    startThread(options) {
      threads++;
      assert.equal(options?.sandboxMode, 'read-only');
      assert.equal(options?.approvalPolicy, 'never');
      assert.equal(options?.webSearchMode, 'disabled');
      assert.equal(options?.networkAccessEnabled, false);
      return {
        async run(prompt, options) {
          prompts.push(prompt);
          assert.equal(options?.signal, controller.signal);
          return { finalResponse: JSON.stringify({ result: draft() }) };
        },
      };
    },
  });
  fs.mkdirSync(path.join(f.repo, '.codex'));
  fs.writeFileSync(path.join(f.repo, '.codex/OUTCOME.md'), '# Outcome\nObserve exports.');
  await Promise.all(
    questions.map((question) =>
      sdk.investigate(
        {
          repo: f.repo,
          question: 'Original question',
          subquestions: questions,
          scope_paths: [],
          allow_external_sources: false,
        },
        [],
        f.repo,
        undefined,
        { question, signal: controller.signal },
      ),
    ),
  );
  assert.equal(threads, 2);
  for (const [index, prompt] of prompts.entries()) {
    assert.ok(prompt.includes('Original question'));
    assert.ok(prompt.includes(questions[index]!));
  }
  const envelope = JSON.parse(before);
  assert.equal(envelope.digest, researchDigest(envelope.state));
});

test('changed subquestions during audit cannot accept or publish the integrated candidate', async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      ...agent,
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
        return {
          verdict: 'safe' as const,
          coverage: context.strings.map((item) => item.path),
          findings: [],
        };
      },
      async audit() {
        const input = JSON.parse(fs.readFileSync(f.input, 'utf8'));
        input.subquestions.reverse();
        fs.writeFileSync(f.input, JSON.stringify(input));
        return pass;
      },
    }),
    /Research input changed/,
  );
  const state = loadResearchState(f.runId)!;
  assert.equal(state.phase, 'audit');
  assert.equal(state.audit, null);
  assert.equal(state.publication, null);
});

test('changed persisted attempts cannot be overwritten by an in-flight investigator', async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      ...agent,
      async investigate() {
        const saved = loadResearchState(f.runId)!;
        saved.investigations![0]!.attempts = 2;
        saveResearchState(f.runId, saved);
        return draft();
      },
    }),
    /stale|changed/,
  );
  const saved = loadResearchState(f.runId)!;
  assert.equal(saved.investigations![0]!.attempts, 2);
  assert.equal(saved.investigations![0]!.result, null);
  assert.equal(saved.publication, null);
});

test('batch boundaries avoid two redundant snapshot scans on the production path', async () => {
  for (const count of [1, 2]) {
    const f = fixture(questions.slice(0, count));
    const script = path.join(temporaryDirectory('parallel-scans-'), 'run.ts');
    fs.writeFileSync(
      script,
      `
      import {mock} from 'bun:test';
      const source = await import(${JSON.stringify(new URL('../../execution/source-seal.ts', import.meta.url).pathname)});
      const original = source.sealRepository;
      let scans = 0;
      mock.module(${JSON.stringify(new URL('../../execution/source-seal.ts', import.meta.url).pathname)}, () => ({...source, sealRepository(...args) { scans++; return original(...args); }}));
      const {runResearchWorkflow} = await import(${JSON.stringify(new URL('../../research/runner.ts', import.meta.url).pathname)});
      await runResearchWorkflow(${JSON.stringify(f.runId)}, ${JSON.stringify(f.input)}, {
        async investigate() { return ${JSON.stringify(draft())}; },
        async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
    return { verdict: 'safe' as const, coverage: context.strings.map(item => item.path), findings: [] };
  },
  async audit() { return ${JSON.stringify(pass)}; }
      });
      // Safety adds a pre-dispatch and a post-dispatch snapshot check.
      if (scans > ${count === 1 ? 10 : 12}) throw new Error('Redundant snapshot scans: ' + scans);
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const error = new Response(child.stderr).text();
    assert.equal(await child.exited, 0, await error);
  }
});

test('parallel waiting joins all investigators and resumes only audited answer dependencies with retry totals intact', async () => {
  const f = modelFixture(exactQuestions);
  const question = {
    id: 'policy',
    prompt: 'Which policy governs the left module investigation?',
    choices: [
      { label: 'Public', description: 'Public use.' },
      { label: 'Private', description: 'Private use.' },
    ],
    recommendation: null,
  };
  const calls = [0, 0];
  let siblingSettled = false;
  const investigator = streamedAgent(async (prompt, schema) => {
    const index = prompt.includes(
      `Your independent assignment: ${JSON.stringify(exactQuestions[0])}`,
    )
      ? 0
      : 1;
    const ids = assignmentIds(prompt, schema, exactQuestions, exactQuestions[index]!);
    calls[index]!++;
    if (index === 1) {
      if (calls[index] === 1) throw new Error('one transient failure');
      await new Promise((resolve) => setTimeout(resolve, 30));
      siblingSettled = true;
      return { result: draft('right.ts') };
    }
    return {
      result: prompt.includes('Complete clarification history')
        ? draft('left.ts')
        : { status: 'waiting', question, affected_questions: [ids[0]] },
    };
  });
  const worker: ResearchAgent = {
    investigate(...args) {
      return investigator.investigate(...args);
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit(_i, candidate, _k, _s, pending) {
      assert(siblingSettled);
      if (pending) {
        assert.deepEqual(pending.question, question);
        assert.deepEqual(pending.investigations[0]!.affected, [exactQuestions[0]]);
        assert.equal(pending.investigations[1]!.attempts, 2);
        assert.deepEqual(candidate.findings, draft('right.ts').findings);
      } else assert.equal(candidate.findings.length, 2);
      return pass;
    },
  };
  const waiting = await run(f, worker);
  assert(waiting.status === 'waiting');
  assert.deepEqual(calls, [1, 2]);
  const before = loadResearchState(f.runId)!;
  assert.deepEqual(before.investigations![0]!.affected, [exactQuestions[0]]);
  assert.deepEqual(await run(f, worker), waiting);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(loadResearchState(f.runId), before);
  const input = JSON.parse(fs.readFileSync(f.input, 'utf8'));
  fs.writeFileSync(
    f.input,
    JSON.stringify({
      ...input,
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
  assert.equal((await run(f, worker)).status, 'completed');
  assert.deepEqual(calls, [2, 2]);
  assert.equal(loadResearchState(f.runId)!.corrections, before.corrections);
  assert.deepEqual(
    loadResearchState(f.runId)!.dispatch_history.slice(0, before.dispatch_history.length),
    before.dispatch_history,
  );
});

const policyQuestion = {
  id: 'parallel-policy',
  prompt: 'Which audience governs this investigation?',
  choices: [
    { label: 'Public', description: 'Investigate public use.' },
    { label: 'Private', description: 'Investigate private use.' },
  ],
  recommendation: null,
};

function modelFixture(subquestions: string[] = questions) {
  const f = fixture(subquestions);
  fs.mkdirSync(path.join(f.repo, '.codex'));
  fs.writeFileSync(
    path.join(f.repo, '.codex/OUTCOME.md'),
    '# Outcome\nInvestigate the access policy.',
  );
  return f;
}

// Controlled SDK events exercise the production adapter, without claiming external API acceptance.
function streamedAgent(respond: (prompt: string, schema: unknown) => unknown) {
  return new CodexResearchAgent({
    startThread() {
      return {
        async run(prompt, options) {
          return runStreamedCodexTurn(
            {
              async runStreamed(actualPrompt, actualOptions) {
                assert.equal(actualPrompt, prompt);
                const safety = prompt.match(
                  /----- BEGIN PUBLIC SAFETY CONTEXT [^\n]+\n([^\n]+)\n/u,
                );
                const response = safety
                  ? {
                      verdict: 'safe',
                      coverage: (
                        JSON.parse(safety[1]!) as { strings: { path: string }[] }
                      ).strings.map((item) => item.path),
                      findings: [],
                    }
                  : await respond(prompt, actualOptions?.outputSchema);
                return {
                  events: (async function* () {
                    yield {
                      type: 'item.completed' as const,
                      item: {
                        id: 'response',
                        type: 'agent_message' as const,
                        text: JSON.stringify(response),
                      },
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
            options,
          );
        },
      };
    },
  });
}

function assignmentIds(prompt: string, schema: unknown, vocabulary: string[], own: string) {
  const emitted = schema as {
    properties: { result: { anyOf: [unknown, { properties: { affected_questions: unknown } }] } };
  };
  const mapping = JSON.parse(prompt.match(/^Complete assignment ID mapping: (.+)$/m)![1]!) as {
    id: string;
    question: string;
  }[];
  assert.deepEqual(
    mapping.map((entry) => entry.question),
    vocabulary,
  );
  const ids = mapping.map((entry) => entry.id);
  assert.equal(new Set(ids).size, vocabulary.length);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{1,16}$/);
  assert.deepEqual(emitted.properties.result.anyOf[1].properties.affected_questions, {
    anyOf: [{ type: 'array', minItems: 1, items: { type: 'string', enum: ids } }, { type: 'null' }],
  });
  assert.deepEqual(
    JSON.parse(prompt.match(/^Your assignment and ID: (.+)$/m)![1]!),
    mapping.find((entry) => entry.question === own),
  );
  assert(prompt.includes('including your own assignment ID'));
  assert(prompt.includes('meaning all assignments'));
  return ids;
}

const exactQuestions = [
  'Which "公開" policy applies?\nPreserve the literal \\n in left.ts.',
  'Which "café" policy applies?\nPreserve C:\\right\\policy.',
];

test('default investigator decodes waiting IDs against concurrent and later call-local vocabularies', async () => {
  const f = modelFixture();
  const sharedSchema = JSON.stringify(RESEARCH_WAITING_SCHEMA);
  const vocabularies = [
    exactQuestions,
    ['Different "雪" question\nwith \\paths', 'Sibling β'],
    ['Single "日本語"\nwith \\literal'],
  ];
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen: string[][] = [];
  const worker = streamedAgent(async (prompt, schema) => {
    const index = entered++;
    const vocabulary = vocabularies[index]!;
    const ids = assignmentIds(prompt, schema, vocabulary, vocabulary.at(-1)!);
    seen.push(ids);
    if (index < 2) {
      if (entered === 2) release();
      await gate;
    }
    return {
      result: {
        status: 'waiting',
        question: policyQuestion,
        affected_questions: [...ids].reverse(),
      },
    };
  });
  const investigate = (vocabulary: string[]) =>
    worker.investigate(
      {
        repo: f.repo,
        question: vocabulary.length === 1 ? vocabulary[0]! : 'Original question',
        scope_paths: [],
        allow_external_sources: false,
        ...(vocabulary.length > 1 ? { subquestions: vocabulary } : {}),
      },
      [],
      f.repo,
      undefined,
      { question: vocabulary.at(-1)!, signal: new AbortController().signal },
    );
  const results = await Promise.all(vocabularies.slice(0, 2).map(investigate));
  results.push(await investigate(vocabularies[2]!));
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result, {
      status: 'waiting',
      question: policyQuestion,
      affected_questions: [...vocabularies[index]!].reverse(),
    });
  }
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[2]![0], seen[0]![0]);
  assert.equal(JSON.stringify(RESEARCH_WAITING_SCHEMA), sharedSchema);
});

test.each(['unknown', 'padded', 'lowercase', 'raw prose'])(
  'default investigator rejects %s IDs even when the SDK skips response validation',
  async (variant) => {
    const f = modelFixture();
    const worker = streamedAgent((prompt, schema) => {
      const [id] = assignmentIds(prompt, schema, exactQuestions, exactQuestions[0]!);
      const invalid =
        variant === 'unknown'
          ? 'Z999'
          : variant === 'padded'
            ? ` ${id} `
            : variant === 'lowercase'
              ? id!.toLowerCase()
              : exactQuestions[0];
      return {
        result: { status: 'waiting', question: policyQuestion, affected_questions: [invalid] },
      };
    });
    await assert.rejects(
      worker.investigate(
        {
          repo: f.repo,
          question: 'Original',
          subquestions: exactQuestions,
          scope_paths: [],
          allow_external_sources: false,
        },
        [],
        f.repo,
        undefined,
        { question: exactQuestions[0]!, signal: new AbortController().signal },
      ),
      /unknown answer-affected assignment ID/,
    );
  },
);

for (const boundary of ['default', 'injected']) {
  test.each(
    boundary === 'default'
      ? ['unknown', 'duplicate', 'sibling-only']
      : ['unknown', 'normalized', 'escaped', 'paraphrased', 'duplicate', 'sibling-only'],
  )(`${boundary} investigator rejects invalid dependencies before audit (%s)`, async (variant) => {
    const f = modelFixture(exactQuestions);
    const calls = [0, 0];
    const dependencies = (vocabulary: string[]) => {
      switch (variant) {
        case 'duplicate':
          return [vocabulary[0]!, vocabulary[0]!];
        case 'sibling-only':
          return [vocabulary[1]!];
        case 'normalized':
          return [vocabulary[0]!.replace(/\s+/g, ' ')];
        case 'escaped':
          return [JSON.stringify(vocabulary[0]!).slice(1, -1)];
        case 'paraphrased':
          return ['What policy governs left.ts?'];
        default:
          return ['Unknown'];
      }
    };
    const investigator: ResearchAgent =
      boundary === 'default'
        ? streamedAgent((prompt, schema) => {
            assert(prompt.startsWith('Investigate the research question.'));
            const index = prompt.includes(
              `Your independent assignment: ${JSON.stringify(exactQuestions[0])}`,
            )
              ? 0
              : 1;
            calls[index]!++;
            const ids = assignmentIds(prompt, schema, exactQuestions, exactQuestions[index]!);
            return {
              result:
                index === 1
                  ? draft('right.ts')
                  : {
                      status: 'waiting',
                      question: policyQuestion,
                      affected_questions: dependencies(ids),
                    },
            };
          })
        : {
            async investigate(_i, _k, _s, _c, assignment) {
              const index = exactQuestions.indexOf(assignment!.question);
              calls[index]!++;
              return index === 1
                ? draft('right.ts')
                : {
                    status: 'waiting',
                    question: policyQuestion,
                    affected_questions: dependencies(exactQuestions),
                  };
            },
            async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
              return {
                verdict: 'safe' as const,
                coverage: context.strings.map((item) => item.path),
                findings: [],
              };
            },
            async audit() {
              assert.fail('Invalid dependencies must fail before audit');
            },
          };
    let audits = 0;
    const worker: ResearchAgent = {
      async investigate(...args) {
        const result = await investigator.investigate(...args);
        if (boundary === 'default' && 'status' in result) {
          // Valid IDs retain duplicates and sibling-only dependencies for pipeline enforcement.
          assert.deepEqual(result.affected_questions, dependencies(exactQuestions));
        }
        return result;
      },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
        return {
          verdict: 'safe' as const,
          coverage: context.strings.map((item) => item.path),
          findings: [],
        };
      },
      async audit() {
        audits++;
        assert.fail('Invalid dependencies must fail before audit');
      },
    };
    await assert.rejects(run(f, worker), /Research blocked/);
    assert.deepEqual(calls, [2, 1]);
    assert.equal(audits, 0);
    const saved = loadResearchState(f.runId)!;
    assert.equal(saved.corrections, 0);
    assert.match(
      saved.investigations![0]!.reason!,
      boundary === 'default' && variant === 'unknown'
        ? /unknown answer-affected assignment ID/
        : /invalid answer-affected assignments/,
    );
    assert.equal(saved.investigations![0]!.proposal, null);
    assert.deepEqual(saved.investigations![1]!.result, draft('right.ts'));
    assert.equal(fs.existsSync(researchArtifactDirectory(f.repo)), false);
    for (const directory of ['records', 'reports'])
      assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
    await assert.rejects(run(f, worker), /Research blocked/);
    assert.deepEqual(calls, [2, 1]);
    assert.equal(audits, 0);
    assert.deepEqual(loadResearchState(f.runId), saved);
  });
}

test('default investigator own-only dependencies require independent correction and null retains all assignments', async () => {
  const f = modelFixture(exactQuestions);
  const calls = [0, 0];
  let audits = 0;
  let answered = false;
  const worker = streamedAgent((prompt, schema) => {
    if (prompt.startsWith('Investigate the research question.')) {
      const index = prompt.includes(
        `Your independent assignment: ${JSON.stringify(exactQuestions[0])}`,
      )
        ? 0
        : 1;
      calls[index]!++;
      const ids = assignmentIds(prompt, schema, exactQuestions, exactQuestions[index]!);
      if (answered) assert(prompt.includes('Complete clarification history'));
      if (index === 1 || answered) return { result: draft(index === 1 ? 'right.ts' : 'left.ts') };
      if (calls[0]! > 1) assert(prompt.includes('Include the dependent sibling'));
      return {
        result: {
          status: 'waiting',
          question: policyQuestion,
          affected_questions: calls[0] === 1 ? [ids[0]] : null,
        },
      };
    }
    audits++;
    const saved = loadResearchState(f.runId)!;
    if (!answered) {
      const expected = audits === 1 ? [exactQuestions[0]] : exactQuestions;
      assert.deepEqual(saved.investigations![0]!.affected, expected);
      assert.deepEqual(JSON.parse(saved.candidate!.answer).investigations[0].affected, expected);
      assert(prompt.includes(JSON.stringify(expected)));
      assert(prompt.includes('Reject incomplete answer dependencies'));
    }
    return audits === 1
      ? {
          summary: 'The answer changes both assignments.',
          findings: [
            {
              severity: 'blocking',
              condition: 'Complete answer dependencies.',
              message: 'Include the dependent sibling in affected_questions.',
              evidence: [],
            },
          ],
        }
      : pass;
  });
  const waiting = await run(f, worker);
  assert(waiting.status === 'waiting');
  assert.deepEqual(waiting.question, policyQuestion);
  assert.equal(audits, 2);
  assert.deepEqual(calls, [2, 2]);
  const saved = loadResearchState(f.runId)!;
  assert.equal(saved.corrections, 1);
  assert.deepEqual(saved.investigations![0]!.affected, exactQuestions);
  assert.equal(fs.existsSync(researchArtifactDirectory(f.repo)), false);
  for (const directory of ['records', 'reports'])
    assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
  assert.deepEqual(await run(f, worker), waiting);
  assert.deepEqual(loadResearchState(f.runId), saved);
  assert.deepEqual(calls, [2, 2]);
  assert.equal(audits, 2);
  const original = JSON.parse(fs.readFileSync(f.input, 'utf8'));
  const answer = {
    owner: waiting.owner,
    question_id: policyQuestion.id,
    prompt: policyQuestion.prompt,
    choices: policyQuestion.choices,
    recommendation: null,
    selection: 'Private',
    answer: null,
  };
  fs.writeFileSync(f.input, JSON.stringify({ ...original, clarification_answers: [answer] }));
  answered = true;
  assert.equal((await run(f, worker)).status, 'completed');
  assert.deepEqual(calls, [3, 3]);
  assert.equal(audits, 3);
  const completed = loadResearchState(f.runId)!;
  assert.equal(completed.corrections, 1);
  assert.deepEqual(
    completed.dispatch_history.slice(0, saved.dispatch_history.length),
    saved.dispatch_history,
  );
  assert.deepEqual(completed.clarification_history, [answer]);
});

test.each(['uninterrupted', 'correction', 'retry'])(
  'conflicting parallel questions receive a correction-round retry and preserve history (%s)',
  async (boundary) => {
    const f = fixture();
    if (boundary !== 'uninterrupted') {
      const script = path.join(temporaryDirectory('parallel-correction-'), 'run.ts');
      fs.writeFileSync(
        script,
        `
        import fs from 'node:fs';import {mock} from 'bun:test';
        const rename=fs.renameSync;
        fs.renameSync=(...args)=>{
          rename(...args);
          if(String(args[1]).endsWith('research-state.json')){
            const s=JSON.parse(fs.readFileSync(args[1],'utf8')).state;
            if(s.corrections===1 && (${JSON.stringify(boundary)}==='correction' || s.investigations.some(p=>p.attempts===3 && p.reason==='transient')))process.exit(73);
          }
        };
        mock.module('node:fs',()=>({...fs,default:fs}));
        const {runResearchWorkflow}=await import(${JSON.stringify(new URL('../../research/runner.ts', import.meta.url).pathname)});
        const {loadResearchState}=await import(${JSON.stringify(new URL('../../research/state.ts', import.meta.url).pathname)});
        await runResearchWorkflow(${JSON.stringify(f.runId)},${JSON.stringify(f.input)},{
          async investigate(_i,_k,_s,_c,a){
            const s=loadResearchState(${JSON.stringify(f.runId)});
            const part=s.investigations.find(p=>p.question===a.question);
            if(part.attempts%2===1)throw Error('transient');
            return {status:'waiting',question:{...${JSON.stringify(policyQuestion)},id:a.question}};
          },
          async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
    return { verdict: 'safe' as const, coverage: context.strings.map(item => item.path), findings: [] };
  },
  async audit(){throw Error('Conflicting questions must not reach audit');}
        });
        `,
      );
      const child = Bun.spawn([process.execPath, script], {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = new Response(child.stderr).text();
      assert.equal(await child.exited, 73, await stderr);
    }
    const interrupted = loadResearchState(f.runId);
    let audits = 0;
    const worker: ResearchAgent = {
      async investigate(input, _k, _s, correction, assignment) {
        const state = loadResearchState(f.runId)!;
        const part = state.investigations!.find((p) => p.question === assignment!.question)!;
        const index = questions.indexOf(part.question);
        if (input.clarification_answers?.length) {
          assert.equal(index, 0);
          return draft();
        }
        if (state.corrections) {
          assert.match(correction!.reason, /reconcile/);
          const previous = JSON.parse(correction!.candidate.answer);
          assert.deepEqual(
            previous.map((p: { attempts: number }) => p.attempts),
            [2, 2],
          );
          assert.deepEqual(
            previous.map((p: { proposal: { id: string } }) => p.proposal.id),
            questions,
          );
        }
        if (part.attempts % 2 === 1) throw new Error('transient');
        if (!state.corrections)
          return { status: 'waiting', question: { ...policyQuestion, id: part.question } };
        return index === 0
          ? { status: 'waiting', question: policyQuestion, affected_questions: [questions[0]!] }
          : draft('right.ts');
      },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
        return {
          verdict: 'safe' as const,
          coverage: context.strings.map((item) => item.path),
          findings: [],
        };
      },
      async audit(input, candidate, _k, _s, pending) {
        audits++;
        if (!input.clarification_answers?.length) {
          assert.deepEqual(pending!.question, policyQuestion);
          assert.deepEqual(
            pending!.investigations.map((p) => p.attempts),
            [4, 4],
          );
          assert.deepEqual(candidate.findings, draft('right.ts').findings);
        } else {
          assert.equal(pending, undefined);
          assert.equal(candidate.findings.length, 2);
        }
        return pass;
      },
    };
    const waiting = await run(f, worker);
    assert(waiting.status === 'waiting');
    const saved = loadResearchState(f.runId)!;
    assert.equal(saved.corrections, 1);
    assert.equal(saved.dispatch_history.length, 9);
    if (interrupted) {
      assert.equal(saved.invocation, interrupted.invocation);
      assert.equal(saved.source_digest, interrupted.source_digest);
      assert.deepEqual(saved.input, interrupted.input);
      assert.deepEqual(saved.knowledge, interrupted.knowledge);
      assert.deepEqual(
        saved.dispatch_history.slice(0, interrupted.dispatch_history.length),
        interrupted.dispatch_history,
      );
    }
    assert.equal(fs.existsSync(researchArtifactDirectory(f.repo)), false);
    for (const directory of ['records', 'reports'])
      assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
    assert.deepEqual(await run(f, worker), waiting);
    assert.deepEqual(loadResearchState(f.runId), saved);
    const answer = {
      owner: waiting.owner,
      question_id: waiting.question.id,
      prompt: waiting.question.prompt,
      choices: waiting.question.choices,
      recommendation: waiting.question.recommendation,
      selection: 'Private',
      answer: null,
    };
    fs.writeFileSync(
      f.input,
      JSON.stringify({ ...(saved.raw_input as object), clarification_answers: [answer] }),
    );
    assert.equal((await run(f, worker)).status, 'completed');
    const completed = loadResearchState(f.runId)!;
    assert.equal(completed.corrections, 1);
    assert.equal(completed.dispatch_history.length, 11);
    assert.deepEqual(completed.clarification_history, [answer]);
    assert.deepEqual(completed.accepted_questions, [
      {
        waiting: { status: waiting.status, question: waiting.question, owner: waiting.owner },
        candidate: saved.candidate,
        review: saved.audit,
      },
    ]);
    assert.equal(audits, 2);
  },
);

test.each(['conflicts', 'failures'])(
  'parallel reconciliation retains bounded correction and retry exhaustion (%s)',
  async (outcome) => {
    const f = fixture();
    const calls = [0, 0];
    const worker: ResearchAgent = {
      async investigate(_i, _k, _s, _c, assignment) {
        const index = questions.indexOf(assignment!.question);
        calls[index]!++;
        if (calls[index]! % 2 === 1 || (outcome === 'failures' && calls[index]! > 2))
          throw new Error('transient');
        return { status: 'waiting', question: { ...policyQuestion, id: assignment!.question } };
      },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
        return {
          verdict: 'safe' as const,
          coverage: context.strings.map((item) => item.path),
          findings: [],
        };
      },
      async audit() {
        assert.fail('Unreconciled questions and failures must not reach audit');
      },
    };
    await assert.rejects(run(f, worker), /Research blocked/);
    const saved = loadResearchState(f.runId)!;
    assert.deepEqual(calls, outcome === 'conflicts' ? [8, 8] : [4, 4]);
    assert.equal(saved.corrections, outcome === 'conflicts' ? 3 : 1);
    assert.deepEqual(
      saved.investigations!.map((p) => p.attempts),
      calls,
    );
    assert.equal(saved.dispatch_history.length, calls[0]! + calls[1]!);
    assert.equal(fs.existsSync(researchArtifactDirectory(f.repo)), false);
    for (const directory of ['records', 'reports'])
      assert.equal(fs.existsSync(path.join(f.repo, 'research', directory)), false);
    await assert.rejects(run(f, worker), /Research blocked/);
    assert.deepEqual(loadResearchState(f.runId), saved);
    assert.deepEqual(calls, outcome === 'conflicts' ? [8, 8] : [4, 4]);
  },
);

test('untracked cited evidence and missing public-safety responses reject accepted parallel source audits', async () => {
  for (const mode of ['untracked', 'missing-safety', 'invalid-safety']) {
    const f = fixture();
    if (mode === 'untracked') execFileSync('git', ['-C', f.repo, 'rm', '--cached', 'right.ts']);
    let sourceAudits = 0;
    const worker: ResearchAgent = {
      ...agent,
      async audit() {
        sourceAudits++;
        return pass;
      },
    };
    if (mode === 'missing-safety') delete worker.auditPublicSafety;
    if (mode === 'invalid-safety')
      worker.auditPublicSafety = async () => ({ verdict: 'safe', coverage: [], findings: [] });
    await assert.rejects(run(f, worker), /public-safety/);
    assert.equal(sourceAudits, 1);
    assert.equal(fs.existsSync(path.join(f.repo, 'research/records')), false);
    assert.equal(fs.existsSync(path.join(f.repo, 'research/reports')), false);
  }
});
