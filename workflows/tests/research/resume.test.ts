/** @file Outcome: Research correction and process recovery cannot skip verification or duplicate artifacts. */

import assert from 'node:assert/strict';
import { test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { armIntent, loadIntent } from '../../runtime/invocation.ts';
import { runResearchWorkflow } from '../../research/runner.ts';
import {
  loadResearchState,
  saveResearchState,
  researchSnapshotPath,
  researchPublicationPaths,
  researchDigest,
} from '../../research/state.ts';
import { researchArtifactDirectory, researchStatePath } from '../../runtime/storage.ts';
import { type ResearchAgent } from '../../research/agent.ts';
import { type ResearchAudit, type ResearchDraft } from '../../research/contracts.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('research-resume-');

const evidence = [
  {
    kind: 'repository' as const,
    source: 'value.ts',
    locator: 'L1',
    supports: 'The exported value is 42.',
  },
];
const candidate: ResearchDraft = {
  answer: 'The value is 42.',
  findings: [
    {
      statement: 'The value is 42.',
      kind: 'fact',
      confidence: 'high',
      qualification: null,
      evidence,
      implication: 'Use the exported value.',
    },
  ],
  rejected: [],
  unknowns: [],
  limitations: [],
};
const passing: ResearchAudit = { summary: 'Supported.', findings: [] };
const blocking: ResearchAudit = {
  summary: 'Wrong value.',
  findings: [
    {
      severity: 'blocking',
      condition: 'Answer the requested value accurately.',
      message: 'The source exports 42.',
      evidence,
    },
  ],
};
const agent: ResearchAgent = {
  async investigate() {
    return candidate;
  },
  async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
    return {
      verdict: 'safe' as const,
      coverage: context.strings.map((item) => item.path),
      findings: [],
    };
  },
  async audit() {
    return passing;
  },
};

function fixture() {
  const repo = temporaryDirectory('research-resume-repo-');
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'value.ts'), 'export const value = 42;\n');
  execFileSync('git', ['-C', repo, 'add', 'value.ts']);
  const runId = crypto.randomUUID();
  const intent = armIntent({ runId, workflow: 'research', cwd: repo });
  fs.writeFileSync(
    intent.input_path,
    JSON.stringify({
      repo,
      question: 'What is the exported value?',
      scope_paths: [],
      allow_external_sources: false,
    }),
  );
  return { repo, runId, inputFile: intent.input_path };
}

test('blocking review returns saved candidate and evidence to its author, then re-audits', async () => {
  const { runId, inputFile } = fixture();
  let authors = 0,
    auditors = 0;
  const result = await runResearchWorkflow(runId, inputFile, {
    async investigate(_input, _knowledge, _snapshot, correction) {
      if (authors++) {
        assert.match(correction!.reason, /exports 42/);
        assert.equal(correction!.candidate.answer, 'The value is 1.');
        return candidate;
      }
      assert.equal(correction, undefined);
      return { ...candidate, answer: 'The value is 1.' };
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit(_input, draft) {
      auditors += 1;
      return draft.answer === candidate.answer ? passing : blocking;
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(authors, 2);
  assert.equal(auditors, 2);
  assert.equal(loadResearchState(runId)!.corrections, 1);
});

test('explicit unknowns and advisory findings can complete without reviewer rewriting', async () => {
  const { runId, inputFile } = fixture();
  const unknown: ResearchDraft = {
    ...candidate,
    answer: 'The value is known but deployment configuration is absent.',
    findings: [],
    unknowns: [
      {
        question: 'Which deployment uses it? Inspected value.ts contains only the export.',
        resolution: 'Obtain deployment configuration.',
      },
    ],
  };
  await runResearchWorkflow(runId, inputFile, {
    async investigate() {
      return unknown;
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit(_input, draft) {
      draft.answer = 'Reviewer attempted rewrite.';
      return {
        ...blocking,
        findings: blocking.findings.map((f) => ({ ...f, severity: 'advisory' })),
      };
    },
  });
  assert.equal(loadResearchState(runId)!.candidate!.answer, unknown.answer);
  assert.equal(loadResearchState(runId)!.corrections, 0);
});

test('three corrections remain exhausted across retries without new intent', async () => {
  const { runId, inputFile } = fixture();
  let calls = 0;
  const failing: ResearchAgent = {
    ...agent,
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit() {
      calls++;
      return blocking;
    },
  };
  await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /after 3 corrections/);
  await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /after 3 corrections/);
  assert.equal(calls, 4);
});

test('indeterminate model failures stop at the retry budget without publication or corrections', async () => {
  for (const stage of ['investigate', 'audit'] as const) {
    for (const failure of ['malformed', 'transport'] as const) {
      const { runId, inputFile, repo } = fixture();
      let calls = 0;
      const fail = async () => {
        calls++;
        if (failure === 'transport') throw new Error('model connection unavailable');
        return {};
      };
      const failing = { ...agent, [stage]: fail } as ResearchAgent;
      await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /Research blocked/);
      await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /Research blocked/);
      const state = loadResearchState(runId)!;
      assert.equal(state.phase, 'blocked');
      assert.ok(state.reason);
      assert.equal(state.corrections, 0);
      assert.equal(calls, 2);
      assert.equal(loadIntent(runId), null);
      assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
    }
  }
});

test('a competing run or intent cannot dispatch while an owner holds the Research run', async () => {
  const { runId, inputFile, repo } = fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const owner = runResearchWorkflow(runId, inputFile, {
    ...agent,
    async investigate() {
      entered();
      await waiting;
      return candidate;
    },
  });
  await started;
  const before = fs.readFileSync(researchStatePath(runId), 'utf8');
  try {
    await assert.rejects(runResearchWorkflow(runId, inputFile, agent), /active runtime owner/);
    // Even invalid input is inspected only after ownership, so a contender cannot race startup.
    await assert.rejects(
      runResearchWorkflow(runId, '/missing-input.json', agent),
      /active runtime owner/,
    );
    assert.throws(
      () => armIntent({ runId, workflow: 'research', cwd: repo }),
      /active runtime owner/,
    );
    assert.equal(fs.readFileSync(researchStatePath(runId), 'utf8'), before);
  } finally {
    release();
    await owner;
  }
});

test('changed pending identity or snapshot rejects the response without publishing', async () => {
  for (const changed of ['dispatch', 'snapshot']) {
    const { runId, inputFile, repo } = fixture();
    await assert.rejects(
      runResearchWorkflow(runId, inputFile, {
        ...agent,
        async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
          return {
            verdict: 'safe' as const,
            coverage: context.strings.map((item) => item.path),
            findings: [],
          };
        },
        async audit() {
          const state = loadResearchState(runId)!;
          if (changed === 'dispatch') {
            state.dispatch = crypto.randomUUID();
            saveResearchState(runId, state);
          } else
            fs.writeFileSync(
              path.join(researchSnapshotPath(runId, state), 'value.ts'),
              'tampered\n',
            );
          return passing;
        },
      }),
      /stale|snapshot changed/,
    );
    assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
    assert.equal(loadResearchState(runId)!.phase, 'audit');
  }
});

// Inject a real process exit immediately after a persisted boundary, without production test hooks.
async function interruptAt(runId: string, inputFile: string, boundary: string): Promise<string> {
  const root = temporaryDirectory('research-child-');
  const script = path.join(root, 'interrupt.ts');
  const runner = new URL('../../research/runner.ts', import.meta.url).pathname;
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs';
    import { mock } from 'bun:test';
    const original = fs.renameSync;
    fs.renameSync = (...args) => {
      original(...args);
      const destination = String(args[1]);
      if (destination.endsWith('research-state.json')) {
        const state = JSON.parse(fs.readFileSync(destination, 'utf8')).state;
        if (${JSON.stringify(boundary)} === 'correction' && state.phase === 'investigate' && state.corrections === 1) process.exit(73);
        if (state.phase === ${JSON.stringify(boundary)} && (${JSON.stringify(boundary)} !== 'investigate' || state.investigations?.some(part => part.attempts > 0 && part.result === null))) process.exit(73);
      }
      if (${JSON.stringify(boundary)} === 'json' && /research-[a-f0-9-]+\\.json$/.test(destination)) process.exit(73);
    };
    const originalLink = fs.linkSync;
    fs.linkSync = (...args) => { originalLink(...args); if ((${JSON.stringify(boundary)} === 'json' && String(args[1]).endsWith('.json')) || (${JSON.stringify(boundary)} === 'pair' && String(args[1]).endsWith('.md'))) process.exit(73); };
    mock.module('node:fs', () => ({ ...fs, default: fs }));
    const { runResearchWorkflow } = await import(${JSON.stringify(runner)});
    await runResearchWorkflow(${JSON.stringify(runId)}, ${JSON.stringify(inputFile)}, {
      async investigate() { return ${JSON.stringify(candidate)}; },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
    return { verdict: 'safe' as const, coverage: context.strings.map(item => item.path), findings: [] };
  },
  async audit() { return ${JSON.stringify(boundary === 'correction' ? blocking : passing)}; },
    });
  `,
  );
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await child.exited;
  const stderr = await new Response(child.stderr).text();
  assert.equal(exit, 73, stderr);
  return fs.readFileSync(researchStatePath(runId), 'utf8');
}

test('real process exits resume saved candidates, audits and paired publication exactly once', async () => {
  for (const boundary of [
    'investigate',
    'validate',
    'audit',
    'decide',
    'safety',
    'publish',
    'json',
    'pair',
  ]) {
    const { runId, inputFile, repo } = fixture();
    await interruptAt(runId, inputFile, boundary);
    const saved = loadResearchState(runId)!;
    assert.equal(loadIntent(runId), null);
    fs.writeFileSync(path.join(repo, 'value.ts'), 'export const value = 0;\n');
    let authors = 0,
      audits = 0,
      safetyAudits = 0;
    const resumed: ResearchAgent = {
      async investigate(_input, _knowledge, snapshot) {
        authors++;
        assert.match(fs.readFileSync(path.join(snapshot, 'value.ts'), 'utf8'), /42/);
        return candidate;
      },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
        safetyAudits++;
        return {
          verdict: 'safe' as const,
          coverage: context.strings.map((item) => item.path),
          findings: [],
        };
      },
      async audit(_input, draft, _knowledge, snapshot) {
        audits++;
        assert.equal(draft.answer, candidate.answer);
        assert.match(fs.readFileSync(path.join(snapshot, 'value.ts'), 'utf8'), /42/);
        return passing;
      },
    };
    const result = await runResearchWorkflow(runId, inputFile, resumed);
    assert.equal(authors, boundary === 'investigate' ? 1 : 0);
    assert.equal(audits, ['investigate', 'validate', 'audit'].includes(boundary) ? 1 : 0);
    assert.equal(
      safetyAudits,
      ['investigate', 'validate', 'audit', 'decide', 'safety'].includes(boundary) ? 1 : 0,
    );
    if (saved.publication) assert.equal(result.report_json!, researchPublicationPaths(saved).json);
    const again = await runResearchWorkflow(runId, inputFile, {
      async investigate() {
        throw new Error('no redispatch');
      },
      async auditPublicSafety() {
        throw new Error('completed Research must not repeat safety audit');
      },
      async audit() {
        throw new Error('no redispatch');
      },
    });
    assert.deepEqual(again, result);
    assert.equal(fs.readdirSync(path.join(repo, 'research/records')).length, 1);
    assert.equal(fs.readdirSync(path.join(repo, 'research/reports')).length, 1);
  }
}, 15000);

test('resume rejects changed input and unsupported or corrupt state before dispatch', async () => {
  const { runId, inputFile } = fixture();
  const originalInput = fs.readFileSync(inputFile, 'utf8');
  const saved = await interruptAt(runId, inputFile, 'audit');
  fs.writeFileSync(inputFile, originalInput.replace('What is', 'Where is'));
  await assert.rejects(runResearchWorkflow(runId, inputFile, agent), /exact original input/);
  assert.equal(fs.readFileSync(researchStatePath(runId), 'utf8'), saved);
  fs.writeFileSync(inputFile, originalInput);
  const unsupported = JSON.parse(saved);
  unsupported.state.protocol = 'unsupported-research-state';
  unsupported.digest = researchDigest(unsupported.state);
  for (const corrupt of ['{}', JSON.stringify(unsupported)]) {
    fs.writeFileSync(researchStatePath(runId), corrupt);
    await assert.rejects(runResearchWorkflow(runId, inputFile, agent), /Retain the record/);
    assert.equal(fs.readFileSync(researchStatePath(runId), 'utf8'), corrupt);
  }
});

test('interrupted correction restores the author context and spent budget', async () => {
  const { runId, inputFile } = fixture();
  await interruptAt(runId, inputFile, 'correction');
  assert.equal(loadResearchState(runId)!.corrections, 1);
  await runResearchWorkflow(runId, inputFile, {
    ...agent,
    async investigate(_input, _knowledge, _snapshot, correction) {
      assert.deepEqual(correction!.candidate, candidate);
      assert.match(correction!.reason, /exports 42/);
      return candidate;
    },
  });
  assert.equal(loadResearchState(runId)!.corrections, 1);
});

test('two interrupted dispatches exhaust the same persisted retry budget', async () => {
  const { runId, inputFile } = fixture();
  await interruptAt(runId, inputFile, 'investigate');
  await interruptAt(runId, inputFile, 'investigate');
  let calls = 0;
  await assert.rejects(
    runResearchWorkflow(runId, inputFile, {
      ...agent,
      async investigate() {
        calls++;
        return candidate;
      },
    }),
    /Both permitted model dispatches/,
  );
  assert.equal(calls, 0);
  assert.equal(loadResearchState(runId)!.corrections, 0);
});

test('resume validates scoped paths against the saved snapshot after live deletion', async () => {
  const { runId, inputFile, repo } = fixture();
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  input.scope_paths = ['value.ts'];
  fs.writeFileSync(inputFile, JSON.stringify(input));
  await interruptAt(runId, inputFile, 'audit');
  fs.unlinkSync(path.join(repo, 'value.ts'));
  const result = await runResearchWorkflow(runId, inputFile, agent);
  assert.equal(result.status, 'completed');
});

test('partial publication retains its original destinations when artifact configuration changes', async () => {
  const { runId, inputFile } = fixture();
  await interruptAt(runId, inputFile, 'json');
  const saved = loadResearchState(runId)!;
  const paths = researchPublicationPaths(saved);
  assert.equal(fs.existsSync(paths.json), true);
  assert.equal(fs.existsSync(paths.markdown), false);
  const configured = process.env.CODEX_FLOW_ARTIFACT_DIR;
  process.env.CODEX_FLOW_ARTIFACT_DIR = temporaryDirectory('research-other-artifacts-');
  try {
    const result = await runResearchWorkflow(runId, inputFile, agent);
    assert.equal(result.report_json!, paths.json);
    assert.equal(result.report_markdown!, paths.markdown);
    assert.equal(fs.existsSync(paths.markdown), true);
  } finally {
    if (configured === undefined) delete process.env.CODEX_FLOW_ARTIFACT_DIR;
    else process.env.CODEX_FLOW_ARTIFACT_DIR = configured;
  }
});

test('report-incompatible citation syntax is corrected before the independent audit', async () => {
  const { runId, inputFile } = fixture();
  let authors = 0,
    auditors = 0;
  await runResearchWorkflow(runId, inputFile, {
    async investigate(_input, _knowledge, _snapshot, correction) {
      if (authors++) {
        assert.match(correction!.reason, /normalized repository path/);
        return candidate;
      }
      return {
        ...candidate,
        findings: [
          { ...candidate.findings[0]!, evidence: [{ ...evidence[0]!, source: './value.ts' }] },
        ],
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
      auditors++;
      return passing;
    },
  });
  assert.equal(authors, 2);
  assert.equal(auditors, 1);
});

test('completed retrieval needs no snapshot or writes and repairs only missing views', async () => {
  const { runId, inputFile, repo } = fixture();
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  input.scope_paths = ['value.ts'];
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const result = await runResearchWorkflow(runId, inputFile, agent);
  const saved = loadResearchState(runId)!;
  assert.equal('report' in saved, false);
  assert.equal(
    saved.generated_at,
    JSON.parse(fs.readFileSync(result.report_json!, 'utf8')).generated_at,
  );
  const before = fs.readFileSync(result.report_json!, 'utf8');
  const markdown = fs.readFileSync(result.report_markdown!, 'utf8');
  fs.rmSync(researchSnapshotPath(runId, saved), { recursive: true });
  fs.unlinkSync(path.join(repo, 'value.ts'));
  const sentinel = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(result.report_json!, sentinel, sentinel);
  fs.utimesSync(result.report_markdown!, sentinel, sentinel);
  const noAgent: ResearchAgent = {
    async investigate() {
      throw new Error('completed run must not dispatch');
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit() {
      throw new Error('completed run must not dispatch');
    },
  };
  assert.deepEqual(await runResearchWorkflow(runId, inputFile, noAgent), result);
  assert.equal(fs.statSync(result.report_json!).mtimeMs, sentinel.getTime());
  assert.equal(fs.statSync(result.report_markdown!).mtimeMs, sentinel.getTime());
  fs.unlinkSync(result.report_markdown!);
  assert.deepEqual(await runResearchWorkflow(runId, inputFile, noAgent), result);
  assert.equal(fs.readFileSync(result.report_markdown!, 'utf8'), markdown);
  assert.equal(fs.readFileSync(result.report_json!, 'utf8'), before);
  assert.equal(fs.statSync(result.report_json!).mtimeMs, sentinel.getTime());
  fs.writeFileSync(inputFile, JSON.stringify({ ...input, question: 'Different question' }));
  await assert.rejects(runResearchWorkflow(runId, inputFile, noAgent), /exact original input/);
});

test('successful publication never attempts a second Markdown write', async () => {
  const { runId, inputFile } = fixture();
  const root = temporaryDirectory('research-write-once-');
  const script = path.join(root, 'write-once.ts');
  const runner = new URL('../../research/runner.ts', import.meta.url).pathname;
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs';
    import path from 'node:path';
    import { mock } from 'bun:test';
    const original = fs.linkSync;
    let writes = 0;
    fs.linkSync = (...args) => {
      if (/^[a-f0-9]{64}\\.md$/.test(path.basename(String(args[1]))) && ++writes > 1) throw new Error('redundant Markdown write');
      return original(...args);
    };
    mock.module('node:fs', () => ({ ...fs, default: fs }));
    const { runResearchWorkflow } = await import(${JSON.stringify(runner)});
    const result = await runResearchWorkflow(${JSON.stringify(runId)}, ${JSON.stringify(inputFile)}, {
      async investigate() { return ${JSON.stringify(candidate)}; },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
    return { verdict: 'safe' as const, coverage: context.strings.map(item => item.path), findings: [] };
  },
  async audit() { return ${JSON.stringify(passing)}; },
    });
    console.log(JSON.stringify({status: result.status, writes}));
  `,
  );
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(await child.exited, 0, await new Response(child.stderr).text());
  assert.deepEqual(JSON.parse(await new Response(child.stdout).text()), {
    status: 'completed',
    writes: 1,
  });
});

const decisionQuestion = {
  id: 'scope-policy',
  prompt: 'Which supported deployment is in scope for this investigation?',
  choices: [
    { label: 'Public', description: 'Investigate the public deployment.' },
    { label: 'Private', description: 'Investigate the private deployment.' },
  ],
  recommendation: null,
};

test('a retried investigator can enter waiting without losing its failure or invalidating settled state', async () => {
  const { runId, inputFile, repo } = fixture();
  let authors = 0;
  let audits = 0;
  const worker: ResearchAgent = {
    async investigate(input) {
      authors++;
      if (authors === 1) throw new Error('Transient investigator failure');
      return input.clarification_answers?.length
        ? candidate
        : { status: 'waiting', question: decisionQuestion };
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
      return passing;
    },
  };
  const waiting = await runResearchWorkflow(runId, inputFile, worker);
  assert(waiting.status === 'waiting');
  const state = loadResearchState(runId)!;
  assert.equal(state.investigations![0]!.attempts, 2);
  assert.equal(state.investigations![0]!.settled, 1);
  assert.equal(state.investigations![0]!.reason, null);
  assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
  assert.deepEqual(await runResearchWorkflow(runId, inputFile, worker), waiting);
  assert.equal(authors, 2);
  assert.equal(audits, 1);
  const original = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const { id, ...context } = decisionQuestion;
  fs.writeFileSync(
    inputFile,
    JSON.stringify({
      ...original,
      clarification_answers: [
        {
          owner: waiting.owner,
          question_id: id,
          ...context,
          selection: 'Private',
          answer: null,
        },
      ],
    }),
  );
  assert.equal((await runResearchWorkflow(runId, inputFile, worker)).status, 'completed');
  assert.equal(authors, 3);
  assert.equal(audits, 2);
  assert.deepEqual(
    loadResearchState(runId)!.dispatch_history.slice(0, state.dispatch_history.length),
    state.dispatch_history,
  );
});

test('Research waiting is audited, stable, owner-bound and resumes with full history and the original snapshot', async () => {
  for (const freeText of [false, true]) {
    const { runId, inputFile, repo } = fixture();
    let authors = 0,
      audits = 0;
    const worker: ResearchAgent = {
      async investigate(input, _k, snapshot) {
        authors++;
        assert.match(fs.readFileSync(path.join(snapshot, 'value.ts'), 'utf8'), /42/);
        return input.clarification_answers?.length
          ? candidate
          : { status: 'waiting', question: decisionQuestion };
      },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
        return {
          verdict: 'safe' as const,
          coverage: context.strings.map((item) => item.path),
          findings: [],
        };
      },
      async audit(input, _draft, _k, _snapshot, question) {
        audits++;
        if (!input.clarification_answers?.length) {
          assert.deepEqual(question!.question, decisionQuestion);
          assert.equal(question!.investigations.length, 1);
        } else assert.equal(question, undefined);
        return passing;
      },
    };
    const waiting = await runResearchWorkflow(runId, inputFile, worker);
    assert(waiting.status === 'waiting');
    assert.equal('report_json' in waiting, false);
    assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
    const before = loadResearchState(runId)!;
    assert.deepEqual(await runResearchWorkflow(runId, inputFile, worker), waiting);
    assert.equal(authors, 1);
    assert.equal(audits, 1);
    const original = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const answer = {
      owner: waiting.owner,
      question_id: waiting.question.id,
      prompt: waiting.question.prompt,
      choices: waiting.question.choices,
      recommendation: waiting.question.recommendation,
      selection: freeText ? null : 'Public',
      answer: freeText ? '  Both deployment policies, verbatim.  ' : null,
    };
    for (const changed of [
      { ...answer, owner: { ...answer.owner, leaf: 'other' } },
      { ...answer, prompt: 'edited' },
    ]) {
      fs.writeFileSync(
        inputFile,
        JSON.stringify({ ...original, clarification_answers: [changed] }),
      );
      await assert.rejects(runResearchWorkflow(runId, inputFile, worker), /owner|match/);
      assert.equal(authors, 1);
    }
    fs.writeFileSync(path.join(repo, 'value.ts'), 'live repository refresh is not authorized\n');
    fs.writeFileSync(inputFile, JSON.stringify({ ...original, clarification_answers: [answer] }));
    const result = await runResearchWorkflow(runId, inputFile, worker);
    assert.equal(result.status, 'completed');
    const after = loadResearchState(runId)!;
    assert.equal(after.invocation, before.invocation);
    assert.equal(after.source_digest, before.source_digest);
    assert.deepEqual(after.clarification_history, [answer]);
    assert.equal(authors, 2);
    assert.equal(audits, 2);
    fs.writeFileSync(
      inputFile,
      JSON.stringify({
        ...original,
        clarification_answers: [{ ...answer, answer: 'edited', selection: null }],
      }),
    );
    await assert.rejects(runResearchWorkflow(runId, inputFile, worker), /history/);
    assert.equal(authors, 2);
  }
}, 15000);

test('rejected Research questions return to their investigator for correction and fresh whole-question audit', async () => {
  const { runId, inputFile } = fixture();
  let authors = 0,
    audits = 0;
  const result = await runResearchWorkflow(runId, inputFile, {
    async investigate(_i, _k, _s, correction) {
      authors++;
      if (authors > 1) assert.match(correction!.reason, /42/);
      return { status: 'waiting', question: { ...decisionQuestion, id: `scope-${authors}` } };
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit(_i, _d, _k, _s, question) {
      audits++;
      assert.equal(question!.question.id, `scope-${audits}`);
      return audits === 1 ? blocking : passing;
    },
  });
  assert(result.status === 'waiting');
  assert.equal(result.question.id, 'scope-2');
  assert.equal(loadResearchState(runId)!.corrections, 1);
  assert.equal(authors, 2);
  assert.equal(audits, 2);
});

for (const parallel of [false, true]) {
  test(`rejected question correction exhaustion retains readable audit context and permits fresh authorization (parallel=${parallel})`, async () => {
    const { runId, inputFile, repo } = fixture();
    const originalInput = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (parallel) originalInput.subquestions = ['Deployment scope?', 'Exported value?'];
    fs.writeFileSync(inputFile, JSON.stringify(originalInput));
    const rejection: ResearchAudit = {
      summary: 'The proposed preference does not affect the requested result.',
      findings: [
        {
          severity: 'blocking',
          condition: 'Only necessary user-owned decisions may wait.',
          message: 'Answer the factual request without this unnecessary preference.',
          evidence: [],
        },
      ],
    };
    let proposals = 0,
      siblings = 0,
      audits = 0;
    const worker: ResearchAgent = {
      async investigate(_i, _k, _s, correction, assignment) {
        if (parallel && assignment!.question === 'Exported value?') {
          siblings++;
          return candidate;
        }
        proposals++;
        if (proposals > 1) assert.match(correction!.reason, /unnecessary preference/);
        return {
          status: 'waiting',
          question: { ...decisionQuestion, id: `rejected-${proposals}` },
        };
      },
      async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
        return {
          verdict: 'safe' as const,
          coverage: context.strings.map((item) => item.path),
          findings: [],
        };
      },
      async audit(_i, _d, _k, _s, context) {
        audits++;
        assert.equal(context!.question.id, `rejected-${audits}`);
        assert.equal(context!.investigations.length, parallel ? 2 : 1);
        return rejection;
      },
    };
    await assert.rejects(runResearchWorkflow(runId, inputFile, worker), /after 3 corrections/);
    const terminal = loadResearchState(runId)!;
    assert.equal(terminal.phase, 'blocked');
    assert.equal(terminal.corrections, 3);
    assert.deepEqual(terminal.pending_question, { ...decisionQuestion, id: 'rejected-4' });
    assert.deepEqual(terminal.audit, rejection);
    assert.equal(terminal.pending_owner, null);
    assert.equal(terminal.publication, null);
    assert.equal(terminal.generated_at, null);
    assert.deepEqual(terminal.accepted_questions, []);
    assert.deepEqual(terminal.clarification_history, []);
    assert.equal(terminal.investigations![0]!.attempts, 4);
    assert.equal(terminal.dispatch_history.length, parallel ? 12 : 8);
    const terminalBytes = fs.readFileSync(researchStatePath(runId), 'utf8');
    await assert.rejects(runResearchWorkflow(runId, inputFile, worker), /after 3 corrections/);
    assert.equal(fs.readFileSync(researchStatePath(runId), 'utf8'), terminalBytes);
    assert.equal(proposals, 4);
    assert.equal(audits, 4);
    assert.equal(siblings, parallel ? 4 : 0);
    assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);

    const freshInput = { ...originalInput, question: 'Confirm the exported value in a fresh run.' };
    fs.writeFileSync(inputFile, JSON.stringify(freshInput));
    await assert.rejects(runResearchWorkflow(runId, inputFile, agent), /exact original input/);
    assert.equal(fs.readFileSync(researchStatePath(runId), 'utf8'), terminalBytes);
    const authorized = armIntent({ runId, workflow: 'research', cwd: repo });
    assert.equal(authorized.input_path, inputFile);
    const completed = await runResearchWorkflow(runId, inputFile, agent);
    assert.equal(completed.status, 'completed');
    const fresh = loadResearchState(runId)!;
    assert.notEqual(fresh.invocation, terminal.invocation);
    assert.equal(fresh.corrections, 0);
    assert.equal(fresh.pending_question, null);
    assert.deepEqual(fresh.clarification_history, []);
    assert.equal(loadIntent(runId), null);
    assert.ok(fs.existsSync(researchSnapshotPath(runId, terminal)));
  });
}

test('persisted Research waiting requires its independently accepted candidate and every bound value', async () => {
  const { runId, inputFile } = fixture();
  let calls = 0;
  const worker: ResearchAgent = {
    async investigate() {
      calls++;
      return { status: 'waiting', question: decisionQuestion };
    },
    async auditPublicSafety(_input: unknown, context: { strings: { path: string }[] }) {
      return {
        verdict: 'safe' as const,
        coverage: context.strings.map((item) => item.path),
        findings: [],
      };
    },
    async audit() {
      return passing;
    },
  };
  const waiting = await runResearchWorkflow(runId, inputFile, worker);
  assert(waiting.status === 'waiting');
  const original = fs.readFileSync(researchStatePath(runId), 'utf8');
  const mutations = [
    ...(['root', 'task'] as const).map(
      (field) => (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
        s.pending_owner![field] = 'another-owner';
        s.pending_owner!.handoff = researchDigest({
          root: s.pending_owner!.root,
          task: s.pending_owner!.task,
          invocation: s.invocation,
        });
      },
    ),
    (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
      s.audit = null;
    },
    (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
      s.audit = blocking;
    },
    (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
      s.candidate!.answer = 'edited';
    },
    (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
      s.pending_question!.prompt = 'edited';
    },
    (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
      s.dispatch = 'edited';
    },
    (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
      s.input.allow_external_sources = true;
    },
    (s: NonNullable<ReturnType<typeof loadResearchState>>) => {
      s.investigations![0]!.attempts++;
    },
  ];
  for (const mutate of mutations) {
    const state = JSON.parse(original).state;
    mutate(state);
    saveResearchState(runId, state);
    const bytes = fs.readFileSync(researchStatePath(runId), 'utf8');
    await assert.rejects(
      runResearchWorkflow(runId, inputFile, worker),
      /acceptance|owner|input|state cannot resume/,
    );
    assert.equal(fs.readFileSync(researchStatePath(runId), 'utf8'), bytes);
    assert.equal(calls, 1);
  }
  fs.writeFileSync(researchStatePath(runId), original);
  assert.deepEqual(await runResearchWorkflow(runId, inputFile, worker), waiting);
});
