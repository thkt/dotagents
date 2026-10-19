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
export const inputConfig = z.strictObject({
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
  model: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  reasoning: z.enum(['low', 'medium', 'high', 'xhigh']),
  cliVersion: z.string().min(1),
  bunVersion: z.string().min(1),
  gitVersion: z.string().min(1),
  caseTimeMs: positive.max(3600000),
  totalTimeMs: positive.max(43200000),
  maxTrials: positive,
  outputDirectory: z.string().min(1),
  trialOrder: z.array(z.string().regex(/^(before|after)-[a-z0-9-]+$/)).optional(),
  disclosure: z.strictObject({
    // 旧値も固定課題入力の宣言としてのみ読む。全送信入力の保証ではない。
    inputs: z.enum([
      'reviewed-public-committed-files-only',
      'fixed-public-inputs-with-common-context',
    ]),
    raw: z.literal('local-only'),
    summary: z.literal('manual-issue-or-pr'),
  }),
});
export type InputConfig = z.infer<typeof inputConfig>;
export const evalCase = z.strictObject({
  id: name,
  source: z.string().url(),
  prompt: z.string().min(1),
  expected: z.enum(['scoping', 'implement', 'none', 'boundary']),
  criteria: z.array(z.string().min(1)).nonempty(),
  actor: z.literal('initial-implementation').optional(),
  check: z.array(z.string().min(1)).nonempty().optional(),
  context: z
    .strictObject({
      body: z.string().min(1),
    })
    .optional(),
});
export type EvalCase = z.infer<typeof evalCase>;

export function validateInputFiles(
  config: Pick<InputConfig, 'workspaceFiles' | 'instructionFiles'>,
) {
  const paths = [...config.workspaceFiles, ...config.instructionFiles];
  assert(new Set(paths).size === paths.length, 'File lists overlap or contain duplicates');
  for (const path of paths) {
    assert(!path.startsWith('actor-records/'), 'Reserved actor record path');
    assert(path !== 'evaluation-issue.json', 'Reserved case context path');
    assert(
      !path.startsWith('scripts/tests/'),
      'Unsupported instruction or workspace file: host-only tests or answers',
    );
    assert(
      !(config.workspaceFiles.includes(path) && /^scripts\/implement\/.+\.ts$/.test(path)),
      'Cannot move trusted actor code into the task workspace',
    );
    assert(!path.startsWith('scripts/eval/'), 'Cannot expose host-only evaluation files');
    assert(
      !path.startsWith('eval/') ||
        (config.workspaceFiles.includes(path) && path.startsWith('eval/fixtures/workspace/')),
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
      /(^|\/)AGENTS\.md$/.test(path) ||
        /^skills\/(scoping|implement)\//.test(path) ||
        /^skills\/references\/.+\.md$/.test(path) ||
        [
          'README.md',
          'scripts/README.md',
          'docs/wiki/development-policy.md',
          'skills/templates/wiki.md',
          'skills/templates/decision.md',
        ].includes(path),
      'Unsupported instruction file',
    );
  }
  for (const path of ['AGENTS.md', 'skills/scoping/SKILL.md', 'skills/implement/SKILL.md']) {
    assert(config.instructionFiles.includes(path), `Missing effective instruction: ${path}`);
  }
}
