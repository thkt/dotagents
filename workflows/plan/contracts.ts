/** @file Outcome: A public Plan contains only the information needed to implement and verify an Issue. */

import { FlowError } from '../shared/errors.ts';
import {
  isObject,
  objectArray,
  rejectUnknownKeys,
  requiredString,
  stringArray,
} from '../shared/schema.ts';
import { oneLine, sentenceItems } from '../shared/text.ts';
import { NON_BLANK_STRING_SCHEMA } from '../shared/structured-output.ts';

/** Shared decision boundary for Plan authors, implementers, and reviewers. */
export const PLAN_DECISION_GUIDANCE =
  'A Plan fixes observable behavior, authorized edit scope, required external or persisted compatibility, safety conditions, and acceptance evidence. Specify exact internal names, types, fields, formats, or algorithms only when a stated compatibility or safety requirement depends on them. Otherwise the implementation owner chooses internal types, record layouts, functions, APIs, and algorithms within scope. Unspecified implementation choices are not missing facts; do not invent hidden compatibility requirements. Preserve requirements established by the authorized contract and current repository evidence.';

export interface BuildPlanAuthoring {
  outcome: string;
  test_command: string;
  units: Array<{
    goal: string;
    files: string[];
    contract: string;
    tests: string[];
  }>;
}

export const BUILD_PLAN_AUTHORING_SCHEMA = {
  type: 'object',
  properties: {
    outcome: NON_BLANK_STRING_SCHEMA,
    test_command: NON_BLANK_STRING_SCHEMA,
    units: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          goal: NON_BLANK_STRING_SCHEMA,
          files: { type: 'array', minItems: 1, items: NON_BLANK_STRING_SCHEMA },
          contract: NON_BLANK_STRING_SCHEMA,
          tests: { type: 'array', minItems: 1, items: NON_BLANK_STRING_SCHEMA },
        },
        required: ['goal', 'files', 'contract', 'tests'],
        additionalProperties: false,
      },
    },
  },
  required: ['outcome', 'test_command', 'units'],
  additionalProperties: false,
} as const;

export function parseBuildPlanAuthoring(raw: unknown): BuildPlanAuthoring {
  if (!isObject(raw)) throw new FlowError('build plan must be an object', 'execution_error');
  rejectUnknownKeys(raw, ['outcome', 'test_command', 'units'], 'build plan', 'execution_error');
  const units = objectArray(raw.units, 'build plan.units').map((item, index) => {
    const label = `build plan.units[${index}]`;
    rejectUnknownKeys(item, ['goal', 'files', 'contract', 'tests'], label, 'execution_error');
    return {
      goal: requiredString(item.goal, `${label}.goal`, 'execution_error'),
      files: stringArray(item.files, `${label}.files`, 'execution_error'),
      contract: requiredString(item.contract, `${label}.contract`, 'execution_error'),
      tests: stringArray(item.tests, `${label}.tests`, 'execution_error'),
    };
  });
  return {
    outcome: requiredString(raw.outcome, 'build plan.outcome', 'execution_error'),
    test_command: requiredString(raw.test_command, 'build plan.test_command', 'execution_error'),
    units,
  };
}

function labeledItems(label: string, value: string): string[] {
  return [`- ${label}:`, ...sentenceItems(value).map((item) => `  - ${item}`)];
}

export function renderPlanMarkdown(plan: BuildPlanAuthoring): string {
  const labels = {
    outcome: 'Outcome',
    test: 'Test command',
    contract: 'Contract',
    acceptance: 'Acceptance',
  };
  const lines = [
    '## Plan',
    '',
    ...labeledItems(labels.outcome, plan.outcome),
    `- ${labels.test}: \`${plan.test_command}\``,
    '',
  ];
  for (const [index, unit] of plan.units.entries()) {
    lines.push(
      `### ${index + 1}. ${oneLine(unit.goal)}`,
      '',
      `- files: ${unit.files.map((file) => `\`${file}\``).join(', ')}`,
      ...labeledItems(labels.contract, unit.contract),
      `- ${labels.acceptance}:`,
      ...unit.tests.map((test) => `  - ${oneLine(test)}`),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}
