#!/usr/bin/env bun
/** @file Outcome: Only closed, traceable, and safely executable build Plans enter the workflow. */

import {
  cli,
  isObject,
  nonEmptyString,
  parseSingletonArgs,
  readJsonFile,
  safeRepoPath,
  stringValue,
  type JsonObject,
  usageError,
} from './cli.ts';
import type { StructuredGateResult } from '../contracts.ts';
import { SHELL_CONTROL, shellWords } from '../../shared/command.ts';
import { isMainModule } from '../../shared/environment.ts';
import { SCREENSHOT_CAP, safeScreenshotName } from './screenshot-contract.ts';

const PROTOCOL = 'codex-build-plan';
const DESCRIPTION_PROTOCOL = 'codex-build-plan-description';
const UNIT_CAPS = { files: 3, tests: 4 } as const;
const UNIT_ID_TEXT = String.raw`U-\d{3}`;
const TEST_ID_TEXT = String.raw`T-[A-Z]*\d{3}`;
const UNIT_ID = new RegExp(`^${UNIT_ID_TEXT}$`, 'u');
const TEST_ID = new RegExp(`^${TEST_ID_TEXT}$`, 'u');
const SOURCE_LOCATION_SUFFIX = /(?::L?\d+(?:-L?\d+)?|#L\d+(?:-L\d+)?)$/u;
const SEAM_TESTED_UNIT_THRESHOLD = 2;
const PLAN_REPO_PATH_FIELDS = [
  'plan.reference_module.path',
  'plan.reference_module.files[]',
  'plan.preconditions[].path',
  'plan.rules[].source',
  'plan.units[].files[]',
] as const;
const PLAN_KEYS = new Set([
  'outcome',
  'test_command',
  'root_cause',
  'reference_module',
  'preconditions',
  'backlog_candidates',
  'rules',
  'manual_verification',
  'screenshots',
  'units',
]);
const INPUT_KEYS = new Set(['issue', 'title', 'body', 'plan']);
const REFERENCE_KEYS = new Set(['kind', 'reason', 'path', 'files', 'instances', 'conventions']);
const PRECONDITION_KEYS = new Set(['path', 'pattern']);
const BACKLOG_KEYS = new Set(['summary']);
const RULE_KEYS = new Set(['source', 'quote']);
const SCREENSHOT_KEYS = new Set(['name', 'alt']);
const UNIT_KEYS = new Set(['id', 'goal', 'files', 'contract', 'tests', 'seam']);
const TEST_KEYS = new Set(['id', 'name']);

interface ExtractionMismatch {
  units_missing: string[];
  units_extra: string[];
  tests_missing: string[];
  tests_extra: string[];
}

interface UnitValidation {
  unitIds: Set<string>;
  testIds: Set<string>;
  oversized: string[];
  testedUnits: number;
  seamUnits: number;
}

interface PlanValidationReport extends StructuredGateResult {
  protocol: typeof PROTOCOL;
  verdict: 'pass' | 'fail';
  classification: string;
  reason_codes: string[];
  failure_route: 'blocked' | null;
  blockers: string[];
  mismatch: ExtractionMismatch;
  oversized_units: string[];
  counts: { units: number; tests: number };
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  label: string,
  blockers: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) blockers.push(`${label} has an unknown key: ${key}`);
  }
}

function singleCommand(value: unknown): value is string {
  return nonEmptyString(value) && !value.includes('\0') && !SHELL_CONTROL.test(value);
}

function invokesGitHubCli(command: string): boolean {
  return shellWords(command).some((word) => /(?:^|[\\/])gh$/u.test(word));
}

function planRepoPath(value: unknown): value is string {
  return safeRepoPath(value) && !SOURCE_LOCATION_SUFFIX.test(value);
}

function definitionIds(planSection: string, pattern: RegExp): Set<string> {
  return new Set([...planSection.matchAll(pattern)].map((match) => match[1]!));
}

function extractPlanSection(body: string): string | null {
  const heading = body.match(/^##\s+Plan\b.*$/m);
  if (!heading) return null;
  const after = body.slice((heading.index ?? 0) + heading[0].length);
  const next = after.search(/^##[^#]/m);
  return next === -1 ? after : after.slice(0, next);
}

function validateReferenceModule(reference: unknown, blockers: string[]): void {
  if (!isObject(reference)) {
    blockers.push('reference_module must be an object with kind and reason/path');
    return;
  }
  rejectUnknownKeys(reference, REFERENCE_KEYS, 'reference_module', blockers);
  if (
    typeof reference.kind !== 'string' ||
    !['module', 'no-module', 'new-shape'].includes(reference.kind)
  ) {
    blockers.push('reference_module.kind is invalid');
  } else if (reference.kind === 'module') {
    if (!planRepoPath(reference.path)) blockers.push('reference_module.path is invalid');
  } else if (!nonEmptyString(reference.reason)) {
    blockers.push(`reference_module.reason is empty while kind is ${reference.kind}`);
  }
  if (reference.files !== undefined && !Array.isArray(reference.files)) {
    blockers.push('reference_module.files must be an array');
  } else {
    for (const file of reference.files || []) {
      if (!planRepoPath(file)) blockers.push(`reference_module file is invalid: ${file}`);
    }
  }
  if (
    reference.instances !== undefined &&
    (!Number.isInteger(reference.instances) || Number(reference.instances) < 0)
  ) {
    blockers.push('reference_module.instances must be a non-negative integer');
  }
  if (
    reference.conventions !== undefined &&
    (!Array.isArray(reference.conventions) ||
      reference.conventions.some((item: unknown) => !nonEmptyString(item)))
  ) {
    blockers.push('reference_module.conventions must contain non-empty strings');
  }
}

function validatePreconditions(value: unknown, blockers: string[]): void {
  if (!Array.isArray(value)) {
    blockers.push('preconditions must be an array');
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) {
      blockers.push(`preconditions[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(entry, PRECONDITION_KEYS, `preconditions[${index}]`, blockers);
    if (!planRepoPath(entry.path)) blockers.push(`preconditions[${index}].path is invalid`);
    if (entry.pattern !== undefined && typeof entry.pattern !== 'string') {
      blockers.push(`preconditions[${index}].pattern must be a string`);
    }
  }
}

function validateBacklogCandidates(value: unknown, blockers: string[]): void {
  if (!Array.isArray(value)) {
    blockers.push('backlog_candidates must be an array');
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) {
      blockers.push(`backlog_candidates[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(entry, BACKLOG_KEYS, `backlog_candidates[${index}]`, blockers);
    if (!nonEmptyString(entry.summary))
      blockers.push(`backlog_candidates[${index}].summary is empty`);
  }
}

function validateRules(value: unknown, blockers: string[]): void {
  if (!Array.isArray(value)) {
    blockers.push('rules must be an array');
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) {
      blockers.push(`rules[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(entry, RULE_KEYS, `rules[${index}]`, blockers);
    if (!planRepoPath(entry.source)) blockers.push(`rules[${index}].source is invalid`);
    if (!nonEmptyString(entry.quote)) blockers.push(`rules[${index}].quote is empty`);
  }
}

function validateScreenshots(value: unknown, blockers: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    blockers.push('screenshots must be an array');
    return;
  }
  if (value.length > SCREENSHOT_CAP) {
    blockers.push(`screenshots may contain at most ${SCREENSHOT_CAP} items`);
  }
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) {
      blockers.push(`screenshots[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(entry, SCREENSHOT_KEYS, `screenshots[${index}]`, blockers);
    if (!safeScreenshotName(entry.name)) {
      blockers.push(`screenshots[${index}].name must be a safe image filename`);
    } else if (names.has(entry.name.toLowerCase())) {
      blockers.push(`duplicate screenshot name ${entry.name}`);
    } else {
      names.add(entry.name.toLowerCase());
    }
    if (!nonEmptyString(entry.alt)) blockers.push(`screenshots[${index}].alt is empty`);
  }
}

function validateUnits(units: readonly unknown[], blockers: string[]): UnitValidation {
  const unitIds = new Set<string>();
  const testIds = new Set<string>();
  const oversized: string[] = [];
  let testedUnits = 0;
  let seamUnits = 0;

  for (const [index, unit] of units.entries()) {
    if (!isObject(unit)) {
      blockers.push(`units[${index}] must be an object`);
      continue;
    }
    const unitId = stringValue(unit.id, `units[${index}]`);
    rejectUnknownKeys(unit, UNIT_KEYS, unitId, blockers);
    if (!UNIT_ID.test(unitId)) blockers.push(`${unitId} has an invalid id`);
    if (unitIds.has(unitId)) blockers.push(`duplicate unit id ${unitId}`);
    unitIds.add(unitId);
    if (!nonEmptyString(unit.goal)) blockers.push(`${unitId} has an empty goal`);
    if (!nonEmptyString(unit.contract)) blockers.push(`${unitId} has an empty contract`);
    if (typeof unit.seam !== 'boolean') blockers.push(`${unitId}.seam must be boolean`);
    if (!Array.isArray(unit.files) || !unit.files.length) {
      blockers.push(`${unitId} has no target files`);
    } else {
      const seenFiles = new Set<unknown>();
      for (const file of unit.files) {
        if (!planRepoPath(file)) blockers.push(`${unitId} has an invalid file: ${file}`);
        if (seenFiles.has(file)) blockers.push(`${unitId} has a duplicate file: ${file}`);
        seenFiles.add(file);
      }
    }
    if (!Array.isArray(unit.tests)) {
      blockers.push(`${unitId}.tests must be an array`);
      continue;
    }
    if (unit.tests.length) testedUnits += 1;
    if (unit.seam === true) seamUnits += 1;
    for (const [testIndex, scenario] of unit.tests.entries()) {
      if (!isObject(scenario)) {
        blockers.push(`${unitId}.tests[${testIndex}] must be an object`);
        continue;
      }
      const testId = stringValue(scenario.id, `${unitId}.tests[${testIndex}]`);
      rejectUnknownKeys(scenario, TEST_KEYS, testId, blockers);
      if (!TEST_ID.test(testId)) blockers.push(`${testId} has an invalid id`);
      if (testIds.has(testId)) blockers.push(`duplicate test id ${testId}`);
      testIds.add(testId);
      if (!nonEmptyString(scenario.name)) blockers.push(`${testId} has an empty name`);
    }
    if (
      unit.seam !== true &&
      ((Array.isArray(unit.files) ? unit.files.length : 0) > UNIT_CAPS.files ||
        unit.tests.length > UNIT_CAPS.tests)
    ) {
      oversized.push(unitId);
    }
  }
  return { unitIds, testIds, oversized, testedUnits, seamUnits };
}

function compareExtractedIds(
  planSection: string,
  unitIds: ReadonlySet<string>,
  testIds: ReadonlySet<string>,
): ExtractionMismatch {
  const bodyUnitIds = definitionIds(planSection, new RegExp(`^###\\s+(${UNIT_ID_TEXT})\\b`, 'gm'));
  const bodyTestIds = definitionIds(
    planSection,
    new RegExp(`^[ \\t]*[-*+][ \\t]+(${TEST_ID_TEXT})\\b`, 'gm'),
  );
  return {
    units_missing: [...bodyUnitIds].filter((id) => !unitIds.has(id)),
    units_extra: [...unitIds].filter((id) => !bodyUnitIds.has(id)),
    tests_missing: [...bodyTestIds].filter((id) => !testIds.has(id)),
    tests_extra: [...testIds].filter((id) => !bodyTestIds.has(id)),
  };
}

/** Validates an untrusted issue Plan into a closed, traceable build contract. */
export function validatePlan(input: unknown): PlanValidationReport {
  if (!isObject(input)) throw usageError('input must be a JSON object');
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const plan = input.plan;
  if (!body.trim()) throw usageError('input.body must be a non-empty string');
  if (!isObject(plan)) throw usageError('input.plan must be an object');

  const planSection = extractPlanSection(body);
  if (planSection === null) {
    return {
      protocol: PROTOCOL,
      verdict: 'fail',
      classification: 'no-plan',
      reason_codes: ['no_plan'],
      failure_route: 'blocked',
      blockers: ['issue body has no ## Plan section'],
      mismatch: { units_missing: [], units_extra: [], tests_missing: [], tests_extra: [] },
      oversized_units: [],
      counts: { units: 0, tests: 0 },
    };
  }

  const blockers: string[] = [];
  rejectUnknownKeys(input, INPUT_KEYS, 'input', blockers);
  if (!Number.isInteger(input.issue) || Number(input.issue) < 1)
    blockers.push('issue must be a positive integer');
  if (!nonEmptyString(title)) blockers.push('title is empty');
  const units: unknown[] = Array.isArray(plan.units) ? plan.units : [];
  rejectUnknownKeys(plan, PLAN_KEYS, 'plan', blockers);
  if (!nonEmptyString(plan.outcome)) blockers.push('outcome is empty');
  if (!nonEmptyString(plan.test_command)) {
    blockers.push('test_command is empty');
  } else if (!singleCommand(plan.test_command)) {
    blockers.push('test_command must be one command without shell control operators');
  } else if (invokesGitHubCli(plan.test_command)) {
    blockers.push('test_command may not invoke GitHub CLI');
  }
  if (!units.length) blockers.push('units is empty');
  if (plan.root_cause !== undefined && typeof plan.root_cause !== 'string') {
    blockers.push('root_cause must be a string when present');
  }
  if (/^\[(?:Bug|バグ)\]/u.test(title) && !nonEmptyString(plan.root_cause)) {
    blockers.push('root_cause is empty on a bug issue');
  }

  validateReferenceModule(plan.reference_module, blockers);
  validatePreconditions(plan.preconditions, blockers);
  validateBacklogCandidates(plan.backlog_candidates, blockers);
  validateRules(plan.rules, blockers);
  validateScreenshots(plan.screenshots, blockers);
  if (
    !Array.isArray(plan.manual_verification) ||
    plan.manual_verification.some((item) => !nonEmptyString(item))
  ) {
    blockers.push('manual_verification must contain non-empty strings');
  }
  const { unitIds, testIds, oversized, testedUnits, seamUnits } = validateUnits(units, blockers);
  if (testedUnits >= SEAM_TESTED_UNIT_THRESHOLD && seamUnits === 0)
    blockers.push('two or more tested units require a seam unit');
  const mismatch = compareExtractedIds(planSection, unitIds, testIds);
  const hasMismatch = Object.values(mismatch).some((items) => items.length);

  const reasonCodes: string[] = [];
  if (blockers.length) reasonCodes.push('invalid_plan');
  if (hasMismatch) reasonCodes.push('extraction_mismatch');
  if (oversized.length) reasonCodes.push('oversized_unit');
  return {
    protocol: PROTOCOL,
    verdict: reasonCodes.length ? 'fail' : 'pass',
    classification: reasonCodes[0] || 'pass',
    reason_codes: reasonCodes,
    failure_route: reasonCodes.length ? 'blocked' : null,
    blockers,
    mismatch,
    oversized_units: oversized,
    counts: { units: unitIds.size, tests: testIds.size },
  };
}

export function describe() {
  const inputTemplate = {
    issue: 123,
    title: 'Feature',
    body: '## Plan\n### U-001 unit\n- T-001 scenario',
    plan: {
      outcome: 'observable done state',
      test_command: 'repository-test-command',
      reference_module: {
        kind: 'no-module',
        reason: 'issue-authored reason',
        files: [],
        instances: 0,
        conventions: [],
      },
      preconditions: [],
      backlog_candidates: [],
      rules: [],
      manual_verification: [],
      screenshots: [],
      units: [
        {
          id: 'U-001',
          goal: 'observable unit behavior',
          files: ['path/to/file'],
          contract: 'cited source plus intent',
          tests: [{ id: 'T-001', name: 'condition and expected result' }],
          seam: false,
        },
      ],
    },
  };
  return {
    protocol: DESCRIPTION_PROTOCOL,
    validates_with: PROTOCOL,
    command: 'codex-build-plan describe' as const,
    input_template: inputTemplate,
    plan_keys: [...PLAN_KEYS],
    unit_caps: UNIT_CAPS,
    constraints: {
      ids: {
        unit: { pattern: UNIT_ID.source, uniqueness: 'plan-wide' },
        test: { pattern: TEST_ID.source, uniqueness: 'plan-wide' },
      },
      repository_paths: {
        fields: [...PLAN_REPO_PATH_FIELDS],
        format: 'bare-repository-relative-path',
        allow_source_location_suffix: false,
      },
      seam: {
        required_when_tested_units_at_least: SEAM_TESTED_UNIT_THRESHOLD,
        bypasses_unit_caps: true,
      },
    },
    conditional_fields: {
      'plan.root_cause': 'required-when-title-prefix:[Bug]|[バグ]',
      'plan.reference_module.path': 'required-when-kind:module',
      'plan.reference_module.reason': 'required-when-kind:no-module|new-shape',
      'plan.screenshots': 'one-or-more-when:user-visible-ui-changes',
      'plan.units[].seam': `one-required-when:${SEAM_TESTED_UNIT_THRESHOLD}-or-more-units-have-tests`,
    },
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)) {
  if (argv[0] === 'describe') {
    if (argv.length !== 1) throw usageError('describe accepts no arguments');
    return { report: describe(), exitCode: 0 };
  }
  const args = parseSingletonArgs(argv, new Set(['--input']));
  const input = readJsonFile(args['--input']);
  const report = validatePlan(input);
  return { report, exitCode: report.verdict === 'pass' ? 0 : 1 };
}

if (isMainModule(import.meta.url)) cli(() => main(), PROTOCOL);
