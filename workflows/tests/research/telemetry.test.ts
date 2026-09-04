/** @file Outcome: Research telemetry remains typed, bounded, and diagnosable at every model boundary. */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { CodexResearchAgent } from '../../research/agent.ts';
import type { CodexClientLike } from '../../shared/codex.ts';
import type { ResearchInput } from '../../research/contracts.ts';
import { FlowError, errorCode } from '../../shared/errors.ts';
import { ProgressReporter, type ProgressEvent } from '../../shared/progress.ts';
import * as fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from '../shared/fixtures.ts';

const input: ResearchInput = {
  repo: '/tmp/repo',
  question: 'q',
  scope_paths: [],
  allow_external_sources: false,
};

function snapshotRepo(): string {
  const repo = temporaryDirectory('codex-research-telemetry-');
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(path.join(repo, '.codex/OUTCOME.md'), '# Project outcome\n\nTest.\n');
  return repo;
}
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
    agent.investigate(input, [], snapshotRepo()),
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
    agent.investigate(input, [], snapshotRepo()),
    /research investigator model call failed after \d+ms/u,
  );
});

test('Research model failure preserves the idle classification from the shared boundary', async () => {
  const client: CodexClientLike = {
    startThread: () => ({
      run: async (_prompt, options) => {
        assert.equal(options.modelRun.idleCode, 'research_investigator_idle_timeout');
        throw new FlowError('idle stream', 'research_investigator_idle_timeout');
      },
    }),
  };
  const agent = new CodexResearchAgent(client);
  await assert.rejects(agent.investigate(input, [], snapshotRepo()), (error: unknown) => {
    assert.equal(errorCode(error), 'research_investigator_idle_timeout');
    assert.match(String((error as Error).message), /idle stream/u);
    return true;
  });
});
