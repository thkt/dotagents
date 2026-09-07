/** @file Outcome: Independent Research parts overlap and survive interruption without bypassing the final audit. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'bun:test';
import { armIntent } from '../../runtime/invocation.ts';
import { researchArtifactDirectory, researchStatePath } from '../../runtime/storage.ts';
import { runResearchWorkflow } from '../../research/runner.ts';
import { loadResearchState, saveResearchState, researchDigest } from '../../research/state.ts';
import { CodexResearchAgent, type ResearchAgent } from '../../research/agent.ts';
import type { ResearchDraft } from '../../research/contracts.ts';
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
const run = (f: ReturnType<typeof fixture>, agent: ResearchAgent) =>
  runResearchWorkflow(f.runId, f.input, agent);
const agent: ResearchAgent = {
  async investigate(_i, _k, _s, _c, assignment) {
    return draft(assignment!.question.includes('right') ? 'right.ts' : 'left.ts');
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
    audits = 0;
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
 await runResearchWorkflow(${JSON.stringify(f.runId)},${JSON.stringify(f.input)},{async investigate(_i,_k,_s,_c,a){if(a.question.includes('right'))await new Promise(()=>{});return ${JSON.stringify(draft())};},async audit(){throw new Error('partial work must not audit');}});
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
          return { finalResponse: JSON.stringify(draft()) };
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
        async audit() { return ${JSON.stringify(pass)}; }
      });
      if (scans > ${count === 1 ? 8 : 10}) throw new Error('Redundant snapshot scans: ' + scans);
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
