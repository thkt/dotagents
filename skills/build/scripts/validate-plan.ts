#!/usr/bin/env node
import {
  cli,
  isObject,
  isMain,
  nonEmptyString,
  parseSingletonArgs,
  readJsonFile,
  safeRepoPath,
  type JsonObject,
  usageError,
} from './lib.ts';

export const PROTOCOL = 'codex-build-plan/v1';
export const DESCRIPTION_PROTOCOL = 'codex-build-plan-description/v1';
export const UNIT_CAPS = { files: 3, tests: 4 } as const;
const PLAN_KEYS = new Set([
  'outcome',
  'test_command',
  'root_cause',
  'reference_module',
  'preconditions',
  'backlog_candidates',
  'rules',
  'units',
]);

interface ExtractionMismatch {
  units_missing: string[];
  units_extra: string[];
  tests_missing: string[];
  tests_extra: string[];
}

export interface PlanValidationReport {
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

export function singleCommand(value: unknown): value is string {
  return nonEmptyString(value) && !/[\0\r\n;&|<>`]/u.test(value) && !value.includes('$(');
}

function definitionIds(planSection: string, pattern: RegExp): Set<string> {
  return new Set([...planSection.matchAll(pattern)].map((match) => match[1]!));
}

export function extractPlanSection(body: string): string | null {
  const heading = body.match(/^##\s+Plan\b.*$/m);
  if (!heading) return null;
  const after = body.slice((heading.index ?? 0) + heading[0].length);
  const next = after.search(/^##[^#]/m);
  return next === -1 ? after : after.slice(0, next);
}

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
  const units: unknown[] = Array.isArray(plan.units) ? plan.units : [];
  rejectUnknownKeys(plan, PLAN_KEYS, 'plan', blockers);
  if (!nonEmptyString(plan.outcome)) blockers.push('outcome is empty');
  if (!nonEmptyString(plan.test_command)) {
    blockers.push('test_command is empty');
  } else if (!singleCommand(plan.test_command)) {
    blockers.push('test_command must be one command without shell control operators');
  }
  if (!units.length) blockers.push('units is empty');
  if (plan.root_cause !== undefined && typeof plan.root_cause !== 'string') {
    blockers.push('root_cause must be a string when present');
  }
  if (title.startsWith('[Bug]') && !nonEmptyString(plan.root_cause)) {
    blockers.push('root_cause is empty on a [Bug] issue');
  }

  const reference = plan.reference_module;
  if (!isObject(reference)) {
    blockers.push('reference_module must be an object with kind and reason/path');
  } else {
    rejectUnknownKeys(
      reference,
      new Set(['kind', 'reason', 'path', 'files', 'instances', 'conventions']),
      'reference_module',
      blockers,
    );
    if (typeof reference.kind !== 'string' || !['module', 'no-module', 'new-shape'].includes(reference.kind)) {
      blockers.push('reference_module.kind is invalid');
    } else if (reference.kind === 'module') {
      if (!safeRepoPath(reference.path)) blockers.push('reference_module.path is invalid');
    } else if (!nonEmptyString(reference.reason)) {
      blockers.push(`reference_module.reason is empty while kind is ${reference.kind}`);
    }
    if (reference.files !== undefined && !Array.isArray(reference.files)) {
      blockers.push('reference_module.files must be an array');
    } else {
      for (const file of reference.files || []) {
        if (!safeRepoPath(file)) blockers.push(`reference_module file is invalid: ${file}`);
      }
    }
    if (
      reference.instances !== undefined &&
      (typeof reference.instances !== 'number' || !Number.isFinite(reference.instances))
    ) {
      blockers.push('reference_module.instances must be a finite number');
    }
    if (
      reference.conventions !== undefined &&
      (!Array.isArray(reference.conventions) ||
        reference.conventions.some((item: unknown) => !nonEmptyString(item)))
    ) {
      blockers.push('reference_module.conventions must contain non-empty strings');
    }
  }

  if (!Array.isArray(plan.preconditions)) {
    blockers.push('preconditions must be an array');
  } else {
    for (const [index, entry] of (plan.preconditions as unknown[]).entries()) {
      if (!isObject(entry)) {
        blockers.push(`preconditions[${index}] must be an object`);
        continue;
      }
      rejectUnknownKeys(entry, new Set(['path', 'pattern']), `preconditions[${index}]`, blockers);
      if (!safeRepoPath(entry.path)) blockers.push(`preconditions[${index}].path is invalid`);
      if (entry.pattern !== undefined && typeof entry.pattern !== 'string') {
        blockers.push(`preconditions[${index}].pattern must be a string`);
      }
    }
  }
  if (!Array.isArray(plan.backlog_candidates)) {
    blockers.push('backlog_candidates must be an array');
  } else {
    for (const [index, entry] of (plan.backlog_candidates as unknown[]).entries()) {
      if (!isObject(entry)) {
        blockers.push(`backlog_candidates[${index}] must be an object`);
        continue;
      }
      rejectUnknownKeys(entry, new Set(['summary']), `backlog_candidates[${index}]`, blockers);
      if (!nonEmptyString(entry.summary)) blockers.push(`backlog_candidates[${index}].summary is empty`);
    }
  }
  if (!Array.isArray(plan.rules)) {
    blockers.push('rules must be an array');
  } else {
    for (const [index, entry] of (plan.rules as unknown[]).entries()) {
      if (!isObject(entry)) {
        blockers.push(`rules[${index}] must be an object`);
        continue;
      }
      rejectUnknownKeys(entry, new Set(['source', 'quote']), `rules[${index}]`, blockers);
      if (!nonEmptyString(entry.source)) blockers.push(`rules[${index}].source is empty`);
      if (!nonEmptyString(entry.quote)) blockers.push(`rules[${index}].quote is empty`);
    }
  }

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
    const unitId = String(unit.id || `units[${index}]`);
    rejectUnknownKeys(
      unit,
      new Set(['id', 'goal', 'files', 'contract', 'tests', 'seam']),
      unitId,
      blockers,
    );
    if (!/^U-\d{3}$/.test(unitId)) blockers.push(`${unitId} has an invalid id`);
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
        if (!safeRepoPath(file)) blockers.push(`${unitId} has an invalid file: ${file}`);
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
    for (const [testIndex, scenario] of (unit.tests as unknown[]).entries()) {
      if (!isObject(scenario)) {
        blockers.push(`${unitId}.tests[${testIndex}] must be an object`);
        continue;
      }
      const testId = String(scenario.id || `${unitId}.tests[${testIndex}]`);
      rejectUnknownKeys(scenario, new Set(['id', 'name']), testId, blockers);
      if (!/^T-[A-Z]*\d{3}$/.test(testId)) blockers.push(`${testId} has an invalid id`);
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

  if (testedUnits >= 2 && seamUnits === 0) blockers.push('two or more tested units require a seam unit');

  const bodyUnitIds = definitionIds(planSection, /^###\s+(U-\d{3})\b/gm);
  const bodyTestIds = definitionIds(planSection, /^[ \t]*[-*+][ \t]+(T-[A-Z]*\d{3})\b/gm);
  const missingUnits = [...bodyUnitIds].filter((id) => !unitIds.has(id));
  const extraUnits = [...unitIds].filter((id) => !bodyUnitIds.has(id));
  const missingTests = [...bodyTestIds].filter((id) => !testIds.has(id));
  const extraTests = [...testIds].filter((id) => !bodyTestIds.has(id));
  const mismatch = {
    units_missing: missingUnits,
    units_extra: extraUnits,
    tests_missing: missingTests,
    tests_extra: extraTests,
  };
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
      units: [{
        id: 'U-001',
        goal: 'observable unit behavior',
        files: ['path/to/file'],
        contract: 'cited source plus intent',
        tests: [{ id: 'T-001', name: 'condition and expected result' }],
        seam: false,
      }],
    },
  };
  return {
    protocol: DESCRIPTION_PROTOCOL,
    validates_with: PROTOCOL,
    input_template: inputTemplate,
    plan_keys: [...PLAN_KEYS],
    unit_caps: UNIT_CAPS,
    conditional_fields: {
      'plan.root_cause': 'required-when-title-prefix:[Bug]',
      'plan.reference_module.path': 'required-when-kind:module',
      'plan.reference_module.reason': 'required-when-kind:no-module|new-shape',
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

if (isMain(import.meta.url)) cli(() => main(), PROTOCOL);
