/** @file Outcome: Think correction, recovery and publication cannot bypass independent acceptance. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { armIntent, loadIntent } from '../../runtime/invocation.ts';
import { runThinkWorkflow } from '../../think/runner.ts';
import {
  loadThinkState,
  saveThinkState,
  thinkDigest,
  thinkSnapshotPath,
  thinkPublicationPaths,
} from '../../think/state.ts';
import { thinkStatePath, thinkArtifactDirectory } from '../../runtime/storage.ts';
import type { ThinkAgent } from '../../think/agent.ts';
import type { ThinkDraft, ThinkReview } from '../../think/contracts.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';
import { persistResearchReport } from '../../research/artifact.ts';
import { updateKnowledge } from '../../research/knowledge.ts';

useTemporaryWorkflowStorage('think-resume-');
const candidate: ThinkDraft = {
  status: 'ready',
  research_questions: [],
  plan: {
    outcome: 'Export value 2.',
    test_command: 'bun test',
    units: [
      {
        goal: 'Export value 2.',
        files: ['value.ts'],
        contract: 'Consumers receive 2.',
        tests: ['The exported value equals 2.'],
      },
    ],
  },
};
const passing: ThinkReview = { summary: 'The candidate meets the request.', findings: [] };
const blocking: ThinkReview = {
  summary: 'Wrong value.',
  findings: [
    {
      severity: 'blocking',
      condition: 'Export the requested value.',
      message: 'The request requires 2, not 1.',
      evidence: ['input.request: Export value 2.', 'candidate.plan.outcome: Export value 1.'],
    },
  ],
};
const agent: ThinkAgent = {
  async design() {
    return candidate;
  },
  async review() {
    return passing;
  },
};
function fixture() {
  const repo = temporaryDirectory('think-resume-repo-');
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'value.ts'), 'export const value = 1;\n');
  const runId = crypto.randomUUID();
  const intent = armIntent({ runId, workflow: 'think', cwd: repo });
  fs.writeFileSync(
    intent.input_path,
    JSON.stringify({ repo, request: 'Export value 2.', research_reports: [] }),
  );
  return { repo, runId, inputFile: intent.input_path };
}

test('static and semantic failures return to the designer, with independent review of each valid candidate', async () => {
  for (const failure of ['static', 'semantic']) {
    const { runId, inputFile } = fixture();
    let designs = 0,
      reviews = 0;
    const bad = structuredClone(candidate);
    if (failure === 'static') bad.plan!.test_command = 'bun test && echo unsafe';
    else bad.plan!.outcome = 'Export value 1.';
    const result = await runThinkWorkflow(runId, inputFile, {
      async design(_input, _research, _knowledge, _contract, _snapshot, correction) {
        if (designs++ === 0) return bad;
        assert.deepEqual(correction!.candidate, bad);
        assert.match(correction!.reason, failure === 'static' ? /test_command/ : /requires 2/);
        return candidate;
      },
      async review(_input, draft) {
        reviews++;
        assert.equal(draft.plan!.test_command, 'bun test');
        return draft.plan!.outcome === candidate.plan!.outcome ? passing : blocking;
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(designs, 2);
    assert.equal(reviews, failure === 'static' ? 1 : 2);
    assert.equal(loadThinkState(runId)!.corrections, 1);
  }
});

test('research questions and advisory findings preserve the designer candidate despite reviewer mutation', async () => {
  const { runId, inputFile } = fixture();
  const unknown: ThinkDraft = {
    status: 'research_required',
    plan: null,
    research_questions: [
      'Which external deployment consumes value.ts? No deployment configuration is supplied.',
    ],
  };
  const result = await runThinkWorkflow(runId, inputFile, {
    async design() {
      return unknown;
    },
    async review(_input, draft) {
      assert.deepEqual(draft, unknown);
      draft.research_questions = ['Reviewer rewrite'];
      return {
        ...blocking,
        findings: blocking.findings.map((f) => ({ ...f, severity: 'advisory' })),
      };
    },
  });
  assert.equal(result.next_step, 'research');
  assert.deepEqual(loadThinkState(runId)!.candidate, unknown);
});

test('correction exhaustion is durable and only a new explicit invocation starts a new budget', async () => {
  const { runId, inputFile, repo } = fixture();
  let calls = 0;
  const failing = {
    ...agent,
    async review() {
      calls++;
      return blocking;
    },
  };
  await assert.rejects(runThinkWorkflow(runId, inputFile, failing), /blocked after 3/);
  await assert.rejects(runThinkWorkflow(runId, inputFile, failing), /blocked after 3/);
  assert.equal(calls, 4);
  assert.equal(fs.existsSync(thinkArtifactDirectory(repo)), false);
  armIntent({ runId, workflow: 'think', cwd: repo });
  await runThinkWorkflow(runId, inputFile, agent);
  assert.equal(loadThinkState(runId)!.corrections, 0);
});

test('malformed output and transport failures are bounded indeterminate stops without publication', async () => {
  for (const stage of ['design', 'review'] as const)
    for (const failure of ['malformed', 'transport']) {
      const { runId, inputFile, repo } = fixture();
      let calls = 0;
      const failing = {
        ...agent,
        [stage]: async () => {
          calls++;
          if (failure === 'transport') throw new Error('connection unavailable');
          return {};
        },
      } as ThinkAgent;
      await assert.rejects(runThinkWorkflow(runId, inputFile, failing), /Think blocked/);
      await assert.rejects(runThinkWorkflow(runId, inputFile, failing), /Think blocked/);
      const saved = loadThinkState(runId)!;
      assert.equal(saved.corrections, 0);
      assert.ok(saved.reason);
      assert.equal(calls, 2);
      assert.equal(loadIntent(runId), null);
      assert.equal(fs.existsSync(thinkArtifactDirectory(repo)), false);
    }
});

test('competing owner prevents input inspection and intent replacement while a model is active', async () => {
  const { runId, inputFile, repo } = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = runThinkWorkflow(runId, inputFile, {
    ...agent,
    async design() {
      started();
      await pending;
      return candidate;
    },
  });
  await entered;
  try {
    await assert.rejects(
      runThinkWorkflow(runId, '/missing-input.json', agent),
      /active runtime owner/,
    );
    assert.throws(() => armIntent({ runId, workflow: 'think', cwd: repo }), /active runtime owner/);
  } finally {
    release();
  }
  await running;
});

test('changed dispatch, captured evidence and snapshot reject pending results', async () => {
  for (const change of ['dispatch', 'evidence', 'snapshot', 'contract', 'input']) {
    const { runId, inputFile, repo } = fixture();
    await assert.rejects(
      runThinkWorkflow(runId, inputFile, {
        ...agent,
        async review() {
          const state = loadThinkState(runId)!;
          if (change === 'input')
            fs.writeFileSync(
              inputFile,
              fs.readFileSync(inputFile, 'utf8').replace('value 2', 'value 3'),
            );
          else if (change === 'snapshot')
            fs.writeFileSync(path.join(thinkSnapshotPath(runId, state), 'value.ts'), 'changed');
          else {
            if (change === 'dispatch') state.dispatch = crypto.randomUUID();
            if (change === 'evidence')
              state.research = [
                {
                  path: 'changed.json',
                  generated_at: '2026-09-01T00:00:00.000Z',
                  question: 'Changed context',
                  answer: 'Missing fact',
                  findings: [],
                  unknowns: [{ question: 'Which value?', resolution: 'Obtain requirement.' }],
                  limitations: [],
                },
              ];
            if (change === 'contract') state.contract_digest = '0'.repeat(64);
            saveThinkState(runId, state);
          }
          return passing;
        },
      }),
      /stale|snapshot changed|governing input changed/,
    );
    assert.equal(fs.existsSync(thinkArtifactDirectory(repo)), false);
  }
});

// Interrupt real processes at writes, including after model return but before candidate acceptance.
async function interruptAt(runId: string, inputFile: string, boundary: string): Promise<string> {
  const script = path.join(temporaryDirectory('think-child-'), 'interrupt.ts');
  const runner = new URL('../../think/runner.ts', import.meta.url).pathname;
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs';
    import { mock } from 'bun:test';
    const original = fs.renameSync;
    fs.renameSync = (...args) => {
      const destination = String(args[1]);
      if (destination.endsWith('think-state.json') && ${JSON.stringify(boundary)}.endsWith('-before')) {
        const state = JSON.parse(fs.readFileSync(args[0], 'utf8')).state;
        if (state.phase + '-before' === ${JSON.stringify(boundary)}) process.exit(73);
      }
      original(...args);
      if (destination.endsWith('think-state.json')) {
        const state = JSON.parse(fs.readFileSync(destination, 'utf8')).state;
        if (${JSON.stringify(boundary)} === 'correction' && state.phase === 'design' && state.corrections === 1) process.exit(73);
        if (state.phase === ${JSON.stringify(boundary)} && (${JSON.stringify(boundary)} !== 'design' || state.dispatch)) process.exit(73);
      }
      if (${JSON.stringify(boundary)} === 'json' && /think-[a-f0-9-]+\\.json$/.test(destination)) process.exit(73);
    };
    mock.module('node:fs', () => ({ ...fs, default: fs }));
    const { runThinkWorkflow } = await import(${JSON.stringify(runner)});
    await runThinkWorkflow(${JSON.stringify(runId)}, ${JSON.stringify(inputFile)}, {
      async design() { return ${JSON.stringify(candidate)}; },
      async review() { return ${JSON.stringify(boundary === 'correction' ? blocking : passing)}; },
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
  return fs.readFileSync(thinkStatePath(runId), 'utf8');
}

test('process exits before and after acceptance resume only permitted work and reuse paired publication', async () => {
  for (const boundary of [
    'design',
    'validate-before',
    'validate',
    'review',
    'decide-before',
    'decide',
    'publish',
    'json',
  ]) {
    const { runId, inputFile, repo } = fixture();
    await interruptAt(runId, inputFile, boundary);
    const saved = loadThinkState(runId)!;
    fs.writeFileSync(path.join(repo, 'value.ts'), 'live edit');
    assert.throws(() => armIntent({ runId, workflow: 'research', cwd: repo }), /Think is active/);
    let designs = 0,
      reviews = 0;
    const result = await runThinkWorkflow(runId, inputFile, {
      async design(_input, _r, _k, _c, snapshot) {
        designs++;
        assert.match(fs.readFileSync(path.join(snapshot, 'value.ts'), 'utf8'), /value = 1/);
        return candidate;
      },
      async review(_input, draft) {
        reviews++;
        assert.deepEqual(draft, candidate);
        return passing;
      },
    });
    assert.equal(designs, ['design', 'validate-before'].includes(boundary) ? 1 : 0);
    assert.equal(
      reviews,
      ['design', 'validate-before', 'validate', 'review', 'decide-before'].includes(boundary)
        ? 1
        : 0,
    );
    assert.equal(result.report_json, thinkPublicationPaths(saved).json);
    const before = fs.statSync(result.report_json).mtimeMs;
    const markdownBefore = fs.statSync(result.report_markdown).mtimeMs;
    fs.rmSync(thinkSnapshotPath(runId, saved), { recursive: true });
    const noCalls = {
      async design() {
        throw new Error('no redispatch');
      },
      async review() {
        throw new Error('no redispatch');
      },
    };
    assert.deepEqual(await runThinkWorkflow(runId, inputFile, noCalls), result);
    assert.equal(fs.statSync(result.report_json).mtimeMs, before);
    assert.equal(fs.statSync(result.report_markdown).mtimeMs, markdownBefore);
    fs.unlinkSync(result.report_markdown);
    assert.deepEqual(await runThinkWorkflow(runId, inputFile, noCalls), result);
    assert.equal(fs.readdirSync(thinkArtifactDirectory(repo)).length, 2);
  }
}, 20000);

test('correction context and interrupted dispatch budgets survive restart', async () => {
  const { runId, inputFile } = fixture();
  await interruptAt(runId, inputFile, 'correction');
  await runThinkWorkflow(runId, inputFile, {
    ...agent,
    async design(_i, _r, _k, _c, _s, correction) {
      assert.deepEqual(correction!.candidate, candidate);
      assert.match(correction!.reason, /requires 2/);
      return candidate;
    },
  });
  const interrupted = fixture();
  await interruptAt(interrupted.runId, interrupted.inputFile, 'design');
  await interruptAt(interrupted.runId, interrupted.inputFile, 'design');
  await assert.rejects(
    runThinkWorkflow(interrupted.runId, interrupted.inputFile, agent),
    /Both permitted model dispatches/,
  );
  assert.equal(loadThinkState(interrupted.runId)!.corrections, 0);
});

test('changed inputs and incompatible state retain the record and reject before dispatch', async () => {
  const { runId, inputFile } = fixture();
  const saved = await interruptAt(runId, inputFile, 'review');
  const input = fs.readFileSync(inputFile, 'utf8');
  fs.writeFileSync(inputFile, input.replace('value 2', 'value 3'));
  await assert.rejects(runThinkWorkflow(runId, inputFile, agent), /exact original input/);
  fs.writeFileSync(inputFile, input);
  const changed = JSON.parse(saved);
  changed.state.contract_digest = '0'.repeat(64);
  changed.digest = thinkDigest(changed.state);
  fs.writeFileSync(thinkStatePath(runId), JSON.stringify(changed));
  await assert.rejects(runThinkWorkflow(runId, inputFile, agent), /governing contract changed/);
  changed.state.protocol = 'unsupported';
  changed.digest = thinkDigest(changed.state);
  for (const invalid of ['{}', JSON.stringify(changed)]) {
    fs.writeFileSync(thinkStatePath(runId), invalid);
    await assert.rejects(runThinkWorkflow(runId, inputFile, agent), /Retain the record/);
    assert.equal(fs.readFileSync(thinkStatePath(runId), 'utf8'), invalid);
  }
});

test('captured Research basenames and Knowledge survive live removal and configuration changes', async () => {
  const { runId, inputFile, repo } = fixture();
  const report = {
    protocol: 'codex-research-report' as const,
    generated_at: '2026-09-01T00:00:00.000Z',
    question: 'Export value 2.',
    scope_paths: [],
    answer: 'No deployment known.',
    findings: [
      {
        id: 'F-001',
        statement: 'The source exports 1.',
        kind: 'fact' as const,
        confidence: 'high' as const,
        qualification: null,
        evidence: [
          {
            kind: 'repository' as const,
            source: 'value.ts',
            locator: 'L1',
            supports: 'The value is 1.',
          },
        ],
        implication: 'Change the exported value.',
      },
    ],
    rejected: [],
    unknowns: [{ question: 'Which deployment consumes it?', resolution: 'Obtain configuration.' }],
    limitations: [],
  };
  const selected = persistResearchReport(repo, report).json;
  const prior = persistResearchReport(repo, {
    ...report,
    generated_at: '2026-09-02T00:00:00.000Z',
    question: 'Export value behavior',
  }).json;
  updateKnowledge(repo);
  fs.writeFileSync(
    inputFile,
    JSON.stringify({
      repo,
      request: 'Export value 2.',
      research_reports: [path.basename(selected)],
    }),
  );
  await interruptAt(runId, inputFile, 'review');
  const saved = loadThinkState(runId)!;
  assert.equal(saved.research.length, 1);
  assert.equal(saved.knowledge.length, 1);
  fs.unlinkSync(selected);
  fs.unlinkSync(prior);
  const configured = process.env.CODEX_FLOW_ARTIFACT_DIR;
  process.env.CODEX_FLOW_ARTIFACT_DIR = temporaryDirectory('think-moved-research-');
  try {
    await runThinkWorkflow(runId, inputFile, {
      ...agent,
      async review(_i, _d, research, knowledge) {
        assert.deepEqual(research, saved.research);
        assert.deepEqual(knowledge, saved.knowledge);
        return passing;
      },
    });
  } finally {
    if (configured === undefined) delete process.env.CODEX_FLOW_ARTIFACT_DIR;
    else process.env.CODEX_FLOW_ARTIFACT_DIR = configured;
  }
});

test('partial publication retains its fixed paths when artifact configuration changes', async () => {
  const { runId, inputFile } = fixture();
  await interruptAt(runId, inputFile, 'json');
  const paths = thinkPublicationPaths(loadThinkState(runId)!);
  assert.equal(fs.existsSync(paths.markdown), false);
  const configured = process.env.CODEX_FLOW_ARTIFACT_DIR;
  process.env.CODEX_FLOW_ARTIFACT_DIR = temporaryDirectory('think-new-artifacts-');
  try {
    const result = await runThinkWorkflow(runId, inputFile, agent);
    assert.equal(result.report_json, paths.json);
    assert.equal(result.report_markdown, paths.markdown);
  } finally {
    if (configured === undefined) delete process.env.CODEX_FLOW_ARTIFACT_DIR;
    else process.env.CODEX_FLOW_ARTIFACT_DIR = configured;
  }
});
