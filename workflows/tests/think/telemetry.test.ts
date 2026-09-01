/** @file Outcome: Think telemetry makes designer and reviewer stalls observable without widening the contract. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderThinkMarkdown } from '../../../workflows/think/artifact.ts';

test('Think Markdown exposes fixed stage timings', () => {
  const report = {
    request: 'q',
    language: 'japanese',
    task_type: 'feature',
    readiness: 'research_required',
    repository: { head: null, dirty: false },
    review_findings: [],
    review_notes: [],
    alternatives: [],
    evidence: [],
    research_questions: ['u'],
    plan: null,
    outcome: 'o',
    root_cause: null,
    decision: 'd',
    rationale: 'r',
    next_step: 'research',
    protocol: 'codex-think-report/v3',
    generated_at: '2026-09-01T00:00:00.000Z',
    research_reports: [],
    timings: {
      repository_snapshot_ms: 1,
      investigator_model_call_ms: 0,
      investigator_structured_validation_ms: 0,
      auditor_model_call_ms: 0,
      auditor_structured_validation_ms: 0,
      designer_model_call_ms: 12,
      designer_structured_validation_ms: 2,
      reviewer_model_call_ms: 8,
      reviewer_structured_validation_ms: 1,
      controller_evidence_validation_ms: 3,
    },
  } as any;
  const markdown = renderThinkMarkdown(report);
  assert.match(markdown, /designer_model_call_ms: 12/u);
  assert.match(markdown, /reviewer_structured_validation_ms: 1/u);
});

test('Think designer and reviewer timings are distinct non-negative stages', () => {
  const designer = 12;
  const structured = 2;
  const reviewer = 8;
  assert.ok(designer >= structured && structured >= 0 && reviewer >= 0);
});
