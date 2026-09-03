#!/usr/bin/env bun
/** @file Outcome: Build accepts an implementable Plan with safe paths and a safe test command. */

import { parseBuildPlanAuthoring } from './contracts.ts';
import {
  cli,
  nonEmptyString,
  parseSingletonArgs,
  readJsonFile,
  safeRepoPath,
} from '../shared/cli.ts';
import type { StructuredGateResult } from '../flow/contracts.ts';
import { SHELL_CONTROL, shellWords } from '../shared/command.ts';
import { isMainModule } from '../shared/environment.ts';
import { usageError } from '../shared/errors.ts';
import { isObject } from '../shared/schema.ts';

const PROTOCOL = 'codex-build-plan';
const DESCRIPTION_PROTOCOL = 'codex-build-plan-description';

interface PlanValidationReport extends StructuredGateResult {
  protocol: typeof PROTOCOL;
  verdict: 'pass' | 'fail';
  classification: string;
  reason_codes: string[];
  failure_route: 'blocked' | null;
  blockers: string[];
  counts: { units: number; tests: number };
}

function singleCommand(value: string): boolean {
  return !value.includes('\0') && !SHELL_CONTROL.test(value);
}

function invokesGitHubCli(command: string): boolean {
  return shellWords(command).some((word) => /(?:^|[\\/])gh$/u.test(word));
}

export function validatePlan(input: unknown): PlanValidationReport {
  if (!isObject(input)) throw usageError('input must be a JSON object');
  const blockers: string[] = [];
  if (!Number.isInteger(input.issue) || Number(input.issue) < 1) {
    blockers.push('issue must be a positive integer');
  }
  if (!nonEmptyString(input.title)) blockers.push('title is empty');
  let plan;
  try {
    plan = parseBuildPlanAuthoring(input.plan);
  } catch (error) {
    blockers.push(String(error));
  }
  if (plan) {
    if (!singleCommand(plan.test_command)) {
      blockers.push('test_command must be one command without shell control operators');
    } else if (invokesGitHubCli(plan.test_command)) {
      blockers.push('test_command may not invoke GitHub CLI');
    }
    if (!plan.units.length) blockers.push('units is empty');
    for (const [index, unit] of plan.units.entries()) {
      if (!unit.files.length) blockers.push(`units[${index}] has no target paths`);
      for (const file of unit.files) {
        if (!safeRepoPath(file)) {
          blockers.push(`units[${index}] has an invalid path: ${String(file)}`);
        }
      }
      if (!unit.tests.length) blockers.push(`units[${index}] has no acceptance tests`);
    }
  }
  const counts = {
    units: plan?.units.length ?? 0,
    tests: plan?.units.reduce((sum, unit) => sum + unit.tests.length, 0) ?? 0,
  };
  return {
    protocol: PROTOCOL,
    verdict: blockers.length ? 'fail' : 'pass',
    classification: blockers.length ? 'invalid_plan' : 'pass',
    reason_codes: blockers.length ? ['invalid_plan'] : [],
    failure_route: blockers.length ? 'blocked' : null,
    blockers,
    counts,
  };
}

export function describe() {
  const inputTemplate = {
    issue: 123,
    title: 'Feature',
    plan: {
      outcome: 'observable done state',
      test_command: 'repository-test-command',
      units: [
        {
          goal: 'observable unit behavior',
          files: ['path/to/file'],
          contract: 'behavior to preserve or establish',
          tests: ['condition and expected result'],
        },
      ],
    },
  };
  return {
    protocol: DESCRIPTION_PROTOCOL,
    validates_with: PROTOCOL,
    command: 'codex-build-plan describe' as const,
    input_template: inputTemplate,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)) {
  if (argv[0] === 'describe') {
    if (argv.length !== 1) throw usageError('describe accepts no arguments');
    return { report: describe(), exitCode: 0 };
  }
  const args = parseSingletonArgs(argv, new Set(['--input']));
  const report = validatePlan(readJsonFile(args['--input']));
  return { report, exitCode: report.verdict === 'pass' ? 0 : 1 };
}

if (isMainModule(import.meta.url)) cli(() => main(), PROTOCOL);
