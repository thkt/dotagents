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
  trialOrder: z.array(z.string().regex(/^(before|after)-[a-z0-9-]+$/)).optional(),
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
  actor: z.literal('initial-implementation').optional(),
  check: z.array(z.string().min(1)).nonempty().optional(),
  context: z
    .strictObject({
      body: z.string().min(1),
    })
    .optional(),
});
export type EvalCase = z.infer<typeof evalCase>;

const behaviorCases = [
  'storage-fields',
  'completion-message',
  'retry-limit',
  'guide-link',
  'work-area',
  'cli-description',
  'history-record',
  'save-diagnostics',
];

function validateBehaviorSuite(config: EvalConfig, selected: EvalCase[]) {
  if (!selected.some((item) => behaviorCases.includes(item.id))) {
    return;
  }
  assert(
    selected.length === 8 && behaviorCases.every((id) => config.cases.includes(id)),
    'Behavior cases must remain separate from the five selection cases',
  );
  assert(config.trialOrder, 'Behavior cases require the fixed paired order');
  for (const path of [
    'AGENTS.md',
    'README.md',
    'scripts/README.md',
    'docs/wiki/development-policy.md',
    'skills/scoping/SKILL.md',
    'skills/scoping/references/sufficiency.md',
    'skills/scoping/references/experiment.md',
    'skills/scoping/references/session.md',
    'skills/scoping/references/issue.md',
    'skills/implement/SKILL.md',
    'skills/implement/references/testing.md',
    'skills/references/documents.md',
    'skills/references/natural-japanese.md',
    'skills/references/premise-validation.md',
    'skills/references/caller-first-design.md',
    'skills/references/mechanization.md',
  ]) {
    assert(config.instructionFiles.includes(path), `Missing behavior instruction: ${path}`);
  }
  assert(
    config.before === 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092' &&
      config.after === '6181233d17a29c711a84f20549f78507c5c3e5fb',
    'Behavior instruction versions are fixed',
  );
  assert(
    config.workspaceFiles.every((path) => path.startsWith('fixtures/workspace/')),
    'Behavior workspace must contain only the public task files',
  );
  assert(config.bunVersion === '1.4.3', 'Behavior evaluation requires Bun 1.4.3');
  for (const item of selected) {
    const implementation = [
      'completion-message',
      'guide-link',
      'work-area',
      'save-diagnostics',
    ].includes(item.id);
    assert(implementation === (item.actor === 'initial-implementation'), 'Incorrect actor stage');
    assert(item.expected === (implementation ? 'implement' : 'scoping'), 'Incorrect task stage');
  }
}

export function validatePlan(config: EvalConfig, cases: EvalCase[]) {
  assert(new Set(config.cases).size === config.cases.length, 'Duplicate case');
  assert(new Set(cases.map((item) => item.id)).size === cases.length, 'Duplicate corpus case');
  const selected = config.cases.map((id) => {
    const item = cases.find((item) => item.id === id);
    assert(item, `Unknown case: ${id}`);
    return item;
  });
  validateBehaviorSuite(config, selected);
  assert(config.before !== config.after, 'Different instruction commits required');
  assert(config.maxTrials === selected.length * 2, 'Exactly one trial per side and case required');
  assert(config.totalTimeMs >= config.caseTimeMs, 'Total time must allow one case');
  if (config.trialOrder) {
    const expected = selected.flatMap((item) => [`before-${item.id}`, `after-${item.id}`]);
    assert(
      selected.length === 8 && config.maxTrials === 16,
      'Explicit order requires eight paired cases',
    );
    assert(
      config.trialOrder.length === 16 &&
        new Set(config.trialOrder).size === 16 &&
        config.trialOrder.every((trial) => expected.includes(trial)),
      'Invalid trial order',
    );
    let beforeFirst = 0;
    for (let index = 0; index < 16; index += 2) {
      const first: string | undefined = config.trialOrder[index];
      const second: string | undefined = config.trialOrder[index + 1];
      assert(
        first &&
          second &&
          first.slice(first.indexOf('-')) === second.slice(second.indexOf('-')) &&
          first.startsWith('before-') !== second.startsWith('before-'),
        'Cases must be adjacent pairs',
      );
      beforeFirst += Number(first.startsWith('before-'));
    }
    assert(beforeFirst === 4, 'Four pairs per order required');
    assert(
      config.caseTimeMs <= 600000 &&
        config.totalTimeMs <= 9600000 &&
        config.maxModelRequestsPerCase <= 20 &&
        config.maxOutputTokens <= 8000,
      'Eight-case limits exceeded',
    );
  }
  const paths = [...config.workspaceFiles, ...config.instructionFiles];
  assert(new Set(paths).size === paths.length, 'File lists overlap or contain duplicates');
  for (const path of paths) {
    assert(!path.startsWith('actor-records/'), 'Reserved actor record path');
    assert(path !== 'evaluation-issue.json', 'Reserved case context path');
    assert(
      !(config.workspaceFiles.includes(path) && path.startsWith('scripts/tests/')),
      'Cannot expose host-only tests or answers',
    );
    assert(
      !(config.workspaceFiles.includes(path) && /^scripts\/implement\/.+\.ts$/.test(path)),
      'Cannot move trusted actor code into the task workspace',
    );
    assert(!path.startsWith('scripts/eval/'), 'Cannot expose host-only evaluation files');
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
  return selected;
}
