/** @file Outcome: Model-authored Plans have one build-owned schema, parser, runtime value, and human view. */

import { FlowError } from '../../shared/errors.ts';
import type { ConfiguredLanguage } from '../../shared/language.ts';
import { isObject, rejectUnknownKeys, stringArray, type JsonObject } from '../../shared/schema.ts';
import { oneLine, sentenceItems } from '../../shared/text.ts';

export interface BuildPlanReference {
  kind: 'module' | 'no-module' | 'new-shape';
  reason: string | null;
  path: string | null;
  files: string[];
  instances: number;
  conventions: string[];
}

export interface BuildPlanAuthoring {
  outcome: string;
  root_cause: string | null;
  test_command: string;
  reference_module: BuildPlanReference;
  preconditions: Array<{ path: string; pattern: string | null }>;
  backlog_candidates: Array<{ summary: string }>;
  rules: Array<{ source: string; quote: string }>;
  manual_verification: string[];
  units: Array<{
    id: string;
    goal: string;
    files: string[];
    contract: string;
    tests: Array<{ id: string; name: string }>;
    seam: boolean;
  }>;
}

export const STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } } as const;
const PLAN_LABELS = {
  japanese: {
    outcome: '成果',
    rootCause: '根本原因',
    testCommand: 'テストコマンド',
    reference: '参照実装',
    path: '基準 path',
    instances: '既存 instance 数',
    file: '関連 file',
    convention: '規約',
    rules: 'ルール',
    preconditions: '前提条件',
    contract: '契約',
    acceptance: '受け入れテスト',
    manual: '手動確認',
    backlog: 'バックログ候補',
    none: 'なし。',
  },
  english: {
    outcome: 'Outcome',
    rootCause: 'Root cause',
    testCommand: 'Test command',
    reference: 'Reference module',
    path: 'path',
    instances: 'instances',
    file: 'file',
    convention: 'convention',
    rules: 'Rules',
    preconditions: 'Preconditions',
    contract: 'Contract',
    acceptance: 'Acceptance tests',
    manual: 'Manual verification',
    backlog: 'Backlog candidates',
    none: 'None.',
  },
} as const;
const REFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['module', 'no-module', 'new-shape'] },
    reason: { type: ['string', 'null'] },
    path: { type: ['string', 'null'] },
    files: STRING_ARRAY_SCHEMA,
    instances: { type: 'integer' },
    conventions: STRING_ARRAY_SCHEMA,
  },
  required: ['kind', 'reason', 'path', 'files', 'instances', 'conventions'],
  additionalProperties: false,
} as const;

export const BUILD_PLAN_AUTHORING_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string' },
    root_cause: { type: ['string', 'null'] },
    test_command: { type: 'string' },
    reference_module: REFERENCE_SCHEMA,
    preconditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, pattern: { type: ['string', 'null'] } },
        required: ['path', 'pattern'],
        additionalProperties: false,
      },
    },
    backlog_candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
    },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: { source: { type: 'string' }, quote: { type: 'string' } },
        required: ['source', 'quote'],
        additionalProperties: false,
      },
    },
    manual_verification: STRING_ARRAY_SCHEMA,
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          goal: { type: 'string' },
          files: STRING_ARRAY_SCHEMA,
          contract: { type: 'string' },
          tests: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, name: { type: 'string' } },
              required: ['id', 'name'],
              additionalProperties: false,
            },
          },
          seam: { type: 'boolean' },
        },
        required: ['id', 'goal', 'files', 'contract', 'tests', 'seam'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'outcome',
    'root_cause',
    'test_command',
    'reference_module',
    'preconditions',
    'backlog_candidates',
    'rules',
    'manual_verification',
    'units',
  ],
  additionalProperties: false,
} as const;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FlowError(`${label} must be a non-empty string`, 'execution_error');
  }
  return value.trim();
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new FlowError(`${label} must be an array of objects`, 'execution_error');
  }
  return value;
}

function parseReference(raw: unknown): BuildPlanReference {
  if (!isObject(raw))
    throw new FlowError('build plan.reference_module must be an object', 'execution_error');
  rejectUnknownKeys(
    raw,
    ['kind', 'reason', 'path', 'files', 'instances', 'conventions'],
    'build plan.reference_module',
    'execution_error',
  );
  if (!['module', 'no-module', 'new-shape'].includes(String(raw.kind))) {
    throw new FlowError('build plan.reference_module.kind is invalid', 'execution_error');
  }
  if (!Number.isInteger(raw.instances) || Number(raw.instances) < 0) {
    throw new FlowError(
      'build plan.reference_module.instances must be a non-negative integer',
      'execution_error',
    );
  }
  return {
    kind: raw.kind as BuildPlanReference['kind'],
    reason: nullableString(raw.reason, 'build plan.reference_module.reason'),
    path: nullableString(raw.path, 'build plan.reference_module.path'),
    files: stringArray(raw.files, 'build plan.reference_module.files', 'execution_error'),
    instances: Number(raw.instances),
    conventions: stringArray(
      raw.conventions,
      'build plan.reference_module.conventions',
      'execution_error',
    ),
  };
}

/** Parses model output into the only Plan shape that can enter build validation. */
export function parseBuildPlanAuthoring(raw: unknown): BuildPlanAuthoring {
  if (!isObject(raw)) throw new FlowError('build plan must be an object', 'execution_error');
  rejectUnknownKeys(
    raw,
    [
      'outcome',
      'root_cause',
      'test_command',
      'reference_module',
      'preconditions',
      'backlog_candidates',
      'rules',
      'manual_verification',
      'units',
    ],
    'build plan',
    'execution_error',
  );
  const preconditions = objectArray(raw.preconditions, 'build plan.preconditions').map(
    (item, index) => {
      const label = `build plan.preconditions[${index}]`;
      rejectUnknownKeys(item, ['path', 'pattern'], label, 'execution_error');
      return {
        path: requiredString(item.path, `${label}.path`),
        pattern: nullableString(item.pattern, `${label}.pattern`),
      };
    },
  );
  const backlogCandidates = objectArray(
    raw.backlog_candidates,
    'build plan.backlog_candidates',
  ).map((item, index) => {
    const label = `build plan.backlog_candidates[${index}]`;
    rejectUnknownKeys(item, ['summary'], label, 'execution_error');
    return { summary: requiredString(item.summary, `${label}.summary`) };
  });
  const rules = objectArray(raw.rules, 'build plan.rules').map((item, index) => {
    const label = `build plan.rules[${index}]`;
    rejectUnknownKeys(item, ['source', 'quote'], label, 'execution_error');
    return {
      source: requiredString(item.source, `${label}.source`),
      quote: requiredString(item.quote, `${label}.quote`),
    };
  });
  const units = objectArray(raw.units, 'build plan.units').map((item, index) => {
    const label = `build plan.units[${index}]`;
    rejectUnknownKeys(
      item,
      ['id', 'goal', 'files', 'contract', 'tests', 'seam'],
      label,
      'execution_error',
    );
    if (typeof item.seam !== 'boolean')
      throw new FlowError(`${label}.seam must be boolean`, 'execution_error');
    const tests = objectArray(item.tests, `${label}.tests`).map((scenario, testIndex) => {
      const testLabel = `${label}.tests[${testIndex}]`;
      rejectUnknownKeys(scenario, ['id', 'name'], testLabel, 'execution_error');
      return {
        id: requiredString(scenario.id, `${testLabel}.id`),
        name: requiredString(scenario.name, `${testLabel}.name`),
      };
    });
    return {
      id: requiredString(item.id, `${label}.id`),
      goal: requiredString(item.goal, `${label}.goal`),
      files: stringArray(item.files, `${label}.files`, 'execution_error'),
      contract: requiredString(item.contract, `${label}.contract`),
      tests,
      seam: item.seam,
    };
  });
  return {
    outcome: requiredString(raw.outcome, 'build plan.outcome'),
    root_cause: nullableString(raw.root_cause, 'build plan.root_cause'),
    test_command: requiredString(raw.test_command, 'build plan.test_command'),
    reference_module: parseReference(raw.reference_module),
    preconditions,
    backlog_candidates: backlogCandidates,
    rules,
    manual_verification: stringArray(
      raw.manual_verification,
      'build plan.manual_verification',
      'execution_error',
    ),
    units,
  };
}

/** Removes nullable authoring fields so the value matches build's exact Plan contract. */
export function buildPlanValue(plan: BuildPlanAuthoring) {
  const reference = plan.reference_module;
  return {
    outcome: plan.outcome,
    ...(plan.root_cause === null ? {} : { root_cause: plan.root_cause }),
    test_command: plan.test_command,
    reference_module: {
      kind: reference.kind,
      ...(reference.reason === null ? {} : { reason: reference.reason }),
      ...(reference.path === null ? {} : { path: reference.path }),
      files: reference.files,
      instances: reference.instances,
      conventions: reference.conventions,
    },
    preconditions: plan.preconditions.map((item) => ({
      path: item.path,
      ...(item.pattern === null ? {} : { pattern: item.pattern }),
    })),
    backlog_candidates: plan.backlog_candidates,
    rules: plan.rules,
    manual_verification: plan.manual_verification,
    units: plan.units,
  };
}

function labeledItems(label: string, value: string): string[] {
  return [`- ${label}:`, ...sentenceItems(value).map((item) => `  - ${item}`)];
}

/** Renders the exact human Plan that the structured value describes. */
export function renderPlanMarkdown(
  plan: BuildPlanAuthoring,
  language: ConfiguredLanguage = 'english',
): string {
  const reference = plan.reference_module;
  const labels = PLAN_LABELS[language];
  const lines = [
    '## Plan',
    '',
    ...labeledItems(labels.outcome, plan.outcome),
    ...(plan.root_cause === null ? [] : labeledItems(labels.rootCause, plan.root_cause)),
    `- ${labels.testCommand}: \`${plan.test_command}\``,
    `- ${labels.reference}: ${reference.kind}${reference.reason === null ? '' : ` — ${oneLine(reference.reason)}`}`,
    '',
  ];
  if (reference.kind === 'module') {
    lines.push(
      `### ${labels.reference}`,
      '',
      `- ${labels.path}: \`${reference.path}\``,
      `- ${labels.instances}: ${reference.instances}`,
      ...reference.files.map((file) => `- ${labels.file}: \`${file}\``),
      ...reference.conventions.map((item) => `- ${labels.convention}: ${oneLine(item)}`),
      '',
    );
  }
  if (plan.rules.length) {
    lines.push(
      `### ${labels.rules}`,
      '',
      ...plan.rules.map((rule) => `- \`${rule.source}\`: ${oneLine(rule.quote)}`),
      '',
    );
  }
  if (plan.preconditions.length) {
    lines.push(
      `### ${labels.preconditions}`,
      '',
      ...plan.preconditions.map(
        (item) =>
          `- \`${item.path}\`${item.pattern === null ? '' : ` \`${oneLine(item.pattern)}\``}`,
      ),
      '',
    );
  }
  for (const unit of plan.units) {
    lines.push(
      `### ${unit.id}`,
      '',
      oneLine(unit.goal),
      '',
      `- files: ${unit.files.map((file) => `\`${file}\``).join(', ')}`,
      ...labeledItems(labels.contract, unit.contract),
      ...(unit.seam ? ['- seam: true'] : []),
      '',
    );
    if (unit.tests.length) {
      lines.push(
        `${labels.acceptance}.`,
        '',
        ...unit.tests.map((test) => `- ${test.id} ${oneLine(test.name)}`),
        '',
      );
    }
  }
  if (plan.manual_verification.length) {
    lines.push(
      `### ${labels.manual}`,
      '',
      ...plan.manual_verification.map((item) => `- ${oneLine(item)}`),
      '',
    );
  }
  lines.push(
    `## ${labels.backlog}`,
    '',
    ...(plan.backlog_candidates.length
      ? plan.backlog_candidates.map((item) => `- ${oneLine(item.summary)}`)
      : [`- ${labels.none}`]),
  );
  return `${lines.join('\n')}\n`;
}
