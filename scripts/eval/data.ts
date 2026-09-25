import assert from 'node:assert/strict';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const name = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const file = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine(
    (value) => value.split('/').every((part) => part !== '.' && part !== '..'),
    'Canonical relative file path required',
  );
const positive = z.number().int().positive();
export const evalConfig = z.strictObject({
  repository: z.literal('thkt/dotagents'),
  issue: z.string().regex(/^https:\/\/github\.com\/thkt\/dotagents\/(issues|pull)\/\d+$/),
  before: sha,
  after: sha,
  corpusCommit: sha,
  workspaceCommit: sha,
  // Explicit public file lists, never the caller's working tree or Git history.
  workspaceFiles: z.array(file).nonempty(),
  instructionFiles: z.array(file).nonempty(),
  cases: z.array(name).nonempty(),
  image: z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/),
  imageReview: z.string().min(1),
  model: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  reasoning: z.enum(['low', 'medium', 'high', 'xhigh']),
  cliVersion: z.string().min(1),
  bunVersion: z.string().min(1),
  gitVersion: z.string().min(1),
  caseTimeMs: positive.max(3600000),
  totalTimeMs: positive.max(43200000),
  maxModelRequestsPerCase: positive.max(1000),
  maxOutputTokens: positive.max(100000),
  maxTrials: positive,
  outputDirectory: z.string().min(1),
  disclosure: z.strictObject({
    inputs: z.literal('reviewed-public-committed-files-only'),
    raw: z.literal('local-only'),
    summary: z.literal('manual-issue-or-pr'),
  }),
});
export type EvalConfig = z.infer<typeof evalConfig>;
export const evalCase = z.strictObject({
  id: name,
  source: z.string().url(),
  prompt: z.string().min(1),
  expected: z.enum(['scoping', 'implement', 'none', 'boundary']),
  criteria: z.array(z.string().min(1)).nonempty(),
  context: z
    .strictObject({
      body: z.string().min(1),
    })
    .optional(),
});
export type EvalCase = z.infer<typeof evalCase>;

export function validatePlan(config: EvalConfig, cases: EvalCase[]) {
  assert(new Set(config.cases).size === config.cases.length, 'Duplicate case');
  const selected = config.cases.map((id) => {
    const item = cases.find((item) => item.id === id);
    assert(item, `Unknown case: ${id}`);
    return item;
  });
  assert(config.before !== config.after, 'Different instruction commits required');
  assert(config.maxTrials === selected.length * 2, 'Exactly one trial per side and case required');
  assert(config.totalTimeMs >= config.caseTimeMs, 'Total time must allow one case');
  const paths = [...config.workspaceFiles, ...config.instructionFiles];
  assert(new Set(paths).size === paths.length, 'File lists overlap or contain duplicates');
  for (const path of paths) {
    assert(path !== 'evaluation-issue.json', 'Reserved case context path');
    assert(
      !path.includes('skill-eval') &&
        !path.startsWith('scripts/eval/') &&
        !path.includes('comparison'),
      'Cannot expose host-only evaluation files',
    );
    assert(!/^(evals|\.git|\.agents)(\/|$)/.test(path), 'Cannot expose host-only files');
    assert(
      !/(^|\/)(auth\.json|config\.toml|\.env[^/]*|credentials)(\/|$)/.test(path),
      'Cannot expose credentials or local settings',
    );
  }
  for (const path of config.instructionFiles) {
    assert(
      /(^|\/)AGENTS\.md$/.test(path) || /^skills\/(scoping|implement)\//.test(path),
      'Unsupported instruction file',
    );
  }
  for (const path of ['AGENTS.md', 'skills/scoping/SKILL.md', 'skills/implement/SKILL.md']) {
    assert(config.instructionFiles.includes(path), `Missing effective instruction: ${path}`);
  }
  return selected;
}
