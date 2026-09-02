/** @file Outcome: Research telemetry remains typed, bounded, and diagnosable at every model boundary. */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { renderResearchMarkdown } from '../../../workflows/research/artifact.ts';
import { parseResearchReport } from '../../../workflows/research/contracts.ts';
import { CodexResearchAgent } from '../../../workflows/research/agent.ts';
import type { CodexClientLike } from '../../../workflows/shared/codex.ts';
import type { ResearchInput } from '../../../workflows/research/contracts.ts';
import { ProgressReporter, type ProgressEvent } from '../../../workflows/shared/progress.ts';

const timings = {
  repository_snapshot_ms: 3,
  investigator_model_call_ms: 11,
  investigator_structured_validation_ms: 2,
  auditor_model_call_ms: 9,
  auditor_structured_validation_ms: 1,
  designer_model_call_ms: 0,
  designer_structured_validation_ms: 0,
  reviewer_model_call_ms: 0,
  reviewer_structured_validation_ms: 0,
  controller_evidence_validation_ms: 4,
};

test('Research report accepts fixed non-negative timing fields and renders them', () => {
  const report = parseResearchReport({
    protocol: 'codex-research-report/v3',
    generated_at: '2026-09-01T00:00:00.000Z',
    question: 'q',
    mode: 'understand',
    language: 'japanese',
    scope_paths: [],
    external_sources: 'none',
    repository: { head: null, dirty: false },
    answer: 'a',
    findings: [],
    rejected: [],
    unknowns: [{ question: 'u', resolution: 'r' }],
    limitations: [],
    next_step: 'complete',
    timings,
  });
  assert.equal(report.timings.investigator_model_call_ms, 11);
  assert.match(renderResearchMarkdown(report), /investigator_model_call_ms: 11/u);
});

test('Research report rejects unknown timing fields', () => {
  assert.throws(
    () =>
      parseResearchReport({
        protocol: 'codex-research-report/v3',
        generated_at: '2026-09-01T00:00:00.000Z',
        question: 'q',
        mode: 'understand',
        language: 'japanese',
        scope_paths: [],
        external_sources: 'none',
        repository: { head: null, dirty: false },
        answer: 'a',
        findings: [],
        rejected: [],
        unknowns: [{ question: 'u', resolution: 'r' }],
        limitations: [],
        next_step: 'complete',
        timings: { ...timings, extra_ms: 1 },
      }),
    /unknown key/u,
  );
});

const input: ResearchInput = {
  repo: '/tmp/repo',
  question: 'q',
  mode: 'understand',
  language: 'japanese',
  scope_paths: [],
  external_sources: 'none',
  protocol: 'codex-research-input/v1',
};
test('Research invalid structured output keeps stage and elapsed duration', async () => {
  const events: ProgressEvent[] = [];
  const client: CodexClientLike = {
    startThread: () => ({
      run: async () => ({ finalResponse: 'not json' }),
    }),
  };
  const agent = new CodexResearchAgent(
    client,
    new ProgressReporter({
      write: (line) => events.push(JSON.parse(line) as ProgressEvent),
      setInterval: () => ({}),
      clearInterval: () => undefined,
    }),
  );
  await assert.rejects(
    agent.investigate(input, [], [], input.repo),
    /research investigator structured validation failed after \d+ms/u,
  );
  assert.deepEqual(
    events.map(({ stage, status }) => [stage, status]),
    [
      ['investigator_model_call', 'started'],
      ['investigator_model_call', 'completed'],
      ['investigator_structured_validation', 'started'],
      ['investigator_structured_validation', 'failed'],
    ],
  );
});

test('Research model failure keeps model stage and elapsed duration', async () => {
  const client: CodexClientLike = {
    startThread: () => ({
      run: async () => {
        throw new Error('boom');
      },
    }),
  };
  const agent = new CodexResearchAgent(client);
  await assert.rejects(
    agent.investigate(input, [], [], input.repo),
    /research investigator model call failed after \d+ms/u,
  );
});
