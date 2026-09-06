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
  async audit() {
    return passing;
  },
};

function fixture() {
  const repo = temporaryDirectory('research-resume-repo-');
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'value.ts'), 'export const value = 42;\n');
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
    async audit(_input, draft) {
      draft.answer = 'Reviewer attempted rewrite.';
      return {
        ...blocking,
        findings: blocking.findings.map((f) => ({ ...f, severity: 'advisory' })),
      };
    },
  });
  assert.equal(loadResearchState(runId)!.report!.answer, unknown.answer);
  assert.equal(loadResearchState(runId)!.corrections, 0);
});

test('three corrections remain exhausted across retries without new intent', async () => {
  const { runId, inputFile } = fixture();
  let calls = 0;
  const failing: ResearchAgent = {
    ...agent,
    async audit() {
      calls++;
      return blocking;
    },
  };
  await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /after 3 corrections/);
  await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /after 3 corrections/);
  assert.equal(calls, 4);
});

test('malformed auditor and transport failures retry once without investigator corrections', async () => {
  for (const invalid of ['malformed', 'transport']) {
    const { runId, inputFile, repo } = fixture();
    let audits = 0;
    const failing: ResearchAgent = {
      ...agent,
      async audit() {
        audits++;
        if (invalid === 'transport') throw new Error('timeout');
        return { answer: 'Auditor cannot author a report.' } as unknown as ResearchAudit;
      },
    };
    await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /Research blocked/);
    await assert.rejects(runResearchWorkflow(runId, inputFile, failing), /Research blocked/);
    assert.equal(audits, 2);
    assert.equal(loadResearchState(runId)!.corrections, 0);
    assert.equal(fs.existsSync(researchArtifactDirectory(repo)), false);
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
        if (state.phase === ${JSON.stringify(boundary)} && (${JSON.stringify(boundary)} !== 'investigate' || state.dispatch)) process.exit(73);
      }
      if (${JSON.stringify(boundary)} === 'json' && /research-[a-f0-9-]+\\.json$/.test(destination)) process.exit(73);
    };
    mock.module('node:fs', () => ({ ...fs, default: fs }));
    const { runResearchWorkflow } = await import(${JSON.stringify(runner)});
    await runResearchWorkflow(${JSON.stringify(runId)}, ${JSON.stringify(inputFile)}, {
      async investigate() { return ${JSON.stringify(candidate)}; },
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
  for (const boundary of ['investigate', 'validate', 'audit', 'decide', 'publish', 'json']) {
    const { runId, inputFile, repo } = fixture();
    await interruptAt(runId, inputFile, boundary);
    const saved = loadResearchState(runId)!;
    assert.equal(loadIntent(runId), null);
    fs.writeFileSync(path.join(repo, 'value.ts'), 'export const value = 0;\n');
    let authors = 0,
      audits = 0;
    const resumed: ResearchAgent = {
      async investigate(_input, _knowledge, snapshot) {
        authors++;
        assert.match(fs.readFileSync(path.join(snapshot, 'value.ts'), 'utf8'), /42/);
        return candidate;
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
    assert.equal(result.report_json, researchPublicationPaths(saved).json);
    const again = await runResearchWorkflow(runId, inputFile, {
      async investigate() {
        throw new Error('no redispatch');
      },
      async audit() {
        throw new Error('no redispatch');
      },
    });
    assert.deepEqual(again, result);
    assert.equal(fs.readdirSync(researchArtifactDirectory(repo)).length, 2);
  }
}, 15000);

test('resume rejects changed input and old or corrupt state before dispatch', async () => {
  const { runId, inputFile } = fixture();
  const originalInput = fs.readFileSync(inputFile, 'utf8');
  const saved = await interruptAt(runId, inputFile, 'audit');
  fs.writeFileSync(inputFile, originalInput.replace('What is', 'Where is'));
  await assert.rejects(runResearchWorkflow(runId, inputFile, agent), /exact original input/);
  assert.equal(fs.readFileSync(researchStatePath(runId), 'utf8'), saved);
  fs.writeFileSync(inputFile, originalInput);
  for (const corrupt of [
    '{}',
    saved.replace('codex-research-state-v1', 'codex-research-state-v0'),
  ]) {
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
    assert.equal(result.report_json, paths.json);
    assert.equal(result.report_markdown, paths.markdown);
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
    async audit() {
      auditors++;
      return passing;
    },
  });
  assert.equal(authors, 2);
  assert.equal(auditors, 1);
});
