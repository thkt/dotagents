/** @file Outcome: Public-safety tests use controlled tracked sources and canonical production contexts. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ResearchDraft } from '../../research/contracts.ts';
import { canonicalReport } from '../../research/corpus.ts';
import { safetyContext } from '../../research/public-safety.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

export const draft: ResearchDraft = {
  answer: 'The module exports a value.',
  findings: [
    {
      statement: 'A value is exported.',
      kind: 'fact',
      confidence: 'high',
      qualification: 'Only this module was inspected.',
      evidence: [
        {
          kind: 'repository',
          source: 'value.ts',
          locator: 'L1',
          supports: 'The export declaration.',
        },
      ],
      implication: 'Consumers can import the value.',
    },
  ],
  rejected: [{ statement: 'It is configurable.', reason: 'No configuration evidence.' }],
  unknowns: [{ question: 'Is it used?', resolution: 'Inspect consumers.' }],
  limitations: ['Consumers were not evaluated.'],
};

export const reproduced =
  'The documented component retains all original values through every verified invocation before publishing evidence.';

export function sourceFixture(tracked = true, source = 'export const value = 1;\n'): string {
  const repo = temporaryDirectory('safety-repo-');
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'value.ts'), source);
  if (tracked) execFileSync('git', ['-C', repo, 'add', 'value.ts']);
  return repo;
}

export function reportContext(overrides: Partial<ResearchDraft> = {}) {
  return safetyContext(
    canonicalReport({
      protocol: 'codex-research-report',
      generated_at: '2026-09-01T00:00:00.000Z',
      question: 'What is exported?',
      scope_paths: [],
      ...draft,
      ...overrides,
      findings: (overrides.findings ?? draft.findings).map((finding) => ({
        ...finding,
        id: 'F-001',
      })),
    }),
  );
}
